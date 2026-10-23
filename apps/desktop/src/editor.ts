// Object editor: selection, gizmo, placement, copy and paste, undo and redo, and object text import and export.
// Keys (when the 3D view has the focus): 1 move, 2 rotate, 3 scale, X or Space world or local space, Delete, Escape, Ctrl+Z, Ctrl+Y, Ctrl+C, Ctrl+V, Ctrl+D.
import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import type { FillResult } from "./data";
import type { ModelLibrary } from "./models";
import { formatLine, joinLines, parseObjectText } from "./objtext";
import { inside, segDist } from "./shapes";
import { ObjectStore, type Change, type Fill, type Snapshot } from "./store";
import { fromText, fromThree, matrixOf, moveOrigin, toText } from "./transform";
import type { Viewer } from "./viewer";

export type GizmoMode = "translate" | "rotate" | "scale";
// World: the gizmo axes are east, up, and north. Local: the gizmo axes are the axes of the last selected object.
export type GizmoSpace = "world" | "local";
// A mouse drag of more pixels than this is a box selection, not a click.
const DRAG_PX = 5;
const ROTATE_SNAP = (15 * Math.PI) / 180;

export interface Step {
	changes: Change[];
	flip?: () => void;
	redo?: () => void;
}

export class Editor {
	store = new ObjectStore();
	lib?: ModelLibrary;
	activeLayer = 0;
	mode: GizmoMode = "translate";
	space: GizmoSpace = "world";
	snapGround = true;
	gridSnap = 0;
	rotateSnap = false;
	// Model name to place with each click, or null.
	placing: string | null = null;
	// Called when the selection, the layers, the history, or the settings change.
	onState?: () => void;
	// One undo step: object changes, and an optional switch of other state (for example a deleted layer). The switch is its own reverse.
	// `redo` is for a switch that is not its own reverse (for example a height stroke in the core). Without it, redo uses `flip`.
	private undoStack: Step[] = [];
	private redoStack: Step[] = [];
	// Goes up with each change of the objects or the layers. The project file uses it to find changes that are not saved.
	version = 0;
	// False while another tool (the height brush) uses the left mouse button in the 3D view.
	enabled = true;
	private clipboard: Snapshot[] = [];
	// Model offset that the transforms of each model use, by model ID. A new model library can change it (see setLibrary).
	private used = new Map<number, number[]>();
	private gizmo: TransformControls;
	private pivot = new THREE.Object3D();
	private dragStart: { pivot: THREE.Matrix4; items: { id: number; m: THREE.Matrix4; before: Snapshot }[] } | null = null;
	private down: { x: number; y: number; ndc: THREE.Vector2 } | null = null;
	private rect: HTMLDivElement;

	constructor(private viewer: Viewer, private canvas: HTMLCanvasElement) {
		this.store.addLayer("default");
		this.store.onChange = (ids) => this.viewer.refresh(ids);
		viewer.setStore(this.store);
		this.gizmo = new TransformControls(viewer.camera, canvas);
		viewer.onView = (c) => (this.gizmo.camera = c);
		viewer.scene.add(this.pivot);
		viewer.scene.add(this.gizmo.getHelper());
		this.gizmo.addEventListener("dragging-changed", (e) => (e.value ? this.beginDrag() : this.endDrag()));
		this.gizmo.addEventListener("objectChange", () => this.drag());
		this.rect = document.createElement("div");
		this.rect.className = "select-rect";
		canvas.parentElement!.appendChild(this.rect);
		canvas.addEventListener("pointerdown", (e) => this.pointerDown(e));
		window.addEventListener("pointerup", (e) => this.pointerUp(e));
		canvas.addEventListener("pointermove", (e) => this.pointerMove(e));
		canvas.addEventListener("keydown", (e) => this.key(e));
	}

	// Use a new store (for example after a WRP or TB project is opened).
	async setStore(store: ObjectStore) {
		if (store !== this.store) this.used.clear();
		this.store = store;
		store.onChange = (ids) => this.viewer.refresh(ids);
		this.activeLayer = 0;
		this.undoStack = [];
		this.redoStack = [];
		this.updateGizmo();
		await this.viewer.setStore(store, this.lib);
		this.changed();
	}

	get selection(): Set<number> {
		return this.viewer.selection;
	}
	// Move the camera to the selected objects.
	focus() {
		const t = this.store.t;
		const ids = [...this.selection];
		if (!ids.length) return;
		// A loop, not Math.min(...): a spread of a large selection overflows the call stack.
		let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
		for (const id of ids) {
			const [x, y] = [t[id * 12 + 9], t[id * 12 + 11]];
			[x0, x1, y0, y1] = [Math.min(x0, x), Math.max(x1, x), Math.min(y0, y), Math.max(y1, y)];
		}
		const h = ids.reduce((a, id) => a + t[id * 12 + 10], 0) / ids.length;
		this.viewer.focus((x0 + x1) / 2, (y0 + y1) / 2, h, Math.max(10, (x1 - x0) / 2, (y1 - y0) / 2));
	}
	get canUndo() {
		return this.undoStack.length > 0;
	}
	get canRedo() {
		return this.redoStack.length > 0;
	}

	setMode(m: GizmoMode) {
		this.mode = m;
		this.gizmo.setMode(m);
		this.changed();
	}

	setSpace(s: GizmoSpace) {
		this.space = s;
		this.gizmo.setSpace(s);
		this.updateGizmo();
		this.changed();
	}

	setSnap(grid: number, rotate: boolean, ground: boolean) {
		this.gridSnap = grid;
		this.rotateSnap = rotate;
		this.snapGround = ground;
		this.gizmo.setTranslationSnap(grid > 0 ? grid : null);
		this.gizmo.setRotationSnap(rotate ? ROTATE_SNAP : null);
		this.changed();
	}

	startPlace(model: string | null) {
		this.placing = model;
		this.changed();
	}

	select(ids: number[], how: "set" | "add" | "toggle" = "set") {
		if (how === "set") this.selection.clear();
		for (const id of ids) {
			if (!this.store.editable(id)) continue;
			if (how === "toggle" && this.selection.has(id)) this.selection.delete(id);
			else this.selection.add(id);
		}
		this.updateGizmo();
		this.viewer.redraw();
		this.changed();
	}

	// Run changes as one undo step.
	commit(changes: Change[], flip?: () => void) {
		if (!changes.length && !flip) return;
		this.store.apply(changes, true);
		flip?.();
		this.pushStep({ changes, flip });
	}

	// Put a step that is already done on the undo list.
	pushStep(s: Step) {
		this.version++;
		this.undoStack.push(s);
		this.redoStack = [];
		this.updateGizmo();
		this.changed();
	}

	undo() {
		const c = this.undoStack.pop();
		if (!c) return;
		this.store.apply(c.changes, false);
		c.flip?.();
		this.version++;
		this.redoStack.push(c);
		this.updateGizmo();
		this.changed();
	}

	redo() {
		const c = this.redoStack.pop();
		if (!c) return;
		this.store.apply(c.changes, true);
		(c.redo ?? c.flip)?.();
		this.version++;
		this.undoStack.push(c);
		this.updateGizmo();
		this.changed();
	}

	deleteSelection() {
		this.commit([...this.selection].map((id) => ({ id, before: this.store.snapshot(id), after: null })));
	}

	copy() {
		this.clipboard = [...this.selection].map((id) => this.store.snapshot(id)!).filter(Boolean);
		this.changed();
	}

	// Paste the copied objects. With a ground point, the center of the copied objects goes there, and each object keeps its height above the terrain.
	paste(at?: { x: number; y: number }) {
		if (!this.clipboard.length) return;
		let dx = 0;
		let dy = 0;
		if (at) {
			dx = at.x - this.clipboard.reduce((s, c) => s + c.t[9], 0) / this.clipboard.length;
			dy = at.y - this.clipboard.reduce((s, c) => s + c.t[11], 0) / this.clipboard.length;
		}
		const changes: Change[] = [];
		const used = new Set<number>();
		for (const c of this.clipboard) {
			const t = c.t.slice();
			t[9] += dx;
			t[11] += dy;
			t[10] += this.ground(t[9], t[11]) - this.ground(c.t[9], c.t[11]);
			let id = this.store.newId();
			while (used.has(id) || this.store.alive(id)) id++;
			used.add(id);
			changes.push({ id, before: null, after: { model: c.model, t, layer: this.activeLayer } });
		}
		this.commit(changes);
		this.select(changes.map((c) => c.id));
	}

	duplicate() {
		this.copy();
		this.paste();
	}

	// Place one object of the model at a ground point (relative z 0), yaw 0, scale 1.
	async place(at: { x: number; y: number }) {
		if (!this.placing) return;
		const model = this.store.modelId(this.placing);
		const off = await this.offset(model);
		const t = fromText({ x: at.x, y: at.y, yaw: 0, pitch: 0, roll: 0, scale: 1, z: 0 }, off, 0, 0, true, (x, y) => this.ground(x, y));
		const id = this.store.newId();
		this.commit([{ id, before: null, after: { model, t, layer: this.activeLayer } }]);
		this.select([id]);
	}

	// Import TB object text into a new layer. Returns the lines that are not correct.
	async importText(text: string, layerName: string, relative: boolean): Promise<string[]> {
		const { objects, errors } = parseObjectText(text);
		const t0 = this.viewer.terrain;
		const [xll, yll] = [t0?.xll ?? 0, t0?.yll ?? 0];
		const layer = this.store.addLayer(layerName);
		this.store.layers[layer].textMode = relative ? "relative" : "absolute";
		const names = [...new Set(objects.map((o) => o.name))];
		const offsets = new Map(await Promise.all(names.map(async (n) => [n, await this.offset(this.store.modelId(n))] as const)));
		const changes: Change[] = [];
		let id = this.store.newId();
		for (const o of objects) {
			while (this.store.alive(id)) id++;
			const t = fromText(o, offsets.get(o.name)!, xll, yll, relative, (x, y) => this.ground(x, y));
			changes.push({ id: id++, before: null, after: { model: this.store.modelId(o.name), t, layer, raw: o.raw } });
		}
		this.activeLayer = layer;
		this.commit(changes);
		return errors;
	}

	// Put the objects of a new fill into its layer as one undo step.
	// The objects stand on the ground (relative z 0) with the model offsets, as in an object text import.
	async applyFill(r: FillResult, fill: Fill): Promise<number> {
		const k = this.store.fills.push(fill) - 1;
		const { layer: l, models } = fill;
		const ids = models.map((m) => this.store.modelId(m));
		const offs = await Promise.all(ids.map((m) => this.offset(m)));
		const changes: Change[] = [];
		// The fill row shows again with a redo of the commit.
		const flip = () => (fill.deleted = !fill.deleted);
		fill.deleted = true;
		const [v, e] = [r.values, r.entries];
		let id = this.store.newId();
		for (let i = 0; i < r.count; i++) {
			while (this.store.alive(id)) id++;
			const o = i * 7;
			const t = fromText({ x: v[o], y: v[o + 1], yaw: v[o + 2], pitch: v[o + 3], roll: v[o + 4], scale: v[o + 5], z: 0 }, offs[e[o + 6]], 0, 0, true, (x, y) => this.ground(x, y));
			changes.push({ id: id++, before: null, after: { model: ids[e[o + 6]], t, layer: l, fill: k } });
		}
		this.commit(changes, flip);
		return k;
	}

	// Delete objects as one undo step, with a switch of other state.
	private deleteWhere(keep: (id: number) => boolean, flip: () => void) {
		const changes: Change[] = [];
		for (const id of this.store.ids()) if (!keep(id)) changes.push({ id, before: this.store.snapshot(id), after: null });
		this.select([...this.selection].filter(keep));
		this.commit(changes, flip);
	}

	// Delete the editable objects (visible layer, not locked) whose center is inside a polygon (local meters). One undo step.
	// Returns the number of deleted objects.
	deleteInside(ring: number[][]): number {
		const st = this.store;
		const xs = ring.map((p) => p[0]);
		const ys = ring.map((p) => p[1]);
		const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
		const changes: Change[] = [];
		for (const id of st.ids()) {
			const [x, y] = [st.t[id * 12 + 9], st.t[id * 12 + 11]];
			if (x < x0 || x > x1 || y < y0 || y > y1 || !st.editable(id) || !inside(ring, x, y)) continue;
			changes.push({ id, before: st.snapshot(id), after: null });
		}
		const gone = new Set(changes.map((c) => c.id));
		this.select([...this.selection].filter((id) => !gone.has(id)));
		this.commit(changes);
		return changes.length;
	}

	// Delete the editable objects near shapes as one undo step: within `dist` meters of a line (its points), or inside a polygon
	// (`ring`) or within `dist` of its edge. The segments go into a grid, so each object checks only the segments near it.
	// Returns the number of deleted objects.
	deleteNear(items: { points: number[][]; dist: number; ring: boolean }[]): number {
		const st = this.store;
		const G = Math.max(25, ...items.map((x) => x.dist * 2));
		const grid = new Map<number, { a: number[]; b: number[]; dist: number }[]>();
		const key = (cx: number, cy: number) => cx * 100003 + cy;
		for (const it of items) {
			const p = it.ring ? [...it.points, it.points[0]] : it.points.length === 1 ? [it.points[0], it.points[0]] : it.points;
			for (let i = 0; i + 1 < p.length; i++) {
				const [a, b] = [p[i], p[i + 1]];
				const [x0, x1, y0, y1] = [Math.min(a[0], b[0]) - it.dist, Math.max(a[0], b[0]) + it.dist, Math.min(a[1], b[1]) - it.dist, Math.max(a[1], b[1]) + it.dist];
				for (let cx = Math.floor(x0 / G); cx <= Math.floor(x1 / G); cx++)
					for (let cy = Math.floor(y0 / G); cy <= Math.floor(y1 / G); cy++) (grid.get(key(cx, cy)) ?? grid.set(key(cx, cy), []).get(key(cx, cy))!).push({ a, b, dist: it.dist });
			}
		}
		const rings = items
			.filter((x) => x.ring && x.points.length > 2)
			.map((x) => ({ r: x.points, box: x.points.reduce((b, p) => [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])], [Infinity, Infinity, -Infinity, -Infinity]) }));
		const changes: Change[] = [];
		for (const id of st.ids()) {
			const [x, y] = [st.t[id * 12 + 9], st.t[id * 12 + 11]];
			const segs = grid.get(key(Math.floor(x / G), Math.floor(y / G)));
			const near = segs?.some((s) => segDist(x, y, s.a, s.b) <= s.dist) || rings.some(({ r, box }) => x >= box[0] && y >= box[1] && x <= box[2] && y <= box[3] && inside(r, x, y));
			if (near && st.editable(id)) changes.push({ id, before: st.snapshot(id), after: null });
		}
		const gone = new Set(changes.map((c) => c.id));
		this.select([...this.selection].filter((id) => !gone.has(id)));
		this.commit(changes);
		return changes.length;
	}

	// Delete a fill and its objects. Other objects in the layer stay.
	deleteFill(k: number) {
		const f = this.store.fills[k];
		this.deleteWhere((id) => this.store.fill[id] !== k, () => (f.deleted = !f.deleted));
	}

	// Delete a layer and its objects. The last layer cannot be deleted.
	deleteLayer(l: number) {
		const st = this.store;
		if (st.shown().length < 2) return;
		const layer = st.layers[l];
		this.deleteWhere((id) => st.layer[id] !== l, () => {
			layer.deleted = !layer.deleted;
			if (st.layers[this.activeLayer]?.deleted) this.activeLayer = st.shown()[0];
		});
	}

	// Position (local meters) and horizontal radius of each object in the visible layers.
	footprints(): [number, number, number][] {
		const out: [number, number, number][] = [];
		const t = this.store.t;
		for (const id of this.store.ids()) {
			const l = this.store.layer[id];
			if (!this.store.layers[l].visible) continue;
			const b = this.viewer.modelBox(this.store.model[id]);
			const o = id * 12;
			const r = Math.max(-b.min.x, b.max.x, -b.min.z, b.max.z) * Math.hypot(t[o], t[o + 1], t[o + 2]);
			out.push([t[o + 9], t[o + 11], r]);
		}
		return out;
	}

	// TB object text of the objects in the layers. An imported object that is not changed keeps its original line,
	// when the export uses the same z mode as the import.
	async exportText(layers: number[], relative: boolean): Promise<string> {
		const t0 = this.viewer.terrain;
		const [xll, yll] = [t0?.xll ?? 0, t0?.yll ?? 0];
		const mode = relative ? "relative" : "absolute";
		const lines: string[] = [];
		for (const id of this.store.ids()) {
			const layer = this.store.layer[id];
			if (!layers.includes(layer)) continue;
			const raw = this.store.raw[id];
			if (raw !== undefined && this.store.layers[layer].textMode === mode) {
				lines.push(raw);
				continue;
			}
			const m = this.store.model[id];
			const v = toText(this.store.t, id * 12, await this.offset(m), xll, yll, relative, (x, y) => this.ground(x, y));
			lines.push(formatLine(this.store.models[m], v));
		}
		return joinLines(lines);
	}

	// Use a new model library. The objects in the layers of an object text import stay at their text position:
	// the import used the model offsets that were known at that time (zero without a library, or for a model that did not load).
	// Objects in other layers do not move, because a WRP gives the centered origin.
	// shortcut: an object placed in a WRP layer does not move when a new scan changes its model offset. Keep the origin type for each object when this is a problem.
	async setLibrary(lib: ModelLibrary) {
		const old = new Map(this.used);
		this.lib = lib;
		const text = new Set(this.store.layers.flatMap((l, i) => (l.textMode ? [i] : [])));
		const next = new Map<number, number[]>();
		for (const id of this.store.ids()) {
			if (!text.has(this.store.layer[id])) continue;
			const m = this.store.model[id];
			if (!next.has(m)) next.set(m, await this.offset(m));
			moveOrigin(this.store.t, id * 12, old.get(m) ?? [0, 0, 0], next.get(m)!);
		}
		await this.setStore(this.store);
	}

	// Model offset of the binarizer (original origin = centered origin + offset). Zero without a model library.
	async offset(model: number): Promise<number[]> {
		const off = this.lib ? (await this.lib.model(this.store.models[model])).offset : [0, 0, 0];
		this.used.set(model, off);
		return off;
	}

	// Length of a model along its long horizontal axis, and true when that axis is the model x axis. 4 m without a model library.
	async modelSize(name: string): Promise<{ length: number; xLong: boolean }> {
		if (!this.lib) return { length: 4, xLong: true };
		const g = (await this.lib.model(name)).geometry;
		if (!g.boundingBox) g.computeBoundingBox();
		const b = g.boundingBox!;
		const [sx, sz] = [b.max.x - b.min.x, b.max.z - b.min.z];
		return Number.isFinite(sx) && Number.isFinite(sz) ? { length: Math.max(sx, sz), xLong: sx >= sz } : { length: 4, xLong: true };
	}

	ground(x: number, y: number): number {
		return this.viewer.heightAt(x, y) ?? 0;
	}

	private changed() {
		this.onState?.();
	}

	// The gizmo sits at the center of the selection. In local space, the gizmo has the rotation of the last selected object.
	private updateGizmo() {
		const ids = [...this.selection].filter((id) => this.store.editable(id));
		if (!ids.length) {
			this.gizmo.detach();
			return;
		}
		const c = new THREE.Vector3();
		for (const id of ids) c.add(new THREE.Vector3(this.store.t[id * 12 + 9], this.store.t[id * 12 + 10], -this.store.t[id * 12 + 11]));
		this.pivot.position.copy(c.divideScalar(ids.length));
		this.pivot.rotation.set(0, 0, 0);
		if (this.space === "local") {
			const q = new THREE.Quaternion();
			matrixOf(this.store.t, ids[ids.length - 1] * 12).decompose(new THREE.Vector3(), q, new THREE.Vector3());
			this.pivot.quaternion.copy(q);
		}
		this.pivot.scale.set(1, 1, 1);
		this.pivot.updateMatrixWorld();
		this.gizmo.attach(this.pivot);
		this.gizmo.setMode(this.mode);
		this.gizmo.setSpace(this.space);
	}

	private beginDrag() {
		this.pivot.updateMatrixWorld();
		const items = [...this.selection].filter((id) => this.store.editable(id)).map((id) => ({ id, m: matrixOf(this.store.t, id * 12), before: this.store.snapshot(id)! }));
		this.dragStart = { pivot: this.pivot.matrixWorld.clone().invert(), items };
	}

	// While the gizmo moves: apply the change of the pivot to each selected object.
	private drag() {
		const d = this.dragStart;
		if (!d) return;
		// Arma objects have one scale for all axes. Each scale handle scales all axes by the value of the axis that changed most.
		if (this.mode === "scale") {
			const v = this.pivot.scale.toArray();
			this.pivot.scale.setScalar(v.reduce((a, b) => (Math.abs(b - 1) > Math.abs(a - 1) ? b : a), 1));
		}
		this.pivot.updateMatrixWorld();
		const delta = this.pivot.matrixWorld.clone().multiply(d.pivot);
		const ids: number[] = [];
		for (const it of d.items) {
			const t = fromThree(delta.clone().multiply(it.m));
			if (this.snapGround && this.mode === "translate") this.snapToGround(it.before.model, t);
			this.store.t.set(t, it.id * 12);
			ids.push(it.id);
		}
		this.viewer.refresh(ids);
	}

	private endDrag() {
		const d = this.dragStart;
		this.dragStart = null;
		if (!d) return;
		const changes = d.items.map((it) => {
			const after = this.store.snapshot(it.id)!;
			after.raw = undefined;
			return { id: it.id, before: it.before, after };
		});
		this.commit(changes);
	}

	// Set the height to relative z 0 (see shift in transform.ts). Uses the cached model offset.
	private snapToGround(model: number, t: Float32Array) {
		const off = this.viewer.modelOffset(model);
		t[10] = this.ground(t[9], t[11]) + t[1] * off[0] + t[4] * off[1] + t[7] * off[2];
	}

	private ndc(e: PointerEvent): THREE.Vector2 {
		const r = this.canvas.getBoundingClientRect();
		return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
	}

	private pointerDown(e: PointerEvent) {
		// The gizmo handles its own drags.
		if (!this.enabled || e.button !== 0 || this.gizmo.axis !== null) return;
		this.down = { x: e.clientX, y: e.clientY, ndc: this.ndc(e) };
	}

	private pointerMove(e: PointerEvent) {
		const d = this.down;
		if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_PX) return;
		const r = this.canvas.getBoundingClientRect();
		Object.assign(this.rect.style, {
			display: "block",
			left: `${Math.min(d.x, e.clientX) - r.left}px`,
			top: `${Math.min(d.y, e.clientY) - r.top}px`,
			width: `${Math.abs(e.clientX - d.x)}px`,
			height: `${Math.abs(e.clientY - d.y)}px`,
		});
	}

	private pointerUp(e: PointerEvent) {
		const d = this.down;
		this.down = null;
		this.rect.style.display = "none";
		if (!d || e.button !== 0) return;
		const how = e.shiftKey ? "add" : e.ctrlKey ? "toggle" : "set";
		if (Math.hypot(e.clientX - d.x, e.clientY - d.y) >= DRAG_PX) {
			this.select(this.viewer.objectsIn(d.ndc, this.ndc(e)), how);
			return;
		}
		if (this.placing) {
			const g = this.viewer.pick(d.ndc);
			if (g) this.place(g);
			return;
		}
		const id = this.viewer.objectAt(d.ndc);
		this.select(id === null ? [] : [id], how);
	}

	private key(e: KeyboardEvent) {
		const ctrl = e.ctrlKey || e.metaKey;
		const k = e.key.toLowerCase();
		const cursor = () => (this.viewer.lastCursor ? { x: this.viewer.lastCursor.x, y: this.viewer.lastCursor.y } : undefined);
		const run: Record<string, () => void> = ctrl
			? { z: () => this.undo(), y: () => this.redo(), c: () => this.copy(), v: () => this.paste(cursor()), d: () => this.duplicate() }
			: {
					"1": () => this.setMode("translate"),
					"2": () => this.setMode("rotate"),
					"3": () => this.setMode("scale"),
					x: () => this.setSpace(this.space === "world" ? "local" : "world"),
					" ": () => this.setSpace(this.space === "world" ? "local" : "world"),
					delete: () => this.deleteSelection(),
					escape: () => (this.placing ? this.startPlace(null) : this.select([])),
				};
		const f = run[k];
		if (!f) return;
		e.preventDefault();
		f();
	}
}
