//! Read layer RVMAT files. Write the tile RVMAT files.
use crate::cfg;

/// The values of one layer RVMAT that the tile RVMAT needs.
#[derive(Debug, Clone, PartialEq)]
pub struct LayerMat {
	/// First value of `diffuse[]`.
	pub diffuse: f64,
	/// Texture repeat: the first value of `aside` of the `_co` stage.
	pub repeat: f64,
	pub nopx: String,
	pub co: String,
}

pub fn parse_layer(text: &str) -> Result<LayerMat, String> {
	let root = cfg::parse(text)?;
	let diffuse = root.nums("diffuse").and_then(|v| v.first().copied()).unwrap_or(1.0);
	let stages: Vec<&cfg::Class> = root.classes().filter(|c| c.name.to_ascii_lowercase().starts_with("stage")).collect();
	let tex = |c: &cfg::Class| c.str("texture").unwrap_or("").to_string();
	let find = |suffix: &str| stages.iter().find(|c| tex(c).to_ascii_lowercase().contains(suffix)).copied();
	let co = find("_co.").ok_or("layer RVMAT: no stage with a _co texture")?;
	let nopx = find("_nopx.").map(tex).unwrap_or_default();
	// The stage has its own uvTransform, or it points to a TexGen class with texGen.
	let uv = co.class("uvTransform").or_else(|| {
		let n = co.value("texGen").and_then(|v| if let cfg::Value::Num(n) = v { Some(*n as i64) } else { None })?;
		root.class(&format!("TexGen{n}"))?.class("uvTransform")
	});
	let repeat = uv.and_then(|u| u.nums("aside")).and_then(|a| a.first().copied()).unwrap_or(1.0);
	Ok(LayerMat { diffuse, repeat, nopx, co: tex(co) })
}

/// A model material: the pixel shader and the stages, for the viewer.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Material {
	pub pixel_shader: String,
	/// `renderFlags[]`, for example `NoZWrite` (glass and decals: blended, not cut out).
	pub render_flags: Vec<String>,
	pub stages: Vec<Stage>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stage {
	pub texture: String,
	/// `tex` (first UV set), `tex1` (second UV set), or another source.
	pub uv_source: String,
	/// uvTransform: u' = aside.x u + up.x v + pos.x, v' = aside.y u + up.y v + pos.y.
	pub aside: [f64; 3],
	pub up: [f64; 3],
	pub pos: [f64; 3],
}

/// Read a model RVMAT (text or binarized). Stage n is `class StageN`. Stage 0 is often not present.
/// The UV source and transform come from the TexGen class of the stage (`texGen = "n"`), or from the stage itself (old form).
pub fn read_material(b: &[u8]) -> Result<Material, String> {
	let root = cfg::parse_bytes(b)?;
	let v3 = |c: &cfg::Class, n: &str, d: [f64; 3]| c.nums(n).filter(|v| v.len() >= 3).map_or(d, |v| [v[0], v[1], v[2]]);
	let mut stages = Vec::new();
	for i in 0..32 {
		let Some(st) = root.class(&format!("Stage{i}")) else {
			stages.push(Stage {
				texture: String::new(),
				uv_source: "tex".into(),
				aside: [1.0, 0.0, 0.0],
				up: [0.0, 1.0, 0.0],
				pos: [0.0; 3],
			});
			continue;
		};
		let gen = match st.value("texGen") {
			Some(cfg::Value::Str(s)) => s.trim().parse::<i64>().ok(),
			Some(cfg::Value::Num(n)) => Some(*n as i64),
			_ => None,
		};
		let src = gen.and_then(|g| root.class(&format!("TexGen{g}"))).unwrap_or(st);
		let uv = src.class("uvTransform");
		stages.push(Stage {
			texture: st.str("texture").unwrap_or("").to_string(),
			uv_source: src.str("uvSource").unwrap_or("tex").to_ascii_lowercase(),
			aside: uv.map_or([1.0, 0.0, 0.0], |u| v3(u, "aside", [1.0, 0.0, 0.0])),
			up: uv.map_or([0.0, 1.0, 0.0], |u| v3(u, "up", [0.0, 1.0, 0.0])),
			pos: uv.map_or([0.0; 3], |u| v3(u, "pos", [0.0; 3])),
		});
	}
	while stages.last().is_some_and(|s| s.texture.is_empty()) {
		stages.pop();
	}
	Ok(Material {
		pixel_shader: root.str("PixelShaderID").unwrap_or("").to_string(),
		render_flags: match root.value("renderFlags") {
			Some(cfg::Value::Array(a)) => a.iter().filter_map(|v| if let cfg::Value::Str(s) = v { Some(s.clone()) } else { None }).collect(),
			_ => Vec::new(),
		},
		stages,
	})
}

/// Input for one tile RVMAT.
pub struct TileMat<'a> {
	pub sat: String,
	pub mask: String,
	/// aside, up, dir, pos of TexGen3 and TexGen4.
	pub uv: [[f64; 3]; 4],
	pub diffuse: f64,
	pub repeat: f64,
	/// One item for each slot of the tile. None is an empty slot (`N`).
	pub slots: Vec<Option<&'a LayerMat>>,
}

/// Write a tile RVMAT.
/// The layout and the number format are verified with the TB tile RVMAT files of bro_range and bro_msi. The line end is CRLF.
pub fn write_tile(t: &TileMat) -> String {
	let v = |a: &[f64; 3]| format!("{{{},{},{}}}", num(a[0]), num(a[1]), num(a[2]));
	let d = num(t.diffuse);
	let r = t.repeat;
	let mut s = format!("ambient[]={{1,1,1,1}};\ndiffuse[]={{{d},{d},{d},1}};\nforcedDiffuse[]={{0,0,0,0}};\nemmisive[]={{0,0,0,0}};\nspecular[]={{0,0,0,0}};\nspecularPower=0;\n");
	let tex_gen = |n: u32, src: &str, a: [f64; 3], u: [f64; 3], di: [f64; 3], p: [f64; 3]| {
		format!(
			"class TexGen{n}\n{{\n\tuvSource=\"{src}\";\n\tclass uvTransform\n\t{{\n\t\taside[]={};\n\t\tup[]={};\n\t\tdir[]={};\n\t\tpos[]={};\n\t}};\n}};\n",
			v(&a),
			v(&u),
			v(&di),
			v(&p)
		)
	};
	let stage = |n: usize, tex: &str, gen: u32| format!("class Stage{n}\n{{\n\ttexture=\"{tex}\";\n\ttexGen={gen};\n}};\n");
	s += &stage(0, &t.sat, 3);
	s += &stage(1, &t.mask, 4);
	s += &tex_gen(3, "worldPos", t.uv[0], t.uv[1], t.uv[2], t.uv[3]);
	s += &tex_gen(4, "worldPos", t.uv[0], t.uv[1], t.uv[2], t.uv[3]);
	s += &tex_gen(0, "tex", [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [0.0; 3]);
	s += &tex_gen(1, "tex", [r, 0.0, 0.0], [0.0, r, 0.0], [0.0; 3], [0.0; 3]);
	s += &tex_gen(2, "tex", [r, 0.0, 0.0], [0.0, r, 0.0], [0.0; 3], [0.0; 3]);
	s += "PixelShaderID=\"TerrainX\";\nVertexShaderID=\"Terrain\";\n";
	s += &stage(2, "#(rgb,1,1,1)color(0.5,0.5,0.5,1,cdt)", 0);
	for (i, slot) in t.slots.iter().enumerate() {
		s += &stage(3 + 2 * i, slot.map_or("", |m| &m.nopx), 1);
		s += &stage(4 + 2 * i, slot.map_or("", |m| &m.co), 2);
	}
	s.replace('\n', "\r\n")
}

/// Write a number as TB does: a 32-bit float with 8 significant digits, for example 0.7 becomes 0.69999999.
fn num(x: f64) -> String {
	let v: f64 = format!("{:.7e}", x as f32).parse().unwrap();
	if v == 0.0 {
		"0".into()
	} else {
		v.to_string()
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	#[test]
	fn reads_render_flags() {
		let m = read_material(b"renderFlags[] = {\"NoZWrite\"};\nPixelShaderID = \"Super\";\nclass Stage1 { texture = \"a_ca.paa\"; };").unwrap();
		assert_eq!((m.pixel_shader.as_str(), m.render_flags.clone()), ("Super", vec!["NoZWrite".to_string()]));
	}
	#[test]
	fn reads_layer_rvmat_with_stage_uv_and_texgen_uv() {
		let a = "diffuse[]={0.7,0.7,0.7,1};\nclass Stage1 { texture=\"x\\dirt_nopx.paa\"; uvSource=\"tex\"; class uvTransform { aside[]={10,0,0}; up[]={0,10,0}; dir[]={0,0,10}; pos[]={0,0,0}; }; };\nclass Stage2 { texture=\"x\\dirt_co.paa\"; uvSource=\"tex\"; class uvTransform { aside[]={10,0,0}; up[]={0,10,0}; dir[]={0,0,10}; pos[]={0,0,0}; }; };\n";
		assert_eq!(
			parse_layer(a).unwrap(),
			LayerMat {
				diffuse: 0.7,
				repeat: 10.0,
				nopx: "x\\dirt_nopx.paa".into(),
				co: "x\\dirt_co.paa".into()
			}
		);
		let b = "class TexGen2 { class uvTransform { aside[]={5,0,0}; }; };\nclass Stage2 { texture=\"y_co.paa\"; texGen=2; };\n";
		let m = parse_layer(b).unwrap();
		assert_eq!((m.diffuse, m.repeat, m.nopx.as_str()), (1.0, 5.0, ""));
	}
	#[test]
	fn tile_rvmat_has_stage_pairs_for_each_slot() {
		let m = LayerMat {
			diffuse: 1.0,
			repeat: 5.0,
			nopx: "n.paa".into(),
			co: "c.paa".into(),
		};
		let t = TileMat {
			sat: "s.png".into(),
			mask: "m.png".into(),
			uv: [[0.0009765625, 0.0, 0.0], [0.0, 0.0, 0.0009765625], [0.0, -0.0009765625, 0.0], [0.125, 1.125, 0.0]],
			diffuse: 1.0,
			repeat: 5.0,
			slots: vec![Some(&m), None],
		};
		let s = write_tile(&t);
		assert!(s.contains("pos[]={0.125,1.125,0};\r\n"));
		assert_eq!(num(0.7), "0.69999999");
		assert_eq!(num(-0.625), "-0.625");
		assert!(s.contains("dir[]={0,-0.0009765625,0};"));
		assert!(s.contains("class Stage4\r\n{\r\n\ttexture=\"c.paa\";"));
		assert!(s.contains("class Stage6\r\n{\r\n\ttexture=\"\";"));
		assert!(!s.contains("Stage7"));
		assert!(crate::cfg::parse(&s).is_ok());
	}
}
