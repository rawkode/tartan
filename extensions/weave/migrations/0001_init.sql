-- tartan.weave (repo scope): queue entries and land batches.
CREATE TABLE entries (change_id TEXT PRIMARY KEY, lane_id TEXT NOT NULL, head TEXT NOT NULL, affected_json TEXT NOT NULL,
  partition_key TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 2, enqueued_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('waiting','batched','landing','landed','ejected','withdrawn')),
  attempts INTEGER NOT NULL DEFAULT 0, batch_id TEXT, depends_on TEXT, last_error TEXT);
CREATE TABLE batches (batch_id TEXT PRIMARY KEY, partition_key TEXT NOT NULL, change_ids_json TEXT NOT NULL,
  state TEXT NOT NULL, parent_batch TEXT, result_json TEXT, created_at INTEGER NOT NULL, finished_at INTEGER);
