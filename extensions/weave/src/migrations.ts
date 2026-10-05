// Mirror of `../migrations/*.sql` (the package files named in
// `storage.migrations`), embedded so the Worker bundle needs no text-module
// rules. `src/builtins.test.ts` fails if the two drift. Forward-only: add a
// new numbered file and entry, never edit a shipped one.

import type { ExtMigration } from "@tartan/contract";

export const migrations: readonly ExtMigration[] = [
	{
		n: 1,
		name: "init",
		sql: `-- tartan.weave (repo scope): queue entries and land batches.
CREATE TABLE entries (change_id TEXT PRIMARY KEY, lane_id TEXT NOT NULL, head TEXT NOT NULL, affected_json TEXT NOT NULL,
  partition_key TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 2, enqueued_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('waiting','batched','landing','landed','ejected','withdrawn')),
  attempts INTEGER NOT NULL DEFAULT 0, batch_id TEXT, depends_on TEXT, last_error TEXT);
CREATE TABLE batches (batch_id TEXT PRIMARY KEY, partition_key TEXT NOT NULL, change_ids_json TEXT NOT NULL,
  state TEXT NOT NULL, parent_batch TEXT, result_json TEXT, created_at INTEGER NOT NULL, finished_at INTEGER);
`,
	},
	{
		n: 2,
		name: "train",
		sql:
			`-- tartan.weave 0002: the serial train (M1). The approval each entry lands on, the stored land request of each batch
-- (minted and stored before land.submit), the revisions the Weave saw, and train state.
ALTER TABLE entries ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE entries ADD COLUMN review_event TEXT;
ALTER TABLE entries ADD COLUMN review_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE entries ADD COLUMN solo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entries ADD COLUMN withdraw_requested INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entries ADD COLUMN reason TEXT;
ALTER TABLE entries ADD COLUMN commit_sha TEXT;
ALTER TABLE entries ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE batches ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE batches ADD COLUMN request_json TEXT;
ALTER TABLE batches ADD COLUMN phase TEXT;
ALTER TABLE batches ADD COLUMN submit_tries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE batches ADD COLUMN submitted_at INTEGER;
ALTER TABLE batches ADD COLUMN last_error TEXT;
CREATE TABLE changes (change_id TEXT PRIMARY KEY, lane_id TEXT NOT NULL, revision INTEGER NOT NULL, head TEXT NOT NULL,
  base TEXT, affected_json TEXT NOT NULL DEFAULT '[]', work_ref TEXT, submitted_event TEXT, revised_event TEXT,
  title TEXT, summary TEXT, author TEXT, closed INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX entries_by_state ON entries (state, priority, enqueued_at);
CREATE INDEX batches_by_state ON batches (state, created_at);
`,
	},
];
