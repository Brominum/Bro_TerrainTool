// Viewport environment: the time of day (sun or moon, sky color, ambient light) and the height fog as in Arma 3 (3DEN):
// density, base altitude, and decay. The fog code goes into each material with withFog(), with shared uniforms.
import * as THREE from "three";

export interface Environment {
	// Hour of the day, 0 to 24.
	hour: number;
	shadows: boolean;
	// Brightness of the sun (or moon), a multiplier (see Viewer.setEnvironment). The sky light grows by half as much.
	sun: number;
	// Fog density in percent (0 to 10), base altitude in meters (also below 0), decay in percent (0 to 1) for each meter above the base.
	fogDensity: number;
	fogBase: number;
	fogDecay: number;
	// Post effects: ambient occlusion and bloom (see post.ts).
	ao: boolean;
	bloom: boolean;
	// Show a water plane at 0 m (the sea level of Arma 3).
	sea: boolean;
	// Ground detail textures of layers.cfg near the camera: full to detailStart meters, gone at detailEnd meters.
	detail: boolean;
	detailStart: number;
	detailEnd: number;
	// Clutter of the ground detail layers (CfgSurfaces in the map config.cpp) to this distance in meters. It shows with the ground detail.
	clutterEnd: number;
}

export const DEFAULT_ENV: Environment = { hour: 9, shadows: true, sun: 1, fogDensity: 0, fogBase: 0, fogDecay: 0, ao: true, bloom: true, sea: true, detail: true, detailStart: 10, detailEnd: 65, clutterEnd: 50 };

export const PRESETS: { name: string; icon: string; hour: number }[] = [
	{ name: "Sunrise", icon: "sun-foggy-line", hour: 6 },
	{ name: "Day", icon: "sun-line", hour: 12 },
	{ name: "Sunset", icon: "haze-line", hour: 18 },
	{ name: "Night", icon: "moon-clear-line", hour: 23 },
];

// The terrain heights for the object materials (decals on the surface, fences sheared to the terrain). The viewer sets them.
export const groundUniforms = {
	uGHeight: { value: null as THREE.Texture | null },
	uGSize: { value: new THREE.Vector2(2, 2) },
	uGCell: { value: 1 },
	// 0 turns the changes off (the model preview).
	uGOn: { value: 1 },
};

// Fog uniforms of all materials. Extinction in 1/m (density 100 % = 0.05/m, a view of about 60 m), base in the Three.js y axis, decay in 1/m.
export const fogUniforms = {
	uFogColor: { value: new THREE.Color(0.62, 0.75, 0.86) },
	uFogK: { value: 0 },
	uFogBase: { value: 0 },
	uFogDecay: { value: 0 },
};

const FOG_VERTEX = `
vec4 fogWorld = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
fogWorld = instanceMatrix * fogWorld;
#endif
vFogWorld = (modelMatrix * fogWorld).xyz;`;

// Optical depth of the height fog along the view ray. The density falls by exp(-decay * (height - base)) above the base and stays full
// below it. The log mean of the two end densities is exact for one exponential.
const FOG_FRAGMENT = `
if (uFogK > 0.0) {
	vec3 fd = vFogWorld - cameraPosition;
	float L = length(fd);
	float rc = uFogK * min(1.0, exp(-uFogDecay * (cameraPosition.y - uFogBase)));
	float rp = uFogK * min(1.0, exp(-uFogDecay * (vFogWorld.y - uFogBase)));
	float mean = abs(rc - rp) < 1e-9 ? rc : (rc - rp) / log(max(rc, 1e-12) / max(rp, 1e-12));
	gl_FragColor.rgb = mix(gl_FragColor.rgb, uFogColor, 1.0 - exp(-mean * L));
}`;

// Add the height fog to a built-in material (Lambert, basic). An onBeforeCompile of the material runs first.
export function withFog<T extends THREE.Material>(m: T): T {
	const prev = m.onBeforeCompile.bind(m);
	m.onBeforeCompile = (sh, r) => {
		prev(sh, r);
		Object.assign(sh.uniforms, fogUniforms);
		sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vFogWorld;").replace("#include <fog_vertex>", `#include <fog_vertex>${FOG_VERTEX}`);
		sh.fragmentShader = sh.fragmentShader
			.replace("#include <common>", "#include <common>\nvarying vec3 vFogWorld;\nuniform vec3 uFogColor;\nuniform float uFogK, uFogBase, uFogDecay;")
			.replace("#include <fog_fragment>", `#include <fog_fragment>${FOG_FRAGMENT}`);
	};
	return m;
}

export interface Sun {
	// Direction to the light (Three.js axes: x east, y up, -z north).
	dir: THREE.Vector3;
	color: THREE.Color;
	intensity: number;
	sky: THREE.Color;
	ground: THREE.Color;
	ambient: number;
}

// The color values here are sRGB (as a color picker shows them).
const srgb = (c: number[]) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
const mix = (a: number[], b: number[], t: number) => srgb(a.map((x, i) => x + (b[i] - x) * t));
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

// Sun from the hour: rises in the east at 5:30, highest (65 degrees) in the south at 12, sets in the west at 18:30.
// At night the moon gives a weak blue light.
export function sunAt(hour: number): Sun {
	const el = THREE.MathUtils.degToRad(65) * Math.sin((Math.PI * (hour - 5.5)) / 13);
	const az = THREE.MathUtils.degToRad(90 + (hour - 6) * 15);
	const day = el > 0;
	// The moon is opposite to the sun.
	const [e, a] = day ? [el, az] : [Math.max(0.35, -el), az + Math.PI];
	const dir = new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)).normalize();
	// 0 at the horizon, 1 from 15 degrees up.
	const high = clamp01(el / THREE.MathUtils.degToRad(15));
	// Twilight: from 8 degrees below the horizon to the horizon.
	const dusk = clamp01((el + THREE.MathUtils.degToRad(8)) / THREE.MathUtils.degToRad(8));
	if (day) {
		return {
			dir,
			color: mix([1, 0.55, 0.3], [1, 0.97, 0.9], high),
			intensity: 0.5 + 1.1 * high,
			sky: mix([0.93, 0.6, 0.45], [0.62, 0.75, 0.86], high),
			ground: mix([0.3, 0.22, 0.18], [0.35, 0.33, 0.28], high),
			ambient: 0.35 + 0.35 * high,
		};
	}
	return {
		dir,
		color: srgb([0.55, 0.65, 1]),
		intensity: 0.25,
		sky: mix([0.03, 0.05, 0.1], [0.6, 0.4, 0.4], dusk),
		ground: srgb([0.05, 0.05, 0.07]),
		ambient: 0.15 + 0.3 * dusk,
	};
}
