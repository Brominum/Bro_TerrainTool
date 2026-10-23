// Round trip of the objects through the project file bytes. Run: npm test
import { readFileSync, existsSync } from "node:fs";
import { expect, it } from "vitest";
import { joinLines, parseObjectText } from "./objtext";
import { storeFromBytes, storeToBytes, type ProjectFile } from "./project";
import { ObjectStore } from "./store";

const sample = new URL("../../../tests/fixtures/objects/Trees2_3_2.txt", import.meta.url);

function project(st: ObjectStore): ProjectFile {
	return { format: "terrain-tool-project", version: 1, files: { mask: false, satellite: false, heights: false }, modelRoots: [], models: st.models, layers: st.layers, order: st.order, fills: st.fills, activeLayer: 0, settings: {} };
}

it("objects, layers, fills, and raw lines round trip", () => {
	const st = new ObjectStore();
	st.addLayer("a");
	st.addLayer("New Layer 1");
	st.layers[0].deleted = true;
	st.order = [1, 0];
	const t = Float32Array.from({ length: 12 }, (_, i) => i * 1.5 - 3);
	st.add({ model: st.modelId("tree_a"), t, layer: 1, raw: '"tree_a";1;2;3;0;0;1;0', fill: 0 });
	st.add({ model: st.modelId("Bush_B"), t: t.map((v) => v * 2), layer: 0 });
	st.add({ model: 0, t, layer: 1, raw: "é line" });
	const { bin, raw } = storeToBytes(st);
	const b = storeFromBytes(JSON.parse(JSON.stringify(project(st))), bin, raw);
	expect(b.count).toBe(3);
	expect(b.models).toEqual(["tree_a", "Bush_B"]);
	expect(b.order).toEqual([1, 0]);
	expect(b.layers[0].deleted).toBe(true);
	for (const id of [0, 1, 2]) expect(b.snapshot(id)).toEqual(st.snapshot(id));
	expect(() => storeFromBytes(project(st), bin.subarray(0, 20), raw)).toThrow();
});

it.skipIf(!existsSync(sample))("Trees2_3_2.txt lines stay byte-identical", () => {
	const text = readFileSync(sample, "latin1");
	const st = new ObjectStore();
	st.addLayer("trees");
	for (const o of parseObjectText(text).objects) st.add({ model: st.modelId(o.name), t: new Float32Array(12), layer: 0, raw: o.raw });
	const { bin, raw } = storeToBytes(st);
	const b = storeFromBytes(project(st), bin, raw);
	expect(joinLines([...b.ids()].map((id) => b.raw[id]!))).toBe(text);
});
