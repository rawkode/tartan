-- tartan.changes (repo scope): the change timeline (submits, revisions, reviews, queue and land outcomes), the latest
-- review decision, and the batches a change was landed in (WP12).
CREATE TABLE timeline (id TEXT PRIMARY KEY, change_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL,
  text TEXT NOT NULL, actor TEXT, revision INTEGER);
CREATE INDEX timeline_change ON timeline(change_id, at);
ALTER TABLE changes ADD COLUMN review_json TEXT;
CREATE INDEX changes_state ON changes(state, updated_at);
CREATE TABLE batches (batch_id TEXT NOT NULL, change_id TEXT NOT NULL, attempt INTEGER NOT NULL,
  PRIMARY KEY (batch_id, change_id));
CREATE INDEX comments_change ON comments(change_id, at);
