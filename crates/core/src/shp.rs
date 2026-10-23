//! ESRI shapefile: SHP (geometry), SHX (index), DBF (properties), and CPG (the text encoding, UTF-8). 2D only.
//! Types: point (1), polyline (3), polygon (5). The reader also reads the Z and M variants (11, 13, 15, 21, 23, 25) without Z and M.
//! Polygon rings are written clockwise and closed (the first point again at the end), as the format needs.
use crate::tilestore::write_atomic;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
	Point,
	Line,
	Polygon,
}

impl Kind {
	fn code(self) -> i32 {
		match self {
			Kind::Point => 1,
			Kind::Line => 3,
			Kind::Polygon => 5,
		}
	}
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Shape {
	/// Parts (lines or rings). A point has one part with one point.
	pub parts: Vec<Vec<[f64; 2]>>,
	/// Properties (the DBF fields) in their order.
	pub props: Vec<(String, String)>,
}

/// Signed area of a ring (positive: counter-clockwise, with y to the north).
fn area(r: &[[f64; 2]]) -> f64 {
	(0..r.len()).map(|i| r[i][0] * r[(i + 1) % r.len()][1] - r[(i + 1) % r.len()][0] * r[i][1]).sum::<f64>() / 2.0
}

fn bbox(pts: impl Iterator<Item = [f64; 2]>) -> [f64; 4] {
	pts.fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |b, p| [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])])
}

fn header(code: i32, words: usize, b: [f64; 4]) -> Vec<u8> {
	let mut h = Vec::with_capacity(100);
	h.extend(9994i32.to_be_bytes());
	h.extend([0u8; 20]);
	h.extend((words as i32).to_be_bytes());
	h.extend(1000i32.to_le_bytes());
	h.extend(code.to_le_bytes());
	for v in b.iter().chain(&[0.0; 4]) {
		h.extend(v.to_le_bytes());
	}
	h
}

/// DBF fields: property key, name (at most 10 bytes), type (N for numbers, C for text), length, decimals.
fn fields(shapes: &[Shape]) -> Vec<(String, String, u8, usize, usize)> {
	let mut names: Vec<String> = Vec::new();
	for s in shapes {
		for (k, _) in &s.props {
			if !names.contains(k) {
				names.push(k.clone());
			}
		}
	}
	names
		.into_iter()
		.map(|n| {
			let vals: Vec<&str> = shapes.iter().filter_map(|s| s.props.iter().find(|p| p.0 == n).map(|p| p.1.trim())).filter(|v| !v.is_empty()).collect();
			let num = !vals.is_empty() && vals.iter().all(|v| v.parse::<f64>().is_ok() && !v.contains(['e', 'E', 'i', 'n', 'N', 'I']));
			let len = vals.iter().map(|v| v.len()).max().unwrap_or(1).clamp(1, if num { 19 } else { 254 });
			let dec = if num {
				vals.iter().map(|v| v.split_once('.').map_or(0, |(_, d)| d.len())).max().unwrap_or(0).min(15)
			} else {
				0
			};
			let mut name: String = n.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
			name.truncate(10);
			let name = if name.is_empty() { "FIELD".to_string() } else { name };
			(n, name, if num { b'N' } else { b'C' }, len, dec)
		})
		.collect()
}

fn dbf(shapes: &[Shape]) -> Vec<u8> {
	let mut f = fields(shapes);
	// A DBF needs one field at least.
	let id_only = f.is_empty();
	if id_only {
		f.push((String::new(), "ID".into(), b'N', 10, 0));
	}
	let rec_len = 1 + f.iter().map(|x| x.3).sum::<usize>();
	let mut b = vec![0x03, 126, 10, 22];
	b.extend((shapes.len() as u32).to_le_bytes());
	b.extend(((32 + f.len() * 32 + 1) as u16).to_le_bytes());
	b.extend((rec_len as u16).to_le_bytes());
	b.extend([0u8; 20]);
	for (_, name, t, len, dec) in &f {
		let mut n = [0u8; 11];
		n[..name.len()].copy_from_slice(name.as_bytes());
		b.extend(n);
		b.push(*t);
		b.extend([0u8; 4]);
		b.push(*len as u8);
		b.push(*dec as u8);
		b.extend([0u8; 14]);
	}
	b.push(0x0D);
	for (i, s) in shapes.iter().enumerate() {
		b.push(b' ');
		for (key, _, t, len, _) in &f {
			let v = if id_only {
				(i + 1).to_string()
			} else {
				s.props.iter().find(|p| &p.0 == key).map(|p| p.1.trim().to_string()).unwrap_or_default()
			};
			// Text is cut at a character boundary that fits the field.
			let mut bytes = v.into_bytes();
			while bytes.len() > *len {
				bytes.pop();
				while !bytes.is_empty() && std::str::from_utf8(&bytes).is_err() {
					bytes.pop();
				}
			}
			let pad = vec![b' '; len - bytes.len()];
			if *t == b'N' {
				b.extend(pad);
				b.extend(bytes);
			} else {
				b.extend(bytes);
				b.extend(pad);
			}
		}
	}
	b.push(0x1A);
	b
}

/// Write `<name>.shp`, `.shx`, `.dbf`, and `.cpg`. Each file goes to a temporary file first.
pub fn write(path: &Path, kind: Kind, shapes: &[Shape]) -> Result<(), String> {
	let code = kind.code();
	let all = bbox(shapes.iter().flat_map(|s| s.parts.iter().flatten().copied()));
	let all = if shapes.is_empty() { [0.0; 4] } else { all };
	let mut recs: Vec<Vec<u8>> = Vec::new();
	for s in shapes {
		let mut c = Vec::new();
		c.extend(code.to_le_bytes());
		if kind == Kind::Point {
			let p = s.parts.first().and_then(|p| p.first()).ok_or("a point shape has no point")?;
			c.extend(p[0].to_le_bytes());
			c.extend(p[1].to_le_bytes());
		} else {
			let parts: Vec<Vec<[f64; 2]>> = s
				.parts
				.iter()
				.filter(|p| !p.is_empty())
				.map(|p| {
					let mut p = p.clone();
					if kind == Kind::Polygon {
						if p.first() != p.last() {
							p.push(p[0]);
						}
						if area(&p) > 0.0 {
							p.reverse();
						}
					}
					p
				})
				.collect();
			for v in bbox(parts.iter().flatten().copied()) {
				c.extend(v.to_le_bytes());
			}
			c.extend((parts.len() as i32).to_le_bytes());
			c.extend((parts.iter().map(|p| p.len()).sum::<usize>() as i32).to_le_bytes());
			let mut start = 0;
			for p in &parts {
				c.extend((start as i32).to_le_bytes());
				start += p.len();
			}
			for p in parts.iter().flatten() {
				c.extend(p[0].to_le_bytes());
				c.extend(p[1].to_le_bytes());
			}
		}
		recs.push(c);
	}
	let words = 50 + recs.iter().map(|r| 4 + r.len() / 2).sum::<usize>();
	let mut shp = header(code, words, all);
	let mut shx = header(code, 50 + 4 * recs.len(), all);
	for (i, r) in recs.iter().enumerate() {
		shx.extend(((shp.len() / 2) as i32).to_be_bytes());
		shx.extend(((r.len() / 2) as i32).to_be_bytes());
		shp.extend((i as i32 + 1).to_be_bytes());
		shp.extend(((r.len() / 2) as i32).to_be_bytes());
		shp.extend(r);
	}
	write_atomic(&path.with_extension("shp"), &shp)?;
	write_atomic(&path.with_extension("shx"), &shx)?;
	write_atomic(&path.with_extension("dbf"), &dbf(shapes))?;
	write_atomic(&path.with_extension("cpg"), b"UTF-8")
}

/// Read a shapefile and its DBF (when it is there). Null shapes are skipped.
pub fn read(path: &Path) -> Result<(Kind, Vec<Shape>), String> {
	let p = path.with_extension("shp");
	let err = |e: &dyn std::fmt::Display| format!("{}: {e}", p.display());
	let b = std::fs::read(&p).map_err(|e| err(&e))?;
	if b.len() < 100 || i32::from_be_bytes(b[0..4].try_into().unwrap()) != 9994 {
		return Err(err(&"not a shapefile"));
	}
	let code = i32::from_le_bytes(b[32..36].try_into().unwrap());
	let kind = match code {
		1 | 11 | 21 => Kind::Point,
		3 | 13 | 23 => Kind::Line,
		5 | 15 | 25 => Kind::Polygon,
		c => return Err(err(&format!("shape type {c} is not supported"))),
	};
	let f64_at = |o: usize| -> Result<f64, String> { b.get(o..o + 8).map(|s| f64::from_le_bytes(s.try_into().unwrap())).ok_or_else(|| err(&"the file ends too early")) };
	let i32_at = |o: usize| -> Result<i32, String> { b.get(o..o + 4).map(|s| i32::from_le_bytes(s.try_into().unwrap())).ok_or_else(|| err(&"the file ends too early")) };
	let mut shapes = Vec::new();
	let mut o = 100;
	while o + 8 <= b.len() {
		let len = i32::from_be_bytes(b[o + 4..o + 8].try_into().unwrap()) as usize * 2;
		let c = o + 8;
		o = c + len;
		if i32_at(c)? == 0 {
			// A null shape keeps its DBF row: an empty shape.
			shapes.push(Shape { parts: Vec::new(), props: Vec::new() });
			continue;
		}
		let parts = if kind == Kind::Point {
			vec![vec![[f64_at(c + 4)?, f64_at(c + 12)?]]]
		} else {
			let (np, n) = (i32_at(c + 36)? as usize, i32_at(c + 40)? as usize);
			let starts: Vec<usize> = (0..np).map(|i| i32_at(c + 44 + i * 4).map(|v| v as usize)).collect::<Result<_, _>>()?;
			let pts = c + 44 + np * 4;
			let mut parts = Vec::new();
			for (i, &s) in starts.iter().enumerate() {
				let e = starts.get(i + 1).copied().unwrap_or(n);
				let mut part: Vec<[f64; 2]> = (s..e).map(|k| Ok([f64_at(pts + k * 16)?, f64_at(pts + k * 16 + 8)?])).collect::<Result<_, String>>()?;
				if kind == Kind::Polygon && part.len() > 1 && part.first() == part.last() {
					part.pop();
				}
				parts.push(part);
			}
			parts
		};
		shapes.push(Shape { parts, props: Vec::new() });
	}
	let d = path.with_extension("dbf");
	if let Ok(b) = std::fs::read(&d) {
		let n = u32::from_le_bytes(b[4..8].try_into().unwrap()) as usize;
		let (head, rec) = (u16::from_le_bytes([b[8], b[9]]) as usize, u16::from_le_bytes([b[10], b[11]]) as usize);
		let mut fields = Vec::new();
		let mut f = 32;
		while f + 32 <= head && b[f] != 0x0D {
			let name = String::from_utf8_lossy(&b[f..f + 11]).trim_end_matches('\0').to_string();
			fields.push((name, b[f + 16] as usize));
			f += 32;
		}
		for (i, s) in shapes.iter_mut().enumerate().take(n) {
			let mut at = head + i * rec + 1;
			for (name, len) in &fields {
				let v = b.get(at..at + len).map(|v| String::from_utf8_lossy(v).trim().to_string()).unwrap_or_default();
				s.props.push((name.clone(), v));
				at += len;
			}
		}
	}
	shapes.retain(|s| !s.parts.is_empty());
	Ok((kind, shapes))
}

#[cfg(test)]
mod tests {
	use super::*;
	fn props(v: &[(&str, &str)]) -> Vec<(String, String)> {
		v.iter().map(|(k, x)| (k.to_string(), x.to_string())).collect()
	}
	#[test]
	fn round_trip_of_each_kind() {
		let dir = std::env::temp_dir().join(format!("terrain_shp_{}", std::process::id()));
		std::fs::create_dir_all(&dir).unwrap();
		let lines = vec![
			Shape {
				parts: vec![vec![[200000.5, 10.25], [200100.0, 20.0], [200150.0, 80.0]]],
				props: props(&[("ID", "1"), ("name", "Main road")]),
			},
			Shape {
				parts: vec![vec![[200010.0, 5.0], [200020.0, 6.0]], vec![[1.0, 2.0], [3.0, 4.0]]],
				props: props(&[("ID", "12"), ("name", "Café")]),
			},
		];
		write(&dir.join("roads.shp"), Kind::Line, &lines).unwrap();
		assert_eq!(read(&dir.join("roads.shp")).unwrap(), (Kind::Line, lines));
		// A counter-clockwise ring is written clockwise, and reads back clockwise without the closing point.
		let poly = vec![Shape {
			parts: vec![vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]]],
			props: props(&[("density", "250.5")]),
		}];
		write(&dir.join("forest"), Kind::Polygon, &poly).unwrap();
		let (k, p) = read(&dir.join("forest.shp")).unwrap();
		assert_eq!(k, Kind::Polygon);
		assert_eq!(p[0].parts[0], vec![[0.0, 0.0], [0.0, 10.0], [10.0, 10.0], [10.0, 0.0]]);
		assert!(area(&p[0].parts[0]) < 0.0);
		assert_eq!(p[0].props, props(&[("density", "250.5")]));
		// Points without properties get an ID field.
		let pts = vec![
			Shape {
				parts: vec![vec![[5.0, 6.0]]],
				props: vec![],
			},
			Shape {
				parts: vec![vec![[7.0, 8.0]]],
				props: vec![],
			},
		];
		write(&dir.join("points"), Kind::Point, &pts).unwrap();
		let (_, p) = read(&dir.join("points.shp")).unwrap();
		assert_eq!((p[1].parts[0][0], p[1].props.clone()), ([7.0, 8.0], props(&[("ID", "2")])));
		std::fs::remove_dir_all(&dir).unwrap();
	}
}

#[cfg(test)]
mod external {
	use super::*;
	/// Writes files for a check with another reader (pyshp), and reads files that it wrote. Run with SHP_CHECK=<folder>.
	#[test]
	#[ignore]
	fn files_for_pyshp() {
		let dir = std::path::PathBuf::from(std::env::var("SHP_CHECK").unwrap());
		let line = Shape {
			parts: vec![vec![[200000.5, 10.25], [200100.0, 20.0]]],
			props: vec![("ID".into(), "3".into()), ("name".into(), "Café".into())],
		};
		write(&dir.join("ours_lines"), Kind::Line, &[line]).unwrap();
		let ring = Shape {
			parts: vec![vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0]]],
			props: vec![("density".into(), "2.5".into())],
		};
		write(&dir.join("ours_polygons"), Kind::Polygon, &[ring]).unwrap();
		if dir.join("theirs.shp").is_file() {
			let (k, s) = read(&dir.join("theirs.shp")).unwrap();
			println!("theirs: {k:?} {s:?}");
		}
	}
}
