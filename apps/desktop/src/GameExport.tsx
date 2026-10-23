// Export for the game (M9): the satellite and mask tiles, the tile RVMAT files, the editable WRP (heights, layer materials, the objects
// of the shown layers), and roads.shp. The settings come from the TB project when one is open, and the project file keeps them.
import { open, save } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { gameExport, readBytes, shpWrite, writeBytes, type GameReport, type Project, type Terrain } from "./data";
import type { ObjectStore } from "./store";
import { roadId, shpPoints, type Shape } from "./shapes";

export interface GameSettings {
	wrp: string;
	layersDir: string;
	prefix: string;
	tilePx: number;
	overlapPx: number;
	layerSize: number;
	satellite: boolean;
	roads: boolean;
	roadsDir: string;
	paa: boolean;
	imageToPaa: string;
	skipOutside: boolean;
	// Pick the tile size and the overlap: the largest tile (2048 px, the TB limit, first) that has a fitting overlap, then its lowest overlap.
	autoOverlap: boolean;
}

// Default settings: from the TB project (the WRP folder, for example p:\bromine\bro_msi), else empty paths.
export function defaultSettings(tb: Project | null): GameSettings {
	const dir = tb?.wrpFolder.replace(/[\\/]+$/, "") ?? "";
	const game = dir.replace(/^[a-z]:[\\/]*/i, "");
	return {
		wrp: dir ? `${dir}\\${tb!.name}.wrp` : "",
		layersDir: dir ? `${dir}\\data\\layers` : "",
		prefix: game ? `${game}\\data\\layers\\` : "",
		tilePx: tb?.tilePx || 2048,
		overlapPx: tb?.overlapPx || 512,
		layerSize: tb?.textureLayer || 64,
		satellite: true,
		roads: false,
		roadsDir: dir ? `${dir}\\data\\roads` : "",
		paa: false,
		skipOutside: true,
		autoOverlap: true,
		imageToPaa: "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Arma 3 Tools\\ImageToPAA\\ImageToPAA.exe",
	};
}

// The objects of the shown layers, and the ones of them outside the map (w x h meters). Binarize stops on an object outside the map.
export function exportIds(st: ObjectStore, w: number, h: number): { ids: number[]; outside: number[] } {
	const ids = [...st.ids()].filter((id) => {
		const l = st.layers[st.layer[id]];
		return l && l.visible && !l.deleted;
	});
	const out = (id: number) => {
		const [x, y] = [st.t[id * 12 + 9], st.t[id * 12 + 11]];
		return !(x >= 0 && x < w && y >= 0 && y < h);
	};
	return { ids, outside: ids.filter(out) };
}

// The lowest even overlap (2 px or more, as in TB) at which each texture layer cell lies inside the tile of its first pixel.
// The same rule as Layout::cells_fit in tiles.rs. Null: no overlap fits (or the cell does not divide the image).
export function lowestOverlap(image: number, tile: number, cell: number): number | null {
	if (!(cell > 0) || image % cell !== 0) return null;
	for (let o = 2; o < tile; o += 2) {
		const step = tile - o;
		const n = Math.ceil(image / step);
		let fit = true;
		for (let c = 0; fit && c < image / cell; c++) {
			const start = c * cell - (Math.min(Math.floor((c * cell) / step), n - 1) * step - o / 2);
			fit = start >= 0 && start + cell <= tile;
		}
		if (fit) return o;
	}
	return null;
}

// Tile sizes of TB, largest first. 2048 px is the largest that TB allows.
export const TILE_SIZES = [2048, 1024, 512, 256];

// The largest tile size with a fitting overlap, and that overlap. Less overlap gives less edge dilation of the textures in the game.
export function bestTiles(image: number, cell: number): { tile: number; overlap: number } | null {
	for (const tile of TILE_SIZES) {
		const overlap = lowestOverlap(image, tile, cell);
		if (overlap !== null) return { tile, overlap };
	}
	return null;
}

// Object data for game_export (see main.rs).
export function objectBytes(st: ObjectStore, ids: number[]): Uint8Array {
	const names = new TextEncoder().encode(st.models.join("\n"));
	const b = new Uint8Array(4 + ids.length * 52 + names.length);
	const d = new DataView(b.buffer);
	d.setUint32(0, ids.length, true);
	ids.forEach((id, i) => {
		for (let k = 0; k < 12; k++) d.setFloat32(4 + i * 48 + k * 4, st.t[id * 12 + k], true);
		d.setUint32(4 + ids.length * 48 + i * 4, st.model[id], true);
	});
	b.set(names, 4 + ids.length * 52);
	return b;
}

// The roads: all lines with a numeric ID, moved by xll and yll.
export const roadShapes = (shapes: Shape[], xll: number, yll: number) =>
	shapes.filter((s) => !s.deleted && s.kind === "line" && s.points.length > 1 && roadId(s) !== undefined).map((s) => ({ parts: [shpPoints(s, xll, yll)], props: s.props }));

interface Props {
	settings: GameSettings;
	onChange: (s: GameSettings) => void;
	store: ObjectStore;
	shapes: Shape[];
	terrain?: Terrain;
	layersCfg: string | null;
	searchRoots: string[];
	mask?: { width: number; height: number };
	hasSat: boolean;
	// Map frame of the TB project (x min, y min, x max, y max, TB coordinates).
	frame?: number[];
}

export function GameExport({ settings: s, onChange, store, shapes, terrain, layersCfg, searchRoots, mask, hasSat, frame }: Props) {
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<{ ok: boolean; lines: string[] } | null>(null);
	const set = (c: Partial<GameSettings>) => onChange({ ...s, ...c });
	const size = terrain ? terrain.ncols * terrain.cell : 0;
	const mpp = mask && size ? size / mask.width : 0;
	const cellPx = mpp ? Math.round((s.layerSize / mpp) * 1e6) / 1e6 : 0;
	const best = mask && Number.isInteger(cellPx) ? bestTiles(mask.width, cellPx) : null;
	const [tile, overlap] = s.autoOverlap ? [best?.tile ?? s.tilePx, best?.overlap ?? null] : [s.tilePx, s.overlapPx];
	const { ids, outside } = exportIds(store, size, terrain ? terrain.nrows * terrain.cell : 0);
	const skip = new Set(outside);
	const tb = (id: number) => `${store.models[store.model[id]]} (${store.layers[store.layer[id]].name}) at ${(store.t[id * 12 + 9] + (terrain?.xll ?? 0)).toFixed(1)}, ${(store.t[id * 12 + 11] + (terrain?.yll ?? 0)).toFixed(1)}`;
	// TB places the WRP at the corner of its map frame. A heightmap with another corner moves the map against the TB coordinates.
	const corner = frame && terrain && (Math.abs(frame[0] - terrain.xll) > 0.01 || Math.abs(frame[1] - terrain.yll) > 0.01);
	// The game reads roads.shp in TB coordinates: x + 200000, y + 0 (the TB map frame). Verified with the user's working roads.shp of
	// bro_laguna (x 200680 to 220473). The export without the offset (map coordinates) gave roads that did not work.
	const roads = roadShapes(shapes, 200000, 0);
	const missing = [!terrain && "a heightmap", !mask && "a mask", !layersCfg && "the layers.cfg of the mask", !s.wrp && "the WRP file", !s.layersDir && "the layers folder", !s.prefix.trim() && "the layers game path", s.roads && roads.length && !s.roadsDir && "the roads folder", mask && s.autoOverlap && !best && `a tile size and an overlap that fit (the texture layer cell of ${+cellPx.toFixed(3)} px must divide the mask of ${mask.width} px)`].filter(Boolean);
	const pick = async (key: "wrp" | "layersDir" | "roadsDir" | "imageToPaa") => {
		const p =
			key === "wrp"
				? await save({ defaultPath: s.wrp || "map.wrp", filters: [{ name: "WRP", extensions: ["wrp"] }] })
				: await open({ multiple: false, directory: key !== "imageToPaa", defaultPath: s[key] || undefined, filters: key === "imageToPaa" ? [{ name: "ImageToPAA", extensions: ["exe"] }] : undefined });
		if (typeof p !== "string") return;
		// Without a game path, take it from the selected layers folder (the work drive P:\ is the game root).
		if (key === "layersDir" && !s.prefix.trim()) set({ layersDir: p, prefix: `${p.replace(/^[a-z]:[\\/]*/i, "").replace(/[\\/]+$/, "")}\\` });
		else set({ [key]: p });
	};
	const run = async () => {
		setBusy(true);
		setResult(null);
		try {
			const r: GameReport = await gameExport(
				{ wrp: s.wrp, layersDir: s.layersDir, prefix: s.prefix, tilePx: tile, overlapPx: overlap!, layerSize: s.layerSize, layersCfg: layersCfg!, searchRoots, satellite: s.satellite && hasSat, imageToPaa: s.paa ? s.imageToPaa : null },
				objectBytes(store, s.skipOutside ? ids.filter((id) => !skip.has(id)) : ids),
			);
			const lines = [...r.lines];
			if (s.skipOutside && outside.length) lines.push(`${outside.length} objects outside the map are not in the WRP`);
			if (s.roads && roads.length) {
				const path = `${s.roadsDir.replace(/[\\/]+$/, "")}\\roads.shp`;
				// Keep the old file set as .bak (one level), so an export never destroys the roads of the user.
				for (const ext of ["shp", "shx", "dbf", "cpg"]) {
					const f = path.replace(/shp$/, ext);
					const old = await readBytes(f).catch(() => null);
					if (old) await writeBytes(`${f}.bak`, old);
				}
				await shpWrite(path, "line", roads);
				lines.push(`${path}: ${roads.length} roads`);
			}
			setResult({ ok: true, lines });
		} catch (e) {
			setResult({ ok: false, lines: String(e).split("\n") });
		} finally {
			setBusy(false);
		}
	};
	const path = (label: string, key: "wrp" | "layersDir" | "roadsDir" | "imageToPaa", title: string) => (
		<label className="field-row" title={title}>
			{label} <input value={s[key]} onChange={(e) => set({ [key]: e.target.value })} />
			<button onClick={() => pick(key)}>…</button>
		</label>
	);
	const num = (label: string, key: "tilePx" | "overlapPx" | "layerSize", title: string) => (
		<label className="field-row" title={title}>
			{label} <input type="number" value={s[key]} onChange={(e) => set({ [key]: Number(e.target.value) || 0 })} />
		</label>
	);
	return (
		<div className="export-page">
			<div className="dialog game-export">
				<b>Export for game</b>
				{path("WRP file", "wrp", "The editable WRP for the binarizer. An existing file is replaced.")}
				{path("Layers folder", "layersDir", "The S_ and M_ tiles and the tile RVMAT files go here")}
				<label className="field-row" title="Game path of the layers folder, used in the RVMAT files and the WRP">
					Layers game path <input value={s.prefix} onChange={(e) => set({ prefix: e.target.value })} />
				</label>
				<label className="field-row" title="Satellite and mask tile size in pixels. TB allows 2048 px at most.">
					Tile size px <input type="number" disabled={s.autoOverlap} value={tile} onChange={(e) => set({ tilePx: Number(e.target.value) || 0 })} />
				</label>
				<label className="field-row" title="Tile overlap in pixels. Each texture layer cell must lie fully inside one tile, so not every overlap fits.">
					Overlap px <input type="number" disabled={s.autoOverlap} value={overlap ?? ""} onChange={(e) => set({ overlapPx: Number(e.target.value) || 0 })} />
				</label>
				<label title="The largest tile size (2048 px first), then the lowest overlap (2 px or more) at which each texture layer cell lies inside its tile. Less overlap gives less edge dilation in the game."><input type="checkbox" checked={s.autoOverlap} onChange={(e) => set({ autoOverlap: e.target.checked })} />Automatic tile size and lowest overlap{best ? ` (${best.tile} px, ${best.overlap} px)` : ""}</label>
				{num("Texture layer m", "layerSize", "Texture layer cell size in meters")}
				<div className="muted">
					{size ? `Map ${size} m` : "No heightmap"}
					{mpp ? `, mask ${mask!.width} px, ${+mpp.toFixed(4)} m/px` : ""}. Objects in shown layers: {ids.length}. Roads: {roads.length}.
				</div>
				{corner && <div className="error">The heightmap corner ({terrain!.xll}, {terrain!.yll}) is not the corner of the TB map frame ({frame![0]}, {frame![1]}). TB requires the map frame at 200000, 0. Import the heightmap with that corner.</div>}
				{outside.length > 0 && (
					<div className="error" title={outside.slice(0, 20).map(tb).join("\n")}>
						{outside.length} objects are outside the map. Binarize stops on them. First: {tb(outside[0])}.
					</div>
				)}
				{outside.length > 0 && <label><input type="checkbox" checked={s.skipOutside} onChange={(e) => set({ skipOutside: e.target.checked })} />Leave out the objects outside the map</label>}
				<label><input type="checkbox" checked={s.satellite && hasSat} disabled={!hasSat} onChange={(e) => set({ satellite: e.target.checked })} />Satellite tiles</label>
				<label title="Lines with an ID property, as roads.shp with the ID field"><input type="checkbox" checked={s.roads} onChange={(e) => set({ roads: e.target.checked })} />Write roads.shp</label>
				{s.roads && path("Roads folder", "roadsDir", "roads.shp, roads.shx, roads.dbf and roads.cpg go here")}
				<label title="Convert each tile PNG to PAA with ImageToPAA of the Arma 3 Tools. The PNG files stay."><input type="checkbox" checked={s.paa} onChange={(e) => set({ paa: e.target.checked })} />Convert tiles to PAA</label>
				{s.paa && path("ImageToPAA.exe", "imageToPaa", "ImageToPAA.exe of the Arma 3 Tools")}
				{missing.length > 0 && <div className="muted">Needs: {missing.join(", ")}.</div>}
				<div className="row">
					<button disabled={busy || missing.length > 0} onClick={run}>{busy ? "Exporting…" : "Export"}</button>
				</div>
				{result && <pre className={result.ok ? "report" : "report error"}>{result.lines.join("\n")}</pre>}
			</div>
		</div>
	);
}
