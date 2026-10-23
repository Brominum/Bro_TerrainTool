import { expect, test } from "vitest";
import { ObjectStore } from "./store";

test("new layer names count up from the largest number", () => {
	const st = new ObjectStore();
	st.addLayer("default");
	expect(st.newLayerName()).toBe("New Layer 1");
	st.addLayer(st.newLayerName());
	st.addLayer("New Layer 5");
	expect(st.newLayerName()).toBe("New Layer 6");
});

test("snapshots keep the fill of an object", () => {
	const st = new ObjectStore();
	st.addLayer("a");
	const a = st.add({ model: st.modelId("m"), t: new Float32Array(12), layer: 0, fill: 3 });
	const b = st.add({ model: 0, t: new Float32Array(12), layer: 0 });
	expect(st.snapshot(a)!.fill).toBe(3);
	expect(st.snapshot(b)!.fill).toBeUndefined();
	st.restore(a, null);
	st.restore(a, { model: 0, t: new Float32Array(12), layer: 0 });
	expect(st.fill[a]).toBe(-1);
});

test("move skips deleted layers", () => {
	const st = new ObjectStore();
	["a", "b", "c"].forEach((n) => st.addLayer(n));
	st.layers[1].deleted = true;
	st.move(2, -1);
	expect(st.shown()).toEqual([2, 0]);
	st.move(2, -1);
	expect(st.shown()).toEqual([2, 0]);
	st.move(0, 1);
	expect(st.order).toEqual([2, 1, 0]);
});
