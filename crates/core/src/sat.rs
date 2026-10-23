//! Satellite image of the satellite painter: RGB pixels in a tile store (see tilestore.rs).
//! Brushes: color, clone, smooth, and texture. A soft brush blends the colors. For color, clone, and texture, the strength of a pixel in
//! one stroke is the largest strength of the dabs on it (not the sum), so a stroke never goes above its opacity.
//! The view uses a mip pyramid: level n is the mean of 2^n x 2^n pixels. The tool calculates a level tile only when the view needs it,
//! and again only after a change in its area.
use crate::mask::{falloff, line};
use crate::paa;
use crate::tiles::Rows;
use crate::tilestore::{Builder, Store, Tile, TILE_PX};
pub use crate::tilestore::{Rect, TILE};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Tool {
	Color([u8; 3]),
	/// Copy from the pixel at this offset (source minus destination, in pixels).
	Clone([f64; 2]),
	/// Blend to the mean of the 5 x 5 pixels around each pixel. This adds up with each dab.
	Smooth,
	/// Paint the loaded texture (see `set_texture`).
	Texture,
}

#[derive(Debug, Clone, Copy)]
pub struct Brush {
	/// Radius in pixels.
	pub radius: f64,
	/// 0 to 1. The part of the radius with full opacity.
	pub hardness: f64,
	/// 0 to 1.
	pub opacity: f64,
	pub tool: Tool,
}

/// RGB image of a texture brush, resized to the repeat size.
pub struct Texture {
	pub width: usize,
	pub height: usize,
	pub rgb: Vec<u8>,
}

impl Texture {
	/// Read a PNG, a 24-bit BMP, or a PAA (DXT1 or DXT5, the largest mipmap).
	pub fn load(path: &Path) -> Result<Texture, String> {
		let err = |e: &dyn std::fmt::Display| format!("{}: {e}", path.display());
		if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("paa")) {
			let p = paa::read(&std::fs::read(path).map_err(|e| err(&e))?).map_err(|e| err(&e))?;
			let m = p.mips.first().ok_or_else(|| err(&"the PAA has no mipmap"))?;
			let (w, h) = (m.width as usize, m.height as usize);
			return Ok(Texture {
				width: w,
				height: h,
				rgb: decode_dxt(p.format, w, h, &m.data).map_err(|e| err(&e))?,
			});
		}
		let mut rows = Rows::open(path)?;
		let (w, h) = (rows.width as usize, rows.height as usize);
		let mut rgb = Vec::with_capacity(w * h * 3);
		for y in 0..h as u32 {
			rows.fill_to(y)?;
			rgb.extend_from_slice(rows.row(y));
			rows.drop_before(y + 1);
		}
		Ok(Texture { width: w, height: h, rgb })
	}
	/// Resize to size x size pixels: the mean of the source pixels in each target pixel (the nearest pixel when the target is larger).
	pub fn resized(&self, size: usize) -> Texture {
		let size = size.max(1);
		let mut rgb = vec![0u8; size * size * 3];
		for j in 0..size {
			let (y0, y1) = (j * self.height / size, ((j + 1) * self.height / size).max(j * self.height / size + 1));
			for i in 0..size {
				let (x0, x1) = (i * self.width / size, ((i + 1) * self.width / size).max(i * self.width / size + 1));
				let mut sum = [0u64; 3];
				for y in y0..y1 {
					for x in x0..x1 {
						for c in 0..3 {
							sum[c] += self.rgb[(y * self.width + x) * 3 + c] as u64;
						}
					}
				}
				let n = ((y1 - y0) * (x1 - x0)) as u64;
				for c in 0..3 {
					rgb[(j * size + i) * 3 + c] = ((sum[c] + n / 2) / n) as u8;
				}
			}
		}
		Texture { width: size, height: size, rgb }
	}
}

/// Decode DXT1 or DXT5 blocks to RGB. DXT5 has 8 bytes of alpha before each color block. The alpha is not used.
pub fn decode_dxt(format: paa::Format, w: usize, h: usize, data: &[u8]) -> Result<Vec<u8>, String> {
	let (bw, bh) = (w.div_ceil(4), h.div_ceil(4));
	let size = if format == paa::Format::Dxt1 { 8 } else { 16 };
	if data.len() < bw * bh * size {
		return Err(format!("{} bytes of DXT data, {} are necessary", data.len(), bw * bh * size));
	}
	let rgb565 = |v: u16| [((v >> 11) & 31) as u32 * 255 / 31, ((v >> 5) & 63) as u32 * 255 / 63, (v & 31) as u32 * 255 / 31];
	let mut out = vec![0u8; w * h * 3];
	for by in 0..bh {
		for bx in 0..bw {
			let b = &data[(by * bw + bx) * size + size - 8..][..8];
			let (v0, v1) = (u16::from_le_bytes([b[0], b[1]]), u16::from_le_bytes([b[2], b[3]]));
			let (c0, c1) = (rgb565(v0), rgb565(v1));
			let mix = |a: u32, b: u32, n: u32, d: u32| ((a * (d - n) + b * n) / d) as u8;
			// DXT1 with c0 <= c1 has 3 colors and black. DXT5 always uses 4 colors.
			let four = format == paa::Format::Dxt5 || v0 > v1;
			let pal: [[u8; 3]; 4] = [
				c0.map(|v| v as u8),
				c1.map(|v| v as u8),
				if four { [0, 1, 2].map(|i| mix(c0[i], c1[i], 1, 3)) } else { [0, 1, 2].map(|i| mix(c0[i], c1[i], 1, 2)) },
				if four { [0, 1, 2].map(|i| mix(c0[i], c1[i], 2, 3)) } else { [0, 0, 0] },
			];
			let bits = u32::from_le_bytes([b[4], b[5], b[6], b[7]]);
			for k in 0..16 {
				let (x, y) = (bx * 4 + k % 4, by * 4 + k / 4);
				if x < w && y < h {
					out[(y * w + x) * 3..(y * w + x) * 3 + 3].copy_from_slice(&pal[(bits >> (2 * k) & 3) as usize]);
				}
			}
		}
	}
	Ok(out)
}

pub struct Sat {
	pub width: u32,
	pub height: u32,
	pub s: Store,
	/// Mip tiles for levels 1, 2, ...: None until the view needs the tile, or after a change in its area.
	mips: Vec<Vec<Option<Tile>>>,
	/// The tile before the stroke and the largest strength (0 to 255) of each pixel in the stroke.
	stroke: HashMap<usize, (Tile, Vec<u8>)>,
	texture: Option<Texture>,
}

impl Sat {
	fn new(s: Store) -> Sat {
		let mut mips = Vec::new();
		let mut l = 1;
		while s.width.max(s.height).div_ceil(TILE << (l - 1)) > 1 {
			mips.push(vec![None; (s.width.div_ceil(TILE << l) * s.height.div_ceil(TILE << l)) as usize]);
			l += 1;
		}
		let mut s = s;
		// The user's PC has 96 GB. A satellite tile has 768 KB, so 4 GB keeps about 5000 changed tiles.
		s.undo_limit = 4 << 30;
		Sat {
			width: s.width,
			height: s.height,
			s,
			mips,
			stroke: HashMap::new(),
			texture: None,
		}
	}
	/// Make an image from a function of the pixel. For tests.
	pub fn from_fn(width: u32, height: u32, f: impl Fn(u32, u32) -> [u8; 3]) -> Sat {
		let mut b = Builder::new(width, height, 3);
		let mut row = vec![0u8; width as usize * 3];
		for y in 0..height {
			for x in 0..width {
				row[x as usize * 3..x as usize * 3 + 3].copy_from_slice(&f(x, y));
			}
			b.row(y, &row);
		}
		Sat::new(b.finish())
	}
	/// Read a satellite image (PNG or 24-bit BMP) row by row.
	pub fn import(path: &Path) -> Result<Sat, String> {
		let mut rows = Rows::open(path)?;
		let mut b = Builder::new(rows.width, rows.height, 3);
		for y in 0..rows.height {
			rows.fill_to(y)?;
			b.row(y, rows.row(y));
			rows.drop_before(y + 1);
		}
		Ok(Sat::new(b.finish()))
	}
	pub fn get(&self, x: u32, y: u32) -> [u8; 3] {
		let p = self.s.get(x, y);
		[p[0], p[1], p[2]]
	}
	/// Use a texture for the texture brush. One repeat of the texture covers `size` x `size` pixels of the satellite image.
	pub fn set_texture(&mut self, t: &Texture, size: usize) {
		self.texture = Some(t.resized(size));
	}
	/// Paint one dab. Returns the changed area.
	pub fn dab(&mut self, cx: f64, cy: f64, b: &Brush) -> Option<Rect> {
		let r = b.radius.max(0.5);
		let rect = self.s.clip([(cx - r).floor() as i64, (cy - r).floor() as i64, (cx + r).ceil() as i64 + 1, (cy + r).ceil() as i64 + 1])?;
		if b.tool == Tool::Texture && self.texture.is_none() {
			return None;
		}
		let (hard, opacity) = (b.hardness.clamp(0.0, 1.0), b.opacity.clamp(0.0, 1.0));
		let (w, h) = (self.width as i64, self.height as i64);
		// Read first, then write: smooth and clone read the pixels before this dab.
		let mut writes: Vec<(usize, usize, [u8; 3])> = Vec::new();
		for y in rect[1]..rect[3] {
			for x in rect[0]..rect[2] {
				let d = ((x as f64 + 0.5 - cx).powi(2) + (y as f64 + 0.5 - cy).powi(2)).sqrt() / r;
				let s = opacity * falloff(d, hard);
				if s <= 0.0 {
					continue;
				}
				let (t, o) = self.s.index(x, y);
				let cur = self.get(x, y);
				let lerp = |a: [u8; 3], b: [u8; 3], k: f64| [0, 1, 2].map(|i| (a[i] as f64 + (b[i] as f64 - a[i] as f64) * k).round() as u8);
				if b.tool == Tool::Smooth {
					let mut sum = [0u32; 3];
					for j in -2..=2i64 {
						for i in -2..=2i64 {
							let p = self.get((x as i64 + i).clamp(0, w - 1) as u32, (y as i64 + j).clamp(0, h - 1) as u32);
							for c in 0..3 {
								sum[c] += p[c] as u32;
							}
						}
					}
					writes.push((t, o, lerp(cur, sum.map(|v| ((v + 12) / 25) as u8), s)));
					continue;
				}
				let target = match b.tool {
					Tool::Color(c) => c,
					Tool::Clone(off) => {
						let (sx, sy) = ((x as f64 + off[0]).floor() as i64, (y as f64 + off[1]).floor() as i64);
						if sx < 0 || sy < 0 || sx >= w || sy >= h {
							continue;
						}
						self.get(sx as u32, sy as u32)
					}
					Tool::Texture => {
						let tex = self.texture.as_ref().unwrap();
						let k = ((y as usize % tex.height) * tex.width + x as usize % tex.width) * 3;
						[tex.rgb[k], tex.rgb[k + 1], tex.rgb[k + 2]]
					}
					Tool::Smooth => unreachable!(),
				};
				let q = (s * 255.0).round() as u8;
				let entry = self.stroke.entry(t).or_insert_with(|| (self.s.tiles[t].clone(), vec![0; TILE_PX]));
				if q <= entry.1[o] {
					continue;
				}
				entry.1[o] = q;
				let base = [entry.0[o * 3], entry.0[o * 3 + 1], entry.0[o * 3 + 2]];
				writes.push((t, o, lerp(base, target, q as f64 / 255.0)));
			}
		}
		let mut dirty = None;
		for (t, o, px) in writes {
			if self.s.tiles[t][o * 3..o * 3 + 3] != px {
				self.s.tile_mut(t)[o * 3..o * 3 + 3].copy_from_slice(&px);
				dirty = Some(rect);
			}
		}
		if let Some(d) = dirty {
			self.s.mark(d);
			self.changed(d);
		}
		dirty
	}
	/// Paint dabs along a line, a quarter of the radius apart.
	pub fn line(&mut self, a: [f64; 2], z: [f64; 2], b: &Brush) -> Option<Rect> {
		line(a, z, b.radius, |x, y| self.dab(x, y, b))
	}
	/// Close the open step (one brush stroke) and put it in the undo list.
	pub fn end_step(&mut self) {
		self.stroke.clear();
		self.s.end_step();
	}
	pub fn undo(&mut self) -> Option<Rect> {
		self.stroke.clear();
		let r = self.s.undo();
		r.inspect(|&r| self.changed(r))
	}
	pub fn redo(&mut self) -> Option<Rect> {
		self.stroke.clear();
		let r = self.s.redo();
		r.inspect(|&r| self.changed(r))
	}
	/// Forget the mip tiles in a changed area.
	fn changed(&mut self, r: Rect) {
		for (i, level) in self.mips.iter_mut().enumerate() {
			let size = TILE << (i + 1);
			let cols = self.width.div_ceil(size);
			for ty in r[1] / size..=(r[3] - 1) / size {
				for tx in r[0] / size..=(r[2] - 1) / size {
					level[(ty * cols + tx) as usize] = None;
				}
			}
		}
	}
	/// Mip tile (RGB, 512 x 512) of a level. Level 0 is a tile of the store. None is outside the image.
	fn mip(&mut self, level: u32, tx: u32, ty: u32) -> Option<Tile> {
		let size = TILE << level;
		let cols = self.width.div_ceil(size);
		if tx >= cols || ty >= self.height.div_ceil(size) {
			return None;
		}
		if level == 0 {
			return Some(self.s.tiles[(ty * cols + tx) as usize].clone());
		}
		if let Some(t) = &self.mips[level as usize - 1][(ty * cols + tx) as usize] {
			return Some(t.clone());
		}
		let mut out = vec![0u8; TILE_PX * 3];
		let half = TILE as usize / 2;
		for (q, (dx, dy)) in [(0, 0), (1, 0), (0, 1), (1, 1)].into_iter().enumerate() {
			let Some(c) = self.mip(level - 1, tx * 2 + dx, ty * 2 + dy) else { continue };
			let (ox, oy) = ((q % 2) * half, (q / 2) * half);
			for j in 0..half {
				for i in 0..half {
					for k in 0..3 {
						let p = |x: usize, y: usize| c[(y * TILE as usize + x) * 3 + k] as u32;
						let v = p(2 * i, 2 * j) + p(2 * i + 1, 2 * j) + p(2 * i, 2 * j + 1) + p(2 * i + 1, 2 * j + 1);
						out[((oy + j) * TILE as usize + ox + i) * 3 + k] = ((v + 2) / 4) as u8;
					}
				}
			}
		}
		let t = Arc::new(out);
		self.mips[level as usize - 1][(ty * cols + tx) as usize] = Some(t.clone());
		Some(t)
	}
	/// RGBA pixels for the view at a level (see the module comment). (x, y) is the first pixel in level pixels.
	/// Pixels outside the image have alpha 0.
	pub fn region(&mut self, level: u32, x: u32, y: u32, w: u32, h: u32) -> Vec<u8> {
		let level = level.min(self.mips.len() as u32);
		let mut out = vec![0u8; w as usize * h as usize * 4];
		let (lw, lh) = (self.width.div_ceil(1 << level), self.height.div_ceil(1 << level));
		let mut cache: Option<(u32, u32, Tile)> = None;
		for j in 0..h.min(lh.saturating_sub(y)) {
			let ly = y + j;
			for i in 0..w.min(lw.saturating_sub(x)) {
				let lx = x + i;
				let (tx, ty) = (lx / TILE, ly / TILE);
				if cache.as_ref().is_none_or(|c| c.0 != tx || c.1 != ty) {
					let Some(t) = self.mip(level, tx, ty) else { continue };
					cache = Some((tx, ty, t));
				}
				let t = &cache.as_ref().unwrap().2;
				let s = (((ly % TILE) * TILE + lx % TILE) * 3) as usize;
				let o = (j * w + i) as usize * 4;
				out[o..o + 3].copy_from_slice(&t[s..s + 3]);
				out[o + 3] = 255;
			}
		}
		out
	}
	/// Write the image as one 8-bit RGB PNG.
	pub fn export_png(&self, path: &Path) -> Result<(), String> {
		self.s.export_png(path, |p| [p[0], p[1], p[2]])
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	fn img() -> Sat {
		Sat::from_fn(1100, 600, |x, y| [(x % 256) as u8, (y % 256) as u8, 100])
	}
	fn brush(tool: Tool) -> Brush {
		Brush {
			radius: 10.0,
			hardness: 1.0,
			opacity: 1.0,
			tool,
		}
	}
	#[test]
	fn color_brush_blends_and_a_stroke_does_not_go_above_its_opacity() {
		let mut s = img();
		let before = s.get(50, 50);
		let b = Brush {
			opacity: 0.5,
			..brush(Tool::Color([255, 0, 0]))
		};
		s.line([40.0, 50.5], [60.0, 50.5], &b);
		let p = s.get(50, 50);
		// Half way from the old color to red, also with many dabs on the pixel.
		assert_eq!(p, [0, 1, 2].map(|i| (before[i] as f64 + ([255.0, 0.0, 0.0][i] - before[i] as f64) * 128.0 / 255.0).round() as u8));
		s.end_step();
		// A second stroke adds to the first.
		s.line([40.0, 50.5], [60.0, 50.5], &b);
		assert!(s.get(50, 50)[0] > p[0]);
		s.end_step();
		s.undo();
		assert_eq!(s.get(50, 50), p);
		s.undo();
		assert_eq!(s.get(50, 50), before);
		assert_eq!(s.region(0, 0, 0, 1100, 600), img().region(0, 0, 0, 1100, 600));
	}
	#[test]
	fn clone_copies_with_the_offset() {
		let mut s = img();
		s.dab(300.5, 300.5, &brush(Tool::Clone([-200.0, 50.0])));
		for (x, y) in [(300, 300), (295, 305), (309, 300)] {
			assert_eq!(s.get(x, y), [((x - 200) % 256) as u8, ((y + 50) % 256) as u8, 100]);
		}
		// Outside the brush, nothing changes.
		assert_eq!(s.get(311, 300), [(311 % 256) as u8, 44, 100]);
	}
	#[test]
	fn smooth_reduces_the_variance() {
		let mut s = Sat::from_fn(64, 64, |x, y| if (x + y) % 2 == 0 { [0, 0, 0] } else { [200, 200, 200] });
		let var = |s: &Sat| {
			let v: Vec<f64> = (20..44).flat_map(|y| (20..44).map(move |x| (x, y))).map(|(x, y)| s.get(x, y)[0] as f64).collect();
			let m = v.iter().sum::<f64>() / v.len() as f64;
			v.iter().map(|a| (a - m).powi(2)).sum::<f64>() / v.len() as f64
		};
		let v0 = var(&s);
		s.dab(32.0, 32.0, &Brush { radius: 20.0, ..brush(Tool::Smooth) });
		assert!(var(&s) < v0 * 0.05, "{} {}", var(&s), v0);
	}
	#[test]
	fn texture_brush_repeats_the_texture() {
		let mut s = img();
		let t = Texture {
			width: 2,
			height: 2,
			rgb: vec![10, 0, 0, 20, 0, 0, 30, 0, 0, 40, 0, 0],
		};
		assert_eq!(s.dab(5.0, 5.0, &brush(Tool::Texture)), None);
		// Resized to 4 x 4: each texture pixel covers 2 x 2 pixels.
		s.set_texture(&t, 4);
		s.dab(5.0, 5.0, &brush(Tool::Texture));
		assert_eq!([s.get(0, 0)[0], s.get(2, 0)[0], s.get(1, 3)[0], s.get(4, 4)[0], s.get(7, 2)[0]], [10, 20, 30, 10, 40]);
		assert_eq!(t.resized(1).rgb, vec![25, 0, 0]);
	}
	#[test]
	fn mip_levels_are_means_and_follow_changes() {
		let mut s = Sat::from_fn(2000, 1500, |x, _| if x % 2 == 0 { [0, 0, 0] } else { [100, 100, 100] });
		// 2000 px: levels 1 and 2 (2048 px for one tile).
		assert_eq!(s.mips.len(), 2);
		let r = s.region(1, 0, 0, 4, 1);
		assert_eq!(&r[..8], &[50, 50, 50, 255, 50, 50, 50, 255]);
		let top = s.region(2, 0, 0, 512, 512);
		// 1500 / 4 = 375 rows. Row 375 is outside.
		assert_eq!((top[(374 * 512) * 4 + 3], top[(375 * 512) * 4 + 3], top[500 * 4 + 3]), (255, 0, 0));
		assert_eq!(top[0], 50);
		s.dab(
			2.0,
			2.0,
			&Brush {
				radius: 2.0,
				..brush(Tool::Color([200, 200, 200]))
			},
		);
		assert!(s.region(2, 0, 0, 1, 1)[0] > 50);
		s.end_step();
		s.undo();
		assert_eq!(s.region(2, 0, 0, 1, 1)[0], 50);
	}
	#[test]
	fn dxt1_block_decodes() {
		// c0 = red (0xF800), c1 = blue (0x001F), c0 > c1: 4 colors. Indices: pixel 0 = c0, pixel 1 = c1, pixel 2 = 2/3 c0 + 1/3 c1.
		let block = [0x00, 0xF8, 0x1F, 0x00, 0b10_01_00, 0, 0, 0];
		let rgb = decode_dxt(paa::Format::Dxt1, 4, 4, &block).unwrap();
		assert_eq!(&rgb[..9], &[255, 0, 0, 0, 0, 255, 170, 0, 85]);
		assert_eq!(&rgb[9..12], &[255, 0, 0]);
	}
}
#[cfg(test)]
mod bench {
	use super::*;
	#[test]
	#[ignore]
	fn stroke_speed() {
		let mut s = Sat::from_fn(16384, 16384, |x, y| [(x % 256) as u8, (y % 256) as u8, 7]);
		s.region(5, 0, 0, 512, 512);
		for tool in [Tool::Color([200, 0, 0]), Tool::Clone([-300.0, 100.0]), Tool::Smooth] {
			let b = Brush {
				radius: 30.0,
				hardness: 0.5,
				opacity: 0.8,
				tool,
			};
			let t = std::time::Instant::now();
			for i in 0..50 {
				let x = 5000.0 + i as f64 * 20.0;
				s.line([x, 5000.0], [x + 20.0, 5000.0], &b);
			}
			let paint = t.elapsed().as_secs_f64() * 1000.0 / 50.0;
			s.end_step();
			let t = std::time::Instant::now();
			let _ = s.region(0, 9 * 512, 9 * 512, 512, 512);
			let l0 = t.elapsed().as_secs_f64() * 1000.0;
			let t = std::time::Instant::now();
			let _ = s.region(5, 0, 0, 512, 512);
			let top = t.elapsed().as_secs_f64() * 1000.0;
			eprintln!("{tool:?}: {paint:.2} ms for each 20 px segment, region level 0 {l0:.2} ms, top level after the change {top:.2} ms");
		}
	}
}
