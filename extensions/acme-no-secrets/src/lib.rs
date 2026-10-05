//! `acme.no-secrets`: a third-party Tartan extension written in Rust and run
//! as a WebAssembly component.
//!
//! - `push.accepted` echo: `remote:` warnings for credentials a push adds;
//! - `ref.advance` gate: vetoes an advance that adds AWS keys, private keys or
//!   `.env` files outside the installation's `allow` globs;
//! - slots: `change.sidebar` findings, the `change.gate` chip and the
//!   `repo.tab` Secrets page;
//! - tool `scan` (`no_secrets_scan` over MCP): a change's findings, or a scan
//!   of a snippet before it is pushed.
//!
//! Everything it knows comes from the kernel's prefetched inputs (added
//! lines); it has no repository permission and keeps its findings in its own
//! SQLite.

pub mod detect;
pub mod store;

use serde_json::{json, Value};
use tartan_ext::gate::Decision;
use tartan_ext::serde_json;
use tartan_ext::ui::{self, Tone};
use tartan_ext::{export, host, parse_json, Error, Event, Extension, GateDecision, Json, SlotContext};

use detect::{AddedLine, Finding};
use store::{Decided, Stored};

/// At most this many `remote:` lines per push (the kernel keeps ≤ 10).
pub const ECHO_MAX_LINES: usize = 8;
/// The `scan` tool's limit on a snippet.
pub const SCAN_TEXT_MAX_BYTES: usize = 64 * 1024;

/// The added lines of a gate or echo input (`addedLines: [{path, line, text}]`).
pub fn added_lines(input: &Value) -> Vec<AddedLine> {
	input["addedLines"]
		.as_array()
		.map(|lines| {
			lines
				.iter()
				.filter_map(|l| {
					Some(AddedLine {
						path: l["path"].as_str()?.to_string(),
						line: u32::try_from(l["line"].as_u64()?).ok()?,
						text: l["text"].as_str()?.to_string(),
					})
				})
				.collect()
		})
		.unwrap_or_default()
}

/// The `allow` globs of an installation config.
pub fn allow_globs(config: &Value) -> Vec<String> {
	config["allow"]
		.as_array()
		.map(|globs| {
			globs
				.iter()
				.filter_map(|g| g.as_str().map(str::to_string))
				.collect()
		})
		.unwrap_or_default()
}

fn plural(n: usize, one: &str, many: &str) -> String {
	format!("{n} {}", if n == 1 { one } else { many })
}

/// The `ref.advance` decision for a scan of `scanned` added lines.
pub fn decide(findings: &[Finding], scanned: usize, truncated: bool) -> Decision {
	if findings.is_empty() {
		let lines = plural(scanned, "added line", "added lines");
		return if truncated {
			// Not a full scan: the kernel's onTruncated (veto) decides.
			Decision::allow(format!("no credentials in the first {lines} (input truncated)"))
		} else {
			Decision::allow(format!("no credentials in {lines}"))
		};
	}
	let listed: Vec<String> = findings.iter().take(3).map(Finding::describe).collect();
	let more = if findings.len() > 3 {
		format!(" and {} more", findings.len() - 3)
	} else {
		String::new()
	};
	let mut decision = Decision::veto(format!(
		"{} added: {}{more}. Remove them and rotate the credentials, or allow test fixtures in the installation's settings.",
		plural(findings.len(), "credential", "credentials"),
		listed.join(", "),
	));
	for f in findings {
		decision = decision.annotate(
			f.path.clone(),
			f.line,
			format!("{} ({})", f.kind.label(), f.masked),
		);
	}
	// A credential found in a truncated input is still a veto.
	decision.full_scan(true)
}

/// `remote:` lines for a push's findings.
pub fn echo_lines(findings: &[Finding]) -> Vec<String> {
	let mut lines: Vec<String> = findings
		.iter()
		.take(ECHO_MAX_LINES)
		.map(|f| format!("{}: remove it and rotate the credential", f.describe()))
		.collect();
	if findings.len() > ECHO_MAX_LINES {
		lines.push(format!(
			"+{} more; Tartan will veto the advance until they are gone",
			findings.len() - ECHO_MAX_LINES
		));
	} else if !findings.is_empty() {
		lines.push("Tartan will veto the advance until they are gone".to_string());
	}
	lines
}

fn findings_table(findings: &[Stored]) -> ui::Node {
	ui::table(
		&["Path", "Line", "Kind", "Value"],
		findings
			.iter()
			.map(|f| {
				vec![
					json!(f.path),
					json!(f.line),
					json!(f.kind.label()),
					ui::mono(f.masked.clone()),
				]
			})
			.collect(),
	)
}

/// `change.sidebar`: the change's findings and its last gate decision.
pub fn sidebar_doc(findings: &[Stored], decision: Option<&Decided>) -> Value {
	let mut children = Vec::new();
	match decision {
		Some(d) if d.verdict == "veto" => children.push(ui::alert(
			Tone::Danger,
			"Advance vetoed",
			Some(ui::text(d.message.clone())),
		)),
		Some(d) => children.push(ui::text_toned(d.message.clone(), Tone::Success)),
		None => children.push(ui::empty(
			"Not checked yet",
			Some("The no-secrets gate runs when the change is advanced."),
		)),
	}
	if !findings.is_empty() {
		children.push(findings_table(findings));
	}
	ui::doc_refreshing(ui::section("Secrets", children), &["gate.decided"])
}

/// `change.gate`: one chip.
pub fn gate_chip_doc(findings: &[Stored], decision: Option<&Decided>) -> Value {
	let chip = match decision {
		None => ui::badge("no-secrets: pending", Tone::Muted),
		Some(d) if d.verdict == "veto" => ui::badge(
			format!(
				"no-secrets: {}",
				plural(findings.len(), "credential", "credentials")
			),
			Tone::Danger,
		),
		Some(_) => ui::badge("no-secrets: clean", Tone::Success),
	};
	ui::doc(chip)
}

/// `repo.tab` Secrets: recent findings and the gate's record.
pub fn repo_tab_doc(findings: &[Stored], decisions: i64, vetoes: i64) -> Value {
	let stats = ui::row(vec![
		ui::stat("Findings (recent)", findings.len() as f64),
		ui::stat("Gate runs", decisions as f64),
		ui::stat("Vetoes", vetoes as f64),
	]);
	let body = if findings.is_empty() {
		ui::empty("No credentials found", Some("Pushes and advances into this repository are scanned for AWS keys, private keys and .env files."))
	} else {
		ui::table(
			&["Path", "Line", "Kind", "Value", "Seen in", "Change"],
			findings
				.iter()
				.map(|f| {
					vec![
						json!(f.path),
						json!(f.line),
						json!(f.kind.label()),
						ui::mono(f.masked.clone()),
						json!(if f.source == "gate" { "advance" } else { "push" }),
						json!(f.change_id.clone().unwrap_or_else(|| "—".to_string())),
					]
				})
				.collect(),
		)
	};
	ui::doc(ui::stack(vec![ui::heading("Secrets", 2), stats, body]))
}

fn finding_json(f: &Finding) -> Value {
	json!({ "path": f.path, "line": f.line, "kind": f.kind.as_str(), "value": f.masked })
}

fn stored_json(f: &Stored) -> Value {
	json!({ "path": f.path, "line": f.line, "kind": f.kind.as_str(), "value": f.masked, "source": f.source })
}

/// The `scan` tool: a snippet's findings (`text`), else a change's.
pub fn scan_tool(args: &Value, allow: &[String]) -> Result<Value, Error> {
	let change_id = args["changeId"]
		.as_str()
		.ok_or_else(|| Error::invalid("changeId is required"))?;
	if let Some(text) = args["text"].as_str() {
		if text.len() > SCAN_TEXT_MAX_BYTES {
			return Err(Error::invalid(format!(
				"text is limited to {SCAN_TEXT_MAX_BYTES} bytes"
			)));
		}
		let path = args["path"].as_str().unwrap_or("snippet");
		let found = detect::scan(&detect::lines_of(path, text), allow);
		return Ok(json!({
			"changeId": change_id,
			"scanned": "text",
			"clean": found.is_empty(),
			"findings": found.iter().map(finding_json).collect::<Vec<_>>(),
		}));
	}
	let stored = store::for_change(change_id)?;
	let decision = store::last_decision(change_id)?;
	Ok(json!({
		"changeId": change_id,
		"scanned": "change",
		"clean": stored.is_empty(),
		"verdict": decision.as_ref().map(|d| d.verdict.clone()),
		"findings": stored.iter().map(stored_json).collect::<Vec<_>>(),
	}))
}

fn change_of(ctx: &SlotContext) -> Option<String> {
	ctx.entity
		.as_ref()
		.filter(|e| e.kind == "change")
		.map(|e| e.id.clone())
}

struct NoSecrets;

impl Extension for NoSecrets {
	fn gate(point: String, input: Json, _ctx: SlotContext) -> Result<GateDecision, Error> {
		if point != "ref.advance" {
			return Err(Error::not_found(format!("gate {point}")));
		}
		let input = parse_json(&input)?;
		let lines = added_lines(&input);
		let truncated = input["truncated"].as_bool().unwrap_or(false);
		let findings = detect::scan(&lines, &allow_globs(&host::config()));
		let decision = decide(&findings, lines.len(), truncated).build();
		// Replays are advisory: they never write the change's record.
		if !input["advisory"].as_bool().unwrap_or(false) {
			let verdict = match decision.verdict {
				tartan_ext::Verdict::Allow => "allow",
				tartan_ext::Verdict::Advise => "advise",
				tartan_ext::Verdict::Veto => "veto",
			};
			store::record_gate(
				input["changeId"].as_str(),
				&point,
				&findings,
				verdict,
				&decision.message,
			)?;
		}
		host::info(&format!("{point}: {}", decision.message));
		Ok(decision)
	}

	fn echo(event: Event, input: Json) -> Result<Vec<String>, Error> {
		let input = parse_json(&input)?;
		let findings = detect::scan(&added_lines(&input), &allow_globs(&host::config()));
		if findings.is_empty() {
			return Ok(Vec::new());
		}
		let data = parse_json(&event.data).unwrap_or(Value::Null);
		let lane = data["target"].as_str().filter(|t| *t != "repo");
		store::record_push(lane, &findings)?;
		Ok(echo_lines(&findings))
	}

	fn render(slot: String, ctx: SlotContext, _props: Json) -> Result<Json, Error> {
		let doc = match slot.as_str() {
			"findings" | "no-secrets" => {
				let change =
					change_of(&ctx).ok_or_else(|| Error::invalid("a change slot needs the change"))?;
				let findings = store::for_change(&change)?;
				let decision = store::last_decision(&change)?;
				if slot == "findings" {
					sidebar_doc(&findings, decision.as_ref())
				} else {
					gate_chip_doc(&findings, decision.as_ref())
				}
			}
			"secrets" => {
				let (decisions, vetoes) = store::decision_counts()?;
				repo_tab_doc(&store::recent(50)?, decisions, vetoes)
			}
			_ => return Err(Error::not_found(format!("slot {slot}"))),
		};
		Ok(doc.to_string())
	}

	fn call_tool(name: String, args: Json, _ctx: SlotContext) -> Result<Json, Error> {
		if name != "scan" {
			return Err(Error::not_found(format!("tool {name}")));
		}
		Ok(scan_tool(&parse_json(&args)?, &allow_globs(&host::config()))?.to_string())
	}
}

export!(NoSecrets);

#[cfg(test)]
mod tests {
	use super::*;
	use detect::Kind;
	use tartan_ext::Verdict;

	const ACCESS: &str = "AKIAIOSFODNN7EXAMPLE";

	fn finding(path: &str, line: u32, kind: Kind) -> Finding {
		Finding {
			path: path.into(),
			line,
			kind,
			masked: "AKIA…MPLE".into(),
		}
	}

	fn stored(path: &str, kind: Kind, source: &str) -> Stored {
		Stored {
			change_id: Some("ch_1".into()),
			lane_id: None,
			path: path.into(),
			line: 3,
			kind,
			masked: "AKIA…MPLE".into(),
			source: source.into(),
			at: 1,
		}
	}

	#[test]
	fn parses_added_lines_and_skips_malformed_ones() {
		let input = json!({ "addedLines": [
			{ "path": "a.env", "line": 1, "text": "X=1" },
			{ "path": "b", "line": -1, "text": "bad" },
			{ "path": "c", "text": "no line" },
		], "truncated": false });
		assert_eq!(
			added_lines(&input),
			vec![AddedLine {
				path: "a.env".into(),
				line: 1,
				text: "X=1".into()
			}]
		);
		assert!(added_lines(&json!({})).is_empty());
		assert_eq!(
			allow_globs(&json!({ "allow": ["fixtures/**", 3] })),
			vec!["fixtures/**".to_string()]
		);
		assert!(allow_globs(&json!({})).is_empty());
	}

	#[test]
	fn a_clean_change_is_allowed() {
		let d = decide(&[], 12, false).build();
		assert!(matches!(d.verdict, Verdict::Allow));
		assert_eq!(d.message, "no credentials in 12 added lines");
		assert!(!d.full_scan);
		let t = decide(&[], 1, true).build();
		assert!(matches!(t.verdict, Verdict::Allow));
		assert!(t.message.contains("truncated"));
		assert!(!t.full_scan, "the kernel's onTruncated decides");
	}

	#[test]
	fn credentials_veto_with_annotations() {
		let findings = vec![
			finding("config/prod.env", 1, Kind::EnvFile),
			finding("config/prod.env", 2, Kind::AwsAccessKey),
			finding("keys/id", 1, Kind::PrivateKey),
			finding("x", 9, Kind::AwsAccessKey),
		];
		let d = decide(&findings, 40, true).build();
		assert!(matches!(d.verdict, Verdict::Veto));
		assert!(d
			.message
			.starts_with("4 credentials added: .env file at config/prod.env:1"));
		assert!(d.message.contains(" and 1 more."));
		assert!(d.full_scan, "a found credential vetoes even a truncated input");
		let annotations: Vec<Value> = serde_json::from_str(&d.annotations).unwrap();
		assert_eq!(annotations.len(), 4);
		assert_eq!(
			annotations[1],
			json!({ "path": "config/prod.env", "line": 2, "text": "AWS access key (AKIA…MPLE)" })
		);
	}

	#[test]
	fn echo_lines_warn_and_cap() {
		assert!(echo_lines(&[]).is_empty());
		let one = echo_lines(&[finding("a.env", 2, Kind::AwsAccessKey)]);
		assert_eq!(
			one[0],
			"AWS access key at a.env:2 (AKIA…MPLE): remove it and rotate the credential"
		);
		assert_eq!(one.len(), 2);
		let many: Vec<_> = (1..=20).map(|n| finding("dump", n, Kind::AwsAccessKey)).collect();
		let lines = echo_lines(&many);
		assert_eq!(lines.len(), ECHO_MAX_LINES + 1);
		assert!(lines.last().unwrap().starts_with("+12 more"));
	}

	#[test]
	fn panels_show_the_decision_and_findings() {
		let vetoed = Decided {
			verdict: "veto".into(),
			message: "1 credential added".into(),
			at: 1,
		};
		let doc = sidebar_doc(&[stored("a.env", Kind::AwsAccessKey, "gate")], Some(&vetoed));
		assert_eq!(doc["root"]["t"], "section");
		assert_eq!(doc["root"]["children"][0]["t"], "alert");
		assert_eq!(doc["root"]["children"][1]["rows"][0][0], "a.env");
		assert_eq!(doc["refreshOn"], json!(["gate.decided"]));
		assert_eq!(sidebar_doc(&[], None)["root"]["children"][0]["t"], "empty");
		assert_eq!(gate_chip_doc(&[], None)["root"]["text"], "no-secrets: pending");
		let chip = gate_chip_doc(&[stored("a", Kind::PrivateKey, "gate")], Some(&vetoed));
		assert_eq!(
			chip["root"],
			json!({ "t": "badge", "text": "no-secrets: 1 credential", "tone": "danger" })
		);
		let allowed = Decided {
			verdict: "allow".into(),
			message: "ok".into(),
			at: 1,
		};
		assert_eq!(gate_chip_doc(&[], Some(&allowed))["root"]["tone"], "success");
		let tab = repo_tab_doc(&[stored("a", Kind::EnvFile, "echo")], 41, 2);
		assert_eq!(tab["root"]["children"][1]["children"][2]["value"], 2.0);
		assert_eq!(tab["root"]["children"][2]["rows"][0][4], "push");
		assert_eq!(repo_tab_doc(&[], 0, 0)["root"]["children"][2]["t"], "empty");
	}

	#[test]
	fn the_scan_tool_scans_snippets() {
		let out = scan_tool(
			&json!({ "changeId": "ch_1", "text": format!("x\nKEY={ACCESS}\n"), "path": "s.txt" }),
			&[],
		)
		.unwrap();
		assert_eq!(out["clean"], false);
		assert_eq!(
			out["findings"][0],
			json!({ "path": "s.txt", "line": 2, "kind": "aws-access-key", "value": "AKIA…MPLE" })
		);
		assert!(!out.to_string().contains(ACCESS), "never echoes the credential");
		let clean = scan_tool(&json!({ "changeId": "ch_1", "text": "nothing" }), &[]).unwrap();
		assert_eq!(clean["clean"], true);
		assert!(matches!(scan_tool(&json!({}), &[]), Err(Error::Invalid(_))));
		let big = "x".repeat(SCAN_TEXT_MAX_BYTES + 1);
		assert!(matches!(
			scan_tool(&json!({ "changeId": "c", "text": big }), &[]),
			Err(Error::Invalid(_))
		));
	}
}
