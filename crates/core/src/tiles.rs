//! Tile pipeline: cut the satellite and the mask into tiles, encode the mask tiles, and write the tile RVMAT files.
//! The tool reads the source images row by row. It keeps only the rows of one tile row in memory.
use crate::layers_cfg::LayersCfg;
use crate::rvmat::{self, LayerMat, TileMat};
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// Mask tile code (R, G, B, A) for each slot.
pub const SLOT_CODES: [[u8; 4]; 6] = [[0, 0, 0, 255], [255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [0, 0, 255, 128], [0, 0, 255, 0]];

#[derive(Debug, Clone, Copy)]
pub struct Layout {
	pub image_px: u32,
	pub tile_px: u32,
	pub overlap_px: u32,
	pub mpp: f64,
	/// Tiles for each axis.
	pub n: u32,
}

impl Layout {
	pub fn new(image_px: u32, tile_px: u32, overlap_px: u32, mpp: f64) -> Result<Layout, String> {
		if overlap_px >= tile_px || overlap_px % 2 != 0 {
			return Err(format!("overlap {overlap_px} px must be even and less than the tile size {tile_px} px"));
		}
		let n = image_px.div_ceil(tile_px - overlap_px);
		Ok(Layout { image_px, tile_px, overlap_px, mpp, n })
	}
	pub fn step_px(&self) -> u32 {
		self.tile_px - self.overlap_px
	}
	/// Image pixel of tile pixel 0 on one axis. It can be less than 0 (the border).
	pub fn origin(&self, t: u32) -> i64 {
		t as i64 * self.step_px() as i64 - (self.overlap_px / 2) as i64
	}
	/// TexGen uvTransform of tile (tx, ty): aside, up, dir, pos.
	/// The V axis uses the image size. In the samples, the image size is equal to the tile size T.
	pub fn uv(&self, tx: u32, ty: u32) -> [[f64; 3]; 4] {
		let t = self.tile_px as f64 * self.mpp;
		let step = self.step_px() as f64 * self.mpp;
		let h = (self.overlap_px / 2) as f64 * self.mpp;
		let size = self.image_px as f64 * self.mpp;
		[[1.0 / t, 0.0, 0.0], [0.0, 0.0, 1.0 / t], [0.0, -1.0 / t, 0.0], [(h - tx as f64 * step) / t, (size + h - ty as f64 * step) / t, 0.0]]
	}
	/// True when each texture layer cell of `cell_px` pixels lies fully inside the tile that owns it (the tile of its first pixel).
	/// Each cell uses one tile RVMAT, so a cell must not cross the edge of its tile.
	pub fn cells_fit(&self, cell_px: u32) -> bool {
		if cell_px == 0 || self.image_px % cell_px != 0 {
			return false;
		}
		(0..self.image_px / cell_px).all(|c| {
			let start = (c * cell_px) as i64 - self.origin((c * cell_px / self.step_px()).min(self.n - 1));
			start >= 0 && start + cell_px as i64 <= self.tile_px as i64
		})
	}
	/// The lowest even overlap (2 px or more, as in TB) at which the texture layer cells fit in their tiles. None: no overlap fits.
	pub fn lowest_overlap(image_px: u32, tile_px: u32, cell_px: u32, mpp: f64) -> Option<u32> {
		(2..tile_px).step_by(2).find(|&o| Layout::new(image_px, tile_px, o, mpp).is_ok_and(|l| l.cells_fit(cell_px)))
	}
	/// Overlapped area as TB shows it: 1 - (step / tile)^2.
	pub fn overlapped_area(&self) -> f64 {
		1.0 - (self.step_px() as f64 / self.tile_px as f64).powi(2)
	}
}

/// Source image (PNG or 24/32-bit BMP, or rows from memory) that the tool reads row by row. Each row is RGB.
pub struct Rows<'a> {
	src: Src<'a>,
	pub(crate) width: u32,
	pub(crate) height: u32,
	next: u32,
	first: u32,
	buf: VecDeque<Vec<u8>>,
}

enum Src<'a> {
	/// Function that gives row y as RGB (an image in memory).
	Fn(Box<dyn FnMut(u32) -> Vec<u8> + 'a>),
	Png(png::Reader<BufReader<File>>, png::ColorType),
	/// File, offset of the pixel data, row stride, bytes for each pixel, rows are stored bottom-up.
	Bmp(File, u64, usize, usize, bool),
}

impl<'a> Rows<'a> {
	/// Rows from memory: `row(y)` gives row y (row 0 is the north row) as RGB, 3 bytes for each pixel.
	pub fn from_fn(width: u32, height: u32, row: impl FnMut(u32) -> Vec<u8> + 'a) -> Rows<'a> {
		Rows {
			src: Src::Fn(Box::new(row)),
			width,
			height,
			next: 0,
			first: 0,
			buf: VecDeque::new(),
		}
	}
	pub(crate) fn open(path: &Path) -> Result<Rows<'static>, String> {
		let err = |e: &dyn std::fmt::Display| format!("{}: {e}", path.display());
		let mut f = File::open(path).map_err(|e| err(&e))?;
		let mut head = [0u8; 54];
		let is_bmp = f.read_exact(&mut head).is_ok() && &head[0..2] == b"BM";
		f.seek(SeekFrom::Start(0)).map_err(|e| err(&e))?;
		if is_bmp {
			let u32_at = |o: usize| u32::from_le_bytes(head[o..o + 4].try_into().unwrap());
			let (width, h) = (u32_at(18), u32_at(22) as i32);
			let bpp = u16::from_le_bytes([head[28], head[29]]) as usize;
			let compression = u32_at(30);
			// Compression 3 (bit fields) is accepted for 32-bit files, which use the BGRA order.
			if !(bpp == 24 && compression == 0 || bpp == 32 && (compression == 0 || compression == 3)) {
				return Err(err(&format!("BMP with {bpp} bits and compression {compression} is not supported. Use 24-bit RGB.")));
			}
			let stride = (width as usize * bpp).div_ceil(32) * 4;
			let src = Src::Bmp(f, u32_at(10) as u64, stride, bpp / 8, h > 0);
			return Ok(Rows {
				src,
				width,
				height: h.unsigned_abs(),
				next: 0,
				first: 0,
				buf: VecDeque::new(),
			});
		}
		let mut d = png::Decoder::new(BufReader::new(f));
		d.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
		let reader = d.read_info().map_err(|e| err(&e))?;
		if reader.info().interlaced {
			return Err(err(&"interlaced PNG files are not supported. Save the file without interlace."));
		}
		let (width, height) = (reader.info().width, reader.info().height);
		let color = reader.output_color_type().0;
		Ok(Rows {
			src: Src::Png(reader, color),
			width,
			height,
			next: 0,
			first: 0,
			buf: VecDeque::new(),
		})
	}
	/// Read rows until row `last` is in memory.
	pub(crate) fn fill_to(&mut self, last: u32) -> Result<(), String> {
		while self.next <= last {
			let rgb: Vec<u8> = match &mut self.src {
				Src::Fn(f) => f(self.next),
				Src::Png(reader, color) => {
					let row = reader.next_row().map_err(|e| e.to_string())?.ok_or("PNG ends too early")?;
					let d = row.data();
					match color {
						png::ColorType::Rgb => d.to_vec(),
						png::ColorType::Rgba => d.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect(),
						png::ColorType::Grayscale => d.iter().flat_map(|&g| [g, g, g]).collect(),
						png::ColorType::GrayscaleAlpha => d.chunks_exact(2).flat_map(|p| [p[0], p[0], p[0]]).collect(),
						png::ColorType::Indexed => return Err("indexed PNG was not expanded".into()),
					}
				}
				Src::Bmp(f, data, stride, bytes, bottom_up) => {
					let r = if *bottom_up { self.height - 1 - self.next } else { self.next };
					let mut d = vec![0u8; *stride];
					f.seek(SeekFrom::Start(*data + r as u64 * *stride as u64)).map_err(|e| e.to_string())?;
					f.read_exact(&mut d).map_err(|_| "BMP ends too early".to_string())?;
					d.chunks_exact(*bytes).take(self.width as usize).flat_map(|p| [p[2], p[1], p[0]]).collect()
				}
			};
			self.buf.push_back(rgb);
			self.next += 1;
		}
		Ok(())
	}
	pub(crate) fn drop_before(&mut self, r: u32) {
		while self.first < r && !self.buf.is_empty() {
			self.buf.pop_front();
			self.first += 1;
		}
	}
	pub(crate) fn row(&self, r: u32) -> &[u8] {
		&self.buf[(r - self.first) as usize]
	}
	/// Load the rows of tile row `ty`. Rows outside the image are clamped.
	fn load_band(&mut self, l: &Layout, ty: u32) -> Result<(), String> {
		let o = l.origin(ty);
		let lo = o.clamp(0, self.height as i64 - 1) as u32;
		let hi = (o + l.tile_px as i64 - 1).clamp(0, self.height as i64 - 1) as u32;
		self.fill_to(hi)?;
		self.drop_before(lo);
		Ok(())
	}
}

fn write_png(path: &Path, w: u32, h: u32, color: png::ColorType, data: &[u8]) -> Result<(), String> {
	let f = File::create(path).map_err(|e| format!("{}: {e}", path.display()))?;
	let mut e = png::Encoder::new(BufWriter::new(f), w, h);
	e.set_color(color);
	e.set_depth(png::BitDepth::Eight);
	let mut wr = e.write_header().map_err(|e| e.to_string())?;
	wr.write_image_data(data).map_err(|e| format!("{}: {e}", path.display()))
}

fn check_size(rows: &Rows, l: &Layout, what: &str) -> Result<(), String> {
	if rows.width != l.image_px || rows.height != l.image_px {
		return Err(format!("{what} is {} x {} px. The settings need {} x {} px.", rows.width, rows.height, l.image_px, l.image_px));
	}
	Ok(())
}

/// Read an image (PNG or BMP) with a reduced size for the viewer. Returns width, height, and RGBA pixels.
/// The size is divided by the smallest power of 2 that gives at most `max_px` on each side. Each output pixel is the mean of its block.
pub fn downsample(src: &Path, max_px: u32) -> Result<(u32, u32, Vec<u8>), String> {
	let mut rows = Rows::open(src)?;
	let mut f = 1u32;
	while rows.width.div_ceil(f) > max_px || rows.height.div_ceil(f) > max_px {
		f *= 2;
	}
	let (w, h) = (rows.width.div_ceil(f), rows.height.div_ceil(f));
	let mut out = vec![255u8; (w * h * 4) as usize];
	let mut sum = vec![0u32; (w * 3) as usize];
	let mut n = vec![0u32; w as usize];
	for oy in 0..h {
		sum.fill(0);
		n.fill(0);
		let last = ((oy + 1) * f).min(rows.height) - 1;
		rows.fill_to(last)?;
		for y in oy * f..=last {
			for (x, p) in rows.row(y).chunks_exact(3).enumerate() {
				let o = x / f as usize;
				n[o] += 1;
				for c in 0..3 {
					sum[o * 3 + c] += p[c] as u32;
				}
			}
		}
		rows.drop_before(last + 1);
		for ox in 0..w as usize {
			for c in 0..3 {
				out[(oy as usize * w as usize + ox) * 4 + c] = (sum[ox * 3 + c] / n[ox]) as u8;
			}
		}
	}
	Ok((w, h, out))
}

/// Write the satellite tiles `S_<tx>_<ty>_lco.png`. Returns the number of tiles.
/// The border outside the image repeats the nearest edge pixel. Verified with the bro_msi sample tiles.
pub fn satellite_tiles(src: &Path, l: &Layout, out: &Path) -> Result<u32, String> {
	satellite_tiles_from(Rows::open(src)?, l, out, &mut |_| true)
}

/// The same as `satellite_tiles`, from rows in memory.
/// `progress` gets the part of the tile rows that is done.
pub fn satellite_tiles_from(mut rows: Rows, l: &Layout, out: &Path, progress: crate::Progress) -> Result<u32, String> {
	check_size(&rows, l, "satellite image")?;
	let tp = l.tile_px as usize;
	let last = l.image_px as i64 - 1;
	let mut tile = vec![0u8; tp * tp * 3];
	for ty in 0..l.n {
		if !progress(ty as f64 / l.n as f64) {
			return Err(crate::CANCELLED.into());
		}
		rows.load_band(l, ty)?;
		for tx in 0..l.n {
			for r in 0..tp {
				let src = rows.row((l.origin(ty) + r as i64).clamp(0, last) as u32);
				let dst = &mut tile[r * tp * 3..(r + 1) * tp * 3];
				for c in 0..tp {
					let s = (l.origin(tx) + c as i64).clamp(0, last) as usize * 3;
					dst[c * 3..c * 3 + 3].copy_from_slice(&src[s..s + 3]);
				}
			}
			write_png(&out.join(format!("S_{tx:03}_{ty:03}_lco.png")), l.tile_px, l.tile_px, png::ColorType::Rgb, &tile)?;
		}
	}
	Ok(l.n * l.n)
}

/// Input of the mask step.
pub struct MaskJob<'a> {
	pub layout: Layout,
	pub layers: &'a LayersCfg,
	/// One item for each layer. Layers without a found RVMAT have empty texture paths.
	pub mats: &'a [LayerMat],
	/// Texture layer cell size in pixels.
	pub cell_px: u32,
	pub prefix: String,
	pub diffuse: f64,
	pub repeat: f64,
}

#[derive(Debug, Default)]
pub struct MaskReport {
	pub tiles: u32,
	pub rvmats: u32,
	/// One line for each tile with more than 6 layers.
	pub errors: Vec<String>,
	/// RVMAT path (prefix and file name) of each texture layer cell. Row 0 is the north row.
	pub cells: Vec<String>,
}

/// Write the mask tiles `M_<tx>_<ty>_lca.png` and the tile RVMAT files.
pub fn mask_tiles(src: &Path, job: &MaskJob, out: &Path) -> Result<MaskReport, String> {
	mask_tiles_from(Rows::open(src)?, job, out, &mut |_| true)
}

/// The same as `mask_tiles`, from rows in memory.
/// `progress` gets the part of the tile rows that is done.
pub fn mask_tiles_from(mut rows: Rows, job: &MaskJob, out: &Path, progress: crate::Progress) -> Result<MaskReport, String> {
	let l = &job.layout;
	if job.cell_px == 0 || l.image_px % job.cell_px != 0 {
		return Err(format!("the texture layer cell ({} px) must divide the image ({} px). Change the texture layer size.", job.cell_px, l.image_px));
	}
	if !l.cells_fit(job.cell_px) {
		let low = Layout::lowest_overlap(l.image_px, l.tile_px, job.cell_px, l.mpp);
		return Err(format!(
			"with an overlap of {} px, some texture layer cells ({} px) cross the edge of their tile. {}",
			l.overlap_px,
			job.cell_px,
			low.map_or("No overlap fits with this tile size: change the tile size.".into(), |o| format!("The lowest overlap that fits is {o} px."))
		));
	}
	check_size(&rows, l, "mask image")?;
	let tp = l.tile_px as usize;
	let mut cache: HashMap<[u8; 3], u8> = job.layers.palette.iter().map(|&(c, i)| (c, i)).collect();
	let last = l.image_px as i64 - 1;
	let mut ids = vec![0u8; tp * tp];
	let mut rgba = vec![0u8; tp * tp * 4];
	let cells = l.image_px / job.cell_px;
	let mut rep = MaskReport {
		cells: vec![String::new(); (cells * cells) as usize],
		..Default::default()
	};
	let owner = |c: u32| (c * job.cell_px / l.step_px()).min(l.n - 1);
	for ty in 0..l.n {
		if !progress(ty as f64 / l.n as f64) {
			return Err(crate::CANCELLED.into());
		}
		rows.load_band(l, ty)?;
		for tx in 0..l.n {
			let mut count = [0u64; 256];
			// The border outside the image repeats the nearest edge pixel, as in the satellite tiles. Verified with bro_msi.
			for r in 0..tp {
				let row = rows.row((l.origin(ty) + r as i64).clamp(0, last) as u32);
				for c in 0..tp {
					let x = (l.origin(tx) + c as i64).clamp(0, last) as usize;
					let key = [row[x * 3], row[x * 3 + 1], row[x * 3 + 2]];
					let id = *cache.entry(key).or_insert_with(|| job.layers.nearest(key));
					count[id as usize] += 1;
					ids[r * tp + c] = id;
				}
			}
			// Slot list: the layers in the tile, in ascending layer number. Assumed rule, see the build brief.
			let present: Vec<u8> = (0..=255u8).filter(|&i| count[i as usize] > 0).collect();
			if present.len() > 6 {
				let names: Vec<&str> = present.iter().map(|&i| job.layers.layers[i as usize].name.as_str()).collect();
				rep.errors.push(format!("tile ({tx},{ty}) has {} layers: {}", present.len(), names.join(", ")));
				continue;
			}
			let mut slot = [0u8; 256];
			for (s, &i) in present.iter().enumerate() {
				slot[i as usize] = s as u8;
			}
			for (px, &id) in rgba.chunks_exact_mut(4).zip(&ids) {
				px.copy_from_slice(&SLOT_CODES[slot[id as usize] as usize]);
			}
			write_png(&out.join(format!("M_{tx:03}_{ty:03}_lca.png")), l.tile_px, l.tile_px, png::ColorType::Rgba, &rgba)?;
			rep.tiles += 1;
			// Combinations: the set of slots in each texture layer cell that this tile owns.
			let mut combos = BTreeSet::new();
			let mut owned = Vec::new();
			for cy in (0..cells).filter(|&c| owner(c) == ty) {
				for cx in (0..cells).filter(|&c| owner(c) == tx) {
					let mut bits = 0u8;
					for y in 0..job.cell_px as i64 {
						let r = (cy * job.cell_px) as i64 + y - l.origin(ty);
						for x in 0..job.cell_px as i64 {
							let c = (cx * job.cell_px) as i64 + x - l.origin(tx);
							bits |= 1 << slot[ids[r as usize * tp + c as usize] as usize];
						}
					}
					combos.insert(bits);
					owned.push(((cy * cells + cx) as usize, bits));
				}
			}
			let uv = l.uv(tx, ty);
			let file = |bits: u8| {
				let names: Vec<String> = present.iter().enumerate().map(|(s, &i)| if bits & (1 << s) != 0 { format!("L{i:02}") } else { "N".into() }).collect();
				format!("P_{tx:03}-{ty:03}_{}.rvmat", names.join("_"))
			};
			for (cell, bits) in owned {
				rep.cells[cell] = format!("{}{}", job.prefix, file(bits));
			}
			for bits in combos {
				let slots: Vec<Option<&LayerMat>> = present.iter().enumerate().map(|(s, &i)| (bits & (1 << s) != 0).then(|| &job.mats[i as usize])).collect();
				let t = TileMat {
					sat: format!("{}s_{tx:03}_{ty:03}_lco.png", job.prefix).to_ascii_lowercase(),
					mask: format!("{}m_{tx:03}_{ty:03}_lca.png", job.prefix).to_ascii_lowercase(),
					uv,
					diffuse: job.diffuse,
					repeat: job.repeat,
					slots,
				};
				let path = out.join(file(bits));
				std::fs::write(&path, rvmat::write_tile(&t)).map_err(|e| format!("{}: {e}", path.display()))?;
				rep.rvmats += 1;
			}
		}
	}
	Ok(rep)
}

/// Result of the search for one layer RVMAT.
pub struct Found {
	pub layer: String,
	pub material: String,
	pub path: Option<PathBuf>,
	pub mat: Result<LayerMat, String>,
}

/// Find and read the layer RVMAT files in the search roots.
/// shortcut: loose files only. Paths inside PBO files (for example `a3\...`) are not found until the PBO index exists (milestone M2).
pub fn find_layer_mats(cfg: &LayersCfg, roots: &[PathBuf]) -> Vec<Found> {
	cfg.layers
		.iter()
		.map(|l| {
			let rel = l.material.replace('\\', std::path::MAIN_SEPARATOR_STR);
			let path = roots.iter().map(|r| r.join(&rel)).find(|p| p.is_file());
			let mat = match &path {
				None => Err("not found".to_string()),
				Some(p) => std::fs::read_to_string(p).map_err(|e| e.to_string()).and_then(|t| rvmat::parse_layer(&t)),
			};
			Found {
				layer: l.name.clone(),
				material: l.material.clone(),
				path,
				mat,
			}
		})
		.collect()
}

#[cfg(test)]
mod tests {
	use super::*;
	fn tmp(name: &str) -> PathBuf {
		let d = std::env::temp_dir().join(format!("terrain_tiles_{name}_{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&d);
		std::fs::create_dir_all(&d).unwrap();
		d
	}
	fn read_png(p: &Path) -> (u32, Vec<u8>) {
		let mut r = png::Decoder::new(File::open(p).unwrap()).read_info().unwrap();
		let mut b = vec![0; r.output_buffer_size()];
		let i = r.next_frame(&mut b).unwrap();
		b.truncate(i.buffer_size());
		(i.width, b)
	}
	#[test]
	fn lowest_overlap_keeps_cells_in_their_tiles() {
		// bro_msi: 64 px cells, 2048 px tiles, overlap 512 (TB) fits; the lowest is 64 (the step 1984 is then 31 cells).
		assert!(Layout::new(2048, 2048, 512, 1.0).unwrap().cells_fit(64));
		assert_eq!(Layout::lowest_overlap(2048, 2048, 64, 1.0), Some(64));
		// 5120 px, 32 px cells, 1024 px tiles: the step must be a multiple of 32, so 32 px.
		assert_eq!(Layout::lowest_overlap(5120, 1024, 32, 1.0), Some(32));
		assert!(!Layout::new(5120, 1024, 2, 1.0).unwrap().cells_fit(32));
	}
	#[test]
	fn uv_matches_the_samples() {
		let r = Layout::new(2048, 2048, 512, 0.5).unwrap();
		assert_eq!(r.n, 2);
		assert_eq!(r.uv(0, 0)[3], [0.125, 1.125, 0.0]);
		assert_eq!(r.uv(0, 1)[3], [0.125, 0.375, 0.0]);
		assert_eq!(r.uv(1, 0)[3], [-0.625, 1.125, 0.0]);
		assert_eq!(r.uv(1, 1)[0], [0.0009765625, 0.0, 0.0]);
		let m = Layout::new(2048, 2048, 512, 1.0).unwrap();
		assert_eq!(m.uv(1, 1)[3], [-0.625, 0.375, 0.0]);
		assert_eq!(m.overlapped_area(), 0.4375);
		assert_eq!(Layout::new(16384, 2048, 512, 1.0).unwrap().n, 11);
	}
	#[test]
	fn cuts_and_encodes_small_image() {
		let d = tmp("small");
		let l = Layout::new(24, 16, 4, 1.0).unwrap();
		assert_eq!(l.n, 2);
		// Satellite: pixel value = x for red, y for green.
		let sat: Vec<u8> = (0..24u8).flat_map(|y| (0..24u8).flat_map(move |x| [x, y, 7])).collect();
		write_png(&d.join("sat.png"), 24, 24, png::ColorType::Rgb, &sat).unwrap();
		assert_eq!(satellite_tiles(&d.join("sat.png"), &l, &d).unwrap(), 4);
		let (w, t) = read_png(&d.join("S_001_000_lco.png"));
		assert_eq!(w, 16);
		// Tile (1,0) pixel (r=5, c=3) is image pixel (y=3, x=13).
		assert_eq!(&t[(5 * 16 + 3) * 3..(5 * 16 + 3) * 3 + 3], &[13, 3, 7]);
		// Border pixel (r=0, c=0) of tile (0,0) repeats image pixel (0,0).
		let (_, t0) = read_png(&d.join("S_000_000_lco.png"));
		assert_eq!(&t0[0..3], &[0, 0, 7]);
		// Mask: x < 11 is layer 2 (red), the rest is layer 0 (green), with one blue pixel of layer 1.
		let cfg = crate::layers_cfg::parse("class Layers { class a { material=\"a.rvmat\"; }; class b { material=\"b.rvmat\"; }; class c { material=\"c.rvmat\"; }; };\nclass Legend { class Colors { a[]={{0,255,0}}; b[]={{0,0,255}}; c[]={{255,0,0}}; }; };").unwrap();
		let mut mask: Vec<u8> = (0..24 * 24).flat_map(|i| if i % 24 < 11 { [250, 3, 0] } else { [0, 255, 0] }).collect();
		mask[(20 * 24 + 20) * 3..(20 * 24 + 20) * 3 + 3].copy_from_slice(&[0, 0, 255]);
		write_png(&d.join("mask.png"), 24, 24, png::ColorType::Rgb, &mask).unwrap();
		let mats: Vec<LayerMat> = ["a", "b", "c"]
			.iter()
			.map(|n| LayerMat {
				diffuse: 1.0,
				repeat: 5.0,
				nopx: format!("{n}_nopx.paa"),
				co: format!("{n}_co.paa"),
			})
			.collect();
		let job = MaskJob {
			layout: l,
			layers: &cfg,
			mats: &mats,
			cell_px: 2,
			prefix: "x\\layers\\".into(),
			diffuse: 1.0,
			repeat: 5.0,
		};
		let rep = mask_tiles(&d.join("mask.png"), &job, &d).unwrap();
		assert_eq!((rep.tiles, rep.errors.len()), (4, 0));
		// Tile (0,0) has layers 0 and 2: slot 0 = layer 0 (black), slot 1 = layer 2 (red).
		let (_, m) = read_png(&d.join("M_000_000_lca.png"));
		let px = |r: usize, c: usize| &m[(r * 16 + c) * 4..(r * 16 + c) * 4 + 4];
		assert_eq!(px(4, 4), &[255, 0, 0, 255]);
		assert_eq!(px(4, 15), &[0, 0, 0, 255]);
		// The border repeats the nearest edge pixel: red at the left, green (slot 0, black) at the right.
		assert_eq!(px(0, 0), &[255, 0, 0, 255]);
		assert_eq!(px(0, 15), &[0, 0, 0, 255]);
		let mut names: Vec<String> = std::fs::read_dir(&d)
			.unwrap()
			.map(|e| e.unwrap().file_name().into_string().unwrap())
			.filter(|n| n.starts_with("P_000-000"))
			.collect();
		names.sort();
		assert_eq!(names, ["P_000-000_L00_L02.rvmat", "P_000-000_N_L02.rvmat"]);
		let r = std::fs::read_to_string(d.join("P_000-000_N_L02.rvmat")).unwrap();
		assert!(r.contains("texture=\"x\\layers\\s_000_000_lco.png\";"));
		assert!(r.contains("c_co.paa"));
		// Tile (1,1) has the blue pixel: three layers, slot 1 = layer 1 = blue.
		let (_, m11) = read_png(&d.join("M_001_001_lca.png"));
		let o = (10 * 16 + 10) * 4;
		assert_eq!(&m11[o..o + 4], &[255, 0, 0, 255]);
		std::fs::remove_dir_all(&d).unwrap();
	}
	#[test]
	fn reads_bottom_up_bmp_with_row_padding() {
		let d = tmp("bmp");
		// 3 x 2 pixels, 24-bit: each row has 9 bytes and 3 bytes of padding. The file stores the bottom row first.
		let mut b = b"BM".to_vec();
		b.extend([0u8; 8]);
		b.extend(54u32.to_le_bytes());
		b.extend(40u32.to_le_bytes());
		b.extend(3i32.to_le_bytes());
		b.extend(2i32.to_le_bytes());
		b.extend(1u16.to_le_bytes());
		b.extend(24u16.to_le_bytes());
		b.extend([0u8; 24]);
		b.extend([3, 2, 1, 6, 5, 4, 9, 8, 7, 0, 0, 0, 30, 20, 10, 60, 50, 40, 90, 80, 70, 0, 0, 0]);
		std::fs::write(d.join("a.bmp"), &b).unwrap();
		let mut r = Rows::open(&d.join("a.bmp")).unwrap();
		r.fill_to(1).unwrap();
		assert_eq!((r.width, r.height), (3, 2));
		assert_eq!(r.row(0), &[10, 20, 30, 40, 50, 60, 70, 80, 90]);
		assert_eq!(r.row(1), &[1, 2, 3, 4, 5, 6, 7, 8, 9]);
		std::fs::remove_dir_all(&d).unwrap();
	}
	#[test]
	fn downsample_makes_block_means() {
		let d = tmp("down");
		let img: Vec<u8> = (0..6u8).flat_map(|y| (0..6u8).flat_map(move |x| [x * 10, y * 10, 0])).collect();
		write_png(&d.join("a.png"), 6, 6, png::ColorType::Rgb, &img).unwrap();
		let (w, h, px) = downsample(&d.join("a.png"), 4).unwrap();
		assert_eq!((w, h), (3, 3));
		// Output pixel (1, 2) is the mean of x 2..3 and y 4..5.
		assert_eq!(&px[(2 * 3 + 1) * 4..(2 * 3 + 1) * 4 + 4], &[25, 45, 0, 255]);
		std::fs::remove_dir_all(&d).unwrap();
	}
	#[test]
	fn reports_tiles_with_too_many_layers() {
		let d = tmp("many");
		let l = Layout::new(8, 8, 2, 1.0).unwrap();
		let mut cls = String::new();
		let mut cols = String::new();
		for i in 0..7 {
			cls += &format!("class l{i} {{ material=\"\"; }};");
			cols += &format!("l{i}[]={{{{{},0,0}}}};", i * 30);
		}
		let cfg = crate::layers_cfg::parse(&format!("class Layers {{ {cls} }}; class Legend {{ class Colors {{ {cols} }}; }};")).unwrap();
		let mask: Vec<u8> = (0..64).flat_map(|i| [(i % 7) as u8 * 30, 0, 0]).collect();
		write_png(&d.join("mask.png"), 8, 8, png::ColorType::Rgb, &mask).unwrap();
		let mats = vec![
			LayerMat {
				diffuse: 1.0,
				repeat: 5.0,
				nopx: String::new(),
				co: String::new()
			};
			7
		];
		let job = MaskJob {
			layout: l,
			layers: &cfg,
			mats: &mats,
			cell_px: 1,
			prefix: String::new(),
			diffuse: 1.0,
			repeat: 5.0,
		};
		let rep = mask_tiles(&d.join("mask.png"), &job, &d).unwrap();
		assert!(!rep.errors.is_empty());
		assert!(rep.errors[0].starts_with("tile (0,0) has 7 layers"));
		std::fs::remove_dir_all(&d).unwrap();
	}
}
