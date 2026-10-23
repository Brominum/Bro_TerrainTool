//! Parser for the Arma config text format (layers.cfg, RVMAT).
//! It reads classes, values, and arrays. It skips comments and preprocessor lines.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
	Str(String),
	Num(f64),
	Array(Vec<Value>),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Entry {
	Value(Value),
	Class(Class),
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Class {
	pub name: String,
	pub entries: Vec<(String, Entry)>,
}

impl Class {
	/// Find a value. The name match ignores case, as in the game.
	pub fn value(&self, name: &str) -> Option<&Value> {
		self.entries.iter().find_map(|(n, e)| match e {
			Entry::Value(v) if n.eq_ignore_ascii_case(name) => Some(v),
			_ => None,
		})
	}
	pub fn class(&self, name: &str) -> Option<&Class> {
		self.entries.iter().find_map(|(n, e)| match e {
			Entry::Class(c) if n.eq_ignore_ascii_case(name) => Some(c),
			_ => None,
		})
	}
	pub fn classes(&self) -> impl Iterator<Item = &Class> {
		self.entries.iter().filter_map(|(_, e)| match e {
			Entry::Class(c) => Some(c),
			_ => None,
		})
	}
	pub fn str(&self, name: &str) -> Option<&str> {
		match self.value(name)? {
			Value::Str(s) => Some(s),
			_ => None,
		}
	}
	/// Get the numbers of an array value. Other items become NaN.
	pub fn nums(&self, name: &str) -> Option<Vec<f64>> {
		match self.value(name)? {
			Value::Array(a) => Some(a.iter().map(|v| if let Value::Num(n) = v { *n } else { f64::NAN }).collect()),
			Value::Num(n) => Some(vec![*n]),
			_ => None,
		}
	}
}

/// Parse a config text. The result is a root class with an empty name.
pub fn parse(text: &str) -> Result<Class, String> {
	let mut p = P { s: text.as_bytes(), i: 0 };
	let entries = p.body(false)?;
	Ok(Class { name: String::new(), entries })
}

/// Parse a config file that is text or binarized (`\0raP`, for example an RVMAT from a PBO).
pub fn parse_bytes(b: &[u8]) -> Result<Class, String> {
	if b.starts_with(b"\0raP") {
		let mut r = Rap { b, i: 16 };
		return Ok(Class { name: String::new(), entries: r.body()? });
	}
	parse(&String::from_utf8_lossy(b))
}

/// Reader for the binarized config format. Assumed from the community description: not checked with a sample file yet.
/// Layout: `\0raP`, uint32 0, uint32 8, uint32 enum offset, then the root class body at offset 16.
/// Class body: asciiz parent, compressed count, entries. Entry: byte type, then
/// 0 class (asciiz name, uint32 body offset), 1 value (byte kind, asciiz name, value), 2 array (asciiz name, array),
/// 3 extern class (asciiz name), 4 delete (asciiz name), 5 array with flag (uint32 flag, asciiz name, array).
struct Rap<'a> {
	b: &'a [u8],
	i: usize,
}

impl Rap<'_> {
	fn byte(&mut self) -> Result<u8, String> {
		let v = *self.b.get(self.i).ok_or("config.bin: file ends too early")?;
		self.i += 1;
		Ok(v)
	}
	fn u32(&mut self) -> Result<u32, String> {
		let v = self.b.get(self.i..self.i + 4).ok_or("config.bin: file ends too early")?;
		self.i += 4;
		Ok(u32::from_le_bytes(v.try_into().unwrap()))
	}
	/// Compressed integer: 7 bits in each byte, bit 7 tells that more bytes follow.
	fn count(&mut self) -> Result<usize, String> {
		let mut v = 0usize;
		for k in 0..5 {
			let x = self.byte()?;
			v |= ((x & 0x7F) as usize) << (7 * k);
			if x & 0x80 == 0 {
				return Ok(v);
			}
		}
		Err("config.bin: bad compressed integer".into())
	}
	fn asciiz(&mut self) -> Result<String, String> {
		let rest = self.b.get(self.i..).unwrap_or_default();
		let n = rest.iter().position(|&c| c == 0).ok_or("config.bin: string has no end")?;
		self.i += n + 1;
		Ok(String::from_utf8_lossy(&rest[..n]).into_owned())
	}
	fn scalar(&mut self, kind: u8) -> Result<Value, String> {
		Ok(match kind {
			0 | 4 => Value::Str(self.asciiz()?),
			1 => Value::Num(f32::from_bits(self.u32()?) as f64),
			2 => Value::Num(self.u32()? as i32 as f64),
			3 => self.array()?,
			k => return Err(format!("config.bin: value type {k} is not known")),
		})
	}
	fn array(&mut self) -> Result<Value, String> {
		let n = self.count()?;
		let mut items = Vec::with_capacity(n);
		for _ in 0..n {
			let k = self.byte()?;
			items.push(self.scalar(k)?);
		}
		Ok(Value::Array(items))
	}
	fn body(&mut self) -> Result<Vec<(String, Entry)>, String> {
		self.asciiz()?;
		let n = self.count()?;
		let mut out = Vec::with_capacity(n);
		for _ in 0..n {
			match self.byte()? {
				0 => {
					let name = self.asciiz()?;
					let at = self.u32()? as usize;
					let back = std::mem::replace(&mut self.i, at);
					let entries = self.body()?;
					self.i = back;
					out.push((name.clone(), Entry::Class(Class { name, entries })));
				}
				1 => {
					let kind = self.byte()?;
					let name = self.asciiz()?;
					out.push((name, Entry::Value(self.scalar(kind)?)));
				}
				2 => {
					let name = self.asciiz()?;
					out.push((name, Entry::Value(self.array()?)));
				}
				3 | 4 => {
					self.asciiz()?;
				}
				5 => {
					self.u32()?;
					let name = self.asciiz()?;
					out.push((name, Entry::Value(self.array()?)));
				}
				t => return Err(format!("config.bin: entry type {t} is not known")),
			}
		}
		Ok(out)
	}
}

struct P<'a> {
	s: &'a [u8],
	i: usize,
}

impl P<'_> {
	fn peek(&self) -> Option<u8> {
		self.s.get(self.i).copied()
	}
	fn err<T>(&self, msg: &str) -> Result<T, String> {
		let line = self.s[..self.i.min(self.s.len())].iter().filter(|&&c| c == b'\n').count() + 1;
		Err(format!("config line {line}: {msg}"))
	}
	fn skip_line(&mut self) {
		while let Some(c) = self.peek() {
			self.i += 1;
			if c == b'\n' {
				break;
			}
		}
	}
	fn ws(&mut self) {
		loop {
			match self.peek() {
				Some(c) if c.is_ascii_whitespace() => self.i += 1,
				Some(b'#') => self.skip_line(),
				Some(b'/') if self.s.get(self.i + 1) == Some(&b'/') => self.skip_line(),
				Some(b'/') if self.s.get(self.i + 1) == Some(&b'*') => {
					self.i += 2;
					while self.i < self.s.len() && !self.s[self.i..].starts_with(b"*/") {
						self.i += 1;
					}
					self.i = (self.i + 2).min(self.s.len());
				}
				_ => break,
			}
		}
	}
	fn ident(&mut self) -> Result<String, String> {
		let start = self.i;
		while matches!(self.peek(), Some(c) if c.is_ascii_alphanumeric() || c == b'_' || c == b'.') {
			self.i += 1;
		}
		if start == self.i {
			return self.err("expected a name");
		}
		Ok(String::from_utf8_lossy(&self.s[start..self.i]).into_owned())
	}
	fn expect(&mut self, c: u8) -> Result<(), String> {
		self.ws();
		if self.peek() != Some(c) {
			return self.err(&format!("expected '{}'", c as char));
		}
		self.i += 1;
		Ok(())
	}
	fn body(&mut self, nested: bool) -> Result<Vec<(String, Entry)>, String> {
		let mut out = Vec::new();
		loop {
			self.ws();
			match self.peek() {
				None if nested => return self.err("missing '}'"),
				None => return Ok(out),
				Some(b'}') if nested => {
					self.i += 1;
					self.ws();
					if self.peek() == Some(b';') {
						self.i += 1;
					}
					return Ok(out);
				}
				Some(b';') => {
					self.i += 1;
					continue;
				}
				_ => {}
			}
			let id = self.ident()?;
			self.ws();
			if id == "class" {
				let name = self.ident()?;
				self.ws();
				if self.peek() == Some(b':') {
					self.i += 1;
					self.ws();
					self.ident()?;
					self.ws();
				}
				if self.peek() == Some(b';') {
					self.i += 1;
					out.push((name.clone(), Entry::Class(Class { name, entries: Vec::new() })));
					continue;
				}
				self.expect(b'{')?;
				let entries = self.body(true)?;
				out.push((name.clone(), Entry::Class(Class { name, entries })));
				continue;
			}
			if self.peek() == Some(b'[') {
				self.expect(b'[')?;
				self.expect(b']')?;
				self.ws();
			}
			if self.peek() == Some(b'+') {
				self.i += 1;
			}
			self.expect(b'=')?;
			let v = self.value()?;
			self.ws();
			if self.peek() == Some(b';') {
				self.i += 1;
			}
			out.push((id, Entry::Value(v)));
		}
	}
	fn value(&mut self) -> Result<Value, String> {
		self.ws();
		match self.peek() {
			Some(b'"') => {
				self.i += 1;
				let mut out = Vec::new();
				loop {
					match self.peek() {
						None => return self.err("missing '\"'"),
						Some(b'"') if self.s.get(self.i + 1) == Some(&b'"') => {
							out.push(b'"');
							self.i += 2;
						}
						Some(b'"') => {
							self.i += 1;
							break;
						}
						Some(c) => {
							out.push(c);
							self.i += 1;
						}
					}
				}
				Ok(Value::Str(String::from_utf8_lossy(&out).into_owned()))
			}
			Some(b'{') => {
				self.i += 1;
				let mut items = Vec::new();
				loop {
					self.ws();
					match self.peek() {
						Some(b'}') => {
							self.i += 1;
							return Ok(Value::Array(items));
						}
						Some(b',') => self.i += 1,
						None => return self.err("missing '}' in array"),
						_ => items.push(self.value()?),
					}
				}
			}
			_ => {
				let start = self.i;
				while matches!(self.peek(), Some(c) if !matches!(c, b';' | b',' | b'}' | b'\n' | b'\r')) {
					self.i += 1;
				}
				let raw = String::from_utf8_lossy(&self.s[start..self.i]).trim().to_string();
				Ok(raw.parse::<f64>().map(Value::Num).unwrap_or(Value::Str(raw)))
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	#[test]
	fn parses_classes_arrays_and_comments() {
		let t = "// comment\n#include \"x.h\"\nclass A : B {\n\tx = 1.5;\n\ts = \"a\"\"b\";\n\tarr[] = {{1, 2}, {3,4}};\n\tclass C;\n\t/* block */ class D { y = abc; };\n};\n";
		let root = parse(t).unwrap();
		let a = root.class("a").unwrap();
		assert_eq!(a.value("X"), Some(&Value::Num(1.5)));
		assert_eq!(a.str("s"), Some("a\"b"));
		assert_eq!(
			a.value("arr"),
			Some(&Value::Array(vec![Value::Array(vec![Value::Num(1.0), Value::Num(2.0)]), Value::Array(vec![Value::Num(3.0), Value::Num(4.0)])]))
		);
		assert!(a.class("C").unwrap().entries.is_empty());
		assert_eq!(a.class("D").unwrap().str("y"), Some("abc"));
	}
	#[test]
	fn reads_binarized_config() {
		let z = |s: &str| [s.as_bytes(), &[0]].concat();
		// Root: no parent, 3 entries: value specularPower = 250 (float), array diffuse[] = {1, 0.5}, class Stage0 at offset `at`.
		let mut b = b"\0raP".to_vec();
		b.extend([0, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0]);
		b.extend(z(""));
		b.push(3);
		b.extend([1, 1]);
		b.extend(z("specularPower"));
		b.extend(250f32.to_le_bytes());
		b.push(2);
		b.extend(z("diffuse"));
		b.extend([2, 1]);
		b.extend(1f32.to_le_bytes());
		b.push(1);
		b.extend(0.5f32.to_le_bytes());
		b.push(0);
		b.extend(z("Stage0"));
		let at = b.len() as u32 + 4;
		b.extend(at.to_le_bytes());
		b.extend(z(""));
		b.push(1);
		b.extend([1, 0]);
		b.extend(z("texture"));
		b.extend(z("a3\\x_co.paa"));
		let c = parse_bytes(&b).unwrap();
		assert_eq!(c.value("specularPower"), Some(&Value::Num(250.0)));
		assert_eq!(c.nums("diffuse"), Some(vec![1.0, 0.5]));
		assert_eq!(c.class("stage0").unwrap().str("texture"), Some("a3\\x_co.paa"));
		assert!(parse_bytes(b"a = 1;").is_ok());
	}
	#[test]
	fn reports_line_of_error() {
		assert!(parse("class A {\n x = 1;\n").unwrap_err().contains("line 3"));
	}
}
