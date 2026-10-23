// Clutter on the ground detail layers, as in the game: one try in each clutter grid cell near the camera. The layer of the cell (from
// the mask) gives the clutter items of its surface (CfgSurfaces, CfgSurfaceCharacters), and a random value picks one item by its
// probability (the rest of the probability is an empty cell). Position, yaw and scale are random, the same each time for a cell.
// shortcut: the clutter stands upright (the game tilts it with the terrain) and has no wind. Add the tilt if it looks wrong on slopes.
import * as THREE from "three";
import type { Model, ModelLibrary } from "./models";

export interface ClutterItem {
	model: string;
	probability: number;
	scaleMin: number;
	scaleMax: number;
}

export interface ClutterHost {
	heightAt(x: number, y: number): number | null;
	// Layer of each mask texel (255: none), w x h, row 0 is the north row, over the full terrain (size meters).
	ids(): { w: number; h: number; data: Uint8Array; size: number } | null;
}

// Hash of a cell and a channel, 0 to 1. The same cell gives the same clutter after each update.
function rand(cx: number, cy: number, k: number): number {
	let h = Math.imul(cx, 0x27d4eb2d) ^ Math.imul(cy, 0x165667b1) ^ Math.imul(k + 1, 0x9e3779b1);
	h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
	h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

interface Kind {
	model?: Model;
	mesh?: THREE.InstancedMesh;
}

export class Clutter {
	readonly group = new THREE.Group();
	private layers: ClutterItem[][] = [];
	private grid = 1.1;
	private kinds = new Map<string, Kind>();
	// Camera cell of the last update; NaN makes the next update run.
	private at = [NaN, NaN];
	private dist = 50;
	count = 0;

	constructor(private host: ClutterHost) {
		this.group.name = "clutter";
	}

	// Clutter items of each layer and the grid (meters between cells, clutterGrid of the world). Null removes the clutter.
	set(c: { layers: ClutterItem[][]; grid?: number | null } | null, lib?: ModelLibrary) {
		for (const k of this.kinds.values()) if (k.mesh) this.group.remove(k.mesh);
		this.kinds.clear();
		this.layers = c?.layers ?? [];
		this.grid = c?.grid && c.grid > 0.1 ? c.grid : 1.1;
		if (lib) {
			for (const name of new Set(this.layers.flat().map((i) => i.model))) {
				const kind: Kind = {};
				this.kinds.set(name, kind);
				lib.model(name).then((m) => {
					if (this.kinds.get(name) !== kind || m.error || m.empty) return;
					kind.model = m;
					this.dirty();
				});
			}
		}
		this.dirty();
	}

	// Run the next update again (new mask, new heights, new models).
	dirty() {
		this.at = [NaN, NaN];
	}

	// Fill the instances in the circle of dist meters around the camera (x east, y north). Runs only after the camera moves 2 cells.
	update(x: number, y: number, dist: number, visible: boolean) {
		this.group.visible = visible && this.kinds.size > 0;
		if (!this.group.visible) return;
		const [cx, cy] = [Math.floor(x / this.grid), Math.floor(y / this.grid)];
		if (dist === this.dist && Math.abs(cx - this.at[0]) < 2 && Math.abs(cy - this.at[1]) < 2) return;
		this.at = [cx, cy];
		this.dist = dist;
		const ids = this.host.ids();
		const out = new Map<string, number[]>();
		const n = Math.ceil(dist / this.grid);
		const m = new THREE.Matrix4();
		const q = new THREE.Quaternion();
		const up = new THREE.Vector3(0, 1, 0);
		const s = new THREE.Vector3();
		const p = new THREE.Vector3();
		for (let j = cy - n; ids && j <= cy + n; j++) {
			for (let i = cx - n; i <= cx + n; i++) {
				const px = (i + rand(i, j, 1)) * this.grid;
				const py = (j + rand(i, j, 2)) * this.grid;
				if ((px - x) ** 2 + (py - y) ** 2 > dist * dist || px < 0 || py < 0 || px >= ids.size || py >= ids.size) continue;
				const layer = ids.data[Math.floor((1 - py / ids.size) * ids.h) * ids.w + Math.floor((px / ids.size) * ids.w)];
				const items = this.layers[layer];
				if (!items?.length) continue;
				let r = rand(i, j, 0);
				const item = items.find((it) => (r -= it.probability) < 0);
				const model = item && this.kinds.get(item.model)?.model;
				const h = model && this.host.heightAt(px, py);
				if (!model || h == null) continue;
				const k = item.scaleMin + (item.scaleMax - item.scaleMin) * rand(i, j, 3);
				// The original origin of the model stands on the ground (see Model.offset).
				p.set(px, h + model.offset[1] * k, -py);
				q.setFromAxisAngle(up, rand(i, j, 4) * Math.PI * 2);
				m.compose(p, q, s.setScalar(k));
				let a = out.get(item.model);
				if (!a) out.set(item.model, (a = []));
				for (const v of m.elements) a.push(v);
			}
		}
		this.count = 0;
		for (const [name, kind] of this.kinds) {
			const a = out.get(name) ?? [];
			const count = a.length / 16;
			if (!kind.model || (!count && !kind.mesh)) continue;
			if (!kind.mesh || kind.mesh.instanceMatrix.count < count) {
				if (kind.mesh) this.group.remove(kind.mesh);
				kind.mesh = new THREE.InstancedMesh(kind.model.geometry, kind.model.materials, Math.max(64, count * 2));
				kind.mesh.frustumCulled = false;
				kind.mesh.receiveShadow = true;
				this.group.add(kind.mesh);
			}
			(kind.mesh.instanceMatrix.array as Float32Array).set(a);
			kind.mesh.count = count;
			kind.mesh.instanceMatrix.clearUpdateRanges();
			kind.mesh.instanceMatrix.addUpdateRange(0, a.length);
			kind.mesh.instanceMatrix.needsUpdate = true;
			this.count += count;
		}
	}
}
