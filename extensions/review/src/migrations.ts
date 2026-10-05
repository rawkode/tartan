// Mirror of `../migrations/*.sql` (the package files named in
// `storage.migrations`), embedded so the Worker bundle needs no text-module
// rules. `src/builtins.test.ts` fails if the two drift. Forward-only: add a
// new numbered file and entry, never edit a shipped one.

import type { ExtMigration } from "@tartan/contract";

export const migrations: readonly ExtMigration[] = [
	{
		n: 1,
		name: "init",
		sql:
			`-- tartan.review (repo scope): owner rules, reviews, attention set, track record.
-- rules come from .tartan/owners.yaml AT TRUNK only (K13); refreshed on ref.advanced.
CREATE TABLE rules (glob TEXT PRIMARY KEY, sensitivity INTEGER NOT NULL, owners_json TEXT NOT NULL,
  trunk_sha TEXT NOT NULL);
CREATE TABLE reviews (change_id TEXT NOT NULL, n INTEGER NOT NULL, risk REAL NOT NULL, factors_json TEXT NOT NULL,
  route TEXT NOT NULL CHECK (route IN ('auto','human')), decision TEXT, decided_by TEXT, evidence_json TEXT NOT NULL,
  shadow INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL, PRIMARY KEY (change_id, n, shadow));
CREATE TABLE attention (change_id TEXT NOT NULL, principal_id TEXT NOT NULL, reason TEXT NOT NULL, since INTEGER NOT NULL,
  PRIMARY KEY (change_id, principal_id));
CREATE TABLE track (principal_id TEXT PRIMARY KEY, landed INTEGER NOT NULL DEFAULT 0, ejected INTEGER NOT NULL DEFAULT 0,
  vetoed INTEGER NOT NULL DEFAULT 0, reverted INTEGER NOT NULL DEFAULT 0);
`,
	},
	{
		n: 2,
		name: "flow",
		sql:
			`-- tartan.review (repo scope), M1: the changes it reviews (latest revision and
-- head, K4), the lanes' open conflicts (radar factor), event dedupe for the
-- track record, and what each review judged.
CREATE TABLE changes (change_id TEXT PRIMARY KEY, lane_id TEXT NOT NULL, author_id TEXT NOT NULL, on_behalf_of TEXT,
  work_ref TEXT, revision INTEGER NOT NULL, head TEXT NOT NULL, base TEXT NOT NULL, state TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX changes_lane ON changes(lane_id);
CREATE TABLE lane_conflicts (conflict_id TEXT PRIMARY KEY, a TEXT NOT NULL, b TEXT NOT NULL, severity TEXT NOT NULL,
  state TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX lane_conflicts_a ON lane_conflicts(a);
CREATE INDEX lane_conflicts_b ON lane_conflicts(b);
CREATE TABLE track_seen (event_id TEXT PRIMARY KEY);
ALTER TABLE reviews ADD COLUMN head TEXT;
ALTER TABLE reviews ADD COLUMN decided_kind TEXT;
ALTER TABLE reviews ADD COLUMN ci TEXT;
ALTER TABLE reviews ADD COLUMN notified INTEGER NOT NULL DEFAULT 0;
`,
	},
];
