// 2D painter: the satellite image with the layer mask on top. The image data stays in the Rust core.
// The view loads both images in tiles of 512 x 512 px at a level of detail. Mask level n uses every 2^n-th pixel,
// satellite level n is the mean of 2^n x 2^n pixels. The paint target selects the image that the tools change.
// Mouse: left paints with the tool, right or middle drag pans, wheel zooms. Keys: [ and ] brush size, Ctrl+Z, Ctrl+Y,
// Enter closes the polygon, Backspace removes its last point, Escape cancels it.
// Satellite: Ctrl+click picks the color (color tool), Alt+click sets the clone source.
import { maskEndStroke, maskFill, maskPaint, maskPolygon, maskRegion, maskUndo, satEndStroke, satPaint, satPick, satRegion, satUndo, type MaskInfo, type Rect, type SatTool } from "./data";

export type MaskTool = "brush" | "erase" | "fill" | "polygon" | "lasso";
const TILE = 512;
// Largest number of tiles in each cache.
const CACHE = 300;

interface Tile {
	level: number;
	tx: number;
	ty: number;
	bmp?: ImageBitmap;
	data?: Uint8Array;
	// The tile changed after its data was read.
	stale: boolean;
	// Value of `seq` at the last change, and at the last request.
	changed: number;
	asked: number;
	used: number;
}

// Tiles of one image at levels of detail. `fetch` gives the raw data and the RGBA pixels of one tile.
class TileCache {
	tiles = new Map<string, Tile>();
	private loading = 0;
	private seq = 0;
	constructor(private fetch: (level: number, x: number, y: number) => Promise<{ data: Uint8Array; rgba: Uint8ClampedArray<ArrayBuffer> }>, private redraw: () => void, private error: (e: string) => void) {}

	clear() {
		this.tiles.forEach((t) => t.bmp?.close());
		this.tiles.clear();
	}

	changed(r: Rect) {
		this.seq++;
		for (const t of this.tiles.values()) {
			const s = TILE << t.level;
			if (t.tx * s < r[2] && (t.tx + 1) * s > r[0] && t.ty * s < r[3] && (t.ty + 1) * s > r[1]) {
				t.stale = true;
				t.changed = this.seq;
			}
		}
	}

	// Get a tile. Load it when it is missing or stale, and `load` is true.
	get(level: number, tx: number, ty: number, load = true): Tile {
		const key = `${level}/${tx}/${ty}`;
		let t = this.tiles.get(key);
		if (!t) {
			t = { level, tx, ty, stale: true, changed: 0, asked: -1, used: 0 };
			this.tiles.set(key, t);
		}
		t.used = performance.now();
		if (load && t.stale && t.asked < this.seq && this.loading < 6) {
			const tile = t;
			const asked = this.seq;
			tile.asked = asked;
			this.loading++;
			this.fetch(level, tx * TILE, ty * TILE)
				.then(async ({ data, rgba }) => {
					const bmp = await createImageBitmap(new ImageData(rgba, TILE, TILE));
					tile.bmp?.close();
					tile.bmp = bmp;
					tile.data = data;
					tile.stale = tile.changed > asked;
				})
				.catch((e) => this.error(String(e)))
				.finally(() => {
					this.loading--;
					this.redraw();
				});
		}
		return t;
	}

	evict() {
		if (this.tiles.size <= CACHE) return;
		const old = [...this.tiles.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, this.tiles.size - CACHE);
		for (const [k, t] of old) {
			t.bmp?.close();
			this.tiles.delete(k);
		}
	}
}

interface Stroke {
	cache: TileCache;
	send: (pts: number[][]) => Promise<Rect | null>;
	end: () => Promise<void>;
	// The last point that was sent, and the points that wait.
	last?: number[];
	pending: number[][];
	busy: boolean;
	// The mouse button is up. The stroke ends after the last points.
	done: boolean;
}

export interface MaskCursor {
	x: number;
	y: number;
	// Palette index under the cursor, -1 when it is not known.
	color: number;
}

export class MaskView {
	info?: MaskInfo;
	// Size of the open satellite image.
	sat?: { width: number; height: number };
	// The image that the tools change.
	target: "mask" | "sat" = "mask";
	tool: MaskTool = "brush";
	satTool: SatTool = "color";
	color = 0;
	// Polygon and lasso: restore the imported mask inside the shape (erase) instead of the paint color.
	polyErase = false;
	// Color of the satellite color brush (RGB).
	rgb = [120, 110, 80];
	// Clone source point, and the offset (source minus destination) after the first stroke.
	cloneSrc?: number[];
	cloneOff?: number[];
	// Brush radius in pixels.
	radius = 8;
	hardness = 1;
	opacity = 1;
	// Opacity of the mask over the satellite image.
	overlay = 0.6;
	onCursor?: (c: MaskCursor | null) => void;
	onError?: (e: string) => void;
	// Called after a key or a click changes a setting, so that the UI can show it.
	onKey?: () => void;
	// Goes up with each change of the mask or the satellite image (for the project file). onChange is called after it.
	version = 0;
	onChange?: () => void;
	// Called after each change of an image (paint, fill, undo) with the changed area in pixels. The 3D view updates its drape with it.
	onPainted?: (target: "mask" | "sat", r: Rect) => void;
	// Middle mouse: move the 3D camera to an image point (click, or drag to move it). cameraPose gives the 3D camera in image
	// pixels for the marker (yaw 0 is north, counterclockwise).
	onCamera?: (p: number[]) => void;
	cameraPose?: () => { x: number; y: number; yaw: number } | null;
	private camDrag = false;
	private ctx: CanvasRenderingContext2D;
	// The mask tiles are drawn here with full opacity, then on the view with the overlay opacity. So two levels do not add up.
	private layer = document.createElement("canvas");
	private lctx = this.layer.getContext("2d")!;
	// CSS pixels for each image pixel, and the image pixel at the top-left corner of the view.
	private scale = 1;
	private ox = 0;
	private oy = 0;
	private lut = new Uint32Array(256);
	private maskTiles: TileCache;
	private satTiles: TileCache;
	// Paint jobs run one after the other.
	private queue: Promise<unknown> = Promise.resolve();
	// The open brush stroke. The mouse points wait in `pending` while a paint request runs. Then they go in one request,
	// so that the requests do not wait in a long queue.
	private stroke?: Stroke;
	private poly: number[][] = [];
	private lasso = false;
	private pan?: { x: number; y: number };
	private mouse?: { x: number; y: number };
	private drawQueued = false;

	constructor(private canvas: HTMLCanvasElement) {
		this.ctx = canvas.getContext("2d")!;
		const err = (e: string) => this.onError?.(e);
		this.maskTiles = new TileCache(async (l, x, y) => {
			const data = await maskRegion(l, x, y, TILE, TILE);
			return { data, rgba: this.rgba(data) };
		}, () => this.redraw(), err);
		this.satTiles = new TileCache(async (l, x, y) => {
			const data = await satRegion(l, x, y, TILE, TILE);
			return { data, rgba: new Uint8ClampedArray(data.buffer as ArrayBuffer) };
		}, () => this.redraw(), err);
		new ResizeObserver(() => this.redraw()).observe(canvas);
		canvas.addEventListener("contextmenu", (e) => e.preventDefault());
		// No auto scroll on the middle button: it moves the 3D camera.
		canvas.addEventListener("mousedown", (e) => e.button === 1 && e.preventDefault());
		canvas.addEventListener("pointerdown", (e) => this.down(e));
		canvas.addEventListener("pointermove", (e) => this.move(e));
		canvas.addEventListener("pointerup", (e) => this.up(e));
		canvas.addEventListener("pointerleave", () => {
			this.mouse = undefined;
			this.onCursor?.(null);
			this.redraw();
		});
		canvas.addEventListener("dblclick", () => this.isPolygon() && this.closePolygon());
		canvas.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
		canvas.addEventListener("keydown", (e) => this.key(e));
	}

	setMask(info: MaskInfo) {
		this.info = info;
		// The bytes R, G, B, A in memory order (little-endian). Index 255 (outside) stays transparent.
		this.lut.fill(0);
		info.colors.forEach((c, i) => (this.lut[i] = ((255 << 24) | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0));
		this.maskTiles.clear();
		this.color = 0;
		this.poly = [];
		// The mask is the default paint target.
		this.target = "mask";
		this.fit();
	}

	setSatellite(size: { width: number; height: number }) {
		this.sat = size;
		this.satTiles.clear();
		this.cloneSrc = this.cloneOff = undefined;
		if (!this.info) this.target = "sat";
		this.fit();
	}

	// Size of the images. The mask and the satellite image have the same size.
	size(): { width: number; height: number } | undefined {
		return this.info ?? this.sat;
	}

	// RGBA pixels of palette indices.
	rgba(ids: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
		const out = new Uint8ClampedArray(ids.length * 4);
		const u = new Uint32Array(out.buffer);
		for (let i = 0; i < ids.length; i++) u[i] = this.lut[ids[i]];
		return out;
	}

	fit() {
		const z = this.size();
		if (!z) return;
		const r = this.canvas.getBoundingClientRect();
		this.scale = Math.min(r.width / z.width, r.height / z.height) * 0.95 || 1;
		this.ox = z.width / 2 - r.width / 2 / this.scale;
		this.oy = z.height / 2 - r.height / 2 / this.scale;
		this.redraw();
	}

	// The mask changed outside the view (a shape action): load the tiles of the area again.
	maskChanged(r: Rect) {
		this.maskTiles.changed(r);
		this.version++;
		this.onChange?.();
		this.redraw();
	}

	undo(redo: boolean) {
		if (this.target === "sat") this.job(() => satUndo(redo), this.satTiles);
		else this.job(() => maskUndo(redo), this.maskTiles);
	}

	// Run a paint job after the jobs before it. Show its changed area.
	private job(f: () => Promise<Rect | null | void>, cache: TileCache): Promise<unknown> {
		return (this.queue = this.queue.then(f).then(
			(r) => {
				if (!r) return;
				cache.changed(r);
				this.onPainted?.(cache === this.satTiles ? "sat" : "mask", r);
				this.version++;
				this.onChange?.();
				this.redraw();
			},
			(e) => this.onError?.(String(e)),
		));
	}

	// Send the waiting points of a stroke, or end the stroke when the mouse button is up and all points are sent.
	private flush(s: Stroke) {
		if (s.busy) return;
		if (!s.pending.length) {
			if (s.done) {
				s.done = false;
				this.job(s.end, s.cache).then(() => this.redraw());
			}
			return;
		}
		const pts = s.last ? [s.last, ...s.pending] : s.pending;
		s.last = s.pending[s.pending.length - 1];
		s.pending = [];
		s.busy = true;
		this.job(() => s.send(pts), s.cache).then(() => {
			s.busy = false;
			this.flush(s);
		});
	}

	private top(): number {
		const z = this.size();
		let l = 0;
		while (z && Math.max(z.width, z.height) > TILE << l) l++;
		return l;
	}

	private level(): number {
		return Math.max(0, Math.min(this.top(), Math.floor(Math.log2(1 / this.scale))));
	}

	private toImage(e: { offsetX: number; offsetY: number }): number[] {
		return [this.ox + e.offsetX / this.scale, this.oy + e.offsetY / this.scale];
	}

	redraw() {
		if (this.drawQueued) return;
		this.drawQueued = true;
		requestAnimationFrame(() => {
			this.drawQueued = false;
			this.draw();
		});
	}

	// Draw the tiles of one image that the view shows: the top level first, as the background while finer tiles load.
	private drawTiles(g: CanvasRenderingContext2D, cache: TileCache, z: { width: number; height: number }, w: number, h: number) {
		const top = this.top();
		for (const l of this.level() === top ? [top] : [top, this.level()]) {
			const s = TILE << l;
			const x0 = Math.max(0, Math.floor(this.ox / s));
			const y0 = Math.max(0, Math.floor(this.oy / s));
			const x1 = Math.min(Math.ceil(z.width / s), Math.ceil((this.ox + w / this.scale) / s));
			const y1 = Math.min(Math.ceil(z.height / s), Math.ceil((this.oy + h / this.scale) / s));
			for (let ty = y0; ty < y1; ty++) {
				for (let tx = x0; tx < x1; tx++) {
					// During a stroke, the background level waits: it is slow to make again, and the finer level covers it.
					const t = cache.get(l, tx, ty, !(this.stroke && l === top && top !== this.level()));
					if (t.bmp) g.drawImage(t.bmp, tx * s, ty * s, s, s);
				}
			}
		}
		cache.evict();
	}

	private draw() {
		const c = this.canvas;
		const dpr = window.devicePixelRatio;
		const r = c.getBoundingClientRect();
		if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) {
			c.width = Math.round(r.width * dpr);
			c.height = Math.round(r.height * dpr);
		}
		// The view is hidden (3D view).
		if (!c.width || !c.height) return;
		const g = this.ctx;
		g.setTransform(1, 0, 0, 1, 0, 0);
		g.fillStyle = "#1e2124";
		g.fillRect(0, 0, c.width, c.height);
		const z = this.size();
		if (!z) return;
		const k = dpr * this.scale;
		g.setTransform(k, 0, 0, k, -this.ox * k, -this.oy * k);
		g.fillStyle = "#000";
		g.fillRect(0, 0, z.width, z.height);
		// Zoomed in, the pixels show as squares.
		g.imageSmoothingEnabled = this.scale < 1;
		if (this.sat) this.drawTiles(g, this.satTiles, z, r.width, r.height);
		if (this.info) {
			const m = this.lctx;
			if (this.layer.width !== c.width || this.layer.height !== c.height) [this.layer.width, this.layer.height] = [c.width, c.height];
			m.setTransform(1, 0, 0, 1, 0, 0);
			m.clearRect(0, 0, c.width, c.height);
			m.setTransform(k, 0, 0, k, -this.ox * k, -this.oy * k);
			m.imageSmoothingEnabled = false;
			this.drawTiles(m, this.maskTiles, z, r.width, r.height);
			g.setTransform(1, 0, 0, 1, 0, 0);
			g.globalAlpha = this.overlay;
			g.drawImage(this.layer, 0, 0);
			g.globalAlpha = 1;
		}
		g.setTransform(dpr, 0, 0, dpr, 0, 0);
		const sx = (x: number) => (x - this.ox) * this.scale;
		const sy = (y: number) => (y - this.oy) * this.scale;
		g.strokeStyle = "#fff";
		g.lineWidth = 1;
		if (this.poly.length) {
			g.beginPath();
			this.poly.forEach((p, i) => (i ? g.lineTo(sx(p[0]), sy(p[1])) : g.moveTo(sx(p[0]), sy(p[1]))));
			if (this.mouse && !this.lasso) g.lineTo(this.mouse.x, this.mouse.y);
			g.stroke();
		}
		if (this.mouse && this.isBrush()) {
			g.beginPath();
			g.arc(this.mouse.x, this.mouse.y, Math.max(this.radius * this.scale, 1), 0, Math.PI * 2);
			g.stroke();
		}
		// The 3D camera: a dot with an arrow in the view direction.
		const cam = this.cameraPose?.();
		if (cam) {
			const [x, y, dx, dy] = [sx(cam.x), sy(cam.y), -Math.sin(cam.yaw), -Math.cos(cam.yaw)];
			g.fillStyle = "#ffd040";
			g.strokeStyle = "#000";
			g.beginPath();
			g.moveTo(x + dx * 18, y + dy * 18);
			g.lineTo(x - dy * 7, y + dx * 7);
			g.lineTo(x + dy * 7, y - dx * 7);
			g.closePath();
			g.fill();
			g.stroke();
			g.beginPath();
			g.arc(x, y, 4, 0, Math.PI * 2);
			g.fill();
			g.stroke();
			g.strokeStyle = "#fff";
		}
		// Clone source: a cross at the source point, or at the point that the brush copies from.
		if (this.target === "sat" && this.satTool === "clone") {
			const p = this.cloneOff && this.mouse ? [this.mouse.x + this.cloneOff[0] * this.scale, this.mouse.y + this.cloneOff[1] * this.scale] : this.cloneSrc && [sx(this.cloneSrc[0]), sy(this.cloneSrc[1])];
			if (p) {
				g.beginPath();
				g.moveTo(p[0] - 6, p[1]);
				g.lineTo(p[0] + 6, p[1]);
				g.moveTo(p[0], p[1] - 6);
				g.lineTo(p[0], p[1] + 6);
				g.stroke();
			}
		}
	}

	private isBrush(): boolean {
		return this.target === "sat" || this.tool === "brush" || this.tool === "erase";
	}

	private isPolygon(): boolean {
		return this.target === "mask" && this.tool === "polygon";
	}

	// Palette index at a mask pixel from the finest loaded tile, -1 when no tile has it.
	private colorAt(x: number, y: number): number {
		for (let l = this.level(); l <= this.top(); l++) {
			const s = TILE << l;
			const d = this.maskTiles.tiles.get(`${l}/${Math.floor(x / s)}/${Math.floor(y / s)}`)?.data;
			if (d) {
				const v = d[Math.floor((y % s) / (1 << l)) * TILE + Math.floor((x % s) / (1 << l))];
				return v === 255 ? -1 : v;
			}
		}
		return -1;
	}

	// A new stroke with the settings of now.
	private newStroke(p: number[]): Stroke {
		const b = [this.radius, this.hardness, this.opacity] as const;
		const base = { pending: [p], busy: false, done: false };
		if (this.target === "mask") {
			const [color, seed] = [this.tool === "erase" ? -1 : this.color, (Math.random() * 2 ** 32) >>> 0];
			return { ...base, cache: this.maskTiles, send: (pts) => maskPaint(pts, ...b, color, seed), end: maskEndStroke };
		}
		const [tool, rgb, off] = [this.satTool, [...this.rgb], this.cloneOff ?? [0, 0]];
		return { ...base, cache: this.satTiles, send: (pts) => satPaint(pts, ...b, tool, rgb, off), end: satEndStroke };
	}

	private down(e: PointerEvent) {
		this.canvas.focus();
		const z = this.size();
		if (!z) return;
		this.canvas.setPointerCapture(e.pointerId);
		if (e.button === 1) {
			e.preventDefault();
			this.camDrag = true;
			this.onCamera?.(this.toImage(e));
			this.redraw();
			return;
		}
		if (e.button !== 0) {
			this.pan = { x: e.offsetX, y: e.offsetY };
			return;
		}
		this.begin(this.toImage(e), e);
	}

	// The tools that the 3D view can use: the brushes and the flood fill (not the polygon and the lasso).
	in3d(): boolean {
		return this.isBrush() || (this.target === "mask" && this.tool === "fill");
	}

	// Start the tool at an image point (pixels). The 2D view and the 3D view (paint3d.ts) use it.
	begin(p: number[], e: { ctrlKey: boolean; altKey: boolean }) {
		const z = this.size();
		if (!z) return;
		const inside = p[0] >= 0 && p[1] >= 0 && p[0] < z.width && p[1] < z.height;
		if (this.target === "sat") {
			if (!this.sat) return;
			if (this.satTool === "color" && e.ctrlKey) {
				if (inside)
					satPick(Math.floor(p[0]), Math.floor(p[1])).then((c) => {
						this.rgb = c;
						this.onKey?.();
					}, (err) => this.onError?.(String(err)));
				return;
			}
			if (this.satTool === "clone") {
				if (e.altKey) {
					this.cloneSrc = p;
					this.cloneOff = undefined;
					this.onError?.("");
					this.redraw();
					return;
				}
				if (!this.cloneSrc) {
					this.onError?.("Alt+click to set the clone source first.");
					return;
				}
				// The offset stays for the next strokes (aligned clone), until a new Alt+click.
				this.cloneOff ??= [this.cloneSrc[0] - p[0], this.cloneSrc[1] - p[1]];
			}
		} else if (!this.info) {
			return;
		}
		if (this.isBrush()) {
			this.stroke = this.newStroke(p);
			this.flush(this.stroke);
		} else if (this.tool === "fill") {
			const color = this.color;
			if (inside) this.job(() => maskFill(Math.floor(p[0]), Math.floor(p[1]), color), this.maskTiles);
		} else if (this.tool === "lasso") {
			this.poly = [p];
			this.lasso = true;
		} else {
			this.poly.push(p);
		}
		this.redraw();
	}

	private move(e: PointerEvent) {
		this.mouse = { x: e.offsetX, y: e.offsetY };
		const p = this.toImage(e);
		if (this.size()) this.onCursor?.({ x: Math.floor(p[0]), y: Math.floor(p[1]), color: this.info ? this.colorAt(p[0], p[1]) : -1 });
		// A button release that the view did not get: stop the pan or the stroke.
		if (this.pan && !(e.buttons & 6)) this.pan = undefined;
		if (this.camDrag) {
			if (e.buttons & 4) this.onCamera?.(p);
			else this.camDrag = false;
		}
		if ((this.stroke || this.lasso) && !(e.buttons & 1)) this.up(e);
		if (this.pan) {
			this.ox -= (e.offsetX - this.pan.x) / this.scale;
			this.oy -= (e.offsetY - this.pan.y) / this.scale;
			this.pan = { x: e.offsetX, y: e.offsetY };
		} else if (this.stroke) {
			this.strokeTo(p);
		} else if (this.lasso) {
			const q = this.poly[this.poly.length - 1];
			if (Math.hypot(p[0] - q[0], p[1] - q[1]) * this.scale > 2) this.poly.push(p);
		}
		this.redraw();
	}

	// The next point of the open brush stroke (image pixels).
	strokeTo(p: number[]) {
		if (!this.stroke) return;
		this.stroke.pending.push(p);
		this.flush(this.stroke);
	}

	// End the open brush stroke after its last points.
	endStroke() {
		if (!this.stroke) return;
		this.stroke.done = true;
		this.flush(this.stroke);
		this.stroke = undefined;
	}

	private up(e: PointerEvent) {
		this.pan = undefined;
		this.camDrag = false;
		this.endStroke();
		if (this.lasso) {
			this.lasso = false;
			this.closePolygon();
		}
		this.canvas.releasePointerCapture(e.pointerId);
	}

	private closePolygon() {
		const pts = this.poly;
		this.poly = [];
		const color = this.polyErase ? -1 : this.color;
		if (pts.length >= 3) this.job(() => maskPolygon(pts, color), this.maskTiles);
		this.redraw();
	}

	private wheel(e: WheelEvent) {
		e.preventDefault();
		const z = this.size();
		if (!z) return;
		const [mx, my] = this.toImage(e);
		const max = 32;
		const min = Math.min(this.canvas.clientWidth / z.width, this.canvas.clientHeight / z.height) / 4;
		this.scale = Math.min(max, Math.max(min, this.scale * Math.pow(1.2, -e.deltaY / 100)));
		this.ox = mx - e.offsetX / this.scale;
		this.oy = my - e.offsetY / this.scale;
		this.redraw();
	}

	private key(e: KeyboardEvent) {
		if (e.ctrlKey && (e.code === "KeyZ" || e.code === "KeyY")) {
			e.preventDefault();
			this.undo(e.code === "KeyY");
		} else if (e.code === "BracketLeft" || e.code === "BracketRight") {
			this.radius = Math.max(0.5, Math.min(2000, this.radius * (e.code === "BracketLeft" ? 1 / 1.25 : 1.25)));
		} else if (e.code === "Enter") {
			this.closePolygon();
		} else if (e.code === "Backspace") {
			this.poly.pop();
		} else if (e.code === "Escape") {
			this.poly = [];
		} else {
			return;
		}
		this.redraw();
		this.onKey?.();
	}
}
