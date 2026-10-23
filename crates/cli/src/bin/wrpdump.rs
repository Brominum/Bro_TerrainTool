//! wrpdump: print the content of an editable WRP (8WVR) file. Export the heights as ASC. Run a round trip.
use terrain_cli::{args, fail, hex};
use terrain_core::{asc, wrp};

const USAGE: &str = "usage: wrpdump <file.wrp> [options]
  --all                 list all materials and models
  --asc <out.asc>       write the heights as ASC (row 0 = north)
  --xll <x>             xllcorner for --asc (default 200000)
  --yll <y>             yllcorner for --asc (default 0)
  --decimals <n>        decimal places for --asc (default 2)
  --compare-asc <in>    compare the heights with an ASC file (flipped)
  --write <out.wrp>     write the WRP again and compare the bytes
  --hex <offset>        print 256 bytes from this file offset";

fn main() {
	let (pos, opt) = args(&["all"]);
	let Some(path) = pos.first() else { fail(USAGE) };
	let bytes = std::fs::read(path).unwrap_or_else(|e| fail(format!("{path}: {e}")));
	let w = wrp::read(&bytes).unwrap_or_else(|e| fail(e));
	let (lo, hi) = w.height_range();
	let rest_at = wrp::HEADER_LEN + w.heights.len() * 4;
	println!("file: {path} ({} bytes)", bytes.len());
	println!("texture layer grid: {} x {}, layer size {} m", w.layers.0, w.layers.1, w.layer_size);
	println!("terrain grid: {} x {}, cell size {} m", w.grid.0, w.grid.1, w.layers.0 as f32 * w.layer_size / w.grid.0 as f32);
	println!("heights: {lo} to {hi}");
	println!("rest: {} bytes from offset {rest_at}", w.rest.len());
	let limit = if opt.contains_key("all") { usize::MAX } else { 20 };
	match &w.body {
		Ok(b) => {
			println!("body: decoded (hypothesis passed: all bytes used, writer gives the same bytes)");
			let (mn, mx) = b.material_index.iter().fold((u16::MAX, 0), |(a, c), &v| (a.min(v), c.max(v)));
			let distinct: std::collections::BTreeSet<_> = b.material_index.iter().collect();
			println!("material index: {} values, {mn} to {mx}, {} different", b.material_index.len(), distinct.len());
			println!("materials: {}", b.materials.len());
			for (i, m) in b.materials.iter().enumerate().take(limit) {
				println!("  {i:5} {m}");
			}
			println!("objects: {}", b.objects.len());
			let mut models: std::collections::BTreeMap<&str, usize> = Default::default();
			for o in &b.objects {
				*models.entry(o.model.as_str()).or_default() += 1;
			}
			println!("models: {}", models.len());
			for (m, n) in models.iter().take(limit) {
				println!("  {n:7} {m}");
			}
			for o in b.objects.iter().take(5) {
				println!("  object id {} pos {:?} model {}", o.id, &o.transform[9..12], o.model);
			}
		}
		Err(e) => {
			println!("body: NOT decoded: {e}");
			print!("{}", hex(&w.rest[..w.rest.len().min(64)], rest_at));
			for ext in [".rvmat", ".p3d"] {
				let s = wrp::find_strings(&w.rest, &[ext]);
				println!("strings that end with {ext}: {}", s.len());
				for (o, t) in s.iter().take(limit) {
					println!("  at {:10} {t}", o + rest_at);
				}
			}
		}
	}
	if let Some(o) = opt.get("hex") {
		let o: usize = o.parse().unwrap_or_else(|_| fail("--hex needs a number"));
		print!("{}", hex(&bytes[o.min(bytes.len())..(o + 256).min(bytes.len())], o));
	}
	let num = |k: &str, d: f64| opt.get(k).map_or(d, |v| v.parse().unwrap_or_else(|_| fail(format!("--{k} needs a number"))));
	if let Some(out) = opt.get("asc") {
		let cell = w.layers.0 as f64 * w.layer_size as f64 / w.grid.0 as f64;
		let a = asc::Asc::from_south_rows(w.grid.0 as usize, w.grid.1 as usize, &w.heights, num("xll", 200000.0), num("yll", 0.0), cell);
		std::fs::write(out, a.write(num("decimals", 2.0) as usize)).unwrap_or_else(|e| fail(format!("{out}: {e}")));
		println!("wrote {out}");
	}
	if let Some(inp) = opt.get("compare-asc") {
		let a = asc::parse(&std::fs::read_to_string(inp).unwrap_or_else(|e| fail(format!("{inp}: {e}")))).unwrap_or_else(|e| fail(e));
		if (a.ncols, a.nrows) != (w.grid.0 as usize, w.grid.1 as usize) {
			fail(format!("ASC is {} x {}, WRP is {} x {}", a.ncols, a.nrows, w.grid.0, w.grid.1));
		}
		let flipped = asc::Asc::from_south_rows(a.ncols, a.nrows, &w.heights, 0.0, 0.0, 1.0).data;
		let d = flipped.iter().zip(&a.data).map(|(x, y)| (x - y).abs()).fold(0f32, f32::max);
		println!("largest difference to {inp} (flipped): {d}");
	}
	if let Some(out) = opt.get("write") {
		let again = w.write();
		std::fs::write(out, &again).unwrap_or_else(|e| fail(format!("{out}: {e}")));
		match again.iter().zip(&bytes).position(|(a, b)| a != b) {
			None if again.len() == bytes.len() => println!("round trip: identical ({out})"),
			p => fail(format!("round trip: different at byte {}", p.unwrap_or(again.len().min(bytes.len())))),
		}
	}
}
