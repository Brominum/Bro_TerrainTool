//! Small helpers for the command line tools.
use std::collections::HashMap;

/// Split the arguments into positional values and `--name value` options. `--name` without a value gets "".
pub fn args(flags: &[&str]) -> (Vec<String>, HashMap<String, String>) {
	let mut pos = Vec::new();
	let mut opt = HashMap::new();
	let mut it = std::env::args().skip(1);
	while let Some(a) = it.next() {
		match a.strip_prefix("--") {
			Some(k) if flags.contains(&k) => {
				opt.insert(k.to_string(), String::new());
			}
			Some(k) => {
				opt.insert(k.to_string(), it.next().unwrap_or_default());
			}
			None => pos.push(a),
		}
	}
	(pos, opt)
}

/// Print the message and stop with exit code 1.
pub fn fail(msg: impl std::fmt::Display) -> ! {
	eprintln!("error: {msg}");
	std::process::exit(1)
}

pub fn hex(b: &[u8], base: usize) -> String {
	b.chunks(16)
		.enumerate()
		.map(|(i, c)| format!("{:08x}  {}\n", base + i * 16, c.iter().map(|x| format!("{x:02x}")).collect::<Vec<_>>().join(" ")))
		.collect()
}
