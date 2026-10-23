// Model library: build Three.js meshes from the P3D meshes and the PAA (DXT) textures. Each model and texture loads one time.
import * as THREE from "three";
import { groundUniforms, withFog } from "./env";
import { oneGroupBox } from "./viewer";
import { loadDds, loadMaterial, loadMesh, type Dds, type Material, type Mesh } from "./data";

export interface Model {
	name: string;
	geometry: THREE.BufferGeometry;
	materials: THREE.Material[];
	triangles: number;
	// Textures that did not load, with the reason.
	missing: string[];
	// Shift of the binarizer in Arma model space (original origin = centered origin + offset). Zero when the model did not load.
	offset: number[];
	// Set when the model did not load. The geometry is then a red box.
	error?: string;
	// The model has no visual LOD (for example a clutter cutter). It shows nothing, and it is not an error.
	empty?: boolean;
}

const failMaterial = new THREE.MeshLambertMaterial({ color: 0xff2020 });
const greyTexture = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
greyTexture.needsUpdate = true;

// Multimaterial (pixel shader Multi): stages 0 to 3 are tiled layers, stage 4 is the mask, stage 9 is the macro color (_mc).
// Mask: black selects layer 0, red layer 1, green layer 2, blue layer 3. Found from the user test with IndustrialShed_01_F.
// shortcut: the normal maps, the specular maps, and the ambient shadow (_ads) are not used. The uvTransform uses only scale and offset.
function multiMaterial(mat: Material, tex: THREE.Texture[]): THREE.Material {
	const xf = mat.stages.slice(0, 4).map((s) => new THREE.Vector4(s.aside[0], s.up[1], s.pos[0], s.pos[1]));
	while (xf.length < 4) xf.push(new THREE.Vector4(1, 1, 0, 0));
	const second = (i: number) => (mat.stages[i]?.uvSource === "tex1" ? 1 : 0);
	const uniforms = {
		mL0: { value: tex[0] },
		mL1: { value: tex[1] },
		mL2: { value: tex[2] },
		mL3: { value: tex[3] },
		mMask: { value: tex[4] },
		mMacro: { value: tex[9] },
		mHasMacro: { value: mat.stages[9]?.texture.toLowerCase().endsWith("_mc.paa") && tex[9] !== greyTexture ? 1 : 0 },
		mXf: { value: xf },
		mMaskUv: { value: second(4) },
		mMacroUv: { value: second(9) },
	};
	const m = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
	m.onBeforeCompile = (sh) => {
		Object.assign(sh.uniforms, uniforms);
		sh.vertexShader = sh.vertexShader
			.replace("#include <common>", "#include <common>\nattribute vec2 uvA;\nattribute vec2 uvB;\nvarying vec2 vUvA;\nvarying vec2 vUvB;")
			.replace("#include <begin_vertex>", "#include <begin_vertex>\nvUvA = uvA;\nvUvB = uvB;");
		sh.fragmentShader = sh.fragmentShader
			.replace(
				"#include <common>",
				"#include <common>\nuniform sampler2D mL0, mL1, mL2, mL3, mMask, mMacro;\nuniform vec4 mXf[4];\nuniform float mHasMacro, mMaskUv, mMacroUv;\nvarying vec2 vUvA;\nvarying vec2 vUvB;\nvec2 mUv(int i) { return vUvA * mXf[i].xy + mXf[i].zw; }",
			)
			.replace(
				"#include <map_fragment>",
				`vec4 mk = texture2D(mMask, mix(vUvA, vUvB, mMaskUv));
				vec4 w = vec4(max(0.0, 1.0 - mk.r - mk.g - mk.b), mk.rgb);
				w /= max(w.x + w.y + w.z + w.w, 0.001);
				vec3 col = texture2D(mL0, mUv(0)).rgb * w.x + texture2D(mL1, mUv(1)).rgb * w.y + texture2D(mL2, mUv(2)).rgb * w.z + texture2D(mL3, mUv(3)).rgb * w.w;
				vec4 mc = texture2D(mMacro, mix(vUvA, vUvB, mMacroUv));
				col = mix(col, mc.rgb, mc.a * mHasMacro);
				diffuseColor.rgb *= col;`,
			);
	};
	m.customProgramCacheKey = () => "multi";
	return withFog(m);
}
// Foliage (leaves of trees and bushes). The normals of the leaf cards point in random directions, so the sun lights only some of the cards
// and the crown is dark. Arma lights a crown almost evenly. This material uses a normal that points out from the center of the crown
// (and a little up), the same normal on the two sides of a card, and half the shadow strength.
function foliageMaterial(t: THREE.Texture, crown: THREE.Vector3): THREE.Material {
	const m = new THREE.MeshLambertMaterial({ map: t, alphaTest: 0.5, side: THREE.DoubleSide });
	m.onBeforeCompile = (sh) => {
		sh.uniforms.uCrown = { value: crown };
		sh.vertexShader = sh.vertexShader
			.replace("#include <common>", "#include <common>\nuniform vec3 uCrown;")
			.replace(
				"#include <beginnormal_vertex>",
				"vec3 crownDir = position - uCrown;\nvec3 objectNormal = normalize((dot(crownDir, crownDir) > 1e-6 ? normalize(crownDir) : vec3(0.0)) + vec3(0.0, 0.6, 0.0));",
			);
		sh.fragmentShader = sh.fragmentShader
			.replace("#include <normal_fragment_begin>", "#include <normal_fragment_begin>\n#ifdef DOUBLE_SIDED\nnormal *= faceDirection;\n#endif")
			.replace("#include <lights_fragment_begin>", THREE.ShaderChunk.lights_fragment_begin.replaceAll("directionalLightShadow.shadowIntensity", "0.5 * directionalLightShadow.shadowIntensity"));
	};
	m.customProgramCacheKey = () => "foliage";
	return withFog(m);
}
// A face is foliage when its RVMAT uses a tree shader that is not the trunk shader (TreeAdv, checked in a3\plants_f and
// a3\vegetation_f_enoch). The texture name does not matter: the far LODs have alpha textures without _ca (t_malusdomestica_3s_lod4.paa).
// Without an RVMAT, a _ca texture on a vegetation path is foliage.
function isFoliage(texture: string, mat: Material | string | undefined): boolean {
	if (mat && typeof mat !== "string") return /^tree/i.test(mat.pixelShader) && !/trunk/i.test(mat.pixelShader);
	return /_ca\.paa$/i.test(texture) && /plants|vegetation|tree|bush|polyplane|leaves|crown|foliage/i.test(texture);
}
// The game moves some vertices to the terrain: "On surface" vertices (attribute aLand = 1, decals such as helipads) go onto the
// ground, and a model with LandContact points (placement = slopelandcontact, fences) is sheared up or down so that the points
// touch the ground. The shear changes linearly between the two points (one point: a shift). Heights are bilinear, as Viewer.heightAt.
// shortcut: the shadow map uses the model without these changes, and more than 2 LandContact points use the 2 that are furthest apart.
const GROUND_COMMON = /* glsl */ `
attribute float aLand;
uniform sampler2D uGHeight;
uniform vec2 uGSize;
uniform float uGCell;
uniform vec3 uC0;
uniform vec3 uC1;
uniform float uCN;
uniform float uGOn;
float gAt(ivec2 c) {
	ivec2 s = ivec2(uGSize);
	c = clamp(c, ivec2(0), s - 1);
	return texelFetch(uGHeight, ivec2(c.x, s.y - 1 - c.y), 0).r;
}
float gH(vec3 w) {
	vec2 c = clamp(vec2(w.x, -w.z) / uGCell, vec2(0.0), uGSize - 1.0);
	vec2 i = min(floor(c), uGSize - 2.0);
	vec2 f = c - i;
	ivec2 k = ivec2(i);
	return mix(mix(gAt(k), gAt(k + ivec2(1, 0)), f.x), mix(gAt(k + ivec2(0, 1)), gAt(k + ivec2(1, 1)), f.x), f.y);
}`;
const GROUND_VERTEX = /* glsl */ `
mat4 gM = modelMatrix;
#ifdef USE_INSTANCING
gM = gM * instanceMatrix;
#endif
float gDy = 0.0;
if (uCN > 0.5) {
	vec3 w0 = (gM * vec4(uC0, 1.0)).xyz;
	vec3 w1 = (gM * vec4(uC1, 1.0)).xyz;
	vec2 dd = uC1.xz - uC0.xz;
	float t = uCN > 1.5 ? clamp(dot(transformed.xz - uC0.xz, dd) / max(dot(dd, dd), 1e-6), 0.0, 1.0) : 0.0;
	gDy = mix(gH(w0) - w0.y, gH(w1) - w1.y, t);
}
if (aLand > 0.5) {
	vec3 w = (gM * vec4(transformed, 1.0)).xyz;
	gDy = gH(w) + 0.03 - w.y;
}
transformed += inverse(mat3(gM)) * vec3(0.0, gDy * uGOn, 0.0);`;

// Add the terrain changes above to a material. `contact` holds 0 to 2 LandContact points (Three.js model space).
function withGround<T extends THREE.Material>(m: T, contact: THREE.Vector3[]): T {
	const prev = m.onBeforeCompile.bind(m);
	const key = m.customProgramCacheKey();
	const u = { uC0: { value: contact[0] ?? new THREE.Vector3() }, uC1: { value: contact[1] ?? new THREE.Vector3() }, uCN: { value: contact.length } };
	m.onBeforeCompile = (sh, r) => {
		prev(sh, r);
		Object.assign(sh.uniforms, groundUniforms, u);
		sh.vertexShader = sh.vertexShader.replace("#include <common>", `#include <common>${GROUND_COMMON}`).replace("#include <begin_vertex>", `#include <begin_vertex>${GROUND_VERTEX}`);
	};
	m.customProgramCacheKey = () => `${key}|ground`;
	return m;
}

// LandContact points (Arma model space, x y z for each) in Three.js space. More than 2: the 2 that are furthest apart.
function contactPoints(c: Float32Array): THREE.Vector3[] {
	const p: THREE.Vector3[] = [];
	for (let i = 0; i + 2 < c.length; i += 3) p.push(new THREE.Vector3(c[i], c[i + 1], -c[i + 2]));
	if (p.length <= 2) return p;
	let best = [p[0], p[1]];
	for (const a of p) for (const b of p) if (a.distanceToSquared(b) > best[0].distanceToSquared(best[1])) best = [a, b];
	return best;
}
const greyMaterial = withFog(new THREE.MeshLambertMaterial({ color: 0x9a9a9a, side: THREE.DoubleSide }));

export function ddsTexture(d: Dds): THREE.CompressedTexture {
	const mips = d.mips.map((m) => ({ data: m.data, width: m.width, height: m.height }));
	// WebGL needs mipmaps down to 1 x 1. PAA stops at 4 x 4. A smaller DXT mipmap still uses one block, so repeat the last block.
	let last = mips[mips.length - 1];
	while (last.width > 1 || last.height > 1) {
		last = { data: last.data.subarray(0, d.dxt5 ? 16 : 8), width: Math.max(1, last.width >> 1), height: Math.max(1, last.height >> 1) };
		mips.push(last);
	}
	const t = new THREE.CompressedTexture(mips, mips[0].width, mips[0].height, d.dxt5 ? THREE.RGBA_S3TC_DXT5_Format : THREE.RGBA_S3TC_DXT1_Format);
	t.minFilter = THREE.LinearMipmapLinearFilter;
	t.magFilter = THREE.LinearFilter;
	t.wrapS = t.wrapT = THREE.RepeatWrapping;
	t.colorSpace = THREE.SRGBColorSpace;
	t.anisotropy = 8;
	t.needsUpdate = true;
	return t;
}

// Convert to Three.js space: z is flipped. The mirror also changes the corner order from clockwise (Direct3D front) to counterclockwise (Three.js front).
export function meshGeometry(m: Mesh): THREE.BufferGeometry {
	const p = Float32Array.from(m.positions);
	const n = Float32Array.from(m.normals);
	// The z flip mirrors the positions. The normals of the reader point into the model (checked: the trunk of t_PinusSylvestris_2sb,
	// the roof of Barracks_01_camo_F, and the walls of IndustrialShed_01_F all face in), so x and y change sign and z stays.
	for (let i = 0; i < p.length; i++) {
		if (i % 3 === 2) p[i] = -p[i];
		else n[i] = -n[i];
	}
	const g = new THREE.BufferGeometry();
	g.setAttribute("position", new THREE.BufferAttribute(p, 3));
	g.setAttribute("normal", new THREE.BufferAttribute(n, 3));
	const uv = new THREE.BufferAttribute(Float32Array.from(m.uvs), 2);
	g.setAttribute("uv", uv);
	// Own names for the multimaterial shader, so that they do not collide with the attributes of Three.js.
	g.setAttribute("uvA", uv);
	g.setAttribute("uvB", new THREE.BufferAttribute(Float32Array.from(m.uv1), 2));
	g.setAttribute("aLand", new THREE.BufferAttribute(m.land ? Float32Array.from(m.land) : new Float32Array(p.length / 3), 1));
	const total = m.groups.reduce((s, x) => s + x.indices.length, 0);
	const idx = new Uint32Array(total);
	let o = 0;
	m.groups.forEach((x, i) => {
		idx.set(x.indices, o);
		g.addGroup(o, x.indices.length, i);
		o += x.indices.length;
	});
	g.setIndex(new THREE.BufferAttribute(idx, 1));
	g.computeBoundingSphere();
	return g;
}

// Center of the bounding box of the vertices of a group, in Three.js space (z flipped, as in meshGeometry).
function groupCenter(m: Mesh, indices: ArrayLike<number>): THREE.Vector3 {
	const box = new THREE.Box3();
	const v = new THREE.Vector3();
	for (let i = 0; i < indices.length; i++) {
		const k = indices[i] * 3;
		box.expandByPoint(v.set(m.positions[k], m.positions[k + 1], -m.positions[k + 2]));
	}
	return box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
}

export class ModelLibrary {
	private textures = new Map<string, Promise<THREE.Texture | string>>();
	private materials = new Map<string, Promise<Material | string>>();

	material(path: string): Promise<Material | string> {
		let m = this.materials.get(path);
		if (!m) {
			m = loadMaterial(path).catch((e) => String(e));
			this.materials.set(path, m);
		}
		return m;
	}

	// Face material for a group: the face texture, or else the RVMAT (multimaterial, or its first color texture).
	// `crown` is the center of the faces of the group in Three.js space (see foliageMaterial).
	private async faceMaterial(g: Mesh["groups"][number], missing: string[], crown: THREE.Vector3): Promise<THREE.Material> {
		// Only a _ca texture has a real alpha channel (Arma naming). The alpha of a _co or _cs texture (for example tree bark) can be 0 or
		// carry other data, so a cut-out would hide the trunk.
		const plain = (t: THREE.Texture, path: string) => withFog(new THREE.MeshLambertMaterial({ map: t, alphaTest: /_ca\.paa$/i.test(path) ? 0.5 : 0, side: THREE.DoubleSide }));
		// An RVMAT with renderFlags NoZWrite (glass, decals) is blended with its alpha, not cut out.
		const blended = (t: THREE.Texture) => withFog(new THREE.MeshLambertMaterial({ map: t, transparent: true, depthWrite: false, alphaTest: 0.01, side: THREE.DoubleSide }));
		const noZWrite = (m: Material | string | undefined) => !!m && typeof m !== "string" && m.renderFlags.some((f) => f.toLowerCase() === "nozwrite");
		if (g.texture && !g.texture.startsWith("#")) {
			const t = await this.texture(g.texture);
			if (typeof t !== "string") {
				const mat = g.material ? await this.material(g.material) : undefined;
				if (/_ca\.paa$/i.test(g.texture) && noZWrite(mat)) return blended(t);
				return isFoliage(g.texture, mat) ? foliageMaterial(t, crown) : plain(t, g.texture);
			}
			missing.push(`${g.texture}: ${t}`);
		}
		if (!g.material) return greyMaterial;
		const mat = await this.material(g.material);
		if (typeof mat === "string") {
			missing.push(`${g.material}: ${mat}`);
			return greyMaterial;
		}
		if (mat.pixelShader.toLowerCase().startsWith("multi")) {
			const tex = await Promise.all(
				mat.stages.map(async (s) => {
					const t = await this.texture(s.texture);
					if (typeof t === "string") {
						if (s.texture && !s.texture.startsWith("#")) missing.push(`${s.texture}: ${t}`);
						return greyTexture;
					}
					return t;
				}),
			);
			while (tex.length < 10) tex.push(greyTexture);
			return multiMaterial(mat, tex);
		}
		const co = mat.stages.find((s) => /_(co|ca)\.paa$/i.test(s.texture));
		if (!g.texture && co) {
			const t = await this.texture(co.texture);
			if (typeof t !== "string") return noZWrite(mat) ? blended(t) : isFoliage(co.texture, mat) ? foliageMaterial(t, crown) : plain(t, co.texture);
		}
		return greyMaterial;
	}
	private models = new Map<string, Promise<Model>>();

	texture(path: string): Promise<THREE.Texture | string> {
		let t = this.textures.get(path);
		if (!t) {
			// Procedural textures such as #(argb,8,8,3)color(...) have no file.
			t = path.startsWith("#") || !path ? Promise.resolve("procedural or empty") : loadDds(path).then(ddsTexture, (e) => String(e));
			this.textures.set(path, t);
		}
		return t;
	}

	// `low` selects the least detailed visual LOD.
	model(name: string, low = false): Promise<Model> {
		const key = `${low ? "low" : "high"}|${name}`;
		let m = this.models.get(key);
		if (!m) {
			m = this.build(name, low);
			this.models.set(key, m);
		}
		return m;
	}

	clear() {
		this.textures.clear();
		this.materials.clear();
		this.models.clear();
	}

	private async build(name: string, low: boolean): Promise<Model> {
		try {
			const mesh = await loadMesh(name, low);
			const missing: string[] = [];
			let materials = await Promise.all(mesh.groups.map((g) => this.faceMaterial(g, missing, groupCenter(mesh, g.indices))));
			const contact = contactPoints(mesh.contact);
			if (contact.length || mesh.land.some((v) => v > 0)) {
				// The grey material is shared, so a model with terrain changes gets its own.
				materials = materials.map((x) => withGround(x === greyMaterial ? withFog(new THREE.MeshLambertMaterial({ color: 0x9a9a9a, side: THREE.DoubleSide })) : x, contact));
			}
			const triangles = mesh.groups.reduce((s, g) => s + g.indices.length / 3, 0);
			return { name, geometry: meshGeometry(mesh), materials, triangles, missing, offset: [...mesh.offset] };
		} catch (e) {
			if (String(e).includes("no visual LOD")) return { name, geometry: new THREE.BufferGeometry(), materials: [], triangles: 0, missing: [], offset: [0, 0, 0], empty: true };
			return { name, geometry: oneGroupBox(), materials: [failMaterial], triangles: 12, missing: [], offset: [0, 0, 0], error: String(e) };
		}
	}
}
