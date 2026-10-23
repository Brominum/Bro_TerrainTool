//! ESRI ASCII grid (ASC) heightmap. Row 0 is the north row.
use std::fmt::Write;
#[derive(Debug, Clone, PartialEq)]
pub struct Asc {
	/// The header lines as they are in the file. The writer keeps them.
	pub header: Vec<String>,
	pub ncols: usize,
	pub nrows: usize,
	pub xll: f64,
	pub yll: f64,
	pub cellsize: f64,
	pub nodata: f64,
	/// Heights, row by row. Row 0 is the north row.
	pub data: Vec<f32>,
}

pub fn parse(text: &str) -> Result<Asc, String> {
	let mut lines = text.lines();
	let mut header = Vec::new();
	let (mut ncols, mut nrows, mut xll, mut yll, mut cellsize, mut nodata) = (0usize, 0usize, 0.0, 0.0, 1.0, -9999.0);
	for _ in 0..6 {
		let l = lines.next().ok_or("ASC: header is too short")?;
		let mut it = l.split_whitespace();
		let (k, v) = (it.next().unwrap_or("").to_ascii_lowercase(), it.next().unwrap_or(""));
		let num = || v.parse::<f64>().map_err(|_| format!("ASC: bad header line '{l}'"));
		match k.as_str() {
			"ncols" => ncols = num()? as usize,
			"nrows" => nrows = num()? as usize,
			"xllcorner" | "xllcenter" => xll = num()?,
			"yllcorner" | "yllcenter" => yll = num()?,
			"cellsize" => cellsize = num()?,
			"nodata_value" => nodata = num()?,
			_ => return Err(format!("ASC: unknown header line '{l}'")),
		}
		header.push(l.to_string());
	}
	let mut data = Vec::with_capacity(ncols * nrows);
	for (r, l) in lines.take(nrows).enumerate() {
		let before = data.len();
		for v in l.split_whitespace() {
			data.push(v.parse::<f32>().map_err(|_| format!("ASC: bad value '{v}' in row {r}"))?);
		}
		if data.len() - before != ncols {
			return Err(format!("ASC: row {r} has {} values, expected {ncols}", data.len() - before));
		}
	}
	if data.len() != ncols * nrows {
		return Err(format!("ASC: expected {nrows} rows"));
	}
	Ok(Asc {
		header,
		ncols,
		nrows,
		xll,
		yll,
		cellsize,
		nodata,
		data,
	})
}

impl Asc {
	/// Write the ASC. Values have `decimals` decimal places. The separator is one space. The line end is LF.
	pub fn write(&self, decimals: usize) -> String {
		let mut s = String::with_capacity(self.data.len() * (decimals + 5));
		for h in &self.header {
			s += h;
			s.push('\n');
		}
		for row in self.data.chunks(self.ncols) {
			for (i, v) in row.iter().enumerate() {
				if i > 0 {
					s.push(' ');
				}
				let _ = write!(s, "{v:.decimals$}");
			}
			s.push('\n');
		}
		s
	}
	/// Make an ASC from heights where row 0 is the south row (the WRP order).
	pub fn from_south_rows(ncols: usize, nrows: usize, south: &[f32], xll: f64, yll: f64, cellsize: f64) -> Asc {
		let data = south.chunks(ncols).rev().flatten().copied().collect();
		let header = vec![
			format!("ncols {ncols}"),
			format!("nrows {nrows}"),
			format!("xllcorner {xll:.6}"),
			format!("yllcorner {yll:.6}"),
			format!("cellsize {cellsize:.6}"),
			"NODATA_value -9999".to_string(),
		];
		Asc {
			header,
			ncols,
			nrows,
			xll,
			yll,
			cellsize,
			nodata: -9999.0,
			data,
		}
	}
}

#[cfg(test)]
mod tests {
	#[test]
	fn round_trip_is_identical() {
		let t = "ncols 3\nnrows 2\nxllcorner 200000.000000\nyllcorner 0.000000\ncellsize 1.000000\nNODATA_value -9999\n1.00 -0.00 101.09\n-1.57 2.50 3.00\n";
		let a = super::parse(t).unwrap();
		assert_eq!((a.ncols, a.nrows, a.xll), (3, 2, 200000.0));
		assert_eq!(a.write(2), t);
		let b = super::Asc::from_south_rows(3, 2, &a.data, a.xll, a.yll, a.cellsize);
		assert_eq!(b.data[0], -1.57);
	}
}
