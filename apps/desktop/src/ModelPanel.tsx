// Model browser: scan the model folders, search the object database, and show one model in the preview.
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./ui";
import { open } from "@tauri-apps/plugin-dialog";
import { dirExists, scanModels } from "./data";
import { ModelLibrary, type Model } from "./models";
import { Preview } from "./preview";

const ROOTS_KEY = "terrainTool.modelRoots";
// Show only this many search results, so that the list stays fast.
const LIST_MAX = 300;

// The folders are kept for the next start as one text, separated with ";".
export function savedRoots(): string[] {
	try {
		return (localStorage.getItem(ROOTS_KEY) ?? "").split(";").filter(Boolean);
	} catch {
		return [];
	}
}

function saveRoots(roots: string[]) {
	try {
		localStorage.setItem(ROOTS_KEY, roots.join(";"));
	} catch {
		// The folders are then not kept for the next start.
	}
}

// placing is the model that the editor places with each click in the 3D view, or null.
// Click selection of a list: a click selects one item, Ctrl+click adds or removes one, Shift+click selects the range from the last clicked item.
export function pickClick(list: string[], sel: string[], last: string | undefined, k: string, e: { ctrlKey: boolean; shiftKey: boolean; metaKey?: boolean }): string[] {
	if (e.shiftKey && last && list.includes(last)) {
		const [a, b] = [list.indexOf(last), list.indexOf(k)].sort((x, y) => x - y);
		return [...new Set([...sel, ...list.slice(a, b + 1)])];
	}
	if (e.ctrlKey || e.metaKey) return sel.includes(k) ? sel.filter((x) => x !== k) : [...sel, k];
	return [k];
}

// onShow gets the name of the model in the preview (the last clicked model: placement uses it).
// onPick gets the selected models (Shift or Ctrl+click), for the recipe of the fill and the brushes.
// scanRequest: folders from a project file. The panel uses and scans them when they are not the same as its folders.
export function ModelPanel({ enabled, onLibrary, placing, onPlace, onShow, onPick, scanRequest }: { enabled: boolean; onLibrary: (l: ModelLibrary) => void; placing: string | null; onPlace: (model: string | null) => void; onShow?: (model: string) => void; onPick?: (models: string[]) => void; scanRequest?: string[] }) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const preview = useRef<Preview>(null);
	const library = useRef(new ModelLibrary());
	const [roots, setRoots] = useState(savedRoots);
	const [keys, setKeys] = useState<string[]>([]);
	const [dups, setDups] = useState<[string, string[]][]>([]);
	const [textures, setTextures] = useState(0);
	const [search, setSearch] = useState("");
	const [busy, setBusy] = useState(false);
	const [model, setModel] = useState<Model>();
	const [picked, setPicked] = useState<string[]>([]);
	const [error, setError] = useState("");
	// The floating preview closes with its ✕ and opens again with the next model click.
	const [closed, setClosed] = useState(false);
	// Scan the kept folders at the start. At the first start (no folders kept yet), use P:\a3 (the extracted game data) when it exists.
	useEffect(() => {
		if (!enabled) return;
		let first = false;
		try {
			first = localStorage.getItem(ROOTS_KEY) === null;
		} catch {
			// No storage: not the first start.
		}
		if (first) dirExists("P:\\a3").then((ok) => void (ok && scan(["P:\\a3"])), () => {});
		else if (roots.length) scan(roots);
	}, []);
	useEffect(() => {
		if (enabled && scanRequest && scanRequest.join(";").toLowerCase() !== roots.join(";").toLowerCase()) scan(scanRequest);
	}, [scanRequest]);
	useEffect(() => {
		preview.current = new Preview(canvas.current!);
		// Test hook for scripts in a browser without Tauri.
		Object.assign(window, { terrainPreview: preview.current });
	}, []);
	const found = useMemo(() => {
		const s = search.trim().toLowerCase();
		return (s ? keys.filter((k) => k.includes(s)) : keys).slice(0, LIST_MAX);
	}, [keys, search]);
	// Keep the folders and scan them. A scan with no folders gives an empty database.
	const scan = async (list: string[]) => {
		setRoots(list);
		saveRoots(list);
		setBusy(true);
		setError("");
		try {
			const r = await scanModels(list);
			// A new library for each scan, so that the 3D view loads the models again.
			library.current = new ModelLibrary();
			setKeys(r.keys);
			setDups(r.duplicates);
			setTextures(r.textures);
			onLibrary(library.current);
		} catch (e) {
			setError(String(e));
		} finally {
			setBusy(false);
		}
	};
	const addFolders = async () => {
		const f = await open({ title: "Select model folders", directory: true, multiple: true });
		const add = (Array.isArray(f) ? f : f ? [f] : []).filter((x) => !roots.some((r) => r.toLowerCase() === x.toLowerCase()));
		if (add.length) scan([...roots, ...add]);
	};
	const click = (key: string, e: { ctrlKey: boolean; shiftKey: boolean; metaKey: boolean }) => {
		const p = pickClick(found, picked, model?.name, key, e);
		setPicked(p);
		onPick?.(p);
		show(key);
	};
	const show = async (key: string) => {
		const m = await library.current.model(key);
		setModel(m);
		setClosed(false);
		onShow?.(key);
		preview.current!.show(m);
	};
	return (
		<div className="panel">
			<details className="folders" open={!roots.length}>
				<summary>Model folders ({roots.length}), {keys.length} models{busy ? ", scanning..." : ""}</summary>
				{roots.map((r) => (
					<div key={r} className="row">
						<span className="name" title={r}>{r}</span>
						<button disabled={busy} title="Remove this folder" onClick={() => scan(roots.filter((x) => x !== r))}>✕</button>
					</div>
				))}
				<div className="row">
					<button disabled={!enabled || busy} onClick={addFolders} title="Add folders. The tool scans them now and at each start."><Icon name="folder-add-line" /> Add folder</button>
					<button disabled={!enabled || busy || !roots.length} onClick={() => scan(roots)} title="Scan the folders again, for example after you add models"><Icon name="refresh-line" /> {busy ? "Scanning..." : "Rescan"}</button>
				</div>
				<div className="muted">
					{keys.length} models, {textures} textures{dups.length ? `, ${dups.length} names in more than one place (the first one is used)` : ""}
				</div>
			</details>
			{error && <div className="error">{error}</div>}
			<input placeholder="Search model name" value={search} onChange={(e) => setSearch(e.target.value)} />
			<ul className="list" title="Click shows a model. Ctrl+click and Shift+click select more models for the recipe of the object fill.">
				{found.map((k) => (
					<li key={k} className={model?.name === k ? "active" : picked.includes(k) ? "picked" : ""} onClick={(e) => click(k, e)}>{k}</li>
				))}
			</ul>
			<div className="preview-float" style={{ display: model && !closed ? "flex" : "none" }}>
				<div className="row">
					<b className="name">{model?.name}</b>
					<button className="icon" title="Close the preview (the next model click opens it again)" onClick={() => setClosed(true)}><Icon name="close-line" /></button>
				</div>
				<canvas ref={canvas} className="preview" />
			{model && !model.error && (
				<button className={placing === model.name ? "on" : ""} onClick={() => onPlace(placing === model.name ? null : model.name)}>
					{placing === model.name ? "Placing (click the terrain, Escape to stop)" : `Place ${model.name}`}
				</button>
			)}
			{model && (
				<div className="muted">
					{model.error ? <span className="error">{model.error}</span> : model.empty ? "No visual LOD. The model shows nothing." : `${model.triangles} triangles, ${model.materials.length} textures`}
					{model.missing.map((t) => <div key={t} className="error">Missing: {t}</div>)}
				</div>
			)}
			</div>
		</div>
	);
}
