// Mirror of `../migrations/*.sql` (the package files named in
// `storage.migrations`), embedded so the Worker bundle needs no text-module
// rules. `src/builtins.test.ts` fails if the two drift. Forward-only: add a
// new numbered file and entry, never edit a shipped one.

import type { ExtMigration } from "@tartan/contract";

export const migrations: readonly ExtMigration[] = [
	{
		n: 1,
		name: "init",
		sql: `-- tartan.ci (repo scope): plans, checks, result cache.
CREATE TABLE plans (subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, sha TEXT NOT NULL, run_id TEXT,
  jobs_json TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (subject_kind, subject_id, sha));
CREATE TABLE checks (subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, sha TEXT NOT NULL, context TEXT NOT NULL,
  state TEXT NOT NULL, run_id TEXT, cached INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
  PRIMARY KEY (subject_kind, subject_id, sha, context));
-- Successful jobs only.
CREATE TABLE cache (input_hash TEXT PRIMARY KEY, job_id TEXT NOT NULL, project TEXT, run_id TEXT NOT NULL, at INTEGER NOT NULL);
`,
	},
	{
		n: 2,
		name: "runs",
		sql:
			`-- tartan.ci (repo scope), M1: what a plan was made from (base on trunk, lane,
-- land attempt, revision), its outcome, and the per-project check index.
ALTER TABLE plans ADD COLUMN base TEXT;
ALTER TABLE plans ADD COLUMN lane_id TEXT;
ALTER TABLE plans ADD COLUMN attempt INTEGER;
ALTER TABLE plans ADD COLUMN revision INTEGER;
ALTER TABLE plans ADD COLUMN gen INTEGER NOT NULL DEFAULT 1;
ALTER TABLE plans ADD COLUMN notified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE plans ADD COLUMN detail_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE plans ADD COLUMN finished_at INTEGER;
CREATE INDEX plans_run ON plans(run_id);
CREATE INDEX plans_created ON plans(created_at);
ALTER TABLE checks ADD COLUMN project TEXT;
ALTER TABLE checks ADD COLUMN job_id TEXT;
CREATE INDEX checks_project ON checks(project, updated_at);
-- The test commands of the latest policy read at a base (context@1, read-only).
CREATE TABLE policy (k TEXT PRIMARY KEY, sha TEXT NOT NULL, mode TEXT NOT NULL, commands_json TEXT NOT NULL, at INTEGER NOT NULL);
`,
	},
	{
		n: 3,
		name: "config_waits",
		sql:
			`-- tartan.ci (repo scope): plan requests whose base's Tartan config (the
-- repository's package tartan, ADR repo config) was still evaluating; replayed
-- when its trunk row resolves (repo.config.resolved).
CREATE TABLE config_waits (subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, sha TEXT NOT NULL,
  request_json TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (subject_kind, subject_id, sha));
`,
	},
];
