//! Clutter of the ground layers, from the config.cpp of a map: CfgSurfaces (the surface of a ground texture by its file name),
//! CfgSurfaceCharacters (the clutter names and their probabilities), and the class Clutter of the world in CfgWorlds (model, scale).
use crate::cfg::{self, Class, Value};

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
	pub model: String,
	/// Probability in each clutter grid cell (the sum of a layer is 1 or less; the rest of the cells stay empty).
	pub probability: f64,
	pub scale_min: f64,
	pub scale_max: f64,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerClutter {
	/// The clutter of each layer (in the order of `co`), empty when the layer has no surface or no character.
	pub layers: Vec<Vec<Item>>,
	/// clutterGrid of the world (meters between clutter cells), when the config has it.
	pub grid: Option<f64>,
}

/// A surface `files` pattern: `gdt_strdirt*` matches every file name that starts with `gdt_strdirt`. Case does not matter.
fn matches(pattern: &str, file: &str) -> bool {
	let (p, f) = (pattern.to_ascii_lowercase(), file.to_ascii_lowercase());
	match p.strip_suffix('*') {
		Some(prefix) => f.starts_with(prefix),
		None => f == p || f.split('.').next() == Some(p.as_str()),
	}
}

fn strings(c: &Class, name: &str) -> Vec<String> {
	match c.value(name) {
		Some(Value::Array(a)) => a.iter().map(|v| if let Value::Str(s) = v { s.clone() } else { String::new() }).collect(),
		_ => Vec::new(),
	}
}

/// The clutter of each layer. `files` holds the file paths of each layer that a surface can match: the `_co` texture and the
/// RVMAT (empty paths are ignored).
pub fn layer_clutter(config_text: &str, files: &[Vec<String>]) -> Result<LayerClutter, String> {
	let root = cfg::parse(config_text)?;
	let none = Class::default();
	let surfaces = root.class("CfgSurfaces").unwrap_or(&none);
	let characters = root.class("CfgSurfaceCharacters").unwrap_or(&none);
	// The world that has a Clutter class (the map class in CfgWorlds).
	let world = root.class("CfgWorlds").and_then(|w| w.classes().filter(|c| c.class("Clutter").is_some_and(|k| k.classes().next().is_some())).last());
	let clutter = world.and_then(|w| w.class("Clutter")).unwrap_or(&none);
	let num = |c: &Class, k: &str, d: f64| c.nums(k).and_then(|v| v.first().copied()).filter(|v| v.is_finite()).unwrap_or(d);
	let layers = files
		.iter()
		.map(|paths| {
			let names: Vec<&str> = paths.iter().filter_map(|p| p.rsplit(['\\', '/']).next()).filter(|f| !f.is_empty()).collect();
			let Some(surface) = surfaces.classes().find(|s| s.str("files").is_some_and(|p| names.iter().any(|f| matches(p, f)))) else { return Vec::new() };
			let Some(ch) = surface.str("character").and_then(|n| characters.class(n)) else { return Vec::new() };
			let probs = ch.nums("probability").unwrap_or_default();
			strings(ch, "names")
				.iter()
				.zip(probs)
				.filter_map(|(name, p)| {
					let c = clutter.class(name)?;
					Some(Item {
						model: c.str("model")?.to_string(),
						probability: if p.is_finite() { p } else { 0.0 },
						scale_min: num(c, "scaleMin", 1.0),
						scale_max: num(c, "scaleMax", 1.0),
					})
				})
				.collect()
		})
		.collect();
	Ok(LayerClutter { layers, grid: world.and_then(|w| w.nums("clutterGrid")).and_then(|v| v.first().copied()) })
}

#[cfg(test)]
mod tests {
	use super::*;
	// The parts of the bro_laguna config.cpp that the clutter needs.
	const TEXT: &str = r#"
class CfgWorlds {
	class CAWorld { class DefaultClutter; };
	class Stratis: CAWorld { class Clutter; };
	class Bro_Laguna: Stratis {
		clutterGrid = 1.1;
		class Clutter {
			class StrGrassDry: DefaultClutter { model="A3\plants_f\Clutter\c_StrGrassDry.p3d"; scaleMin=0.8; scaleMax=1.2; };
			class ftpolk_lilrocks { model = "A3\vegetation_f_exp\clutter\cliff\c_rock_stones.p3d"; scaleMin = 0.7; scaleMax = 1.0; };
		};
	};
};
class CfgSurfaces {
	class Default {};
	class bro_dirt_Surface: Default { files="gdt_strdirt*"; character="bro_dirt_Character"; };
	class bro_asphalt_Surface: Default { files="gdt_enweatheredtarmac*"; character="bro_asphalt_Character"; };
};
class CfgSurfaceCharacters {
	class bro_dirt_Character { probability[] = {0.1, 0.05}; names[] = {"StrGrassDry", "Missing"}; };
	class bro_asphalt_Character { probability[] = {0.025}; names[] = {"ftpolk_lilrocks"}; };
};
"#;
	#[test]
	fn clutter_of_each_layer() {
		let files: Vec<Vec<String>> = [["a3\\map_data\\gdt_strdirt_co.paa", "x.rvmat"], ["x\\y_co.paa", "x\\gdt_EnWeatheredTarmac.rvmat"], ["x\\other_co.paa", ""], ["", ""]]
			.iter()
			.map(|l| l.iter().map(|s| s.to_string()).collect())
			.collect();
		let c = layer_clutter(TEXT, &files).unwrap();
		assert_eq!(c.grid, Some(1.1));
		assert_eq!(c.layers[0], vec![Item { model: "A3\\plants_f\\Clutter\\c_StrGrassDry.p3d".into(), probability: 0.1, scale_min: 0.8, scale_max: 1.2 }]);
		assert_eq!((c.layers[1].len(), c.layers[1][0].probability), (1, 0.025));
		assert!(c.layers[2].is_empty() && c.layers[3].is_empty());
	}
}
