//! Reader for the ALB1 format of Terrain Builder (`.tv4p` project, `.tv4l` layer, `.tv4s` shapes).
//! Verified with the bro_msi project. See docs/tv4p-format.md.
//! Layout: `ALB1`, 12 bytes, a table of field names, a table of class names, then the root object (uint16 class, uint32 ID, fields).
//! Table: uint16, byte, uint32 count, then for each name: uint16 ID, uint16 length, characters.
//! Field: uint16 name ID, byte type, value.

#[derive(Debug, Clone, PartialEq)]
pub enum Node {
	Int(i64),
	Float(f64),
	Bool(bool),
	Char(u8),
	Str(String),
	Doubles(Vec<f64>),
	Null,
	/// Reference to an object: class name and object ID.
	Ref(String, u32),
	/// Object or key-value pair: class name (`pair` for a pair), object ID, fields.
	Obj(String, u32, Vec<(String, Node)>),
	/// List: count and items.
	List(u32, Vec<(String, Node)>),
	/// A block that this reader cannot decode, for example the object tree of a layer.
	Raw(Vec<u8>),
}

impl Node {
	/// The first field with this name, in an object or a list.
	pub fn get(&self, name: &str) -> Option<&Node> {
		self.fields().iter().find(|(n, _)| n == name).map(|(_, v)| v)
	}
	pub fn fields(&self) -> &[(String, Node)] {
		match self {
			Node::Obj(_, _, f) | Node::List(_, f) => f,
			_ => &[],
		}
	}
	pub fn str(&self) -> Option<&str> {
		if let Node::Str(s) = self {
			Some(s)
		} else {
			None
		}
	}
	pub fn num(&self) -> Option<f64> {
		match self {
			Node::Int(v) => Some(*v as f64),
			Node::Float(v) => Some(*v),
			_ => None,
		}
	}
}

struct R<'a> {
	b: &'a [u8],
	names: std::collections::HashMap<u16, String>,
	classes: std::collections::HashMap<u16, String>,
}

impl R<'_> {
	fn take(&self, o: usize, n: usize) -> Result<&[u8], String> {
		self.b.get(o..o + n).ok_or_else(|| format!("ALB1: file ends at offset {o}"))
	}
	fn u16(&self, o: usize) -> Result<u16, String> {
		Ok(u16::from_le_bytes(self.take(o, 2)?.try_into().unwrap()))
	}
	fn u32(&self, o: usize) -> Result<u32, String> {
		Ok(u32::from_le_bytes(self.take(o, 4)?.try_into().unwrap()))
	}
	fn class(&self, id: u16) -> String {
		self.classes.get(&id).cloned().unwrap_or_else(|| id.to_string())
	}
	fn fields(&self, mut o: usize, end: usize) -> Result<Vec<(String, Node)>, String> {
		let mut out = Vec::new();
		while o < end {
			let (name, (v, next)) = self.field(o)?;
			out.push((name, v));
			o = next;
		}
		if o != end {
			return Err(format!("ALB1: fields end at offset {o}, not {end}"));
		}
		Ok(out)
	}
	fn field(&self, o: usize) -> Result<(String, (Node, usize)), String> {
		let id = self.u16(o)?;
		let name = self.names.get(&id).cloned().unwrap_or_else(|| id.to_string());
		Ok((name, self.value(o + 3, self.take(o + 2, 1)?[0])?))
	}
	fn value(&self, o: usize, t: u8) -> Result<(Node, usize), String> {
		Ok(match t {
			0x01 => (Node::Char(self.take(o, 1)?[0]), o + 1),
			0x05 => (Node::Int(self.u32(o)? as i32 as i64), o + 4),
			0x06 | 0x07 => (Node::Int(self.u32(o)? as i64), o + 4),
			0x09 => (Node::Bool(self.take(o, 1)?[0] != 0), o + 1),
			0x0a => (Node::Float(f32::from_le_bytes(self.take(o, 4)?.try_into().unwrap()) as f64), o + 4),
			0x14 => (Node::Float(f64::from_le_bytes(self.take(o, 8)?.try_into().unwrap())), o + 8),
			0x0b => {
				let n = self.u16(o)? as usize;
				(Node::Str(String::from_utf8_lossy(self.take(o + 2, n)?).into_owned()), o + 2 + n)
			}
			0x13 => (Node::Null, o),
			// Doubles: byte count, then the values.
			0x15 => {
				let n = self.take(o, 1)?[0] as usize;
				let d = self.take(o + 1, 8 * n)?;
				(Node::Doubles(d.chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect()), o + 1 + 8 * n)
			}
			0x0e => (Node::Ref(self.class(self.u16(o)?), self.u32(o + 2)?), o + 6),
			// Pair: two fields without a size.
			0x0f => {
				let (k, (kv, o2)) = self.field(o)?;
				let (v, (vv, o3)) = self.field(o2)?;
				(Node::Obj("pair".into(), 0, vec![(k, kv), (v, vv)]), o3)
			}
			// Object: uint32 size (from after the size), uint16 class, uint32 ID, fields.
			0x0d => {
				let end = o + 4 + self.u32(o)? as usize;
				(Node::Obj(self.class(self.u16(o + 4)?), self.u32(o + 6)?, self.fields(o + 10, end)?), end)
			}
			// List: uint32 size (from after the size), uint32 count, fields. Some lists hold other data: keep them as raw bytes.
			0x0c => {
				let end = o + 4 + self.u32(o)? as usize;
				match self.fields(o + 8, end) {
					Ok(f) => (Node::List(self.u32(o + 4)?, f), end),
					Err(_) => (Node::Raw(self.take(o + 4, end - o - 4)?.to_vec()), end),
				}
			}
			t => return Err(format!("ALB1: value type 0x{t:02X} at offset {o} is not known")),
		})
	}
}

/// Read an ALB1 file. Returns the root object.
pub fn read(b: &[u8]) -> Result<Node, String> {
	if !b.starts_with(b"ALB1") {
		return Err("the file does not start with ALB1".into());
	}
	let mut r = R {
		b,
		names: Default::default(),
		classes: Default::default(),
	};
	let mut o = 16;
	for k in 0..2 {
		let n = r.u32(o + 3)? as usize;
		o += 7;
		let mut map = std::collections::HashMap::new();
		for _ in 0..n {
			let (id, len) = (r.u16(o)?, r.u16(o + 2)? as usize);
			map.insert(id, String::from_utf8_lossy(r.take(o + 4, len)?).into_owned());
			o += 4 + len;
		}
		if k == 0 {
			r.names = map;
		} else {
			r.classes = map;
		}
	}
	Ok(Node::Obj(r.class(r.u16(o)?), r.u32(o + 2)?, r.fields(o + 6, b.len())?))
}

/// The parts of a Terrain Builder project that the tool uses.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tv4p {
	pub name: String,
	/// Map frame: x min, y min, x max, y max (TB coordinates, with the TB offset).
	pub map_frame: Vec<f64>,
	/// Folder for the WRP export, for example `p:\bromine\bro_msi`.
	pub wrp_folder: String,
	/// layers.cfg as a game path.
	pub layers_cfg: String,
	/// Texture layer size in meters.
	pub texture_layer: f64,
	/// Satellite tile size and overlap in pixels, and meters for each pixel.
	pub tile_px: i64,
	pub overlap_px: i64,
	pub meters_per_px: f64,
	/// Imported files: heightmap (ASC), satellite image, and mask image. Empty when the project has none.
	pub heightmap: String,
	pub satellite: String,
	pub mask: String,
}

/// Read the project settings and the imported files of a `.tv4p` file.
pub fn tv4p(b: &[u8]) -> Result<Tv4p, String> {
	let root = read(b)?;
	let mut p = Tv4p {
		name: root.get("mname").and_then(Node::str).unwrap_or("").into(),
		..Default::default()
	};
	let frame = root.get("objManager").and_then(|m| m.get("mapFrame")).and_then(|m| m.get("mframe")).and_then(|l| l.get("item"));
	if let Some(f) = frame {
		if let Some(Node::Doubles(d)) = f.get("mpos") {
			p.map_frame = d.clone();
		}
		if let Some(c) = f.get("config") {
			let s = |k: &str| c.get(k).and_then(Node::str).unwrap_or("").to_string();
			let n = |k: &str| c.get(k).and_then(Node::num).unwrap_or(0.0);
			p.wrp_folder = s("wrpdirexport");
			p.layers_cfg = s("wrpfilecfg");
			p.texture_layer = n("gridX");
			p.tile_px = n("texcell") as i64;
			p.overlap_px = n("texoverlap") as i64;
			p.meters_per_px = n("imageryResolution");
		}
	}
	// Imported files: type 0 = heightmap, 1 = satellite, 2 = mask. The heightfield cache of TB has type 0 and no file name.
	let contents = root.get("world").and_then(|w| w.get("mcontents")).and_then(|m| m.get("mcontents"));
	for (_, pair) in contents.map(Node::fields).unwrap_or_default() {
		let Some(item) = pair.get("data") else { continue };
		let file = item.get("filename").and_then(Node::str).unwrap_or("");
		let slot = match item.get("type").and_then(Node::num) {
			Some(t) if t == 0.0 && file.to_ascii_lowercase().ends_with(".asc") => &mut p.heightmap,
			Some(t) if t == 1.0 => &mut p.satellite,
			Some(t) if t == 2.0 => &mut p.mask,
			_ => continue,
		};
		*slot = file.to_string();
	}
	Ok(p)
}
