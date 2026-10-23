//! Reader for P3D models. MLOD is verified with Bro_MSWR_Doorway.p3d (4 LODs).
//! ODOL version 73 is verified with 6 vanilla models (69 LODs). See docs/p3d-format.md.
//! The output stays in Arma model space: x right, y up, z forward.

/// One LOD of an MLOD file.
#[derive(Debug, Clone)]
pub struct MlodLod {
	pub resolution: f32,
	pub points: Vec<[f32; 3]>,
	/// Flags of each point. The low 4 bits: 1 is "On surface" (Object Builder vertex properties).
	pub point_flags: Vec<u32>,
	pub normals: Vec<[f32; 3]>,
	pub faces: Vec<MlodFace>,
	/// Names of the named selections (tags without `#`), in file order.
	pub selections: Vec<String>,
	/// Second UV set (tag `#UVSet#` with index 1): one value for each face corner, in face order. Empty when the LOD has no second set.
	pub uv1: Vec<[f32; 2]>,
	/// Named properties (tag `#Property#`): name and value, for example `autocenter` and `0`.
	pub properties: Vec<(String, String)>,
	/// True for each face of a proxy selection (`proxy:...`). The game does not draw these faces.
	pub proxy: Vec<bool>,
}

#[derive(Debug, Clone)]
pub struct MlodFace {
	/// 3 or 4 vertices: point index, normal index, u, v.
	pub verts: Vec<(u32, u32, f32, f32)>,
	pub texture: String,
	pub material: String,
}

/// Mesh for the viewer: one vertex list, and one triangle list for each texture and material.
#[derive(Debug, Clone, Default)]
pub struct Mesh {
	pub positions: Vec<[f32; 3]>,
	pub normals: Vec<[f32; 3]>,
	pub uvs: Vec<[f32; 2]>,
	/// Second UV set (for example the mask of a multimaterial). Empty when the model has no second set.
	pub uv1: Vec<[f32; 2]>,
	pub groups: Vec<Group>,
	pub min: [f32; 3],
	pub max: [f32; 3],
	/// Shift of the binarizer: original model origin = centered position + offset. The positions above are centered.
	/// The WRP uses the centered origin. TB object text uses the centered origin for x and y, and the original origin for the height.
	pub offset: [f32; 3],
	/// Clip flags of each vertex. `CLIP_LAND_ON` (Object Builder "On surface"): the game puts the vertex on the terrain (decals).
	/// An MLOD point flag "On surface" becomes `CLIP_LAND_ON`.
	pub clip: Vec<u32>,
	/// Points of the LandContact LOD (centered model space) when the geometry LOD has `placement = slopelandcontact`.
	/// The game shears the model up or down so that these points touch the terrain (fences on slopes). Else empty.
	pub land_contact: Vec<[f32; 3]>,
	/// Named properties of the LOD (ODOL).
	pub properties: Vec<(String, String)>,
	/// Proxies: other models that the game draws at a place in this model (for example the wire of a fence).
	pub proxies: Vec<Proxy>,
}

#[derive(Debug, Clone, Default)]
pub struct Proxy {
	/// Model path as in the file.
	pub model: String,
	/// Orientation (3 rows: aside, up, direction) and position, in centered model space.
	pub matrix: [f32; 12],
}

#[derive(Debug, Clone, Default)]
pub struct Group {
	/// Texture path, lower case, as in the model. Faces of a multimaterial have no texture.
	pub texture: String,
	/// RVMAT path, lower case, as in the model.
	pub material: String,
	pub indices: Vec<u32>,
}

struct Cur<'a> {
	b: &'a [u8],
	i: usize,
}

impl Cur<'_> {
	fn take(&mut self, n: usize) -> Result<&[u8], String> {
		let s = self.b.get(self.i..self.i + n).ok_or_else(|| format!("P3D: file ends at offset {} (need {n} bytes)", self.i))?;
		self.i += n;
		Ok(s)
	}
	fn u32(&mut self) -> Result<u32, String> {
		Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
	}
	fn f32(&mut self) -> Result<f32, String> {
		Ok(f32::from_le_bytes(self.take(4)?.try_into().unwrap()))
	}
	fn vec3(&mut self) -> Result<[f32; 3], String> {
		Ok([self.f32()?, self.f32()?, self.f32()?])
	}
	fn u8(&mut self) -> Result<u8, String> {
		Ok(self.take(1)?[0])
	}
	fn i32(&mut self) -> Result<i32, String> {
		Ok(self.u32()? as i32)
	}
	fn skip(&mut self, n: usize) -> Result<(), String> {
		self.take(n).map(|_| ())
	}
	/// ODOL array: count (given or read), then if the size is not 0, a flag byte and the data. Flag 0 = raw, else LZO.
	fn compressed(&mut self, esize: usize, count: Option<usize>) -> Result<(usize, Vec<u8>), String> {
		let n = match count {
			Some(n) => n,
			None => self.u32()? as usize,
		};
		if n * esize == 0 {
			return Ok((n, Vec::new()));
		}
		if self.u8()? == 0 {
			return Ok((n, self.take(n * esize)?.to_vec()));
		}
		let (d, used) = crate::paa::lzo1x_prefix(&self.b[self.i..], n * esize).map_err(|e| format!("ODOL at offset {}: {e}", self.i))?;
		self.i += used;
		Ok((n, d))
	}
	/// ODOL array that can be one fill value: count, fill flag, then one element or a compressed array.
	fn condensed(&mut self, esize: usize) -> Result<(usize, Vec<u8>, bool), String> {
		let n = self.u32()? as usize;
		if self.u8()? != 0 {
			return Ok((n, self.take(esize)?.to_vec(), true));
		}
		let (n, d) = self.compressed(esize, Some(n))?;
		Ok((n, d, false))
	}
	fn asciiz(&mut self) -> Result<String, String> {
		let rest = &self.b[self.i.min(self.b.len())..];
		let n = rest.iter().position(|&c| c == 0).ok_or("P3D: string has no end")?;
		self.i += n + 1;
		Ok(String::from_utf8_lossy(&rest[..n]).into_owned())
	}
}

/// Read all LODs of an MLOD file (`MLOD`, version 257, `P3DM` LODs).
pub fn read_mlod(b: &[u8]) -> Result<Vec<MlodLod>, String> {
	let mut c = Cur { b, i: 0 };
	if c.take(4)? != b"MLOD" {
		return Err("P3D: the file does not start with MLOD".into());
	}
	let version = c.u32()?;
	if version != 257 {
		return Err(format!("MLOD version {version} is not supported"));
	}
	let n = c.u32()?;
	let mut lods = Vec::new();
	for _ in 0..n {
		if c.take(4)? != b"P3DM" {
			return Err(format!("MLOD: LOD {} does not start with P3DM", lods.len()));
		}
		let (_major, _minor) = (c.u32()?, c.u32()?);
		let (np, nn, nf, _flags) = (c.u32()? as usize, c.u32()? as usize, c.u32()? as usize, c.u32()?);
		let mut points = Vec::with_capacity(np);
		let mut point_flags = Vec::with_capacity(np);
		for _ in 0..np {
			points.push(c.vec3()?);
			point_flags.push(c.u32()?);
		}
		let mut normals = Vec::with_capacity(nn);
		for _ in 0..nn {
			normals.push(c.vec3()?);
		}
		let mut faces = Vec::with_capacity(nf);
		for _ in 0..nf {
			let count = c.u32()? as usize;
			if !(3..=4).contains(&count) {
				return Err(format!("MLOD: face with {count} vertices"));
			}
			let mut verts = Vec::with_capacity(count);
			for k in 0..4 {
				let v = (c.u32()?, c.u32()?, c.f32()?, c.f32()?);
				if k < count {
					if v.0 as usize >= np || (nn > 0 && v.1 as usize >= nn) {
						return Err("MLOD: face index outside the point or normal list".into());
					}
					verts.push(v);
				}
			}
			c.u32()?;
			faces.push(MlodFace {
				verts,
				texture: c.asciiz()?,
				material: c.asciiz()?,
			});
		}
		if c.take(4)? != b"TAGG" {
			return Err("MLOD: TAGG is missing".into());
		}
		let mut selections = Vec::new();
		let mut uv1 = Vec::new();
		let mut properties = Vec::new();
		let corners: usize = faces.iter().map(|f| f.verts.len()).sum();
		let mut proxy = vec![false; nf];
		loop {
			c.take(1)?;
			let name = c.asciiz()?;
			let size = c.u32()? as usize;
			let data = c.take(size)?;
			if name == "#EndOfFile#" {
				break;
			}
			// UV set: uint32 index, then u and v (float) for each face corner. Verified with IndustrialShed_01_F (sets 0 and 1).
			if name == "#UVSet#" && size == 4 + corners * 8 && data[0..4] == 1u32.to_le_bytes() {
				let f = |o: usize| f32::from_le_bytes(data[o..o + 4].try_into().unwrap());
				uv1 = (0..corners).map(|k| [f(4 + k * 8), f(8 + k * 8)]).collect();
			}
			// Property: 64 bytes name and 64 bytes value, each ends with a zero byte.
			if name == "#Property#" && size == 128 {
				let text = |d: &[u8]| String::from_utf8_lossy(d.split(|&c| c == 0).next().unwrap_or_default()).into_owned();
				properties.push((text(&data[..64]), text(&data[64..])));
			}
			// Selection: one weight byte for each point, then one for each face.
			if name.to_ascii_lowercase().starts_with("proxy:") && size == np + nf {
				for (k, p) in proxy.iter_mut().enumerate() {
					*p |= data[np + k] != 0;
				}
			}
			if !name.starts_with('#') {
				selections.push(name);
			}
		}
		lods.push(MlodLod {
			resolution: c.f32()?,
			points,
			point_flags,
			normals,
			faces,
			selections,
			uv1,
			properties,
			proxy,
		});
	}
	Ok(lods)
}

/// Clip flag of a vertex on the terrain surface (ODOL `ClipLandOn`). Verified: all 9 vertices of HelipadSquare_F have 0x13F, a fence has 0x3F.
pub const CLIP_LAND_ON: u32 = 0x100;

fn near(r: f32, want: f32) -> bool {
	(r - want).abs() < want * 1e-3
}

fn slope_land_contact(props: &[(String, String)]) -> bool {
	props.iter().any(|(k, v)| k.eq_ignore_ascii_case("placement") && v.trim().eq_ignore_ascii_case("slopelandcontact"))
}

/// Read a P3D file and make the mesh of its most detailed visual LOD, or with `low` its least detailed visual LOD.
pub fn mesh(b: &[u8], low: bool) -> Result<Mesh, String> {
	match b.get(0..4) {
		Some(b"MLOD") => {
			let lods = read_mlod(b)?;
			let i = visual_lod(&lods.iter().map(|l| l.resolution).collect::<Vec<_>>(), low).ok_or("P3D: no visual LOD")?;
			let mut m = lods[i].mesh();
			// The binarizer moves the model so that the center of the bounding box of all LODs is at the origin.
			// The WRP and the game use that origin. Verified with 6 vanilla ODOL models and the doorway.
			let off = if lods.iter().flat_map(|l| &l.properties).any(|(k, v)| k.eq_ignore_ascii_case("autocenter") && v.trim() == "0") {
				[0.0; 3]
			} else {
				let pts = lods.iter().flat_map(|l| &l.points);
				let (mut lo, mut hi) = ([f32::MAX; 3], [f32::MIN; 3]);
				for p in pts {
					for k in 0..3 {
						lo[k] = lo[k].min(p[k]);
						hi[k] = hi[k].max(p[k]);
					}
				}
				[(lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0, (lo[2] + hi[2]) / 2.0]
			};
			for p in m.positions.iter_mut() {
				for k in 0..3 {
					p[k] -= off[k];
				}
			}
			if lods.iter().filter(|l| near(l.resolution, 1e13)).any(|l| slope_land_contact(&l.properties)) {
				if let Some(l) = lods.iter().find(|l| near(l.resolution, 2e15)) {
					m.land_contact = l.points.iter().map(|p| [p[0] - off[0], p[1] - off[1], p[2] - off[2]]).collect();
				}
			}
			m.bounds();
			m.offset = off;
			Ok(m)
		}
		Some(b"ODOL") => {
			let o = read_odol(b)?;
			let i = visual_lod(&o.resolutions, low).ok_or("P3D: no visual LOD")?;
			let mut m = odol_lod(b, &o, i)?;
			m.offset = o.bounding_center;
			let lod = |r: f32| o.resolutions.iter().position(|&x| near(x, r)).and_then(|k| odol_lod(b, &o, k).ok());
			if lod(1e13).is_some_and(|g| slope_land_contact(&g.properties)) {
				m.land_contact = lod(2e15).map(|l| l.positions).unwrap_or_default();
			}
			Ok(m)
		}
		_ => Err("not a P3D file".into()),
	}
}

/// Index of the most detailed visual LOD (the smallest resolution below 1000). With `low`: the least detailed visual LOD.
pub fn visual_lod(resolutions: &[f32], low: bool) -> Option<usize> {
	let visual = resolutions.iter().enumerate().filter(|(_, &r)| r < 1000.0);
	let lod = if low { visual.max_by(|a, b| a.1.total_cmp(b.1)) } else { visual.min_by(|a, b| a.1.total_cmp(b.1)) };
	lod.map(|(i, _)| i)
}

impl MlodLod {
	/// Make a mesh. Each different (point, normal, uv) becomes one vertex. A quad becomes two triangles.
	pub fn mesh(&self) -> Mesh {
		let mut m = Mesh::default();
		let mut seen = std::collections::HashMap::new();
		let mut corner = 0;
		for (fi, f) in self.faces.iter().enumerate() {
			if self.proxy.get(fi) == Some(&true) {
				corner += f.verts.len();
				continue;
			}
			let gi = m.group(&f.texture, &f.material);
			let ids: Vec<u32> = f
				.verts
				.iter()
				.map(|&(p, n, u, v)| {
					let w = self.uv1.get(corner).copied();
					corner += 1;
					let key = (p, n, u.to_bits(), v.to_bits(), w.map(|w| (w[0].to_bits(), w[1].to_bits())));
					*seen.entry(key).or_insert_with(|| {
						m.positions.push(self.points[p as usize]);
						// The same meaning as the ODOL clip flags: 0x100 is "On surface".
						m.clip.push(if self.point_flags.get(p as usize).is_some_and(|f| f & 0xF == 1) { CLIP_LAND_ON } else { 0 });
						m.normals.push(self.normals.get(n as usize).copied().unwrap_or([0.0, 1.0, 0.0]));
						m.uvs.push([u, v]);
						if let Some(w) = w {
							m.uv1.push(w);
						}
						m.positions.len() as u32 - 1
					})
				})
				.collect();
			let tris: &[usize] = if ids.len() == 4 { &[0, 1, 2, 0, 2, 3] } else { &[0, 1, 2] };
			m.groups[gi].indices.extend(tris.iter().map(|&k| ids[k]));
		}
		m.bounds();
		m
	}
}

/// Put the proxy models into a mesh, `depth` levels deep. `load` gives the bytes of a proxy model by its path, or None.
/// shortcut: only ODOL proxies are read (MLOD proxies are faces of a selection). Read them when an MLOD model needs them.
pub fn add_proxies(m: &mut Mesh, low: bool, depth: u32, load: &dyn Fn(&str) -> Option<Vec<u8>>) {
	if depth == 0 {
		return;
	}
	for p in std::mem::take(&mut m.proxies) {
		// Flags (flag_f of mast_f) are cloth that the game animates. Their mesh does not show correctly here, so the pole stays without it.
		if p.model.rsplit(['\\', '/']).next().is_some_and(|n| n.to_ascii_lowercase().starts_with("flag")) {
			continue;
		}
		let Some(b) = load(&p.model) else { continue };
		let Ok(mut c) = mesh(&b, low) else { continue };
		add_proxies(&mut c, low, depth - 1, load);
		m.add_proxy(&c, &p.matrix);
	}
}

impl Mesh {
	/// Add a proxy model. The original origin of the proxy model goes to the proxy position (verified with New_WiredFence_10m_F:
	/// its proxy position is minus its own binarizer shift, and the wire is on the posts).
	pub fn add_proxy(&mut self, c: &Mesh, m: &[f32; 12]) {
		let base = self.positions.len() as u32;
		let tf = |p: [f32; 3], w: f32| [0, 1, 2].map(|k| m[k] * p[0] + m[3 + k] * p[1] + m[6 + k] * p[2] + w * m[9 + k]);
		self.positions.extend(c.positions.iter().map(|p| tf([p[0] + c.offset[0], p[1] + c.offset[1], p[2] + c.offset[2]], 1.0)));
		self.normals.extend(c.normals.iter().map(|n| {
			let v = tf(*n, 0.0);
			let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt().max(1e-9);
			v.map(|x| x / l)
		}));
		self.uvs.extend(&c.uvs);
		// Optional per-vertex lists: fill the missing part with zeros, so that all lists keep the vertex count.
		let n = self.positions.len();
		if !self.uv1.is_empty() || !c.uv1.is_empty() {
			self.uv1.resize(base as usize, [0.0; 2]);
			self.uv1.extend(&c.uv1);
			self.uv1.resize(n, [0.0; 2]);
		}
		if !self.clip.is_empty() || !c.clip.is_empty() {
			self.clip.resize(base as usize, 0);
			self.clip.extend(&c.clip);
			self.clip.resize(n, 0);
		}
		for g in &c.groups {
			let gi = self.group(&g.texture, &g.material);
			self.groups[gi].indices.extend(g.indices.iter().map(|i| i + base));
		}
		self.bounds();
	}

	/// Index of the group for this texture and material. A new group is added when necessary.
	fn group(&mut self, texture: &str, material: &str) -> usize {
		let (t, mat) = (texture.to_ascii_lowercase(), material.to_ascii_lowercase());
		if let Some(i) = self.groups.iter().position(|g| g.texture == t && g.material == mat) {
			return i;
		}
		self.groups.push(Group {
			texture: t,
			material: mat,
			indices: Vec::new(),
		});
		self.groups.len() - 1
	}
	fn bounds(&mut self) {
		let (mut lo, mut hi) = ([f32::MAX; 3], [f32::MIN; 3]);
		for p in &self.positions {
			for k in 0..3 {
				lo[k] = lo[k].min(p[k]);
				hi[k] = hi[k].max(p[k]);
			}
		}
		(self.min, self.max) = (lo, hi);
	}
}

/// Header of an ODOL file and the byte range of each LOD.
#[derive(Debug, Clone)]
pub struct Odol {
	pub version: u32,
	pub resolutions: Vec<f32>,
	/// Start and end offset of each LOD, in the order of `resolutions`.
	pub ranges: Vec<(usize, usize)>,
	/// Shift of the binarizer (model info `boundingCenter`, byte 104 of the model info in versions 73 and 75).
	/// Verified: the doorway gives the same value as its MLOD, and t_PinusS2s_F (6.904 m up) agrees with the object heights in bro_range.wrp.
	pub bounding_center: [f32; 3],
}

/// Read the ODOL header and find the table of LOD start and end offsets.
/// shortcut: the model info and the animations between the header and the table are not read. The tool finds the table
/// as the only place where 2 x n offsets give n ranges inside the file that do not overlap. Read them when a tool needs them.
pub fn read_odol(b: &[u8]) -> Result<Odol, String> {
	let mut c = Cur { b, i: 0 };
	if c.take(4)? != b"ODOL" {
		return Err("P3D: the file does not start with ODOL".into());
	}
	let version = c.u32()?;
	if !(69..=75).contains(&version) {
		return Err(format!("ODOL version {version} is not supported (69 to 75)"));
	}
	// App ID, then 8 more bytes in version 75 (meaning unknown, verified with the doorway), then the muzzle flash name.
	// shortcut: version 74 is not checked. The reader tries 0, 8 and 4 extra bytes and uses the first that gives a LOD table.
	let after_version = c.i;
	let mut last = String::new();
	for extra in [0, 8, 4] {
		c.i = after_version + 4 + extra;
		match odol_table(&mut c) {
			Ok((resolutions, ranges)) => {
				let f = |o: usize| b.get(o..o + 4).map_or(0.0, |x| f32::from_le_bytes(x.try_into().unwrap()));
				let at = c.i + 104;
				let bounding_center = [f(at), f(at + 4), f(at + 8)];
				return Ok(Odol { version, resolutions, ranges, bounding_center });
			}
			// Report the error of each attempt.
			Err(e) => last = if last.is_empty() { e } else { format!("{last}; {e}") },
		}
	}
	Err(last)
}

/// Read the muzzle flash name, the LOD count and the resolutions, then find the LOD table.
fn odol_table(c: &mut Cur) -> Result<(Vec<f32>, Vec<(usize, usize)>), String> {
	let b = c.b;
	c.asciiz()?;
	let n = c.u32()? as usize;
	if n == 0 || n > 64 {
		return Err(format!("ODOL: {n} LODs is not possible"));
	}
	let resolutions: Vec<f32> = (0..n).map(|_| c.f32()).collect::<Result<_, _>>()?;
	let start = c.i;
	let u = |p: usize| u32::from_le_bytes(b[p..p + 4].try_into().unwrap()) as usize;
	let mut found = Vec::new();
	for p in start..b.len().saturating_sub(8 * n) {
		let r: Vec<(usize, usize)> = (0..n).map(|k| (u(p + 4 * k), u(p + 4 * (n + k)))).collect();
		// The LOD data comes after the table.
		if !r.iter().all(|&(s, e)| p + 8 * n <= s && s < e && e <= b.len()) {
			continue;
		}
		let mut sorted = r.clone();
		sorted.sort();
		if sorted.windows(2).all(|w| w[0].1 <= w[1].0) {
			found.push(r);
			if found.len() > 1 {
				return Err("ODOL: the LOD table is not clear (more than one place fits)".into());
			}
		}
	}
	let ranges = found.pop().ok_or("ODOL: the LOD table is not found")?;
	Ok((resolutions, ranges))
}

/// Read one ODOL LOD and make a mesh. The checks stop at the first value that does not agree.
pub fn odol_lod(b: &[u8], o: &Odol, lod: usize) -> Result<Mesh, String> {
	let (start, end) = o.ranges[lod];
	let mut c = Cur { b: &b[..end], i: start };
	let err = |what: &str| Err(format!("ODOL LOD {lod} ({}): {what}", o.resolutions[lod]));
	let mut proxies = Vec::new();
	// Sections of the proxy triangles (the last value of each proxy). Verified with mast_f: its flag triangle is section 0.
	let mut proxy_sections = std::collections::HashSet::new();
	for _ in 0..c.u32()? {
		// Proxy: model name, 4 x 3 matrix, sequence ID, selection index, bone index, section index.
		let name = c.asciiz()?;
		let m: Vec<f32> = (0..12).map(|_| c.f32()).collect::<Result<_, _>>()?;
		c.skip(12)?;
		proxy_sections.insert(c.i32()? as usize);
		proxies.push(Proxy { model: name, matrix: m.try_into().unwrap() });
	}
	let n = c.u32()? as usize;
	c.skip(4 * n)?;
	for _ in 0..c.u32()? {
		let k = c.u32()? as usize;
		c.skip(4 * k)?;
	}
	let vertices = c.u32()? as usize;
	// Face area, hints, bounding box, center and radius.
	c.skip(4 + 8 + 40)?;
	let textures: Vec<String> = (0..c.u32()?).map(|_| c.asciiz()).collect::<Result<_, _>>()?;
	let mut materials = Vec::new();
	for _ in 0..c.u32()? {
		// Embedded material: name, version, 6 colors, specular power, 4 shader values, surface, render flags, stages, uv transforms.
		materials.push(c.asciiz()?);
		let mv = c.u32()?;
		c.skip(96 + 4 + 16)?;
		if mv >= 6 {
			c.asciiz()?;
		}
		c.skip(8)?;
		let stages = c.u32()?;
		let texgens = if mv > 6 { c.u32()? } else { stages };
		let stage = |c: &mut Cur| -> Result<(), String> {
			if mv >= 5 {
				c.u32()?;
			}
			c.asciiz()?;
			if mv >= 8 {
				c.u32()?;
			}
			if mv >= 11 {
				c.u8()?;
			}
			Ok(())
		};
		for _ in 0..stages {
			stage(&mut c)?;
		}
		c.skip(texgens as usize * 52)?;
		if mv >= 10 {
			stage(&mut c)?;
		}
	}
	// Point to vertex and vertex to point tables.
	c.compressed(4, None)?;
	c.compressed(4, None)?;
	let nf = c.u32()? as usize;
	let alloc = c.u32()? as usize;
	c.skip(2)?;
	// Face position in the allocation units (4 + 4 x corners) that the sections use.
	let mut faces = Vec::with_capacity(nf);
	let mut used = 0;
	for _ in 0..nf {
		let k = c.u8()? as usize;
		let idx: Vec<u32> = (0..k).map(|_| c.u32()).collect::<Result<_, _>>()?;
		if !(3..=4).contains(&k) || idx.iter().any(|&i| i as usize >= vertices) {
			return err("face index outside the vertex list");
		}
		faces.push((used, idx));
		used += 4 + 4 * k;
	}
	if used != alloc {
		return err("face data size does not agree with the allocation size");
	}
	let mut sections = Vec::new();
	for _ in 0..c.u32()? {
		let (lo, hi) = (c.i32()? as usize, c.i32()? as usize);
		c.skip(12)?;
		let tex = i16::from_le_bytes(c.take(2)?.try_into().unwrap());
		c.u32()?;
		let mat = c.i32()?;
		if mat == -1 {
			c.asciiz()?;
		}
		let k = c.u32()? as usize;
		c.skip(4 * k + 4)?;
		sections.push((lo, hi, tex, mat));
	}
	if sections.last().is_some_and(|s| s.1 != alloc) {
		return err("the sections do not end at the allocation size");
	}
	// Faces of proxy selections (`proxy:...`): triangles that only mark where the game puts another model. The game does not draw them.
	let mut proxy = std::collections::HashSet::new();
	for _ in 0..c.u32()? {
		// Named selection: name, faces, value, sectional flag, sections, vertices, weights.
		let name = c.asciiz()?;
		let (_, sel) = c.compressed(4, None)?;
		if name.to_ascii_lowercase().starts_with("proxy:") {
			proxy.extend(sel.chunks_exact(4).map(|x| u32::from_le_bytes(x.try_into().unwrap()) as usize));
		}
		c.i32()?;
		c.u8()?;
		c.compressed(4, None)?;
		c.compressed(4, None)?;
		c.compressed(1, None)?;
	}
	let mut properties = Vec::new();
	for _ in 0..c.u32()? {
		properties.push((c.asciiz()?, c.asciiz()?));
	}
	for _ in 0..c.u32()? {
		c.f32()?;
		let k = c.u32()? as usize;
		c.skip(12 * k)?;
	}
	// Colors, special flags, simple bone flag, size of the rest.
	c.skip(13)?;
	let rest = c.u32()? as usize;
	if c.i + rest + 1 != end {
		return err("the size of the vertex data does not agree with the LOD end");
	}
	let (_, clip, clip_fill) = c.condensed(4)?;
	let (uv_min, (nu, uv, uv_fill)) = ([c.f32()?, c.f32()?, c.f32()?, c.f32()?], c.condensed(4)?);
	let mut set1 = None;
	for k in 1..c.u32()? {
		let range = [c.f32()?, c.f32()?, c.f32()?, c.f32()?];
		let (n, d, fill) = c.condensed(4)?;
		if k == 1 && n == vertices {
			set1 = Some((range, d, fill));
		}
	}
	let (np, pos) = c.compressed(12, None)?;
	let (nn, nrm, nrm_fill) = c.condensed(4)?;
	if np != vertices || nn != vertices || nu != vertices {
		return err("vertex, normal, and UV counts do not agree");
	}
	let f = |d: &[u8], i: usize| f32::from_le_bytes(d[i..i + 4].try_into().unwrap());
	let at = |i: usize, fill: bool| if fill { 0 } else { i * 4 };
	// UV: two signed 16-bit values, scaled to the stored range.
	let uv_at = |r: &[f32; 4], d: &[u8], fill: bool, i: usize| {
		let p = at(i, fill);
		let q = |k: usize, lo: f32, hi: f32| lo + (i16::from_le_bytes([d[p + k], d[p + k + 1]]) as f32 + 32767.0) / 65534.0 * (hi - lo);
		[q(0, r[0], r[2]), q(2, r[1], r[3])]
	};
	let mut m = Mesh::default();
	for i in 0..vertices {
		m.positions.push([f(&pos, i * 12), f(&pos, i * 12 + 4), f(&pos, i * 12 + 8)]);
		// Normal: three signed 10-bit values with the scale -1/511. ODOL stores the faces and the normals in the opposite
		// direction to MLOD. Verified visually with FuelStation_02_workshop_F (closed walls with back faces hidden).
		let v = u32::from_le_bytes(nrm[at(i, nrm_fill)..][..4].try_into().unwrap());
		let s = |x: u32| {
			let x = (x & 0x3FF) as i32;
			(if x > 511 { x - 1024 } else { x }) as f32 / -511.0
		};
		m.normals.push([s(v), s(v >> 10), s(v >> 20)]);
		m.uvs.push(uv_at(&uv_min, &uv, uv_fill, i));
		m.clip.push(u32::from_le_bytes(clip[at(i, clip_fill)..][..4].try_into().unwrap()));
		if let Some((r, d, fill)) = &set1 {
			m.uv1.push(uv_at(r, d, *fill, i));
		}
	}
	for (fi, (off, idx)) in faces.into_iter().enumerate() {
		if proxy.contains(&fi) || sections.iter().position(|s| s.0 <= off && off < s.1).is_some_and(|k| proxy_sections.contains(&k)) {
			continue;
		}
		let (t, mat) = sections.iter().find(|s| s.0 <= off && off < s.1).map_or((-1, -1), |s| (s.2 as i32, s.3));
		let name = |list: &Vec<String>, i: i32| if i >= 0 { list.get(i as usize).cloned().unwrap_or_default() } else { String::new() };
		let gi = m.group(&name(&textures, t), &name(&materials, mat));
		// Reverse the corner order, so that the mesh uses the MLOD order.
		let tris: &[usize] = if idx.len() == 4 { &[0, 2, 1, 0, 3, 2] } else { &[0, 2, 1] };
		m.groups[gi].indices.extend(tris.iter().map(|&k| idx[k]));
	}
	m.properties = properties;
	m.proxies = proxies;
	m.bounds();
	Ok(m)
}
