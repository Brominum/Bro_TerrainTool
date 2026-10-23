// Height brush in the 3D view. The heights stay in the Rust core; the view gets the changed cells after each request.
// Left mouse paints. Ctrl+click picks the height of flatten, or the two points of the plane. A stamp is one click.
// A stroke is one undo step of the editor. With "objects follow", the objects in the changed area keep their height above the terrain.
import * as THREE from "three";
import { heightEndStroke, heightPaint, heightPick, heightRegion, heightStamp, heightUndo, type HeightTool, type Rect } from "./data";
import type { Editor } from "./editor";
import type { Change } from "./store";
import type { Viewer } from "./viewer";

export type TerrainTool = HeightTool | "stamp";

// Bilinear height of an ASC-order array at local meters, the same as Viewer.heightAt.
function sample(h: Float32Array, ncols: number, nrows: number, cell: number, x: number, y: number): number {
	const fx = Math.max(0, Math.min(ncols - 1, x / cell));
	const fy = Math.max(0, Math.min(nrows - 1, y / cell));
	const x0 = Math.min(Math.floor(fx), ncols - 2);
	const y0 = Math.min(Math.floor(fy), nrows - 2);
	const [ax, ay] = [fx - x0, fy - y0];
	const v = (c: number, r: number) => h[(nrows - 1 - r) * ncols + c];
	return (v(x0, y0) * (1 - ax) + v(x0 + 1, y0) * ax) * (1 - ay) + (v(x0, y0 + 1) * (1 - ax) + v(x0 + 1, y0 + 1) * ax) * ay;
}

export class HeightBrush {
	tool: TerrainTool | null = null;
	// Radius in meters. Strength: meters for each dab (raise, lower, noise) or 0 to 1 (smooth, flatten, plane).
	radius = 40;
	strength = 0.5;
	hardness = 0.3;
	// Height of flatten. Size of the noise in meters.
	flatten = 0;
	noiseSize = 30;
	// Two points of the plane: x, y, height. The second point is set after the first.
	plane: number[] = [];
	stamp = { loaded: "", size: 200, height: 20, max: false };
	follow = true;
	onChange?: () => void;
	onError?: (e: string) => void;
	private ring: THREE.LineLoop;
	private queue: Promise<unknown> = Promise.resolve();
	private stroke?: { pending: number[][]; last?: number[]; busy: boolean; done: boolean; rect?: Rect; base: Float32Array; send: (pts: number[][]) => Promise<Rect | null> };

	constructor(private viewer: Viewer, private ed: Editor, private canvas: HTMLCanvasElement) {
		const g = new THREE.BufferGeometry();
		g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(64 * 3), 3));
		this.ring = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: 0xffe040, depthTest: false }));
		this.ring.frustumCulled = false;
		this.ring.renderOrder = 10;
		this.ring.visible = false;
		viewer.scene.add(this.ring);
		viewer.onFrame = () => this.updateRing();
		canvas.addEventListener("pointerdown", (e) => this.down(e));
		canvas.addEventListener("pointermove", (e) => this.move(e));
		window.addEventListener("pointerup", () => this.up());
	}

	setTool(t: TerrainTool | null) {
		this.tool = t;
		this.ed.enabled = t === null;
		if (t) {
			this.ed.startPlace(null);
			// The gizmo of a selection would take the clicks of the brush.
			this.ed.select([]);
		}
		this.plane = [];
		this.onChange?.();
	}

	private updateRing() {
		const c = this.viewer.lastCursor;
		this.ring.visible = !!this.tool && !!c;
		if (!this.ring.visible || !c) return;
		const r = this.tool === "stamp" ? this.stamp.size / 2 : this.radius;
		const p = this.ring.geometry.getAttribute("position") as THREE.BufferAttribute;
		for (let i = 0; i < 64; i++) {
			const a = (i / 64) * Math.PI * 2;
			const [x, y] = [c.x + Math.cos(a) * r, c.y + Math.sin(a) * r];
			p.setXYZ(i, x, (this.viewer.heightAt(x, y) ?? c.h) + 0.5, -y);
		}
		p.needsUpdate = true;
	}

	private ground(e: PointerEvent): number[] | null {
		const r = this.canvas.getBoundingClientRect();
		const c = this.viewer.pick(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1));
		return c && [c.x, c.y];
	}

	private job<T>(f: () => Promise<T>): Promise<T> {
		const p = this.queue.then(f);
		this.queue = p.catch((e) => this.onError?.(String(e)));
		return p;
	}

	// Load the cells of a changed area into the 3D view.
	private async show(r: Rect) {
		this.viewer.updateHeights(r, await heightRegion(r));
	}

	private down(e: PointerEvent) {
		if (!this.tool || e.button !== 0 || !this.viewer.terrain) return;
		const p = this.ground(e);
		if (!p) return;
		if (e.ctrlKey && (this.tool === "flatten" || this.tool === "plane")) {
			this.job(() => heightPick(p[0], p[1])).then((h) => {
				if (this.tool === "flatten") this.flatten = Math.round(h * 100) / 100;
				else this.plane = this.plane.length === 3 ? [...this.plane, p[0], p[1], h] : [p[0], p[1], h];
				this.onChange?.();
			});
			return;
		}
		if (this.tool === "plane" && this.plane.length < 6) {
			this.onError?.("Ctrl+click two points to set the plane first.");
			return;
		}
		const t = this.viewer.terrain;
		const base = this.follow ? t.heights.slice() : new Float32Array(0);
		if (this.tool === "stamp") {
			const s = this.stamp;
			if (!s.loaded) {
				this.onError?.("Load a stamp image first.");
				return;
			}
			this.job(() => heightStamp(p[0], p[1], s.size, s.height, s.max)).then((r) => r && this.finish(r, base));
			return;
		}
		const tool = this.tool;
		const [rad, hard, str] = [this.radius, this.hardness, this.strength];
		const value = tool === "flatten" ? this.flatten : this.noiseSize;
		const plane = this.plane.length === 6 ? [...this.plane] : [0, 0, 0, 0, 0, 0];
		const seed = (Math.random() * 2 ** 32) >>> 0;
		this.stroke = { pending: [p], busy: false, done: false, base, send: (pts) => heightPaint(pts, rad, hard, str, tool, value, plane, seed) };
		this.flush();
	}

	private move(e: PointerEvent) {
		const s = this.stroke;
		if (!s) return;
		if (!(e.buttons & 1)) return this.up();
		const p = this.ground(e);
		if (p) s.pending.push(p);
		this.flush();
	}

	private up() {
		const s = this.stroke;
		if (!s || s.done) return;
		s.done = true;
		this.flush();
	}

	// Send the waiting points (one request at a time, as in the 2D view). At the end: close the stroke and make the undo step.
	private flush() {
		const s = this.stroke;
		if (!s || s.busy) return;
		if (!s.pending.length) {
			if (s.done) {
				this.stroke = undefined;
				this.job(() => heightEndStroke()).then(() => s.rect && this.finish(s.rect, s.base, true));
			}
			return;
		}
		const pts = s.last ? [s.last, ...s.pending] : s.pending;
		s.last = s.pending[s.pending.length - 1];
		s.pending = [];
		s.busy = true;
		this.job(() => s.send(pts))
			.then(async (r) => {
				if (!r) return;
				s.rect = s.rect ? [Math.min(s.rect[0], r[0]), Math.min(s.rect[1], r[1]), Math.max(s.rect[2], r[2]), Math.max(s.rect[3], r[3])] : r;
				await this.show(r);
			})
			.finally(() => {
				s.busy = false;
				this.flush();
			});
	}

	// The heights before a change, for "objects follow" (empty when it is off).
	base(): Float32Array {
		return this.follow && this.viewer.terrain ? this.viewer.terrain.heights.slice() : new Float32Array(0);
	}

	// After a stroke, a stamp, or a shape action: move the objects in the area with the ground, and put one undo step on the editor.
	async finish(r: Rect, base: Float32Array, shown = false) {
		if (!shown) await this.show(r);
		const t = this.viewer.terrain!;
		const st = this.ed.store;
		const changes: Change[] = [];
		if (this.follow && base.length) {
			// The area in local meters, from the cells (row 0 is the north row).
			const [x0, x1] = [r[0] * t.cell, (r[2] - 1) * t.cell];
			const [y0, y1] = [(t.nrows - r[3]) * t.cell, (t.nrows - 1 - r[1]) * t.cell];
			for (const id of st.ids()) {
				const o = id * 12;
				const [x, y] = [st.t[o + 9], st.t[o + 11]];
				if (x < x0 - t.cell || x > x1 + t.cell || y < y0 - t.cell || y > y1 + t.cell) continue;
				const d = sample(t.heights, t.ncols, t.nrows, t.cell, x, y) - sample(base, t.ncols, t.nrows, t.cell, x, y);
				if (Math.abs(d) < 1e-4) continue;
				const before = st.snapshot(id)!;
				const after = { ...before, t: before.t.slice() };
				after.t[10] += d;
				// A raw line of a relative text import stays correct (the height above the terrain does not change). An absolute one does not.
				if (st.layers[before.layer]?.textMode !== "relative") after.raw = undefined;
				changes.push({ id, before, after });
			}
			st.apply(changes, true);
		}
		const redraw = (rect: Rect | null) => rect && this.show(rect);
		this.ed.pushStep({ changes, flip: () => this.job(() => heightUndo(false)).then(redraw), redo: () => this.job(() => heightUndo(true)).then(redraw) });
		this.onChange?.();
	}
}
