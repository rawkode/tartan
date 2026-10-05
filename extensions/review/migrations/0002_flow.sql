-- tartan.review (repo scope), M1: the changes it reviews (latest revision and
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
