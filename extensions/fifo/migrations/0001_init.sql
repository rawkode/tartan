-- tartan.fifo (repo scope): serial queue entries.
CREATE TABLE entries (change_id TEXT PRIMARY KEY, lane_id TEXT NOT NULL, head TEXT NOT NULL, enqueued_at INTEGER NOT NULL,
  state TEXT NOT NULL, batch_id TEXT);
