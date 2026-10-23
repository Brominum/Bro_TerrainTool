// TB object text: one object on each line, `"name";x;y;yaw;pitch;roll;scale;z`, CRLF after each line (also the last).
// Verified with Trees2_3_2.txt (1342 lines). The number of decimals in the sample is not constant, so an imported line
// is kept and written again while its object is not changed.
import type { TextValues } from "./transform";

export interface TextObject extends TextValues {
	name: string;
	// The line as it was in the file, without the line end.
	raw: string;
}

// Read object text. Lines that are not correct are reported with their line number.
export function parseObjectText(text: string): { objects: TextObject[]; errors: string[] } {
	const objects: TextObject[] = [];
	const errors: string[] = [];
	text.split(/\r?\n/).forEach((line, n) => {
		if (!line.trim()) return;
		const f = line.split(";");
		const m = /^\s*"([^"]*)"\s*$/.exec(f[0] ?? "");
		const v = f.slice(1).map(Number);
		if (!m || f.length !== 8 || v.some((x) => !Number.isFinite(x))) {
			errors.push(`line ${n + 1}: ${line.slice(0, 80)}`);
			return;
		}
		objects.push({ name: m[1], x: v[0], y: v[1], yaw: v[2], pitch: v[3], roll: v[4], scale: v[5], z: v[6], raw: line });
	});
	return { objects, errors };
}

// A number with at most `d` decimals, without zeros at the end.
function num(v: number, d: number): string {
	const s = v.toFixed(d).replace(/\.?0+$/, "");
	return s === "-0" ? "0" : s;
}

// One line for a new or changed object: x and y with 3 decimals, angles with 2, scale with 3, z with 3.
export function formatLine(name: string, v: TextValues): string {
	return `"${name}";${v.x.toFixed(3)};${v.y.toFixed(3)};${num(v.yaw, 2)};${num(v.pitch, 2)};${num(v.roll, 2)};${num(v.scale, 3)};${num(v.z, 3)}`;
}

export function joinLines(lines: string[]): string {
	return lines.map((l) => l + "\r\n").join("");
}
