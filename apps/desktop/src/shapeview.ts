// Shape editor in the 3D view (the "Shapes" view). The shapes are in the object store (ObjectStore.shapes).
// Mouse: while a new shape is open, each click adds a point; Enter, a double-click, or Escape ends it (Backspace removes the last point).
// Else: drag a point to move it, click a shape to select it, Ctrl+click adds a point at the end of the selected shape.
// Delete removes the selected point. Each change is one undo step of the editor, together with the objects of its spline.
// A line with the property ID shows as a road when RoadsLib.cfg has that road type: a band of the road width with the road texture.
// The property ORDER sets the layering: 0 is on top, higher numbers are below.
import * as THREE from "three";
import { withFog } from "./env";
import { roadsRead, type FillSettings, type RoadType } from "./data";
import type { Editor } from "./editor";
import { along, curve, prop, roadId, splinePlaces, type Shape, type ShapeKind } from "./shapes";
import type { Change } from "./store";
import { fromText } from "./transform";
import type { Viewer } from "./viewer";

// Pick distance in CSS pixels. The point markers have a fixed screen size (device pixels times the pixel ratio).
const PICK_PX = 14;
const COLORS: Record<ShapeKind, number> = { line: 0xffd040, polygon: 0x40d0ff, point: 0xff60ff };
const MIN_POINTS: Record<ShapeKind, number> = { line: 2, polygon: 3, point: 1 };

export class ShapeEditor {
	enabled = false;
	selected: number | null = null;
	point: number | null = null;
	// The id of the new shape while the user adds its points.
	drawing: number | null = null;
	// Shape layers are the shape groups. Hidden groups do not draw; hidden and locked groups cannot be clicked or changed in the view.
	// New shapes go into the active group (null: lines, polygons, or points by kind).
	// shortcut: hidden, locked, and active are not saved in the project file. Save them when the user asks.
	hidden = new Set<string>();
	locked = new Set<string>();
	activeGroup: string | null = null;
	// More shapes selected in the list (for "Delete selected"). They draw white like the selected shape.
	picked = new Set<number>();
	onChange?: () => void;
	onError?: (e: string) => void;
	private group = new THREE.Group();
	// Road types of RoadsLib.cfg by ID, and one material for each.
	roads = new Map<number, RoadType>();
	private roadMats = new Map<string, THREE.MeshLambertMaterial>();
	// The path of the RoadsLib.cfg (saved in the project).
	roadsPath = "";
	private heightsTimer = 0;
	private drag?: { id: number; i: number; before: Shape[]; moved: boolean };
	// Erase tool: "polygon" (click the points; Enter or a double-click ends it) or "lasso" (drag). It deletes the objects inside
	// (visible layers that are not locked). Escape cancels the open area.
	erase: "polygon" | "lasso" | null = null;
	private erasePts: number[][] = [];
	private lassoing = false;
	private eraseLine = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xff4040, depthTest: false }));

	constructor(private viewer: Viewer, private ed: Editor, private canvas: HTMLCanvasElement) {
		viewer.scene.add(this.group);
		this.eraseLine.renderOrder = 10;
		this.eraseLine.frustumCulled = false;
		viewer.scene.add(this.eraseLine);
		canvas.addEventListener("pointerdown", (e) => this.down(e));
		canvas.addEventListener("pointermove", (e) => this.move(e));
		window.addEventListener("pointerup", () => this.up());
		canvas.addEventListener("dblclick", () => this.enabled && this.finish());
		canvas.addEventListener("keydown", (e) => this.key(e));
		// After a change of the terrain, put the roads on the new heights (not more than 5 times a second).
		viewer.onHeights = () => {
			if (!this.roads.size || this.heightsTimer) return;
			this.heightsTimer = window.setTimeout(() => ((this.heightsTimer = 0), this.draw()), 200);
		};
	}

	// Read a RoadsLib.cfg. Returns the warnings of the parser.
	async loadRoads(path: string): Promise<string[]> {
		const lib = await roadsRead(path);
		this.roadsPath = path;
		this.setRoads(lib.types);
		return lib.warnings;
	}

	// Move the camera to the selected shape. Returns false when no shape is selected.
	focus(): boolean {
		const s = this.shape(this.selected);
		if (!s || !s.points.length) return false;
		const xs = s.points.map((p) => p[0]);
		const ys = s.points.map((p) => p[1]);
		const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
		const [x, y] = [(x0 + x1) / 2, (y0 + y1) / 2];
		this.viewer.focus(x, y, this.viewer.heightAt(x, y) ?? 0, Math.max(x1 - x0, y1 - y0) / 2);
		return true;
	}

	get shapes(): Shape[] {
		return this.ed.store.shapes;
	}

	shape(id: number | null): Shape | undefined {
		return this.shapes.find((s) => s.id === id && !s.deleted);
	}

	setEnabled(on: boolean) {
		this.enabled = on;
		this.ed.enabled = !on;
		if (on) this.ed.select([]);
		else this.finish();
		this.draw();
	}

	// Change the shapes as one undo step. f changes the shapes and returns the ids of the shapes whose spline objects must change.
	async edit(f: (shapes: Shape[]) => number[]) {
		const st = this.ed.store;
		const before = structuredClone(st.shapes);
		const ids = f(st.shapes);
		const changes: Change[] = [];
		for (const id of ids) {
			const s = st.shapes.find((x) => x.id === id);
			if (s) for (const c of await this.regenerate(s)) changes.push(c);
		}
		const after = structuredClone(st.shapes);
		st.apply(changes, true);
		let now = "after";
		this.ed.pushStep({
			changes,
			flip: () => {
				st.shapes = structuredClone(now === "after" ? before : after);
				now = now === "after" ? "before" : "after";
				this.draw();
				this.onChange?.();
			},
		});
		this.draw();
		this.onChange?.();
	}

	// The object changes that make the spline objects of a shape new (or remove them when the shape has no spline or is deleted).
	private async regenerate(s: Shape): Promise<Change[]> {
		const st = this.ed.store;
		const sp = s.spline;
		const changes: Change[] = [];
		if (s.fill === undefined) {
			if (!sp?.model) return changes;
			s.fill = st.fills.push({ name: `spline: ${s.name}`, layer: this.ed.activeLayer, settings: {} as FillSettings, models: [], avoid: false, shape: s.id }) - 1;
		}
		const k = s.fill;
		for (const id of st.ids()) if (st.fill[id] === k) changes.push({ id, before: st.snapshot(id), after: null });
		if (s.deleted || !sp?.model || s.kind === "point" || s.points.length < 2) return changes;
		const fill = st.fills[k];
		fill.name = `spline: ${s.name}`;
		const model = st.modelId(sp.model);
		const [off, size] = await Promise.all([this.ed.offset(model), this.ed.modelSize(sp.model)]);
		const ground = (x: number, y: number) => this.ed.ground(x, y);
		let id = st.newId();
		const used = new Set(changes.map((c) => c.id));
		for (const p of splinePlaces(s, sp, size.length, size.xLong, ground)) {
			while (st.alive(id) || used.has(id)) id++;
			// A deleted object of this spline can take its id again: the change then replaces it.
			const t = fromText({ x: p.x, y: p.y, yaw: p.yaw, pitch: p.pitch, roll: p.roll, scale: 1, z: 0 }, off, 0, 0, true, ground);
			changes.push({ id: id++, before: null, after: { model, t, layer: fill.layer, fill: k } });
		}
		return changes;
	}

	// A new shape: the next clicks add its points.
	start(kind: ShapeKind) {
		this.setErase(null);
		const n = this.shapes.filter((s) => s.kind === kind).length + 1;
		const id = this.shapes.reduce((m, s) => Math.max(m, s.id), 0) + 1;
		const name = `${{ line: "Line", polygon: "Polygon", point: "Point" }[kind]} ${n}`;
		// Lines are smooth curves by default, as the roads of TB.
		this.shapes.push({ id, kind, name, group: kind === "point" ? "points" : kind === "line" ? "lines" : "polygons", points: [], props: [], smooth: kind === "line", closed: false });
		const group = this.activeGroup;
		if (group) this.shapes[this.shapes.length - 1].group = group;
		this.drawing = this.selected = id;
		this.point = null;
		this.draw();
		this.onChange?.();
	}

	setErase(mode: "polygon" | "lasso" | null) {
		this.finish();
		this.erase = mode;
		this.erasePts = [];
		this.drawErase();
		this.onChange?.();
	}

	// Delete the objects inside the erase area, then start a new area.
	private closeErase() {
		const pts = this.erasePts;
		this.erasePts = [];
		this.lassoing = false;
		if (pts.length >= 3) this.ed.deleteInside(pts);
		this.drawErase();
	}

	private drawErase() {
		const pos = this.erasePts.flatMap((p) => [p[0], (this.viewer.heightAt(p[0], p[1]) ?? 0) + 0.6, -p[1]]);
		this.eraseLine.geometry.dispose();
		this.eraseLine.geometry = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
		this.viewer.redraw();
	}

	// End the new shape (or the erase polygon). A shape with too few points is removed.
	finish() {
		if (this.erase === "polygon" && this.erasePts.length) this.closeErase();
		const s = this.shape(this.drawing);
		this.drawing = null;
		if (s && s.points.length < MIN_POINTS[s.kind]) {
			this.ed.store.shapes = this.shapes.filter((x) => x !== s);
			if (this.selected === s.id) this.selected = null;
		}
		this.draw();
		this.onChange?.();
	}

	remove(id: number) {
		this.removeMany([id]);
	}

	// Delete shapes as one undo step (with their spline objects).
	removeMany(ids: number[]) {
		const set = new Set(ids);
		this.edit((all) => {
			for (const s of all) if (set.has(s.id)) s.deleted = true;
			if (this.selected !== null && set.has(this.selected)) this.selected = this.point = null;
			for (const id of ids) this.picked.delete(id);
			return ids;
		});
	}

	// Rename a shape group (one undo step). The hidden, locked, and active settings go with it.
	renameGroup(from: string, to: string) {
		if (!to || to === from) return;
		this.edit((all) => {
			for (const s of all) if (s.group === from) s.group = to;
			return [];
		});
		for (const set of [this.hidden, this.locked]) if (set.delete(from)) set.add(to);
		if (this.activeGroup === from) this.activeGroup = to;
	}

	// The shape can be clicked and changed in the view: its group is visible and not locked.
	private usable(s: Shape): boolean {
		return !s.deleted && !this.hidden.has(s.group) && !this.locked.has(s.group);
	}

	private ndc(e: { clientX: number; clientY: number }): THREE.Vector2 {
		const r = this.canvas.getBoundingClientRect();
		return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
	}

	// Screen pixels of a point at local meters (on the terrain).
	private screen(p: number[]): THREE.Vector2 | null {
		const v = new THREE.Vector3(p[0], (this.viewer.heightAt(p[0], p[1]) ?? 0) + 0.6, -p[1]).project(this.viewer.view);
		if (v.z > 1) return null;
		const r = this.canvas.getBoundingClientRect();
		return new THREE.Vector2(((v.x + 1) / 2) * r.width, ((1 - v.y) / 2) * r.height);
	}

	// The nearest point of a shape near the mouse: the selected shape first.
	private vertexAt(e: PointerEvent): { id: number; i: number } | null {
		const r = this.canvas.getBoundingClientRect();
		const m = new THREE.Vector2(e.clientX - r.left, e.clientY - r.top);
		let best: { id: number; i: number; d: number } | null = null;
		const order = [...this.shapes].sort((a, b) => (b.id === this.selected ? 1 : 0) - (a.id === this.selected ? 1 : 0));
		for (const s of order) {
			if (!this.usable(s)) continue;
			s.points.forEach((p, i) => {
				const q = this.screen(p);
				const d = q ? q.distanceTo(m) : Infinity;
				if (d < PICK_PX && (!best || d < best.d)) best = { id: s.id, i, d };
			});
			if (best) break;
		}
		return best;
	}

	// The shape with a line near the mouse.
	private lineAt(e: PointerEvent): number | null {
		const r = this.canvas.getBoundingClientRect();
		const m = new THREE.Vector2(e.clientX - r.left, e.clientY - r.top);
		for (const s of this.shapes) {
			if (!this.usable(s) || s.kind === "point") continue;
			const c = curve(s, 4);
			const pts = s.kind === "polygon" ? [...c, c[0]] : c;
			for (let i = 0; i + 1 < pts.length; i++) {
				const [a, b] = [this.screen(pts[i]), this.screen(pts[i + 1])];
				if (!a || !b) continue;
				const ab = b.clone().sub(a);
				const t = Math.max(0, Math.min(1, m.clone().sub(a).dot(ab) / Math.max(1e-9, ab.lengthSq())));
				if (a.clone().addScaledVector(ab, t).distanceTo(m) < PICK_PX) return s.id;
			}
		}
		return null;
	}

	private down(e: PointerEvent) {
		if (!this.enabled || e.button !== 0 || !this.viewer.terrain) return;
		const g = this.viewer.pick(this.ndc(e));
		if (this.erase) {
			if (!g) return;
			if (this.erase === "lasso") {
				this.erasePts = [];
				this.lassoing = true;
			}
			this.erasePts.push([g.x, g.y]);
			this.drawErase();
			return;
		}
		const open = this.shape(this.drawing);
		if (open) {
			if (!g) return;
			this.edit((all) => {
				const s = all.find((x) => x.id === open.id)!;
				s.points.push([g.x, g.y]);
				this.point = s.points.length - 1;
				return [s.id];
			}).then(() => open.kind === "point" && this.finish());
			return;
		}
		const v = this.vertexAt(e);
		if (v) {
			this.selected = v.id;
			this.point = v.i;
			this.drag = { ...v, before: structuredClone(this.shapes), moved: false };
			this.draw();
			this.onChange?.();
			return;
		}
		const sel = this.shape(this.selected);
		if (sel && e.ctrlKey && g && sel.kind !== "point" && this.usable(sel)) {
			this.edit((all) => {
				const s = all.find((x) => x.id === sel.id)!;
				s.points.push([g.x, g.y]);
				this.point = s.points.length - 1;
				return [s.id];
			});
			return;
		}
		this.selected = this.lineAt(e);
		this.point = null;
		this.picked.clear();
		this.draw();
		this.onChange?.();
	}

	private move(e: PointerEvent) {
		if (this.lassoing) {
			if (!(e.buttons & 1)) return this.up();
			const g = this.viewer.pick(this.ndc(e));
			const q = this.erasePts[this.erasePts.length - 1];
			if (g && Math.hypot(g.x - q[0], g.y - q[1]) >= (this.viewer.terrain?.cell ?? 1)) {
				this.erasePts.push([g.x, g.y]);
				this.drawErase();
			}
			return;
		}
		const d = this.drag;
		if (!d) return;
		if (!(e.buttons & 1)) return this.up();
		const g = this.viewer.pick(this.ndc(e));
		const s = this.shape(d.id);
		if (!g || !s) return;
		s.points[d.i] = [g.x, g.y];
		d.moved = true;
		this.draw();
	}

	// The end of a drag: one undo step from the shapes before the drag.
	private up() {
		if (this.lassoing) return this.closeErase();
		const d = this.drag;
		this.drag = undefined;
		if (!d?.moved) return;
		const moved = structuredClone(this.shape(d.id)!.points);
		this.ed.store.shapes = d.before;
		this.edit((all) => {
			all.find((x) => x.id === d.id)!.points = moved;
			return [d.id];
		});
	}

	private key(e: KeyboardEvent) {
		if (!this.enabled) return;
		const open = this.shape(this.drawing);
		if (e.code === "Escape" && this.erase) {
			this.erasePts = [];
			this.lassoing = false;
			this.drawErase();
		} else if (e.code === "Enter" || e.code === "Escape") {
			this.finish();
		} else if (e.code === "Backspace" && open && open.points.length) {
			this.edit((all) => {
				all.find((x) => x.id === open.id)!.points.pop();
				return [open.id];
			});
		} else if (e.code === "Delete") {
			const s = this.shape(this.selected);
			if (!s || this.point === null || !this.usable(s)) return;
			e.stopPropagation();
			if (s.points.length <= MIN_POINTS[s.kind]) {
				this.onError?.(`A ${s.kind} needs ${MIN_POINTS[s.kind]} points at least. Use "Delete shape" to remove it.`);
				return;
			}
			const i = this.point;
			this.point = null;
			this.edit((all) => {
				all.find((x) => x.id === s.id)!.points.splice(i, 1);
				return [s.id];
			});
		} else {
			return;
		}
		e.preventDefault();
	}

	// Use the road types of a RoadsLib.cfg.
	setRoads(types: RoadType[]) {
		this.roads = new Map(types.map((t) => [t.id, t]));
		this.roadMats.forEach((m) => m.dispose());
		this.roadMats.clear();
		this.draw();
	}

	// The material of a road type: its texture when the model folders have it, else its map color (or grey).
	private roadMaterial(t: RoadType, texture: string): THREE.MeshLambertMaterial {
		const key = `${t.id}|${texture}`;
		let m = this.roadMats.get(key);
		if (m) return m;
		const c = t.color ?? [0.45, 0.45, 0.45, 1];
		m = withFog(new THREE.MeshLambertMaterial({ color: new THREE.Color(c[0], c[1], c[2]), transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 }));
		this.roadMats.set(key, m);
		const mat = m;
		this.ed.lib?.texture(texture).then((tex) => {
			if (typeof tex === "string") {
				this.onError?.(`Road type ${t.id} shows its map color: ${tex}. Add the folder of the texture to the model folders.`);
				return;
			}
			tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
			tex.needsUpdate = true;
			Object.assign(mat, { map: tex, color: new THREE.Color(1, 1, 1), opacity: 1, alphaTest: 0.3 });
			mat.needsUpdate = true;
			this.viewer.redraw();
		});
		return m;
	}

	// A band along the road curve, on the terrain. The texture repeats each road width along the road.
	// Each end is one road width long with the end texture (mainTerTex): v = 0 at the open end, 1 where it touches the road (checked in the game).
	// shortcut: the end length (one road width) is assumed, not checked in the game. Check it against a road in the game.
	private roadMesh(s: Shape, t: RoadType, order: number): THREE.Mesh | null {
		const c = curve(s, 2);
		if (c.length < 2) return null;
		const d = [0];
		for (let i = 1; i < c.length; i++) d.push(d[i - 1] + Math.hypot(c[i][0] - c[i - 1][0], c[i][1] - c[i - 1][1]));
		const total = d[d.length - 1];
		const end = t.endTexture ? Math.min(t.width, total / 2) : 0;
		// Points of the curve, with a point at each end piece border.
		const pts: number[][] = [c[0]];
		const ds = [0];
		for (let i = 1; i < c.length; i++) {
			for (const cut of end > 0 ? [end, total - end] : []) {
				if (cut > d[i - 1] + 1e-6 && cut < d[i] - 1e-6) {
					const f = (cut - d[i - 1]) / (d[i] - d[i - 1]);
					pts.push([c[i - 1][0] + (c[i][0] - c[i - 1][0]) * f, c[i - 1][1] + (c[i][1] - c[i - 1][1]) * f]);
					ds.push(cut);
				}
			}
			pts.push(c[i]);
			ds.push(d[i]);
		}
		const half = t.width / 2;
		// Layer 0 is the highest: a lower ORDER lifts the band a little more, and draws later.
		const lift = 0.12 + Math.max(0, 10 - Math.min(10, order)) * 0.01;
		// Vertices across the road at each point, about half a terrain cell apart, from the left edge to the right edge. The heights are on
		// the drawn terrain triangles, so the band does not go into the terrain between the edges.
		const cell = this.viewer.terrain?.cell ?? 1;
		const across = Math.max(1, Math.ceil((t.width / cell) * 2));
		const edge = pts.map((p, i) => {
			const [a, b] = [pts[Math.max(0, i - 1)], pts[Math.min(pts.length - 1, i + 1)]];
			const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
			const [rx, ry] = [(b[1] - a[1]) / len, -(b[0] - a[0]) / len];
			return Array.from({ length: across + 1 }, (_, c) => {
				const side = -1 + (2 * c) / across;
				const [x, y] = [p[0] + rx * half * side, p[1] + ry * half * side];
				return [x, (this.viewer.meshHeightAt(x, y) ?? 0) + lift, -y];
			});
		});
		// Zone 0 is the road, 1 the start piece, 2 the end piece. Each row of vertices is shared by the segments of one zone; a zone border
		// has its own row, so the zones can have other UVs. Index list 0 is the road texture, list 1 the end texture.
		const pos: number[] = [];
		const uv: number[] = [];
		const idx: number[][] = [[], []];
		const row = (k: number, z: number) => {
			const base = pos.length / 3;
			const v = z === 0 ? ds[k] / t.width : z === 1 ? ds[k] / end : 1 - (ds[k] - (total - end)) / end;
			for (let c = 0; c <= across; c++) {
				const e = edge[k][c];
				pos.push(e[0], e[1], e[2]);
				// The end piece goes the other way (the texture turned 180 degrees), so its left and right change too.
				uv.push(z === 2 ? 1 - c / across : c / across, v);
			}
			return base;
		};
		let prev = { z: -1, k: -1, base: 0 };
		for (let i = 0; i + 1 < pts.length; i++) {
			const mid = (ds[i] + ds[i + 1]) / 2;
			const z = mid < end ? 1 : mid > total - end ? 2 : 0;
			const a = prev.z === z && prev.k === i ? prev.base : row(i, z);
			const b = row(i + 1, z);
			const list = idx[z === 0 ? 0 : 1];
			for (let c = 0; c < across; c++) {
				// Counterclockwise from above, so the front face points up. The other order showed the back face, and the light made it black.
				list.push(a + c, a + c + 1, b + c, a + c + 1, b + c + 1, b + c);
			}
			prev = { z, k: i + 1, base: b };
		}
		const g = new THREE.BufferGeometry();
		g.addGroup(0, idx[0].length, 0);
		g.addGroup(idx[0].length, idx[1].length, 1);
		g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
		g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
		g.setAttribute("normal", new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
		g.setIndex(idx[0].concat(idx[1]));
		const m = new THREE.Mesh(g, [this.roadMaterial(t, t.texture), this.roadMaterial(t, t.endTexture || t.texture)]);
		m.renderOrder = 100 - Math.min(99, order);
		m.receiveShadow = true;
		m.frustumCulled = false;
		return m;
	}

	// Make the lines, the roads, and the point markers again.
	draw() {
		for (const c of [...this.group.children]) {
			this.group.remove(c);
			(c as THREE.Line).geometry.dispose();
		}
		const t = this.viewer.terrain;
		if (!t) return;
		const lift = (p: number[]) => [p[0], (this.viewer.heightAt(p[0], p[1]) ?? 0) + 0.6, -p[1]];
		for (const s of this.shapes) {
			if (s.deleted || !s.points.length || this.hidden.has(s.group)) continue;
			const sel = s.id === this.selected || this.picked.has(s.id);
			const road = s.kind === "line" ? this.roads.get(roadId(s) ?? -1) : undefined;
			if (road) {
				const m = this.roadMesh(s, road, Number(prop(s, "ORDER")) || 0);
				if (m) this.group.add(m);
			}
			if (s.kind !== "point") {
				const c = curve(s, 2);
				const ring = s.kind === "polygon" ? [...c, c[0]] : c;
				// Points on the terrain, about one cell apart, so that the line follows the ground.
				const pts = ring.length > 1 ? [...along(ring, t.cell).map((p) => [p.x, p.y]), ring[ring.length - 1]] : ring;
				const g = new THREE.BufferGeometry();
				g.setAttribute("position", new THREE.Float32BufferAttribute(pts.flatMap(lift), 3));
				const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: sel ? 0xffffff : COLORS[s.kind] }));
				line.frustumCulled = false;
				this.group.add(line);
			}
			if (sel || s.kind === "point") {
				const g = new THREE.BufferGeometry();
				g.setAttribute("position", new THREE.Float32BufferAttribute(s.points.flatMap(lift), 3));
				g.setAttribute("color", new THREE.Float32BufferAttribute(s.points.flatMap((_, i) => (s.id === this.selected && i === this.point ? [1, 0.2, 0.2] : new THREE.Color(sel ? 0xffffff : COLORS[s.kind]).toArray())), 3));
				const m = new THREE.Points(g, new THREE.PointsMaterial({ size: (sel ? 13 : 9) * this.viewer.renderer.getPixelRatio(), sizeAttenuation: false, vertexColors: true, depthTest: false, transparent: true }));
				// Transparent and last, so that the points draw after the road bands (transparent too) and stay on top.
				m.renderOrder = 1000;
				m.frustumCulled = false;
				this.group.add(m);
			}
		}
		this.viewer.redraw();
	}
}
