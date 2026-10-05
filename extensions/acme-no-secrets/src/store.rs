//! The extension's own tables (`migrations/0001_init.sql`): findings from
//! gates, pushes and scans, and every gate decision. Reads run in read-only
//! renders; writes only from the gate and the echo.

use tartan_ext::host;
use tartan_ext::sql::{self, params, Row};
use tartan_ext::Error;

use crate::detect::{Finding, Kind};

/// Where a finding came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
	Gate,
	Echo,
}

impl Source {
	fn as_str(self) -> &'static str {
		match self {
			Source::Gate => "gate",
			Source::Echo => "echo",
		}
	}
}

/// A stored finding (as shown in the panels).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stored {
	pub change_id: Option<String>,
	pub lane_id: Option<String>,
	pub path: String,
	pub line: u32,
	pub kind: Kind,
	pub masked: String,
	pub source: String,
	pub at: u64,
}

/// A stored gate decision.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decided {
	pub verdict: String,
	pub message: String,
	pub at: u64,
}

fn stored(row: &Row) -> Option<Stored> {
	Some(Stored {
		change_id: row.text("change_id").map(str::to_string),
		lane_id: row.text("lane_id").map(str::to_string),
		path: row.text("path")?.to_string(),
		line: u32::try_from(row.int("line")?).ok()?,
		kind: Kind::parse(row.text("kind")?)?,
		masked: row.text("masked").unwrap_or("").to_string(),
		source: row.text("source").unwrap_or("").to_string(),
		at: u64::try_from(row.int("at").unwrap_or(0)).unwrap_or(0),
	})
}

fn insert(
	change_id: Option<&str>,
	lane_id: Option<&str>,
	f: &Finding,
	source: Source,
	at: u64,
) -> Result<(), Error> {
	sql::execute(
		"INSERT OR REPLACE INTO findings (change_id, lane_id, path, line, kind, masked, source, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		&params![change_id, lane_id, f.path.as_str(), f.line, f.kind.as_str(), f.masked.as_str(), source.as_str(), at],
	)?;
	Ok(())
}

/// A gate run replaces the change's earlier gate findings and records the
/// decision.
pub fn record_gate(
	change_id: Option<&str>,
	point: &str,
	findings: &[Finding],
	verdict: &str,
	message: &str,
) -> Result<(), Error> {
	let at = host::now_ms();
	if let Some(change) = change_id {
		sql::execute(
			"DELETE FROM findings WHERE change_id = ? AND source = 'gate'",
			&params![change],
		)?;
	}
	for f in findings {
		insert(change_id, None, f, Source::Gate, at)?;
	}
	sql::execute(
		"INSERT INTO decisions (id, point, change_id, verdict, message, at) VALUES (?, ?, ?, ?, ?, ?)",
		&params![host::ulid(), point, change_id, verdict, message, at],
	)?;
	Ok(())
}

/// Findings from a push (the lane's, or the canonical repo's when `lane_id`
/// is None); the same line found again is stored once.
pub fn record_push(lane_id: Option<&str>, findings: &[Finding]) -> Result<(), Error> {
	let at = host::now_ms();
	for f in findings {
		insert(None, lane_id, f, Source::Echo, at)?;
	}
	Ok(())
}

const COLUMNS: &str = "change_id, lane_id, path, line, kind, masked, source, at";

pub fn for_change(change_id: &str) -> Result<Vec<Stored>, Error> {
	let rows = sql::query(
		&format!("SELECT {COLUMNS} FROM findings WHERE change_id = ? ORDER BY path, line, kind LIMIT 200"),
		&params![change_id],
	)?;
	Ok(rows.iter().filter_map(stored).collect())
}

pub fn recent(limit: u32) -> Result<Vec<Stored>, Error> {
	let rows = sql::query(
		&format!("SELECT {COLUMNS} FROM findings ORDER BY at DESC, path, line LIMIT ?"),
		&params![limit],
	)?;
	Ok(rows.iter().filter_map(stored).collect())
}

pub fn last_decision(change_id: &str) -> Result<Option<Decided>, Error> {
	let row = sql::first(
		"SELECT verdict, message, at FROM decisions WHERE change_id = ? ORDER BY at DESC, id DESC LIMIT 1",
		&params![change_id],
	)?;
	Ok(row.map(|r| Decided {
		verdict: r.text("verdict").unwrap_or("").to_string(),
		message: r.text("message").unwrap_or("").to_string(),
		at: u64::try_from(r.int("at").unwrap_or(0)).unwrap_or(0),
	}))
}

/// `(decisions, vetoes)` over every recorded gate run.
pub fn decision_counts() -> Result<(i64, i64), Error> {
	let row = sql::first(
		"SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN verdict = 'veto' THEN 1 ELSE 0 END), 0) AS vetoes FROM decisions",
		&[],
	)?;
	Ok(row.map_or((0, 0), |r| {
		(r.int("n").unwrap_or(0), r.int("vetoes").unwrap_or(0))
	}))
}
