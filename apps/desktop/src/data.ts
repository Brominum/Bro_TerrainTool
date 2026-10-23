// Read the binary results of the Tauri commands. See src-tauri/src/main.rs for the layouts.
import { invoke } from "@tauri-apps/api/core";
import type { ClutterItem } from "./clutter";

export interface Terrain {
	ncols: number;
	nrows: number;
	cell: number;
	xll: number;
	yll: number;
	// Heights row by row. Row 0 is the north row (the ASC order).
	heights: Float32Array;
}

export interface Picture {
	width: number;
	height: number;
	rgba: Uint8Array;
}

export interface Objects {
	count: number;
	// 12 values for each object: aside, up, dir, position. Arma order (x east, z up, y north) is (x, z, y) here.
	transforms: Float32Array;
	model: Uint32Array;
	models: string[];
}

export function parseAsc(b: ArrayBuffer): Terrain {
	const d = new DataView(b);
	const ncols = d.getUint32(0, true);
	const nrows = d.getUint32(4, true);
	return { ncols, nrows, cell: d.getFloat64(8, true), xll: d.getFloat64(16, true), yll: d.getFloat64(24, true), heights: new Float32Array(b, 32, ncols * nrows) };
}

export function parsePicture(b: ArrayBuffer): Picture {
	const d = new DataView(b);
	return { width: d.getUint32(0, true), height: d.getUint32(4, true), rgba: new Uint8Array(b, 8) };
}

export function parseObjects(b: ArrayBuffer): Objects {
	const d = new DataView(b);
	const count = d.getUint32(0, true);
	const transforms = new Float32Array(b, 8, count * 12);
	const model = new Uint32Array(b, 8 + count * 48, count);
	const text = new TextDecoder().decode(new Uint8Array(b, 8 + count * 52));
	return { count, transforms, model, models: text ? text.split("\n") : [] };
}

export const loadAsc = async (path: string) => parseAsc(await invoke<ArrayBuffer>("open_asc", { path }));
// A new flat terrain in the core.
export const newTerrain = async (ncols: number, nrows: number, cell: number, xll: number, yll: number, height: number) => parseAsc(await invoke<ArrayBuffer>("new_terrain", { ncols, nrows, cell, xll, yll, height }));
export const loadPicture = async (path: string, maxPx: number) => parsePicture(await invoke<ArrayBuffer>("open_image", { path, maxPx }));
// A WRP gives the terrain and the objects. The WRP has no TB offset, so xllcorner and yllcorner are 0.
export const loadWrp = async (path: string) => {
	const b = await invoke<ArrayBuffer>("open_wrp", { path });
	const n = new DataView(b).getUint32(0, true);
	return { terrain: parseAsc(b.slice(4, 4 + n)), objects: parseObjects(b.slice(4 + n)) };
};

// Synthetic terrain for the speed test without a file: hills and valleys on an n x n grid.
export function demoTerrain(n: number, cell: number): Terrain {
	const heights = new Float32Array(n * n);
	for (let r = 0; r < n; r++) {
		for (let c = 0; c < n; c++) {
			const x = c / n;
			const y = r / n;
			heights[r * n + c] = 120 * Math.sin(x * 9) * Math.cos(y * 7) + 40 * Math.sin(x * 41 + y * 23) + 8 * Math.sin(x * 211) * Math.sin(y * 197) + 150;
		}
	}
	return { ncols: n, nrows: n, cell, xll: 200000, yll: 0, heights };
}

export interface Mesh {
	min: Float32Array;
	max: Float32Array;
	// Shift of the binarizer: original model origin = centered position + offset (Arma model space).
	offset: Float32Array;
	// Arma model space: x right, y up, z forward.
	positions: Float32Array;
	normals: Float32Array;
	uvs: Float32Array;
	// Second UV set. All zero when the model has no second set.
	uv1: Float32Array;
	groups: { texture: string; material: string; indices: Uint32Array }[];
	land: Float32Array;
	contact: Float32Array;
}

// A model material (RVMAT). Stage n is stages[n]. See rvmat::Material in the core library.
export interface Material {
	pixelShader: string;
	// renderFlags[] of the RVMAT, for example NoZWrite (glass, decals: blended).
	renderFlags: string[];
	stages: { texture: string; uvSource: string; aside: number[]; up: number[]; pos: number[] }[];
}

export interface Dds {
	dxt5: boolean;
	mips: { width: number; height: number; data: Uint8Array }[];
}

export function parseMesh(b: ArrayBuffer): Mesh {
	const d = new DataView(b);
	const n = d.getUint32(0, true);
	const g = d.getUint32(4, true);
	let o = 8;
	const f = (count: number) => {
		const a = new Float32Array(b, o, count);
		o += count * 4;
		return a;
	};
	const min = f(3);
	const max = f(3);
	const offset = f(3);
	const positions = f(n * 3);
	const normals = f(n * 3);
	const uvs = f(n * 2);
	const uv1 = f(n * 2);
	// 1 for a vertex on the terrain surface (decals), else 0.
	const land = f(n);
	const groups = [];
	const text = () => {
		const len = d.getUint32(o, true);
		const t = new TextDecoder().decode(new Uint8Array(b, o + 4, len));
		o += 4 + Math.ceil(len / 4) * 4;
		return t;
	};
	for (let i = 0; i < g; i++) {
		const count = d.getUint32(o, true);
		o += 4;
		const texture = text();
		const material = text();
		groups.push({ texture, material, indices: new Uint32Array(b, o, count) });
		o += count * 4;
	}
	// LandContact points (model space) of a model that the game shears to the terrain (placement = slopelandcontact).
	const k = d.getUint32(o, true);
	o += 4;
	const contact = f(k * 3);
	return { min, max, offset, positions, normals, uvs, uv1, groups, land, contact };
}

export function parseDds(b: ArrayBuffer): Dds {
	const d = new DataView(b);
	const count = d.getUint32(4, true);
	const mips = [];
	let o = 8;
	for (let i = 0; i < count; i++) {
		const size = d.getUint32(o + 4, true);
		mips.push({ width: d.getUint16(o, true), height: d.getUint16(o + 2, true), data: new Uint8Array(b, o + 8, size) });
		o += 8 + size;
	}
	return { dxt5: d.getUint32(0, true) === 5, mips };
}

export const scanModels = (roots: string[]) => invoke<{ keys: string[]; textures: number; duplicates: [string, string[]][] }>("scan_models", { roots });
export const loadMesh = async (name: string, low: boolean) => parseMesh(await invoke<ArrayBuffer>("model_mesh", { name, low }));
export const loadDds = async (path: string) => parseDds(await invoke<ArrayBuffer>("texture", { path }));
export const loadMaterial = (path: string) => invoke<Material>("material", { path });

// A Terrain Builder project: settings and the paths of the imported files. See alb::Tv4p in the core library.
export interface Project {
	name: string;
	mapFrame: number[];
	wrpFolder: string;
	layersCfg: string;
	textureLayer: number;
	tilePx: number;
	overlapPx: number;
	metersPerPx: number;
	heightmap: string;
	satellite: string;
	mask: string;
	// The exported WRP, when the file exists.
	wrp: string | null;
}

export const loadProject = (path: string) => invoke<Project>("open_tv4p", { path });
export const readText = (path: string) => invoke<string>("read_text", { path });
export const writeText = (path: string, text: string) => invoke<void>("write_text", { path, text });
// Layer mask of the mask painter. A pixel value is an index in `colors`. 255 is outside the image.
export interface MaskInfo {
	width: number;
	height: number;
	colors: [number, number, number][];
	// Layer name of each palette color.
	names: string[];
	// Pixels that were not an exact palette color. They got the nearest color.
	inexact: number;
	warnings: string[];
}

// Changed area: x0, y0, x1, y1 in mask pixels (x1 and y1 not included). Row 0 is the north row.
export type Rect = [number, number, number, number];

export const maskOpen = (path: string, layersCfg: string) => invoke<MaskInfo>("mask_open", { path, layersCfg });
// Ground detail textures of layers.cfg (see layer_detail in main.rs): the _co texture of each layer, the layer of each palette color.
// Close the open map in the core (see reset_state in main.rs).
export const dirExists = (path: string) => invoke<boolean>("dir_exists", { path });
export const resetState = () => invoke<void>("reset_state");
export const layerDetail = (layersCfg: string) => invoke<{ co: string[]; palette: number[]; diffuse: number; repeat: number; missing: string[]; mid: string; water: number[] | null; clutter: { layers: ClutterItem[][]; grid: number | null } | null }>("layer_detail", { layersCfg });
export const maskRegion = async (level: number, x: number, y: number, w: number, h: number) => new Uint8Array(await invoke<ArrayBuffer>("mask_region", { level, x, y, w, h }));
// Color -1 is erase (back to the imported mask).
// Lines through the points. One point paints one dab.
export const maskPaint = (points: number[][], radius: number, hardness: number, opacity: number, color: number, seed: number) =>
	invoke<Rect | null>("mask_paint", { points, radius, hardness, opacity, color, seed });
export const maskEndStroke = () => invoke<void>("mask_end_stroke");
export const maskFill = (x: number, y: number, color: number) => invoke<Rect | null>("mask_fill", { x, y, color });
export const maskPolygon = (points: number[][], color: number) => invoke<Rect | null>("mask_polygon", { points, color });
export const maskUndo = (redo: boolean) => invoke<Rect | null>("mask_undo", { redo });
export const maskExport = (path: string) => invoke<void>("mask_export", { path });

// Settings of one object fill. See fill::Settings in the core library. Distances in meters, angles in degrees.
export interface FillSettings {
	weights: number[];
	density: number;
	spacing: number;
	randomYaw: boolean;
	scale: [number, number];
	tilt: boolean;
	seed: number;
	colors: number[];
	inset: number;
	feather: number;
	noiseScale: number;
	noise: number;
	maxSlope: number;
	minHeight: number;
	maxHeight: number;
	noWater: boolean;
	// Existing objects: x, y (local meters) and radius.
	avoid: [number, number, number][];
	gap: number;
}

// Placed objects: 7 values for each object: x, y, yaw, pitch, roll, scale, and the recipe entry.
export interface FillResult {
	count: number;
	truncated: boolean;
	values: Float32Array;
	entries: Uint32Array;
}

// polygon: the fill area in local meters instead of the mask colors.
export const fillEstimate = (settings: FillSettings, polygon?: number[][]) => invoke<number>("fill_estimate", { settings, polygon });
export async function fillRun(settings: FillSettings, limit: number, polygon?: number[][]): Promise<FillResult> {
	const b = await invoke<ArrayBuffer>("fill_run", { settings, limit, polygon });
	const d = new DataView(b);
	const count = d.getUint32(0, true);
	return { count, truncated: d.getUint32(4, true) === 1, values: new Float32Array(b, 8, count * 7), entries: new Uint32Array(b, 8, count * 7) };
}

// Satellite painter. The image stays in the Rust core. Region pixels are RGBA, alpha 0 is outside the image.
export type SatTool = "color" | "clone" | "smooth" | "texture";
export const satOpen = async (path: string) => {
	const [width, height] = await invoke<[number, number]>("sat_open", { path });
	return { width, height };
};
export const satRegion = async (level: number, x: number, y: number, w: number, h: number) => new Uint8Array(await invoke<ArrayBuffer>("sat_region", { level, x, y, w, h }));
// Offset: source minus destination, for the clone tool.
export const satPaint = (points: number[][], radius: number, hardness: number, opacity: number, tool: SatTool, color: number[], offset: number[]) =>
	invoke<Rect | null>("sat_paint", { points, radius, hardness, opacity, tool, color, offset });
export const satEndStroke = () => invoke<void>("sat_end_stroke");
// Color change of the whole satellite image (see sat::Adjust): hue in degrees, the others -1 to 1. One undo step.
export interface SatAdjust {
	hue: number;
	saturation: number;
	lightness: number;
	brightness: number;
	contrast: number;
}
export const satAdjust = (adjust: SatAdjust) => invoke<Rect | null>("sat_adjust", { adjust });
export const satUndo = (redo: boolean) => invoke<Rect | null>("sat_undo", { redo });
export const satPick = (x: number, y: number) => invoke<[number, number, number]>("sat_pick", { x, y });
// One repeat of the texture covers size x size pixels of the satellite image.
export const satTexture = (path: string, size: number) => invoke<[number, number]>("sat_texture", { path, size });
export const satExport = (path: string) => invoke<void>("sat_export", { path });

// Height editor. The heights stay in the Rust core. Positions are local meters, areas are cells (row 0 is the north row).
export type HeightTool = "raise" | "lower" | "smooth" | "flatten" | "plane" | "noise";
// value: the height of flatten, or the noise size in meters. plane: x, y, height of two points.
export const heightPaint = (points: number[][], radius: number, hardness: number, strength: number, tool: HeightTool, value: number, plane: number[], seed: number) =>
	invoke<Rect | null>("height_paint", { points, radius, hardness, strength, tool, value, plane, seed });
export const heightEndStroke = () => invoke<void>("height_end_stroke");
export const heightUndo = (redo: boolean) => invoke<Rect | null>("height_undo", { redo });
export const heightRegion = async (r: Rect) => new Float32Array(await invoke<ArrayBuffer>("height_region", { c0: r[0], r0: r[1], w: r[2] - r[0], h: r[3] - r[1] }));
export const heightPick = (x: number, y: number) => invoke<number>("height_pick", { x, y });
export const heightStampLoad = (path: string) => invoke<[number, number]>("height_stamp_load", { path });
// The stamp covers size x size meters. Each cell gets height meters times the stamp value: added, or (max) raised to it.
export const heightStamp = (x: number, y: number, size: number, height: number, max: boolean) => invoke<Rect | null>("height_stamp", { x, y, size, height, max });
// decimals null: as in the source ASC.
export const heightExport = (path: string, decimals: number | null) => invoke<void>("height_export", { path, decimals });

// Files of the project. write_bytes writes a temporary file first, then renames it.
export const readBytes = async (path: string) => new Uint8Array(await invoke<ArrayBuffer>("read_bytes", { path }));
export const writeBytes = (path: string, bytes: Uint8Array) => invoke<void>("write_bytes", bytes, { headers: { path: encodeURIComponent(path) } });
// Write the open images into the project folder (only the images that changed). The result tells what was written.
export const projectSave = (dir: string) => invoke<{ mask: boolean; satellite: boolean; heights: boolean }>("project_save", { dir });
export const projectHeights = async (dir: string) => parseAsc(await invoke<ArrayBuffer>("project_heights", { dir }));
export const projectSaved = (dir: string) => invoke<void>("project_saved", { dir });

// Shape actions. Mask positions are mask pixels, height positions local meters.
export const maskBand = (points: number[][], half: number, feather: number, color: number, seed: number) => invoke<Rect | null>("mask_band", { points, half, feather, color, seed });
export const heightFlattenPolygon = (points: number[][], target: number | null, feather: number) => invoke<Rect | null>("height_flatten_polygon", { points, target, feather });
export const heightOffset = (dh: number) => invoke<Rect | null>("height_offset", { dh });
// Cut or fill along lines (one undo step). maxSlope and maxTilt are fractions (0.12 is 12 %), 0 for no limit and flat across.
export const heightRoad = (lines: number[][][], width: number, feather: number, smooth: number, maxSlope: number, maxTilt: number) => invoke<Rect | null>("height_road", { lines, width, feather, smooth, maxSlope, maxTilt });
// Shapefiles. The coordinates are TB coordinates (with the map offset).
export type ShpKind = "point" | "line" | "polygon";
export interface ShpShape {
	parts: number[][][];
	props: [string, string][];
}
export const shpWrite = (path: string, kind: ShpKind, shapes: ShpShape[]) => invoke<void>("shp_write", { path, kind, shapes });
export const shpRead = (path: string) => invoke<{ kind: ShpKind; shapes: ShpShape[] }>("shp_read", { path });
// Road types of RoadsLib.cfg. Road type n is the line with the property ID = n.
export interface RoadType {
	id: number;
	width: number;
	texture: string;
	endTexture: string;
	material: string;
	map: string;
	color: [number, number, number, number] | null;
}
export const roadsRead = (path: string) => invoke<{ types: RoadType[]; warnings: string[] }>("roads_read", { path });
// Export for the game (see game_export in main.rs). `objects` is the object data of GameExport.objectBytes.
export interface GameReport {
	pngs: string[];
	lines: string[];
}
export const gameExport = (settings: Record<string, unknown>, objects: Uint8Array) => invoke<GameReport>("game_export", objects, { headers: { settings: encodeURIComponent(JSON.stringify(settings)) } });
// Cancel the long job that runs (fill, export for the game, model scan). The job then fails with "cancelled".
export const cancelJob = () => invoke<void>("cancel_job");
