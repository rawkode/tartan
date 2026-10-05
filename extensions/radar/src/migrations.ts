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
			`-- tartan.radar (repo scope): touches, footprints, lane projection, conflicts, stats.
CREATE TABLE touches (lane_id TEXT NOT NULL, path TEXT NOT NULL, project TEXT, change TEXT NOT NULL,
  base_blob TEXT, head_blob TEXT, hunks_json TEXT, head_sha TEXT NOT NULL, PRIMARY KEY (lane_id, path));
CREATE INDEX touches_path ON touches(path);
CREATE INDEX touches_project ON touches(project);
CREATE TABLE footprints (lane_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('project','prefix')), value TEXT NOT NULL,
  PRIMARY KEY (lane_id, kind, value));
CREATE INDEX footprints_value ON footprints(kind, value);
-- Projection of lane.* events for joins.
CREATE TABLE lanes (lane_id TEXT PRIMARY KEY, owner TEXT NOT NULL, entity_kind TEXT, entity_id TEXT, base_sha TEXT NOT NULL,
  head_sha TEXT, state TEXT NOT NULL);
CREATE TABLE conflicts (id TEXT PRIMARY KEY, a TEXT NOT NULL, b TEXT NOT NULL, path TEXT NOT NULL, project TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('declared','same_project','same_file','adjacent','textual','semantic','trunk_drift')),
  detail_json TEXT NOT NULL, suggestion TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','acked','cleared')), ack_json TEXT, notified INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, cleared_at INTEGER, avoided INTEGER, UNIQUE (a, b, path));
-- Counters: predicted, avoided, materialized.
CREATE TABLE stats (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
`,
	},
	{
		n: 2,
		name: "m1",
		sql:
			`-- tartan.radar M1 (path level): lane facts for notices and suggestions, the change map, trunk landings
-- (trunk drift), project roots by trunk commit, small settings and the effects outbox.
ALTER TABLE lanes ADD COLUMN mode TEXT NOT NULL DEFAULT 'branch';
ALTER TABLE lanes ADD COLUMN ref TEXT;
ALTER TABLE lanes ADD COLUMN remote TEXT;
ALTER TABLE lanes ADD COLUMN owner_label TEXT;
ALTER TABLE lanes ADD COLUMN work_title TEXT;
ALTER TABLE lanes ADD COLUMN work_why TEXT;
ALTER TABLE lanes ADD COLUMN change_id TEXT;
ALTER TABLE lanes ADD COLUMN range_base TEXT;
ALTER TABLE lanes ADD COLUMN commits_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE lanes ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lanes ADD COLUMN opened_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lanes ADD COLUMN last_push_at INTEGER;
ALTER TABLE lanes ADD COLUMN touches_at TEXT;
CREATE INDEX lanes_state ON lanes(state);
CREATE INDEX lanes_change ON lanes(change_id);
CREATE INDEX conflicts_b ON conflicts(b, state);
CREATE INDEX conflicts_state ON conflicts(state, last_seen);
-- One row per landed change, in trunk order (seq), from ref.advanced.
CREATE TABLE landings (seq INTEGER PRIMARY KEY, advance_id TEXT NOT NULL, lane_id TEXT, change_id TEXT,
  commit_sha TEXT NOT NULL, trunk_sha TEXT NOT NULL, old_sha TEXT NOT NULL, at INTEGER NOT NULL,
  UNIQUE (advance_id, commit_sha));
CREATE INDEX landings_commit ON landings(commit_sha);
CREATE INDEX landings_trunk ON landings(trunk_sha);
CREATE TABLE landed_paths (seq INTEGER NOT NULL, path TEXT NOT NULL, project TEXT, PRIMARY KEY (seq, path));
CREATE INDEX landed_paths_path ON landed_paths(path);
-- Project roots of the graph at a trunk commit (longest-root match), from caps.repo.projectGraph.
CREATE TABLE project_roots (sha TEXT PRIMARY KEY, roots_json TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
-- Effects (events, notices) written in the same transaction as the state they report, flushed afterwards.
CREATE TABLE outbox (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('emit','notify')), body_json TEXT NOT NULL,
  at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
`,
	},
];
