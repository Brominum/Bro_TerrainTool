//! Mask-driven object fill. The tool places objects on the pixels of selected mask layers (palette indices).
//! Spacing: dart throwing with a seeded random generator and a grid of the placed objects. The tool works in mask tiles in a fixed order,
//! and each tile has its own random sequence. So the same settings and seed give the same result.
//! The mask covers the terrain like the satellite image: ncols x cellsize meters. Mask row 0 is the north row.
use crate::height::Heights;
use crate::mask::{Mask, TILE};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Settings of one fill: the recipe, the mask layers, and the rules. The UI saves the recipe part as JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
	/// Weight of each model of the recipe. The result gives the index in this list.
	pub weights: Vec<f64>,
	/// Objects per hectare.
	pub density: f64,
	/// Smallest distance between two objects of the fill, in meters. 0 is off.
	pub spacing: f64,
	/// Random yaw from 0 to 360. Off: yaw 0.
	pub random_yaw: bool,
	pub scale: [f64; 2],
	/// Pitch and roll follow the terrain. Assumed rotation order, see transform.ts.
	pub tilt: bool,
	pub seed: u64,
	/// Palette indices of the mask layers to fill.
	pub colors: Vec<u8>,
	/// No objects nearer than this to the edge of the selected layers, in meters.
	pub inset: f64,
	/// The density falls to 0 across this width inside the inset, in meters.
	pub feather: f64,
	/// Size of the clump noise in meters, and its strength from 0 (off) to 1.
	pub noise_scale: f64,
	pub noise: f64,
	/// Largest terrain slope in degrees.
	pub max_slope: f64,
	pub min_height: f64,
	pub max_height: f64,
	/// No objects below sea level (0 m).
	pub no_water: bool,
	/// Existing objects to keep away from: x, y (local meters) and radius.
	pub avoid: Vec<[f32; 3]>,
	/// Extra distance to the existing objects, in meters.
	pub gap: f64,
}

impl Default for Settings {
	fn default() -> Settings {
		Settings {
			weights: vec![1.0],
			density: 100.0,
			spacing: 3.0,
			random_yaw: true,
			scale: [1.0, 1.0],
			tilt: false,
			seed: 1,
			colors: Vec::new(),
			inset: 0.0,
			feather: 0.0,
			noise_scale: 50.0,
			noise: 0.0,
			max_slope: 90.0,
			min_height: -1e9,
			max_height: 1e9,
			no_water: true,
			avoid: Vec::new(),
			gap: 0.0,
		}
	}
}

/// One placed object. x and y are local meters (east, north). Angles in degrees.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placed {
	pub x: f32,
	pub y: f32,
	pub yaw: f32,
	pub pitch: f32,
	pub roll: f32,
	pub scale: f32,
	/// Index in `Settings::weights`.
	pub entry: u32,
}

/// Small random generator (SplitMix64).
struct Rng(u64);

impl Rng {
	fn next(&mut self) -> u64 {
		self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
		let mut z = self.0;
		z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
		z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
		z ^ (z >> 31)
	}
	/// 0 to 1, 1 not included.
	fn f(&mut self) -> f64 {
		(self.next() >> 11) as f64 / (1u64 << 53) as f64
	}
}

/// Value noise from 0 to 1 at a point (lattice units).
fn noise(seed: u64, x: f64, y: f64) -> f64 {
	let v = |i: i64, j: i64| Rng(seed ^ (i as u64).wrapping_mul(0x8CB9_2BA7_2F3D_8DD7) ^ (j as u64).wrapping_mul(0xD6E8_FEB8_6659_FD93)).f();
	let (i, j) = (x.floor(), y.floor());
	let s = |t: f64| t * t * (3.0 - 2.0 * t);
	let (u, w) = (s(x - i), s(y - j));
	let (i, j) = (i as i64, j as i64);
	(v(i, j) * (1.0 - u) + v(i + 1, j) * u) * (1.0 - w) + (v(i, j + 1) * (1.0 - u) + v(i + 1, j + 1) * u) * w
}

/// Height change for each meter to the east and to the north.
fn gradient(t: &Heights, x: f64, y: f64) -> (f64, f64) {
	// At the edge of the terrain, the step stays inside the terrain.
	let (c, mx, my) = (t.cellsize, (t.ncols - 1) as f64 * t.cellsize, (t.nrows - 1) as f64 * t.cellsize);
	let (x0, x1, y0, y1) = ((x - c).clamp(0.0, mx), (x + c).clamp(0.0, mx), (y - c).clamp(0.0, my), (y + c).clamp(0.0, my));
	((t.at(x1, y) - t.at(x0, y)) / (x1 - x0).max(1e-9), (t.at(x, y1) - t.at(x, y0)) / (y1 - y0).max(1e-9))
}

/// Squared distance transform in one line (Felzenszwalb and Huttenlocher). f is 0 or infinite (large).
fn edt_1d(f: &[f32], d: &mut [f32], v: &mut [usize], z: &mut [f32]) {
	let n = f.len();
	let mut k = 0;
	v[0] = 0;
	z[0] = f32::NEG_INFINITY;
	z[1] = f32::INFINITY;
	for q in 1..n {
		let mut s;
		// z[0] is minus infinity, so k does not go below 0.
		loop {
			let p = v[k];
			s = ((f[q] + (q * q) as f32) - (f[p] + (p * p) as f32)) / (2 * q - 2 * p) as f32;
			if s > z[k] {
				break;
			}
			k -= 1;
		}
		k += 1;
		v[k] = q;
		z[k] = s;
		z[k + 1] = f32::INFINITY;
	}
	k = 0;
	for (q, out) in d.iter_mut().enumerate().take(n) {
		while z[k + 1] < q as f32 {
			k += 1;
		}
		let p = v[k];
		*out = (q as f32 - p as f32).powi(2) + f[p];
	}
}

/// Distance in pixels from each pixel of the window to the nearest pixel that is not selected. Pixels outside the mask count as selected.
fn distance(mask: &Mask, sel: &[bool; 256], win: [i64; 4]) -> Vec<f32> {
	let (w, h) = ((win[2] - win[0]) as usize, (win[3] - win[1]) as usize);
	const BIG: f32 = 1e12;
	let mut g = vec![BIG; w * h];
	for y in 0..h {
		let my = win[1] + y as i64;
		if my < 0 || my >= mask.height as i64 {
			continue;
		}
		for x in 0..w {
			let mx = win[0] + x as i64;
			if mx >= 0 && mx < mask.width as i64 && !sel[mask.get(mx as u32, my as u32) as usize] {
				g[y * w + x] = 0.0;
			}
		}
	}
	let n = w.max(h);
	let (mut f, mut d, mut v, mut z) = (vec![0f32; n], vec![0f32; n], vec![0usize; n], vec![0f32; n + 1]);
	for x in 0..w {
		for y in 0..h {
			f[y] = g[y * w + x];
		}
		edt_1d(&f[..h], &mut d[..h], &mut v, &mut z);
		for y in 0..h {
			g[y * w + x] = d[y];
		}
	}
	for y in 0..h {
		f[..w].copy_from_slice(&g[y * w..(y + 1) * w]);
		edt_1d(&f[..w], &mut d[..w], &mut v, &mut z);
		for x in 0..w {
			g[y * w + x] = d[x].sqrt();
		}
	}
	g
}

/// Meters for each mask pixel (east, north), from the terrain size.
fn pixel_size(mask: &Mask, t: &Heights) -> (f64, f64) {
	(t.ncols as f64 * t.cellsize / mask.width as f64, t.nrows as f64 * t.cellsize / mask.height as f64)
}

fn selection(s: &Settings) -> [bool; 256] {
	let mut sel = [false; 256];
	for &c in &s.colors {
		sel[c as usize] = true;
	}
	sel
}

/// Expected object count before the rules: the area of the selected layers multiplied by the density.
pub fn estimate(mask: &Mask, t: &Heights, s: &Settings) -> f64 {
	let sel = selection(s);
	let (mx, my) = pixel_size(mask, t);
	let mut n = 0u64;
	for y in 0..mask.height {
		for x in 0..mask.width {
			n += sel[mask.get(x, y) as usize] as u64;
		}
	}
	n as f64 * mx * my / 10_000.0 * s.density
}

/// Result of a fill. `truncated` is true when the fill stopped at the object limit.
pub struct Report {
	pub objects: Vec<Placed>,
	pub truncated: bool,
}

/// Place the objects. The fill stops at `limit` objects.
pub fn run(mask: &Mask, t: &Heights, s: &Settings, limit: usize) -> Result<Report, String> {
	run_with(mask, t, s, limit, &mut |_| true)
}

/// The same as `run`, with progress and cancel (see `Progress`).
pub fn run_with(mask: &Mask, t: &Heights, s: &Settings, limit: usize, progress: crate::Progress) -> Result<Report, String> {
	let total: f64 = s.weights.iter().filter(|w| **w > 0.0).sum();
	if total <= 0.0 {
		return Err("the recipe has no model with a weight above 0".into());
	}
	if s.colors.is_empty() {
		return Err("select one or more mask layers".into());
	}
	if t.ncols < 2 || t.nrows < 2 {
		return Err("the terrain is too small".into());
	}
	let sel = selection(s);
	let (mx, my) = pixel_size(mask, t);
	let size_y = t.nrows as f64 * t.cellsize;
	// shortcut: the edge distance uses the east pixel size. Use both sizes if a map has pixels that are not square.
	let edge = s.inset.max(0.0) + s.feather.max(0.0);
	let margin = (edge / mx).ceil() as i64 + 1;
	let spacing = s.spacing.max(0.0);
	let mut grid: HashMap<(i32, i32), Vec<[f32; 2]>> = HashMap::new();
	let cell = |x: f64, y: f64, size: f64| ((x / size).floor() as i32, (y / size).floor() as i32);
	// Grid of the existing objects. The cell is the largest radius plus the gap, so 3 x 3 cells hold all objects in range.
	let avoid_cell = s.avoid.iter().map(|a| a[2] as f64).fold(0.0, f64::max) + s.gap.max(0.0) + 1.0;
	let mut avoid: HashMap<(i32, i32), Vec<[f32; 3]>> = HashMap::new();
	for a in &s.avoid {
		avoid.entry(cell(a[0] as f64, a[1] as f64, avoid_cell)).or_default().push(*a);
	}
	let near = |map: &HashMap<(i32, i32), Vec<[f32; 2]>>, x: f64, y: f64| {
		let (cx, cy) = cell(x, y, spacing);
		(-1..=1).any(|i| {
			(-1..=1).any(|j| {
				map.get(&(cx + i, cy + j))
					.is_some_and(|v| v.iter().any(|p| (p[0] as f64 - x).powi(2) + (p[1] as f64 - y).powi(2) < spacing * spacing))
			})
		})
	};
	let blocked = |x: f64, y: f64| {
		let (cx, cy) = cell(x, y, avoid_cell);
		(-1..=1).any(|i| (-1..=1).any(|j| avoid.get(&(cx + i, cy + j)).is_some_and(|v| v.iter().any(|a| (a[0] as f64 - x).hypot(a[1] as f64 - y) < a[2] as f64 + s.gap))))
	};
	let max_slope = s.max_slope.clamp(0.0, 90.0).to_radians().tan();
	let mut out = Vec::new();
	let (cols, rows) = (mask.width.div_ceil(TILE), mask.height.div_ceil(TILE));
	for ty in 0..rows {
		if !progress(ty as f64 / rows as f64) {
			return Err(crate::CANCELLED.into());
		}
		for tx in 0..cols {
			let r = [tx * TILE, ty * TILE, ((tx + 1) * TILE).min(mask.width), ((ty + 1) * TILE).min(mask.height)];
			let any = (r[1]..r[3]).any(|y| (r[0]..r[2]).any(|x| sel[mask.get(x, y) as usize]));
			if !any {
				continue;
			}
			let win = [r[0] as i64 - margin, r[1] as i64 - margin, r[2] as i64 + margin, r[3] as i64 + margin];
			let dist = (edge > 0.0).then(|| distance(mask, &sel, win));
			let ww = (win[2] - win[0]) as usize;
			let mut rng = Rng(s.seed ^ ((ty * cols + tx) as u64 + 1).wrapping_mul(0xA24B_AED4_963E_E407));
			let (tw, th) = ((r[2] - r[0]) as f64, (r[3] - r[1]) as f64);
			let n = s.density.max(0.0) / 10_000.0 * tw * mx * th * my;
			let count = n.floor() as u64 + (rng.f() < n.fract()) as u64;
			'candidate: for _ in 0..count {
				// The first position decides if the candidate counts (area, rules, feather, noise). A candidate that is too near to another
				// object of the fill then looks for a free position that obeys the area and the rules. So the density does not fall in tiles
				// that are only partly selected.
				for attempt in 0..30 {
					let first = attempt == 0;
					let fx = r[0] as f64 + rng.f() * tw;
					let fy = r[1] as f64 + rng.f() * th;
					let (px, py) = (fx as u32, fy as u32);
					if !sel[mask.get(px, py) as usize] {
						if first {
							continue 'candidate;
						}
						continue;
					}
					let (x, y) = (fx * mx, size_y - fy * my);
					let mut p = 1.0;
					if let Some(d) = &dist {
						let d = d[(py as i64 - win[1]) as usize * ww + (px as i64 - win[0]) as usize] as f64 * mx;
						if d < s.inset {
							if first {
								continue 'candidate;
							}
							continue;
						}
						if s.feather > 0.0 && d < s.inset + s.feather {
							p *= (d - s.inset) / s.feather;
						}
					}
					if s.noise > 0.0 {
						p *= 1.0 - s.noise.min(1.0) * (1.0 - noise(s.seed, x / s.noise_scale.max(1.0), y / s.noise_scale.max(1.0)));
					}
					if p < 1.0 && rng.f() >= p {
						if first {
							continue 'candidate;
						}
						continue;
					}
					let h = t.at(x, y);
					let (gx, gy) = gradient(t, x, y);
					if h < s.min_height || h > s.max_height || (s.no_water && h < 0.0) || gx.hypot(gy) > max_slope || blocked(x, y) {
						if first {
							continue 'candidate;
						}
						continue;
					}
					if spacing > 0.0 && near(&grid, x, y) {
						continue;
					}
					let mut pick = rng.f() * total;
					let entry = s.weights.iter().position(|&w| {
						let w = w.max(0.0);
						if pick < w {
							return true;
						}
						pick -= w;
						false
					});
					let entry = entry.unwrap_or_else(|| s.weights.iter().rposition(|&w| w > 0.0).unwrap()) as u32;
					let yaw = if s.random_yaw { rng.f() * 360.0 } else { 0.0 };
					let scale = s.scale[0] + rng.f() * (s.scale[1] - s.scale[0]);
					let (mut pitch, mut roll) = (0.0, 0.0);
					if s.tilt {
						// Positive pitch lifts the front (dir), positive roll lowers the right side (aside). See axes() in transform.ts.
						let a = yaw.to_radians();
						pitch = (gx * a.sin() + gy * a.cos()).atan().to_degrees();
						roll = -(gx * a.cos() - gy * a.sin()).atan().to_degrees();
					}
					if spacing > 0.0 {
						grid.entry(cell(x, y, spacing)).or_default().push([x as f32, y as f32]);
					}
					out.push(Placed {
						x: x as f32,
						y: y as f32,
						yaw: yaw as f32,
						pitch: pitch as f32,
						roll: roll as f32,
						scale: scale as f32,
						entry,
					});
					if out.len() >= limit {
						return Ok(Report { objects: out, truncated: true });
					}
					continue 'candidate;
				}
			}
		}
	}
	Ok(Report { objects: out, truncated: false })
}

#[cfg(test)]
mod tests {
	use super::*;
	fn flat(n: usize, cell: f64, f: impl Fn(f64, f64) -> f32) -> Heights {
		let mut data = Vec::with_capacity(n * n);
		for r in 0..n {
			for c in 0..n {
				// Row 0 is the north row.
				data.push(f(c as f64 * cell, (n - 1 - r) as f64 * cell));
			}
		}
		Heights::from_asc(&crate::asc::Asc {
			header: Vec::new(),
			ncols: n,
			nrows: n,
			xll: 0.0,
			yll: 0.0,
			cellsize: cell,
			nodata: -9999.0,
			data,
		})
	}
	fn colors() -> Vec<[u8; 3]> {
		vec![[0, 0, 0], [0, 255, 0]]
	}
	fn settings() -> Settings {
		Settings {
			colors: vec![1],
			density: 400.0,
			spacing: 2.0,
			weights: vec![1.0, 3.0],
			..Default::default()
		}
	}
	#[test]
	fn same_seed_gives_the_same_result_and_spacing_holds() {
		// 1024 m map, 1 m pixels. The east half is layer 1.
		let m = Mask::from_fn(1024, 1024, colors(), |x, _| (x >= 512) as u8);
		let t = flat(256, 4.0, |_, _| 10.0);
		let a = run(&m, &t, &settings(), usize::MAX).unwrap().objects;
		let b = run(&m, &t, &settings(), usize::MAX).unwrap().objects;
		assert_eq!(a, b);
		let c = run(&m, &t, &Settings { seed: 2, ..settings() }, usize::MAX).unwrap().objects;
		assert_ne!(a, c);
		// 52.4 ha with 400 for each hectare.
		let target = 512.0 * 1024.0 / 10_000.0 * 400.0;
		assert!((a.len() as f64 - target).abs() / target < 0.05, "{} objects, target {target}", a.len());
		assert!(a.iter().all(|p| p.x >= 512.0 && p.x < 1024.0));
		// Spacing: check each pair in a grid of 2 m cells.
		let mut g: HashMap<(i32, i32), Vec<Placed>> = HashMap::new();
		for p in &a {
			g.entry(((p.x / 2.0).floor() as i32, (p.y / 2.0).floor() as i32)).or_default().push(*p);
		}
		for p in &a {
			let (cx, cy) = ((p.x / 2.0).floor() as i32, (p.y / 2.0).floor() as i32);
			for i in -1..=1 {
				for j in -1..=1 {
					for q in g.get(&(cx + i, cy + j)).into_iter().flatten() {
						assert!(q == p || (p.x - q.x).hypot(p.y - q.y) >= 2.0);
					}
				}
			}
		}
		// The weights 1 and 3 give about 25% of model 0.
		let share = a.iter().filter(|p| p.entry == 0).count() as f64 / a.len() as f64;
		assert!((share - 0.25).abs() < 0.02, "{share}");
		assert_eq!(estimate(&m, &t, &settings()), target);
		let cut = run(&m, &t, &settings(), 100).unwrap();
		assert!(cut.truncated && cut.objects.len() == 100);
	}
	#[test]
	fn inset_feather_height_slope_water_and_avoid() {
		let m = Mask::from_fn(512, 512, colors(), |x, _| (x >= 100) as u8);
		let t = flat(128, 4.0, |_, _| 10.0);
		let s = Settings { inset: 20.0, feather: 30.0, ..settings() };
		let a = run(&m, &t, &s, usize::MAX).unwrap().objects;
		// The edge is at x = 100 m. Allow half a pixel for the pixel centre.
		assert!(a.iter().all(|p| p.x >= 119.5), "{:?}", a.iter().map(|p| p.x).fold(f32::MAX, f32::min));
		let band = |lo: f32, hi: f32| a.iter().filter(|p| p.x >= lo && p.x < hi).count() as f64;
		// Inside the feather the density is lower than after it.
		assert!(band(120.0, 135.0) < band(200.0, 215.0) * 0.5);
		// Height: the terrain goes from 0 m (west) to 51.1 m (east) on the 512 m map.
		let slope = flat(128, 4.0, |x, _| (x * 0.1) as f32);
		let h = run(
			&m,
			&slope,
			&Settings {
				min_height: 20.0,
				max_height: 30.0,
				..settings()
			},
			usize::MAX,
		)
		.unwrap()
		.objects;
		assert!(!h.is_empty() && h.iter().all(|p| p.x >= 199.0 && p.x <= 301.0));
		// Slope 0.1 is 5.7 degrees.
		assert!(run(&m, &slope, &Settings { max_slope: 5.0, ..settings() }, usize::MAX).unwrap().objects.is_empty());
		assert!(!run(&m, &slope, &Settings { max_slope: 6.0, ..settings() }, usize::MAX).unwrap().objects.is_empty());
		// Water: the terrain is below 0 m west of x = 300.
		let sea = flat(128, 4.0, |x, _| (x - 300.0) as f32);
		assert!(run(&m, &sea, &settings(), usize::MAX).unwrap().objects.iter().all(|p| p.x >= 299.0));
		// An existing object at (300, 300) with radius 10 and a gap of 5 m.
		let v = run(
			&m,
			&t,
			&Settings {
				avoid: vec![[300.0, 300.0, 10.0]],
				gap: 5.0,
				..settings()
			},
			usize::MAX,
		)
		.unwrap()
		.objects;
		assert!(v.iter().all(|p| (p.x - 300.0).hypot(p.y - 300.0) >= 15.0));
	}
	#[test]
	fn polygon_area_fill() {
		// A triangle on a 512 m map with 1 m pixels. Pixel y is from the north: y = 512 - north meters.
		let ring = [[100.0, 100.0], [400.0, 100.0], [250.0, 400.0]];
		let m = Mask::polygon_mask(512, 512, &[ring.iter().map(|p| [p[0], 512.0 - p[1]]).collect()]);
		let t = flat(128, 4.0, |_, _| 10.0);
		let s = Settings { colors: vec![1], ..settings() };
		let a = run(&m, &t, &s, usize::MAX).unwrap().objects;
		assert_eq!(a, run(&m, &t, &s, usize::MAX).unwrap().objects);
		// Counter-clockwise triangle: inside when each edge has the point on its left. The tolerance is one pixel (times the edge length).
		let inside = |x: f64, y: f64| {
			let e = |a: [f64; 2], b: [f64; 2]| (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) >= -340.0;
			e(ring[0], ring[1]) && e(ring[1], ring[2]) && e(ring[2], ring[0])
		};
		assert!(a.iter().all(|p| inside(p.x as f64, p.y as f64)));
		// Area 45000 m2 = 4.5 ha with 400 for each hectare.
		assert!(
			(a.len() as f64 - 1800.0).abs() < 1800.0 * 0.06,
			"{} objects, estimate {}, pixels {}",
			a.len(),
			estimate(&m, &t, &s),
			m.region(0, 0, 0, 512, 512).iter().filter(|&&v| v == 1).count()
		);
	}
	#[test]
	fn tilt_follows_the_slope() {
		let m = Mask::from_fn(512, 512, colors(), |_, _| 1);
		// The terrain goes up to the east.
		let t = flat(128, 4.0, |x, _| (x * 0.2) as f32);
		let a = run(&m, &t, &Settings { tilt: true, ..settings() }, usize::MAX).unwrap().objects;
		let slope = 0.2f32.atan().to_degrees();
		for p in a.iter().take(50) {
			// Front to the east (yaw 90): the front goes up. Front to the north (yaw 0): the right side (east) goes up, so the roll is negative.
			let y = p.yaw.to_radians();
			assert!((p.pitch - (0.2 * y.sin()).atan().to_degrees()).abs() < 0.01);
			assert!((p.roll + (0.2 * y.cos()).atan().to_degrees()).abs() < 0.01);
			assert!(p.pitch.abs() <= slope + 0.01);
		}
	}
	#[test]
	fn distance_transform_is_exact() {
		let m = Mask::from_fn(64, 64, colors(), |x, y| !(x == 10 && y == 20) as u8);
		let d = distance(&m, &[false, true].iter().chain([false; 254].iter()).copied().collect::<Vec<_>>().try_into().unwrap(), [0, 0, 64, 64]);
		assert_eq!(d[20 * 64 + 10], 0.0);
		assert_eq!(d[24 * 64 + 13], 5.0);
		assert_eq!(d[20 * 64 + 40], 30.0);
	}
}
