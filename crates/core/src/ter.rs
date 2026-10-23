//! Reader for Terragen terrain files (`.ter`): the chunks SIZE, XPTS, YPTS, SCAL, CRAD, CRVM, ALTW, and EOF.
//! Height in meters = SCAL z * (BaseHeight + value * HeightScale / 65536).
//! The first row of the data is the south row (the origin is at the bottom left), as in the GDAL Terragen driver. Verified with a sample file.
use crate::asc::Asc;

/// Read a TER file. The map corner is (xll, yll), for example 200000, 0 for TB. The cell size is the SCAL x value (30 m when the file has no SCAL).
pub fn parse(b: &[u8], xll: f64, yll: f64) -> Result<Asc, String> {
	if b.len() < 16 || &b[0..16] != b"TERRAGENTERRAIN " {
		return Err("TER: the file does not start with TERRAGENTERRAIN".into());
	}
	let i16_at = |o: usize| b.get(o..o + 2).map(|x| i16::from_le_bytes([x[0], x[1]])).ok_or("TER: the file ends too early");
	let f32_at = |o: usize| b.get(o..o + 4).map(|x| f32::from_le_bytes(x.try_into().unwrap())).ok_or("TER: the file ends too early");
	let (mut size, mut xpts, mut ypts) = (0usize, 0usize, 0usize);
	let mut scal = [30.0f32; 3];
	let mut o = 16;
	while o + 4 <= b.len() {
		let id = &b[o..o + 4];
		o += 4;
		match id {
			b"SIZE" => (size, o) = (i16_at(o)? as u16 as usize, o + 4),
			b"XPTS" => (xpts, o) = (i16_at(o)? as u16 as usize, o + 4),
			b"YPTS" => (ypts, o) = (i16_at(o)? as u16 as usize, o + 4),
			b"SCAL" => {
				scal = [f32_at(o)?, f32_at(o + 4)?, f32_at(o + 8)?];
				o += 12;
			}
			b"CRAD" | b"CRVM" => o += 4,
			b"ALTW" => {
				// Without XPTS and YPTS, the terrain is square with SIZE + 1 points on each side.
				let (w, h) = (if xpts > 0 { xpts } else { size + 1 }, if ypts > 0 { ypts } else { size + 1 });
				if w < 2 || h < 2 {
					return Err(format!("TER: the terrain has {w} x {h} points"));
				}
				let (scale, base) = (i16_at(o)? as f64, i16_at(o + 2)? as f64);
				o += 4;
				let mut south = Vec::with_capacity(w * h);
				for k in 0..w * h {
					south.push((scal[2] as f64 * (base + i16_at(o + k * 2)? as f64 * scale / 65536.0)) as f32);
				}
				// A square Terragen file of 2^n + 1 points covers 2^n cells. TB and the WRP use 2^n points, so the north row and the east column go.
				// Verified with a 4097 x 4097 file of the user against the ASC of the same map: the first row is the south row.
				let (w2, h2) = if w == h && w > 2 && (w - 1).is_power_of_two() { (w - 1, h - 1) } else { (w, h) };
				let south: Vec<f32> = (0..h2).flat_map(|r| south[r * w..r * w + w2].to_vec()).collect();
				// The SCAL value is often a float near a round number (3.9999998 for 4 m).
				let cell = scal[0] as f64;
				let cell = if (cell - cell.round()).abs() < 1e-5 * cell.max(1.0) { cell.round() } else { cell };
				return Ok(Asc::from_south_rows(w2, h2, &south, xll, yll, cell));
			}
			b"EOF " => break,
			_ => return Err(format!("TER: unknown chunk {:?} at byte {}", String::from_utf8_lossy(id), o - 4)),
		}
	}
	Err("TER: the file has no ALTW chunk (heights)".into())
}

#[cfg(test)]
mod tests {
	#[test]
	fn reads_heights_and_scale() {
		let mut b = b"TERRAGENTERRAIN ".to_vec();
		b.extend(b"SIZE");
		b.extend(2i16.to_le_bytes());
		b.extend([0, 0]);
		b.extend(b"XPTS");
		b.extend(3i16.to_le_bytes());
		b.extend([0, 0]);
		b.extend(b"YPTS");
		b.extend(2i16.to_le_bytes());
		b.extend([0, 0]);
		b.extend(b"SCAL");
		for v in [4.0f32, 4.0, 2.0] {
			b.extend(v.to_le_bytes());
		}
		// Height scale 16384 (one quarter), base height 10.
		b.extend(b"ALTW");
		b.extend(16384i16.to_le_bytes());
		b.extend(10i16.to_le_bytes());
		for v in [0i16, 4, 8, 12, 16, -20] {
			b.extend(v.to_le_bytes());
		}
		b.extend(b"EOF ");
		let a = super::parse(&b, 200000.0, 0.0).unwrap();
		assert_eq!((a.ncols, a.nrows, a.cellsize, a.xll), (3, 2, 4.0, 200000.0));
		// 2 * (10 + v / 4). The data of an Asc starts with the north row, so the second TER row comes first.
		assert_eq!(a.data, [26.0, 28.0, 10.0, 20.0, 22.0, 24.0]);
		assert!(super::parse(b"TERRAGENTERRAIN EOF ", 0.0, 0.0).is_err());
		// 3 x 3 points (2^1 + 1) give 2 x 2: the north row and the east column go.
		let mut c = b"TERRAGENTERRAIN SIZE".to_vec();
		c.extend([2, 0, 0, 0]);
		c.extend(b"SCAL");
		for v in [3.9999998f32, 3.9999998, 1.0] {
			c.extend(v.to_le_bytes());
		}
		c.extend(b"ALTW");
		c.extend(16384i16.to_le_bytes());
		c.extend(0i16.to_le_bytes());
		for v in [0i16, 4, 8, 12, 16, 20, 24, 28, 32] {
			c.extend(v.to_le_bytes());
		}
		let a = super::parse(&c, 0.0, 0.0).unwrap();
		assert_eq!((a.ncols, a.nrows, a.cellsize), (2, 2, 4.0));
		assert_eq!(a.data, [3.0, 4.0, 0.0, 1.0]);
	}
}
