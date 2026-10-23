//! Object database: all P3D files in the model folders (for example `P:\`). The key is the file name without the extension, in lower case.
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

#[derive(Debug, Default)]
pub struct Db {
	pub roots: Vec<PathBuf>,
	/// Key and all files with that key. More than one file is a duplicate.
	pub models: BTreeMap<String, Vec<PathBuf>>,
	/// Textures (PAA) and materials (RVMAT): file name (lower case) and all files with that name.
	pub files: HashMap<String, Vec<PathBuf>>,
}

/// Find all P3D, PAA, and RVMAT files below the roots.
/// shortcut: the scan runs again at each start (some seconds for P:\a3). Add a disk cache when this is too slow.
pub fn scan(roots: &[PathBuf]) -> Db {
	scan_with(roots, &mut |_| true).unwrap()
}

/// The same as `scan`, with progress and cancel (see `Progress`). None: the user cancelled the scan.
/// The progress is the part of the folders found so far that is done, so it can go back when the scan finds more folders.
pub fn scan_with(roots: &[PathBuf], progress: crate::Progress) -> Option<Db> {
	let mut db = Db {
		roots: roots.to_vec(),
		..Default::default()
	};
	let mut stack: Vec<PathBuf> = roots.to_vec();
	// A folder inside another model folder is scanned one time only.
	let mut seen = std::collections::HashSet::new();
	while let Some(dir) = stack.pop() {
		if !progress(seen.len() as f64 / (seen.len() + stack.len() + 1) as f64) {
			return None;
		}
		// The real path, so that a link (or a junction) to a folder that is already scanned does not scan it again, or loop.
		let real = std::fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
		if !seen.insert(real.to_string_lossy().to_ascii_lowercase().trim_end_matches(['\\', '/']).to_string()) {
			continue;
		}
		let Ok(rd) = std::fs::read_dir(&dir) else { continue };
		for e in rd.flatten() {
			let p = e.path();
			let Ok(t) = e.file_type() else { continue };
			// A link or a junction to a folder (for example P:\bromine) is a folder too.
			if t.is_dir() || (t.is_symlink() && p.is_dir()) {
				stack.push(p);
				continue;
			}
			let ext = p.extension().map(|x| x.to_string_lossy().to_ascii_lowercase());
			if ext.as_deref() == Some("p3d") {
				let key = p.file_stem().unwrap().to_string_lossy().to_ascii_lowercase();
				db.models.entry(key).or_default().push(p);
			} else if matches!(ext.as_deref(), Some("paa" | "rvmat")) {
				let name = p.file_name().unwrap().to_string_lossy().to_ascii_lowercase();
				db.files.entry(name).or_default().push(p);
			}
		}
	}
	Some(db)
}

impl Db {
	/// Find a model by key, file name, or game path (for example `a3\plants_f\tree\t_ficusb2s_f.p3d`).
	pub fn find(&self, name: &str) -> Option<&Path> {
		let stem = name.rsplit(['\\', '/']).next().unwrap_or(name);
		let key = stem.strip_suffix(".p3d").or_else(|| stem.strip_suffix(".P3D")).unwrap_or(stem).to_ascii_lowercase();
		self.models.get(&key).and_then(|v| v.first()).map(|p| p.as_path())
	}
	/// Game path of a model (for example `a3\plants_f\tree\t_ficusb2s_f.p3d`): its file path without the drive.
	/// A name that is already a path (it has a `\`) stays as it is.
	/// shortcut: assumes that the model folders are on the work drive (P:\), as the game paths start at its root.
	pub fn game_path(&self, name: &str) -> Option<String> {
		if name.contains('\\') {
			return Some(name.to_string());
		}
		let p = self.find(name)?.to_string_lossy().replace('/', "\\");
		let rest = p.split_once(":\\").map_or(p.trim_start_matches('\\'), |(_, r)| r);
		Some(rest.to_ascii_lowercase())
	}
	/// Find a texture or material by its game path (for example `a3\data_f\x_co.paa`): a file with the same name whose full path
	/// ends with the game path. The model folders can be `P:\`, `P:\a3`, or both. Case and `/` or `\` do not matter.
	pub fn file(&self, game_path: &str) -> Option<&Path> {
		let want = game_path.trim_start_matches(['\\', '/']).replace('/', "\\").to_ascii_lowercase();
		let name = want.rsplit('\\').next()?;
		let tail = format!("\\{want}");
		self.files
			.get(name)?
			.iter()
			.find(|p| p.to_string_lossy().replace('/', "\\").to_ascii_lowercase().ends_with(&tail))
			.map(|p| p.as_path())
	}
	/// Number of texture files (PAA).
	pub fn texture_count(&self) -> usize {
		self.files.iter().filter(|(k, _)| k.ends_with(".paa")).map(|(_, v)| v.len()).sum()
	}
	pub fn duplicates(&self) -> impl Iterator<Item = (&String, &Vec<PathBuf>)> {
		self.models.iter().filter(|(_, v)| v.len() > 1)
	}
}

#[cfg(test)]
mod tests {
	#[test]
	fn scans_keys_and_duplicates() {
		let d = std::env::temp_dir().join(format!("terrain_objdb_{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&d);
		for p in ["a3/plants_f/Tree/T_Ficus.p3d", "mod/t_ficus.P3D", "mod/house.p3d", "mod/house_co.paa"] {
			std::fs::create_dir_all(d.join(p).parent().unwrap()).unwrap();
			std::fs::write(d.join(p), b"x").unwrap();
		}
		let db = super::scan(&[d.clone()]);
		assert_eq!(db.models.len(), 2);
		assert_eq!(db.duplicates().count(), 1);
		assert!(db.find("a3\\plants_f\\tree\\t_ficus.p3d").is_some());
		assert!(db.find("HOUSE").is_some());
		assert!(db.file("MOD/House_CO.paa").is_some());
		assert!(db.file("other\\house_co.paa").is_none());
		assert!(db.game_path("House").unwrap().ends_with("\\mod\\house.p3d"));
		assert_eq!(db.game_path("a3\\x\\Y.p3d").as_deref(), Some("a3\\x\\Y.p3d"));
		assert_eq!(db.game_path("missing"), None);
		// The same files with the model folders `d` and `d/mod`: the texture path still starts above the folder.
		let db2 = super::scan(&[d.join("mod"), d.clone()]);
		assert!(db2.file("mod\\house_co.paa").is_some());
		assert_eq!((db2.texture_count(), db2.models.len()), (1, 2));
		// A link to a folder outside the root is scanned. A link back to the root does not loop.
		#[cfg(unix)]
		{
			let out = d.with_extension("linked");
			let _ = std::fs::remove_dir_all(&out);
			std::fs::create_dir_all(out.join("bro_laguna")).unwrap();
			std::fs::write(out.join("bro_laguna/road_co.paa"), b"x").unwrap();
			std::os::unix::fs::symlink(&out, d.join("bromine")).unwrap();
			std::os::unix::fs::symlink(&d, d.join("loop")).unwrap();
			assert!(super::scan(&[d.clone()]).file("bromine\\bro_laguna\\road_co.paa").is_some());
			std::fs::remove_dir_all(&out).unwrap();
		}
		std::fs::remove_dir_all(&d).unwrap();
	}
}
