//! Credential detection over added lines. Pure: no host calls, so `cargo
//! test` covers it natively.
//!
//! Detectors:
//! - AWS access key ids: `AKIA`/`ASIA` followed by 16 of `[A-Z0-9]`, as a
//!   whole word;
//! - AWS secret access keys: a 40-character `[A-Za-z0-9/+]` token with both
//!   cases on a line that names an AWS secret (`aws_secret_access_key = …`);
//! - private keys: a PEM `-----BEGIN … PRIVATE KEY-----` header (RSA, EC,
//!   DSA, OpenSSH, PGP, encrypted, PKCS#8);
//! - `.env` files: an added `.env`, `.env.<name>` or `<name>.env` file (not
//!   `.env.example`, `.env.sample`, `.env.template`, `.env.dist`), reported
//!   once per file.
//!
//! Paths matching the installation's `allow` globs are skipped (fixtures with
//! fake keys). A finding never carries the credential itself, only a masked
//! form (`AKIA…MPLE`).

/// One added line of a change, as the kernel prefetches it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AddedLine {
	pub path: String,
	pub line: u32,
	pub text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
	AwsAccessKey,
	AwsSecretKey,
	PrivateKey,
	EnvFile,
}

impl Kind {
	pub fn as_str(self) -> &'static str {
		match self {
			Kind::AwsAccessKey => "aws-access-key",
			Kind::AwsSecretKey => "aws-secret-key",
			Kind::PrivateKey => "private-key",
			Kind::EnvFile => "env-file",
		}
	}

	pub fn label(self) -> &'static str {
		match self {
			Kind::AwsAccessKey => "AWS access key",
			Kind::AwsSecretKey => "AWS secret key",
			Kind::PrivateKey => "private key",
			Kind::EnvFile => ".env file",
		}
	}

	pub fn parse(text: &str) -> Option<Kind> {
		match text {
			"aws-access-key" => Some(Kind::AwsAccessKey),
			"aws-secret-key" => Some(Kind::AwsSecretKey),
			"private-key" => Some(Kind::PrivateKey),
			"env-file" => Some(Kind::EnvFile),
			_ => None,
		}
	}
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Finding {
	pub path: String,
	pub line: u32,
	pub kind: Kind,
	/// The credential with all but its edges masked; never the credential.
	pub masked: String,
}

impl Finding {
	/// `AWS access key at config/prod.env:3 (AKIA…MPLE)`.
	pub fn describe(&self) -> String {
		format!(
			"{} at {}:{} ({})",
			self.kind.label(),
			self.path,
			self.line,
			self.masked
		)
	}
}

/// At most this many findings per scan (a dump of keys is one problem).
pub const MAX_FINDINGS: usize = 200;

const ACCESS_KEY_PREFIXES: [&str; 2] = ["AKIA", "ASIA"];
const ACCESS_KEY_LEN: usize = 20;
const SECRET_KEY_LEN: usize = 40;
const ENV_EXAMPLE_SUFFIXES: [&str; 5] = ["example", "sample", "template", "dist", "defaults"];

fn is_word_byte(b: u8) -> bool {
	b.is_ascii_alphanumeric() || b == b'_'
}

fn is_secret_byte(b: u8) -> bool {
	b.is_ascii_alphanumeric() || b == b'/' || b == b'+'
}

/// `AKIA…MPLE`: the first `head` and last `tail` characters.
pub fn mask(secret: &str, head: usize, tail: usize) -> String {
	let chars: Vec<char> = secret.chars().collect();
	if chars.len() <= head + tail {
		return "…".to_string();
	}
	let start: String = chars[..head].iter().collect();
	let end: String = chars[chars.len() - tail..].iter().collect();
	format!("{start}…{end}")
}

/// Every AWS access key id on a line.
pub fn aws_access_keys(text: &str) -> Vec<String> {
	let bytes = text.as_bytes();
	let mut found = Vec::new();
	let mut i = 0;
	while i + ACCESS_KEY_LEN <= bytes.len() {
		let window = &bytes[i..i + ACCESS_KEY_LEN];
		let starts_word = i == 0 || !is_word_byte(bytes[i - 1]);
		let ends_word = i + ACCESS_KEY_LEN == bytes.len() || !is_word_byte(bytes[i + ACCESS_KEY_LEN]);
		let prefixed = ACCESS_KEY_PREFIXES
			.iter()
			.any(|p| window.starts_with(p.as_bytes()));
		let body_ok = window[4..]
			.iter()
			.all(|b| b.is_ascii_uppercase() || b.is_ascii_digit());
		if starts_word && ends_word && prefixed && body_ok {
			found.push(String::from_utf8_lossy(window).into_owned());
			i += ACCESS_KEY_LEN;
		} else {
			i += 1;
		}
	}
	found
}

/// Every AWS secret access key on a line that names one.
pub fn aws_secret_keys(text: &str) -> Vec<String> {
	let lower = text.to_ascii_lowercase();
	if !(lower.contains("aws") && lower.contains("secret")) {
		return Vec::new();
	}
	let bytes = text.as_bytes();
	let mut found = Vec::new();
	let mut i = 0;
	while i < bytes.len() {
		if !is_secret_byte(bytes[i]) {
			i += 1;
			continue;
		}
		let start = i;
		while i < bytes.len() && is_secret_byte(bytes[i]) {
			i += 1;
		}
		let token = &text[start..i];
		let mixed_case =
			token.bytes().any(|b| b.is_ascii_uppercase()) && token.bytes().any(|b| b.is_ascii_lowercase());
		if token.len() == SECRET_KEY_LEN && mixed_case {
			found.push(token.to_string());
		}
	}
	found
}

/// The PEM header of a private key on a line, if any.
pub fn private_key_header(text: &str) -> Option<String> {
	let start = text.find("-----BEGIN ")?;
	let rest = &text[start + "-----BEGIN ".len()..];
	let end = rest.find("-----")?;
	let label = &rest[..end];
	let known = label == "PRIVATE KEY" || label.ends_with(" PRIVATE KEY") || label == "PGP PRIVATE KEY BLOCK";
	if known {
		Some(format!("-----BEGIN {label}-----"))
	} else {
		None
	}
}

/// True for an added `.env` file that is not an example.
pub fn is_env_file(path: &str) -> bool {
	let name = path.rsplit('/').next().unwrap_or(path);
	if name == ".env" {
		return true;
	}
	if let Some(suffix) = name.strip_prefix(".env.") {
		return !suffix.is_empty() && !ENV_EXAMPLE_SUFFIXES.contains(&suffix);
	}
	if let Some(stem) = name.strip_suffix(".env") {
		return !stem.is_empty() && !ENV_EXAMPLE_SUFFIXES.contains(&stem);
	}
	false
}

/// Glob match over a whole path: `**` crosses directories, `*` and `?` do
/// not; a pattern ending in `/` matches everything below it.
pub fn glob_match(pattern: &str, path: &str) -> bool {
	let pattern = if let Some(dir) = pattern.strip_suffix('/') {
		format!("{dir}/**")
	} else {
		pattern.to_string()
	};
	matches(pattern.as_bytes(), path.as_bytes())
}

fn matches(p: &[u8], s: &[u8]) -> bool {
	match p.first() {
		None => s.is_empty(),
		Some(b'*') if p.get(1) == Some(&b'*') => {
			// `**/` also matches zero directories.
			let rest = &p[2..];
			let rest_after_slash = rest.strip_prefix(b"/").unwrap_or(rest);
			if matches(rest_after_slash, s) {
				return true;
			}
			(0..s.len()).any(|i| matches(rest, &s[i + 1..]) || matches(rest_after_slash, &s[i + 1..]))
		}
		Some(b'*') => {
			let rest = &p[1..];
			if matches(rest, s) {
				return true;
			}
			for i in 0..s.len() {
				if s[i] == b'/' {
					return false;
				}
				if matches(rest, &s[i + 1..]) {
					return true;
				}
			}
			false
		}
		Some(b'?') => !s.is_empty() && s[0] != b'/' && matches(&p[1..], &s[1..]),
		Some(c) => !s.is_empty() && s[0] == *c && matches(&p[1..], &s[1..]),
	}
}

/// Scans added lines; paths matching an `allow` glob are skipped.
pub fn scan(lines: &[AddedLine], allow: &[String]) -> Vec<Finding> {
	let mut findings = Vec::new();
	let mut env_files: Vec<&str> = Vec::new();
	for added in lines {
		if findings.len() >= MAX_FINDINGS {
			break;
		}
		if allow.iter().any(|g| glob_match(g, &added.path)) {
			continue;
		}
		if is_env_file(&added.path) && !env_files.contains(&added.path.as_str()) {
			env_files.push(&added.path);
			findings.push(Finding {
				path: added.path.clone(),
				line: added.line,
				kind: Kind::EnvFile,
				masked: added.path.rsplit('/').next().unwrap_or(&added.path).to_string(),
			});
		}
		for key in aws_access_keys(&added.text) {
			findings.push(Finding {
				path: added.path.clone(),
				line: added.line,
				kind: Kind::AwsAccessKey,
				masked: mask(&key, 4, 4),
			});
		}
		for key in aws_secret_keys(&added.text) {
			findings.push(Finding {
				path: added.path.clone(),
				line: added.line,
				kind: Kind::AwsSecretKey,
				masked: mask(&key, 4, 2),
			});
		}
		if let Some(header) = private_key_header(&added.text) {
			findings.push(Finding {
				path: added.path.clone(),
				line: added.line,
				kind: Kind::PrivateKey,
				masked: header,
			});
		}
	}
	findings.truncate(MAX_FINDINGS);
	findings
}

/// Splits free text (the `scan` tool's `text`) into numbered lines.
pub fn lines_of(path: &str, text: &str) -> Vec<AddedLine> {
	text.lines()
		.enumerate()
		.map(|(i, line)| AddedLine {
			path: path.to_string(),
			line: u32::try_from(i + 1).unwrap_or(u32::MAX),
			text: line.to_string(),
		})
		.collect()
}

#[cfg(test)]
mod tests {
	use super::*;

	// AWS's documented example credentials (not real keys).
	const ACCESS: &str = "AKIAIOSFODNN7EXAMPLE";
	const SECRET: &str = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

	fn line(path: &str, n: u32, text: &str) -> AddedLine {
		AddedLine {
			path: path.into(),
			line: n,
			text: text.into(),
		}
	}

	#[test]
	fn finds_aws_access_keys_as_whole_words() {
		assert_eq!(
			aws_access_keys(&format!("key = \"{ACCESS}\"")),
			vec![ACCESS.to_string()]
		);
		assert_eq!(
			aws_access_keys(&format!("{ACCESS},ASIAABCDEFGHIJKLMNOP")).len(),
			2
		);
		assert!(aws_access_keys(&format!("X{ACCESS}")).is_empty(), "inside a word");
		assert!(aws_access_keys(&format!("{ACCESS}9")).is_empty(), "longer token");
		assert!(
			aws_access_keys("AKIAiosfodnn7example").is_empty(),
			"lowercase body"
		);
		assert!(aws_access_keys("AKIA1234").is_empty(), "too short");
		assert!(
			aws_access_keys("AIDAIOSFODNN7EXAMPLE").is_empty(),
			"a user id, not a key"
		);
	}

	#[test]
	fn finds_aws_secret_keys_only_where_named() {
		assert_eq!(
			aws_secret_keys(&format!("aws_secret_access_key = {SECRET}")),
			vec![SECRET.to_string()]
		);
		assert_eq!(aws_secret_keys(&format!("AWS_SECRET={SECRET}")).len(), 1);
		assert!(
			aws_secret_keys(&format!("token = {SECRET}")).is_empty(),
			"no AWS secret named"
		);
		let sha = "0123456789abcdef0123456789abcdef01234567";
		assert!(
			aws_secret_keys(&format!("aws_secret_sha = {sha}")).is_empty(),
			"single-case hex"
		);
		assert!(
			aws_secret_keys(&format!("aws secret {SECRET}X")).is_empty(),
			"41 characters"
		);
	}

	#[test]
	fn finds_private_key_headers() {
		for label in [
			"RSA PRIVATE KEY",
			"OPENSSH PRIVATE KEY",
			"EC PRIVATE KEY",
			"PRIVATE KEY",
			"ENCRYPTED PRIVATE KEY",
			"PGP PRIVATE KEY BLOCK",
		] {
			let text = format!("-----BEGIN {label}-----");
			assert_eq!(private_key_header(&text), Some(text.clone()), "{label}");
		}
		assert_eq!(private_key_header("-----BEGIN PUBLIC KEY-----"), None);
		assert_eq!(private_key_header("-----BEGIN CERTIFICATE-----"), None);
		assert_eq!(private_key_header("BEGIN RSA PRIVATE KEY"), None);
	}

	#[test]
	fn env_files_but_not_examples() {
		for path in [".env", "app/.env", ".env.production", "config/prod.env"] {
			assert!(is_env_file(path), "{path}");
		}
		for path in [
			".env.example",
			"a/.env.sample",
			".env.template",
			"example.env",
			".envrc",
			"env.ts",
			".env.",
		] {
			assert!(!is_env_file(path), "{path}");
		}
	}

	#[test]
	fn globs() {
		assert!(glob_match("fixtures/**", "fixtures/a/b.env"));
		assert!(glob_match("fixtures/", "fixtures/keys/id_rsa"));
		assert!(glob_match("**/testdata/**", "svc/api/testdata/x.pem"));
		assert!(glob_match("**/testdata/**", "testdata/x.pem"));
		assert!(glob_match("*.pem", "x.pem"));
		assert!(!glob_match("*.pem", "keys/x.pem"), "* stays in one directory");
		assert!(glob_match("keys/?.pem", "keys/a.pem"));
		assert!(!glob_match("keys/?.pem", "keys/ab.pem"));
		assert!(glob_match(
			"services/*/fixtures/**",
			"services/api/fixtures/aws.env"
		));
		assert!(!glob_match("services/*/fixtures/**", "services/api/src/aws.env"));
	}

	#[test]
	fn scan_finds_each_kind_once_and_masks_them() {
		let lines = vec![
			line("config/prod.env", 1, "REGION=eu-west-1"),
			line("config/prod.env", 2, &format!("AWS_ACCESS_KEY_ID={ACCESS}")),
			line("config/prod.env", 3, &format!("AWS_SECRET_ACCESS_KEY={SECRET}")),
			line("keys/deploy", 1, "-----BEGIN OPENSSH PRIVATE KEY-----"),
			line("src/main.rs", 10, "fn main() {}"),
		];
		let found = scan(&lines, &[]);
		let kinds: Vec<_> = found.iter().map(|f| (f.kind, f.path.as_str(), f.line)).collect();
		assert_eq!(
			kinds,
			vec![
				(Kind::EnvFile, "config/prod.env", 1),
				(Kind::AwsAccessKey, "config/prod.env", 2),
				(Kind::AwsSecretKey, "config/prod.env", 3),
				(Kind::PrivateKey, "keys/deploy", 1),
			]
		);
		assert_eq!(found[1].masked, "AKIA…MPLE");
		assert_eq!(found[2].masked, "wJal…EY");
		for f in &found {
			assert!(
				!f.masked.contains(ACCESS) && !f.masked.contains(SECRET),
				"never the credential"
			);
		}
		assert_eq!(
			found[1].describe(),
			"AWS access key at config/prod.env:2 (AKIA…MPLE)"
		);
	}

	#[test]
	fn allowlisted_paths_are_skipped() {
		let lines = vec![
			line("fixtures/aws.env", 1, &format!("KEY={ACCESS}")),
			line("src/config.ts", 4, &format!("const key = \"{ACCESS}\";")),
		];
		let found = scan(&lines, &["fixtures/**".to_string()]);
		assert_eq!(found.len(), 1);
		assert_eq!(found[0].path, "src/config.ts");
	}

	#[test]
	fn clean_lines_find_nothing_and_findings_are_capped() {
		assert!(scan(&[line("README.md", 1, "no secrets here")], &[]).is_empty());
		let many: Vec<_> = (1..=300).map(|n| line("dump.txt", n, ACCESS)).collect();
		assert_eq!(scan(&many, &[]).len(), MAX_FINDINGS);
	}

	#[test]
	fn free_text_becomes_numbered_lines() {
		let lines = lines_of("snippet", "a\nb\n");
		assert_eq!(lines, vec![line("snippet", 1, "a"), line("snippet", 2, "b")]);
	}

	#[test]
	fn masking_short_values_hides_everything() {
		assert_eq!(mask("abc", 4, 4), "…");
		assert_eq!(mask("ABCDEFGHIJ", 2, 2), "AB…IJ");
	}

	#[test]
	fn kinds_round_trip() {
		for kind in [
			Kind::AwsAccessKey,
			Kind::AwsSecretKey,
			Kind::PrivateKey,
			Kind::EnvFile,
		] {
			assert_eq!(Kind::parse(kind.as_str()), Some(kind));
		}
		assert_eq!(Kind::parse("nope"), None);
	}
}
