// Object fill panel: the recipe (models and weights), the mask layers, and the rules. Preview shows points, Commit makes a fill layer.
import { useState } from "react";
import { Icon } from "./ui";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { fillEstimate, fillRun, readText, writeText, type FillResult, type FillSettings, type MaskInfo } from "./data";
import type { Editor } from "./editor";
import { pickClick } from "./ModelPanel";
import type { Viewer } from "./viewer";

// Largest object count without a question to the user.
const LIMIT = 2_000_000;

type Rules = Omit<FillSettings, "weights" | "colors" | "avoid">;

const DEFAULTS: Rules = { density: 100, spacing: 3, randomYaw: true, scale: [0.9, 1.1], tilt: false, seed: 1, inset: 0, feather: 0, noiseScale: 50, noise: 0, maxSlope: 90, minHeight: -1000, maxHeight: 10000, noWater: true, gap: 1 };

// Run a fill: estimate the count, ask above the limit, then place the objects. Returns null when the user stops it.
// polygon: the area in local meters (a shape) instead of the mask layers.
export async function runFill(ed: Editor, settings: FillSettings, avoidObjects: boolean, polygon?: number[][]): Promise<FillResult | null> {
	const s = { ...settings, avoid: avoidObjects ? ed.footprints() : [] };
	const n = await fillEstimate(s, polygon);
	let limit = LIMIT;
	if (n > LIMIT) {
		if (!(await ask(`The fill can make up to ${Math.round(n).toLocaleString()} objects. The limit is ${LIMIT.toLocaleString()}. Continue without the limit?`, { title: "Object fill", kind: "warning" }))) return null;
		limit = Number.MAX_SAFE_INTEGER;
	}
	return fillRun(s, limit, polygon);
}

// The recipe of the fill panel, for the scatter brush and the polygon scatter of a shape.
export interface Recipe {
	settings: FillSettings;
	models: string[];
	avoid: boolean;
}

export function FillPanel({ ed, viewer, mask, shown, picked = [], onError, onDone, recipe }: { ed: Editor; viewer: Viewer; mask?: MaskInfo; shown?: string; picked?: string[]; onError: (e: string) => void; onDone: () => void; recipe?: { current: () => Recipe } }) {
	const [models, setModels] = useState<{ name: string; weight: number }[]>([]);
	const [colors, setColors] = useState<number[]>([]);
	const [rules, setRules] = useState<Rules>(DEFAULTS);
	const [avoid, setAvoid] = useState(true);
	const [target, setTarget] = useState<"new" | "current">("new");
	const [preview, setPreview] = useState<{ r: FillResult; s: FillSettings } | null>(null);
	const [busy, setBusy] = useState("");
	const [bench, setBench] = useState(500000);
	// Selected rows of the recipe (Shift or Ctrl+click), to remove them together.
	const [sel, setSel] = useState<string[]>([]);
	const [lastSel, setLastSel] = useState<string>();
	// The models to add: the selected models of the model panel, else the model of the preview.
	const toAdd = (picked.length ? picked : shown ? [shown] : []).filter((n) => !models.some((m) => m.name === n));
	const settings = (): FillSettings => ({ ...rules, weights: models.map((m) => m.weight), colors, avoid: [] });
	if (recipe) recipe.current = () => ({ settings: settings(), models: models.map((m) => m.name), avoid });
	const set = (change: Partial<Rules>) => {
		setRules({ ...rules, ...change });
		clear();
	};
	const clear = () => {
		setPreview(null);
		viewer.setPreview(null);
	};
	const job = async (label: string, f: () => Promise<void>) => {
		setBusy(label);
		onError("");
		try {
			await f();
		} catch (e) {
			onError(String(e));
		} finally {
			setBusy("");
		}
	};
	const doPreview = () =>
		job("Filling", async () => {
			const s = settings();
			const r = await runFill(ed, s, avoid);
			if (!r) return;
			viewer.setPreview(r.values, 7);
			setPreview({ r, s });
		});
	const commit = () =>
		job("Placing objects", async () => {
			let p = preview;
			if (!p) {
				const s = settings();
				const r = await runFill(ed, s, avoid);
				if (!r) return;
				p = { r, s };
			}
			const st = ed.store;
			if (target === "current" && !st.layers[ed.activeLayer]) throw "select a layer first";
			const layer = target === "new" ? st.addLayer(st.newLayerName()) : ed.activeLayer;
			ed.activeLayer = layer;
			await ed.applyFill(p.r, { name: `fill ${st.fills.length + 1}`, layer, settings: p.s, models: models.map((m) => m.name), avoid });
			clear();
			onDone();
		});
	// Speed test: n objects of the recipe models at random positions on the whole map, in a new layer. ✕ on the fill row deletes them.
	const doBench = () =>
		job("Placing bench objects", async () => {
			const t = viewer.terrain;
			if (!t) throw "open a heightmap first";
			const [w, h] = [t.ncols * t.cell, t.nrows * t.cell];
			const values = new Float32Array(bench * 7);
			const entries = new Uint32Array(bench * 7);
			for (let i = 0; i < bench; i++) {
				const o = i * 7;
				[values[o], values[o + 1], values[o + 2], values[o + 5]] = [Math.random() * w, Math.random() * h, Math.random() * 360, 1];
				entries[o + 6] = i % models.length;
			}
			const st = ed.store;
			const layer = st.addLayer(`Bench ${bench}`);
			ed.activeLayer = layer;
			const t0 = performance.now();
			await ed.applyFill({ count: bench, truncated: false, values, entries }, { name: `bench ${bench}`, layer, settings: settings(), models: models.map((m) => m.name), avoid: false });
			onDone();
			onError(`Bench: ${bench.toLocaleString()} objects placed in ${((performance.now() - t0) / 1000).toFixed(1)} s. Read the FPS in the status bar.`);
		});
	// The recipe file keeps the layer names, not the palette indices, so that it works with another mask.
	const saveRecipe = async () => {
		const path = await save({ defaultPath: "recipe.json", filters: [{ name: "Recipe", extensions: ["json"] }] });
		if (!path) return;
		const layers = colors.map((c) => mask?.names[c] ?? "");
		await writeText(path, JSON.stringify({ models, layers, avoidObjects: avoid, ...rules }, null, "\t")).catch((e) => onError(String(e)));
	};
	const loadRecipe = async () => {
		const path = await open({ multiple: false, directory: false, filters: [{ name: "Recipe", extensions: ["json"] }] });
		if (typeof path !== "string") return;
		try {
			const j = JSON.parse(await readText(path));
			const { models: m, layers, avoidObjects, ...r } = j;
			setModels(m ?? []);
			setAvoid(avoidObjects ?? true);
			setRules({ ...DEFAULTS, ...r });
			const found = (layers ?? []).map((n: string) => mask?.names.indexOf(n) ?? -1);
			setColors(found.filter((i: number) => i >= 0));
			if (found.includes(-1)) onError(`Recipe layers not in the open mask: ${(layers as string[]).filter((_, i) => found[i] < 0).join(", ")}`);
			clear();
		} catch (e) {
			onError(`${path}: ${e}`);
		}
	};
	const num = (label: string, key: keyof Rules, title: string, step = 1) => (
		<label className="field-row" title={title}>
			{label}
			<input type="number" step={step} value={rules[key] as number} onChange={(e) => set({ [key]: Number(e.target.value) || 0 })} />
		</label>
	);
	const check = (label: string, key: keyof Rules, title: string) => (
		<label title={title}><input type="checkbox" checked={rules[key] as boolean} onChange={(e) => set({ [key]: e.target.checked })} />{label}</label>
	);
	return (
		<div className="fill">
			{!mask && <div className="muted">Open a mask first (Heightmap & imagery tab, Mask).</div>}
			{mask?.colors.map((c, i) => (
				<label key={i} className="row">
					<input type="checkbox" checked={colors.includes(i)} onChange={(e) => {
						setColors(e.target.checked ? [...colors, i] : colors.filter((x) => x !== i));
						clear();
					}} />
					<span className="swatch" style={{ background: `rgb(${c.join(",")})` }} />
					<span className="name">{mask.names[i]}</span>
				</label>
			))}
			<div className="muted">Models (weight):</div>
			{models.map((m, i) => (
				<div key={m.name} className={`row${sel.includes(m.name) ? " active" : ""}`}>
					<span className="name" title={`${m.name}. Click selects, Ctrl+click and Shift+click select more.`} onClick={(e) => {
						setSel(pickClick(models.map((x) => x.name), sel, lastSel, m.name, e));
						setLastSel(m.name);
					}}>{m.name}</span>
					<input type="number" min={0} step={1} value={m.weight} title="Weight. A model with weight 2 is used two times as often as a model with weight 1." onChange={(e) => {
						setModels(models.map((x, k) => (k === i ? { ...x, weight: Math.max(0, Number(e.target.value) || 0) } : x)));
						clear();
					}} />
					<button title="Remove" onClick={() => {
						setModels(models.filter((_, k) => k !== i));
						clear();
					}}>x</button>
				</div>
			))}
			<div className="row">
				<button disabled={!toAdd.length} title="Add the selected models of the model panel (Ctrl+click or Shift+click there selects more)" onClick={() => {
					setModels([...models, ...toAdd.map((name) => ({ name, weight: 1 }))]);
					clear();
				}}>{toAdd.length > 1 ? `Add ${toAdd.length} models` : toAdd.length ? `Add ${toAdd[0]}` : "Select models in the model panel"}</button>
				{sel.length > 0 && (
					<button title="Remove the selected models from the recipe" onClick={() => {
						setModels(models.filter((m) => !sel.includes(m.name)));
						setSel([]);
						clear();
					}}>{`Remove ${sel.length}`}</button>
				)}
			</div>
			{num("Density /ha", "density", "Objects for each hectare (100 x 100 m)")}
			{num("Spacing m", "spacing", "Smallest distance between two objects of the fill", 0.5)}
			<label className="field-row" title="Random scale from the first to the second value">
				Scale
				<input type="number" step={0.05} value={rules.scale[0]} onChange={(e) => set({ scale: [Number(e.target.value) || 0, rules.scale[1]] })} />
				<input type="number" step={0.05} value={rules.scale[1]} onChange={(e) => set({ scale: [rules.scale[0], Number(e.target.value) || 0] })} />
			</label>
			{check("Random yaw", "randomYaw", "Yaw from 0 to 360. Off: yaw 0.")}
			{check("Tilt to terrain", "tilt", "Pitch and roll follow the terrain slope. Not verified against TB yet.")}
			{num("Inset m", "inset", "No objects nearer than this to the edge of the selected layers", 0.5)}
			{num("Feather m", "feather", "The density falls to 0 across this width at the edge", 0.5)}
			{num("Clumps 0-1", "noise", "Strength of the clump noise. 0 is off.", 0.05)}
			{num("Clump size m", "noiseScale", "Size of the clumps", 5)}
			{num("Max slope °", "maxSlope", "No objects on a steeper terrain")}
			{num("Min height m", "minHeight", "No objects below this height")}
			{num("Max height m", "maxHeight", "No objects above this height")}
			{check("Not in water", "noWater", "No objects below sea level (0 m)")}
			<label title="Keep away from the objects in the visible layers"><input type="checkbox" checked={avoid} onChange={(e) => {
				setAvoid(e.target.checked);
				clear();
			}} />Avoid objects</label>
			{num("Gap m", "gap", "Extra distance to the existing objects", 0.5)}
			<label className="field-row" title="The same seed gives the same result">
				Seed
				<input type="number" value={rules.seed} onChange={(e) => set({ seed: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
				<button onClick={() => set({ seed: Math.floor(Math.random() * 1e9) })}>New</button>
			</label>
			<label title="Commit makes a new layer New Layer <n>"><input type="radio" checked={target === "new"} onChange={() => setTarget("new")} />Add to new layer</label>
			<label title="Commit puts the objects into the selected (active) layer"><input type="radio" checked={target === "current"} onChange={() => setTarget("current")} />Add to currently selected layer</label>
			<div className="row">
				<button disabled={!!busy || !mask || !models.length || !colors.length} onClick={doPreview} title="Show the objects as points"><Icon name="eye-line" /> Preview</button>
				<button disabled={!!busy || !mask || !models.length || !colors.length} onClick={commit} title="Put the objects into the layer that is set above"><Icon name="check-line" /> Commit</button>
				<button disabled={!preview} onClick={clear}><Icon name="close-line" /> Clear</button>
			</div>
			<label className="field-row" title="Speed test: place this number of the recipe models at random positions on the whole map, in a new layer">
				Bench
				<input type="number" min={1} step={100000} value={bench} onChange={(e) => setBench(Math.max(1, Math.floor(Number(e.target.value) || 1)))} />
				<button disabled={!!busy || !models.length || !viewer.terrain} onClick={doBench}><Icon name="speed-up-line" /> Place</button>
			</label>
			<div className="row">
				<button onClick={saveRecipe}><Icon name="save-line" /> Save recipe</button>
				<button onClick={loadRecipe}><Icon name="folder-open-line" /> Load recipe</button>
			</div>
			<div className="muted">{busy ? `${busy}...` : preview ? `${preview.r.count.toLocaleString()} objects in the preview` : ""}</div>
		</div>
	);
}
