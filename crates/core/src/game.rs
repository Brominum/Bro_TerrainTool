//! Export for the game: the satellite and mask tiles, the tile RVMAT files, and the editable WRP, from the images and heights in memory.
//! The tile steps are the same as in `tilegen`. The WRP is made new: heights, the RVMAT of each texture layer cell, and the objects.
use crate::height::Heights;
use crate::layers_cfg;
use crate::mask::Mask;
use crate::rvmat::LayerMat;
use crate::sat::Sat;
use crate::tiles::{self, Layout, MaskJob, Rows};
use crate::tilestore::write_atomic;
use crate::wrp::{Body, Object, Wrp};
use std::path::PathBuf;

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
	/// Output WRP file.
	pub wrp: PathBuf,
	/// Folder for the tiles and the tile RVMAT files.
	pub layers_dir: PathBuf,
	/// Game path of the layers folder, for example `bromine\bro_msi\data\layers\`.
	pub prefix: String,
	pub tile_px: u32,
	pub overlap_px: u32,
	/// Texture layer size in meters.
	pub layer_size: f64,
	pub layers_cfg: PathBuf,
	/// Folders to find the layer RVMAT files of layers.cfg (for example `P:\`).
	pub search_roots: Vec<PathBuf>,
	/// Write the satellite tiles.
	pub satellite: bool,
}

/// Result: the written files (`S_` and `M_` tiles, PNG) and one line for each step or warning.
#[derive(Debug, Default, serde::Serialize)]
pub struct Report {
	pub pngs: Vec<PathBuf>,
	pub lines: Vec<String>,
}

/// Write the tiles, the RVMAT files, and the WRP. `objects` are in the WRP form (model game path, transform). Their IDs are set here.
/// `progress`: see `Progress`. The satellite tiles are the first half when they are written, then the mask tiles, then the WRP.
pub fn export(s: &Settings, mask: &Mask, sat: Option<&Sat>, heights: &Heights, mut objects: Vec<Object>, progress: crate::Progress) -> Result<Report, String> {
	let mut rep = Report::default();
	let px = mask.width;
	if mask.height != px {
		return Err(format!("the mask must be square. It is {} x {} px.", mask.width, mask.height));
	}
	let size = heights.ncols as f64 * heights.cellsize;
	let mpp = size / px as f64;
	let cell_px = s.layer_size / mpp;
	if cell_px.fract().abs() > 1e-9 {
		return Err(format!("the texture layer size {} m is not a whole number of mask pixels ({mpp} m for each pixel)", s.layer_size));
	}
	let l = Layout::new(px, s.tile_px, s.overlap_px, mpp)?;
	rep.lines.push(format!("map {size} m, mask {px} px ({mpp} m/px), {} x {} tiles of {} px", l.n, l.n, l.tile_px));
	let text = std::fs::read_to_string(&s.layers_cfg).map_err(|e| format!("{}: {e}", s.layers_cfg.display()))?;
	let cfg = layers_cfg::parse(&text)?;
	rep.lines.extend(cfg.warnings.iter().map(|w| format!("layers.cfg: {w}")));
	// Diffuse and repeat come from the first layer RVMAT, as in tilegen.
	let found = tiles::find_layer_mats(&cfg, &s.search_roots);
	// A layer without its RVMAT has no ground detail textures in the game, so stop.
	let bad: Vec<String> = found.iter().filter_map(|f| f.mat.as_ref().err().map(|e| format!("layer {}: {} ({e})", f.layer, f.material))).collect();
	if !bad.is_empty() {
		return Err(format!("the layer RVMAT files of layers.cfg must be in the model folders:\n{}", bad.join("\n")));
	}
	let first = found.first().and_then(|f| f.mat.as_ref().ok());
	let (diffuse, repeat) = (first.map_or(1.0, |m| m.diffuse), first.map_or(5.0, |m| m.repeat));
	let mats: Vec<LayerMat> = found
		.into_iter()
		.map(|f| {
			f.mat.unwrap_or(LayerMat {
				diffuse,
				repeat,
				nopx: String::new(),
				co: String::new(),
			})
		})
		.collect();
	let mut prefix = s.prefix.trim().to_string();
	if !prefix.is_empty() && !prefix.ends_with('\\') {
		prefix.push('\\');
	}
	std::fs::create_dir_all(&s.layers_dir).map_err(|e| format!("{}: {e}", s.layers_dir.display()))?;
	if let (true, Some(sat)) = (s.satellite, sat) {
		if sat.width != px || sat.height != px {
			return Err(format!("the satellite image is {} x {} px, the mask is {px} x {px} px", sat.width, sat.height));
		}
		let rows = Rows::from_fn(px, px, |y| (0..px).flat_map(|x| sat.get(x, y)).collect());
		let n = tiles::satellite_tiles_from(rows, &l, &s.layers_dir, &mut |v| progress(v * 0.5))?;
		rep.lines.push(format!("{n} satellite tiles"));
		rep.pngs.extend(names(&l, "S", "lco"));
	}
	let job = MaskJob {
		layout: l,
		layers: &cfg,
		mats: &mats,
		cell_px: cell_px as u32,
		prefix,
		diffuse,
		repeat,
	};
	let rows = Rows::from_fn(px, px, |y| (0..px).flat_map(|x| mask.colors[mask.get(x, y) as usize]).collect());
	let first = if s.satellite && sat.is_some() { 0.5 } else { 0.0 };
	let mt = tiles::mask_tiles_from(rows, &job, &s.layers_dir, &mut |v| progress(first + v * (0.95 - first)))?;
	if !mt.errors.is_empty() {
		return Err(format!("{} tiles have more than 6 layers (a tile can have 6 at most):\n{}", mt.errors.len(), mt.errors.join("\n")));
	}
	rep.lines.push(format!("{} mask tiles, {} RVMAT files in {}", mt.tiles, mt.rvmats, s.layers_dir.display()));
	rep.pngs.extend(names(&l, "M", "lca"));
	let cells = px / cell_px as u32;
	let values = heights.values();
	let south: Vec<f32> = values.chunks(heights.ncols).rev().flatten().copied().collect();
	let count = objects.len();
	for (i, o) in objects.iter_mut().enumerate() {
		o.id = i as u32;
	}
	// End marker: NaN matrix and an empty model path. shortcut: its ID in TB files has an unknown meaning (bro_range: 21228356); the object count is used.
	objects.push(Object {
		transform: [f32::NAN; 12],
		id: count as u32,
		model: String::new(),
	});
	let mut w = Wrp {
		layers: (cells, cells),
		grid: (heights.ncols as u32, heights.nrows as u32),
		layer_size: s.layer_size as f32,
		heights: south,
		rest: Vec::new(),
		body: Ok(Body {
			material_index: Vec::new(),
			materials: Vec::new(),
			objects,
		}),
	};
	w.set_materials(&mt.cells)?;
	if let Some(d) = s.wrp.parent() {
		std::fs::create_dir_all(d).map_err(|e| format!("{}: {e}", d.display()))?;
	}
	write_atomic(&s.wrp, &w.write())?;
	rep.lines.push(format!(
		"{}: {} x {} heights, {} materials, {count} objects",
		s.wrp.display(),
		w.grid.0,
		w.grid.1,
		w.body.as_ref().map_or(0, |b| b.materials.len())
	));
	Ok(rep)
}

fn names(l: &Layout, kind: &str, end: &str) -> Vec<PathBuf> {
	(0..l.n).flat_map(|ty| (0..l.n).map(move |tx| PathBuf::from(format!("{kind}_{tx:03}_{ty:03}_{end}.png")))).collect()
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::asc::Asc;
	#[test]
	fn writes_tiles_and_a_wrp_that_reads_back() {
		let dir = std::env::temp_dir().join(format!("terrain_game_{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		let cfg_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/bro_msi/Layers.cfg");
		// The sample files are not in the public repository.
		let Ok(text) = std::fs::read_to_string(&cfg_path) else {
			eprintln!("SKIPPED: {} is missing", cfg_path.display());
			return;
		};
		let cfg = layers_cfg::parse(&text).unwrap();
		let colors: Vec<[u8; 3]> = cfg.palette.iter().map(|p| p.0).collect();
		// 256 px mask at 1 m: left half the first palette color, right half the second one.
		let mask = Mask::from_fn(256, 256, colors, |x, _| (x >= 128) as u8);
		let sat = Sat::from_fn(256, 256, |x, y| [x as u8, y as u8, 7]);
		let south: Vec<f32> = (0..128 * 128).map(|i| (i / 128) as f32).collect();
		let h = Heights::from_asc(&Asc::from_south_rows(128, 128, &south, 0.0, 0.0, 2.0));
		let s = Settings {
			wrp: dir.join("map.wrp"),
			layers_dir: dir.join("layers"),
			prefix: "x\\map\\data\\layers".into(),
			tile_px: 256,
			overlap_px: 64,
			layer_size: 32.0,
			layers_cfg: cfg_path,
			search_roots: vec![PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/bro_msi/P")],
			satellite: true,
		};
		let obj = Object {
			transform: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 10.0, 5.0, 20.0],
			id: 99,
			model: "a3\\x\\y.p3d".into(),
		};
		let mut last = 0.0;
		let rep = export(&s, &mask, Some(&sat), &h, vec![obj.clone(), obj], &mut |v| {
			assert!(v >= last);
			last = v;
			true
		})
		.unwrap();
		assert!(last > 0.5);
		// A cancel stops the export.
		assert_eq!(export(&s, &mask, Some(&sat), &h, vec![], &mut |v| v < 0.3).unwrap_err(), crate::CANCELLED);
		assert!(rep.pngs.iter().all(|p| s.layers_dir.join(p).is_file()), "{:?}", rep.pngs);
		let w = crate::wrp::read(&std::fs::read(&s.wrp).unwrap()).unwrap();
		assert_eq!((w.layers, w.grid, w.layer_size), ((8, 8), (128, 128), 32.0));
		assert_eq!((w.heights[0], w.heights[128 * 127]), (0.0, 127.0));
		let b = w.body.unwrap();
		assert_eq!(b.objects.iter().map(|o| o.id).collect::<Vec<_>>(), [0, 1, 2]);
		assert!(b.objects[2].transform[0].is_nan() && b.objects[2].model.is_empty());
		assert!(b.materials[1].starts_with("x\\map\\data\\layers\\P_000-000_"), "{:?}", b.materials);
		assert!(b.material_index.iter().all(|&i| i > 0));
		std::fs::remove_dir_all(&dir).unwrap();
	}
}
