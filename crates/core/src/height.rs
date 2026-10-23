//! Heightmap for editing: one f32 for each cell in a tile store (4 bytes for each pixel, see tilestore.rs). Row 0 is the north row (the ASC order).
//! Positions of the tools are local meters (x east, y north, from the south-west corner): cell (c, r) is at x = c * cellsize,
//! y = (nrows - 1 - r) * cellsize, as in the 3D view.
//! The ASC export writes each row that did not change with its original text, so a round trip without edits gives the same bytes.
use crate::asc::{self, Asc};
use crate::tiles::Rows;
pub use crate::tilestore::Rect;
use crate::tilestore::{write_atomic, Builder, Store, TILE};
use std::io::{BufWriter, Write};
use std::path::Path;
use std::sync::Arc;

/// The text of the source ASC: the header, the byte range of each row (with its line end), and the text after the last row.
struct Source {
	text: String,
	header_end: usize,
	rows: Vec<(usize, usize)>,
	tail: usize,
	nl: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Tool {
	/// Add `strength` meters at the brush centre for each dab.
	Raise,
	Lower,
	/// Blend to the mean of the 3 x 3 cells. Strength 0 to 1.
	Smooth,
	/// Blend to this height. Strength 0 to 1.
	Flatten(f32),
	/// Blend to the plane through two points (x, y, height in meters). The plane is level across the line from the first point to the second.
	Plane([f64; 3], [f64; 3]),
	/// Add value noise of this size in meters. Strength is the amplitude in meters for each dab.
	Noise(f64, u32),
}

#[derive(Debug, Clone, Copy)]
pub struct Brush {
	/// Radius in meters.
	pub radius: f64,
	/// 0 to 1. The part of the radius with full strength. The rest falls smoothly to 0.
	pub hardness: f64,
	pub strength: f64,
	pub tool: Tool,
}

/// Height image for the stamp tool: values from 0 to 1.
pub struct Stamp {
	pub width: usize,
	pub height: usize,
	pub v: Vec<f32>,
}

impl Stamp {
	/// Read a PNG or a 24-bit BMP. The value is the mean of red, green, and blue.
	pub fn load(path: &Path) -> Result<Stamp, String> {
		let mut rows = Rows::open(path)?;
		let (w, h) = (rows.width as usize, rows.height as usize);
		let mut v = Vec::with_capacity(w * h);
		for y in 0..h as u32 {
			rows.fill_to(y)?;
			v.extend(rows.row(y).chunks_exact(3).map(|p| (p[0] as f32 + p[1] as f32 + p[2] as f32) / 765.0));
			rows.drop_before(y + 1);
		}
		Ok(Stamp { width: w, height: h, v })
	}
	/// Bilinear value at (u, v) from 0 to 1. Outside is 0.
	fn at(&self, u: f64, v: f64) -> f64 {
		if !(0.0..=1.0).contains(&u) || !(0.0..=1.0).contains(&v) {
			return 0.0;
		}
		let (fx, fy) = (u * (self.width - 1) as f64, v * (self.height - 1) as f64);
		let (x0, y0) = ((fx as usize).min(self.width.saturating_sub(2)), (fy as usize).min(self.height.saturating_sub(2)));
		let (x1, y1) = ((x0 + 1).min(self.width - 1), (y0 + 1).min(self.height - 1));
		let (ax, ay) = (fx - x0 as f64, fy - y0 as f64);
		let p = |x: usize, y: usize| self.v[y * self.width + x] as f64;
		(p(x0, y0) * (1.0 - ax) + p(x1, y0) * ax) * (1.0 - ay) + (p(x0, y1) * (1.0 - ax) + p(x1, y1) * ax) * ay
	}
}

/// Strength from 1 (centre and hard part) to 0 (edge) with a smooth curve. d is 0 to 1 of the radius.
fn falloff(d: f64, hard: f64) -> f64 {
	if d >= 1.0 {
		return 0.0;
	}
	if d <= hard {
		return 1.0;
	}
	let t = (d - hard) / (1.0 - hard);
	1.0 - t * t * (3.0 - 2.0 * t)
}

/// Value noise from -1 to 1 (lattice units).
fn noise(seed: u32, x: f64, y: f64) -> f64 {
	let v = |i: i64, j: i64| crate::mask::rnd(i as u32, j as u32, seed);
	let (i, j) = (x.floor(), y.floor());
	let s = |t: f64| t * t * (3.0 - 2.0 * t);
	let (u, w) = (s(x - i), s(y - j));
	let (i, j) = (i as i64, j as i64);
	((v(i, j) * (1.0 - u) + v(i + 1, j) * u) * (1.0 - w) + (v(i, j + 1) * (1.0 - u) + v(i + 1, j + 1) * u) * w) * 2.0 - 1.0
}

pub struct Heights {
	pub ncols: usize,
	pub nrows: usize,
	pub xll: f64,
	pub yll: f64,
	pub cellsize: f64,
	pub nodata: f64,
	/// The header lines (for an export without a source text).
	pub header: Vec<String>,
	/// Decimal places of the values in the source, or 2.
	pub decimals: usize,
	pub s: Store,
	source: Option<Source>,
}

fn build(ncols: usize, nrows: usize, data: &[f32]) -> Store {
	let mut b = Builder::new(ncols as u32, nrows as u32, 4);
	let mut row = vec![0u8; ncols * 4];
	for (r, vals) in data.chunks(ncols).enumerate() {
		for (c, v) in vals.iter().enumerate() {
			row[c * 4..c * 4 + 4].copy_from_slice(&v.to_le_bytes());
		}
		b.row(r as u32, &row);
	}
	b.finish()
}

impl Heights {
	/// Heights without a source text (for example from a WRP). The export formats all rows.
	pub fn from_asc(a: &Asc) -> Heights {
		Heights {
			ncols: a.ncols,
			nrows: a.nrows,
			xll: a.xll,
			yll: a.yll,
			cellsize: a.cellsize,
			nodata: a.nodata,
			header: a.header.clone(),
			decimals: 2,
			s: build(a.ncols, a.nrows, &a.data),
			source: None,
		}
	}
	/// Read the text of an ASC file. The export keeps the rows that do not change.
	pub fn parse(text: String) -> Result<Heights, String> {
		let a = asc::parse(&text)?;
		let mut h = Heights::from_asc(&a);
		// Line starts. The ASC has 6 header lines, then one line for each row.
		let mut starts = vec![0usize];
		starts.extend(text.match_indices('\n').map(|(i, _)| i + 1));
		if starts.len() < 7 + a.nrows {
			starts.push(text.len());
		}
		let rows: Vec<(usize, usize)> = (0..a.nrows).map(|r| (starts[6 + r], starts[7 + r].min(text.len()))).collect();
		let nl = if text[..starts[1]].ends_with("\r\n") { "\r\n" } else { "\n" };
		let first = text[rows[0].0..rows[0].1].split_whitespace().next().unwrap_or("");
		h.decimals = first.split_once('.').map_or(0, |(_, d)| d.len());
		h.source = Some(Source {
			header_end: starts[6],
			tail: rows[a.nrows - 1].1,
			rows,
			nl,
			text,
		});
		Ok(h)
	}
	/// Load heights that were saved (`save_bin`) on top of their source. The source stays the base for the export.
	pub fn with_values(mut self, data: &[f32]) -> Result<Heights, String> {
		if data.len() != self.ncols * self.nrows {
			return Err(format!("the heights have {} values, the ASC has {} x {}", data.len(), self.ncols, self.nrows));
		}
		let cur = build(self.ncols, self.nrows, data);
		// Tiles with the same values as the source keep sharing memory with it.
		let tiles = cur.tiles.iter().zip(&self.s.orig).map(|(c, o)| if c == o { o.clone() } else { c.clone() }).collect();
		self.s.tiles = tiles;
		Ok(self)
	}
	pub fn get(&self, c: usize, r: usize) -> f32 {
		let p = self.s.get(c as u32, r as u32);
		f32::from_le_bytes([p[0], p[1], p[2], p[3]])
	}
	/// All values, row by row (row 0 is the north row).
	pub fn values(&self) -> Vec<f32> {
		self.region(0, 0, self.ncols, self.nrows)
	}
	/// Values of a rectangle of cells, row by row.
	pub fn region(&self, c0: usize, r0: usize, w: usize, h: usize) -> Vec<f32> {
		let mut out = Vec::with_capacity(w * h);
		for r in r0..(r0 + h).min(self.nrows) {
			for c in c0..(c0 + w).min(self.ncols) {
				out.push(self.get(c, r));
			}
		}
		out
	}
	/// Height at local meters (bilinear), the same as the 3D view. Points outside use the nearest edge.
	pub fn at(&self, x: f64, y: f64) -> f64 {
		let fx = (x / self.cellsize).clamp(0.0, (self.ncols - 1) as f64);
		let fy = (y / self.cellsize).clamp(0.0, (self.nrows - 1) as f64);
		let x0 = (fx.floor() as usize).min(self.ncols - 2);
		let y0 = (fy.floor() as usize).min(self.nrows - 2);
		let (ax, ay) = (fx - x0 as f64, fy - y0 as f64);
		let h = |c: usize, r: usize| self.get(c, self.nrows - 1 - r) as f64;
		(h(x0, y0) * (1.0 - ax) + h(x0 + 1, y0) * ax) * (1.0 - ay) + (h(x0, y0 + 1) * (1.0 - ax) + h(x0 + 1, y0 + 1) * ax) * ay
	}
	/// Set the cells, then keep the changed area for undo. Returns the changed area in cells.
	fn write(&mut self, writes: Vec<(usize, usize, f32)>) -> Option<Rect> {
		let mut dirty: Option<Rect> = None;
		for (c, r, v) in writes {
			let (t, o) = self.s.index(c as u32, r as u32);
			let b = v.to_le_bytes();
			if self.s.tiles[t][o * 4..o * 4 + 4] != b {
				self.s.tile_mut(t)[o * 4..o * 4 + 4].copy_from_slice(&b);
				let (c, r) = (c as u32, r as u32);
				dirty = Some(dirty.map_or([c, r, c + 1, r + 1], |d| [d[0].min(c), d[1].min(r), d[2].max(c + 1), d[3].max(r + 1)]));
			}
		}
		if let Some(d) = dirty {
			self.s.mark(d);
		}
		dirty
	}
	/// Cells in a circle around local meters: column, row, position, and the strength of the falloff.
	fn cells(&self, cx: f64, cy: f64, radius: f64, hard: f64) -> Vec<(usize, usize, f64, f64, f64)> {
		let cs = self.cellsize;
		let top = (self.nrows - 1) as f64;
		let (c0, c1) = (((cx - radius) / cs).floor().max(0.0) as usize, (((cx + radius) / cs).ceil().max(0.0) as usize).min(self.ncols - 1));
		let (y0, y1) = (((cy - radius) / cs).floor().max(0.0), ((cy + radius) / cs).ceil().min(top));
		let mut out = Vec::new();
		if y0 > y1 || c0 > c1 {
			return out;
		}
		for ry in y0 as usize..=y1 as usize {
			let (y, r) = (ry as f64 * cs, (top as usize) - ry);
			for c in c0..=c1 {
				let x = c as f64 * cs;
				let w = falloff(((x - cx).powi(2) + (y - cy).powi(2)).sqrt() / radius.max(1e-9), hard);
				if w > 0.0 {
					out.push((c, r, x, y, w));
				}
			}
		}
		out
	}
	/// One dab of a brush at local meters. Returns the changed area in cells.
	pub fn dab(&mut self, cx: f64, cy: f64, b: &Brush) -> Option<Rect> {
		let hard = b.hardness.clamp(0.0, 1.0);
		let k = b.strength;
		let nodata = self.nodata as f32;
		// Read first, then write: smooth reads the cells before this dab.
		let writes = self
			.cells(cx, cy, b.radius, hard)
			.into_iter()
			.filter_map(|(c, r, x, y, w)| {
				let h = self.get(c, r);
				if h == nodata {
					return None;
				}
				let target = |t: f64| (h as f64 + (t - h as f64) * (w * k).clamp(0.0, 1.0)) as f32;
				let v = match b.tool {
					Tool::Raise => (h as f64 + k * w) as f32,
					Tool::Lower => (h as f64 - k * w) as f32,
					Tool::Flatten(t) => target(t as f64),
					Tool::Plane(a, z) => {
						let (dx, dy) = (z[0] - a[0], z[1] - a[1]);
						let len2 = (dx * dx + dy * dy).max(1e-9);
						let t = ((x - a[0]) * dx + (y - a[1]) * dy) / len2;
						target(a[2] + (z[2] - a[2]) * t)
					}
					Tool::Smooth => {
						let mut sum = 0.0;
						for j in -1..=1i64 {
							for i in -1..=1i64 {
								let cc = (c as i64 + i).clamp(0, self.ncols as i64 - 1) as usize;
								let rr = (r as i64 + j).clamp(0, self.nrows as i64 - 1) as usize;
								sum += self.get(cc, rr) as f64;
							}
						}
						target(sum / 9.0)
					}
					Tool::Noise(size, seed) => (h as f64 + k * w * noise(seed, x / size.max(1e-6), y / size.max(1e-6))) as f32,
				};
				Some((c, r, v))
			})
			.collect();
		self.write(writes)
	}
	/// Dabs along a line, a quarter of the radius apart.
	pub fn line(&mut self, a: [f64; 2], z: [f64; 2], b: &Brush) -> Option<Rect> {
		crate::mask::line(a, z, b.radius, |x, y| self.dab(x, y, b))
	}
	/// Put a stamp at local meters. It covers `size` x `size` meters. Each cell gets `height` meters times the stamp value:
	/// added, or (`max`) the higher of the cell and the base height plus the stamp. This is one undo step.
	#[allow(clippy::too_many_arguments)]
	pub fn stamp(&mut self, cx: f64, cy: f64, st: &Stamp, size: f64, height: f64, max: bool, base: f64) -> Option<Rect> {
		self.end_step();
		let half = size / 2.0;
		let writes = self
			.cells(cx, cy, half * std::f64::consts::SQRT_2 + self.cellsize, 1.0)
			.into_iter()
			.filter_map(|(c, r, x, y, _)| {
				let s = st.at((x - cx + half) / size, (cy + half - y) / size);
				let h = self.get(c, r) as f64;
				if s <= 0.0 || h == self.nodata {
					return None;
				}
				Some((c, r, if max { h.max(base + s * height) } else { h + s * height } as f32))
			})
			.collect();
		let r = self.write(writes);
		self.end_step();
		r
	}
	/// Flatten the cells inside a polygon (local meters) to a height (None: the mean of the cells inside). Outside the polygon,
	/// the change falls smoothly to 0 across `feather` meters. This is one undo step.
	pub fn flatten_polygon(&mut self, ring: &[[f64; 2]], target: Option<f64>, feather: f64) -> Option<Rect> {
		self.end_step();
		if ring.len() < 3 {
			return None;
		}
		let inside = |p: [f64; 2]| {
			let mut c = false;
			for (i, a) in ring.iter().enumerate() {
				let z = ring[(i + 1) % ring.len()];
				if (a[1] > p[1]) != (z[1] > p[1]) && p[0] < a[0] + (p[1] - a[1]) / (z[1] - a[1]) * (z[0] - a[0]) {
					c = !c;
				}
			}
			c
		};
		let edge = |p: [f64; 2]| (0..ring.len()).map(|i| crate::mask::seg_dist(p, ring[i], ring[(i + 1) % ring.len()]).0).fold(f64::MAX, f64::min);
		let (lo, hi) = ring
			.iter()
			.fold(([f64::MAX; 2], [f64::MIN; 2]), |(lo, hi), p| ([lo[0].min(p[0]), lo[1].min(p[1])], [hi[0].max(p[0]), hi[1].max(p[1])]));
		let f = feather.max(0.0);
		let r = ((hi[0] - lo[0]).max(hi[1] - lo[1]) / 2.0 + f) * std::f64::consts::SQRT_2 + self.cellsize;
		let cells = self.cells((lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0, r, 1.0);
		let mut weights = Vec::new();
		let (mut sum, mut n) = (0.0, 0usize);
		for (c, row, x, y, _) in cells {
			let h = self.get(c, row) as f64;
			if h == self.nodata {
				continue;
			}
			if inside([x, y]) {
				sum += h;
				n += 1;
				weights.push((c, row, h, 1.0));
			} else if f > 0.0 {
				let d = edge([x, y]);
				if d < f {
					let t = d / f;
					weights.push((c, row, h, 1.0 - t * t * (3.0 - 2.0 * t)));
				}
			}
		}
		let t = target.unwrap_or(if n > 0 { sum / n as f64 } else { return None });
		let r = self.write(weights.into_iter().map(|(c, row, h, w)| (c, row, (h + (t - h) * w) as f32)).collect());
		self.end_step();
		r
	}
	/// Cut or fill the terrain along a line (local meters), for a road or a runway. The target height is the terrain on the centre
	/// line, smoothed along the line with a mean over `smooth` meters. Full change inside `width` / 2, then a smooth fall across `feather`.
	/// This is one undo step.
	pub fn road(&mut self, line: &[[f64; 2]], width: f64, feather: f64, smooth: f64) -> Option<Rect> {
		self.end_step();
		if line.len() < 2 {
			return None;
		}
		// Centre profile: one sample each cell along the line (distance from the start, height).
		let mut prof: Vec<(f64, f64)> = Vec::new();
		let mut at = vec![0.0];
		for w in line.windows(2) {
			let len = ((w[1][0] - w[0][0]).powi(2) + (w[1][1] - w[0][1]).powi(2)).sqrt();
			let n = (len / self.cellsize).ceil().max(1.0) as usize;
			let s0 = *at.last().unwrap();
			for i in 0..n {
				let t = i as f64 / n as f64;
				prof.push((s0 + len * t, self.at(w[0][0] + (w[1][0] - w[0][0]) * t, w[0][1] + (w[1][1] - w[0][1]) * t)));
			}
			at.push(s0 + len);
		}
		let z = line[line.len() - 1];
		prof.push((*at.last().unwrap(), self.at(z[0], z[1])));
		let half = smooth.max(0.0) / 2.0;
		let (mut a, mut b, mut sum) = (0usize, 0usize, 0.0);
		let smoothed: Vec<f64> = (0..prof.len())
			.map(|i| {
				while b < prof.len() && prof[b].0 <= prof[i].0 + half {
					sum += prof[b].1;
					b += 1;
				}
				while prof[a].0 < prof[i].0 - half {
					sum -= prof[a].1;
					a += 1;
				}
				sum / (b - a) as f64
			})
			.collect();
		let target = |s: f64| {
			let k = prof.partition_point(|p| p.0 <= s).clamp(1, prof.len() - 1);
			let (p0, p1) = (prof[k - 1], prof[k]);
			let t = if p1.0 > p0.0 { ((s - p0.0) / (p1.0 - p0.0)).clamp(0.0, 1.0) } else { 0.0 };
			smoothed[k - 1] + (smoothed[k] - smoothed[k - 1]) * t
		};
		let (w2, f) = (width.max(0.0) / 2.0, feather.max(0.0));
		// The nearest segment for each cell: distance and distance along the line.
		let mut best: std::collections::HashMap<(usize, usize), (f64, f64)> = std::collections::HashMap::new();
		for (i, w) in line.windows(2).enumerate() {
			let len = at[i + 1] - at[i];
			let mid = [(w[0][0] + w[1][0]) / 2.0, (w[0][1] + w[1][1]) / 2.0];
			for (c, row, x, y, _) in self.cells(mid[0], mid[1], len / 2.0 + w2 + f + self.cellsize, 1.0) {
				let (d, t) = crate::mask::seg_dist([x, y], w[0], w[1]);
				if d < w2 + f || d <= w2 {
					let e = best.entry((c, row)).or_insert((f64::MAX, 0.0));
					if d < e.0 {
						*e = (d, at[i] + len * t);
					}
				}
			}
		}
		let writes = best
			.into_iter()
			.filter_map(|((c, row), (d, s))| {
				let h = self.get(c, row) as f64;
				if h == self.nodata {
					return None;
				}
				let k = if d <= w2 {
					1.0
				} else {
					let t = (d - w2) / f;
					1.0 - t * t * (3.0 - 2.0 * t)
				};
				Some((c, row, (h + (target(s) - h) * k) as f32))
			})
			.collect();
		let r = self.write(writes);
		self.end_step();
		r
	}
	/// Add `dh` meters to all heights (not to NODATA cells), for example to move the sea level. This is one undo step.
	pub fn offset(&mut self, dh: f32) -> Option<Rect> {
		self.end_step();
		if dh == 0.0 || !dh.is_finite() {
			return None;
		}
		let nodata = self.nodata as f32;
		for t in 0..self.s.tiles.len() {
			for v in self.s.tile_mut(t).chunks_exact_mut(4) {
				let h = f32::from_le_bytes([v[0], v[1], v[2], v[3]]);
				if h != nodata {
					v.copy_from_slice(&(h + dh).to_le_bytes());
				}
			}
		}
		let r = [0, 0, self.ncols as u32, self.nrows as u32];
		self.s.mark(r);
		self.end_step();
		Some(r)
	}
	pub fn end_step(&mut self) {
		self.s.end_step();
	}
	pub fn undo(&mut self) -> Option<Rect> {
		self.s.undo()
	}
	pub fn redo(&mut self) -> Option<Rect> {
		self.s.redo()
	}
	/// True when row r has the values of the source.
	fn row_unchanged(&self, r: usize) -> bool {
		let ty = r / TILE as usize;
		let o = (r % TILE as usize) * TILE as usize * 4;
		(0..self.s.cols as usize).all(|tx| {
			let t = ty * self.s.cols as usize + tx;
			let (cur, orig) = (&self.s.tiles[t], &self.s.orig[t]);
			Arc::ptr_eq(cur, orig) || cur[o..o + TILE as usize * 4] == orig[o..o + TILE as usize * 4]
		})
	}
	/// Write the ASC. Rows without a change keep the text of the source. Other rows have `decimals` decimal places (None: as in the source).
	/// The tool writes a temporary file first, then renames it.
	pub fn export_asc(&self, path: &Path, decimals: Option<usize>) -> Result<(), String> {
		let err = |e: &dyn std::fmt::Display| format!("{}: {e}", path.display());
		let dec = decimals.unwrap_or(self.decimals);
		let tmp = path.with_extension("tmp.asc");
		{
			let mut w = BufWriter::with_capacity(1 << 20, std::fs::File::create(&tmp).map_err(|e| err(&e))?);
			let nl = self.source.as_ref().map_or("\n", |s| s.nl);
			match &self.source {
				Some(s) => w.write_all(&s.text.as_bytes()[..s.header_end]),
				None => w.write_all(self.header.iter().map(|h| format!("{h}{nl}")).collect::<String>().as_bytes()),
			}
			.map_err(|e| err(&e))?;
			let mut line = String::new();
			for r in 0..self.nrows {
				if let Some(s) = self.source.as_ref().filter(|_| self.row_unchanged(r)) {
					w.write_all(&s.text.as_bytes()[s.rows[r].0..s.rows[r].1]).map_err(|e| err(&e))?;
					continue;
				}
				line.clear();
				for c in 0..self.ncols {
					if c > 0 {
						line.push(' ');
					}
					use std::fmt::Write as _;
					let _ = write!(line, "{:.dec$}", self.get(c, r));
				}
				line.push_str(nl);
				w.write_all(line.as_bytes()).map_err(|e| err(&e))?;
			}
			if let Some(s) = &self.source {
				w.write_all(&s.text.as_bytes()[s.tail..]).map_err(|e| err(&e))?;
			}
			w.flush().map_err(|e| err(&e))?;
		}
		std::fs::rename(&tmp, path).map_err(|e| err(&e))
	}
	/// Save into a project folder: `source.asc` (the source text, written when the folder does not have it) and `heights.bin`
	/// (magic `TTH1`, ncols u32, nrows u32, xll, yll, cellsize, nodata f64, decimals u32, then the values as f32, row 0 north).
	pub fn save(&self, dir: &Path) -> Result<(), String> {
		let src = dir.join("source.asc");
		match &self.source {
			Some(s) if std::fs::metadata(&src).map_or(true, |m| m.len() != s.text.len() as u64) => write_atomic(&src, s.text.as_bytes())?,
			Some(_) => {}
			None => {
				let _ = std::fs::remove_file(&src);
			}
		}
		let mut b = Vec::with_capacity(48 + self.ncols * self.nrows * 4);
		b.extend(b"TTH1");
		b.extend((self.ncols as u32).to_le_bytes());
		b.extend((self.nrows as u32).to_le_bytes());
		for v in [self.xll, self.yll, self.cellsize, self.nodata] {
			b.extend(v.to_le_bytes());
		}
		b.extend((self.decimals as u32).to_le_bytes());
		for v in self.values() {
			b.extend(v.to_le_bytes());
		}
		write_atomic(&dir.join("heights.bin"), &b)
	}
	/// Load from a project folder (see `save`).
	pub fn load(dir: &Path) -> Result<Heights, String> {
		let p = dir.join("heights.bin");
		let b = std::fs::read(&p).map_err(|e| format!("{}: {e}", p.display()))?;
		if b.len() < 48 || &b[..4] != b"TTH1" {
			return Err(format!("{}: not a heights file", p.display()));
		}
		let u = |o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap()) as usize;
		let f = |o: usize| f64::from_le_bytes(b[o..o + 8].try_into().unwrap());
		let (ncols, nrows) = (u(4), u(8));
		if b.len() != 48 + ncols * nrows * 4 {
			return Err(format!("{}: the file size does not agree with {ncols} x {nrows} values", p.display()));
		}
		let values: Vec<f32> = b[48..].chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect();
		let src = dir.join("source.asc");
		if src.is_file() {
			let text = std::fs::read_to_string(&src).map_err(|e| format!("{}: {e}", src.display()))?;
			return Heights::parse(text)?.with_values(&values);
		}
		let mut a = Asc::from_south_rows(ncols, nrows, &values, f(12), f(20), f(28));
		a.data = values;
		a.nodata = f(36);
		let mut h = Heights::from_asc(&a);
		h.decimals = u(44);
		Ok(h)
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	const TEXT: &str = "ncols 4\r\nnrows 3\r\nxllcorner 200000.000000\r\nyllcorner 0.000000\r\ncellsize 2.000000\r\nNODATA_value -9999\r\n1.10 1.20  1.30 1.40\r\n2.00 2.00 2.00 2.00\r\n3.5 3.50 3.50 3.50\r\n";
	fn tmp(name: &str) -> std::path::PathBuf {
		std::env::temp_dir().join(format!("terrain_height_{name}_{}.asc", std::process::id()))
	}
	#[test]
	fn offset_moves_all_heights_and_undoes() {
		let mut h = Heights::parse(TEXT.replace("3.5 ", "-9999 ")).unwrap();
		assert_eq!(h.offset(-94.0), Some([0, 0, 4, 3]));
		assert_eq!((h.get(0, 0), h.get(3, 1), h.get(0, 2), h.get(1, 2)), (1.1 - 94.0, 2.0 - 94.0, -9999.0, 3.5 - 94.0));
		h.undo();
		assert_eq!((h.get(0, 0), h.get(0, 2)), (1.1, -9999.0));
	}
	#[test]
	fn export_keeps_rows_without_changes() {
		let mut h = Heights::parse(TEXT.to_string()).unwrap();
		assert_eq!((h.ncols, h.nrows, h.decimals), (4, 3, 2));
		let p = tmp("rows");
		h.export_asc(&p, None).unwrap();
		assert_eq!(std::fs::read_to_string(&p).unwrap(), TEXT);
		// The middle row is at y = 2 m. Raise one cell (x = 4 m) with a small brush.
		let r = h
			.dab(
				4.0,
				2.0,
				&Brush {
					radius: 1.0,
					hardness: 1.0,
					strength: 0.5,
					tool: Tool::Raise,
				},
			)
			.unwrap();
		assert_eq!(r, [2, 1, 3, 2]);
		h.end_step();
		h.export_asc(&p, None).unwrap();
		assert_eq!(std::fs::read_to_string(&p).unwrap(), TEXT.replace("2.00 2.00 2.00 2.00", "2.00 2.00 2.50 2.00"));
		// After undo, the row is the same as the source again.
		h.undo();
		h.export_asc(&p, None).unwrap();
		assert_eq!(std::fs::read_to_string(&p).unwrap(), TEXT);
		std::fs::remove_file(&p).unwrap();
	}
	#[test]
	fn project_save_and_load() {
		let dir = std::env::temp_dir().join(format!("terrain_hproj_{}", std::process::id()));
		std::fs::create_dir_all(&dir).unwrap();
		let mut h = Heights::parse(TEXT.to_string()).unwrap();
		h.dab(
			2.0,
			4.0,
			&Brush {
				radius: 1.0,
				hardness: 1.0,
				strength: 0.25,
				tool: Tool::Raise,
			},
		);
		h.save(&dir).unwrap();
		let l = Heights::load(&dir).unwrap();
		assert_eq!(l.values(), h.values());
		let (a, b) = (dir.join("a.asc"), dir.join("b.asc"));
		h.export_asc(&a, None).unwrap();
		l.export_asc(&b, None).unwrap();
		assert_eq!(std::fs::read(&a).unwrap(), std::fs::read(&b).unwrap());
		// Without a source text (for example from a WRP).
		let w = flat(8, 3.0);
		std::fs::remove_file(dir.join("source.asc")).unwrap();
		w.save(&dir).unwrap();
		let l = Heights::load(&dir).unwrap();
		assert_eq!((l.values(), l.cellsize, l.decimals), (w.values(), 1.0, 2));
		std::fs::remove_dir_all(&dir).unwrap();
	}
	#[test]
	fn saved_values_load_on_the_source() {
		let mut h = Heights::parse(TEXT.to_string()).unwrap();
		h.dab(
			0.0,
			0.0,
			&Brush {
				radius: 1.0,
				hardness: 1.0,
				strength: 1.0,
				tool: Tool::Lower,
			},
		);
		let v = h.values();
		assert_eq!(v[8], 2.5);
		let again = Heights::parse(TEXT.to_string()).unwrap().with_values(&v).unwrap();
		assert_eq!(again.values(), v);
		let p = tmp("saved");
		again.export_asc(&p, None).unwrap();
		assert_eq!(std::fs::read_to_string(&p).unwrap(), TEXT.replace("3.5 3.50", "2.50 3.50"));
		std::fs::remove_file(&p).unwrap();
	}
	fn flat(n: usize, v: f32) -> Heights {
		Heights::from_asc(&Asc::from_south_rows(n, n, &vec![v; n * n], 0.0, 0.0, 1.0))
	}
	#[test]
	fn tools_change_the_heights() {
		let b = |tool, strength| Brush {
			radius: 5.0,
			hardness: 0.5,
			strength,
			tool,
		};
		let mut h = flat(64, 10.0);
		h.dab(32.0, 32.0, &b(Tool::Raise, 2.0));
		// Cell (32, 32 m) is column 32, row 63 - 32 = 31. Full strength in the hard part, less outside, 0 at the edge.
		assert_eq!((h.get(32, 31), h.get(34, 31)), (12.0, 12.0));
		assert!(h.get(36, 31) > 10.0 && h.get(36, 31) < 12.0);
		assert_eq!(h.get(37, 31), 10.0);
		h.dab(32.0, 32.0, &b(Tool::Flatten(10.0), 1.0));
		assert_eq!(h.get(32, 31), 10.0);
		// Smooth: one high cell spreads to its neighbours.
		let mut s = flat(16, 0.0);
		s.write(vec![(8, 8, 9.0)]);
		s.dab(
			8.0,
			7.0,
			&Brush {
				radius: 2.0,
				hardness: 1.0,
				strength: 1.0,
				tool: Tool::Smooth,
			},
		);
		assert_eq!((s.get(8, 8), s.get(9, 8)), (1.0, 1.0));
		// Plane from (0, 0, 0 m) to (60, 0, 30 m): the height is half of x.
		let mut p = flat(64, 0.0);
		p.dab(
			30.0,
			30.0,
			&Brush {
				radius: 50.0,
				hardness: 1.0,
				strength: 1.0,
				tool: Tool::Plane([0.0, 0.0, 0.0], [60.0, 0.0, 30.0]),
			},
		);
		assert_eq!((p.get(10, 20), p.get(40, 5)), (5.0, 20.0));
		// Noise changes the heights up and down.
		let mut n = flat(64, 0.0);
		n.dab(
			32.0,
			32.0,
			&Brush {
				radius: 20.0,
				hardness: 1.0,
				strength: 1.0,
				tool: Tool::Noise(3.0, 7),
			},
		);
		let v = n.values();
		assert!(v.iter().any(|&x| x > 0.1) && v.iter().any(|&x| x < -0.1) && v.iter().all(|&x| x.abs() <= 1.0));
	}
	#[test]
	fn flatten_polygon_and_road() {
		// A slope: the height is x / 2 (meters), 1 m cells.
		let n = 100;
		let data: Vec<f32> = (0..n * n).map(|i| (i % n) as f32 / 2.0).collect();
		let mut h = Heights::from_asc(&Asc::from_south_rows(n, n, &data, 0.0, 0.0, 1.0));
		let at = |h: &Heights, x: usize, y: usize| h.get(x, n - 1 - y);
		let r = h.flatten_polygon(&[[20.0, 20.0], [40.0, 20.0], [40.0, 40.0], [20.0, 40.0]], None, 10.0).unwrap();
		// Inside (even-odd rule: the cells on the east and north edges are outside): the mean of x / 2 for x 20..39 is 14.75.
		assert_eq!((at(&h, 30, 30), at(&h, 21, 39)), (14.75, 14.75));
		assert!(at(&h, 45, 30) > 14.75 && at(&h, 45, 30) < 22.5);
		assert_eq!((at(&h, 51, 30), at(&h, 30, 55)), (25.5, 15.0));
		assert_eq!((r[0], r[2]), (11, 50));
		h.undo();
		assert_eq!(at(&h, 30, 30), 15.0);
		h.redo();
		let mut flat = Heights::from_asc(&Asc::from_south_rows(n, n, &data, 0.0, 0.0, 1.0));
		flat.flatten_polygon(&[[20.0, 20.0], [40.0, 20.0], [40.0, 40.0]], Some(3.0), 0.0);
		assert_eq!((flat.get(35, n - 1 - 25), flat.get(25, n - 1 - 35)), (3.0, 12.5));
		// A road across the slope (north to south at x = 50): the target is 25 m on the whole line. Width 6 m, feather 4 m.
		let mut bump = data.clone();
		bump[(n - 1 - 50) * n + 50] = 40.0;
		let mut road = Heights::from_asc(&Asc {
			data: bump,
			..Asc::from_south_rows(n, n, &data, 0.0, 0.0, 1.0)
		});
		road.road(&[[50.0, 10.0], [50.0, 90.0]], 6.0, 4.0, 10.0);
		// On the centre line the height is the smoothed centre: near 25 m, the bump of 40 m is mostly gone.
		let c = road.get(50, n - 1 - 50);
		assert!((25.0..27.5).contains(&c), "{c}");
		assert!((road.get(52, n - 1 - 30) - road.get(50, n - 1 - 30)).abs() < 1e-4);
		assert!((road.get(48, n - 1 - 30) - 25.0).abs() < 0.1);
		// After width / 2 + feather (7 m) there is no change.
		assert_eq!((road.get(58, n - 1 - 30), road.get(42, n - 1 - 30)), (29.0, 21.0));
	}
	#[test]
	fn stamp_adds_or_raises() {
		let st = Stamp {
			width: 2,
			height: 2,
			v: vec![1.0, 1.0, 1.0, 1.0],
		};
		let mut h = flat(32, 5.0);
		h.stamp(16.0, 16.0, &st, 4.0, 3.0, false, 0.0);
		assert_eq!((h.get(16, 15), h.get(14, 17), h.get(19, 15)), (8.0, 8.0, 5.0));
		h.stamp(16.0, 16.0, &st, 4.0, 1.0, true, 5.0);
		assert_eq!(h.get(16, 15), 8.0);
		h.undo();
		h.undo();
		assert_eq!(h.get(16, 15), 5.0);
		assert!((h.at(16.0, 16.0) - 5.0).abs() < 1e-9);
	}
}
