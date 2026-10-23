// 3D terrain viewer. Data stays in Arma units: x east, y north, z up. Only this file converts to Three.js:
// Arma x = Three x, Arma z (height) = Three y, Arma y (north) = Three -z.
import * as THREE from "three";
import type { Picture, Terrain } from "./data";
import type { Model, ModelLibrary } from "./models";
import type { ObjectStore } from "./store";
import { DEFAULT_ENV, fogUniforms, groundUniforms, sunAt, withFog, type Environment } from "./env";
import { Post } from "./post";
import { toThree } from "./transform";

// Cells on each side of one terrain chunk at full detail.
const CHUNK = 256;
const box = oneGroupBox();

// A 2 m box with one material group. BoxGeometry has one group for each side, and the objects use one material.
export function oneGroupBox(): THREE.BoxGeometry {
	const b = new THREE.BoxGeometry(2, 2, 2);
	b.clearGroups();
	b.addGroup(0, b.index!.count, 0);
	return b;
}
// The most detailed visual LOD shows to NEAR x r meters (r: the bounding radius of the model), between the limits. After that the
// least detailed LOD shows, up to the draw distance (setDrawDistance), the same for all models.
const NEAR = 15;
const NEAR_LIMITS = [40, 250];
// Objects are sorted into square grid cells of this size (meters). An update checks only the cells near the camera.
const CELL = 250;
// First size of the instance buffers. A buffer doubles when more instances are visible.
const START_CAPACITY = 256;

interface ObjectGroup {
	model: number;
	high: THREE.InstancedMesh;
	low: THREE.InstancedMesh;
	// Object ID of each instance in the last update.
	highIds: number[];
	lowIds: number[];
	// Model offset (see Model.offset).
	offset: number[];
	radius: number;
	near: number;
	// Grid cell key (x + y x 65536) and the object IDs in that cell.
	cells: Map<number, Set<number>>;
}

function cellKey(x: number, y: number): number {
	return Math.floor(x / CELL) + Math.floor(y / CELL) * 65536;
}

function instanced(geometry: THREE.BufferGeometry, materials: THREE.Material[], capacity: number, name: string): THREE.InstancedMesh {
	const mesh = new THREE.InstancedMesh(geometry, materials, capacity);
	// The viewer selects the visible instances itself.
	mesh.frustumCulled = false;
	mesh.castShadow = mesh.receiveShadow = true;
	mesh.count = 0;
	mesh.name = name;
	return mesh;
}

function hue(name: string): number {
	let h = 0;
	for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) | 0;
	return ((h >>> 0) % 360) / 360;
}

export interface Cursor {
	// Local meters from the south-west corner, and the height.
	x: number;
	y: number;
	h: number;
}

type TerrainUniforms = Record<string, THREE.IUniform>;
export type TerrainMaterial = THREE.MeshLambertMaterial & { uniforms: TerrainUniforms };

// The terrain chunks are Lambert materials (sun, shadows, fog), with the height texture in the vertex shader.
const TERRAIN_COMMON = /* glsl */ `
uniform sampler2D uHeight;
uniform ivec2 uSize;
uniform vec2 uOffset;
uniform float uStep;
uniform float uCell;
uniform float uSkirt;
varying vec2 vTUv;
varying vec2 vWorld;
varying float vH;
float hAt(ivec2 c) {
	c = clamp(c, ivec2(0), uSize - 1);
	// The texture row 0 is the north row. c.y counts from the south.
	return texelFetch(uHeight, ivec2(c.x, uSize.y - 1 - c.y), 0).r;
}`;

const TERRAIN_NORMAL = /* glsl */ `
ivec2 tcN = min(ivec2(uOffset + position.xz * uStep), uSize - 1);
vec3 objectNormal = normalize(vec3(hAt(tcN - ivec2(1, 0)) - hAt(tcN + ivec2(1, 0)), 2.0 * uCell, hAt(tcN + ivec2(0, 1)) - hAt(tcN - ivec2(0, 1))));`;

// Skirt vertices (position.y = 1) go down to hide the gaps between chunks of different detail.
const TERRAIN_POSITION = /* glsl */ `
ivec2 tc = min(ivec2(uOffset + position.xz * uStep), uSize - 1);
float th = hAt(tc);
vec2 tm = vec2(tc) * uCell;
vec3 transformed = vec3(tm.x, th - position.y * uSkirt, -tm.y);
vH = th;
vWorld = tm;
vTUv = vec2(tm.x / (float(uSize.x) * uCell), 1.0 - tm.y / (float(uSize.y) * uCell));`;

// Ground detail textures near the camera (Arma shows the layer textures of layers.cfg near the camera and the satellite image far away).
// uIds holds the layer of each mask texel (255: none). The 4 nearest texels blend, so the layer borders are soft.
// The fade distances are viewport settings (default 10 m to 65 m, as in Arma). shortcut: the scale (texture layer size / repeat of the layer RVMAT) is assumed, not checked in the game.
const DETAIL_MAX = 10;
// Mid detail texture (midDetailTexture of the world): one tile is MID_TILE meters, it fades out between the MID_FADE distances.
// shortcut: the tile size and the fade are guesses, not measured in the game. Make them settings if they look wrong.
const MID_TILE = 40;
const MID_FADE = [800, 2000];
const DETAIL_COMMON = /* glsl */ `
uniform float uDetailOn;
uniform sampler2D uIds;
uniform float uDetailScale;
uniform float uDiffuse;
uniform vec2 uDetailFade;
uniform sampler2D uMid;
uniform float uMidOn;
${Array.from({ length: DETAIL_MAX }, (_, i) => `uniform sampler2D uL${i};`).join("\n")}
varying vec2 vWorld;
vec3 layerColor(int id, vec2 uv, vec2 gx, vec2 gy) {
${Array.from({ length: DETAIL_MAX }, (_, i) => `	if (id == ${i}) return textureGrad(uL${i}, uv, gx, gy).rgb;`).join("\n")}
	return vec3(-1.0);
}`;
const DETAIL_COLOR = /* glsl */ `
if (uDetailOn > 0.5 && uMidOn > 0.5) {
	// Mid detail: an overlay on the satellite image, 0.5 grey changes nothing (x 2 in gamma space is x 2^2.2 in linear space).
	float mf = 1.0 - smoothstep(${MID_FADE[0].toFixed(1)}, ${MID_FADE[1].toFixed(1)}, length(vViewPosition));
	base *= mix(vec3(1.0), texture(uMid, vWorld / ${MID_TILE.toFixed(1)}).rgb * 4.595, mf);
}
if (uDetailOn > 0.5) {
	float fade = 1.0 - smoothstep(uDetailFade.x, uDetailFade.y, length(vViewPosition));
	if (fade > 0.0) {
		vec2 uv = vWorld * uDetailScale;
		vec2 gx = dFdx(uv);
		vec2 gy = dFdy(uv);
		vec2 ts = vec2(textureSize(uIds, 0));
		vec2 p = vTUv * ts - 0.5;
		vec2 f = fract(p);
		ivec2 i0 = ivec2(floor(p));
		vec3 dc = vec3(0.0);
		float ws = 0.0;
		for (int k = 0; k < 4; k++) {
			ivec2 o = clamp(i0 + ivec2(k & 1, k >> 1), ivec2(0), ivec2(ts) - 1);
			float w = ((k & 1) == 1 ? f.x : 1.0 - f.x) * ((k >> 1) == 1 ? f.y : 1.0 - f.y);
			vec3 c = layerColor(int(texelFetch(uIds, o, 0).r * 255.0 + 0.5), uv, gx, gy);
			if (c.r >= 0.0) {
				dc += w * c;
				ws += w;
			}
		}
		if (ws > 0.0) base = mix(base, dc / ws * uDiffuse, fade * ws);
	}
}`;
const flatTexture = (data: number[], format: THREE.PixelFormat) => {
	const t = new THREE.DataTexture(new Uint8Array(data), 1, 1, format);
	t.needsUpdate = true;
	return t;
};
const greyLayer = flatTexture([128, 128, 128, 255], THREE.RGBAFormat);
// Shared by all terrain chunks. Viewer.setDetail and setDetailIds fill them.
const detailUniforms: Record<string, THREE.IUniform> = {
	uDetailOn: { value: 0 },
	uIds: { value: flatTexture([255], THREE.RedFormat) },
	uDetailScale: { value: 5 / 64 },
	uDiffuse: { value: 1 },
	uDetailFade: { value: new THREE.Vector2(10, 65) },
	uMid: { value: greyLayer },
	uMidOn: { value: 0 },
	...Object.fromEntries(Array.from({ length: DETAIL_MAX }, (_, i) => [`uL${i}`, { value: greyLayer }])),
};

const TERRAIN_COLOR = /* glsl */ `
float tt = clamp((vH - uRange.x) / max(uRange.y - uRange.x, 1.0), 0.0, 1.0);
vec3 base = uHasSat ? texture(uSat, vTUv).rgb : mix(vec3(0.09, 0.15, 0.05), vec3(0.52, 0.45, 0.33), tt);
${DETAIL_COLOR}
if (uMaskAlpha > 0.0) {
	vec4 mk = texture(uMask, vTUv);
	base = mix(base, mk.rgb, mk.a * uMaskAlpha);
}
diffuseColor.rgb = base;`;

function terrainMaterial(u: TerrainUniforms): TerrainMaterial {
	const m = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide }) as TerrainMaterial;
	m.uniforms = u;
	m.onBeforeCompile = (sh) => {
		Object.assign(sh.uniforms, u, detailUniforms);
		sh.vertexShader = sh.vertexShader.replace("#include <common>", `#include <common>${TERRAIN_COMMON}`).replace("#include <beginnormal_vertex>", TERRAIN_NORMAL).replace("#include <begin_vertex>", TERRAIN_POSITION);
		sh.fragmentShader = sh.fragmentShader
			.replace("#include <common>", `#include <common>\nuniform sampler2D uSat;\nuniform bool uHasSat;\nuniform sampler2D uMask;\nuniform float uMaskAlpha;\nuniform vec2 uRange;\nvarying vec2 vTUv;\nvarying float vH;${DETAIL_COMMON}`)
			.replace("#include <map_fragment>", TERRAIN_COLOR);
	};
	m.customProgramCacheKey = () => "terrain";
	return withFog(m);
}

// The depth material of a chunk for the shadow map: the same vertex positions.
function terrainDepth(u: TerrainUniforms): THREE.MeshDepthMaterial {
	const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
	m.onBeforeCompile = (sh) => {
		Object.assign(sh.uniforms, u);
		sh.vertexShader = sh.vertexShader.replace("#include <common>", `#include <common>${TERRAIN_COMMON}`).replace("#include <begin_vertex>", TERRAIN_POSITION);
	};
	m.customProgramCacheKey = () => "terrain-depth";
	return m;
}

// One grid geometry for each detail level. Step s uses every s-th cell. The border ring has skirt copies.
function chunkGeometry(cells: number): THREE.BufferGeometry {
	const k = cells + 1;
	const pos: number[] = [];
	const idx: number[] = [];
	for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) pos.push(i, 0, j);
	for (let j = 0; j < cells; j++) {
		for (let i = 0; i < cells; i++) {
			const a = j * k + i;
			// Counterclockwise from above (the shader flips z), so the front faces point up. The diagonal goes from (i + 1, j) to (i, j + 1).
			idx.push(a, a + 1, a + k, a + 1, a + k + 1, a + k);
		}
	}
	const ring: number[] = [];
	for (let i = 0; i < cells; i++) ring.push(i);
	for (let j = 0; j < cells; j++) ring.push(j * k + cells);
	for (let i = cells; i > 0; i--) ring.push(cells * k + i);
	for (let j = cells; j > 0; j--) ring.push(j * k);
	const base = pos.length / 3;
	for (const r of ring) pos.push(pos[r * 3], 1, pos[r * 3 + 2]);
	for (let n = 0; n < ring.length; n++) {
		const a = ring[n];
		const b = ring[(n + 1) % ring.length];
		const sa = base + n;
		const sb = base + ((n + 1) % ring.length);
		idx.push(a, sa, b, b, sa, sb);
	}
	const g = new THREE.BufferGeometry();
	g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
	// The shader makes the normals from the heights. Without a normal attribute, Three.js uses flat shading (one normal for each triangle).
	g.setAttribute("normal", new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3));
	g.setIndex(idx);
	return g;
}

interface Chunk {
	mesh: THREE.Mesh<THREE.BufferGeometry, TerrainMaterial>;
	box: THREE.Box3;
}

export class Viewer {
	readonly renderer: THREE.WebGLRenderer;
	readonly scene = new THREE.Scene();
	// The sun (or the moon at night) with the shadow map, and the sky light.
	private sun = new THREE.DirectionalLight();
	private hemi = new THREE.HemisphereLight();
	env: Environment = DEFAULT_ENV;
	private post!: Post;
	readonly camera = new THREE.PerspectiveCamera(60, 1, 1, 50000);
	// Top-down orthographic view (Viewport tab). It looks down on the point below the perspective camera, with the same heading.
	// Its half height in meters is the zoom. W A S D and the right mouse pan, the wheel zooms.
	ortho = false;
	readonly orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 100000);
	private orthoHalf = 500;
	private topHeight = 1000;
	// The camera that draws: the perspective or the orthographic camera.
	get view(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
		return this.ortho ? this.orthoCam : this.camera;
	}
	terrain?: Terrain;
	onCursor?: (c: Cursor | null) => void;
	// Ground point below the mouse in the last frame.
	lastCursor: Cursor | null = null;
	onStats?: (fps: number, triangles: number, objectsDrawn: number) => void;
	private chunks: Chunk[] = [];
	private lods: THREE.BufferGeometry[] = [];
	private heightTex?: THREE.DataTexture;
	private satTex?: THREE.DataTexture;
	private maskTex?: THREE.DataTexture;
	private maskAlpha = 0;
	private preview?: THREE.Points;
	private objects = new THREE.Group();
	// Sea at 0 m (Arma 3 sea level). A square of 5 map sizes around the map, transparent so that the ground below shows.
	private sea = new THREE.Mesh(
		new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
		// It writes depth: the ambient occlusion then sees the flat water, not the ground below it (that made the water flicker).
		withFog(new THREE.MeshLambertMaterial({ color: 0x1f5a85, transparent: true, opacity: 0.55 })),
	);
	private store?: ObjectStore;
	private lib?: ModelLibrary;
	private groups = new Map<number, ObjectGroup>();
	// Grid cell of each object ID, -1 when the object is in no cell.
	private cellOf = new Int32Array(0);
	// Selected objects, with a wire box around each.
	readonly selection = new Set<number>();
	private selectionBoxes?: THREE.InstancedMesh;
	// Models that did not load (red boxes).
	failed: Model[] = [];
	private lastView = new THREE.Matrix4();
	// Number of objects in the last update, for the status bar.
	objectsDrawn = 0;
	// True while the 2D mask view covers the 3D view. The view does not render.
	paused = false;
	// Called after each frame (the height brush moves its ring).
	onFrame?: () => void;
	// Called after updateHeights (the roads go on the new heights).
	onHeights?: () => void;
	// Multiplier of the far draw distance of the objects (the setting "Draw distance").
	// Draw distance in meters: all objects show up to it, none after it (a hard cut, the user's choice).
	private drawDist = 2500;
	private keys = new Set<string>();
	private yaw = 0;
	private pitch = -0.5;
	private speed = 50;
	private mouse?: THREE.Vector2;
	private last = performance.now();
	private frames = 0;
	private fpsTime = performance.now();
	private frustum = new THREE.Frustum();

	constructor(private canvas: HTMLCanvasElement) {
		this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
		this.renderer.setPixelRatio(window.devicePixelRatio);
		this.renderer.shadowMap.enabled = true;
		this.renderer.shadowMap.type = THREE.PCFShadowMap;
		this.scene.background = new THREE.Color();
		this.sun.castShadow = true;
		this.sun.shadow.mapSize.set(4096, 4096);
		this.scene.add(this.sun, this.sun.target, this.hemi);
		this.post = new Post(this.renderer, this.scene, this.camera);
		this.renderer.info.autoReset = false;
		this.setEnvironment(DEFAULT_ENV);
		this.bindInput();
		new ResizeObserver(() => this.resize()).observe(canvas);
		this.resize();
		this.renderer.setAnimationLoop(() => this.frame());
	}

	// Time of day, shadows, and fog. See env.ts.
	setEnvironment(e: Environment) {
		this.env = e;
		const s = sunAt(e.hour);
		this.sun.color.copy(s.color);
		// Sunlight x 1 is as bright as x 6 was before 23 Oct 2026 (the user asked for x 3, then for twice that).
		const k = e.sun * 6;
		this.sun.intensity = s.intensity * k;
		this.sun.castShadow = e.shadows;
		this.hemi.color.copy(s.sky);
		this.hemi.groundColor.copy(s.ground);
		this.hemi.intensity = s.ambient * (1 + (k - 1) / 2);
		this.sunDir.copy(s.dir);
		this.sea.visible = e.sea;
		detailUniforms.uDetailOn.value = this.detailReady && e.detail ? 1 : 0;
		(detailUniforms.uDetailFade.value as THREE.Vector2).set(Math.max(0, e.detailStart), Math.max(e.detailStart + 1, e.detailEnd));
		(this.scene.background as THREE.Color).copy(s.sky);
		fogUniforms.uFogColor.value.copy(s.sky);
		fogUniforms.uFogK.value = (Math.max(0, e.fogDensity) / 100) * 0.05;
		fogUniforms.uFogBase.value = e.fogBase;
		fogUniforms.uFogDecay.value = Math.max(0, e.fogDecay) / 100;
		this.redraw();
	}
	private sunDir = new THREE.Vector3(0, 1, 0);

	// The shadow map covers a square around the point that the camera looks at. Its size grows with the camera height.
	private updateSun() {
		const c = this.camera.position;
		const fwd = new THREE.Vector3();
		this.camera.getWorldDirection(fwd);
		const ground = this.heightAt(c.x, -c.z) ?? 0;
		const r = this.ortho ? THREE.MathUtils.clamp(this.orthoHalf * 1.5, 150, 4000) : THREE.MathUtils.clamp((c.y - ground) * 3, 150, 1500);
		const focus = this.ortho ? new THREE.Vector3(c.x, ground, c.z) : c.clone().addScaledVector(fwd.setY(0).normalize(), r * 0.6);
		this.sun.target.position.copy(focus);
		this.sun.position.copy(focus).addScaledVector(this.sunDir, 4000);
		const cam = this.sun.shadow.camera;
		[cam.left, cam.right, cam.top, cam.bottom, cam.near, cam.far] = [-r, r, r, -r, 100, 8000];
		cam.updateProjectionMatrix();
		// The normal offset grows with the size of one shadow map texel (a fixed 0.6 m was too much near the camera).
		const texel = (2 * r) / this.sun.shadow.mapSize.x;
		this.sun.shadow.normalBias = texel * 1.5;
		// The depth bias is a part of the depth range (100 to 8000 m). The fixed -0.0004 was more than 3 m, so the shadows moved away from their objects.
		this.sun.shadow.bias = -(texel * 0.5) / (cam.far - cam.near);
	}

	setTerrain(t: Terrain) {
		this.terrain = t;
		for (const c of this.chunks) this.scene.remove(c.mesh);
		this.lods.forEach((g) => g.dispose());
		this.heightTex?.dispose();
		const chunk = Math.min(CHUNK, t.ncols - 1, t.nrows - 1);
		this.lods = [];
		for (let s = 1; chunk / s >= 4; s *= 2) this.lods.push(chunkGeometry(chunk / s));
		this.heightTex = new THREE.DataTexture(t.heights, t.ncols, t.nrows, THREE.RedFormat, THREE.FloatType);
		this.heightTex.needsUpdate = true;
		groundUniforms.uGHeight.value = this.heightTex;
		groundUniforms.uGSize.value.set(t.ncols, t.nrows);
		groundUniforms.uGCell.value = t.cell;
		let lo = Infinity;
		let hi = -Infinity;
		for (const h of t.heights) {
			if (h < lo) lo = h;
			if (h > hi) hi = h;
		}
		this.chunks = [];
		for (let cy = 0; cy < t.nrows - 1; cy += chunk) {
			for (let cx = 0; cx < t.ncols - 1; cx += chunk) {
				let clo = Infinity;
				let chi = -Infinity;
				for (let y = cy; y <= Math.min(cy + chunk, t.nrows - 1); y++) {
					const row = (t.nrows - 1 - y) * t.ncols;
					for (let x = cx; x <= Math.min(cx + chunk, t.ncols - 1); x++) {
						const h = t.heights[row + x];
						if (h < clo) clo = h;
						if (h > chi) chi = h;
					}
				}
				const u: TerrainUniforms = {
						uHeight: { value: this.heightTex },
						uSize: { value: new THREE.Vector2(t.ncols, t.nrows) },
						uOffset: { value: new THREE.Vector2(cx, cy) },
						uStep: { value: 1 },
						uCell: { value: t.cell },
						uSkirt: { value: 0 },
						uSat: { value: this.satTex ?? null },
						uHasSat: { value: !!this.satTex },
						uMask: { value: this.maskTex ?? null },
						uMaskAlpha: { value: this.maskTex ? this.maskAlpha : 0 },
						uRange: { value: new THREE.Vector2(lo, hi) },
				};
				const mesh = new THREE.Mesh(this.lods[0], terrainMaterial(u));
				mesh.customDepthMaterial = terrainDepth(u);
				mesh.castShadow = mesh.receiveShadow = true;
				// The shader moves the vertices, so the chunk uses its own box for culling.
				mesh.frustumCulled = false;
				const x0 = cx * t.cell;
				const x1 = Math.min(cx + chunk, t.ncols - 1) * t.cell;
				const y0 = cy * t.cell;
				const y1 = Math.min(cy + chunk, t.nrows - 1) * t.cell;
				const box = new THREE.Box3(new THREE.Vector3(x0, clo - 50, -y1), new THREE.Vector3(x1, chi + 1, -y0));
				this.scene.add(mesh);
				this.chunks.push({ mesh, box });
			}
		}
		const size = t.ncols * t.cell;
		this.topHeight = hi + 1000;
		this.sea.scale.set(size * 5, 1, size * 5);
		this.sea.position.set(size / 2, 0, -(t.nrows * t.cell) / 2);
		if (!this.sea.parent) this.scene.add(this.sea);
		this.camera.far = size * 3;
		this.camera.updateProjectionMatrix();
		this.speed = Math.max(20, size / 40);
		this.resetCamera();
	}

	// Show the whole map: the camera south of the map center, looking north and down. The top-down view shows the whole map.
	resetCamera() {
		const t = this.terrain;
		if (!t) return;
		const size = t.ncols * t.cell;
		this.camera.position.set(size / 2, this.topHeight - 1000 + size * 0.25, -size * 0.05);
		this.yaw = 0;
		this.pitch = -0.6;
		this.vel.set(0, 0, 0);
		this.look.set(0, 0);
		this.orthoHalf = (t.nrows * t.cell) / 2 / 0.95;
		if (this.ortho) this.camera.position.z = -(t.nrows * t.cell) / 2;
		this.orthoProjection();
	}

	// New heights for a rectangle of cells (x0, y0, x1, y1, row 0 is the north row). v has the values row by row.
	// Only the changed rows of the height texture go to the GPU. The chunk bounds for culling are made again.
	updateHeights(r: number[], v: Float32Array) {
		const t = this.terrain;
		const tex = this.heightTex;
		if (!t || !tex) return;
		const w = r[2] - r[0];
		for (let row = r[1]; row < r[3]; row++) {
			t.heights.set(v.subarray((row - r[1]) * w, (row - r[1] + 1) * w), row * t.ncols + r[0]);
			// Three.js counts the update ranges in RGBA components (4 for each texel). The texture has 1, so the values are times 4.
			tex.addUpdateRange((row * t.ncols + r[0]) * 4, w * 4);
		}
		tex.needsUpdate = true;
		// Chunk columns and rows from the south-west corner, as in setTerrain.
		const [c0, c1, s0, s1] = [r[0], r[2] - 1, t.nrows - r[3], t.nrows - 1 - r[1]];
		for (const c of this.chunks) {
			const [x0, x1] = [Math.round(c.box.min.x / t.cell), Math.round(c.box.max.x / t.cell)];
			const [y0, y1] = [Math.round(-c.box.max.z / t.cell), Math.round(-c.box.min.z / t.cell)];
			if (x1 < c0 || x0 > c1 || y1 < s0 || y0 > s1) continue;
			let lo = Infinity;
			let hi = -Infinity;
			for (let y = y0; y <= y1; y++) {
				const row = (t.nrows - 1 - y) * t.ncols;
				for (let x = x0; x <= x1; x++) {
					const h = t.heights[row + x];
					if (h < lo) lo = h;
					if (h > hi) hi = h;
				}
			}
			c.box.min.y = lo - 50;
			c.box.max.y = hi + 1;
		}
		this.onHeights?.();
	}

	// Move the camera to look at a point from the current direction. r: the radius to show in meters.
	focus(x: number, y: number, h: number, r: number) {
		this.pitch = -0.7;
		const fwd = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
		this.camera.position.set(x, h, -y).addScaledVector(fwd, -Math.max(30, r * 2.5));
		this.camera.lookAt(x, h, -y);
		this.redraw();
	}

	setSatellite(p: Picture) {
		this.satTex?.dispose();
		this.satTex = new THREE.DataTexture(p.rgba, p.width, p.height, THREE.RGBAFormat);
		this.satTex.colorSpace = THREE.SRGBColorSpace;
		this.satTex.magFilter = THREE.LinearFilter;
		this.satTex.minFilter = THREE.LinearMipmapLinearFilter;
		this.satTex.generateMipmaps = true;
		this.satTex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
		this.satTex.needsUpdate = true;
		for (const c of this.chunks) {
			c.mesh.material.uniforms.uSat.value = this.satTex;
			c.mesh.material.uniforms.uHasSat.value = true;
		}
	}

	// Change a part of the satellite or mask drape (pixels of the drape texture, RGBA rows). Only these rows go to the GPU again.
	patchDrape(which: "sat" | "mask", x: number, y: number, w: number, h: number, rgba: Uint8Array) {
		const tex = which === "sat" ? this.satTex : this.maskTex;
		if (!tex) return;
		const W = tex.image.width;
		const data = tex.image.data as Uint8Array;
		for (let r = 0; r < h; r++) {
			data.set(rgba.subarray(r * w * 4, (r + 1) * w * 4), ((y + r) * W + x) * 4);
			tex.addUpdateRange(((y + r) * W + x) * 4, w * 4);
		}
		tex.needsUpdate = true;
		this.redraw();
	}

	// Fill preview: one point for each object on the ground. Null removes it. xy has x and y (local meters) for each point.
	setPreview(xy: ArrayLike<number> | null, stride = 2) {
		if (this.preview) {
			this.scene.remove(this.preview);
			this.preview.geometry.dispose();
			this.preview = undefined;
		}
		if (!xy) return;
		const n = Math.floor(xy.length / stride);
		const pos = new Float32Array(n * 3);
		for (let i = 0; i < n; i++) {
			const [x, y] = [xy[i * stride], xy[i * stride + 1]];
			pos.set([x, (this.heightAt(x, y) ?? 0) + 0.5, -y], i * 3);
		}
		const g = new THREE.BufferGeometry();
		g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
		this.preview = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffe040, size: 3, sizeAttenuation: false }));
		this.preview.frustumCulled = false;
		this.scene.add(this.preview);
	}

	// Ground detail: the _co texture of each layer (null: none), the scale (texture repeats for each meter), and the diffuse value.
	// Null turns the detail off.
	setDetail(d: { textures: (THREE.Texture | null)[]; scale: number; diffuse: number; mid: THREE.Texture | null } | null) {
		for (let i = 0; i < DETAIL_MAX; i++) detailUniforms[`uL${i}`].value = d?.textures[i] ?? greyLayer;
		detailUniforms.uMid.value = d?.mid ?? greyLayer;
		detailUniforms.uMidOn.value = d?.mid ? 1 : 0;
		this.detailReady = !!d;
		if (d) {
			detailUniforms.uDetailScale.value = d.scale;
			detailUniforms.uDiffuse.value = d.diffuse;
		}
		detailUniforms.uDetailOn.value = this.detailReady && this.env.detail ? 1 : 0;
	}
	private detailReady = false;

	// Layer of each mask texel for the ground detail (255: none), w x h, row 0 is the north row. With x and y: a part of the texture.
	setDetailIds(w: number, h: number, ids: Uint8Array, x?: number, y?: number) {
		let tex = detailUniforms.uIds.value as THREE.DataTexture;
		if (x === undefined || y === undefined) {
			tex.dispose();
			tex = new THREE.DataTexture(ids, w, h, THREE.RedFormat);
			// One byte for each texel: rows are not padded to 4 bytes.
			tex.unpackAlignment = 1;
			detailUniforms.uIds.value = tex;
		} else {
			const W = tex.image.width;
			const data = tex.image.data as Uint8Array;
			for (let r = 0; r < h; r++) {
				data.set(ids.subarray(r * w, (r + 1) * w), (y + r) * W + x);
				// Three.js counts the update ranges in RGBA components; the texture has 1.
				tex.addUpdateRange(((y + r) * W + x) * 4, w * 4);
			}
		}
		tex.needsUpdate = true;
		this.redraw();
	}

	// Show the layer mask over the terrain with an opacity from 0 to 1. Null removes it. The mask covers the terrain like the satellite image.
	setMaskOverlay(p: Picture | null, alpha: number) {
		this.maskTex?.dispose();
		this.maskTex = undefined;
		if (p) {
			this.maskTex = new THREE.DataTexture(p.rgba, p.width, p.height, THREE.RGBAFormat);
			this.maskTex.colorSpace = THREE.SRGBColorSpace;
			this.maskTex.magFilter = THREE.NearestFilter;
			this.maskTex.minFilter = THREE.NearestFilter;
			this.maskTex.needsUpdate = true;
		}
		this.maskAlpha = alpha;
		for (const c of this.chunks) {
			c.mesh.material.uniforms.uMask.value = this.maskTex ?? null;
			c.mesh.material.uniforms.uMaskAlpha.value = this.maskTex ? alpha : 0;
		}
	}

	// Show the objects of a store. With a model library, each model shows with its mesh and textures. Without a library,
	// or when a model does not load, each object is a 2 m box (red when it did not load). Models without a visual LOD show nothing.
	// Each model has two instanced meshes: the most detailed visual LOD near the camera, and the least detailed one further away.
	async setStore(store: ObjectStore, lib?: ModelLibrary) {
		for (const g of this.groups.values()) {
			g.high.dispose();
			g.low.dispose();
		}
		this.groups.clear();
		this.objects.clear();
		this.scene.add(this.objects);
		this.store = store;
		this.lib = lib;
		this.failed = [];
		this.cellOf = new Int32Array(0);
		this.selection.clear();
		await this.refresh([...store.ids()]);
	}

	// Update the grid cells after objects are added, moved, or removed. Makes the instanced meshes for new models.
	async refresh(ids: number[]) {
		const st = this.store;
		if (!st) return;
		if (this.cellOf.length < st.size) {
			const c = new Int32Array(Math.max(st.size, this.cellOf.length * 2)).fill(-1);
			c.set(this.cellOf);
			this.cellOf = c;
		}
		const models = new Set<number>();
		for (const id of ids) if (st.alive(id) && !this.groups.has(st.model[id])) models.add(st.model[id]);
		await Promise.all([...models].map((m) => this.makeGroup(m)));
		for (const id of ids) {
			const old = this.cellOf[id];
			if (old !== -1) {
				for (const g of this.groups.values()) g.cells.get(old)?.delete(id);
				this.cellOf[id] = -1;
			}
			if (!st.alive(id)) {
				this.selection.delete(id);
				continue;
			}
			const g = this.groups.get(st.model[id]);
			if (!g) continue;
			const key = cellKey(st.t[id * 12 + 9], st.t[id * 12 + 11]);
			let set = g.cells.get(key);
			if (!set) g.cells.set(key, (set = new Set()));
			set.add(id);
			this.cellOf[id] = key;
		}
		this.redraw();
	}

	private async makeGroup(model: number) {
		const name = this.store!.models[model];
		let high: { geometry: THREE.BufferGeometry; materials: THREE.Material[] } = { geometry: box, materials: [withFog(new THREE.MeshLambertMaterial({ color: new THREE.Color().setHSL(hue(name), 0.7, 0.5) }))] };
		let low = high;
		let offset = [0, 0, 0];
		if (this.lib) {
			const [h, l] = await Promise.all([this.lib.model(name), this.lib.model(name, true)]);
			if (h.error) this.failed.push(h);
			high = h;
			offset = h.offset;
			low = l.error ? h : l;
		}
		if (this.groups.has(model)) return;
		high.geometry.computeBoundingSphere();
		const s = high.geometry.boundingSphere;
		const radius = Math.max(0.5, s && s.radius > 0 ? s.center.length() + s.radius : 1);
		const make = (x: typeof high) => {
			const mesh = instanced(x.geometry, x.materials, START_CAPACITY, name);
			this.objects.add(mesh);
			return mesh;
		};
		const clamp = (v: number, l: number[]) => Math.min(l[1], Math.max(l[0], v));
		this.groups.set(model, { model, offset, high: make(high), low: make(low), highIds: [], lowIds: [], radius, near: clamp(radius * NEAR, NEAR_LIMITS), cells: new Map() });
	}

	// Draw the objects again in the next frame (after a change of objects, layers, or the selection).
	redraw() {
		this.lastView.identity();
	}

	modelOffset(model: number): number[] {
		return this.groups.get(model)?.offset ?? [0, 0, 0];
	}

	setDrawDistance(m: number) {
		this.drawDist = m;
		this.redraw();
	}

	// Bounding box of a model in its centered model space (Three.js axes).
	modelBox(model: number): THREE.Box3 {
		const g = this.groups.get(model)?.high.geometry ?? box;
		if (!g.boundingBox) g.computeBoundingBox();
		return g.boundingBox && !g.boundingBox.isEmpty() ? g.boundingBox : new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
	}

	// Put the objects in view into the instanced meshes. This runs again only when the camera or the objects change.
	// Only the grid cells within the draw distance of each model are checked, and only the used part of each buffer goes to the GPU.
	private updateObjects() {
		const st = this.store;
		if (!st || !this.objects.visible || this.view.matrixWorld.equals(this.lastView)) return;
		this.lastView.copy(this.view.matrixWorld);
		const c = this.view.position;
		const sphere = new THREE.Sphere();
		const cellBox = new THREE.Box3();
		const hidden = st.layers.map((l) => !l.visible);
		let drawn = 0;
		for (const g of this.groups.values()) {
			g.highIds.length = 0;
			g.lowIds.length = 0;
			const far = this.drawDist;
			const near = Math.min(g.near, far);
			const x0 = Math.floor((c.x - far) / CELL);
			const x1 = Math.floor((c.x + far) / CELL);
			const y0 = Math.floor((-c.z - far) / CELL);
			const y1 = Math.floor((-c.z + far) / CELL);
			for (let cy = y0; cy <= y1; cy++) {
				for (let cx = x0; cx <= x1; cx++) {
					const set = g.cells.get(cx + cy * 65536);
					if (!set?.size) continue;
					// The cell box is high, because the cells have no height range.
					cellBox.min.set(cx * CELL - g.radius, -2000, -(cy + 1) * CELL - g.radius);
					cellBox.max.set((cx + 1) * CELL + g.radius, 10000, -cy * CELL + g.radius);
					if (cellBox.distanceToPoint(c) > far || !this.frustum.intersectsBox(cellBox)) continue;
					for (const id of set) {
						if (hidden[st.layer[id]]) continue;
						const i = id * 12;
						sphere.center.set(st.t[i + 9], st.t[i + 10], -st.t[i + 11]);
						const d2 = sphere.center.distanceToSquared(c);
						if (d2 > far * far) continue;
						sphere.radius = g.radius;
						if (!this.frustum.intersectsSphere(sphere)) continue;
						const high = d2 < near * near;
						const ids = high ? g.highIds : g.lowIds;
						let mesh = high ? g.high : g.low;
						if (ids.length === mesh.instanceMatrix.count) {
							mesh = this.grow(mesh);
							if (high) g.high = mesh;
							else g.low = mesh;
						}
						toThree(st.t, i, mesh.instanceMatrix.array as Float32Array, ids.length * 16);
						ids.push(id);
					}
				}
			}
			for (const [mesh, count] of [[g.high, g.highIds.length], [g.low, g.lowIds.length]] as const) {
				mesh.count = count;
				const a = mesh.instanceMatrix;
				a.clearUpdateRanges();
				a.addUpdateRange(0, count * 16);
				a.needsUpdate = true;
			}
			drawn += g.highIds.length + g.lowIds.length;
		}
		this.objectsDrawn = drawn;
		this.updateSelectionBoxes();
	}

	// A wire box around each selected object.
	private updateSelectionBoxes() {
		const st = this.store!;
		const ids = [...this.selection].filter((id) => st.alive(id));
		if (!this.selectionBoxes || this.selectionBoxes.instanceMatrix.count < ids.length) {
			if (this.selectionBoxes) {
				this.scene.remove(this.selectionBoxes);
				this.selectionBoxes.dispose();
			}
			const cap = Math.max(64, ids.length * 2);
			this.selectionBoxes = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffd400, wireframe: true }), cap);
			this.selectionBoxes.frustumCulled = false;
			this.scene.add(this.selectionBoxes);
		}
		const m = new THREE.Matrix4();
		const b = new THREE.Matrix4();
		const size = new THREE.Vector3();
		const center = new THREE.Vector3();
		ids.forEach((id, n) => {
			const bb = this.modelBox(st.model[id]);
			bb.getSize(size);
			bb.getCenter(center);
			toThree(st.t, id * 12, m.elements, 0);
			b.makeScale(size.x * 1.02 + 0.05, size.y * 1.02 + 0.05, size.z * 1.02 + 0.05).setPosition(center);
			this.selectionBoxes!.setMatrixAt(n, m.multiply(b));
		});
		this.selectionBoxes.count = ids.length;
		this.selectionBoxes.instanceMatrix.needsUpdate = true;
	}

	// The object under a screen position (-1 to 1), from the instances in the last update. Null when there is none.
	objectAt(ndc: THREE.Vector2): number | null {
		const ray = new THREE.Raycaster();
		ray.setFromCamera(ndc, this.view);
		const meshes: THREE.Object3D[] = [];
		for (const g of this.groups.values()) meshes.push(g.high, g.low);
		// The raycast uses the bounding sphere of all instances. The instances change, so compute it again.
		for (const m of meshes as THREE.InstancedMesh[]) m.boundingSphere = null;
		for (const hit of ray.intersectObjects(meshes, false)) {
			const g = [...this.groups.values()].find((x) => x.high === hit.object || x.low === hit.object);
			const id = g && hit.instanceId !== undefined ? (hit.object === g.high ? g.highIds : g.lowIds)[hit.instanceId] : undefined;
			if (id !== undefined) return id;
		}
		return null;
	}

	// The objects in the last update whose position is inside a screen rectangle (-1 to 1).
	objectsIn(a: THREE.Vector2, b: THREE.Vector2): number[] {
		const st = this.store;
		if (!st) return [];
		const [x0, x1, y0, y1] = [Math.min(a.x, b.x), Math.max(a.x, b.x), Math.min(a.y, b.y), Math.max(a.y, b.y)];
		const v = new THREE.Vector3();
		const out: number[] = [];
		for (const g of this.groups.values()) {
			for (const id of [...g.highIds, ...g.lowIds]) {
				v.set(st.t[id * 12 + 9], st.t[id * 12 + 10], -st.t[id * 12 + 11]).project(this.view);
				if (v.z < 1 && v.x >= x0 && v.x <= x1 && v.y >= y0 && v.y <= y1) out.push(id);
			}
		}
		return out;
	}

	// Replace an instanced mesh with one of double capacity. The visible instances are copied.
	private grow(mesh: THREE.InstancedMesh): THREE.InstancedMesh {
		const next = instanced(mesh.geometry, mesh.material as THREE.Material[], mesh.instanceMatrix.count * 2, mesh.name);
		(next.instanceMatrix.array as Float32Array).set(mesh.instanceMatrix.array);
		this.objects.remove(mesh);
		this.objects.add(next);
		mesh.dispose();
		return next;
	}

	set objectsVisible(v: boolean) {
		this.objects.visible = v;
		this.lastView.identity();
	}

	// Height with bilinear interpolation at local meters (x east, y north). Null outside the terrain.
	// The height on the drawn terrain mesh (detail level 0): the triangles of chunkGeometry (diagonal from (i + 1, j) to (i, j + 1)), not
	// bilinear. Bands on the terrain (roads) use it, so that they do not go into the mesh.
	meshHeightAt(x: number, y: number): number | null {
		const t = this.terrain;
		if (!t) return null;
		const fx = x / t.cell;
		const fy = y / t.cell;
		if (fx < 0 || fy < 0 || fx > t.ncols - 1 || fy > t.nrows - 1) return null;
		const x0 = Math.min(Math.floor(fx), t.ncols - 2);
		const y0 = Math.min(Math.floor(fy), t.nrows - 2);
		const ax = fx - x0;
		const ay = fy - y0;
		const h = (c: number, r: number) => t.heights[(t.nrows - 1 - r) * t.ncols + c];
		const [h00, h10, h01, h11] = [h(x0, y0), h(x0 + 1, y0), h(x0, y0 + 1), h(x0 + 1, y0 + 1)];
		return ax + ay <= 1 ? h00 + ax * (h10 - h00) + ay * (h01 - h00) : h11 + (1 - ax) * (h01 - h11) + (1 - ay) * (h10 - h11);
	}

	heightAt(x: number, y: number): number | null {
		const t = this.terrain;
		if (!t) return null;
		const fx = x / t.cell;
		const fy = y / t.cell;
		if (fx < 0 || fy < 0 || fx > t.ncols - 1 || fy > t.nrows - 1) return null;
		const x0 = Math.min(Math.floor(fx), t.ncols - 2);
		const y0 = Math.min(Math.floor(fy), t.nrows - 2);
		const ax = fx - x0;
		const ay = fy - y0;
		const h = (c: number, r: number) => t.heights[(t.nrows - 1 - r) * t.ncols + c];
		return (h(x0, y0) * (1 - ax) + h(x0 + 1, y0) * ax) * (1 - ay) + (h(x0, y0 + 1) * (1 - ax) + h(x0 + 1, y0 + 1) * ax) * ay;
	}

	// Find the ground point under a screen position (-1 to 1). The ray goes in steps of one cell, then bisects.
	pick(ndc: THREE.Vector2): Cursor | null {
		const t = this.terrain;
		if (!t) return null;
		const ray = new THREE.Raycaster();
		ray.setFromCamera(ndc, this.view);
		const o = ray.ray.origin;
		const d = ray.ray.direction;
		const above = (s: number) => {
			const h = this.heightAt(o.x + d.x * s, -(o.z + d.z * s));
			return h === null ? null : o.y + d.y * s - h;
		};
		const step = t.cell;
		const max = this.view.far;
		let prev = 0;
		for (let s = step; s < max; s += step) {
			const a = above(s);
			if (a === null || a > 0) {
				prev = s;
				continue;
			}
			let lo = prev;
			let hi = s;
			for (let i = 0; i < 20; i++) {
				const mid = (lo + hi) / 2;
				const am = above(mid);
				if (am !== null && am > 0) lo = mid;
				else hi = mid;
			}
			const x = o.x + d.x * hi;
			const y = -(o.z + d.z * hi);
			return { x, y, h: this.heightAt(x, y) ?? 0 };
		}
		return null;
	}

	private resize() {
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		if (!w || !h) return;
		this.renderer.setSize(w, h, false);
		this.post.setSize(Math.round(w * this.renderer.getPixelRatio()), Math.round(h * this.renderer.getPixelRatio()));
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
		this.orthoProjection();
		this.lastView.identity();
	}

	private bindInput() {
		const c = this.canvas;
		c.tabIndex = 0;
		// Ctrl is for the editor shortcuts (Ctrl+Z, Ctrl+D, Ctrl+click). A key with Ctrl does not move the camera.
		// Inputs must not stay held: a release outside the view, a lost focus, or a late pointer lock clears them. Escape clears all.
		let right = false;
		const release = () => {
			this.keys.clear();
			right = false;
			if (document.pointerLockElement === c) document.exitPointerLock();
		};
		c.addEventListener("keydown", (e) => {
			if (e.code === "Escape") release();
			else if (e.code === "Home") this.resetCamera();
			else if (!e.ctrlKey && !e.metaKey) this.keys.add(e.code);
		});
		window.addEventListener("keyup", (e) => this.keys.delete(e.code));
		c.addEventListener("blur", () => this.keys.clear());
		window.addEventListener("blur", release);
		document.addEventListener("visibilitychange", release);
		c.addEventListener("contextmenu", (e) => e.preventDefault());
		c.addEventListener("mousedown", (e) => {
			c.focus();
			if (e.button === 2) {
				right = true;
				c.requestPointerLock();
			}
		});
		window.addEventListener("mouseup", (e) => {
			if (e.button !== 2) return;
			right = false;
			if (document.pointerLockElement === c) document.exitPointerLock();
		});
		// The lock comes some time after the request. If the button is already up, end the lock.
		document.addEventListener("pointerlockchange", () => {
			if (document.pointerLockElement === c && !right) document.exitPointerLock();
		});
		c.addEventListener("mousemove", (e) => {
			if (document.pointerLockElement === c) {
				// The right button is not down (its release was lost): end the look.
				if (!(e.buttons & 2)) {
					right = false;
					document.exitPointerLock();
					return;
				}
				if (this.ortho) {
					// Drag the map: the ground point under the mouse follows the mouse.
					const m = (2 * this.orthoHalf) / Math.max(1, c.clientHeight);
					const [f, r] = this.flatAxes();
					this.camera.position.addScaledVector(r, -e.movementX * m).addScaledVector(f, e.movementY * m);
					return;
				}
				// The frame applies the look a little at a time (smooth look).
				this.look.x -= e.movementX * 0.003;
				this.look.y -= e.movementY * 0.003;
				return;
			}
			const r = c.getBoundingClientRect();
			this.mouse = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
		});
		c.addEventListener("mouseleave", () => {
			this.mouse = undefined;
			this.lastCursor = null;
			this.onCursor?.(null);
		});
		c.addEventListener("wheel", (e) => {
			e.preventDefault();
			if (this.ortho) {
				this.orthoHalf = Math.max(10, Math.min(20000, this.orthoHalf * (e.deltaY < 0 ? 0.8 : 1.25)));
				this.orthoProjection();
				return;
			}
			this.speed = Math.max(1, Math.min(5000, this.speed * (e.deltaY < 0 ? 1.25 : 0.8)));
		}, { passive: false });
	}

	private frame() {
		const now = performance.now();
		const dt = Math.min(0.1, (now - this.last) / 1000);
		this.last = now;
		if (this.paused) return;
		this.move(dt);
		this.updateChunks();
		this.updateObjects();
		this.updateSun();
		// The post effects draw more than once in a frame, so the triangle count is reset here and not after each draw.
		this.renderer.info.reset();
		// The ambient occlusion works with the perspective camera only.
		this.post.render(this.ortho ? { ...this.env, ao: false } : this.env, this.view);
		if (this.mouse) this.onCursor?.((this.lastCursor = this.pick(this.mouse)));
		this.onFrame?.();
		this.frames++;
		if (now - this.fpsTime > 500) {
			this.onStats?.((this.frames * 1000) / (now - this.fpsTime), this.renderer.info.render.triangles, this.objectsDrawn);
			this.frames = 0;
			this.fpsTime = now;
		}
	}

	// Forward and right on the ground (Three.js axes), from the heading.
	private flatAxes(): THREE.Vector3[] {
		return [new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)), new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw))];
	}

	private orthoProjection() {
		const a = this.camera.aspect;
		const o = this.orthoCam;
		[o.left, o.right, o.top, o.bottom] = [-this.orthoHalf * a, this.orthoHalf * a, this.orthoHalf, -this.orthoHalf];
		o.updateProjectionMatrix();
		this.redraw();
	}

	// Called when the camera that draws changes (the gizmo of the editor uses it).
	onView?: (c: THREE.Camera) => void;

	setOrtho(on: boolean) {
		this.ortho = on;
		this.onView?.(this.view);
		this.orthoProjection();
	}

	// Camera position (local meters) and heading (radians, 0 is north, counterclockwise), for the marker of the 2D view.
	pose(): { x: number; y: number; yaw: number } {
		return { x: this.camera.position.x, y: -this.camera.position.z, yaw: this.yaw };
	}

	// Move the camera to 50 m above the terrain at a point (local meters), looking down at 45 degrees. The heading stays.
	teleport(x: number, y: number) {
		const h = this.heightAt(x, y) ?? 0;
		this.camera.position.set(x, h + 50, -y);
		this.pitch = -Math.PI / 4;
		this.vel.set(0, 0, 0);
		this.look.set(0, 0);
		this.redraw();
	}

	// Camera smoothing: the velocity follows the keys, and the mouse look not applied yet. A higher rate is less smooth.
	private vel = new THREE.Vector3();
	private look = new THREE.Vector2();
	private static readonly MOVE_RATE = 10;
	private static readonly LOOK_RATE = 30;
	private smooth(target: THREE.Vector3, dt: number) {
		this.vel.lerp(target, 1 - Math.exp(-dt * Viewer.MOVE_RATE));
		if (this.vel.lengthSq() < 1e-6 && target.lengthSq() === 0) this.vel.set(0, 0, 0);
		this.camera.position.addScaledVector(this.vel, dt);
	}

	private move(dt: number) {
		const k = this.keys;
		const lk = 1 - Math.exp(-dt * Viewer.LOOK_RATE);
		this.yaw += this.look.x * lk;
		this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch + this.look.y * lk));
		this.look.multiplyScalar(1 - lk);
		if (this.ortho) {
			const [f, r] = this.flatAxes();
			const v = new THREE.Vector3();
			if (k.has("KeyW")) v.add(f);
			if (k.has("KeyS")) v.sub(f);
			if (k.has("KeyD")) v.add(r);
			if (k.has("KeyA")) v.sub(r);
			const fast = k.has("ShiftLeft") || k.has("ShiftRight") ? 5 : 1;
			this.smooth(v.multiplyScalar(this.orthoHalf * fast), dt);
			const p = this.camera.position;
			const o = this.orthoCam;
			o.position.set(p.x, this.topHeight, p.z);
			o.up.copy(f);
			o.lookAt(p.x, this.topHeight - 1, p.z);
			return;
		}
		const fwd = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
		const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
		const v = new THREE.Vector3();
		if (k.has("KeyW")) v.add(fwd);
		if (k.has("KeyS")) v.sub(fwd);
		if (k.has("KeyD")) v.add(right);
		if (k.has("KeyA")) v.sub(right);
		if (k.has("KeyQ")) v.y += 1;
		if (k.has("KeyZ")) v.y -= 1;
		const fast = k.has("ShiftLeft") || k.has("ShiftRight") ? 5 : 1;
		this.smooth(v.multiplyScalar(this.speed * fast), dt);
		const p = this.camera.position;
		const ground = this.heightAt(p.x, -p.z);
		if (ground !== null && p.y < ground + 1.5) p.y = ground + 1.5;
		this.camera.lookAt(p.clone().add(fwd));
	}

	// Choose the detail level of each chunk from its distance to the camera. Hide chunks outside the view.
	private updateChunks() {
		const t = this.terrain;
		if (!t) return;
		const view = this.view;
		view.updateMatrixWorld();
		this.frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(view.projectionMatrix, view.matrixWorldInverse));
		const span = Math.min(CHUNK, t.ncols - 1) * t.cell;
		for (const c of this.chunks) {
			c.mesh.visible = this.frustum.intersectsBox(c.box);
			if (!c.mesh.visible) continue;
			const d = c.box.distanceToPoint(this.ortho ? this.camera.position.clone().setY(c.box.max.y) : this.camera.position);
			const level = Math.min(this.lods.length - 1, Math.max(0, Math.floor(Math.log2(Math.max(1, d / (span * 0.75))))));
			c.mesh.geometry = this.lods[level];
			const u = c.mesh.material.uniforms;
			u.uStep.value = 2 ** level;
			u.uSkirt.value = 2 ** level * t.cell * 4;
		}
	}
}
