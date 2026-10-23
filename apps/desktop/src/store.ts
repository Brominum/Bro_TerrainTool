// Object store: all placed objects, in layers.
import type { FillSettings } from "./data";
import type { Shape } from "./shapes";
// A transform has 12 values: aside, up, dir, position. Each vector is (x, z, y) in Arma order (x east, z up, y north).
// The position is the centered model origin, as in the WRP (see the model offset in p3d.rs).
export interface Layer {
	name: string;
	visible: boolean;
	locked: boolean;
	// z mode of the imported object text. The export keeps the original lines only in the same mode.
	textMode?: "relative" | "absolute";
	// A deleted layer stays in the list (hidden), so that the layer numbers of the objects and of undo do not change.
	deleted?: boolean;
}

// One object fill: the settings and the recipe models, so that the fill can run again. Its objects are in one layer.
export interface Fill {
	name: string;
	layer: number;
	settings: FillSettings;
	models: string[];
	avoid: boolean;
	deleted?: boolean;
	// The shape (Shape.id) of the objects of a spline.
	shape?: number;
}

// One object. `raw` is the original line of an imported object text. The export writes it again while the object is not changed.
export interface Snapshot {
	model: number;
	t: Float32Array;
	layer: number;
	raw?: string;
	// Index in ObjectStore.fills, when a fill made the object.
	fill?: number;
}

// One change for undo: the object before and after. Null is "no object" (added or deleted).
export interface Change {
	id: number;
	before: Snapshot | null;
	after: Snapshot | null;
}

export class ObjectStore {
	models: string[] = [];
	layers: Layer[] = [];
	// Layer numbers in the order of the layer list.
	order: number[] = [];
	fills: Fill[] = [];
	shapes: Shape[] = [];
	// Object data by ID. Model -1 is a free ID.
	t = new Float32Array(12 * 1024);
	model = new Int32Array(1024).fill(-1);
	layer = new Uint16Array(1024);
	// Fill of each object, -1 for none.
	fill = new Int32Array(1024).fill(-1);
	raw: (string | undefined)[] = [];
	// All IDs are below `size`. `count` is the number of objects.
	size = 0;
	count = 0;
	private free: number[] = [];
	private modelIndex = new Map<string, number>();
	// Called after objects are added, changed, or removed, with their IDs.
	onChange?: (ids: number[]) => void;

	modelId(name: string): number {
		const key = name.toLowerCase();
		let i = this.modelIndex.get(key);
		if (i === undefined) {
			i = this.models.length;
			this.models.push(name);
			this.modelIndex.set(key, i);
		}
		return i;
	}

	// Name for a new layer: "New Layer <n>", with n one more than the largest n in use.
	newLayerName(): string {
		const n = this.layers.map((l) => /^New Layer (\d+)$/.exec(l.name)).reduce((m, r) => Math.max(m, r ? Number(r[1]) : 0), 0);
		return `New Layer ${n + 1}`;
	}

	addLayer(name: string): number {
		this.layers.push({ name, visible: true, locked: false });
		this.order.push(this.layers.length - 1);
		return this.layers.length - 1;
	}

	// Layers that are not deleted, in the list order.
	shown(): number[] {
		return this.order.filter((l) => !this.layers[l].deleted);
	}

	// Move a layer up (-1) or down (1) in the list, past the next layer that is not deleted.
	move(l: number, dir: -1 | 1) {
		const s = this.shown();
		const i = s.indexOf(l);
		const j = i + dir;
		if (i < 0 || j < 0 || j >= s.length) return;
		const [a, b] = [this.order.indexOf(s[i]), this.order.indexOf(s[j])];
		[this.order[a], this.order[b]] = [this.order[b], this.order[a]];
	}

	alive(id: number): boolean {
		return id < this.size && this.model[id] >= 0;
	}

	*ids(): Generator<number> {
		for (let id = 0; id < this.size; id++) if (this.model[id] >= 0) yield id;
	}

	// The object can be selected and edited: it exists, and its layer is visible and not locked.
	editable(id: number): boolean {
		const l = this.layers[this.layer[id]];
		return this.alive(id) && !!l && l.visible && !l.locked;
	}

	snapshot(id: number): Snapshot | null {
		if (!this.alive(id)) return null;
		return { model: this.model[id], t: this.t.slice(id * 12, id * 12 + 12), layer: this.layer[id], raw: this.raw[id], fill: this.fill[id] < 0 ? undefined : this.fill[id] };
	}

	// Set an object to a snapshot, or delete it (null). Does not call onChange.
	restore(id: number, s: Snapshot | null) {
		this.reserve(id + 1);
		if (this.model[id] >= 0) this.count--;
		if (!s) {
			this.model[id] = -1;
			this.raw[id] = undefined;
			this.free.push(id);
			return;
		}
		this.model[id] = s.model;
		this.t.set(s.t, id * 12);
		this.layer[id] = s.layer;
		this.raw[id] = s.raw;
		this.fill[id] = s.fill ?? -1;
		this.count++;
		this.size = Math.max(this.size, id + 1);
	}

	// A free ID for a new object.
	newId(): number {
		while (this.free.length) {
			const id = this.free.pop()!;
			if (this.model[id] < 0) return id;
		}
		return this.size;
	}

	add(s: Snapshot): number {
		const id = this.newId();
		this.restore(id, s);
		return id;
	}

	// Apply changes forward (after) or back (before), then report the changed IDs.
	apply(changes: Change[], forward: boolean) {
		for (const c of forward ? changes : [...changes].reverse()) this.restore(c.id, forward ? c.after : c.before);
		this.onChange?.(changes.map((c) => c.id));
	}

	private reserve(n: number) {
		if (n <= this.model.length) return;
		let cap = this.model.length;
		while (cap < n) cap *= 2;
		const t = new Float32Array(cap * 12);
		t.set(this.t);
		this.t = t;
		const model = new Int32Array(cap).fill(-1);
		model.set(this.model);
		this.model = model;
		const layer = new Uint16Array(cap);
		layer.set(this.layer);
		this.layer = layer;
		const fill = new Int32Array(cap).fill(-1);
		fill.set(this.fill);
		this.fill = fill;
	}
}

// A store with the objects of a WRP in one layer. The WRP transforms are already in the store form.
export function storeFromWrp(o: { count: number; transforms: Float32Array; model: Uint32Array; models: string[] }, layerName: string): ObjectStore {
	const st = new ObjectStore();
	st.addLayer(layerName);
	const ids = o.models.map((n) => st.modelId(n));
	for (let i = 0; i < o.count; i++) st.restore(i, { model: ids[o.model[i]], t: o.transforms.subarray(i * 12, i * 12 + 12), layer: 0 });
	return st;
}
