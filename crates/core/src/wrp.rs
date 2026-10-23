//! Reader and writer for the editable WRP (`8WVR`). See docs/wrp-format.md.
//! The header and the heights are verified. The rest uses a hypothesis.
//! The reader checks the hypothesis: it must use all bytes, and the writer must give the same bytes.
//! If the check fails, the reader keeps the rest as raw bytes and gives the reason.

#[derive(Debug, Clone, PartialEq)]
pub struct Object {
	/// 4 x 3 matrix: aside, up, dir, position. Assumed: position is (x, z, y).
	pub transform: [f32; 12],
	pub id: u32,
	pub model: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Body {
	/// One value for each texture layer cell. Assumed: index into `materials`.
	pub material_index: Vec<u16>,
	pub materials: Vec<String>,
	pub objects: Vec<Object>,
}

#[derive(Debug, Clone)]
pub struct Wrp {
	/// Texture layer grid (x, y).
	pub layers: (u32, u32),
	/// Terrain grid (x, y).
	pub grid: (u32, u32),
	/// Texture layer size in meters.
	pub layer_size: f32,
	/// Heights. Row 0 is the south row.
	pub heights: Vec<f32>,
	/// The bytes after the heights, as they are in the file.
	pub rest: Vec<u8>,
	/// The decoded rest, or the reason why the hypothesis failed.
	pub body: Result<Body, String>,
}

pub const HEADER_LEN: usize = 24;

pub fn read(b: &[u8]) -> Result<Wrp, String> {
	if b.len() < HEADER_LEN || &b[0..4] != b"8WVR" {
		return Err("WRP: the file does not start with 8WVR".into());
	}
	let u = |o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap());
	let layers = (u(4), u(8));
	let grid = (u(12), u(16));
	let layer_size = f32::from_le_bytes(b[20..24].try_into().unwrap());
	let n = grid.0 as usize * grid.1 as usize;
	let end = HEADER_LEN + n * 4;
	if b.len() < end {
		return Err(format!("WRP: file has {} bytes, the heights need {end}", b.len()));
	}
	let heights = b[HEADER_LEN..end].chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect();
	let rest = b[end..].to_vec();
	let body = parse_body(&rest, layers.0 as usize * layers.1 as usize).and_then(|body| {
		let again = write_body(&body);
		match again.iter().zip(&rest).position(|(a, b)| a != b) {
			None if again.len() == rest.len() => Ok(body),
			p => Err(format!("hypothesis read all bytes, but the writer output differs at rest offset {}", p.unwrap_or(again.len().min(rest.len())))),
		}
	});
	Ok(Wrp {
		layers,
		grid,
		layer_size,
		heights,
		rest,
		body,
	})
}

struct Cur<'a> {
	b: &'a [u8],
	i: usize,
}

impl Cur<'_> {
	fn take(&mut self, n: usize, what: &str) -> Result<&[u8], String> {
		if self.i + n > self.b.len() {
			return Err(format!("{what} at rest offset {} needs {n} bytes, but only {} are left", self.i, self.b.len() - self.i));
		}
		self.i += n;
		Ok(&self.b[self.i - n..self.i])
	}
	fn u32(&mut self, what: &str) -> Result<u32, String> {
		Ok(u32::from_le_bytes(self.take(4, what)?.try_into().unwrap()))
	}
	fn string(&mut self, what: &str) -> Result<String, String> {
		let n = self.u32(what)? as usize;
		if n > 4096 {
			return Err(format!("{what} at rest offset {} has length {n}, which is too long", self.i - 4));
		}
		Ok(String::from_utf8_lossy(self.take(n, what)?).into_owned())
	}
}

fn parse_body(rest: &[u8], cells: usize) -> Result<Body, String> {
	let mut c = Cur { b: rest, i: 0 };
	let material_index = c.take(cells * 2, "material index grid")?.chunks_exact(2).map(|x| u16::from_le_bytes([x[0], x[1]])).collect();
	let n = c.u32("material count")? as usize;
	if n > 1_000_000 {
		return Err(format!("material count {n} is not possible"));
	}
	let mut materials = Vec::with_capacity(n);
	for _ in 0..n {
		let m = c.string("material name")?;
		// Verified in bro_range.wrp: a name that is not empty has a uint32 0 after it. Its meaning is unknown.
		if !m.is_empty() && c.u32("value after material name")? != 0 {
			return Err(format!("value after material name at rest offset {} is not 0", c.i - 4));
		}
		materials.push(m);
	}
	let mut objects = Vec::new();
	while c.i < rest.len() {
		let m = c.take(48, "object transform")?;
		let mut transform = [0f32; 12];
		for (t, x) in transform.iter_mut().zip(m.chunks_exact(4)) {
			*t = f32::from_le_bytes(x.try_into().unwrap());
		}
		let id = c.u32("object id")?;
		let model = c.string("object model path")?;
		objects.push(Object { transform, id, model });
	}
	Ok(Body { material_index, materials, objects })
}

fn write_body(body: &Body) -> Vec<u8> {
	let mut o = Vec::new();
	for v in &body.material_index {
		o.extend(v.to_le_bytes());
	}
	o.extend((body.materials.len() as u32).to_le_bytes());
	let s = |o: &mut Vec<u8>, t: &str| {
		o.extend((t.len() as u32).to_le_bytes());
		o.extend(t.as_bytes());
	};
	for m in &body.materials {
		s(&mut o, m);
		if !m.is_empty() {
			o.extend(0u32.to_le_bytes());
		}
	}
	for ob in &body.objects {
		for t in ob.transform {
			o.extend(t.to_le_bytes());
		}
		o.extend(ob.id.to_le_bytes());
		s(&mut o, &ob.model);
	}
	o
}

impl Wrp {
	/// Write the WRP. If the body is decoded, write it from the decoded data. If not, write the raw bytes.
	pub fn write(&self) -> Vec<u8> {
		let mut o = Vec::with_capacity(HEADER_LEN + self.heights.len() * 4 + self.rest.len());
		o.extend(b"8WVR");
		for v in [self.layers.0, self.layers.1, self.grid.0, self.grid.1] {
			o.extend(v.to_le_bytes());
		}
		o.extend(self.layer_size.to_le_bytes());
		for h in &self.heights {
			o.extend(h.to_le_bytes());
		}
		match &self.body {
			Ok(b) => o.extend(write_body(b)),
			Err(_) => o.extend(&self.rest),
		}
		o
	}
	/// Replace the material table and the material index grid.
	/// `cells` has the RVMAT path of each texture layer cell, row by row. Row 0 is the north row (the image order).
	/// The WRP grid uses row 0 = south row, x changes fastest. Verified with bro_range.wrp (256 of 256 cells).
	pub fn set_materials(&mut self, cells: &[String]) -> Result<(), String> {
		let (w, h) = (self.layers.0 as usize, self.layers.1 as usize);
		if cells.len() != w * h {
			return Err(format!("the WRP has {w} x {h} texture layer cells, the tiles have {}", cells.len()));
		}
		if cells.iter().any(|c| c.is_empty()) {
			return Err("a texture layer cell has no RVMAT".into());
		}
		let body = self.body.as_mut().map_err(|e| format!("the WRP body is not decoded: {e}"))?;
		let mut names: Vec<String> = cells.to_vec();
		names.sort();
		names.dedup();
		// Material 0 is empty, as in the TB files.
		names.insert(0, String::new());
		body.material_index = (0..h)
			.flat_map(|r| (0..w).map(move |c| (r, c)))
			.map(|(r, c)| names.binary_search(&cells[(h - 1 - r) * w + c]).unwrap() as u16)
			.collect();
		body.materials = names;
		Ok(())
	}
	pub fn height_range(&self) -> (f32, f32) {
		self.heights.iter().fold((f32::MAX, f32::MIN), |(a, b), &h| (a.min(h), b.max(h)))
	}
}

/// Find printable strings that end with one of `exts` (case ignored). Returns (offset, text).
/// Use this to study the bytes when the hypothesis fails.
pub fn find_strings(b: &[u8], exts: &[&str]) -> Vec<(usize, String)> {
	let mut out = Vec::new();
	let mut start = 0;
	for i in 0..=b.len() {
		let printable = i < b.len() && (0x20..0x7f).contains(&b[i]);
		if !printable {
			if i - start >= 5 {
				let s = String::from_utf8_lossy(&b[start..i]).into_owned();
				let lower = s.to_ascii_lowercase();
				if exts.iter().any(|e| lower.ends_with(e)) {
					out.push((start, s));
				}
			}
			start = i + 1;
		}
	}
	out
}

#[cfg(test)]
mod tests {
	use super::*;
	fn sample() -> Wrp {
		let body = Body {
			material_index: vec![1, 1, 0, 2],
			materials: vec!["".into(), "a\\p_000-000_l01.rvmat".into(), "a\\p_000-000_l02.rvmat".into()],
			objects: vec![Object {
				transform: [1., 0., 0., 0., 1., 0., 0., 0., 1., 207000., 5., 14000.],
				id: 7,
				model: "a3\\x.p3d".into(),
			}],
		};
		Wrp {
			layers: (2, 2),
			grid: (2, 2),
			layer_size: 64.0,
			heights: vec![1., 2., 3., 4.],
			rest: write_body(&body),
			body: Ok(body),
		}
	}
	#[test]
	fn round_trip_of_decoded_file_is_identical() {
		let bytes = sample().write();
		let w = read(&bytes).unwrap();
		assert!(w.body.is_ok());
		assert_eq!(w.write(), bytes);
		assert_eq!(w.height_range(), (1.0, 4.0));
		assert_eq!(find_strings(&bytes, &[".p3d"]).len(), 1);
	}
	#[test]
	fn set_materials_flips_rows_to_south_first() {
		let mut w = sample();
		let cells: Vec<String> = ["b", "a", "c", "a"].iter().map(|s| s.to_string()).collect();
		w.set_materials(&cells).unwrap();
		let b = w.body.as_ref().unwrap();
		assert_eq!(b.materials, ["", "a", "b", "c"]);
		assert_eq!(b.material_index, [3, 1, 2, 1]);
		let again = read(&w.write()).unwrap();
		assert_eq!(again.body.unwrap().materials.len(), 4);
	}
	#[test]
	fn unknown_rest_stays_raw() {
		let mut bytes = sample().write();
		bytes.extend([1, 2, 3]);
		let w = read(&bytes).unwrap();
		assert!(w.body.is_err());
		assert_eq!(w.write(), bytes);
	}
}
