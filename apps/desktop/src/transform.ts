// Conversions between object transforms (12 values, WRP frame, see store.ts), Three.js matrices, and TB object text values.
import * as THREE from "three";

// Write the Three.js matrix (column-major, 16 values) of transform t[i..i+12] to out[o..o+16].
// Arma (x, z, y) becomes Three.js (x, z, -y). The dir axis is flipped with the z axis.
export function toThree(t: ArrayLike<number>, i: number, out: Float32Array | number[], o: number) {
	out[o] = t[i];
	out[o + 1] = t[i + 1];
	out[o + 2] = -t[i + 2];
	out[o + 3] = 0;
	out[o + 4] = t[i + 3];
	out[o + 5] = t[i + 4];
	out[o + 6] = -t[i + 5];
	out[o + 7] = 0;
	out[o + 8] = -t[i + 6];
	out[o + 9] = -t[i + 7];
	out[o + 10] = t[i + 8];
	out[o + 11] = 0;
	out[o + 12] = t[i + 9];
	out[o + 13] = t[i + 10];
	out[o + 14] = -t[i + 11];
	out[o + 15] = 1;
}

export function matrixOf(t: ArrayLike<number>, i = 0): THREE.Matrix4 {
	const m = new THREE.Matrix4();
	toThree(t, i, m.elements, 0);
	return m;
}

// The reverse of toThree.
export function fromThree(m: THREE.Matrix4): Float32Array {
	const e = m.elements;
	return Float32Array.from([e[0], e[1], -e[2], e[4], e[5], -e[6], -e[8], -e[9], e[10], e[12], e[13], -e[14]]);
}

// Values of one object in TB object text. x and y include the TB offset. z is relative to the terrain, or absolute.
export interface TextValues {
	x: number;
	y: number;
	yaw: number;
	pitch: number;
	roll: number;
	scale: number;
	z: number;
}

const rad = Math.PI / 180;

// Axes from yaw, pitch, and roll (degrees) and scale, in the WRP frame (x east, up, north).
// Yaw is the compass direction (clockwise from north). Verified only for yaw: the samples have pitch and roll 0.
// Assumed order: yaw, then pitch around the side axis (positive lifts the front), then roll around the front axis.
export function axes(yaw: number, pitch: number, roll: number, scale: number): number[] {
	const [a, p, r] = [yaw * rad, pitch * rad, roll * rad];
	const dir0 = [Math.sin(a), 0, Math.cos(a)];
	const aside0 = [Math.cos(a), 0, -Math.sin(a)];
	const dir1 = dir0.map((v, k) => v * Math.cos(p) + [0, 1, 0][k] * Math.sin(p));
	const up1 = [0, 1, 0].map((v, k) => v * Math.cos(p) - dir0[k] * Math.sin(p));
	const aside2 = aside0.map((v, k) => v * Math.cos(r) - up1[k] * Math.sin(r));
	const up2 = up1.map((v, k) => v * Math.cos(r) + aside0[k] * Math.sin(r));
	return [...aside2, ...up2, ...dir1].map((v) => v * scale);
}

// The reverse of axes. Returns yaw (0 to 360), pitch, roll, and scale.
export function angles(t: ArrayLike<number>, i = 0): { yaw: number; pitch: number; roll: number; scale: number } {
	const len = (o: number) => Math.hypot(t[i + o], t[i + o + 1], t[i + o + 2]);
	const scale = len(3);
	const dir = [t[i + 6], t[i + 7], t[i + 8]].map((v) => v / len(6));
	const aside = [t[i], t[i + 1], t[i + 2]].map((v) => v / len(0));
	const pitch = Math.asin(Math.max(-1, Math.min(1, dir[1])));
	const yaw = Math.atan2(dir[0], dir[2]) / rad;
	const roll = Math.asin(Math.max(-1, Math.min(1, -aside[1] / Math.max(1e-6, Math.cos(pitch)))));
	return { yaw: (yaw + 360) % 360, pitch: pitch / rad, roll: roll / rad, scale };
}

// Shift from the TB text position to the centered origin: the height part of the rotated model offset (x right, y up, z forward).
// TB uses the centered origin for x and y, and the original origin for the height (as getPosWorld and getPosASL in the game).
// Verified: x and y with the Airport_02 hangar halves (the halves touch only with this rule), the height with t_PinusS2s_F in bro_range.wrp.
// shortcut: verified only with pitch and roll 0. Check a tilted object against TB when one is available.
function shift(ax: ArrayLike<number>, i: number, off: ArrayLike<number>): number[] {
	return [0, ax[i + 1] * off[0] + ax[i + 4] * off[1] + ax[i + 7] * off[2], 0];
}

// The model offset of transform t[i..i+12] changes from a to b. Move the centered origin, so that the TB text position stays at its place.
export function moveOrigin(t: Float32Array, i: number, a: ArrayLike<number>, b: ArrayLike<number>) {
	const s = shift(t, i, [b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
	for (let k = 0; k < 3; k++) t[i + 9 + k] += s[k];
}

// Transform from TB object text. ground(x, y) gives the terrain height at local meters. off is the model offset.
export function fromText(v: TextValues, off: ArrayLike<number>, xll: number, yll: number, relative: boolean, ground: (x: number, y: number) => number): Float32Array {
	const ax = axes(v.yaw, v.pitch, v.roll, v.scale);
	const x = v.x - xll;
	const y = v.y - yll;
	const h = relative ? ground(x, y) + v.z : v.z;
	const s = shift(ax, 0, off);
	return Float32Array.from([...ax, x + s[0], h + s[1], y + s[2]]);
}

// TB object text values from a transform. The reverse of fromText.
export function toText(t: ArrayLike<number>, i: number, off: ArrayLike<number>, xll: number, yll: number, relative: boolean, ground: (x: number, y: number) => number): TextValues {
	const s = shift(t, i, off);
	const x = t[i + 9] - s[0];
	const h = t[i + 10] - s[1];
	const y = t[i + 11] - s[2];
	const a = angles(t, i);
	return { x: x + xll, y: y + yll, yaw: a.yaw, pitch: a.pitch, roll: a.roll, scale: a.scale, z: relative ? h - ground(x, y) : h };
}
