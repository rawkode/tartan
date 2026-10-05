-- tartan.changes (repo scope): changes, revisions, review threads.
CREATE TABLE changes (change_id TEXT PRIMARY KEY, work_ref TEXT, lane_id TEXT NOT NULL UNIQUE, source_ref TEXT,
  title TEXT NOT NULL, summary_md TEXT, author_id TEXT NOT NULL, on_behalf_of TEXT,
  state TEXT NOT NULL CHECK (state IN ('draft','submitted','approved','queued','landing','landed','ejected','abandoned','superseded')),
  selection_ref TEXT, landed_commit TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE revisions (change_id TEXT NOT NULL, n INTEGER NOT NULL, head TEXT NOT NULL, base TEXT NOT NULL,
  affected_json TEXT NOT NULL, diffstat_json TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (change_id, n));
CREATE TABLE comments (id TEXT PRIMARY KEY, change_id TEXT NOT NULL, n INTEGER NOT NULL, path TEXT, line INTEGER,
  side TEXT CHECK (side IN ('base','head')), body_md TEXT NOT NULL, author_id TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL);
