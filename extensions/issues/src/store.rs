//! The `issues` table (`migrations/`). Reads also run in the
//! read-only render; writes only from tools and the tab's action.

use tartan_ext::host;
use tartan_ext::sql::{self, params, Row, Value};
use tartan_ext::Error;

use crate::issue::{Author, Filter, Issue, NewIssue, State};

const COLUMNS: &str =
	"number, title, body, project, state, author_kind, author_id, on_behalf_of, created_at, updated_at, closed_at";

fn time(row: &Row, column: &str) -> Option<u64> {
	row.int(column).and_then(|t| u64::try_from(t).ok())
}

fn issue(row: &Row) -> Option<Issue> {
	Some(Issue {
		number: u32::try_from(row.int("number")?).ok()?,
		title: row.text("title")?.to_string(),
		body: row.text("body").unwrap_or("").to_string(),
		project: row.text("project").map(str::to_string),
		state: State::parse(row.text("state")?)?,
		author: Author {
			kind: row.text("author_kind")?.to_string(),
			id: row.text("author_id")?.to_string(),
			on_behalf_of: row.text("on_behalf_of").map(str::to_string),
		},
		created_at: time(row, "created_at").unwrap_or(0),
		updated_at: time(row, "updated_at").unwrap_or(0),
		closed_at: time(row, "closed_at"),
	})
}

/// Opens an issue with the repository's next number.
pub fn create(new: &NewIssue, project: Option<&str>, author: &Author) -> Result<Issue, Error> {
	let at = host::now_ms();
	let next = sql::first("SELECT COALESCE(MAX(number), 0) + 1 AS n FROM issues", &[])?
		.and_then(|r| r.int("n"))
		.and_then(|n| u32::try_from(n).ok())
		.ok_or_else(|| Error::internal("no next issue number"))?;
	sql::execute(
		"INSERT INTO issues (number, title, body, project, state, author_kind, author_id, on_behalf_of, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)",
		&params![
			next,
			new.title.as_str(),
			new.body.as_str(),
			project,
			author.kind.as_str(),
			author.id.as_str(),
			author.on_behalf_of.as_deref(),
			at,
			at
		],
	)?;
	Ok(Issue {
		number: next,
		title: new.title.clone(),
		body: new.body.clone(),
		project: project.map(str::to_string),
		state: State::Open,
		author: author.clone(),
		created_at: at,
		updated_at: at,
		closed_at: None,
	})
}

pub fn get(number: u32) -> Result<Option<Issue>, Error> {
	let row = sql::first(
		&format!("SELECT {COLUMNS} FROM issues WHERE number = ?"),
		&params![number],
	)?;
	Ok(row.as_ref().and_then(issue))
}

/// The newest issues first, of one project when given.
pub fn list(filter: Filter, project: Option<&str>, limit: u32) -> Result<Vec<Issue>, Error> {
	let mut conditions = Vec::new();
	let mut bound = Vec::new();
	if let Filter::Only(state) = filter {
		conditions.push("state = ?");
		bound.push(Value::from(state.as_str()));
	}
	if let Some(root) = project {
		conditions.push("project = ?");
		bound.push(Value::from(root));
	}
	let filtered = if conditions.is_empty() {
		String::new()
	} else {
		format!("WHERE {}", conditions.join(" AND "))
	};
	bound.push(Value::from(limit));
	let rows = sql::query(
		&format!("SELECT {COLUMNS} FROM issues {filtered} ORDER BY number DESC LIMIT ?"),
		&bound,
	)?;
	Ok(rows.iter().filter_map(issue).collect())
}

/// `(open, closed)`, of one project when given.
pub fn counts(project: Option<&str>) -> Result<(i64, i64), Error> {
	const COUNTS: &str = "SELECT COALESCE(SUM(CASE WHEN state = 'open' THEN 1 ELSE 0 END), 0) AS open, COALESCE(SUM(CASE WHEN state = 'closed' THEN 1 ELSE 0 END), 0) AS closed FROM issues";
	let row = match project {
		None => sql::first(COUNTS, &[])?,
		Some(root) => sql::first(&format!("{COUNTS} WHERE project = ?"), &params![root])?,
	};
	Ok(row.map_or((0, 0), |r| {
		(r.int("open").unwrap_or(0), r.int("closed").unwrap_or(0))
	}))
}

/// Moves an issue to `state`; `(issue, changed)`, or None when there is no
/// such issue. Already in that state is not an error.
pub fn set_state(number: u32, state: State) -> Result<Option<(Issue, bool)>, Error> {
	let Some(current) = get(number)? else {
		return Ok(None);
	};
	if current.state == state {
		return Ok(Some((current, false)));
	}
	let at = host::now_ms();
	let closed_at = (state == State::Closed).then_some(at);
	sql::execute(
		"UPDATE issues SET state = ?, updated_at = ?, closed_at = ? WHERE number = ?",
		&params![state.as_str(), at, closed_at, number],
	)?;
	Ok(Some((
		Issue {
			state,
			updated_at: at,
			closed_at,
			..current
		},
		true,
	)))
}
