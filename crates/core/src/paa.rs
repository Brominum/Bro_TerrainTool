//! Reader for PAA textures. Verified with bro_dirt_co.paa (DXT1) and bro_dirt_nopx.paa (DXT5, LZO).
//! Layout: uint16 type, tags (`GGAT`, name, uint32 length, data), uint16 palette count and palette,
//! then the mipmaps: uint16 width, uint16 height, uint24 size, data. Width 0 ends the list.
//! Bit 15 of the width tells that the mipmap data is LZO1X compressed.

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Format {
	Dxt1,
	Dxt5,
}

#[derive(Debug, Clone)]
pub struct Mip {
	pub width: u16,
	pub height: u16,
	/// DXT blocks, not compressed.
	pub data: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct Paa {
	pub format: Format,
	/// Tag name (as in the file, for example `CGVA`) and data.
	pub tags: Vec<([u8; 4], Vec<u8>)>,
	/// The largest mipmap first.
	pub mips: Vec<Mip>,
}

/// Read a PAA file.
/// shortcut: only DXT1 and DXT5 are read. Other types (ARGB4444, ARGB1555, AI88, ARGB8888) give an error. Add them when a model needs them.
pub fn read(b: &[u8]) -> Result<Paa, String> {
	let u16_at = |o: usize| b.get(o..o + 2).map(|x| u16::from_le_bytes([x[0], x[1]])).ok_or("PAA: file ends too early");
	let format = match u16_at(0)? {
		0xFF01 => Format::Dxt1,
		0xFF05 => Format::Dxt5,
		t => return Err(format!("PAA: type 0x{t:04X} is not supported")),
	};
	let block = if format == Format::Dxt1 { 8 } else { 16 };
	let mut o = 2;
	let mut tags = Vec::new();
	while b.get(o..o + 4) == Some(b"GGAT") {
		let len = b.get(o + 8..o + 12).map(|x| u32::from_le_bytes(x.try_into().unwrap()) as usize).ok_or("PAA: tag ends too early")?;
		let data = b.get(o + 12..o + 12 + len).ok_or("PAA: tag ends too early")?;
		tags.push((b[o + 4..o + 8].try_into().unwrap(), data.to_vec()));
		o += 12 + len;
	}
	o += 2 + u16_at(o)? as usize * 3;
	let mut mips = Vec::new();
	loop {
		let (w, height) = (u16_at(o)?, u16_at(o + 2)?);
		if w == 0 {
			break;
		}
		let size = b.get(o + 4..o + 7).map(|x| x[0] as usize | (x[1] as usize) << 8 | (x[2] as usize) << 16).ok_or("PAA: mipmap ends too early")?;
		let src = b.get(o + 7..o + 7 + size).ok_or("PAA: mipmap ends too early")?;
		let width = w & 0x7FFF;
		let need = (width as usize).div_ceil(4) * (height as usize).div_ceil(4) * block;
		let data = if w & 0x8000 != 0 {
			lzo1x(src, need).map_err(|e| format!("PAA mipmap {width} x {height}: {e}"))?
		} else {
			src.to_vec()
		};
		if data.len() != need {
			return Err(format!("PAA mipmap {width} x {height} has {} bytes, expected {need}", data.len()));
		}
		mips.push(Mip { width, height, data });
		o += 7 + size;
	}
	if mips.is_empty() {
		return Err("PAA: no mipmaps".into());
	}
	Ok(Paa { format, tags, mips })
}

/// Decompress LZO1X data. The output must have exactly `out_len` bytes, and all input bytes must be used.
pub fn lzo1x(src: &[u8], out_len: usize) -> Result<Vec<u8>, String> {
	let (out, used) = lzo1x_prefix(src, out_len)?;
	if used != src.len() {
		return Err(format!("LZO: {} input bytes are not used", src.len() - used));
	}
	Ok(out)
}

/// Decompress LZO1X data at the start of `src`. Returns the output (exactly `out_len` bytes) and the number of input bytes used.
/// This follows lzo1x_decompress_safe of the Linux kernel.
pub fn lzo1x_prefix(src: &[u8], out_len: usize) -> Result<(Vec<u8>, usize), String> {
	let mut out: Vec<u8> = Vec::with_capacity(out_len);
	let mut ip = 0usize;
	let get = |i: usize| src.get(i).copied().map(|x| x as usize).ok_or_else(|| "LZO: input ends too early".to_string());
	// Length extension: a run of zero bytes, each adds 255, then one byte.
	let ext = |ip: &mut usize| -> Result<usize, String> {
		let mut n = 0;
		while get(*ip)? == 0 {
			n += 255;
			*ip += 1;
		}
		*ip += 1;
		Ok(n + get(*ip - 1)?)
	};
	let literals = |out: &mut Vec<u8>, ip: &mut usize, n: usize| -> Result<(), String> {
		if out.len() + n > out_len {
			return Err("LZO: output is larger than expected".into());
		}
		let s = src.get(*ip..*ip + n).ok_or("LZO: literal run ends too early")?;
		out.extend_from_slice(s);
		*ip += n;
		Ok(())
	};
	let copy = |out: &mut Vec<u8>, back: usize, len: usize| -> Result<(), String> {
		if back == 0 || back > out.len() {
			return Err("LZO: match points outside the output".into());
		}
		if out.len() + len > out_len {
			return Err("LZO: output is larger than expected".into());
		}
		let start = out.len() - back;
		for i in 0..len {
			let v = out[start + i];
			out.push(v);
		}
		Ok(())
	};
	let mut state = 0usize;
	if get(0)? > 17 {
		let t = get(0)? - 17;
		ip = 1;
		literals(&mut out, &mut ip, t)?;
		state = if t < 4 { t } else { 4 };
	}
	loop {
		let t = get(ip)?;
		ip += 1;
		let (back, len, next);
		if t < 16 {
			if state == 0 {
				let n = if t == 0 { 15 + ext(&mut ip)? } else { t };
				literals(&mut out, &mut ip, n + 3)?;
				state = 4;
				continue;
			}
			let d = get(ip)?;
			ip += 1;
			next = t & 3;
			if state != 4 {
				back = 1 + (t >> 2) + (d << 2);
				len = 2;
			} else {
				back = 1 + 0x800 + (t >> 2) + (d << 2);
				len = 3;
			}
		} else if t >= 64 {
			let d = get(ip)?;
			ip += 1;
			next = t & 3;
			back = 1 + ((t >> 2) & 7) + (d << 3);
			len = (t >> 5) + 1;
		} else if t >= 32 {
			let mut l = (t & 31) + 2;
			if l == 2 {
				l += 31 + ext(&mut ip)?;
			}
			let v = get(ip)? | get(ip + 1)? << 8;
			ip += 2;
			back = 1 + (v >> 2);
			next = v & 3;
			len = l;
		} else {
			let mut l = (t & 7) + 2;
			if l == 2 {
				l += 7 + ext(&mut ip)?;
			}
			let v = get(ip)? | get(ip + 1)? << 8;
			ip += 2;
			let b = ((t & 8) << 11) + (v >> 2);
			if b == 0 {
				// End marker.
				break;
			}
			back = b + 0x4000;
			next = v & 3;
			len = l;
		}
		copy(&mut out, back, len)?;
		literals(&mut out, &mut ip, next)?;
		state = next;
	}
	if out.len() != out_len {
		return Err(format!("LZO: output has {} bytes, expected {out_len}", out.len()));
	}
	Ok((out, ip))
}

#[cfg(test)]
mod tests {
	use super::*;
	#[test]
	fn lzo_literal_and_match() {
		// 4 literals "abcd" (first byte 17 + 4), then a match of 4 bytes 4 back (t = 64..), then the end marker.
		let src = [21, b'a', b'b', b'c', b'd', 0x6C, 0, 0x11, 0, 0];
		assert_eq!(lzo1x(&src, 8).unwrap(), b"abcdabcd");
	}
}
