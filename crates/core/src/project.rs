//! Project settings (mapframe). The file is JSON. Paths are relative to the folder of the file.
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
	pub terrain: Option<Terrain>,
	pub imagery: Imagery,
	pub tiles: Tiles,
	pub texture_layer_size_meters: f64,
	/// Prefix of the tile texture paths in the RVMAT, for example `bromine\bro_msi\data\layers\`.
	#[serde(default)]
	pub texture_path_prefix: String,
	pub layers_cfg: Option<PathBuf>,
	pub satellite: Option<PathBuf>,
	pub mask: Option<PathBuf>,
	/// The tool writes the tiles and RVMAT files here. Default: `layers`.
	pub output_dir: Option<PathBuf>,
	/// Folders where the tool looks for the layer RVMAT files, for example `P:\`.
	#[serde(default)]
	pub search_roots: Vec<PathBuf>,
	/// Values for the tile RVMAT. If they are not set, the tool uses the first layer RVMAT.
	pub diffuse: Option<f64>,
	pub repeat: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Terrain {
	pub grid_size: u32,
	pub cell_size: f64,
	pub size_meters: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Imagery {
	pub width: u32,
	pub height: u32,
	pub meters_per_pixel: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tiles {
	pub size: u32,
	pub overlap_px: u32,
	#[serde(default = "yes")]
	pub export_satellite: bool,
	#[serde(default = "yes")]
	pub export_mask: bool,
}

fn yes() -> bool {
	true
}

impl Project {
	/// Read the project file. Make the relative paths absolute.
	pub fn load(path: &Path) -> Result<Project, String> {
		let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
		let mut p: Project = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
		let dir = path.parent().unwrap_or(Path::new("."));
		for f in [&mut p.layers_cfg, &mut p.satellite, &mut p.mask, &mut p.output_dir] {
			if let Some(x) = f {
				*x = dir.join(&*x);
			}
		}
		p.search_roots = p.search_roots.iter().map(|r| dir.join(r)).collect();
		Ok(p)
	}
}
