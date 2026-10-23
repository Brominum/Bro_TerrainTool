//! Tauri shell of Terrain Tool. The commands read files with the core library and send binary data to the UI.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::ipc::Response;
use tauri::State;
use terrain_core::height::{self, Heights};
use terrain_core::mask::{Brush, Mask, Paint, Rect};
use terrain_core::sat::{self, Sat};
use terrain_core::tilestore::{polyline, write_atomic};
use terrain_core::{alb, asc, fill, game, layers_cfg, objdb, p3d, paa, roads, rvmat, shp, ter, tiles, wrp};

/// The object database of the open session.
#[derive(Default)]
struct Models(Mutex<objdb::Db>);

/// The heights of the open terrain: the height editor, the object fill, and the ASC export use them.
#[derive(Default)]
struct TerrainState(Arc<Mutex<Option<Heights>>>, Mutex<Option<height::Stamp>>);

/// Version of each image (mask, satellite, heights) at the last save into each project folder.
#[derive(Default)]
struct Saved(Mutex<HashMap<(&'static str, PathBuf), u64>>);

/// The layer mask of the mask painter.
#[derive(Default)]
struct MaskState(Arc<Mutex<Option<Mask>>>);

/// The satellite image of the satellite painter.
#[derive(Default)]
struct SatState(Arc<Mutex<Option<Sat>>>);

/// The mask and the satellite image must have the same size.
fn same_size(what: &str, w: u32, h: u32, other: &str, size: Option<(u32, u32)>) -> Result<(), String> {
	match size {
		Some((ow, oh)) if (ow, oh) != (w, h) => Err(format!("the {what} is {w} x {h} px, but the open {other} is {ow} x {oh} px. They must have the same size.")),
		_ => Ok(()),
	}
}

/// Run a job with the open mask on a worker thread.
async fn with_mask<T: Send + 'static>(s: &MaskState, f: impl FnOnce(&mut Mask) -> Result<T, String> + Send + 'static) -> Result<T, String> {
	let m = s.0.clone();
	tauri::async_runtime::spawn_blocking(move || f(m.lock().unwrap().as_mut().ok_or("no mask is open")?))
		.await
		.map_err(|e| e.to_string())?
}

/// Palette index, or -1 for erase.
fn paint(color: i32) -> Paint {
	if color < 0 {
		Paint::Erase
	} else {
		Paint::Color(color as u8)
	}
}

#[derive(serde::Serialize)]
struct MaskInfo {
	width: u32,
	height: u32,
	/// Palette colors. A pixel value is an index in this list.
	colors: Vec<[u8; 3]>,
	/// Layer name of each palette color.
	names: Vec<String>,
	/// Pixels that are not an exact palette color. They got the nearest color.
	inexact: u64,
	warnings: Vec<String>,
}

/// Read layers.cfg and the source mask (PNG or BMP). The mask replaces the open mask.
#[tauri::command]
async fn mask_open(path: String, layers_cfg: String, state: State<'_, MaskState>, sat: State<'_, SatState>) -> Result<MaskInfo, String> {
	let (m, s) = (state.0.clone(), sat.0.clone());
	tauri::async_runtime::spawn_blocking(move || {
		let cfg = layers_cfg::parse(&std::fs::read_to_string(&layers_cfg).map_err(|e| format!("{layers_cfg}: {e}"))?).map_err(|e| format!("{layers_cfg}: {e}"))?;
		// Free the old mask first. A large mask uses much memory.
		*m.lock().unwrap() = None;
		let (mask, inexact) = Mask::import(std::path::Path::new(&path), &cfg)?;
		same_size("mask", mask.width, mask.height, "satellite image", s.lock().unwrap().as_ref().map(|s| (s.width, s.height)))?;
		let info = MaskInfo {
			width: mask.width,
			height: mask.height,
			colors: mask.colors.clone(),
			names: cfg.palette.iter().map(|p| cfg.layers[p.1 as usize].name.clone()).collect(),
			inexact,
			warnings: cfg.warnings,
		};
		*m.lock().unwrap() = Some(mask);
		Ok(info)
	})
	.await
	.map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
struct LayerDetail {
	/// The `_co` texture of each layer (game path), empty when the layer RVMAT is not in the model folders.
	co: Vec<String>,
	/// The layer of each palette color (the mask pixel value).
	palette: Vec<u8>,
	/// Diffuse and texture repeat of the first layer: the tile RVMAT files of the game export use them for all layers.
	diffuse: f64,
	repeat: f64,
	/// Layers whose RVMAT did not load, with the reason.
	missing: Vec<String>,
}

/// The ground detail textures of layers.cfg for the 3D view. The layer RVMAT files are found in the model folders.
#[tauri::command]
async fn layer_detail(layers_cfg: String, models: State<'_, Models>) -> Result<LayerDetail, String> {
	let cfg = layers_cfg::parse(&std::fs::read_to_string(&layers_cfg).map_err(|e| format!("{layers_cfg}: {e}"))?).map_err(|e| format!("{layers_cfg}: {e}"))?;
	let db = models.0.lock().unwrap();
	let mut missing = Vec::new();
	let mats: Vec<Option<rvmat::LayerMat>> = cfg
		.layers
		.iter()
		.map(|l| {
			let r = db.file(&l.material).ok_or("not in the model folders".to_string()).and_then(|p| std::fs::read_to_string(p).map_err(|e| e.to_string())).and_then(|t| rvmat::parse_layer(&t));
			r.map_err(|e| missing.push(format!("{}: {} ({e})", l.name, l.material))).ok()
		})
		.collect();
	let first = mats.first().cloned().flatten();
	Ok(LayerDetail {
		co: mats.iter().map(|m| m.as_ref().map_or(String::new(), |m| m.co.clone())).collect(),
		palette: cfg.palette.iter().map(|p| p.1).collect(),
		diffuse: first.as_ref().map_or(1.0, |m| m.diffuse),
		repeat: first.as_ref().map_or(5.0, |m| m.repeat),
		missing,
	})
}

/// Binary result: w x h palette indices, row by row. 255 is outside the image. See `Mask::region`.
#[tauri::command]
async fn mask_region(level: u32, x: u32, y: u32, w: u32, h: u32, state: State<'_, MaskState>) -> Result<Response, String> {
	with_mask(&state, move |m| Ok(Response::new(m.region(level, x, y, w, h)))).await
}

/// Paint lines of dabs through the points. The result is the changed area or null.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn mask_paint(points: Vec<[f64; 2]>, radius: f64, hardness: f64, opacity: f64, color: i32, seed: u32, state: State<'_, MaskState>) -> Result<Option<Rect>, String> {
	let b = Brush {
		radius,
		hardness,
		opacity,
		paint: paint(color),
	};
	with_mask(&state, move |m| Ok(polyline(&points, |a, z| m.line(a, z, &b, seed)))).await
}

/// End the brush stroke. The stroke is one undo step.
#[tauri::command]
async fn mask_end_stroke(state: State<'_, MaskState>) -> Result<(), String> {
	with_mask(&state, |m| Ok(m.end_step())).await
}

#[tauri::command]
async fn mask_fill(x: u32, y: u32, color: i32, state: State<'_, MaskState>) -> Result<Option<Rect>, String> {
	with_mask(&state, move |m| Ok(m.fill(x, y, paint(color)))).await
}

#[tauri::command]
async fn mask_polygon(points: Vec<[f64; 2]>, color: i32, state: State<'_, MaskState>) -> Result<Option<Rect>, String> {
	with_mask(&state, move |m| Ok(m.polygon(&points, paint(color)))).await
}

#[tauri::command]
async fn mask_undo(redo: bool, state: State<'_, MaskState>) -> Result<Option<Rect>, String> {
	with_mask(&state, move |m| Ok(if redo { m.redo() } else { m.undo() })).await
}

/// Run a job with the open mask and the open terrain on a worker thread.
/// With a polygon (local meters), the area is the polygon, not the mask colors: the fill uses a mask with 1 inside the polygon,
/// with the size of the open mask, or 1 m pixels without a mask.
// Cancel flag of the long jobs (fill, export for the game, model scan).
// shortcut: one flag for all jobs, so Cancel stops each job that runs. Use one flag for each job if jobs run at the same time.
static CANCEL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Progress of a long job: sends the event `progress` (0 to 1, at most 10 times a second) and returns false after a cancel.
fn reporter(app: &tauri::AppHandle) -> impl FnMut(f64) -> bool + Send + 'static {
	use tauri::Emitter;
	CANCEL.store(false, std::sync::atomic::Ordering::Relaxed);
	let app = app.clone();
	let mut last: Option<std::time::Instant> = None;
	move |v| {
		if last.map_or(true, |t| t.elapsed().as_millis() >= 100) {
			let _ = app.emit("progress", v);
			last = Some(std::time::Instant::now());
		}
		!CANCEL.load(std::sync::atomic::Ordering::Relaxed)
	}
}

/// The end of a long job (also after an error): the UI hides the progress bar.
fn job_done(app: &tauri::AppHandle) {
	use tauri::Emitter;
	let _ = app.emit("progress", 1.0);
}

/// Close the open map: the heights, the stamp, the mask, the satellite image, and the save versions. The model folders stay.
/// The window loads the UI again after this ("New map": as a new start).
#[tauri::command]
fn reset_state(terrain: State<'_, TerrainState>, mask: State<'_, MaskState>, sat: State<'_, SatState>, saved: State<'_, Saved>) {
	*terrain.0.lock().unwrap() = None;
	*terrain.1.lock().unwrap() = None;
	*mask.0.lock().unwrap() = None;
	*sat.0.lock().unwrap() = None;
	saved.0.lock().unwrap().clear();
}

/// True when the folder exists (for example the work drive P:\).
#[tauri::command]
fn dir_exists(path: String) -> bool {
	Path::new(&path).is_dir()
}

/// Cancel the long job that runs.
#[tauri::command]
fn cancel_job() {
	CANCEL.store(true, std::sync::atomic::Ordering::Relaxed);
}

async fn with_fill<T: Send + 'static>(mask: &MaskState, terrain: &TerrainState, polygon: Option<Vec<[f64; 2]>>, f: impl FnOnce(&Mask, &Heights) -> Result<T, String> + Send + 'static) -> Result<T, String> {
	let (m, t) = (mask.0.clone(), terrain.0.clone());
	tauri::async_runtime::spawn_blocking(move || {
		let m = m.lock().unwrap();
		let t = t.lock().unwrap();
		let t = t.as_ref().ok_or("open a heightmap (ASC, WRP, or TB project) first")?;
		let Some(ring) = polygon else { return f(m.as_ref().ok_or("open a mask in the mask view first")?, t) };
		let (sx, sy) = (t.ncols as f64 * t.cellsize, t.nrows as f64 * t.cellsize);
		let (w, h) = m.as_ref().map_or((sx.round() as u32, sy.round() as u32), |m| (m.width, m.height));
		let px: Vec<[f64; 2]> = ring.iter().map(|p| [p[0] / (sx / w as f64), (sy - p[1]) / (sy / h as f64)]).collect();
		f(&Mask::polygon_mask(w, h, &[px]), t)
	})
	.await
	.map_err(|e| e.to_string())?
}

/// Expected object count of a fill before the rules.
#[tauri::command]
async fn fill_estimate(settings: fill::Settings, polygon: Option<Vec<[f64; 2]>>, mask: State<'_, MaskState>, terrain: State<'_, TerrainState>) -> Result<f64, String> {
	let mut settings = settings;
	if polygon.is_some() {
		settings.colors = vec![1];
	}
	with_fill(&mask, &terrain, polygon, move |m, t| Ok(fill::estimate(m, t, &settings))).await
}

/// Binary result: object count u32, truncated u32 (1 when the fill stopped at the limit),
/// then for each object x, y, yaw, pitch, roll, scale (f32) and the recipe entry (u32).
#[tauri::command]
async fn fill_run(app: tauri::AppHandle, settings: fill::Settings, limit: usize, polygon: Option<Vec<[f64; 2]>>, mask: State<'_, MaskState>, terrain: State<'_, TerrainState>) -> Result<Response, String> {
	let mut settings = settings;
	if polygon.is_some() {
		settings.colors = vec![1];
	}
	let mut p = reporter(&app);
	let r = with_fill(&mask, &terrain, polygon, move |m, t| {
		let r = fill::run_with(m, t, &settings, limit, &mut p)?;
		let mut b = Vec::with_capacity(8 + r.objects.len() * 28);
		b.extend((r.objects.len() as u32).to_le_bytes());
		b.extend((r.truncated as u32).to_le_bytes());
		for o in &r.objects {
			for v in [o.x, o.y, o.yaw, o.pitch, o.roll, o.scale] {
				b.extend(v.to_le_bytes());
			}
			b.extend(o.entry.to_le_bytes());
		}
		Ok(Response::new(b))
	})
	.await;
	job_done(&app);
	r
}

/// Write the mask as one RGB PNG with the palette colors.
#[tauri::command]
async fn mask_export(path: String, state: State<'_, MaskState>) -> Result<(), String> {
	with_mask(&state, move |m| m.export_png(std::path::Path::new(&path))).await
}

/// Run a job with the open satellite image on a worker thread.
async fn with_sat<T: Send + 'static>(s: &SatState, f: impl FnOnce(&mut Sat) -> Result<T, String> + Send + 'static) -> Result<T, String> {
	let m = s.0.clone();
	tauri::async_runtime::spawn_blocking(move || f(m.lock().unwrap().as_mut().ok_or("no satellite image is open")?))
		.await
		.map_err(|e| e.to_string())?
}

/// Read the satellite image (PNG or BMP). It replaces the open image. The result is the width and the height.
#[tauri::command]
async fn sat_open(path: String, state: State<'_, SatState>, mask: State<'_, MaskState>) -> Result<(u32, u32), String> {
	let (s, m) = (state.0.clone(), mask.0.clone());
	tauri::async_runtime::spawn_blocking(move || {
		// Free the old image first. A large image uses much memory.
		*s.lock().unwrap() = None;
		let img = Sat::import(std::path::Path::new(&path))?;
		same_size("satellite image", img.width, img.height, "mask", m.lock().unwrap().as_ref().map(|m| (m.width, m.height)))?;
		let size = (img.width, img.height);
		*s.lock().unwrap() = Some(img);
		Ok(size)
	})
	.await
	.map_err(|e| e.to_string())?
}

/// Binary result: w x h RGBA pixels at a level of the mip pyramid. Alpha 0 is outside the image. See `Sat::region`.
#[tauri::command]
async fn sat_region(level: u32, x: u32, y: u32, w: u32, h: u32, state: State<'_, SatState>) -> Result<Response, String> {
	with_sat(&state, move |s| Ok(Response::new(s.region(level, x, y, w, h)))).await
}

/// Paint lines of dabs through the points. Tool: "color" (uses color), "clone" (uses offset, source minus destination), "smooth", or "texture".
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn sat_paint(points: Vec<[f64; 2]>, radius: f64, hardness: f64, opacity: f64, tool: String, color: [u8; 3], offset: [f64; 2], state: State<'_, SatState>) -> Result<Option<Rect>, String> {
	let tool = match tool.as_str() {
		"color" => sat::Tool::Color(color),
		"clone" => sat::Tool::Clone(offset),
		"smooth" => sat::Tool::Smooth,
		"texture" => sat::Tool::Texture,
		t => return Err(format!("unknown satellite tool {t}")),
	};
	let b = sat::Brush { radius, hardness, opacity, tool };
	with_sat(&state, move |s| Ok(polyline(&points, |a, z| s.line(a, z, &b)))).await
}

#[tauri::command]
async fn sat_end_stroke(state: State<'_, SatState>) -> Result<(), String> {
	with_sat(&state, |s| Ok(s.end_step())).await
}

#[tauri::command]
async fn sat_undo(redo: bool, state: State<'_, SatState>) -> Result<Option<Rect>, String> {
	with_sat(&state, move |s| Ok(if redo { s.redo() } else { s.undo() })).await
}

/// The color of one pixel.
#[tauri::command]
async fn sat_pick(x: u32, y: u32, state: State<'_, SatState>) -> Result<[u8; 3], String> {
	with_sat(&state, move |s| if x < s.width && y < s.height { Ok(s.get(x, y)) } else { Err("the point is outside the image".into()) }).await
}

/// Load the texture of the texture brush (PNG, BMP, or PAA). One repeat covers size x size pixels. The result is the texture size.
#[tauri::command]
async fn sat_texture(path: String, size: usize, state: State<'_, SatState>) -> Result<(usize, usize), String> {
	with_sat(&state, move |s| {
		let t = sat::Texture::load(std::path::Path::new(&path))?;
		s.set_texture(&t, size);
		Ok((t.width, t.height))
	})
	.await
}

/// Write the satellite image as one 8-bit RGB PNG.
#[tauri::command]
async fn sat_export(path: String, state: State<'_, SatState>) -> Result<(), String> {
	with_sat(&state, move |s| s.export_png(std::path::Path::new(&path))).await
}

/// Run a job with the open heights on a worker thread.
async fn with_heights<T: Send + 'static>(t: &TerrainState, f: impl FnOnce(&mut Heights) -> Result<T, String> + Send + 'static) -> Result<T, String> {
	let h = t.0.clone();
	tauri::async_runtime::spawn_blocking(move || f(h.lock().unwrap().as_mut().ok_or("open a heightmap first")?))
		.await
		.map_err(|e| e.to_string())?
}

/// Paint lines of dabs through the points (local meters). Tool: "raise", "lower", "smooth", "flatten" (to `value`),
/// "plane" (through `plane`: x, y, height of two points), or "noise" (size `value` in meters). The result is the changed area in cells.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn height_paint(points: Vec<[f64; 2]>, radius: f64, hardness: f64, strength: f64, tool: String, value: f64, plane: [f64; 6], seed: u32, state: State<'_, TerrainState>) -> Result<Option<Rect>, String> {
	let tool = match tool.as_str() {
		"raise" => height::Tool::Raise,
		"lower" => height::Tool::Lower,
		"smooth" => height::Tool::Smooth,
		"flatten" => height::Tool::Flatten(value as f32),
		"plane" => height::Tool::Plane([plane[0], plane[1], plane[2]], [plane[3], plane[4], plane[5]]),
		"noise" => height::Tool::Noise(value, seed),
		t => return Err(format!("unknown height tool {t}")),
	};
	let b = height::Brush { radius, hardness, strength, tool };
	with_heights(&state, move |h| Ok(polyline(&points, |a, z| h.line(a, z, &b)))).await
}

#[tauri::command]
async fn height_end_stroke(state: State<'_, TerrainState>) -> Result<(), String> {
	with_heights(&state, |h| Ok(h.end_step())).await
}

#[tauri::command]
async fn height_undo(redo: bool, state: State<'_, TerrainState>) -> Result<Option<Rect>, String> {
	with_heights(&state, move |h| Ok(if redo { h.redo() } else { h.undo() })).await
}

/// Binary result: the heights of a rectangle of cells (f32, row by row, row 0 is the north row).
#[tauri::command]
async fn height_region(c0: usize, r0: usize, w: usize, h: usize, state: State<'_, TerrainState>) -> Result<Response, String> {
	with_heights(&state, move |t| Ok(Response::new(t.region(c0, r0, w, h).iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>()))).await
}

/// Height at local meters.
#[tauri::command]
async fn height_pick(x: f64, y: f64, state: State<'_, TerrainState>) -> Result<f64, String> {
	with_heights(&state, move |h| Ok(h.at(x, y))).await
}

/// Load the image of the stamp tool (PNG or BMP). The result is its size.
#[tauri::command]
async fn height_stamp_load(path: String, state: State<'_, TerrainState>) -> Result<(usize, usize), String> {
	let s = height::Stamp::load(Path::new(&path))?;
	let size = (s.width, s.height);
	*state.1.lock().unwrap() = Some(s);
	Ok(size)
}

/// Put the stamp at local meters (see `Heights::stamp`).
#[tauri::command]
async fn height_stamp(x: f64, y: f64, size: f64, height: f64, max: bool, state: State<'_, TerrainState>) -> Result<Option<Rect>, String> {
	let stamp = state.1.lock().unwrap().take().ok_or("load a stamp image first")?;
	let h = state.0.clone();
	let (r, stamp) = tauri::async_runtime::spawn_blocking(move || {
		let mut g = h.lock().unwrap();
		let t = g.as_mut().ok_or("open a heightmap first")?;
		let base = t.at(x, y);
		Ok::<_, String>((t.stamp(x, y, &stamp, size, height, max, base), stamp))
	})
	.await
	.map_err(|e| e.to_string())??;
	*state.1.lock().unwrap() = Some(stamp);
	Ok(r)
}

/// Write the heights as an ASC. Rows without a change keep their text. `decimals` null: as in the source.
#[tauri::command]
async fn height_export(path: String, decimals: Option<usize>, state: State<'_, TerrainState>) -> Result<(), String> {
	with_heights(&state, move |h| h.export_asc(Path::new(&path), decimals)).await
}

/// Paint a band along a line (mask pixels): full inside `half` pixels, dithered across `feather`. Color -1 is erase.
#[tauri::command]
async fn mask_band(points: Vec<[f64; 2]>, half: f64, feather: f64, color: i32, seed: u32, state: State<'_, MaskState>) -> Result<Option<Rect>, String> {
	with_mask(&state, move |m| Ok(m.band(&points, half, feather, paint(color), seed))).await
}

/// Flatten inside a polygon (local meters) to a height (null: the mean inside), with a feather outside.
#[tauri::command]
async fn height_flatten_polygon(points: Vec<[f64; 2]>, target: Option<f64>, feather: f64, state: State<'_, TerrainState>) -> Result<Option<Rect>, String> {
	with_heights(&state, move |h| Ok(h.flatten_polygon(&points, target, feather))).await
}

/// Raise (or lower, with a negative value) all heights by `dh` meters.
#[tauri::command]
async fn height_offset(dh: f32, state: State<'_, TerrainState>) -> Result<Option<Rect>, String> {
	with_heights(&state, move |h| Ok(h.offset(dh))).await
}

/// Cut or fill along a line (local meters): road or runway.
#[tauri::command]
async fn height_road(points: Vec<[f64; 2]>, width: f64, feather: f64, smooth: f64, state: State<'_, TerrainState>) -> Result<Option<Rect>, String> {
	with_heights(&state, move |h| Ok(h.road(&points, width, feather, smooth))).await
}

/// Write a shapefile set (SHP, SHX, DBF, CPG). The coordinates are as the UI gives them (TB coordinates).
#[tauri::command]
async fn shp_write(path: String, kind: shp::Kind, shapes: Vec<shp::Shape>) -> Result<(), String> {
	tauri::async_runtime::spawn_blocking(move || shp::write(Path::new(&path), kind, &shapes)).await.map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
struct ShpFile {
	kind: shp::Kind,
	shapes: Vec<shp::Shape>,
}

/// Read a shapefile and its DBF.
#[tauri::command]
async fn shp_read(path: String) -> Result<ShpFile, String> {
	tauri::async_runtime::spawn_blocking(move || shp::read(Path::new(&path)).map(|(kind, shapes)| ShpFile { kind, shapes }))
		.await
		.map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
struct RoadsLib {
	types: Vec<roads::RoadType>,
	warnings: Vec<String>,
}

/// Read a RoadsLib.cfg (the road types of the roads shapefile).
#[tauri::command]
async fn roads_read(path: String) -> Result<RoadsLib, String> {
	let text = std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?;
	let (types, warnings) = roads::parse(&text).map_err(|e| format!("{path}: {e}"))?;
	Ok(RoadsLib { types, warnings })
}

/// Read a file as bytes.
#[tauri::command]
async fn read_bytes(path: String) -> Result<Response, String> {
	work(move || std::fs::read(&path).map_err(|e| format!("{path}: {e}"))).await
}

/// Write the request body to a file (temporary file, then rename). The path is in the header `path` (URI-encoded).
#[tauri::command]
async fn write_bytes(request: tauri::ipc::Request<'_>) -> Result<(), String> {
	let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
		return Err("write_bytes needs raw bytes".into());
	};
	let path = request.headers().get("path").and_then(|v| v.to_str().ok()).ok_or("write_bytes needs the header path")?;
	let path = percent_decode(path);
	write_atomic(Path::new(&path), bytes)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GameExport {
	#[serde(flatten)]
	settings: game::Settings,
	/// ImageToPAA.exe of the Arma 3 Tools. When set, each tile PNG is also converted to PAA.
	image_to_paa: Option<String>,
}

/// Export for the game: tiles, tile RVMAT files, and the WRP (see `game::export`). The settings are JSON in the header `settings` (URI-encoded).
/// Body: object count u32, 12 f32 for each object (the WRP transform), one u32 model index for each object, then the model names
/// (game paths or model keys) as UTF-8 text with one name on each line. Model keys get their game path from the model folders.
#[tauri::command]
async fn game_export(
	app: tauri::AppHandle,
	request: tauri::ipc::Request<'_>,
	models: State<'_, Models>,
	mask: State<'_, MaskState>,
	sat: State<'_, SatState>,
	terrain: State<'_, TerrainState>,
) -> Result<game::Report, String> {
	let tauri::ipc::InvokeBody::Raw(b) = request.body() else {
		return Err("game_export needs raw bytes".into());
	};
	let head = request.headers().get("settings").and_then(|v| v.to_str().ok()).ok_or("game_export needs the header settings")?;
	let ex: GameExport = serde_json::from_str(&percent_decode(head)).map_err(|e| e.to_string())?;
	let u = |o: usize| b.get(o..o + 4).map(|x| u32::from_le_bytes(x.try_into().unwrap())).ok_or("the object data is too short");
	let n = u(0)? as usize;
	let names: Vec<&str> = std::str::from_utf8(b.get(4 + n * 52..).ok_or("the object data is too short")?).map_err(|e| e.to_string())?.split('\n').collect();
	let mut ex = ex;
	let paths: Vec<Option<String>> = {
		let db = models.0.lock().unwrap();
		// The layer RVMAT files: add the folder above each game path that the model folders have (a model folder can be P:\a3 and not P:\).
		if let Ok(cfg) = std::fs::read_to_string(&ex.settings.layers_cfg).map_err(|e| e.to_string()).and_then(|t| layers_cfg::parse(&t)) {
			for l in &cfg.layers {
				let depth = l.material.split(['\\', '/']).filter(|p| !p.is_empty()).count();
				if let Some(root) = db.file(&l.material).and_then(|p| p.ancestors().nth(depth)) {
					if !ex.settings.search_roots.iter().any(|r| r == root) {
						ex.settings.search_roots.push(root.to_path_buf());
					}
				}
			}
		}
		names.iter().map(|m| db.game_path(m)).collect()
	};
	let missing: Vec<&str> = names.iter().zip(&paths).filter(|(m, p)| p.is_none() && !m.is_empty()).map(|(m, _)| *m).collect();
	if !missing.is_empty() {
		return Err(format!(
			"{} models are not in the model folders, so their game paths are not known: {}",
			missing.len(),
			missing.iter().take(10).copied().collect::<Vec<_>>().join(", ")
		));
	}
	let mut objects = Vec::with_capacity(n);
	for i in 0..n {
		let mut transform = [0f32; 12];
		for (k, t) in transform.iter_mut().enumerate() {
			*t = f32::from_bits(u(4 + i * 48 + k * 4)?);
		}
		let m = u(4 + n * 48 + i * 4)? as usize;
		let model = paths.get(m).cloned().flatten().ok_or("an object has a model index that is not in the list")?;
		objects.push(wrp::Object { transform, id: 0, model });
	}
	let (mask, sat, terrain) = (mask.0.clone(), sat.0.clone(), terrain.0.clone());
	let mut p = reporter(&app);
	let r = tauri::async_runtime::spawn_blocking(move || {
		let mut rep = {
			let m = mask.lock().unwrap();
			let s = sat.lock().unwrap();
			let t = terrain.lock().unwrap();
			game::export(&ex.settings, m.as_ref().ok_or("open a mask first")?, s.as_ref(), t.as_ref().ok_or("open a heightmap first")?, objects, &mut p)?
		};
		if let Some(exe) = ex.image_to_paa.filter(|e| !e.trim().is_empty()) {
			let failed = image_to_paa(&exe, &ex.settings.layers_dir, &rep.pngs);
			rep.lines.push(format!("{} PAA files", rep.pngs.len() - failed.len()));
			if !failed.is_empty() {
				return Err(format!("the WRP and the PNG tiles are written, but ImageToPAA failed for {} files:\n{}", failed.len(), failed.join("\n")));
			}
		}
		Ok(rep)
	})
	.await
	.map_err(|e| e.to_string());
	job_done(&app);
	r?
}

/// Convert the PNG files in `dir` to PAA with ImageToPAA.exe, some at the same time. Returns one line for each file that failed.
fn image_to_paa(exe: &str, dir: &Path, pngs: &[PathBuf]) -> Vec<String> {
	let next = std::sync::atomic::AtomicUsize::new(0);
	let failed = Mutex::new(Vec::new());
	let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(8);
	std::thread::scope(|sc| {
		for _ in 0..threads {
			sc.spawn(|| loop {
				let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
				let Some(p) = pngs.get(i) else { break };
				let (src, dst) = (dir.join(p), dir.join(p).with_extension("paa"));
				let err = match std::process::Command::new(exe).arg(&src).arg(&dst).output() {
					Ok(o) if o.status.success() && dst.is_file() => continue,
					Ok(o) => format!("{}: {} {}", src.display(), String::from_utf8_lossy(&o.stdout).trim(), String::from_utf8_lossy(&o.stderr).trim()),
					Err(e) => format!("{exe}: {e}"),
				};
				failed.lock().unwrap().push(err);
			});
		}
	});
	failed.into_inner().unwrap()
}

/// Decode %XX in a header value (the UI encodes the path with encodeURIComponent).
fn percent_decode(s: &str) -> String {
	let b = s.as_bytes();
	let mut out = Vec::with_capacity(b.len());
	let mut i = 0;
	while i < b.len() {
		if b[i] == b'%' && i + 2 < b.len() {
			if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
				out.push(v);
				i += 3;
				continue;
			}
		}
		out.push(b[i]);
		i += 1;
	}
	String::from_utf8_lossy(&out).into_owned()
}

/// What `project_save` wrote.
#[derive(serde::Serialize)]
struct SaveReport {
	mask: bool,
	satellite: bool,
	heights: bool,
}

/// Save the open images into a project folder: `mask.png`, `satellite.png`, `heights.bin` (and `source.asc`).
/// An image is written only when it changed after the last save into this folder, or when its file is missing.
#[tauri::command]
async fn project_save(dir: String, mask: State<'_, MaskState>, sat: State<'_, SatState>, terrain: State<'_, TerrainState>, saved: State<'_, Saved>) -> Result<SaveReport, String> {
	let dir = PathBuf::from(dir);
	std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
	let (m, s, t) = (mask.0.clone(), sat.0.clone(), terrain.0.clone());
	let todo = |kind: &'static str, file: &str, version: u64| {
		let last = saved.0.lock().unwrap().get(&(kind, dir.clone())).copied();
		last != Some(version) || !dir.join(file).is_file()
	};
	let mv = m.lock().unwrap().as_ref().map(|x| x.s.version);
	let sv = s.lock().unwrap().as_ref().map(|x| x.s.version);
	let tv = t.lock().unwrap().as_ref().map(|x| x.s.version);
	let want = (
		mv.filter(|&v| todo("mask", "mask.png", v)),
		sv.filter(|&v| todo("satellite", "satellite.png", v)),
		tv.filter(|&v| todo("heights", "heights.bin", v)),
	);
	let d = dir.clone();
	tauri::async_runtime::spawn_blocking(move || {
		if want.0.is_some() {
			m.lock().unwrap().as_ref().unwrap().export_png(&d.join("mask.png"))?;
		}
		if want.1.is_some() {
			s.lock().unwrap().as_ref().unwrap().export_png(&d.join("satellite.png"))?;
		}
		if want.2.is_some() {
			t.lock().unwrap().as_ref().unwrap().save(&d)?;
		}
		Ok::<_, String>(())
	})
	.await
	.map_err(|e| e.to_string())??;
	let mut map = saved.0.lock().unwrap();
	for (kind, v) in [("mask", want.0), ("satellite", want.1), ("heights", want.2)] {
		if let Some(v) = v {
			map.insert((kind, dir.clone()), v);
		}
	}
	Ok(SaveReport {
		mask: want.0.is_some(),
		satellite: want.1.is_some(),
		heights: want.2.is_some(),
	})
}

/// Load the heights of a project folder. Binary result: the terrain block (see `terrain_bytes`).
#[tauri::command]
async fn project_heights(dir: String, terrain: State<'_, TerrainState>) -> Result<Response, String> {
	let keep = terrain.0.clone();
	work(move || {
		let h = Heights::load(Path::new(&dir))?;
		let b = terrain_bytes(&h);
		*keep.lock().unwrap() = Some(h);
		Ok(b)
	})
	.await
}

/// After a project is opened: its images are the saved state of its folder, so the next save does not write them again.
#[tauri::command]
async fn project_saved(dir: String, mask: State<'_, MaskState>, sat: State<'_, SatState>, terrain: State<'_, TerrainState>, saved: State<'_, Saved>) -> Result<(), String> {
	let dir = PathBuf::from(dir);
	let mut map = saved.0.lock().unwrap();
	map.retain(|(_, d), _| d != &dir);
	if let Some(v) = mask.0.lock().unwrap().as_ref().map(|x| x.s.version) {
		map.insert(("mask", dir.clone()), v);
	}
	if let Some(v) = sat.0.lock().unwrap().as_ref().map(|x| x.s.version) {
		map.insert(("satellite", dir.clone()), v);
	}
	if let Some(v) = terrain.0.lock().unwrap().as_ref().map(|x| x.s.version) {
		map.insert(("heights", dir), v);
	}
	Ok(())
}

#[derive(serde::Serialize)]
struct ScanResult {
	keys: Vec<String>,
	textures: usize,
	/// Key and paths of each model name that is in more than one place.
	duplicates: Vec<(String, Vec<String>)>,
}

/// Run blocking file work on a worker thread, so that the window does not stop.
async fn work(f: impl FnOnce() -> Result<Vec<u8>, String> + Send + 'static) -> Result<Response, String> {
	tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?.map(Response::new)
}

/// Terrain block: ncols u32, nrows u32, cellsize f64, xllcorner f64, yllcorner f64, then the heights as f32. Row 0 is the north row.
fn terrain_bytes(a: &Heights) -> Vec<u8> {
	let mut b = Vec::with_capacity(32 + a.ncols * a.nrows * 4);
	b.extend((a.ncols as u32).to_le_bytes());
	b.extend((a.nrows as u32).to_le_bytes());
	for v in [a.cellsize, a.xll, a.yll] {
		b.extend(v.to_le_bytes());
	}
	for h in a.values() {
		b.extend(h.to_le_bytes());
	}
	b
}

/// Read an object text file (TB import). TB writes ANSI text. Each byte becomes one character (Latin-1), so that the export can write the same bytes again.
#[tauri::command]
async fn read_text(path: String) -> Result<String, String> {
	let b = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
	Ok(b.iter().map(|&c| c as char).collect())
}

/// Write an object text file (TB export). Each character becomes one byte (Latin-1). A character above 255 is an error.
#[tauri::command]
async fn write_text(path: String, text: String) -> Result<(), String> {
	let b = text
		.chars()
		.map(|c| u8::try_from(c).map_err(|_| format!("{path}: the character {c:?} is not in the ANSI (Latin-1) range")))
		.collect::<Result<Vec<u8>, String>>()?;
	std::fs::write(&path, b).map_err(|e| format!("{path}: {e}"))
}

/// Binary result: the terrain block (see `terrain_bytes`).
#[tauri::command]
async fn open_asc(path: String, terrain: State<'_, TerrainState>) -> Result<Response, String> {
	let keep = terrain.0.clone();
	work(move || {
		// A Terragen file has no map position: it gets the TB corner 200000, 0.
		let a = if path.to_ascii_lowercase().ends_with(".ter") {
			Heights::from_asc(&ter::parse(&std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?, 200000.0, 0.0).map_err(|e| format!("{path}: {e}"))?)
		} else {
			Heights::parse(std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?).map_err(|e| format!("{path}: {e}"))?
		};
		let b = terrain_bytes(&a);
		*keep.lock().unwrap() = Some(a);
		Ok(b)
	})
	.await
}

/// New flat terrain: ncols x nrows cells of `cell` meters, the corner at (xll, yll), all heights `height`. The result is as `open_asc`.
#[tauri::command]
async fn new_terrain(ncols: usize, nrows: usize, cell: f64, xll: f64, yll: f64, height: f32, terrain: State<'_, TerrainState>) -> Result<Response, String> {
	if ncols < 2 || nrows < 2 || ncols * nrows > 1 << 28 || !(cell > 0.0) {
		return Err(format!("a terrain of {ncols} x {nrows} cells of {cell} m is not possible"));
	}
	let keep = terrain.0.clone();
	work(move || {
		let a = Heights::from_asc(&asc::Asc::from_south_rows(ncols, nrows, &vec![height; ncols * nrows], xll, yll, cell));
		let b = terrain_bytes(&a);
		*keep.lock().unwrap() = Some(a);
		Ok(b)
	})
	.await
}

/// Binary result: width u32, height u32, then RGBA pixels. The image is reduced to at most `max_px` on each side.
#[tauri::command]
async fn open_image(path: String, max_px: u32) -> Result<Response, String> {
	work(move || {
		let (w, h, px) = tiles::downsample(std::path::Path::new(&path), max_px)?;
		let mut b = Vec::with_capacity(8 + px.len());
		b.extend(w.to_le_bytes());
		b.extend(h.to_le_bytes());
		b.extend(px);
		Ok(b)
	})
	.await
}

/// Binary result: terrain block length u32, the terrain block (see `terrain_bytes`, xllcorner and yllcorner are 0),
/// then the objects: object count u32, model count u32, 12 f32 for each object (aside, up, dir, position),
/// one u32 model index for each object, then the model paths as UTF-8 text with one path on each line.
/// The end marker of the WRP is not sent.
#[tauri::command]
async fn open_wrp(path: String, terrain: State<'_, TerrainState>) -> Result<Response, String> {
	let keep = terrain.0.clone();
	work(move || {
		let bytes = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
		let w = wrp::read(&bytes)?;
		let (nx, ny) = (w.grid.0 as usize, w.grid.1 as usize);
		let cell = w.layers.0 as f64 * w.layer_size as f64 / nx as f64;
		let a = Heights::from_asc(&asc::Asc::from_south_rows(nx, ny, &w.heights, 0.0, 0.0, cell));
		let t = terrain_bytes(&a);
		*keep.lock().unwrap() = Some(a);
		let body = w.body.map_err(|e| format!("the objects of the WRP are not decoded: {e}"))?;
		let objects: Vec<&wrp::Object> = body.objects.iter().filter(|o| !o.model.is_empty()).collect();
		let mut models: Vec<&str> = objects.iter().map(|o| o.model.as_str()).collect();
		models.sort_unstable();
		models.dedup();
		let mut b = Vec::with_capacity(4 + t.len() + objects.len() * 52);
		b.extend((t.len() as u32).to_le_bytes());
		b.extend(t);
		b.extend((objects.len() as u32).to_le_bytes());
		b.extend((models.len() as u32).to_le_bytes());
		for o in &objects {
			for t in o.transform {
				b.extend(t.to_le_bytes());
			}
		}
		for o in &objects {
			b.extend((models.binary_search(&o.model.as_str()).unwrap() as u32).to_le_bytes());
		}
		b.extend(models.join("\n").as_bytes());
		Ok(b)
	})
	.await
}

#[derive(serde::Serialize)]
struct Project {
	#[serde(flatten)]
	tv4p: alb::Tv4p,
	/// The exported WRP (`<WRP folder>\<name>.wrp`), when the file exists.
	wrp: Option<String>,
}

/// Read a Terrain Builder project (`.tv4p`): the settings and the paths of the imported files.
#[tauri::command]
async fn open_tv4p(path: String) -> Result<Project, String> {
	tauri::async_runtime::spawn_blocking(move || {
		let tv4p = alb::tv4p(&std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?).map_err(|e| format!("{path}: {e}"))?;
		let wrp = std::path::Path::new(&tv4p.wrp_folder).join(format!("{}.wrp", tv4p.name));
		let wrp = wrp.is_file().then(|| wrp.display().to_string());
		Ok(Project { tv4p, wrp })
	})
	.await
	.map_err(|e| e.to_string())?
}

/// Scan the model folders and keep the result as the object database.
#[tauri::command]
async fn scan_models(app: tauri::AppHandle, roots: Vec<String>, models: State<'_, Models>) -> Result<ScanResult, String> {
	let roots: Vec<std::path::PathBuf> = roots.iter().map(Into::into).collect();
	let mut p = reporter(&app);
	let db = tauri::async_runtime::spawn_blocking(move || objdb::scan_with(&roots, &mut p)).await.map_err(|e| e.to_string());
	job_done(&app);
	// After a cancel, the old model list stays.
	let db = db?.ok_or(terrain_core::CANCELLED)?;
	let r = ScanResult {
		keys: db.models.keys().cloned().collect(),
		textures: db.texture_count(),
		duplicates: db.duplicates().map(|(k, v)| (k.clone(), v.iter().map(|p| p.display().to_string()).collect())).collect(),
	};
	*models.0.lock().unwrap() = db;
	Ok(r)
}

/// Binary result: vertex count u32, group count u32, min and max (6 f32), offset of the binarizer (3 f32), positions (3 f32), normals (3 f32), uvs (2 f32),
/// second uvs (2 f32, zero when the model has no second UV set), "on surface" (1 f32: 1 or 0),
/// then for each group: index count u32, texture path length u32, the path, material path length u32, the path
/// (each path UTF-8, padded to 4 bytes), the indices (u32). At the end: LandContact point count u32, the points (3 f32).
/// Positions are in Arma model space (x right, y up, z forward). `low` selects the least detailed visual LOD.
#[tauri::command]
async fn model_mesh(app: tauri::AppHandle, name: String, low: bool, models: State<'_, Models>) -> Result<Response, String> {
	let path = models.0.lock().unwrap().find(&name).map(|p| p.to_path_buf()).ok_or_else(|| format!("model {name} is not in the model folders"))?;
	work(move || {
		let bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
		let mut m = p3d::mesh(&bytes, low).map_err(|e| format!("{}: {e}", path.display()))?;
		// Proxy models (for example the wire of a fence) become part of the mesh, two levels deep.
		use tauri::Manager;
		let load = |model: &str| {
			let p = app.state::<Models>().0.lock().unwrap().find(model).map(|p| p.to_path_buf())?;
			std::fs::read(p).ok()
		};
		p3d::add_proxies(&mut m, low, 2, &load);
		let mut b = Vec::new();
		b.extend((m.positions.len() as u32).to_le_bytes());
		b.extend((m.groups.len() as u32).to_le_bytes());
		let uv1 = if m.uv1.is_empty() { vec![[0.0; 2]; m.positions.len()] } else { m.uv1.clone() };
		let land: Vec<f32> = (0..m.positions.len()).map(|i| if m.clip.get(i).is_some_and(|c| c & p3d::CLIP_LAND_ON != 0) { 1.0 } else { 0.0 }).collect();
		for v in m
			.min
			.iter()
			.chain(&m.max)
			.chain(&m.offset)
			.chain(m.positions.iter().flatten())
			.chain(m.normals.iter().flatten())
			.chain(m.uvs.iter().flatten())
			.chain(uv1.iter().flatten())
			.chain(&land)
		{
			b.extend(v.to_le_bytes());
		}
		for g in &m.groups {
			b.extend((g.indices.len() as u32).to_le_bytes());
			for text in [&g.texture, &g.material] {
				b.extend((text.len() as u32).to_le_bytes());
				b.extend(text.as_bytes());
				b.resize(b.len().next_multiple_of(4), 0);
			}
			for i in &g.indices {
				b.extend(i.to_le_bytes());
			}
		}
		b.extend((m.land_contact.len() as u32).to_le_bytes());
		for v in m.land_contact.iter().flatten() {
			b.extend(v.to_le_bytes());
		}
		Ok(b)
	})
	.await
}

/// Binary result: format u32 (1 = DXT1, 5 = DXT5), mipmap count u32, then for each mipmap: width u16, height u16, size u32, DXT data.
/// The path is a game path (for example `a3\data_f\x_co.paa`) below one of the model folders.
#[tauri::command]
async fn texture(path: String, models: State<'_, Models>) -> Result<Response, String> {
	let file = {
		let db = models.0.lock().unwrap();
		db.file(&path)
			.map(|p| p.to_path_buf())
			.ok_or_else(|| format!("texture {path} is not in the model folders ({} PAA files were found in the scan)", db.texture_count()))?
	};
	work(move || {
		let p = paa::read(&std::fs::read(&file).map_err(|e| format!("{}: {e}", file.display()))?).map_err(|e| format!("{}: {e}", file.display()))?;
		let mut b = Vec::new();
		b.extend((if p.format == paa::Format::Dxt1 { 1u32 } else { 5 }).to_le_bytes());
		b.extend((p.mips.len() as u32).to_le_bytes());
		for m in &p.mips {
			b.extend(m.width.to_le_bytes());
			b.extend(m.height.to_le_bytes());
			b.extend((m.data.len() as u32).to_le_bytes());
			b.extend(&m.data);
		}
		Ok(b)
	})
	.await
}

/// Read a model material (RVMAT, text or binarized) by its game path.
#[tauri::command]
async fn material(path: String, models: State<'_, Models>) -> Result<rvmat::Material, String> {
	let file = models
		.0
		.lock()
		.unwrap()
		.file(&path)
		.map(|p| p.to_path_buf())
		.ok_or_else(|| format!("material {path} is not in the model folders"))?;
	tauri::async_runtime::spawn_blocking(move || {
		let b = std::fs::read(&file).map_err(|e| format!("{}: {e}", file.display()))?;
		rvmat::read_material(&b).map_err(|e| format!("{}: {e}", file.display()))
	})
	.await
	.map_err(|e| e.to_string())?
}

fn main() {
	tauri::Builder::default()
		.plugin(tauri_plugin_dialog::init())
		.manage(Models::default())
		.manage(MaskState::default())
		.manage(Saved::default())
		.manage(SatState::default())
		.manage(TerrainState::default())
		.invoke_handler(tauri::generate_handler![
			read_text,
			write_text,
			open_asc,
			open_image,
			open_wrp,
			open_tv4p,
			scan_models,
			model_mesh,
			texture,
			material,
			mask_open,
			mask_region,
			mask_paint,
			mask_end_stroke,
			mask_fill,
			mask_polygon,
			layer_detail,
			mask_undo,
			mask_export,
			fill_estimate,
			fill_run,
			sat_open,
			sat_region,
			sat_paint,
			sat_end_stroke,
			sat_undo,
			sat_pick,
			sat_texture,
			sat_export,
			height_paint,
			height_end_stroke,
			height_undo,
			height_region,
			height_pick,
			height_stamp_load,
			height_stamp,
			height_export,
			read_bytes,
			write_bytes,
			project_save,
			project_heights,
			project_saved,
			mask_band,
			height_flatten_polygon,
			height_road,
			height_offset,
			shp_write,
			shp_read,
			roads_read,
			game_export,
			cancel_job,
			reset_state,
			dir_exists,
			new_terrain
		])
		.run(tauri::generate_context!())
		.expect("Terrain Tool did not start");
}
