// Shapes: curves, points along a line, and spline objects. Run: npm test
import { expect, it } from "vitest";
import { along, curve, inside, newSpline, roadId, splinePlaces, type Shape } from "./shapes";

const line = (points: number[][], extra: Partial<Shape> = {}): Shape => ({ id: 1, kind: "line", name: "a", group: "g", points, props: [], smooth: false, closed: false, ...extra });

it("points along a line", () => {
	const a = along([[0, 0], [6, 0], [6, 4]], 2);
	expect(a.map((p) => [p.x, p.y])).toEqual([[0, 0], [2, 0], [4, 0], [6, 0], [6, 2], [6, 4]]);
	expect([a[1].dx, a[4].dy]).toEqual([1, 1]);
});

it("a smooth curve goes through the points", () => {
	const s = line([[0, 0], [10, 10], [20, 0], [30, 10]], { smooth: true });
	const c = curve(s, 1);
	for (const p of s.points) expect(c.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-9)).toBe(true);
	expect(c.length).toBeGreaterThan(30);
	// A polygon ring has no closing point. A closed polyline ends at its start.
	expect(curve({ ...s, kind: "polygon" }, 1).at(-1)).not.toEqual([0, 0]);
	expect(curve({ ...s, closed: true }, 1).at(-1)).toEqual(curve({ ...s, closed: true }, 1)[0]);
	expect(inside([[0, 0], [10, 0], [0, 10]], 2, 2)).toBe(true);
	expect(inside([[0, 0], [10, 0], [0, 10]], 6, 6)).toBe(false);
});

it("fence: one model for each model length, along the line, on the slope", () => {
	const s = line([[0, 0], [40, 0]]);
	const p = splinePlaces(s, newSpline("Fence"), 4, true, (x) => x * 0.1);
	expect(p.length).toBe(10);
	expect(p.map((o) => o.x)).toEqual([2, 6, 10, 14, 18, 22, 26, 30, 34, 38]);
	// The line goes east. The model x axis goes along it: yaw 0. The slope goes up to the east, so the right side (east) is up: roll < 0.
	expect(p[0].yaw).toBeCloseTo(0, 9);
	expect(p[0].roll).toBeCloseTo((-Math.atan(0.1) * 180) / Math.PI, 6);
	expect(p[0].pitch).toBe(0);
});

it("runway lights: two rows, the same seed gives the same result", () => {
	const s = line([[0, 0], [0, 300]]);
	const sp = { ...newSpline("Runway lights"), jitter: 0.5, seed: 7 };
	const p = splinePlaces(s, sp, 1, false, () => 0);
	expect(p.length).toBe(22);
	// The line goes north. The right side is east (+x).
	expect(Math.abs(p[0].x - 23)).toBeLessThan(0.51);
	expect(Math.abs(p[1].x + 23)).toBeLessThan(0.51);
	expect(p[0].yaw).toBeCloseTo(0, 9);
	expect(splinePlaces(s, sp, 1, false, () => 0)).toEqual(p);
	expect(splinePlaces(s, { ...sp, seed: 8 }, 1, false, () => 0)).not.toEqual(p);
});
it("a line with a numeric ID is a road", () => {
	expect(roadId(line([], { props: [["id", " 12 "]] }))).toBe(12);
	expect(roadId(line([], { props: [["ID", "a1"]] }))).toBeUndefined();
	expect(roadId(line([]))).toBeUndefined();
});

it("a smooth curve has no loops where long and short segments meet", () => {
	// Collinear points with segments of 8 m and 540 m (as in the roads.shp of bro_laguna): the curve stays on the line and goes forward.
	const s: Shape = { id: 1, kind: "line", name: "r", group: "g", points: [[0, 0], [8, 0], [548, 0], [556, 0], [564, 0]], props: [], smooth: true, closed: false };
	const c = curve(s, 2);
	for (let i = 1; i < c.length; i++) {
		expect(Math.abs(c[i][1])).toBeLessThan(1e-6);
		expect(c[i][0]).toBeGreaterThanOrEqual(c[i - 1][0] - 1e-9);
	}
});
