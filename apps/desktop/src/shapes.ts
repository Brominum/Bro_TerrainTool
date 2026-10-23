// Shapes: polylines, polygons, and points in local meters (x east, y north). A polyline can be a spline that generates objects.
// The shapes are in the object store and in the project file. Pure functions here; the 3D editing is in shapeview.ts.

export type ShapeKind = "line" | "polygon" | "point";

// Objects along a polyline. Spacing in meters; `useLength`: the spacing is the model length (fences, walls).
export interface SplineSettings {
	preset: string;
	model: string;
	spacing: number;
	useLength: boolean;
	// Yaw offset in degrees, side offset in meters, and a second row on the other side (runway lights).
	yaw: number;
	side: number;
	twoRows: boolean;
	// Random position change in meters (along and across the line).
	jitter: number;
	// Pitch follows the terrain along the line.
	conform: boolean;
	seed: number;
}

export interface Shape {
	id: number;
	kind: ShapeKind;
	name: string;
	// The SHP export writes one file for each group (for example "roads" gives roads.shp).
	group: string;
	points: number[][];
	// Properties for the DBF (for example ID = 1 for a road of RoadsLib.cfg).
	props: [string, string][];
	// A smooth curve (Catmull-Rom) through the points. A closed polyline joins its last point to its first.
	smooth: boolean;
	closed: boolean;
	spline?: SplineSettings;
	// The fill entry (ObjectStore.fills) of the generated objects.
	fill?: number;
	deleted?: boolean;
}

export const PRESETS: Record<string, Partial<SplineSettings>> = {
	Fence: { spacing: 4, useLength: true, yaw: 0, side: 0, twoRows: false, jitter: 0, conform: true },
	"Runway lights": { spacing: 30, useLength: false, yaw: 0, side: 23, twoRows: true, jitter: 0, conform: false },
	"Runway line": { spacing: 1, useLength: false, yaw: 0, side: 0, twoRows: false, jitter: 0, conform: true },
	Custom: {},
};

export function newSpline(preset = "Fence", model = ""): SplineSettings {
	return { preset, model, spacing: 4, useLength: true, yaw: 0, side: 0, twoRows: false, jitter: 0, conform: true, seed: 1, ...PRESETS[preset] };
}

// The line through the points of a shape. Smooth: centripetal Catmull-Rom with about `step` meters between the samples. Closed: back to
// the start. The centripetal form does not make loops or spikes where long and short segments meet (imported roads have both).
export function curve(s: Pick<Shape, "points" | "smooth" | "closed" | "kind">, step = 2): number[][] {
	const p = s.points;
	const closed = s.closed || s.kind === "polygon";
	if (!s.smooth || p.length < 3) return closed && s.kind === "line" && p.length > 2 ? [...p, p[0]] : p.slice();
	const n = p.length;
	// An open line continues straight past its ends.
	const at = (i: number): number[] => {
		if (closed) return p[(i + n) % n];
		if (i < 0) return [2 * p[0][0] - p[1][0], 2 * p[0][1] - p[1][1]];
		if (i > n - 1) return [2 * p[n - 1][0] - p[n - 2][0], 2 * p[n - 1][1] - p[n - 2][1]];
		return p[i];
	};
	const knot = (a: number[], b: number[]) => Math.max(1e-4, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
	const lerp = (a: number[], b: number[], ta: number, tb: number, t: number) => [0, 1].map((q) => ((tb - t) * a[q] + (t - ta) * b[q]) / (tb - ta));
	const out: number[][] = [];
	const segs = closed ? n : n - 1;
	for (let i = 0; i < segs; i++) {
		const [a, b, c, d] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
		const t1 = knot(a, b);
		const t2 = t1 + knot(b, c);
		const t3 = t2 + knot(c, d);
		const k = Math.max(1, Math.ceil(Math.hypot(c[0] - b[0], c[1] - b[1]) / step));
		for (let j = 0; j < k; j++) {
			const t = t1 + ((t2 - t1) * j) / k;
			const [a1, a2, a3] = [lerp(a, b, 0, t1, t), lerp(b, c, t1, t2, t), lerp(c, d, t2, t3, t)];
			out.push(lerp(lerp(a1, a2, 0, t2, t), lerp(a2, a3, t1, t3, t), t1, t2, t));
		}
	}
	// A polygon stays open (the ring closes itself). A closed polyline ends at its start.
	out.push(closed ? (s.kind === "line" ? out[0] : out[out.length - 1]) : p[n - 1]);
	if (s.kind === "polygon") out.pop();
	return out;
}

// Points along a line, each `spacing` meters, with the direction (unit vector) of the line there. The first point is at the start.
export function along(line: number[][], spacing: number): { x: number; y: number; dx: number; dy: number }[] {
	const out: { x: number; y: number; dx: number; dy: number }[] = [];
	if (line.length < 2 || spacing <= 0) return out;
	let next = 0;
	let s0 = 0;
	for (let i = 0; i + 1 < line.length; i++) {
		const [a, b] = [line[i], line[i + 1]];
		const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
		if (len === 0) continue;
		const [dx, dy] = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
		while (next <= s0 + len + 1e-9) {
			const t = (next - s0) / len;
			out.push({ x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, dx, dy });
			next += spacing;
		}
		s0 += len;
	}
	return out;
}

// Seeded random numbers from 0 to 1 (mulberry32).
export function random(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// Positions and yaw (compass degrees) of the spline objects. `length`: the model length along its long axis, and true when the
// long axis is the model x axis (then the yaw turns the x axis along the line). `height` gives the terrain for the pitch.
export function splinePlaces(s: Shape, sp: SplineSettings, length: number, xLong: boolean, height: (x: number, y: number) => number): { x: number; y: number; yaw: number; pitch: number; roll: number }[] {
	const spacing = sp.useLength ? Math.max(0.1, length) : Math.max(0.1, sp.spacing);
	const line = curve(s, Math.min(2, spacing / 2));
	const rnd = random(sp.seed);
	const out: { x: number; y: number; yaw: number; pitch: number; roll: number }[] = [];
	// A model placed by its length is centred on its part of the line.
	const pts = along(line, spacing).map((p) => (sp.useLength ? { ...p, x: p.x + (p.dx * spacing) / 2, y: p.y + (p.dy * spacing) / 2 } : p));
	if (sp.useLength && pts.length) pts.pop();
	for (const p of pts) {
		for (const side of sp.twoRows ? [sp.side, -sp.side] : [sp.side]) {
			const j = () => (rnd() * 2 - 1) * sp.jitter;
			// The right side of the line is (dy, -dx).
			const [x, y] = [p.x + p.dy * side + p.dx * j(), p.y - p.dx * side + p.dy * j()];
			let yaw = (Math.atan2(p.dx, p.dy) * 180) / Math.PI - (xLong ? 90 : 0) + sp.yaw;
			yaw = ((yaw % 360) + 360) % 360;
			let [pitch, roll] = [0, 0];
			if (sp.conform) {
				const d = Math.max(0.5, Math.min(spacing / 2, 4));
				const rise = (height(x + p.dx * d, y + p.dy * d) - height(x - p.dx * d, y - p.dy * d)) / (2 * d);
				const a = (Math.atan(rise) * 180) / Math.PI;
				// Positive pitch lifts the front (z axis), positive roll lowers the right side (x axis). See axes() in transform.ts.
				if (xLong) roll = -a;
				else pitch = a;
			}
			out.push({ x, y, yaw, pitch, roll });
		}
	}
	return out;
}

// Even-odd point in polygon.
export function inside(ring: number[][], x: number, y: number): boolean {
	let c = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [a, b] = [ring[i], ring[j]];
		if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
	}
	return c;
}

// Distance from a point to the segment a-b.
export function segDist(x: number, y: number, a: number[], b: number[]): number {
	const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
	const l2 = dx * dx + dy * dy;
	const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2)) : 0;
	return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
}

// A property of a shape (the key ignores case).
export function prop(s: Shape, key: string): string | undefined {
	return s.props.find((p) => p[0].toLowerCase() === key.toLowerCase())?.[1];
}

// The road type of a line: its numeric ID property.
export function roadId(s: Shape): number | undefined {
	const v = prop(s, "ID");
	return v !== undefined && /^\s*\d+\s*$/.test(v) ? Number(v) : undefined;
}

// The SHP points of a shape in TB coordinates. TB makes a smooth curve through the points of a road itself, so a smooth road gives its points, not the curve.
export function shpPoints(s: Shape, xll: number, yll: number): number[][] {
	const p = s.kind === "point" ? s.points.slice(0, 1) : s.smooth && roadId(s) !== undefined ? s.points : curve(s, 2);
	return p.map((q) => [q[0] + xll, q[1] + yll]);
}
