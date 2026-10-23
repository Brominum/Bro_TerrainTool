// Sea material: moving waves (normals from a sum of sine waves), sky reflection at low angles (Fresnel), sun highlights (Phong), clear
// shallow water and darker deep water (depth from the terrain heights), and foam at the shore line.
// shortcut: the reflection is the sky color only (no objects or terrain), and the wave values are chosen by eye, not from the game.
import * as THREE from "three";
import { fogUniforms, groundUniforms, withFog } from "./env";

// Sea color when the map config.cpp has no procedural waterTexture.
export const SEA_COLOR = 0x1f5a85;

export const waterUniforms = {
	uTime: { value: 0 },
};

// Direction, wave length (meters), height (meters), and speed (radians in each second) of each wave.
const WAVES = [
	[1, 0.3, 31, 0.1, 0.9],
	[-0.4, 1, 17, 0.06, 1.3],
	[0.7, -0.8, 7.3, 0.03, 2.1],
	[-0.9, -0.2, 3.1, 0.012, 3.2],
	[0.2, 0.95, 1.7, 0.006, 4.4],
];

const COMMON = /* glsl */ `
varying vec3 vSeaW;
uniform float uTime;
uniform vec3 uSky;
uniform sampler2D uGHeight;
uniform vec2 uGSize;
uniform float uGCell;
// Water depth below 0 m from the terrain heights (bilinear). Outside the terrain the water is deep.
float seaDepth(vec3 w) {
	vec2 c = vec2(w.x, -w.z) / uGCell;
	if (c.x < 0.0 || c.y < 0.0 || c.x > uGSize.x - 1.0 || c.y > uGSize.y - 1.0) return 100.0;
	vec2 i = min(floor(c), uGSize - 2.0);
	vec2 f = c - i;
	ivec2 k = ivec2(i);
	int top = int(uGSize.y) - 1;
	float h00 = texelFetch(uGHeight, ivec2(k.x, top - k.y), 0).r;
	float h10 = texelFetch(uGHeight, ivec2(k.x + 1, top - k.y), 0).r;
	float h01 = texelFetch(uGHeight, ivec2(k.x, top - k.y - 1), 0).r;
	float h11 = texelFetch(uGHeight, ivec2(k.x + 1, top - k.y - 1), 0).r;
	return max(0.0, -mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y));
}
// World normal of the waves. Small waves fade out with distance, so that they do not flicker.
vec3 seaNormal(vec2 p, float dist) {
	vec2 g = vec2(0.0);
${WAVES.map(([dx, dz, l, a, s]) => {
	const n = Math.hypot(dx, dz);
	const k = (2 * Math.PI) / l;
	return `	g += vec2(${(dx / n).toFixed(4)}, ${(dz / n).toFixed(4)}) * ${(k * a).toFixed(5)} * cos(dot(vec2(${(dx / n).toFixed(4)}, ${(dz / n).toFixed(4)}), p) * ${k.toFixed(5)} + uTime * ${s.toFixed(2)}) * exp(-dist / ${(l * 60).toFixed(1)});`;
}).join("\n")}
	return normalize(vec3(-g.x, 1.0, -g.y));
}`;

export function waterMaterial(): THREE.MeshPhongMaterial {
	const m = new THREE.MeshPhongMaterial({ color: SEA_COLOR, specular: 0x555555, shininess: 220, transparent: true });
	m.onBeforeCompile = (sh) => {
		Object.assign(sh.uniforms, waterUniforms, groundUniforms, { uSky: fogUniforms.uFogColor });
		sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vSeaW;").replace("#include <project_vertex>", "#include <project_vertex>\nvSeaW = (modelMatrix * vec4(transformed, 1.0)).xyz;");
		sh.fragmentShader = sh.fragmentShader
			.replace("#include <common>", `#include <common>${COMMON}`)
			.replace(
				"#include <color_fragment>",
				`#include <color_fragment>
float sDepth = seaDepth(vSeaW);
// 0 at the shore, 1 in deep water.
float sDeep = 1.0 - exp(-sDepth * 0.3);
diffuseColor.rgb *= mix(vec3(1.25, 1.35, 1.2), vec3(0.55, 0.7, 0.8), sDeep);
float sDist = length(cameraPosition - vSeaW);
vec3 sN = seaNormal(vSeaW.xz, sDist);`,
			)
			.replace("#include <normal_fragment_maps>", "#include <normal_fragment_maps>\nnormal = normalize((viewMatrix * vec4(sN, 0.0)).xyz);")
			.replace(
				"#include <opaque_fragment>",
				`#include <opaque_fragment>
vec3 sV = normalize(cameraPosition - vSeaW);
float sFres = 0.02 + 0.98 * pow(1.0 - max(dot(sN, sV), 0.0), 5.0);
gl_FragColor.rgb = mix(gl_FragColor.rgb, uSky, sFres * 0.8);
// Foam: bands that move to the shore in the first 0.8 m of depth.
float sFoam = (1.0 - smoothstep(0.0, 0.8, sDepth)) * smoothstep(0.3, 1.0, 0.5 + 0.5 * sin(sDepth * 14.0 + uTime * 1.6 + sin(vSeaW.x * 0.11) + sin(vSeaW.z * 0.13)));
gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.85), sFoam * 0.7);
gl_FragColor.a = clamp(mix(0.2, 0.93, sDeep) + sFres * 0.5 + sFoam * 0.6, 0.0, 1.0);`,
			);
	};
	m.customProgramCacheKey = () => "sea";
	return withFog(m);
}
