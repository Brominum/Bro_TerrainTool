// Scatter brush in the 3D view: paint objects of the fill panel recipe. Each dab adds objects until the circle has the density
// of the recipe; the spacing, slope, height, and water rules apply. Shift+paint removes the objects of the recipe models under the brush.
// One stroke is one undo step. The objects go into the active layer.
import * as THREE from "three";
import type { Editor } from "./editor";
import type { Recipe } from "./FillPanel";
import { random } from "./shapes";
import type { Change } from "./store";
import { fromText } from "./transform";
import type { Viewer } from "./viewer";

export class ScatterBrush {
	enabled = false;
	radius = 20;
	onChange?: () => void;
	onError?: (e: string) => void;
	private ring: THREE.LineLoop;
	private stroke?: { erase: boolean; changes: Change[]; grid: Map<string, number[][]>; models: number[]; offs: number[][]; rnd: () => number; recipe: Recipe; last?: number[] };

	constructor(private viewer: Viewer, private ed: Editor, private canvas: HTMLCanvasElement, private recipe: { current: () => Recipe }) {
		const g = new THREE.BufferGeometry();
		g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(64 * 3), 3));
		this.ring = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: 0x60ff60, depthTest: false }));
		this.ring.frustumCulled = false;
		this.ring.renderOrder = 10;
		this.ring.visible = false;
		viewer.scene.add(this.ring);
		const prev = viewer.onFrame;
		viewer.onFrame = () => {
			prev?.();
			this.updateRing();
		};
		canvas.addEventListener("pointerdown", (e) => this.down(e));
		canvas.addEventListener("pointermove", (e) => this.move(e));
		window.addEventListener("pointerup", () => this.up());
	}

	setEnabled(on: boolean) {
		this.enabled = on;
		this.ed.enabled = !on;
		if (on) {
			this.ed.startPlace(null);
			this.ed.select([]);
		}
		this.onChange?.();
	}

	private updateRing() {
		const c = this.viewer.lastCursor;
		this.ring.visible = this.enabled && !!c;
		if (!this.ring.visible || !c) return;
		const p = this.ring.geometry.getAttribute("position") as THREE.BufferAttribute;
		for (let i = 0; i < 64; i++) {
			const a = (i / 64) * Math.PI * 2;
			const [x, y] = [c.x + Math.cos(a) * this.radius, c.y + Math.sin(a) * this.radius];
			p.setXYZ(i, x, (this.viewer.heightAt(x, y) ?? c.h) + 0.5, -y);
		}
		p.needsUpdate = true;
	}

	private ground(e: PointerEvent): number[] | null {
		const r = this.canvas.getBoundingClientRect();
		const c = this.viewer.pick(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1));
		return c && [c.x, c.y];
	}

	private async down(e: PointerEvent) {
		if (!this.enabled || e.button !== 0 || !this.viewer.terrain) return;
		const recipe = this.recipe.current();
		const weights = recipe.settings.weights;
		if (!recipe.models.length || !weights.some((w) => w > 0)) {
			this.onError?.("Add models to the recipe in the Object fill panel first.");
			return;
		}
		const st = this.ed.store;
		const models = recipe.models.map((m) => st.modelId(m));
		// The objects of the recipe models in a grid of cells as large as the spacing (at least 1 m).
		const cell = Math.max(1, recipe.settings.spacing);
		const grid = new Map<string, number[][]>();
		const set = new Set(models);
		for (const id of st.ids()) {
			if (!set.has(st.model[id])) continue;
			const [x, y] = [st.t[id * 12 + 9], st.t[id * 12 + 11]];
			const k = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
			(grid.get(k) ?? grid.set(k, []).get(k)!).push([x, y, id]);
		}
		this.stroke = { erase: e.shiftKey, changes: [], grid, models, offs: [], rnd: random((Math.random() * 2 ** 32) >>> 0), recipe };
		const s = this.stroke;
		s.offs = await Promise.all(models.map((m) => this.ed.offset(m)));
		const p = this.ground(e);
		if (p && this.stroke === s) this.dab(p);
	}

	private move(e: PointerEvent) {
		const s = this.stroke;
		if (!s || !s.offs.length) return;
		if (!(e.buttons & 1)) return this.up();
		const p = this.ground(e);
		// A new dab each quarter of the radius.
		if (p && (!s.last || Math.hypot(p[0] - s.last[0], p[1] - s.last[1]) > this.radius / 4)) this.dab(p);
	}

	private up() {
		const s = this.stroke;
		this.stroke = undefined;
		if (!s || !s.changes.length) return;
		this.ed.pushStep({ changes: s.changes });
		this.onChange?.();
	}

	private near(s: NonNullable<typeof this.stroke>, x: number, y: number, r: number): number[][] {
		const cell = Math.max(1, s.recipe.settings.spacing);
		const out: number[][] = [];
		for (let i = Math.floor((x - r) / cell); i <= Math.floor((x + r) / cell); i++) {
			for (let j = Math.floor((y - r) / cell); j <= Math.floor((y + r) / cell); j++) {
				for (const p of s.grid.get(`${i},${j}`) ?? []) if (Math.hypot(p[0] - x, p[1] - y) < r) out.push(p);
			}
		}
		return out;
	}

	private dab(c: number[]) {
		const s = this.stroke!;
		s.last = c;
		const st = this.ed.store;
		const r = this.radius;
		const changes: Change[] = [];
		const inCircle = this.near(s, c[0], c[1], r);
		if (s.erase) {
			for (const p of inCircle) {
				if (!st.alive(p[2]) || !st.editable(p[2])) continue;
				changes.push({ id: p[2], before: st.snapshot(p[2]), after: null });
				const k = `${Math.floor(p[0] / Math.max(1, s.recipe.settings.spacing))},${Math.floor(p[1] / Math.max(1, s.recipe.settings.spacing))}`;
				s.grid.set(k, (s.grid.get(k) ?? []).filter((q) => q[2] !== p[2]));
			}
		} else {
			const set = s.recipe.settings;
			const target = (set.density / 10000) * Math.PI * r * r;
			let need = Math.round(target - inCircle.length);
			const total = set.weights.reduce((a, w) => a + Math.max(0, w), 0);
			const maxSlope = Math.tan((Math.min(90, Math.max(0, set.maxSlope)) * Math.PI) / 180);
			const h = (x: number, y: number) => this.ed.ground(x, y);
			let id = st.newId();
			for (let tries = 0; need > 0 && tries < need * 30 + 30; tries++) {
				const a = s.rnd() * Math.PI * 2;
				const d = Math.sqrt(s.rnd()) * r;
				const [x, y] = [c[0] + Math.cos(a) * d, c[1] + Math.sin(a) * d];
				if (set.spacing > 0 && this.near(s, x, y, set.spacing).length) continue;
				const z = h(x, y);
				const [gx, gy] = [(h(x + 1, y) - h(x - 1, y)) / 2, (h(x, y + 1) - h(x, y - 1)) / 2];
				if (z < set.minHeight || z > set.maxHeight || (set.noWater && z < 0) || Math.hypot(gx, gy) > maxSlope) continue;
				let pick = s.rnd() * total;
				const k = Math.max(0, set.weights.findIndex((w) => (pick -= Math.max(0, w)) < 0));
				const yaw = set.randomYaw ? s.rnd() * 360 : 0;
				const scale = set.scale[0] + s.rnd() * (set.scale[1] - set.scale[0]);
				let [pitch, roll] = [0, 0];
				if (set.tilt) {
					const ya = (yaw * Math.PI) / 180;
					pitch = (Math.atan(gx * Math.sin(ya) + gy * Math.cos(ya)) * 180) / Math.PI;
					roll = (-Math.atan(gx * Math.cos(ya) - gy * Math.sin(ya)) * 180) / Math.PI;
				}
				while (st.alive(id) || changes.some((ch) => ch.id === id)) id++;
				const t = fromText({ x, y, yaw, pitch, roll, scale, z: 0 }, s.offs[k], 0, 0, true, h);
				changes.push({ id, before: null, after: { model: s.models[k], t, layer: this.ed.activeLayer } });
				const gk = `${Math.floor(x / Math.max(1, set.spacing))},${Math.floor(y / Math.max(1, set.spacing))}`;
				(s.grid.get(gk) ?? s.grid.set(gk, []).get(gk)!).push([x, y, id]);
				id++;
				need--;
			}
		}
		if (!changes.length) return;
		st.apply(changes, true);
		for (const c of changes) s.changes.push(c);
	}
}
