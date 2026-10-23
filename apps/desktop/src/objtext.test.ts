// Golden test of the object text (milestone M3) and checks of the transform conversions. Run: npm test
import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatLine, joinLines, parseObjectText } from "./objtext";
import { angles, axes, fromText, moveOrigin, toText } from "./transform";

const sample = new URL("../../../tests/fixtures/objects/Trees2_3_2.txt", import.meta.url);

describe("object text", () => {
	it.skipIf(!existsSync(sample))("Trees2_3_2.txt round trip is byte-identical", () => {
		const text = readFileSync(sample, "latin1");
		const { objects, errors } = parseObjectText(text);
		expect(errors).toEqual([]);
		expect(objects.length).toBe(1342);
		expect(joinLines(objects.map((o) => o.raw))).toBe(text);
		// A new line for the same values reads back to the same values.
		for (const o of objects.slice(0, 50)) {
			const again = parseObjectText(formatLine(o.name, o)).objects[0];
			for (const k of ["x", "y", "yaw", "pitch", "roll", "scale", "z"] as const) expect(again[k]).toBeCloseTo(o[k], 3);
		}
	});
	it("reports bad lines", () => {
		const r = parseObjectText('"a";1;2;3;0;0;1;0\r\nbad line\r\n"b";1;2;3;0;0;x;0\r\n');
		expect(r.objects.length).toBe(1);
		expect(r.errors.length).toBe(2);
	});
});

describe("transforms", () => {
	it("axes and angles are the reverse of each other", () => {
		for (const [yaw, pitch, roll, scale] of [[0, 0, 0, 1], [90, 0, 0, 1], [182, 10, -5, 0.94], [359, -30, 20, 1.3]]) {
			const a = angles(axes(yaw, pitch, roll, scale));
			expect(a.yaw).toBeCloseTo(yaw, 4);
			expect(a.pitch).toBeCloseTo(pitch, 4);
			expect(a.roll).toBeCloseTo(roll, 4);
			expect(a.scale).toBeCloseTo(scale, 5);
		}
		// Yaw 90 looks east, the right side is south.
		const ax = axes(90, 0, 0, 1);
		expect(ax.slice(6, 9).map((v) => Math.round(v))).toEqual([1, 0, 0]);
		expect(ax.slice(0, 3).map((v) => Math.round(v))).toEqual([0, 0, -1]);
	});
	it("text values go to the WRP frame and back", () => {
		const ground = (x: number, y: number) => 100 + x * 0.01 + y * 0.02;
		const off = [0.5, 6.9, -0.2];
		const v = { x: 207092.144, y: 14561.414, yaw: 182, pitch: 3, roll: -2, scale: 0.94, z: 0.25 };
		for (const relative of [true, false]) {
			const t = fromText(v, off, 200000, 0, relative, ground);
			const back = toText(t, 0, off, 200000, 0, relative, ground);
			for (const k of ["x", "y", "yaw", "pitch", "roll", "scale", "z"] as const) expect(back[k]).toBeCloseTo(v[k], 3);
		}
		// Relative z 0, no rotation: the centered origin is the model offset above the terrain.
		const t = fromText({ ...v, pitch: 0, roll: 0, scale: 1, z: 0 }, off, 200000, 0, true, () => 50);
		expect(t[10]).toBeCloseTo(56.9, 4);
	});
	it("the Airport_02 hangar halves touch, as in TB", () => {
		// Lines from a TB export. Offsets and x ranges of the visual LOD (centered) from p3d::mesh of the vanilla ODOL files.
		const { objects } = parseObjectText('"airport_02_hangar_left_f";209173.75000000;3607.11254883;-159.26425171;-0.00000000;0.00000000;1.00000000;0.00000000\r\n"airport_02_hangar_right_f";209140.20312500;3619.81445312;-159.26425171;-0.00000000;0.00000000;1.00000000;0.00000000\r\n');
		const left = fromText(objects[0], [-2.235, 7.7155, 2.1776], 200000, 0, true, () => 10);
		const right = fromText(objects[1], [2.25185, 7.73316, 2.1776], 200000, 0, true, () => 10);
		// Distance of the centered origins along the right axis (aside) of the left half.
		const d = (right[9] - left[9]) * left[0] + (right[11] - left[11]) * left[2];
		const gap = d - 18.20415 - 18.0456;
		expect(Math.abs(gap)).toBeLessThan(0.5);
		// Relative z 0: the original origin is on the terrain.
		expect(left[10]).toBeCloseTo(10 + 7.7155, 3);
	});
	it("a new model offset keeps the object at the text position", () => {
		// Import without a model library (offset 0), then the library gives the real offset.
		const ground = () => 20;
		const off = [-2.27, 6.9, 0.045];
		const v = { x: 207092.144, y: 14561.414, yaw: 182, pitch: 3, roll: -2, scale: 0.94, z: 0.25 };
		const t = fromText(v, [0, 0, 0], 200000, 0, true, ground);
		moveOrigin(t, 0, [0, 0, 0], off);
		const want = fromText(v, off, 200000, 0, true, ground);
		for (let k = 0; k < 12; k++) expect(t[k]).toBeCloseTo(want[k], 3);
	});
});
