-- tartan.fifo 0002: the serial train (M1), the same tables as tartan.weave runs on (the shared engine): the approval
-- each entry lands on, the stored land request of each batch (minted and stored before land.submit), the
-- revisions the queue saw, and train state.
ALTER TABLE entries ADD COLUMN affected_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE entries ADD COLUMN partition_key TEXT NOT NULL DEFAULT '*';
ALTER TABLE entries ADD COLUMN priority INTEGER NOT NULL DEFAULT 2;
ALTER TABLE entries ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entries ADD COLUMN depends_on TEXT;
ALTER TABLE entries ADD COLUMN last_error TEXT;
ALTER TABLE entries ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE entries ADD COLUMN review_event TEXT;
ALTER TABLE entries ADD COLUMN review_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE entries ADD COLUMN solo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entries ADD COLUMN withdraw_requested INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entries ADD COLUMN reason TEXT;
ALTER TABLE entries ADD COLUMN commit_sha TEXT;
ALTER TABLE entries ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
CREATE TABLE batches (batch_id TEXT PRIMARY KEY, partition_key TEXT NOT NULL, change_ids_json TEXT NOT NULL,
  state TEXT NOT NULL, parent_batch TEXT, result_json TEXT, created_at INTEGER NOT NULL, finished_at INTEGER,
  seq INTEGER NOT NULL DEFAULT 0, request_json TEXT, phase TEXT, submit_tries INTEGER NOT NULL DEFAULT 0,
  submitted_at INTEGER, last_error TEXT);
CREATE TABLE changes (change_id TEXT PRIMARY KEY, lane_id TEXT NOT NULL, revision INTEGER NOT NULL, head TEXT NOT NULL,
  base TEXT, affected_json TEXT NOT NULL DEFAULT '[]', work_ref TEXT, submitted_event TEXT, revised_event TEXT,
  title TEXT, summary TEXT, author TEXT, closed INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX entries_by_state ON entries (state, priority, enqueued_at);
CREATE INDEX batches_by_state ON batches (state, created_at);
