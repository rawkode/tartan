//! Issues without the host: argument checks, JSON shapes and the Issues tab
//! document. Pure, so `cargo test` covers it on the host target.

use serde_json::{json, Value};
use tartan_ext::serde_json;
use tartan_ext::ui::{self, Tone};
use tartan_ext::{Actor, ActorKind, Error};

/// A title's limit, in characters (the tool schema's `maxLength`).
pub const TITLE_MAX_CHARS: usize = 200;
/// A body's limit, in characters.
pub const BODY_MAX_CHARS: usize = 20_000;
pub const LIST_DEFAULT_LIMIT: u32 = 30;
pub const LIST_MAX_LIMIT: u32 = 100;
/// The Issues tab shows at most this many issues.
pub const TAB_LIMIT: u32 = 100;
/// The largest issue number a tool accepts.
pub const NUMBER_MAX: u32 = i32::MAX as u32;
/// A project's root path, in bytes: the walk's 12 levels of the longest names.
pub const PROJECT_MAX_BYTES: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
	Open,
	Closed,
}

impl State {
	pub fn as_str(self) -> &'static str {
		match self {
			State::Open => "open",
			State::Closed => "closed",
		}
	}

	pub fn parse(s: &str) -> Option<State> {
		match s {
			"open" => Some(State::Open),
			"closed" => Some(State::Closed),
			_ => None,
		}
	}
}

/// The `list` tool's `state`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Filter {
	Only(State),
	All,
}

impl Filter {
	pub fn as_str(self) -> &'static str {
		match self {
			Filter::Only(s) => s.as_str(),
			Filter::All => "all",
		}
	}
}

/// Who opened an issue: the actor the host gave the call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Author {
	pub kind: String,
	pub id: String,
	pub on_behalf_of: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Issue {
	pub number: u32,
	pub title: String,
	pub body: String,
	/// The project's root path; None for an issue of the whole repository.
	pub project: Option<String>,
	pub state: State,
	pub author: Author,
	pub created_at: u64,
	pub updated_at: u64,
	pub closed_at: Option<u64>,
}

/// A checked `create` input.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewIssue {
	pub title: String,
	pub body: String,
}

/// `create` arguments (tool args or the tab's form payload): a trimmed,
/// non-empty one-line title and an optional body.
pub fn new_issue(args: &Value) -> Result<NewIssue, Error> {
	let title = match &args["title"] {
		Value::String(s) => s.trim(),
		Value::Null => "",
		_ => return Err(Error::invalid("title is a string")),
	};
	if title.is_empty() {
		return Err(Error::invalid("title is required"));
	}
	if title.chars().count() > TITLE_MAX_CHARS {
		return Err(Error::invalid(format!(
			"title is limited to {TITLE_MAX_CHARS} characters"
		)));
	}
	if title.contains(['\n', '\r']) {
		return Err(Error::invalid("title is one line"));
	}
	let body = match &args["body"] {
		Value::String(s) => s.trim_end(),
		Value::Null => "",
		_ => return Err(Error::invalid("body is a string")),
	};
	if body.chars().count() > BODY_MAX_CHARS {
		return Err(Error::invalid(format!(
			"body is limited to {BODY_MAX_CHARS} characters"
		)));
	}
	Ok(NewIssue {
		title: title.to_string(),
		body: body.to_string(),
	})
}

/// The optional `project` argument of every tool: a project's root path, as
/// the kernel passes it. The extension cannot see the project graph, so it
/// checks the shape only, and any directory git can hold has to pass: a
/// backslash or a newline in a name is a project like any other. Only tools
/// read it; the tab's form never sets one.
pub fn project_arg(args: &Value) -> Result<Option<String>, Error> {
	let root = match &args["project"] {
		Value::Null => return Ok(None),
		Value::String(s) => s.as_str(),
		_ => return Err(Error::invalid("project is a string")),
	};
	let clean = !root.is_empty()
		&& root.len() <= PROJECT_MAX_BYTES
		&& !root.contains('\0')
		&& root.split('/').all(|s| !s.is_empty() && s != "." && s != "..");
	if !clean {
		return Err(Error::invalid(
			"project is a repository-relative root path, like crates/lsp",
		));
	}
	Ok(Some(root.to_string()))
}

/// The `number` argument of `get`, `close` and `reopen`.
pub fn number_arg(args: &Value) -> Result<u32, Error> {
	args["number"]
		.as_u64()
		.and_then(|n| u32::try_from(n).ok())
		.filter(|n| (1..=NUMBER_MAX).contains(n))
		.ok_or_else(|| Error::invalid(format!("number is an integer from 1 to {NUMBER_MAX}")))
}

/// The `list` tool's `state` (default open) and `limit` (default 30, ≤ 100).
pub fn list_args(args: &Value) -> Result<(Filter, u32), Error> {
	let filter = match &args["state"] {
		Value::Null => Filter::Only(State::Open),
		Value::String(s) if s == "all" => Filter::All,
		Value::String(s) => {
			Filter::Only(State::parse(s).ok_or_else(|| Error::invalid("state is open, closed or all"))?)
		}
		_ => return Err(Error::invalid("state is open, closed or all")),
	};
	let limit = match &args["limit"] {
		Value::Null => LIST_DEFAULT_LIMIT,
		v => v
			.as_u64()
			.and_then(|n| u32::try_from(n).ok())
			.filter(|n| (1..=LIST_MAX_LIMIT).contains(n))
			.ok_or_else(|| Error::invalid(format!("limit is an integer from 1 to {LIST_MAX_LIMIT}")))?,
	};
	Ok((filter, limit))
}

pub fn actor_kind(kind: ActorKind) -> &'static str {
	match kind {
		ActorKind::User => "user",
		ActorKind::Agent => "agent",
		ActorKind::Ext => "ext",
		ActorKind::System => "system",
	}
}

/// The author of a new issue: the call's actor (a tool's caller, a slot's
/// viewer). An anonymous call cannot open one.
pub fn author_of(actor: Option<&Actor>) -> Result<Author, Error> {
	let actor = actor.ok_or_else(|| Error::denied("an issue needs a signed-in author"))?;
	Ok(Author {
		kind: actor_kind(actor.kind).to_string(),
		id: actor.id.clone(),
		on_behalf_of: actor.on_behalf_of.clone(),
	})
}

fn author_json(a: &Author) -> Value {
	let mut v = json!({ "kind": a.kind, "id": a.id });
	if let Some(user) = &a.on_behalf_of {
		v["onBehalfOf"] = json!(user);
	}
	v
}

/// An issue as a tool returns it; `list` leaves the body out.
pub fn issue_json(i: &Issue, with_body: bool) -> Value {
	let mut v = json!({
		"number": i.number,
		"title": i.title,
		"project": i.project,
		"state": i.state.as_str(),
		"author": author_json(&i.author),
		"createdAt": i.created_at,
		"updatedAt": i.updated_at,
		"closedAt": i.closed_at,
	});
	if with_body {
		v["body"] = json!(i.body);
	}
	v
}

/// `YYYY-MM-DD` (UTC) of a Unix time in milliseconds.
pub fn date(ms: u64) -> String {
	// Howard Hinnant's civil_from_days.
	let z = (ms / 86_400_000) as i64 + 719_468;
	let era = z.div_euclid(146_097);
	let doe = z - era * 146_097;
	let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
	let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	let mp = (5 * doy + 2) / 153;
	let day = doy - (153 * mp + 2) / 5 + 1;
	let month = if mp < 10 { mp + 3 } else { mp - 9 };
	let year = yoe + era * 400 + i64::from(month <= 2);
	format!("{year:04}-{month:02}-{day:02}")
}

fn author_text(a: &Author) -> String {
	match &a.on_behalf_of {
		Some(user) => format!("{} (for {user})", a.id),
		None => a.id.clone(),
	}
}

/// The action id of the tab's form.
pub const CREATE_ACTION: &str = "create";

/// The form that opens an issue from the tab.
pub fn create_form() -> ui::Node {
	ui::form(
		vec![
			ui::input("title", Some("Title"), true),
			ui::textarea("body", Some("Description (Markdown)"), false),
		],
		"Open issue",
		ui::action(CREATE_ACTION, None, None),
	)
}

/// `repo.tab` Issues: counts, the newest issues and the new-issue form.
pub fn tab_doc(issues: &[Issue], open: i64, closed: i64) -> Value {
	let stats = ui::row(vec![
		ui::stat("Open", open as f64),
		ui::stat("Closed", closed as f64),
	]);
	let list = if issues.is_empty() {
		ui::empty(
			"No issues yet",
			Some("Open the first one below, or with the issues_create tool over MCP."),
		)
	} else {
		ui::table(
			&["#", "Title", "Project", "State", "Author", "Updated"],
			issues
				.iter()
				.map(|i| {
					vec![
						json!(format!("#{}", i.number)),
						json!(i.title),
						i.project.as_deref().map_or(json!("—"), ui::mono),
						match i.state {
							State::Open => ui::badge("open", Tone::Success),
							State::Closed => ui::badge("closed", Tone::Muted),
						},
						ui::mono(author_text(&i.author)),
						json!(date(i.updated_at)),
					]
				})
				.collect(),
		)
	};
	ui::doc(ui::stack(vec![
		ui::heading("Issues", 2),
		stats,
		list,
		ui::section("New issue", vec![create_form()]),
	]))
}

/// The tab action's result: a toast and a re-render of the tab.
pub fn created_result(issue: &Issue) -> Value {
	let mut r = ui::result::toast(Tone::Success, &format!("Opened #{}", issue.number));
	r["refresh"] = json!(["issues"]);
	r
}

/// A refused form submit, shown as a toast instead of an error.
pub fn refused_result(message: &str) -> Value {
	ui::result::toast(Tone::Danger, message)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn author() -> Author {
		Author {
			kind: "user".into(),
			id: "usr_dev".into(),
			on_behalf_of: None,
		}
	}

	fn issue(number: u32, state: State) -> Issue {
		Issue {
			number,
			title: format!("Issue {number}"),
			body: "body".into(),
			project: None,
			state,
			author: author(),
			created_at: 1_700_000_000_000,
			updated_at: 1_762_128_000_000,
			closed_at: None,
		}
	}

	#[test]
	fn new_issues_are_trimmed_and_bounded() {
		assert_eq!(
			new_issue(&json!({ "title": "  Crash on push ", "body": "steps\n\n" })).unwrap(),
			NewIssue {
				title: "Crash on push".into(),
				body: "steps".into()
			}
		);
		assert_eq!(new_issue(&json!({ "title": "x" })).unwrap().body, "");
		for bad in [
			json!({}),
			json!({ "title": "   " }),
			json!({ "title": 3 }),
			json!({ "title": "a\nb" }),
			json!({ "title": "x".repeat(TITLE_MAX_CHARS + 1) }),
			json!({ "title": "x", "body": 1 }),
			json!({ "title": "x", "body": "b".repeat(BODY_MAX_CHARS + 1) }),
		] {
			assert!(matches!(new_issue(&bad), Err(Error::Invalid(_))), "{bad}");
		}
		// Characters, not bytes.
		assert!(new_issue(&json!({ "title": "é".repeat(TITLE_MAX_CHARS) })).is_ok());
	}

	#[test]
	fn numbers_and_list_arguments() {
		assert_eq!(number_arg(&json!({ "number": 7 })).unwrap(), 7);
		for bad in [
			json!({}),
			json!({ "number": 0 }),
			json!({ "number": -1 }),
			json!({ "number": "7" }),
		] {
			assert!(matches!(number_arg(&bad), Err(Error::Invalid(_))), "{bad}");
		}
		assert!(number_arg(&json!({ "number": u64::from(NUMBER_MAX) + 1 })).is_err());
		assert_eq!(
			list_args(&json!({})).unwrap(),
			(Filter::Only(State::Open), LIST_DEFAULT_LIMIT)
		);
		assert_eq!(
			list_args(&json!({ "state": "closed", "limit": 5 })).unwrap(),
			(Filter::Only(State::Closed), 5)
		);
		assert_eq!(list_args(&json!({ "state": "all" })).unwrap().0, Filter::All);
		for bad in [
			json!({ "state": "merged" }),
			json!({ "state": 1 }),
			json!({ "limit": 0 }),
			json!({ "limit": 101 }),
		] {
			assert!(matches!(list_args(&bad), Err(Error::Invalid(_))), "{bad}");
		}
	}

	#[test]
	fn the_author_is_the_calls_actor() {
		let agent = Actor {
			kind: ActorKind::Agent,
			id: "agt_1".into(),
			on_behalf_of: Some("usr_dev".into()),
		};
		let a = author_of(Some(&agent)).unwrap();
		assert_eq!(a.kind, "agent");
		assert_eq!(a.on_behalf_of.as_deref(), Some("usr_dev"));
		assert!(matches!(author_of(None), Err(Error::Denied(_))));
	}

	#[test]
	fn issue_json_has_the_body_only_when_asked() {
		let i = issue(3, State::Open);
		let full = issue_json(&i, true);
		assert_eq!(full["number"], 3);
		assert_eq!(full["state"], "open");
		assert_eq!(full["project"], Value::Null);
		assert_eq!(full["author"], json!({ "kind": "user", "id": "usr_dev" }));
		assert_eq!(full["body"], "body");
		assert_eq!(full["closedAt"], Value::Null);
		assert!(issue_json(&i, false).get("body").is_none());
		let scoped = Issue {
			project: Some("crates/lsp".into()),
			..i
		};
		assert_eq!(issue_json(&scoped, false)["project"], "crates/lsp");
	}

	#[test]
	fn a_project_is_a_clean_root_path() {
		assert_eq!(project_arg(&json!({})).unwrap(), None);
		assert_eq!(project_arg(&json!({ "project": null })).unwrap(), None);
		assert_eq!(
			project_arg(&json!({ "project": "crates/lsp" }))
				.unwrap()
				.as_deref(),
			Some("crates/lsp")
		);
		for odd in ["back\\slash", "new\nline", "tab\there"] {
			assert_eq!(
				project_arg(&json!({ "project": odd })).unwrap().as_deref(),
				Some(odd)
			);
		}
		for bad in [
			json!({ "project": "" }),
			json!({ "project": 1 }),
			json!({ "project": "/crates" }),
			json!({ "project": "crates/" }),
			json!({ "project": "crates//lsp" }),
			json!({ "project": "../etc" }),
			json!({ "project": "a/./b" }),
			json!({ "project": "a\0b" }),
			json!({ "project": "x".repeat(PROJECT_MAX_BYTES + 1) }),
		] {
			assert!(matches!(project_arg(&bad), Err(Error::Invalid(_))), "{bad}");
		}
	}

	#[test]
	fn dates_are_utc_days() {
		assert_eq!(date(0), "1970-01-01");
		assert_eq!(date(951_782_400_000), "2000-02-29");
		assert_eq!(date(1_762_128_000_000), "2025-11-03");
	}

	#[test]
	fn the_tab_lists_issues_and_has_a_form() {
		let doc = tab_doc(&[issue(2, State::Closed), issue(1, State::Open)], 1, 1);
		let children = &doc["root"]["children"];
		assert_eq!(children[0]["text"], "Issues");
		assert_eq!(children[1]["children"][0]["value"], 1.0);
		assert_eq!(children[2]["t"], "table");
		assert_eq!(children[2]["rows"][0][0], "#2");
		assert_eq!(children[2]["rows"][0][2], "—");
		assert_eq!(children[2]["rows"][0][3]["text"], "closed");
		assert_eq!(children[2]["rows"][1][3]["tone"], "success");
		assert_eq!(children[2]["rows"][1][5], "2025-11-03");
		let form = &children[3]["children"][0];
		assert_eq!(form["t"], "form");
		assert_eq!(form["submit"]["action"]["id"], CREATE_ACTION);
		assert_eq!(form["fields"][0]["name"], "title");
		let empty = tab_doc(&[], 0, 0);
		assert_eq!(empty["root"]["children"][2]["t"], "empty");
	}

	#[test]
	fn action_results() {
		let r = created_result(&issue(4, State::Open));
		assert_eq!(r["toast"]["text"], "Opened #4");
		assert_eq!(r["refresh"], json!(["issues"]));
		assert_eq!(refused_result("title is required")["toast"]["tone"], "danger");
	}
}
