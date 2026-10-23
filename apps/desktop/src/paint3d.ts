// Mask and satellite painting in the 3D view (Paint tab, 3D view). The tools of the 2D painter (MaskView) get image points from
// the terrain under the mouse: the brushes and the flood fill. The polygon and the lasso are only in the 2D view.
import * as THREE from "three";
import type { MaskView } from "./maskview";
import type { Viewer } from "./viewer";

export class Paint3D {
	enabled = false;
	private ring: THREE.LineLoop;
	private painting = false;

	constructor(private viewer: Viewer, private mv: MaskView, private canvas: HTMLCanvasElement) {
		const g = new THREE.BufferGeometry();
		g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(64 * 3), 3));
		this.ring = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: 0x40e0ff, depthTest: false }));
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

	// Meters for each pixel of the image that the tools change.
	private metersPerPx(): number {
		const t = this.viewer.terrain;
		const z = this.mv.size();
		return t && z ? (t.ncols * t.cell) / z.width : 0;
	}

	// Image pixel (row 0 is the north row) of the terrain under the mouse.
	private image(e: PointerEvent): number[] | null {
		const t = this.viewer.terrain;
		const z = this.mv.size();
		const r = this.canvas.getBoundingClientRect();
		const c = this.viewer.pick(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1));
		if (!c || !t || !z) return null;
		return [(c.x / (t.ncols * t.cell)) * z.width, ((t.nrows * t.cell - c.y) / (t.nrows * t.cell)) * z.height];
	}

	private updateRing() {
		const c = this.viewer.lastCursor;
		const k = this.metersPerPx();
		this.ring.visible = this.enabled && !!c && k > 0 && this.mv.in3d();
		if (!this.ring.visible || !c) return;
		const r = this.mv.radius * k;
		const p = this.ring.geometry.getAttribute("position") as THREE.BufferAttribute;
		for (let i = 0; i < 64; i++) {
			const a = (i / 64) * Math.PI * 2;
			const [x, y] = [c.x + Math.cos(a) * r, c.y + Math.sin(a) * r];
			p.setXYZ(i, x, (this.viewer.heightAt(x, y) ?? c.h) + 0.5, -y);
		}
		p.needsUpdate = true;
	}

	private down(e: PointerEvent) {
		if (!this.enabled || e.button !== 0 || !this.mv.in3d()) return;
		const p = this.image(e);
		if (!p) return;
		this.mv.begin(p, e);
		this.painting = true;
	}

	private move(e: PointerEvent) {
		if (!this.painting) return;
		if (!(e.buttons & 1)) return this.up();
		const p = this.image(e);
		if (p) this.mv.strokeTo(p);
	}

	private up() {
		if (!this.painting) return;
		this.painting = false;
		this.mv.endStroke();
	}
}
