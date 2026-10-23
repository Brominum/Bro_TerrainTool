//! Golden-file tests with the sample files in tests/fixtures. A test is skipped when its files are missing.
//! See tests/fixtures/README.md for the file names.
use std::path::{Path, PathBuf};
use terrain_core::{asc, fill, layers_cfg, mask, project::Project, rvmat::LayerMat, sat, tiles, wrp};

fn fixtures() -> PathBuf {
	Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures")
}

fn skip(what: &Path) -> bool {
	if what.exists() {
		return false;
	}
	eprintln!("SKIPPED: {} is missing", what.display());
	true
}

fn rgba(p: &Path) -> (u32, u32, Vec<u8>) {
	let mut d = png::Decoder::new(std::fs::File::open(p).unwrap());
	d.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
	let mut r = d.read_info().unwrap();
	let mut b = vec![0; r.output_buffer_size()];
	let i = r.next_frame(&mut b).unwrap();
	b.truncate(i.buffer_size());
	let px = match i.color_type {
		png::ColorType::Rgb => b.chunks_exact(3).flat_map(|c| [c[0], c[1], c[2], 255]).collect(),
		png::ColorType::Rgba => b,
		t => panic!("{}: color type {t:?} is not expected", p.display()),
	};
	(i.width, i.height, px)
}

#[test]
fn bro_range_wrp_heights_equal_the_asc_and_round_trip_is_identical() {
	let dir = fixtures().join("bro_range");
	if skip(&dir.join("bro_range.wrp")) || skip(&dir.join("height_3.asc")) {
		return;
	}
	let bytes = std::fs::read(dir.join("bro_range.wrp")).unwrap();
	let w = wrp::read(&bytes).unwrap();
	assert_eq!((w.layers, w.grid, w.layer_size), ((16, 16), (1024, 1024), 64.0));
	let a = asc::parse(&std::fs::read_to_string(dir.join("height_3.asc")).unwrap()).unwrap();
	let flipped = asc::Asc::from_south_rows(1024, 1024, &w.heights, 0.0, 0.0, 1.0).data;
	// The ASC has 2 decimals. The WRP floats can differ from the parsed ASC text in the last bit.
	let d = flipped.iter().zip(&a.data).map(|(x, y)| (x - y).abs()).fold(0f32, f32::max);
	assert!(d < 1e-4, "largest height difference {d}");
	assert_eq!(w.write(), bytes);
	let body = w.body.as_ref().unwrap();
	assert_eq!((body.material_index.len(), body.materials.len(), body.objects.len()), (256, 26, 22462));
}

#[test]
fn bro_msi_tiles_match_the_samples() {
	let dir = fixtures().join("bro_msi");
	if skip(&dir.join("project.json")) || skip(&dir.join("expected")) {
		return;
	}
	let p = Project::load(&dir.join("project.json")).unwrap();
	let l = tiles::Layout::new(p.imagery.width, p.tiles.size, p.tiles.overlap_px, p.imagery.meters_per_pixel).unwrap();
	let out = std::env::temp_dir().join(format!("terrain_golden_{}", std::process::id()));
	let _ = std::fs::remove_dir_all(&out);
	std::fs::create_dir_all(&out).unwrap();
	tiles::satellite_tiles(p.satellite.as_ref().unwrap(), &l, &out).unwrap();
	let cfg = layers_cfg::parse(&std::fs::read_to_string(p.layers_cfg.as_ref().unwrap()).unwrap()).unwrap();
	let found = tiles::find_layer_mats(&cfg, &p.search_roots);
	let first = found[0].mat.as_ref().ok();
	let diffuse = p.diffuse.or(first.map(|m| m.diffuse)).unwrap_or(1.0);
	let repeat = p.repeat.or(first.map(|m| m.repeat)).unwrap_or(5.0);
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
	let job = tiles::MaskJob {
		layout: l,
		layers: &cfg,
		mats: &mats,
		cell_px: (p.texture_layer_size_meters / p.imagery.meters_per_pixel) as u32,
		prefix: p.texture_path_prefix.clone(),
		diffuse,
		repeat,
	};
	let rep = tiles::mask_tiles(p.mask.as_ref().unwrap(), &job, &out).unwrap();
	assert!(rep.errors.is_empty(), "{:?}", rep.errors);
	// Each texture layer cell must refer to an RVMAT file that the tool wrote. The WRP uses these names.
	for c in &rep.cells {
		let file = c.rsplit('\\').next().unwrap();
		assert!(out.join(file).is_file(), "cell RVMAT {c} is not written");
	}
	let exp = dir.join("expected");
	let mut failures = Vec::new();
	let mut names: Vec<String> = std::fs::read_dir(&exp).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
	names.sort();
	for name in names.iter().filter(|n| n.ends_with(".png") && (n.starts_with("S_") || n.starts_with("M_"))) {
		let (a, b) = (exp.join(name), out.join(name));
		if !b.exists() {
			failures.push(format!("{name} is not written"));
			continue;
		}
		let ((w1, h1, x), (w2, h2, y)) = (rgba(&a), rgba(&b));
		if (w1, h1) != (w2, h2) {
			failures.push(format!("{name}: size {w2} x {h2}, expected {w1} x {h1}"));
			continue;
		}
		// Satellite: the pixels must be equal. Mask: the decoded layer must be equal, because the slot order can differ from TB.
		let (same, need) = if name.starts_with("S_") {
			(x.chunks_exact(4).zip(y.chunks_exact(4)).filter(|(p, q)| p == q).count(), 1.0)
		} else {
			let tile = name[2..9].replace('_', "-");
			let (sx, sy) = (slots(&exp, &tile), slots(&out, &tile));
			let layer = |s: &[Option<u8>], p: &[u8]| tiles::SLOT_CODES.iter().position(|c| c == p).and_then(|i| s.get(i).copied().flatten());
			(x.chunks_exact(4).zip(y.chunks_exact(4)).filter(|(p, q)| layer(&sx, p).is_some() && layer(&sx, p) == layer(&sy, q)).count(), 0.95)
		};
		let same = same as f64 / (w1 * h1) as f64;
		eprintln!("{name}: {:.3}% of the pixels agree", same * 100.0);
		if same < need {
			failures.push(format!("{name}: {:.3}% of the pixels agree, {:.0}% is necessary", same * 100.0, need * 100.0));
		}
	}
	// RVMAT: compare each written file with the TB file of the same tile and the same set of layers.
	// The text before Stage3 must be equal. The texture pairs must be equal in any order.
	let mut matched = 0;
	for e in std::fs::read_dir(&out).unwrap() {
		let name = e.unwrap().file_name().into_string().unwrap();
		if !name.ends_with(".rvmat") {
			continue;
		}
		let Some(tb) = names.iter().find(|n| n.ends_with(".rvmat") && n[..9] == name[..9] && layer_set(n) == layer_set(&name)) else {
			continue;
		};
		matched += 1;
		let (x, y) = (std::fs::read_to_string(exp.join(tb)).unwrap(), std::fs::read_to_string(out.join(&name)).unwrap());
		let split = |t: &str| {
			let i = t.find("class Stage3").unwrap_or(t.len());
			let mut pairs: Vec<String> = t[i..].split("class Stage").filter(|b| !b.contains("texture=\"\"")).map(|b| b.split('"').nth(1).unwrap_or("").to_string()).collect();
			pairs.sort();
			(t[..i].to_string(), pairs)
		};
		let ((hx, px), (hy, py)) = (split(&x), split(&y));
		if hx != hy {
			let i = hx.lines().zip(hy.lines()).position(|(a, b)| a != b).unwrap_or(0);
			failures.push(format!("{name} (TB {tb}) line {}: expected {:?}, got {:?}", i + 1, hx.lines().nth(i), hy.lines().nth(i)));
		}
		if px != py {
			failures.push(format!("{name} (TB {tb}): textures {py:?}, expected {px:?}"));
		}
	}
	eprintln!("{matched} RVMAT files have a TB file with the same tile and layers");
	assert!(matched > 0, "no RVMAT file has a TB file with the same tile and layers");
	let _ = std::fs::remove_dir_all(&out);
	assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn bro_msi_mask_round_trip_gives_the_same_pixels_and_tiles() {
	let dir = fixtures().join("bro_msi");
	if skip(&dir.join("msi_mask.bmp")) {
		return;
	}
	let cfg = layers_cfg::parse(&std::fs::read_to_string(dir.join("Layers.cfg")).unwrap()).unwrap();
	let (m, inexact) = mask::Mask::import(&dir.join("msi_mask.bmp"), &cfg).unwrap();
	// The sample has 318 pixels that are not palette colors (311 are 86, 86, 57). They become the nearest palette color, as in tilegen.
	assert_eq!((m.width, m.height, inexact), (2048, 2048, 318));
	let out = std::env::temp_dir().join(format!("terrain_mask_{}", std::process::id()));
	let _ = std::fs::remove_dir_all(&out);
	for d in ["a", "b"] {
		std::fs::create_dir_all(out.join(d)).unwrap();
	}
	let png = out.join("mask.png");
	m.export_png(&png).unwrap();
	// The source has only exact palette colors, so the export must have the same pixels. The source is a BMP: compare with tilegen's reader.
	let (w, h, px) = rgba(&png);
	assert_eq!((w, h), (2048, 2048));
	let (again, inexact) = mask::Mask::import(&png, &cfg).unwrap();
	assert_eq!(inexact, 0);
	assert_eq!(again.region(0, 0, 0, 2048, 2048), m.region(0, 0, 0, 2048, 2048));
	assert!(px.chunks_exact(4).all(|p| p[3] == 255 && cfg.palette.iter().any(|c| c.0 == p[..3])));
	// Source: 24-bit BMP, 54 byte header, bottom row first, no row padding at 2048 px.
	let bmp = std::fs::read(dir.join("msi_mask.bmp")).unwrap();
	let mut changed = 0;
	for y in 0..2048usize {
		for x in 0..2048usize {
			let s = 54 + ((2047 - y) * 2048 + x) * 3;
			let src = [bmp[s + 2], bmp[s + 1], bmp[s]];
			let o = &px[(y * 2048 + x) * 4..(y * 2048 + x) * 4 + 3];
			if o != src {
				changed += 1;
				assert_eq!(o, cfg.palette[cfg.nearest_entry(src)].0, "pixel ({x}, {y})");
			}
		}
	}
	assert_eq!(changed, 318);
	// tilegen must write the same mask tiles and RVMAT files from the BMP and from the exported PNG.
	let mats = vec![
		LayerMat {
			diffuse: 1.0,
			repeat: 5.0,
			nopx: String::new(),
			co: String::new()
		};
		cfg.layers.len()
	];
	let job = tiles::MaskJob {
		layout: tiles::Layout::new(2048, 2048, 512, 1.0).unwrap(),
		layers: &cfg,
		mats: &mats,
		cell_px: 64,
		prefix: String::new(),
		diffuse: 1.0,
		repeat: 5.0,
	};
	tiles::mask_tiles(&dir.join("msi_mask.bmp"), &job, &out.join("a")).unwrap();
	tiles::mask_tiles(&png, &job, &out.join("b")).unwrap();
	let mut names: Vec<_> = std::fs::read_dir(out.join("a")).unwrap().map(|e| e.unwrap().file_name()).collect();
	names.sort();
	assert!(names.len() > 4);
	for n in &names {
		assert_eq!(std::fs::read(out.join("a").join(n)).unwrap(), std::fs::read(out.join("b").join(n)).unwrap(), "{n:?}");
	}
	assert_eq!(std::fs::read_dir(out.join("b")).unwrap().count(), names.len());
	let _ = std::fs::remove_dir_all(&out);
}

/// Speed and memory test with the size of the target map. Run it with `cargo test --release -- --ignored --nocapture`.
#[test]
#[ignore]
fn target_size_mask_import_paint_export() {
	let out = std::env::temp_dir().join(format!("terrain_big_{}", std::process::id()));
	std::fs::create_dir_all(&out).unwrap();
	let cfg = layers_cfg::parse(
		"class Layers { class a { material=\"\"; }; class b { material=\"\"; }; class c { material=\"\"; }; };\nclass Legend { class Colors { a[]={{10,200,10}}; b[]={{0,0,255}}; c[]={{200,0,0}}; }; };",
	)
	.unwrap();
	let n = 16384u32;
	let t = std::time::Instant::now();
	// Source: stripes and circles, so that most tiles are not uniform.
	let src = mask::Mask::from_fn(n, n, cfg.palette.iter().map(|p| p.0).collect(), |x, y| {
		(((x / 700 + y / 900) % 2) as u8) + ((x as i64 - 8000).pow(2) + (y as i64 - 8000).pow(2) < 3000i64.pow(2)) as u8
	});
	src.export_png(&out.join("src.png")).unwrap();
	drop(src);
	eprintln!("make source: {:.1} s", t.elapsed().as_secs_f64());
	let t = std::time::Instant::now();
	let (mut m, inexact) = mask::Mask::import(&out.join("src.png"), &cfg).unwrap();
	assert_eq!(inexact, 0);
	eprintln!("import: {:.1} s", t.elapsed().as_secs_f64());
	let t = std::time::Instant::now();
	let b = mask::Brush {
		radius: 50.0,
		hardness: 0.5,
		opacity: 1.0,
		paint: mask::Paint::Color(2),
	};
	for i in 0..100 {
		m.line([100.0 + i as f64 * 160.0, 100.0], [100.0 + i as f64 * 160.0, 16000.0], &b, i);
		m.end_step();
	}
	eprintln!("paint 100 strokes of 16 km: {:.1} s", t.elapsed().as_secs_f64());
	let t = std::time::Instant::now();
	m.fill(16300, 16300, mask::Paint::Color(1));
	eprintln!("flood fill: {:.1} s", t.elapsed().as_secs_f64());
	let t = std::time::Instant::now();
	m.undo();
	m.export_png(&out.join("out.png")).unwrap();
	eprintln!("undo and export: {:.1} s", t.elapsed().as_secs_f64());
	drop(m);
	let mut u = mask::Mask::from_fn(n, n, vec![[0, 0, 0], [1, 1, 1]], |_, _| 0);
	let t = std::time::Instant::now();
	assert_eq!(u.fill(5, 5, mask::Paint::Color(1)), Some([0, 0, n, n]));
	eprintln!("flood fill of the whole map: {:.1} s", t.elapsed().as_secs_f64());
	if let Ok(s) = std::fs::read_to_string("/proc/self/status") {
		eprintln!("{}", s.lines().filter(|l| l.starts_with("VmHWM") || l.starts_with("VmRSS")).collect::<Vec<_>>().join(", "));
	}
	let _ = std::fs::remove_dir_all(&out);
}

#[test]
fn bro_msi_satellite_round_trip_gives_the_same_pixels_and_tiles() {
	let dir = fixtures().join("bro_msi");
	if skip(&dir.join("msi_sat.bmp")) {
		return;
	}
	let s = sat::Sat::import(&dir.join("msi_sat.bmp")).unwrap();
	assert_eq!((s.width, s.height), (2048, 2048));
	let out = std::env::temp_dir().join(format!("terrain_sat_{}", std::process::id()));
	let _ = std::fs::remove_dir_all(&out);
	for d in ["a", "b"] {
		std::fs::create_dir_all(out.join(d)).unwrap();
	}
	let png = out.join("sat.png");
	s.export_png(&png).unwrap();
	let mut d = png::Decoder::new(std::fs::File::open(&png).unwrap());
	d.set_transformations(png::Transformations::IDENTITY);
	let r = d.read_info().unwrap();
	assert_eq!((r.info().width, r.info().height, r.info().color_type, r.info().bit_depth), (2048, 2048, png::ColorType::Rgb, png::BitDepth::Eight));
	// Source: 24-bit BMP, 54 byte header, bottom row first, no row padding at 2048 px.
	let bmp = std::fs::read(dir.join("msi_sat.bmp")).unwrap();
	let (_, _, px) = rgba(&png);
	for y in 0..2048usize {
		for x in 0..2048usize {
			let b = 54 + ((2047 - y) * 2048 + x) * 3;
			assert_eq!(&px[(y * 2048 + x) * 4..(y * 2048 + x) * 4 + 3], &[bmp[b + 2], bmp[b + 1], bmp[b]], "pixel ({x}, {y})");
		}
	}
	let l = tiles::Layout::new(2048, 2048, 512, 1.0).unwrap();
	tiles::satellite_tiles(&dir.join("msi_sat.bmp"), &l, &out.join("a")).unwrap();
	tiles::satellite_tiles(&png, &l, &out.join("b")).unwrap();
	for t in ["S_000_000_lco.png", "S_000_001_lco.png", "S_001_000_lco.png", "S_001_001_lco.png"] {
		assert_eq!(std::fs::read(out.join("a").join(t)).unwrap(), std::fs::read(out.join("b").join(t)).unwrap(), "{t}");
	}
	let _ = std::fs::remove_dir_all(&out);
}

/// Speed and memory test of the satellite painter with the size of the target map.
#[test]
#[ignore]
fn target_size_satellite_import_paint_export() {
	let out = std::env::temp_dir().join(format!("terrain_bigsat_{}", std::process::id()));
	std::fs::create_dir_all(&out).unwrap();
	let n = 16384u32;
	let t = std::time::Instant::now();
	let src = sat::Sat::from_fn(n, n, |x, y| [(x / 7 % 256) as u8, (y / 5 % 256) as u8, ((x ^ y) % 256) as u8]);
	src.export_png(&out.join("src.png")).unwrap();
	drop(src);
	eprintln!("make source: {:.1} s", t.elapsed().as_secs_f64());
	let t = std::time::Instant::now();
	let mut s = sat::Sat::import(&out.join("src.png")).unwrap();
	eprintln!("import: {:.1} s", t.elapsed().as_secs_f64());
	let t = std::time::Instant::now();
	let top = s.region(5, 0, 0, 512, 512);
	assert_eq!(top[3], 255);
	eprintln!("whole map at level 5 (first time, all mip levels): {:.1} s", t.elapsed().as_secs_f64());
	let t = std::time::Instant::now();
	let b = sat::Brush {
		radius: 30.0,
		hardness: 0.5,
		opacity: 0.7,
		tool: sat::Tool::Color([200, 50, 50]),
	};
	for i in 0..20 {
		s.line([100.0 + i as f64 * 800.0, 100.0], [100.0 + i as f64 * 800.0, 16000.0], &b);
		s.end_step();
	}
	eprintln!("paint 20 strokes of 16 km: {:.1} s", t.elapsed().as_secs_f64());
	let t = std::time::Instant::now();
	s.region(5, 0, 0, 512, 512);
	eprintln!("whole map at level 5 after the strokes: {:.2} s", t.elapsed().as_secs_f64());
	let t = std::time::Instant::now();
	s.undo();
	s.export_png(&out.join("out.png")).unwrap();
	eprintln!("undo and export: {:.1} s", t.elapsed().as_secs_f64());
	if let Ok(st) = std::fs::read_to_string("/proc/self/status") {
		eprintln!("{}", st.lines().filter(|l| l.starts_with("VmHWM")).collect::<Vec<_>>().join(", "));
	}
	let _ = std::fs::remove_dir_all(&out);
}

#[test]
fn asc_round_trip_is_byte_identical() {
	for f in ["bro_range/height_3.asc", "target/oregon_ASC.asc"] {
		let src = fixtures().join(f);
		if skip(&src) {
			continue;
		}
		let text = std::fs::read_to_string(&src).unwrap();
		let mut h = terrain_core::height::Heights::parse(text.clone()).unwrap();
		let out = std::env::temp_dir().join(format!("terrain_asc_{}.asc", std::process::id()));
		let t = std::time::Instant::now();
		h.export_asc(&out, None).unwrap();
		eprintln!("{f}: export {:.2} s", t.elapsed().as_secs_f64());
		assert!(std::fs::read(&out).unwrap() == text.as_bytes(), "{f}: the export is not the same");
		// One edit changes only the rows under the brush.
		let b = terrain_core::height::Brush {
			radius: h.cellsize * 3.0,
			hardness: 1.0,
			strength: 1.0,
			tool: terrain_core::height::Tool::Raise,
		};
		let r = h.dab(h.cellsize * 50.0, h.cellsize * 50.0, &b).unwrap();
		h.export_asc(&out, None).unwrap();
		let a = std::fs::read_to_string(&out).unwrap();
		let changed: Vec<usize> = a.lines().zip(text.lines()).enumerate().filter(|(_, (x, y))| x != y).map(|(i, _)| i - 6).collect();
		assert_eq!(changed, (r[1] as usize..r[3] as usize).collect::<Vec<_>>(), "{f}");
		let again = terrain_core::height::Heights::parse(a).unwrap();
		assert_eq!(again.values(), h.values());
		std::fs::remove_file(&out).unwrap();
	}
}

/// Speed of the height brushes at the target size (4096 x 4096 cells of 4 m).
#[test]
#[ignore]
fn target_size_height_brushes() {
	use terrain_core::height::{Brush, Heights, Tool};
	let n = 4096;
	let data: Vec<f32> = (0..n * n).map(|i| ((i % n) as f32 / 50.0).sin() * 20.0 + 100.0).collect();
	let mut h = Heights::from_asc(&asc::Asc::from_south_rows(n, n, &data, 0.0, 0.0, 4.0));
	for tool in [Tool::Raise, Tool::Smooth, Tool::Flatten(100.0), Tool::Noise(20.0, 3)] {
		let b = Brush {
			radius: 100.0,
			hardness: 0.3,
			strength: 0.5,
			tool,
		};
		let t = std::time::Instant::now();
		for i in 0..50 {
			let x = 4000.0 + i as f64 * 40.0;
			h.line([x, 8000.0], [x + 40.0, 8000.0], &b);
		}
		h.end_step();
		eprintln!("{tool:?}: {:.2} ms for each 40 m mouse move with a 100 m brush", t.elapsed().as_secs_f64() * 1000.0 / 50.0);
	}
}

/// Slot list of a tile from the names of its RVMAT files: the layer of each slot position.
fn slots(dir: &Path, tile: &str) -> Vec<Option<u8>> {
	let mut s: Vec<Option<u8>> = Vec::new();
	for e in std::fs::read_dir(dir).unwrap() {
		let n = e.unwrap().file_name().into_string().unwrap();
		let Some(rest) = n.strip_prefix(&format!("P_{tile}_")).and_then(|r| r.strip_suffix(".rvmat")) else {
			continue;
		};
		for (i, part) in rest.split('_').enumerate() {
			if s.len() <= i {
				s.push(None);
			}
			if let Some(l) = part.strip_prefix('L') {
				s[i] = l.parse().ok();
			}
		}
	}
	s
}

/// Sorted layer numbers in an RVMAT file name.
fn layer_set(name: &str) -> Vec<String> {
	let mut v: Vec<String> = name.trim_end_matches(".rvmat").split('_').skip(2).filter(|p| p.starts_with('L')).map(String::from).collect();
	v.sort();
	v
}

#[test]
fn paa_samples_decode_all_mipmaps() {
	let dir = fixtures().join("paa");
	if skip(&dir.join("bro_dirt_co.paa")) || skip(&dir.join("bro_dirt_nopx.paa")) {
		return;
	}
	use terrain_core::paa;
	for (name, format, tags) in [("bro_dirt_co.paa", paa::Format::Dxt1, 3), ("bro_dirt_nopx.paa", paa::Format::Dxt5, 5)] {
		let p = paa::read(&std::fs::read(dir.join(name)).unwrap()).unwrap();
		assert_eq!(p.format, format, "{name}");
		assert_eq!(p.tags.len(), tags, "{name}");
		let sizes: Vec<u16> = p.mips.iter().map(|m| m.width).collect();
		assert_eq!(sizes, [2048, 1024, 512, 256, 128, 64, 32, 16, 8, 4], "{name}");
	}
}

#[test]
fn mlod_doorway_has_four_lods() {
	let f = fixtures().join("mlod/Bro_MSWR_Doorway.p3d");
	if skip(&f) {
		return;
	}
	use terrain_core::p3d;
	let lods = p3d::read_mlod(&std::fs::read(f).unwrap()).unwrap();
	assert_eq!(lods.len(), 4);
	let l = &lods[p3d::visual_lod(&lods.iter().map(|l| l.resolution).collect::<Vec<_>>(), false).unwrap()];
	assert_eq!((l.resolution, l.points.len(), l.normals.len(), l.faces.len()), (1.0, 314, 176, 181));
	assert_eq!(l.selections, ["camo", "door_1"]);
	assert_eq!(lods[2].selections, ["snap_1", "snap_2", "door_1_axis", "door_1_trigger"]);
	let m = l.mesh();
	let textures: Vec<&str> = m.groups.iter().map(|g| g.texture.as_str()).collect();
	assert_eq!(textures, ["bro_modularshoothouse\\remastered\\modshnew_brick_co.paa", "bro_modularshoothouse\\remastered\\wood_co.paa"]);
	let tris: usize = m.groups.iter().map(|g| g.indices.len() / 3).sum();
	eprintln!("doorway mesh: {} vertices, {tris} triangles, bounds {:?} to {:?}", m.positions.len(), m.min, m.max);
	assert!(tris >= 181);
}

#[test]
fn odol_vanilla_models_read_all_lods() {
	// Vanilla models are not in the repo. Copy some from P:\a3 to tests/fixtures/local to run this test.
	let dir = fixtures().join("local");
	if skip(&dir) {
		return;
	}
	use terrain_core::p3d;
	let mut files = 0;
	for e in std::fs::read_dir(&dir).unwrap() {
		let p = e.unwrap().path();
		if !p.extension().is_some_and(|x| x.eq_ignore_ascii_case("p3d")) {
			continue;
		}
		let b = std::fs::read(&p).unwrap();
		if &b[..4] != b"ODOL" {
			continue;
		}
		files += 1;
		let o = p3d::read_odol(&b).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
		for i in 0..o.resolutions.len() {
			let m = p3d::odol_lod(&b, &o, i).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
			// Visual LODs: each normal is a unit vector. Some models store a zero normal for a few vertices.
			for (k, n) in m.normals.iter().enumerate() {
				let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
				assert!(o.resolutions[i] >= 1000.0 || len == 0.0 || (len - 1.0).abs() < 0.01, "{} LOD {i} normal {k} has length {len}", p.display());
			}
		}
		let m = p3d::mesh(&b, false).unwrap();
		eprintln!(
			"{}: ODOL {}, {} LODs, visual LOD: {} vertices, textures {:?}",
			p.file_name().unwrap().to_string_lossy(),
			o.version,
			o.resolutions.len(),
			m.positions.len(),
			m.groups.iter().map(|g| g.texture.rsplit('\\').next().unwrap_or("")).collect::<Vec<_>>()
		);
		if p.file_name().unwrap().eq_ignore_ascii_case("t_PinusS2s_F.p3d") {
			// bro_range.wrp has this model a median 6.90 m above the terrain (relative z 0 in TB).
			assert!((m.offset[1] - 6.904).abs() < 0.01, "offset {:?}", m.offset);
		}
		if p.file_name().unwrap().eq_ignore_ascii_case("FuelStation_03_prices_F.p3d") {
			assert_eq!(m.positions.len(), 391);
			assert_eq!(m.groups.iter().map(|g| g.indices.len() / 3).sum::<usize>(), 256 + 25 * 2);
		}
	}
	eprintln!("{files} ODOL files read");
}

#[test]
fn odol_doorway_agrees_with_mlod() {
	let (fo, fm) = (fixtures().join("odol/bro_mswr_doorway.p3d"), fixtures().join("mlod/Bro_MSWR_Doorway.p3d"));
	if skip(&fo) || skip(&fm) {
		return;
	}
	use terrain_core::p3d;
	let b = std::fs::read(&fo).unwrap();
	let o = p3d::read_odol(&b).unwrap();
	assert_eq!((o.version, o.resolutions.len()), (75, 4));
	let odol = p3d::mesh(&b, false).unwrap();
	let mlod = p3d::mesh(&std::fs::read(&fm).unwrap(), false).unwrap();
	// The binarizer can split vertices and moves the bounding center to the origin. So compare the size, the textures, and the triangle count.
	for k in 0..3 {
		let (so, sm) = (odol.max[k] - odol.min[k], mlod.max[k] - mlod.min[k]);
		assert!((so - sm).abs() < 1e-3, "size {so} / {sm} on axis {k}");
		assert!((odol.max[k] + odol.min[k]).abs() < 1e-3, "ODOL is not centered on axis {k}");
	}
	let tex = |m: &p3d::Mesh| {
		let mut t: Vec<String> = m.groups.iter().map(|g| g.texture.clone()).collect();
		t.sort();
		t
	};
	assert_eq!(tex(&odol), tex(&mlod));
	// The shift of the binarizer: computed from the MLOD, read from the ODOL model info.
	for k in 0..3 {
		assert!((odol.offset[k] - mlod.offset[k]).abs() < 1e-3, "offset {:?} / {:?}", odol.offset, mlod.offset);
	}
	assert!((mlod.offset[1] - 1.4).abs() < 1e-3);
	// The MLOD mesh is centered as the binarizer does it, so both meshes have the same bounds.
	for k in 0..3 {
		assert!(
			(odol.min[k] - mlod.min[k]).abs() < 1e-3 && (odol.max[k] - mlod.max[k]).abs() < 1e-3,
			"bounds {:?} {:?} / {:?} {:?}",
			odol.min,
			odol.max,
			mlod.min,
			mlod.max
		);
	}
	let tris = |m: &p3d::Mesh| m.groups.iter().map(|g| g.indices.len() / 3).sum::<usize>();
	assert_eq!(tris(&odol), tris(&mlod));
	for i in 0..4 {
		p3d::odol_lod(&b, &o, i).unwrap();
	}
}

#[test]
fn mlod_shed_has_multimaterials_and_second_uv_set() {
	let f = fixtures().join("local/IndustrialShed_01_F_mlod.p3d");
	if skip(&f) {
		return;
	}
	use terrain_core::p3d;
	let m = p3d::mesh(&std::fs::read(f).unwrap(), false).unwrap();
	assert_eq!(m.uv1.len(), m.positions.len());
	let multi: usize = m.groups.iter().filter(|g| g.texture.is_empty() && g.material.contains("_multi")).map(|g| g.indices.len() / 3).sum();
	let all: usize = m.groups.iter().map(|g| g.indices.len() / 3).sum();
	eprintln!("shed: {} vertices, {multi} of {all} triangles use a multimaterial", m.positions.len());
	assert!(multi * 10 > all * 9);
}

// The proxy triangle of the fence (selection `proxy:...`, no texture) is not in the mesh.
#[test]
fn odol_proxy_faces_are_left_out() {
	let f = fixtures().join("local/New_WiredFence_10m_F.p3d");
	if skip(&f) {
		return;
	}
	let m = terrain_core::p3d::mesh(&std::fs::read(f).unwrap(), false).unwrap();
	assert_eq!(m.groups.iter().map(|g| g.indices.len() / 3).sum::<usize>(), 1806);
	assert!(m.groups.iter().all(|g| !(g.texture.is_empty() && g.material.is_empty())));
}

// The flag proxy selection of mast_f has no face list. The proxy gives its section: its triangle is left out too.
#[test]
fn sectional_proxy_faces_are_left_out() {
	let f = fixtures().join("local/mast_f.p3d");
	if skip(&f) {
		return;
	}
	let m = terrain_core::p3d::mesh(&std::fs::read(f).unwrap(), false).unwrap();
	assert!(m.groups.iter().all(|g| !g.texture.is_empty()));
}

// The wire of the fence is a proxy model (new_wiredfence_10m_proxy). Its original origin goes to the proxy position.
#[test]
fn proxy_model_goes_into_the_mesh() {
	let f = fixtures().join("local/New_WiredFence_10m_F.p3d");
	let w = fixtures().join("local/new_wiredfence_10m_proxy.p3d");
	if skip(&f) || skip(&w) {
		return;
	}
	use terrain_core::p3d;
	let mut m = p3d::mesh(&std::fs::read(f).unwrap(), false).unwrap();
	assert_eq!(m.proxies.len(), 1);
	let wire = p3d::mesh(&std::fs::read(&w).unwrap(), false).unwrap();
	let before = (m.positions.len(), m.groups.len());
	p3d::add_proxies(&mut m, false, 2, &|name| name.to_ascii_lowercase().ends_with("new_wiredfence_10m_proxy").then(|| std::fs::read(&w).unwrap()));
	assert_eq!(m.positions.len(), before.0 + wire.positions.len());
	assert!(m.groups.len() > before.1);
	assert!(m.proxies.is_empty());
}

// The fence has `placement = slopelandcontact` and two LandContact points at its ends. HelipadSquare_F is a decal: all its vertices are "On surface".
#[test]
fn land_contact_and_on_surface() {
	let f = fixtures().join("local/New_WiredFence_10m_F.p3d");
	let h = fixtures().join("local/HelipadSquare_F.p3d");
	if skip(&f) || skip(&h) {
		return;
	}
	use terrain_core::p3d;
	let m = p3d::mesh(&std::fs::read(f).unwrap(), false).unwrap();
	assert_eq!(m.land_contact.len(), 2);
	assert!((m.land_contact[1][0] - m.land_contact[0][0] - 10.0).abs() < 0.01);
	assert!(m.clip.iter().all(|c| c & p3d::CLIP_LAND_ON == 0));
	let d = p3d::mesh(&std::fs::read(h).unwrap(), false).unwrap();
	assert!(d.land_contact.is_empty());
	assert!(!d.clip.is_empty() && d.clip.iter().all(|c| c & p3d::CLIP_LAND_ON != 0));
}

#[test]
fn multimaterial_rvmat_stages() {
	let f = fixtures().join("local/i_Shed_Ind_multi.rvmat");
	if skip(&f) {
		return;
	}
	let m = terrain_core::rvmat::read_material(&std::fs::read(f).unwrap()).unwrap();
	assert_eq!((m.pixel_shader.as_str(), m.stages.len()), ("Multi", 15));
	assert_eq!(m.stages[2].aside, [1.4, 0.0, 0.0]);
	assert_eq!(m.stages[2].pos, [0.0, -0.15, 0.0]);
	assert_eq!(m.stages[4].uv_source, "tex1");
	assert!(m.stages[4].texture.ends_with("i_shed_ind_multi_mask.paa"));
	assert!(m.stages[9].texture.ends_with("_mc.paa"));
}

#[test]
fn tv4p_project_settings_and_files() {
	let dir = fixtures().join("tv4p");
	if skip(&dir.join("bro_msi.tv4p")) {
		return;
	}
	use terrain_core::alb;
	let p = alb::tv4p(&std::fs::read(dir.join("bro_msi.tv4p")).unwrap()).unwrap();
	assert_eq!(p.name, "bro_msi");
	assert_eq!(p.map_frame, [200000.0, 0.0, 202048.0, 2048.0]);
	assert_eq!((p.texture_layer, p.tile_px, p.overlap_px, p.meters_per_px), (64.0, 2048, 512, 1.0));
	assert_eq!(p.wrp_folder, "p:\\bromine\\bro_msi");
	assert_eq!(p.layers_cfg, "bromine\\bro_msi\\data\\layers.cfg");
	assert_eq!(p.heightmap, "P:\\bromine\\source_msi\\msi_ht_2.asc");
	assert_eq!(p.satellite, "P:\\bromine\\source_msi\\msi_sat.bmp");
	assert_eq!(p.mask, "P:\\bromine\\source_msi\\msi_mask.bmp");
	// The layer and shape files use the same container. The object tree of the layer is not decoded yet (raw bytes).
	for f in ["default.tv4l", "residential.tv4s"] {
		let n = alb::read(&std::fs::read(dir.join(f)).unwrap()).unwrap_or_else(|e| panic!("{f}: {e}"));
		assert!(!n.fields().is_empty(), "{f}");
	}
}

/// Speed test of the object fill with the size of the target map. Run it with `cargo test --release -- --ignored --nocapture`.
#[test]
#[ignore]
fn target_size_fill_one_million_objects() {
	let n = 16384u32;
	// Stripes of 1 km: half of the map is layer 1.
	let m = mask::Mask::from_fn(n, n, vec![[0, 0, 0], [0, 255, 0]], |x, y| (((x / 1000) + (y / 1000)) % 2) as u8);
	let g = 4096usize;
	let data = (0..g * g).map(|i| (120.0 * ((i % g) as f64 / 300.0).sin() * ((i / g) as f64 / 400.0).cos() + 100.0) as f32).collect();
	let t = asc::Asc {
		header: Vec::new(),
		ncols: g,
		nrows: g,
		xll: 0.0,
		yll: 0.0,
		cellsize: 4.0,
		nodata: -9999.0,
		data,
	};
	let t = terrain_core::height::Heights::from_asc(&t);
	let s = fill::Settings {
		colors: vec![1],
		density: 110.0,
		spacing: 4.0,
		inset: 5.0,
		feather: 10.0,
		noise: 0.2,
		max_slope: 40.0,
		weights: vec![1.0, 2.0, 1.0],
		tilt: true,
		..Default::default()
	};
	let time = std::time::Instant::now();
	let e = fill::estimate(&m, &t, &s);
	eprintln!("estimate {e:.0} objects: {:.1} s", time.elapsed().as_secs_f64());
	let time = std::time::Instant::now();
	let r = fill::run(&m, &t, &s, 5_000_000).unwrap();
	eprintln!("fill {} objects: {:.1} s", r.objects.len(), time.elapsed().as_secs_f64());
	assert!(r.objects.len() > 1_000_000);
}

#[test]
fn bro_msi_game_export_gives_the_same_files_as_tilegen() {
	let dir = fixtures().join("bro_msi");
	if skip(&dir.join("project.json")) || skip(&dir.join("msi_sat.bmp")) {
		return;
	}
	let p = Project::load(&dir.join("project.json")).unwrap();
	let out = std::env::temp_dir().join(format!("terrain_game_fixture_{}", std::process::id()));
	let _ = std::fs::remove_dir_all(&out);
	let (a, b) = (out.join("tilegen"), out.join("game"));
	std::fs::create_dir_all(&a).unwrap();
	// tilegen steps from the files.
	let l = tiles::Layout::new(p.imagery.width, p.tiles.size, p.tiles.overlap_px, p.imagery.meters_per_pixel).unwrap();
	tiles::satellite_tiles(p.satellite.as_ref().unwrap(), &l, &a).unwrap();
	let cfg = layers_cfg::parse(&std::fs::read_to_string(p.layers_cfg.as_ref().unwrap()).unwrap()).unwrap();
	let found = tiles::find_layer_mats(&cfg, &p.search_roots);
	let first = found[0].mat.as_ref().ok();
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
	let job = tiles::MaskJob {
		layout: l,
		layers: &cfg,
		mats: &mats,
		cell_px: (p.texture_layer_size_meters / p.imagery.meters_per_pixel) as u32,
		prefix: p.texture_path_prefix.clone(),
		diffuse,
		repeat,
	};
	let rep = tiles::mask_tiles(p.mask.as_ref().unwrap(), &job, &a).unwrap();
	// Game export from the images in memory.
	let (m, _) = mask::Mask::import(p.mask.as_ref().unwrap(), &cfg).unwrap();
	let s = sat::Sat::import(p.satellite.as_ref().unwrap()).unwrap();
	let n = (p.imagery.width as f64 * p.imagery.meters_per_pixel) as usize;
	let h = terrain_core::height::Heights::from_asc(&asc::Asc::from_south_rows(n, n, &vec![5.0; n * n], 0.0, 0.0, 1.0));
	let settings = terrain_core::game::Settings {
		wrp: b.join("map.wrp"),
		layers_dir: b.clone(),
		prefix: p.texture_path_prefix.clone(),
		tile_px: p.tiles.size,
		overlap_px: p.tiles.overlap_px,
		layer_size: p.texture_layer_size_meters,
		layers_cfg: p.layers_cfg.clone().unwrap(),
		search_roots: p.search_roots.clone(),
		satellite: true,
	};
	terrain_core::game::export(&settings, &m, Some(&s), &h, vec![], &mut |_| true).unwrap();
	let mut names: Vec<_> = std::fs::read_dir(&a).unwrap().map(|e| e.unwrap().file_name()).collect();
	names.sort();
	assert!(names.len() > 8);
	for n in &names {
		assert_eq!(std::fs::read(a.join(n)).unwrap(), std::fs::read(b.join(n)).unwrap(), "{n:?}");
	}
	let w = wrp::read(&std::fs::read(b.join("map.wrp")).unwrap()).unwrap();
	let body = w.body.unwrap();
	let mut cells: Vec<&String> = rep.cells.iter().collect();
	cells.sort();
	cells.dedup();
	assert_eq!(body.materials.len(), cells.len() + 1);
	assert_eq!(body.objects.len(), 1);
	let _ = std::fs::remove_dir_all(&out);
}

/// Speed test of the export for the game with the size of the target map (121 tiles). Run it with `cargo test --release -- --ignored --nocapture`.
#[test]
#[ignore]
fn target_size_game_export() {
	let n = 16384u32;
	let cfg_path = fixtures().join("bro_msi").join("Layers.cfg");
	let cfg = layers_cfg::parse(&std::fs::read_to_string(&cfg_path).unwrap()).unwrap();
	let colors: Vec<[u8; 3]> = cfg.palette.iter().map(|p| p.0).collect();
	let k = colors.len() as u32;
	let m = mask::Mask::from_fn(n, n, colors, |x, y| ((x / 700 + y / 900) % k) as u8);
	let s = sat::Sat::from_fn(n, n, |x, y| [x as u8, y as u8, (x ^ y) as u8]);
	let g = 4096usize;
	let h = terrain_core::height::Heights::from_asc(&asc::Asc::from_south_rows(g, g, &vec![10.0; g * g], 0.0, 0.0, 4.0));
	let out = std::env::temp_dir().join(format!("terrain_game_target_{}", std::process::id()));
	let settings = terrain_core::game::Settings {
		wrp: out.join("map.wrp"),
		layers_dir: out.join("layers"),
		prefix: "x\\map\\data\\layers\\".into(),
		tile_px: 2048,
		overlap_px: 512,
		layer_size: 64.0,
		layers_cfg: cfg_path,
		search_roots: vec![fixtures().join("bro_msi").join("P")],
		satellite: true,
	};
	let objects: Vec<wrp::Object> = (0..500_000)
		.map(|i| wrp::Object {
			transform: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, (i % 16000) as f32, 10.0, (i / 40) as f32],
			id: 0,
			model: "a3\\x\\y.p3d".into(),
		})
		.collect();
	let time = std::time::Instant::now();
	let rep = terrain_core::game::export(&settings, &m, Some(&s), &h, objects, &mut |_| true).unwrap();
	eprintln!("{}\nexport: {:.1} s", rep.lines.join("\n"), time.elapsed().as_secs_f64());
	let _ = std::fs::remove_dir_all(&out);
}

#[test]
fn terragen_sample_has_the_size_of_the_target_map() {
	let p = fixtures().join("local").join("heightmap.ter");
	if skip(&p) {
		return;
	}
	let a = terrain_core::ter::parse(&std::fs::read(&p).unwrap(), 200000.0, 0.0).unwrap();
	assert_eq!((a.ncols, a.nrows, a.cellsize, a.xll), (4096, 4096, 4.0, 200000.0));
}
