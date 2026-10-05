-- tartan.radar M1 (path level): lane facts for notices and suggestions, the change map, trunk landings
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
