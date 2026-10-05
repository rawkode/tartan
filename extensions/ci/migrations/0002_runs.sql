-- tartan.ci (repo scope), M1: what a plan was made from (base on trunk, lane,
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
