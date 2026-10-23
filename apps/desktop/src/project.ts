// Project file: `<name>.ttproj` (JSON) and the folder `<name>_data` with mask.png, satellite.png, heights.bin, source.asc,
// objects.bin, and objects_raw.txt. See README.md.
// objects.bin: magic "TTO1", object count u32, then for each object: model u32, layer u16, flags u16 (bit 0: the object has a raw line),
// fill i32, the transform (12 f32). objects_raw.txt: the raw lines of the objects with bit 0, in the same order, each ends with LF.
// The raw lines are Latin-1 (one byte for each character), as the object text files.
import { ObjectStore, type Fill, type Layer } from "./store";
import type { GameSettings } from "./GameExport";
import type { Shape } from "./shapes";

export interface ProjectFile {
	format: "terrain-tool-project";
	version: 1;
	// The images in the data folder.
	files: { mask: boolean; satellite: boolean; heights: boolean };
	layersCfg?: string;
	modelRoots: string[];
	models: string[];
	layers: Layer[];
	order: number[];
	fills: Fill[];
	shapes?: Shape[];
	roadsLib?: string;
	// The map folder (the mod folder of the map, for example P:\Bromine\Bro_Appalachia).
	mapRoot?: string;
	gameExport?: GameSettings;
	activeLayer: number;
	// UI settings (z mode of the object text, mask overlay, and so on).
	settings: Record<string, unknown>;
}

// The data folder of a project file.
export const dataDir = (path: string) => path.replace(/\.ttproj$/i, "") + "_data";
export const join = (dir: string, name: string) => `${dir}${/[\\/]$/.test(dir) ? "" : "\\"}${name}`;

export function storeToBytes(st: ObjectStore): { bin: Uint8Array; raw: Uint8Array } {
	const ids = [...st.ids()];
	const bin = new Uint8Array(8 + ids.length * 60);
	const d = new DataView(bin.buffer);
	bin.set([84, 84, 79, 49]);
	d.setUint32(4, ids.length, true);
	const raw: string[] = [];
	ids.forEach((id, i) => {
		const o = 8 + i * 60;
		const r = st.raw[id];
		d.setUint32(o, st.model[id], true);
		d.setUint16(o + 4, st.layer[id], true);
		d.setUint16(o + 6, r === undefined ? 0 : 1, true);
		d.setInt32(o + 8, st.fill[id], true);
		for (let k = 0; k < 12; k++) d.setFloat32(o + 12 + k * 4, st.t[id * 12 + k], true);
		if (r !== undefined) raw.push(r);
	});
	const text = raw.map((l) => l + "\n").join("");
	const rawBytes = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i++) rawBytes[i] = text.charCodeAt(i);
	return { bin, raw: rawBytes };
}

// A store from the project file and the object bytes.
export function storeFromBytes(p: ProjectFile, bin: Uint8Array, raw: Uint8Array): ObjectStore {
	const st = new ObjectStore();
	for (const m of p.models) st.modelId(m);
	st.layers = p.layers;
	st.order = p.order;
	st.fills = p.fills;
	st.shapes = p.shapes ?? [];
	const d = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
	if (bin.length < 8 || String.fromCharCode(...bin.subarray(0, 4)) !== "TTO1") throw "objects.bin: not an object file";
	const n = d.getUint32(4, true);
	if (bin.length !== 8 + n * 60) throw "objects.bin: the file size does not agree with the object count";
	let text = "";
	for (let i = 0; i < raw.length; i += 65536) text += String.fromCharCode(...raw.subarray(i, i + 65536));
	const lines = text.split("\n");
	let k = 0;
	for (let i = 0; i < n; i++) {
		const o = 8 + i * 60;
		const t = new Float32Array(12);
		for (let j = 0; j < 12; j++) t[j] = d.getFloat32(o + 12 + j * 4, true);
		const fill = d.getInt32(o + 8, true);
		st.restore(i, { model: d.getUint32(o, true), t, layer: d.getUint16(o + 4, true), raw: d.getUint16(o + 6, true) & 1 ? lines[k++] : undefined, fill: fill < 0 ? undefined : fill });
	}
	return st;
}
