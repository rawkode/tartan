-- tartan.radar (repo scope): touches, footprints, lane projection, conflicts, stats.
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
