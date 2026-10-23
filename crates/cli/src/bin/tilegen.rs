//! tilegen: write the satellite tiles, the mask tiles, and the tile RVMAT files from a project file.
use std::path::{Path, PathBuf};
use terrain_cli::{args, fail};
use terrain_core::{layers_cfg, project::Project, rvmat::LayerMat, tiles, wrp};

const USAGE: &str = "usage: tilegen <project.json> [--check] [--wrp <in.wrp> --wrp-out <out.wrp>]
  --check     show the layout and the layer RVMAT table. Do not write files.
  --wrp       editable WRP (from TB or from this tool) of the same map
  --wrp-out   write a copy of the WRP that uses the new RVMAT files";

fn main() {
	let (pos, opt) = args(&["check"]);
	let Some(path) = pos.first() else { fail(USAGE) };
	let p = Project::load(Path::new(path)).unwrap_or_else(|e| fail(e));
	let (img, mpp) = (p.imagery.width, p.imagery.meters_per_pixel);
	if p.imagery.height != img {
		fail("the image must be square (width = height)");
	}
	let l = tiles::Layout::new(img, p.tiles.size, p.tiles.overlap_px, mpp).unwrap_or_else(|e| fail(e));
	println!("image {img} x {img} px at {mpp} m/px = {} m", img as f64 * mpp);
	println!("tiles {} px, overlap {} px, overlapped area {:.2}%", l.tile_px, l.overlap_px, l.overlapped_area() * 100.0);
	println!("tiles in row {}, total {}, final sat grid {} px", l.n, l.n * l.n, l.step_px());
	println!("landgrid {}", img as f64 * mpp / p.texture_layer_size_meters);
	if let Some(t) = &p.terrain {
		if (t.size_meters - img as f64 * mpp).abs() > 1e-6 {
			println!("WARNING: terrain size {} m is not equal to the image size {} m", t.size_meters, img as f64 * mpp);
		}
	}
	let cell_px = p.texture_layer_size_meters / mpp;
	if cell_px.fract() != 0.0 {
		fail(format!("texture layer size {} m is not a whole number of pixels", p.texture_layer_size_meters));
	}
	let out = p.output_dir.clone().unwrap_or_else(|| PathBuf::from("layers"));
	let mut job = None;
	if p.tiles.export_mask {
		let cfg_path = p.layers_cfg.as_ref().unwrap_or_else(|| fail("layersCfg is not set"));
		let text = std::fs::read_to_string(cfg_path).unwrap_or_else(|e| fail(format!("{}: {e}", cfg_path.display())));
		let cfg = layers_cfg::parse(&text).unwrap_or_else(|e| fail(e));
		for w in &cfg.warnings {
			println!("WARNING: layers.cfg: {w}");
		}
		let found = tiles::find_layer_mats(&cfg, &p.search_roots);
		println!("{:>3}  {:<24} {:<8} {:>7} {:>6}  RVMAT", "L", "layer", "status", "diffuse", "repeat");
		for (i, f) in found.iter().enumerate() {
			match &f.mat {
				Ok(m) => println!("{i:>3}  {:<24} {:<8} {:>7} {:>6}  {}", f.layer, "found", m.diffuse, m.repeat, f.path.as_ref().unwrap().display()),
				Err(e) => println!("{i:>3}  {:<24} {:<8} {:>7} {:>6}  {} ({e})", f.layer, "MISSING", "-", "-", f.material),
			}
		}
		let ok: Vec<&LayerMat> = found.iter().filter_map(|f| f.mat.as_ref().ok()).collect();
		if ok.windows(2).any(|w| w[0].diffuse != w[1].diffuse || w[0].repeat != w[1].repeat) {
			println!("WARNING: the layer RVMATs have different diffuse or repeat values");
		}
		let first = found.first().and_then(|f| f.mat.as_ref().ok());
		if first.is_none() && (p.diffuse.is_none() || p.repeat.is_none()) {
			println!("WARNING: the first layer RVMAT is missing. Defaults are used for the values that are not set.");
		}
		let diffuse = p.diffuse.or(first.map(|m| m.diffuse)).unwrap_or(1.0);
		let repeat = p.repeat.or(first.map(|m| m.repeat)).unwrap_or(5.0);
		println!("tile RVMAT: diffuse {diffuse}, repeat {repeat} (set \"diffuse\" and \"repeat\" in the project file to change them)");
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
		let mut prefix = p.texture_path_prefix.clone();
		if !prefix.is_empty() && !prefix.ends_with('\\') {
			prefix.push('\\');
		}
		job = Some((cfg, mats, prefix, diffuse, repeat));
	}
	if opt.contains_key("check") {
		return;
	}
	std::fs::create_dir_all(&out).unwrap_or_else(|e| fail(format!("{}: {e}", out.display())));
	if p.tiles.export_satellite {
		let src = p.satellite.as_ref().unwrap_or_else(|| fail("satellite is not set"));
		let n = tiles::satellite_tiles(src, &l, &out).unwrap_or_else(|e| fail(e));
		println!("wrote {n} satellite tiles to {}", out.display());
	}
	if let Some((cfg, mats, prefix, diffuse, repeat)) = job {
		let src = p.mask.as_ref().unwrap_or_else(|| fail("mask is not set"));
		let j = tiles::MaskJob {
			layout: l,
			layers: &cfg,
			mats: &mats,
			cell_px: cell_px as u32,
			prefix,
			diffuse,
			repeat,
		};
		let rep = tiles::mask_tiles(src, &j, &out).unwrap_or_else(|e| fail(e));
		println!("wrote {} mask tiles and {} RVMAT files to {}", rep.tiles, rep.rvmats, out.display());
		if !rep.errors.is_empty() {
			for e in &rep.errors {
				println!("ERROR: {e}. A tile can have 6 layers at most.");
			}
			fail(format!("{} tiles have too many layers", rep.errors.len()));
		}
		if let Some(inp) = opt.get("wrp") {
			let outp = opt.get("wrp-out").unwrap_or_else(|| fail("--wrp needs --wrp-out"));
			let bytes = std::fs::read(inp).unwrap_or_else(|e| fail(format!("{inp}: {e}")));
			let mut w = wrp::read(&bytes).unwrap_or_else(|e| fail(e));
			if (w.layer_size as f64 - p.texture_layer_size_meters).abs() > 1e-6 {
				fail(format!("the WRP texture layer size is {} m, the project has {} m", w.layer_size, p.texture_layer_size_meters));
			}
			w.set_materials(&rep.cells).unwrap_or_else(|e| fail(e));
			std::fs::write(outp, w.write()).unwrap_or_else(|e| fail(format!("{outp}: {e}")));
			println!("wrote {outp} with {} materials", w.body.as_ref().map_or(0, |b| b.materials.len()));
		}
	}
}
