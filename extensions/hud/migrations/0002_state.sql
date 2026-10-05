-- tartan.hud (node scope): the state behind the counters (WP20). The last event applied per stream (redelivery and
-- backfill apply each event once), lanes for the active-lanes gauge, reviewed changes for "needed a human", and
-- all-time totals (per-minute counters keep 7 days).
CREATE TABLE cursors (stream TEXT PRIMARY KEY, seq INTEGER NOT NULL);
CREATE TABLE lanes (lane_id TEXT PRIMARY KEY, repo TEXT, state TEXT NOT NULL CHECK (state IN ('opening','open','gone')),
  sim INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL);
CREATE INDEX lanes_state ON lanes(state, sim);
CREATE TABLE reviews (repo TEXT NOT NULL, change_id TEXT NOT NULL, human INTEGER NOT NULL DEFAULT 0,
  sim INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL, PRIMARY KEY (repo, change_id));
CREATE TABLE totals (metric TEXT PRIMARY KEY, value INTEGER NOT NULL);
