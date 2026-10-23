//! RoadsLib.cfg: the road types of the roads shapefile. Class `Road0001` is the road type of a line with ID = 1.
//! `width` is the full width of the road texture in meters. `mainStrTex` is the texture of the straight parts, `mainTerTex` of the ends.
use crate::cfg;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoadType {
	pub id: u32,
	pub width: f64,
	pub texture: String,
	pub end_texture: String,
	pub material: String,
	pub map: String,
	/// RGBA from 0 to 1, when the class has `color[]`.
	pub color: Option<[f64; 4]>,
}

/// Read the road types. Classes that are not `Road<number>`, or without a width, are reported in the warnings.
pub fn parse(text: &str) -> Result<(Vec<RoadType>, Vec<String>), String> {
	let root = cfg::parse(text)?;
	let lib = root.class("RoadTypesLibrary").ok_or("RoadsLib.cfg: class RoadTypesLibrary is missing")?;
	let (mut out, mut warnings) = (Vec::new(), Vec::new());
	for c in lib.classes() {
		let id = c.name.get(..4).filter(|p| p.eq_ignore_ascii_case("road")).and_then(|_| c.name[4..].parse::<u32>().ok());
		let width = c.nums("width").and_then(|v| v.first().copied()).filter(|w| w.is_finite() && *w > 0.0);
		let (Some(id), Some(width)) = (id, width) else {
			warnings.push(format!("class {} has no road number or no width", c.name));
			continue;
		};
		let s = |k: &str| c.str(k).unwrap_or("").to_string();
		let color = c.nums("color").filter(|v| v.len() >= 3).map(|v| [v[0], v[1], v[2], v.get(3).copied().unwrap_or(1.0)]);
		out.push(RoadType {
			id,
			width,
			texture: s("mainStrTex"),
			end_texture: s("mainTerTex"),
			material: s("mainMat"),
			map: s("map"),
			color,
		});
	}
	Ok((out, warnings))
}

#[cfg(test)]
mod tests {
	#[test]
	fn reads_the_bro_laguna_sample() {
		let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/roads/RoadsLib.cfg");
		let Ok(text) = std::fs::read_to_string(&p) else {
			eprintln!("SKIPPED: {} is missing", p.display());
			return;
		};
		let (r, w) = super::parse(&text).unwrap();
		assert!(w.is_empty(), "{w:?}");
		assert_eq!(r.len(), 10);
		assert_eq!(
			(r[0].id, r[0].width, r[0].texture.as_str(), r[0].color),
			(1, 20.0, "bromine\\bro_laguna\\cali_hwy_co.paa", Some([0.0, 0.5, 1.0, 1.0]))
		);
		assert_eq!((r[1].id, r[1].color, r[1].map.as_str()), (2, None, "track"));
		assert_eq!((r[8].id, r[8].width), (9, 1.6));
		assert_eq!(r[9].end_texture, "a3\\structures_f_exp\\data\\roads\\surf_exp_roadtarmac_main_road_end_ca.paa");
	}
}
