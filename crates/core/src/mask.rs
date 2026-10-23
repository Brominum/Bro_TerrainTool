//! Layer mask of the mask painter. Each pixel is an index in the palette (the colors of `class Legend` in layers.cfg).
//! The pixels are in a tile store with one byte for each pixel (see tilestore.rs). The tiles of the import stay available for erase.
use crate::layers_cfg::LayersCfg;
use crate::tiles::Rows;
use crate::tilestore::{union, Builder, Store};
pub use crate::tilestore::{Rect, TILE};
use std::collections::HashMap;
use std::path::Path;

/// Value of `region` for pixels outside the image.
pub const OUTSIDE: u8 = 255;

/// What a brush, a fill, or a polygon writes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Paint {
	/// Palette index.
	Color(u8),
	/// The pixel of the imported mask.
	Erase,
}

#[derive(Debug, Clone, Copy)]
pub struct Brush {
	/// Radius in pixels.
	pub radius: f64,
	/// 0 to 1. The part of the radius with full opacity.
	pub hardness: f64,
	/// 0 to 1.
	pub opacity: f64,
	pub paint: Paint,
}

pub struct Mask {
	pub width: u32,
	pub height: u32,
	/// Palette colors. A pixel value is an index in this list.
	pub colors: Vec<[u8; 3]>,
	pub s: Store,
}

/// Random value from 0 to 1 for a pixel. The same pixel and seed give the same value, so the dabs of one stroke do not add up.
pub(crate) fn rnd(x: u32, y: u32, seed: u32) -> f64 {
	let mut h = ((x as u64) << 32 | y as u64) ^ (seed as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
	h = (h ^ (h >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
	h = (h ^ (h >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
	h ^= h >> 31;
	(h >> 11) as f64 / (1u64 << 53) as f64
}

/// Brush strength from 0 to 1 at the distance d (0 to 1 of the radius): full in the hard part, then a linear fall to the edge.
pub(crate) fn falloff(d: f64, hardness: f64) -> f64 {
	if d > 1.0 {
		0.0
	} else if d <= hardness {
		1.0
	} else {
		(1.0 - d) / (1.0 - hardness)
	}
}

impl Mask {
	fn new(s: Store, colors: Vec<[u8; 3]>) -> Mask {
		Mask {
			width: s.width,
			height: s.height,
			colors,
			s,
		}
	}
	/// Make a mask from rows of palette indices. For tests and for new masks.
	pub fn from_fn(width: u32, height: u32, colors: Vec<[u8; 3]>, f: impl Fn(u32, u32) -> u8) -> Mask {
		let mut b = Builder::new(width, height, 1);
		let mut row = vec![0u8; width as usize];
		for y in 0..height {
			for (x, v) in row.iter_mut().enumerate() {
				*v = f(x as u32, y);
			}
			b.row(y, &row);
		}
		Mask::new(b.finish(), colors)
	}
	/// Read a source mask (PNG or 24-bit BMP) row by row. Each pixel gets the nearest palette color.
	/// Returns the mask and the number of pixels that are not an exact palette color.
	pub fn import(path: &Path, cfg: &LayersCfg) -> Result<(Mask, u64), String> {
		if cfg.palette.len() > OUTSIDE as usize {
			return Err(format!("layers.cfg has {} palette colors. The mask painter supports {} at most.", cfg.palette.len(), OUTSIDE));
		}
		let mut rows = Rows::open(path)?;
		let (w, h) = (rows.width, rows.height);
		// Exact colors first. With two equal colors, the first entry wins.
		let mut cache: HashMap<[u8; 3], (u8, bool)> = cfg.palette.iter().enumerate().rev().map(|(i, p)| (p.0, (i as u8, true))).collect();
		let mut b = Builder::new(w, h, 1);
		let mut ids = vec![0u8; w as usize];
		let mut inexact = 0u64;
		for y in 0..h {
			rows.fill_to(y)?;
			let mut last = ([0u8; 3], (0u8, false));
			let mut first = true;
			for (x, p) in rows.row(y).chunks_exact(3).enumerate() {
				let key = [p[0], p[1], p[2]];
				if first || key != last.0 {
					let v = *cache.entry(key).or_insert_with(|| (cfg.nearest_entry(key) as u8, false));
					last = (key, v);
					first = false;
				}
				ids[x] = last.1 .0;
				inexact += !last.1 .1 as u64;
			}
			rows.drop_before(y + 1);
			b.row(y, &ids);
		}
		Ok((Mask::new(b.finish(), cfg.palette.iter().map(|p| p.0).collect()), inexact))
	}
	pub fn get(&self, x: u32, y: u32) -> u8 {
		let (t, o) = self.s.index(x, y);
		self.s.tiles[t][o]
	}
	/// Call `f(x, y, current, imported)` for each pixel in the rectangle. `Some(v)` sets the pixel.
	fn apply(&mut self, r: [i64; 4], mut f: impl FnMut(u32, u32, u8, u8) -> Option<u8>) -> Option<Rect> {
		self.s.apply(r, |x, y, cur, orig, out| match f(x, y, cur[0], orig[0]) {
			Some(v) => {
				out[0] = v;
				true
			}
			None => false,
		})
	}
	/// Paint one dab. In the hard part of the radius, opacity 1 sets each pixel. Elsewhere a pixel changes when its random value
	/// is less than the brush strength. So each pixel keeps an exact palette color (a dithered edge).
	pub fn dab(&mut self, cx: f64, cy: f64, b: &Brush, seed: u32) -> Option<Rect> {
		let r = b.radius.max(0.5);
		let rect = [(cx - r).floor() as i64, (cy - r).floor() as i64, (cx + r).ceil() as i64 + 1, (cy + r).ceil() as i64 + 1];
		let (hard, opacity) = (b.hardness.clamp(0.0, 1.0), b.opacity.clamp(0.0, 1.0));
		self.apply(rect, |x, y, _, orig| {
			let d = ((x as f64 + 0.5 - cx).powi(2) + (y as f64 + 0.5 - cy).powi(2)).sqrt() / r;
			if d > 1.0 {
				return None;
			}
			let p = opacity * falloff(d, hard);
			if p < 1.0 && rnd(x, y, seed) >= p {
				return None;
			}
			Some(match b.paint {
				Paint::Color(c) => c,
				Paint::Erase => orig,
			})
		})
	}
	/// Paint dabs along a line. The dabs are a quarter of the radius apart. Use the same seed for all lines of one stroke.
	pub fn line(&mut self, a: [f64; 2], z: [f64; 2], b: &Brush, seed: u32) -> Option<Rect> {
		line(a, z, b.radius, |x, y| self.dab(x, y, b, seed))
	}
	/// Close the open step (one brush stroke) and put it in the undo list.
	pub fn end_step(&mut self) {
		self.s.end_step();
	}
	/// Flood fill (4 neighbours) from one pixel: all connected pixels with the same value. This is one undo step.
	pub fn fill(&mut self, x: u32, y: u32, paint: Paint) -> Option<Rect> {
		self.end_step();
		if x >= self.width || y >= self.height {
			return None;
		}
		let target = self.get(x, y);
		let (tt, to) = self.s.index(x, y);
		let value = |m: &Mask, t: usize, o: usize| match paint {
			Paint::Color(c) => c,
			Paint::Erase => m.s.orig[t][o],
		};
		if value(self, tt, to) == target && paint != Paint::Erase {
			return None;
		}
		// Done pixels: one bit for each pixel. Erase can write the target value again, so the pixel value does not show what is done.
		let mut done = vec![0u64; (self.width as usize * self.height as usize).div_ceil(64)];
		let w = self.width as usize;
		let mut stack = vec![(x, y)];
		let mut rect = [x, y, x + 1, y + 1];
		while let Some((sx, sy)) = stack.pop() {
			let bit = |x: u32| sy as usize * w + x as usize;
			let open = |m: &Mask, done: &[u64], x: u32| done[bit(x) / 64] & (1 << (bit(x) % 64)) == 0 && m.get(x, sy) == target;
			if !open(self, &done, sx) {
				continue;
			}
			let (mut l, mut r) = (sx, sx);
			while l > 0 && open(self, &done, l - 1) {
				l -= 1;
			}
			while r + 1 < self.width && open(self, &done, r + 1) {
				r += 1;
			}
			for x in l..=r {
				done[bit(x) / 64] |= 1 << (bit(x) % 64);
				let (t, o) = self.s.index(x, sy);
				let v = value(self, t, o);
				if v != self.s.tiles[t][o] {
					self.s.tile_mut(t)[o] = v;
				}
			}
			rect = union(Some(rect), [l, sy, r + 1, sy + 1]);
			for ny in [sy.wrapping_sub(1), sy + 1] {
				if ny >= self.height {
					continue;
				}
				let mut x = l;
				while x <= r {
					if self.get(x, ny) == target {
						stack.push((x, ny));
						while x <= r && self.get(x, ny) == target {
							x += 1;
						}
					}
					x += 1;
				}
			}
		}
		self.s.mark(rect);
		let changed = self.s.has_changes();
		self.end_step();
		changed.then_some(rect)
	}
	/// Fill a polygon (even-odd rule). A pixel is in the polygon when its centre is. Polygon and lasso use this. This is one undo step.
	pub fn polygon(&mut self, pts: &[[f64; 2]], paint: Paint) -> Option<Rect> {
		self.end_step();
		if pts.len() < 3 {
			return None;
		}
		let (lo, hi) = pts.iter().fold((f64::MAX, f64::MIN), |(lo, hi), p| (lo.min(p[1]), hi.max(p[1])));
		let mut dirty = None;
		let mut xs = Vec::new();
		for y in (lo.floor().max(0.0) as u32)..(hi.ceil().min(self.height as f64) as u32) {
			let c = y as f64 + 0.5;
			xs.clear();
			for (i, a) in pts.iter().enumerate() {
				let b = pts[(i + 1) % pts.len()];
				if (a[1] <= c) != (b[1] <= c) {
					xs.push(a[0] + (c - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
				}
			}
			xs.sort_by(f64::total_cmp);
			for s in xs.chunks_exact(2) {
				let span = [(s[0] - 0.5).ceil() as i64, y as i64, (s[1] - 0.5).ceil() as i64, y as i64 + 1];
				if let Some(d) = self.apply(span, |_, _, _, orig| Some(if let Paint::Color(c) = paint { c } else { orig })) {
					dirty = Some(union(dirty, d));
				}
			}
		}
		self.end_step();
		dirty
	}
	/// Paint a band along a line (pixel coordinates): full inside `half` pixels of the line, dithered across `feather` pixels after it.
	/// This is one undo step.
	pub fn band(&mut self, pts: &[[f64; 2]], half: f64, feather: f64, paint: Paint, seed: u32) -> Option<Rect> {
		self.end_step();
		let reach = half + feather.max(0.0);
		let mut dirty = None;
		let one = [pts.first().copied().unwrap_or([0.0, 0.0]); 2];
		let segs: Vec<[[f64; 2]; 2]> = if pts.len() == 1 { vec![one] } else { pts.windows(2).map(|w| [w[0], w[1]]).collect() };
		for [a, z] in segs {
			let r = [
				(a[0].min(z[0]) - reach).floor() as i64,
				(a[1].min(z[1]) - reach).floor() as i64,
				(a[0].max(z[0]) + reach).ceil() as i64 + 1,
				(a[1].max(z[1]) + reach).ceil() as i64 + 1,
			];
			let d = self.apply(r, |x, y, _, orig| {
				let d = seg_dist([x as f64 + 0.5, y as f64 + 0.5], a, z).0;
				if d > reach || (d > half && rnd(x, y, seed) >= 1.0 - (d - half) / feather) {
					return None;
				}
				Some(match paint {
					Paint::Color(c) => c,
					Paint::Erase => orig,
				})
			});
			if let Some(d) = d {
				dirty = Some(union(dirty, d));
			}
		}
		self.end_step();
		dirty
	}
	/// A mask with value 1 inside the polygons (pixel coordinates, even-odd rule, pixel centres) and 0 outside.
	/// The fill uses it for a polygon area. Tiles outside the polygons share memory, so a large map costs little.
	pub fn polygon_mask(width: u32, height: u32, rings: &[Vec<[f64; 2]>]) -> Mask {
		let mut b = Builder::new(width, height, 1);
		let mut row = vec![0u8; width as usize];
		let mut xs = Vec::new();
		for y in 0..height {
			row.fill(0);
			let c = y as f64 + 0.5;
			xs.clear();
			for r in rings {
				for (i, a) in r.iter().enumerate() {
					let z = r[(i + 1) % r.len()];
					if (a[1] <= c) != (z[1] <= c) {
						xs.push(a[0] + (c - a[1]) / (z[1] - a[1]) * (z[0] - a[0]));
					}
				}
			}
			xs.sort_by(f64::total_cmp);
			for s in xs.chunks_exact(2) {
				let (x0, x1) = (((s[0] - 0.5).ceil().max(0.0) as usize).min(width as usize), ((s[1] - 0.5).ceil().max(0.0) as usize).min(width as usize));
				row[x0..x1.max(x0)].fill(1);
			}
			b.row(y, &row);
		}
		Mask::new(b.finish(), vec![[0, 0, 0], [255, 255, 255]])
	}
	/// Undo the last step. Returns the changed area.
	pub fn undo(&mut self) -> Option<Rect> {
		self.s.undo()
	}
	pub fn redo(&mut self) -> Option<Rect> {
		self.s.redo()
	}
	pub fn can_undo(&self) -> bool {
		self.s.can_undo()
	}
	pub fn can_redo(&self) -> bool {
		self.s.can_redo()
	}
	/// Palette indices for the view. Level 0 is full size. Level n uses every 2^n-th pixel.
	/// (x, y) is the first pixel in level pixels. Pixels outside the image are `OUTSIDE`.
	pub fn region(&self, level: u32, x: u32, y: u32, w: u32, h: u32) -> Vec<u8> {
		let mut out = vec![OUTSIDE; w as usize * h as usize];
		for j in 0..h {
			let sy = (y + j) << level;
			if sy >= self.height {
				break;
			}
			for i in 0..w {
				let sx = (x + i) << level;
				if sx >= self.width {
					break;
				}
				out[(j * w + i) as usize] = self.get(sx, sy);
			}
		}
		out
	}
	/// Write the mask as one RGB PNG with the palette colors.
	pub fn export_png(&self, path: &Path) -> Result<(), String> {
		self.s.export_png(path, |p| self.colors[p[0] as usize])
	}
}

/// Distance from a point to a segment, and the part (0 to 1) of the segment at the nearest point.
pub(crate) fn seg_dist(p: [f64; 2], a: [f64; 2], z: [f64; 2]) -> (f64, f64) {
	let (dx, dy) = (z[0] - a[0], z[1] - a[1]);
	let len2 = dx * dx + dy * dy;
	let t = if len2 > 0.0 { (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2).clamp(0.0, 1.0) } else { 0.0 };
	(((p[0] - a[0] - t * dx).powi(2) + (p[1] - a[1] - t * dy).powi(2)).sqrt(), t)
}

/// Call `dab` along a line, a quarter of the radius apart. Returns the union of the changed areas.
pub(crate) fn line(a: [f64; 2], z: [f64; 2], radius: f64, mut dab: impl FnMut(f64, f64) -> Option<Rect>) -> Option<Rect> {
	let len = ((z[0] - a[0]).powi(2) + (z[1] - a[1]).powi(2)).sqrt();
	let n = (len / (radius * 0.25).max(0.5)).ceil().max(1.0) as u32;
	let mut dirty = None;
	for i in 0..=n {
		let t = i as f64 / n as f64;
		if let Some(d) = dab(a[0] + (z[0] - a[0]) * t, a[1] + (z[1] - a[1]) * t) {
			dirty = Some(union(dirty, d));
		}
	}
	dirty
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::sync::Arc;
	const COLORS: [[u8; 3]; 3] = [[0, 255, 0], [0, 0, 255], [255, 0, 0]];
	fn mask(w: u32, h: u32) -> Mask {
		Mask::from_fn(w, h, COLORS.to_vec(), |x, _| (x >= w / 2) as u8)
	}
	fn count(m: &Mask, v: u8) -> usize {
		m.region(0, 0, 0, m.width, m.height).iter().filter(|&&p| p == v).count()
	}
	#[test]
	fn tiles_share_memory_and_copy_on_change() {
		// 1100 x 600 px: 3 x 2 tiles, the edge tiles are partly outside.
		let mut m = mask(1100, 600);
		assert_eq!((m.s.cols, m.s.tiles.len()), (3, 6));
		// Tile 0 is all 0, tile 2 is all 1. Tiles 0 and 3 share one buffer.
		assert!(Arc::ptr_eq(&m.s.tiles[0], &m.s.tiles[3]));
		assert_eq!((m.get(549, 10), m.get(550, 10), m.get(1099, 599)), (0, 1, 1));
		let hard = Brush {
			radius: 3.0,
			hardness: 1.0,
			opacity: 1.0,
			paint: Paint::Color(2),
		};
		let r = m.dab(10.0, 10.0, &hard, 1).unwrap();
		assert_eq!(r, [7, 7, 14, 14]);
		assert!(!Arc::ptr_eq(&m.s.tiles[0], &m.s.tiles[3]));
		assert_eq!((m.get(10, 10), m.get(12, 10), m.get(13, 10), m.get(10, 7)), (2, 2, 0, 2));
		// 3 px radius: 32 pixel centres are in the circle.
		assert_eq!(count(&m, 2), 32);
		// The same dab again changes nothing.
		assert_eq!(m.dab(10.0, 10.0, &hard, 1), None);
		m.end_step();
		assert_eq!(m.undo(), Some([7, 7, 14, 14]));
		assert_eq!(count(&m, 2), 0);
		assert!(Arc::ptr_eq(&m.s.tiles[0], &m.s.tiles[3]));
		m.redo();
		assert_eq!(count(&m, 2), 32);
	}
	#[test]
	fn soft_brush_dithers_with_exact_colors_and_erase_restores_the_import() {
		let mut m = mask(512, 512);
		let soft = Brush {
			radius: 40.0,
			hardness: 0.0,
			opacity: 1.0,
			paint: Paint::Color(2),
		};
		m.line([100.0, 100.0], [140.0, 100.0], &soft, 7);
		m.end_step();
		let n = count(&m, 2);
		let px = m.region(0, 0, 0, 512, 512);
		assert!(px.iter().all(|&p| p < 3));
		// A full circle has about 5000 pixels. The soft edge paints about a third of the area of one dab, the line adds more.
		assert!(n > 2000 && n < 6000, "{n} pixels");
		// The centre is painted, the edge is partly painted.
		assert_eq!(m.get(120, 100), 2);
		let edge = (0..40).filter(|&i| m.get(100 + i, 132) == 2).count();
		assert!(edge > 0 && edge < 40, "{edge}");
		let erase = Brush {
			radius: 100.0,
			hardness: 1.0,
			opacity: 1.0,
			paint: Paint::Erase,
		};
		m.dab(120.0, 100.0, &erase, 1);
		m.end_step();
		assert_eq!(count(&m, 2), 0);
		assert_eq!(m.region(0, 0, 0, 512, 512), mask(512, 512).region(0, 0, 0, 512, 512));
	}
	#[test]
	fn flood_fill_and_polygon() {
		let mut m = mask(1100, 600);
		// A wall of value 2 at x = 100 splits the left area.
		m.line(
			[100.5, 0.0],
			[100.5, 600.0],
			&Brush {
				radius: 0.5,
				hardness: 1.0,
				opacity: 1.0,
				paint: Paint::Color(2),
			},
			0,
		);
		m.end_step();
		assert_eq!(count(&m, 2), 600);
		assert_eq!(m.fill(10, 10, Paint::Color(1)), Some([0, 0, 100, 600]));
		assert_eq!(m.get(99, 599), 1);
		assert_eq!(m.get(101, 0), 0);
		assert_eq!(count(&m, 1), 100 * 600 + 550 * 600);
		// Fill with the same color does nothing. Erase fills back to the import.
		assert_eq!(m.fill(10, 10, Paint::Color(1)), None);
		assert!(m.fill(10, 10, Paint::Erase).is_some());
		assert_eq!(m.get(10, 10), 0);
		m.undo();
		assert_eq!(m.get(10, 10), 1);
		// Triangle (0,0), (10,0), (0,10): pixel centres with x + y + 1 < 10.
		let r = m.polygon(&[[0.0, 0.0], [10.0, 0.0], [0.0, 10.0]], Paint::Color(2)).unwrap();
		assert_eq!(r, [0, 0, 9, 9]);
		assert_eq!((m.get(0, 8), m.get(1, 8), m.get(4, 4), m.get(5, 4)), (2, 1, 2, 1));
		assert_eq!(count(&m, 2), 600 + 45);
	}
	#[test]
	fn band_and_polygon_mask() {
		let mut m = mask(200, 100);
		// A horizontal band at y = 50, 10 px wide (half 5), no feather.
		let r = m.band(&[[20.0, 50.0], [80.0, 50.0]], 5.0, 0.0, Paint::Color(2), 1).unwrap();
		assert_eq!(r, [15, 45, 86, 56]);
		assert_eq!((m.get(50, 45), m.get(50, 54), m.get(50, 44), m.get(50, 55), m.get(84, 50), m.get(86, 50)), (2, 2, 0, 0, 2, 0));
		m.undo();
		assert_eq!(m.get(50, 50), 0);
		// With a feather, some pixels after the band change and some do not. Each pixel keeps a palette color.
		m.band(&[[20.0, 50.0], [80.0, 50.0]], 5.0, 10.0, Paint::Color(2), 1);
		let edge = (20..80).filter(|&x| m.get(x, 60) == 2).count();
		assert!(edge > 5 && edge < 55, "{edge}");
		assert_eq!(m.get(50, 66), 0);
		let p = Mask::polygon_mask(1100, 600, &[vec![[0.0, 0.0], [10.0, 0.0], [0.0, 10.0]]]);
		assert_eq!((p.get(0, 8), p.get(1, 8), p.get(4, 4), p.get(5, 4), p.get(500, 300)), (1, 0, 1, 0, 0));
		// The tiles outside the polygon share memory.
		assert!(Arc::ptr_eq(&p.s.tiles[1], &p.s.tiles[4]));
	}
	#[test]
	fn undo_list_keeps_the_memory_limit() {
		let mut m = mask(1024, 512);
		m.s.undo_limit = 2 * crate::tilestore::TILE_PX;
		for i in 0..5 {
			m.dab(
				10.0 + i as f64,
				10.0,
				&Brush {
					radius: 2.0,
					hardness: 1.0,
					opacity: 1.0,
					paint: Paint::Color(2),
				},
				0,
			);
			m.end_step();
		}
		assert_eq!(m.s.undo_len(), 2);
	}
	#[test]
	fn region_uses_levels() {
		let m = mask(1100, 600);
		assert_eq!(m.region(1, 274, 0, 3, 1), vec![0, 1, 1]);
		assert_eq!(m.region(2, 274, 0, 2, 1), vec![1, OUTSIDE]);
	}
}
