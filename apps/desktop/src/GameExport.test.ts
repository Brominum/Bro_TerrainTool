// Export for the game: default settings and the object data. Run: npm test
import { expect, it } from "vitest";
import { bestTiles, defaultSettings, exportIds, lowestOverlap, objectBytes } from "./GameExport";
import { ObjectStore } from "./store";

it("takes the default paths from the TB project", () => {
	const s = defaultSettings({ name: "bro_msi", wrpFolder: "p:\\bromine\\bro_msi\\", tilePx: 1024, overlapPx: 128, textureLayer: 32 } as never);
	expect([s.wrp, s.layersDir, s.prefix, s.roadsDir]).toEqual(["p:\\bromine\\bro_msi\\bro_msi.wrp", "p:\\bromine\\bro_msi\\data\\layers", "bromine\\bro_msi\\data\\layers\\", "p:\\bromine\\bro_msi\\data\\roads"]);
	expect([s.tilePx, s.overlapPx, s.layerSize]).toEqual([1024, 128, 32]);
	expect(defaultSettings(null).wrp).toBe("");
});

it("writes only the objects of shown layers", () => {
	const st = new ObjectStore();
	const [a, h] = [st.addLayer("a"), st.addLayer("h")];
	st.layers[h].visible = false;
	const t = (x: number) => new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, x, 0, 0]);
	st.restore(0, { model: st.modelId("m1"), t: t(1), layer: h });
	st.restore(1, { model: st.modelId("m2"), t: t(2), layer: a });
	st.restore(2, { model: st.modelId("m2"), t: t(-32), layer: a });
	const { ids, outside } = exportIds(st, 100, 100);
	expect([ids, outside]).toEqual([[1, 2], [2]]);
	const b = objectBytes(st, [1]);
	const d = new DataView(b.buffer);
	expect([d.getUint32(0, true), d.getFloat32(4 + 9 * 4, true), d.getUint32(4 + 48, true)]).toEqual([1, 2, 1]);
	expect(new TextDecoder().decode(b.subarray(4 + 52))).toBe("m1\nm2");
});

it("finds the lowest overlap at which the cells fit (the same cases as tiles.rs)", () => {
	expect(lowestOverlap(2048, 2048, 64)).toBe(64);
	expect(lowestOverlap(5120, 1024, 32)).toBe(32);
	expect(lowestOverlap(5120, 1024, 33)).toBeNull();
});

it("takes 2048 px tiles when an overlap fits, else a smaller tile", () => {
	expect(bestTiles(5120, 32)).toEqual({ tile: 2048, overlap: 32 });
	expect(bestTiles(16384, 64)).toEqual({ tile: 2048, overlap: 64 });
	expect(bestTiles(5120, 33)).toBeNull();
});
