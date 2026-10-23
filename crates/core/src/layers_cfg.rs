//! Reader for layers.cfg: the layer list and the palette colors of the source mask.
use crate::cfg;

#[derive(Debug, Clone)]
pub struct Layer {
	pub name: String,
	pub material: String,
}

#[derive(Debug, Clone)]
pub struct LayersCfg {
	/// The layers in the order of `class Layers`. The index is the layer number (L00, L01, ...).
	pub layers: Vec<Layer>,
	/// Palette color and layer number for each color in `class Legend`, `class Colors`.
	pub palette: Vec<([u8; 3], u8)>,
	pub warnings: Vec<String>,
}

pub fn parse(text: &str) -> Result<LayersCfg, String> {
	let root = cfg::parse(text)?;
	let layers: Vec<Layer> = root
		.class("Layers")
		.ok_or("layers.cfg: class Layers is missing")?
		.classes()
		.map(|c| Layer {
			name: c.name.clone(),
			material: c.str("material").unwrap_or("").to_string(),
		})
		.collect();
	if layers.len() > 255 {
		return Err("layers.cfg: more than 255 layers".into());
	}
	let colors = root.class("Legend").and_then(|l| l.class("Colors")).ok_or("layers.cfg: class Legend, class Colors is missing")?;
	let mut palette = Vec::new();
	let mut warnings = Vec::new();
	for (name, e) in &colors.entries {
		let cfg::Entry::Value(cfg::Value::Array(list)) = e else { continue };
		let Some(idx) = layers.iter().position(|l| l.name.eq_ignore_ascii_case(name)) else {
			warnings.push(format!("color entry '{name}' has no layer in class Layers"));
			continue;
		};
		for c in list {
			match c {
				cfg::Value::Array(v) if v.len() >= 3 => {
					let n: Vec<u8> = v.iter().take(3).map(|x| if let cfg::Value::Num(n) = x { *n as u8 } else { 0 }).collect();
					palette.push(([n[0], n[1], n[2]], idx as u8));
				}
				_ => warnings.push(format!("color entry '{name}' has a bad color value")),
			}
		}
	}
	for (i, l) in layers.iter().enumerate() {
		if !palette.iter().any(|p| p.1 as usize == i) {
			warnings.push(format!("layer '{}' has no color in class Legend", l.name));
		}
	}
	if palette.is_empty() {
		return Err("layers.cfg: no usable palette colors".into());
	}
	Ok(LayersCfg { layers, palette, warnings })
}

impl LayersCfg {
	/// Return the layer of the nearest palette color (squared RGB distance).
	pub fn nearest(&self, c: [u8; 3]) -> u8 {
		self.palette[self.nearest_entry(c)].1
	}
	/// Return the index in `palette` of the nearest color (squared RGB distance). The first entry wins when two are equal.
	pub fn nearest_entry(&self, c: [u8; 3]) -> usize {
		let d = |p: &[u8; 3]| (0..3).map(|i| (p[i] as i32 - c[i] as i32).pow(2)).sum::<i32>();
		(0..self.palette.len()).min_by_key(|&i| d(&self.palette[i].0)).unwrap()
	}
}

#[cfg(test)]
mod tests {
	#[test]
	fn reads_layers_and_warns_on_unknown_names() {
		let t = "class Layers {\n\tclass GdtGrass { texture = \"\"; material = \"a\\grass.rvmat\"; };\n\tclass GdtEnsoil { texture = \"\"; material = \"a\\soil.rvmat\"; };\n};\nclass Legend {\n\tpicture = \"x.png\";\n\tclass Colors {\n\t\tGdtGrass[] = {{55, 51, 38}};\n\t\tGdtSoil[] = {{1, 2, 3}};\n\t};\n};\n";
		let l = super::parse(t).unwrap();
		assert_eq!(l.layers.len(), 2);
		assert_eq!(l.layers[1].material, "a\\soil.rvmat");
		assert_eq!(l.palette, vec![([55, 51, 38], 0)]);
		assert_eq!(l.warnings.len(), 2);
		assert_eq!(l.nearest([50, 50, 40]), 0);
	}
}
