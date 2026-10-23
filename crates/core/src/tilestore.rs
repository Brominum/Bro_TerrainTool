//! Image in tiles of 512 x 512 px with `bpp` bytes for each pixel. The mask painter (1 byte) and the satellite painter (3 bytes, RGB) use it.
//! Tiles with the same content share memory, and a change copies only that tile. The tiles of the import stay available (erase).
//! Undo keeps the before-image of each changed tile for each step.
//! shortcut: all tiles stay in memory. The user's PC has 96 GB. Add a disk cache if a smaller PC must open the target map.
use std::collections::HashMap;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::sync::Arc;

pub const TILE: u32 = 512;
pub(crate) const TILE_PX: usize = (TILE * TILE) as usize;

pub(crate) type Tile = Arc<Vec<u8>>;

/// Rectangle of image pixels: x0, y0 (included), x1, y1 (not included). Row 0 is the north row.
pub type Rect = [u32; 4];

pub(crate) fn union(a: Option<Rect>, b: Rect) -> Rect {
	match a {
		None => b,
		Some(a) => [a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])],
	}
}

/// Call `line` for each pair of points that follow each other (one point: a line from the point to itself). Returns the union of the changed areas.
/// The view sends the mouse points of a stroke in groups, so that the requests do not wait in a queue.
pub fn polyline(pts: &[[f64; 2]], mut line: impl FnMut([f64; 2], [f64; 2]) -> Option<Rect>) -> Option<Rect> {
	if pts.len() == 1 {
		return line(pts[0], pts[0]);
	}
	let mut dirty = None;
	for w in pts.windows(2) {
		if let Some(r) = line(w[0], w[1]) {
			dirty = Some(union(dirty, r));
		}
	}
	dirty
}

/// One undo step: the tiles before (or after, in the redo list) the change.
#[derive(Default)]
struct Step {
	tiles: Vec<(usize, Tile)>,
	rect: Option<Rect>,
}

pub struct Store {
	pub width: u32,
	pub height: u32,
	pub bpp: usize,
	pub(crate) cols: u32,
	pub(crate) tiles: Vec<Tile>,
	pub(crate) orig: Vec<Tile>,
	undo: Vec<Step>,
	redo: Vec<Step>,
	open: Option<Step>,
	/// Tiles that are in the open step.
	saved: Vec<bool>,
	/// Memory limit of the undo list in bytes.
	pub undo_limit: usize,
	/// Goes up with each change, undo, and redo. A save writes the image only when the version changed.
	pub version: u64,
}

static NEXT_IMAGE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Write a file: first a temporary file, then a rename. So a failure does not destroy the old file.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
	let err = |e: &dyn std::fmt::Display| format!("{}: {e}", path.display());
	let mut tmp = path.as_os_str().to_owned();
	tmp.push(".tmp");
	std::fs::write(&tmp, bytes).map_err(|e| err(&e))?;
	std::fs::rename(&tmp, path).map_err(|e| err(&e))
}

impl Store {
	/// Tile number and pixel number in the tile.
	pub(crate) fn index(&self, x: u32, y: u32) -> (usize, usize) {
		((y / TILE * self.cols + x / TILE) as usize, ((y % TILE) * TILE + x % TILE) as usize)
	}
	pub fn get(&self, x: u32, y: u32) -> &[u8] {
		let (t, o) = self.index(x, y);
		&self.tiles[t][o * self.bpp..(o + 1) * self.bpp]
	}
	/// The tile for a change. The first change of a tile in a step keeps its before-image.
	pub(crate) fn tile_mut(&mut self, t: usize) -> &mut Vec<u8> {
		if !self.saved[t] {
			self.saved[t] = true;
			self.open.get_or_insert_with(Default::default).tiles.push((t, self.tiles[t].clone()));
		}
		Arc::make_mut(&mut self.tiles[t])
	}
	pub(crate) fn clip(&self, r: [i64; 4]) -> Option<Rect> {
		let c = [r[0].max(0), r[1].max(0), r[2].min(self.width as i64), r[3].min(self.height as i64)];
		(c[0] < c[2] && c[1] < c[3]).then(|| c.map(|v| v as u32))
	}
	/// Add an area to the changed area of the open step.
	pub(crate) fn mark(&mut self, r: Rect) {
		self.version += 1;
		let s = self.open.get_or_insert_with(Default::default);
		s.rect = Some(union(s.rect, r));
	}
	pub(crate) fn has_changes(&self) -> bool {
		self.open.as_ref().is_some_and(|s| !s.tiles.is_empty())
	}
	/// Call `f(x, y, current, imported, out)` for each pixel in the rectangle. `out` starts as the current pixel. Return true to set it.
	/// Only tiles with a change are copied. Returns the changed area (the part of each changed tile in the rectangle).
	pub(crate) fn apply(&mut self, r: [i64; 4], mut f: impl FnMut(u32, u32, &[u8], &[u8], &mut [u8]) -> bool) -> Option<Rect> {
		let r = self.clip(r)?;
		let n = self.bpp;
		let mut dirty = None;
		let mut changes: Vec<(usize, [u8; 4])> = Vec::new();
		for ty in r[1] / TILE..=(r[3] - 1) / TILE {
			for tx in r[0] / TILE..=(r[2] - 1) / TILE {
				let t = (ty * self.cols + tx) as usize;
				let a = [r[0].max(tx * TILE), r[1].max(ty * TILE), r[2].min((tx + 1) * TILE), r[3].min((ty + 1) * TILE)];
				changes.clear();
				let (cur, orig) = (&self.tiles[t], &self.orig[t]);
				for y in a[1]..a[3] {
					for x in a[0]..a[2] {
						let o = ((y % TILE) * TILE + x % TILE) as usize * n;
						let mut px = [0u8; 4];
						px[..n].copy_from_slice(&cur[o..o + n]);
						if f(x, y, &cur[o..o + n], &orig[o..o + n], &mut px[..n]) && px[..n] != cur[o..o + n] {
							changes.push((o, px));
						}
					}
				}
				if !changes.is_empty() {
					let d = self.tile_mut(t);
					for (o, px) in &changes {
						d[*o..*o + n].copy_from_slice(&px[..n]);
					}
					dirty = Some(union(dirty, a));
				}
			}
		}
		if let Some(d) = dirty {
			self.mark(d);
		}
		dirty
	}
	/// Close the open step and put it in the undo list.
	pub fn end_step(&mut self) {
		let Some(s) = self.open.take() else { return };
		for (t, _) in &s.tiles {
			self.saved[*t] = false;
		}
		if s.tiles.is_empty() {
			return;
		}
		self.undo.push(s);
		self.redo.clear();
		// shortcut: each kept tile counts its full size, also when it shares memory, and the tiles are not compressed. Compress them if the limit is too small.
		let size = TILE_PX * self.bpp;
		while self.undo.len() > 1 && self.undo.iter().map(|s| s.tiles.len() * size).sum::<usize>() > self.undo_limit {
			self.undo.remove(0);
		}
	}
	fn swap(&mut self, mut s: Step) -> Step {
		self.version += 1;
		for (t, tile) in &mut s.tiles {
			std::mem::swap(&mut self.tiles[*t], tile);
		}
		s
	}
	/// Undo the last step. Returns the changed area.
	pub fn undo(&mut self) -> Option<Rect> {
		self.end_step();
		let s = self.undo.pop()?;
		let s = self.swap(s);
		let r = s.rect;
		self.redo.push(s);
		r
	}
	pub fn redo(&mut self) -> Option<Rect> {
		self.end_step();
		let s = self.redo.pop()?;
		let s = self.swap(s);
		let r = s.rect;
		self.undo.push(s);
		r
	}
	pub fn can_undo(&self) -> bool {
		!self.undo.is_empty() || self.has_changes()
	}
	pub fn can_redo(&self) -> bool {
		!self.redo.is_empty()
	}
	#[cfg(test)]
	pub(crate) fn undo_len(&self) -> usize {
		self.undo.len()
	}
	/// Write one 8-bit RGB PNG, row by row. `rgb` gives the color of each pixel. The tool writes a temporary file first, then renames it.
	pub(crate) fn export_png(&self, path: &Path, mut rgb: impl FnMut(&[u8]) -> [u8; 3]) -> Result<(), String> {
		let err = |e: &dyn std::fmt::Display| format!("{}: {e}", path.display());
		let tmp = path.with_extension("tmp.png");
		{
			let f = std::fs::File::create(&tmp).map_err(|e| err(&e))?;
			let mut e = png::Encoder::new(BufWriter::new(f), self.width, self.height);
			e.set_color(png::ColorType::Rgb);
			e.set_depth(png::BitDepth::Eight);
			e.set_compression(png::Compression::Fast);
			let mut wr = e.write_header().map_err(|e| err(&e))?;
			let mut s = wr.stream_writer().map_err(|e| err(&e))?;
			let mut row = vec![0u8; self.width as usize * 3];
			for y in 0..self.height {
				for (x, p) in row.chunks_exact_mut(3).enumerate() {
					p.copy_from_slice(&rgb(self.get(x as u32, y)));
				}
				s.write_all(&row).map_err(|e| err(&e))?;
			}
			s.finish().map_err(|e| err(&e))?;
		}
		std::fs::rename(&tmp, path).map_err(|e| err(&e))
	}
}

/// Collects rows into tiles. Uniform tiles of one pixel value share one buffer.
pub(crate) struct Builder {
	w: u32,
	h: u32,
	bpp: usize,
	cols: u32,
	band: Vec<Vec<u8>>,
	tiles: Vec<Tile>,
	uniform: HashMap<Vec<u8>, Tile>,
}

impl Builder {
	pub(crate) fn new(w: u32, h: u32, bpp: usize) -> Builder {
		let cols = w.div_ceil(TILE);
		Builder {
			w,
			h,
			bpp,
			cols,
			band: vec![vec![0; TILE_PX * bpp]; cols as usize],
			tiles: Vec::new(),
			uniform: HashMap::new(),
		}
	}
	/// Add image row y (`bpp` bytes for each pixel). The rows must come in order.
	pub(crate) fn row(&mut self, y: u32, px: &[u8]) {
		let n = self.bpp;
		let r = ((y % TILE) * TILE) as usize * n;
		for (tx, t) in self.band.iter_mut().enumerate() {
			let x0 = tx * TILE as usize;
			let k = (self.w as usize - x0).min(TILE as usize);
			t[r..r + k * n].copy_from_slice(&px[x0 * n..(x0 + k) * n]);
			// Pixels outside the image repeat the first pixel of the tile, so that a uniform edge tile can share memory.
			let first = t[..n].to_vec();
			for p in t[r + k * n..r + TILE as usize * n].chunks_exact_mut(n) {
				p.copy_from_slice(&first);
			}
		}
		if y % TILE == TILE - 1 || y + 1 == self.h {
			let last = (y % TILE + 1) as usize * TILE as usize * n;
			for t in 0..self.cols as usize {
				let mut b = std::mem::replace(&mut self.band[t], vec![0; TILE_PX * n]);
				let first = b[..n].to_vec();
				for p in b[last..].chunks_exact_mut(n) {
					p.copy_from_slice(&first);
				}
				let tile = if b.chunks_exact(n).all(|p| p == first) {
					self.uniform.entry(first).or_insert_with(|| Arc::new(b)).clone()
				} else {
					Arc::new(b)
				};
				self.tiles.push(tile);
			}
		}
	}
	pub(crate) fn finish(self) -> Store {
		let n = self.tiles.len();
		Store {
			width: self.w,
			height: self.h,
			bpp: self.bpp,
			cols: self.cols,
			orig: self.tiles.clone(),
			tiles: self.tiles,
			undo: Vec::new(),
			redo: Vec::new(),
			open: None,
			saved: vec![false; n],
			undo_limit: 512 << 20,
			// Each new image starts at its own number, so that a saved version of an older image never matches.
			version: NEXT_IMAGE.fetch_add(1, std::sync::atomic::Ordering::Relaxed) << 32,
		}
	}
}

#[cfg(test)]
mod tests {
	#[test]
	fn polyline_calls_each_segment() {
		let mut seen = Vec::new();
		let r = super::polyline(&[[1.0, 1.0], [5.0, 2.0], [3.0, 9.0]], |a, z| {
			seen.push((a, z));
			Some([a[0].min(z[0]) as u32, a[1].min(z[1]) as u32, a[0].max(z[0]) as u32 + 1, a[1].max(z[1]) as u32 + 1])
		});
		assert_eq!(seen, vec![([1.0, 1.0], [5.0, 2.0]), ([5.0, 2.0], [3.0, 9.0])]);
		assert_eq!(r, Some([1, 1, 6, 10]));
		seen.clear();
		super::polyline(&[[4.0, 4.0]], |a, z| {
			seen.push((a, z));
			None
		});
		assert_eq!(seen, vec![([4.0, 4.0], [4.0, 4.0])]);
	}
}
