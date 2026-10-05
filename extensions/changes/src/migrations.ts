// Mirror of `../migrations/*.sql` (the package files named in
// `storage.migrations`), embedded so the Worker bundle needs no text-module
// rules. `src/builtins.test.ts` fails if the two drift. Forward-only: add a
// new numbered file and entry, never edit a shipped one.

import type { ExtMigration } from "@tartan/contract";

export const migrations: readonly ExtMigration[] = [
	{
		n: 1,
		name: "init",
		sql: `-- tartan.changes (repo scope): changes, revisions, review threads.
CREATE TABLE changes (change_id TEXT PRIMARY KEY, work_ref TEXT, lane_id TEXT NOT NULL UNIQUE, source_ref TEXT,
  title TEXT NOT NULL, summary_md TEXT, author_id TEXT NOT NULL, on_behalf_of TEXT,
  state TEXT NOT NULL CHECK (state IN ('draft','submitted','approved','queued','landing','landed','ejected','abandoned','superseded')),
  selection_ref TEXT, landed_commit TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE revisions (change_id TEXT NOT NULL, n INTEGER NOT NULL, head TEXT NOT NULL, base TEXT NOT NULL,
  affected_json TEXT NOT NULL, diffstat_json TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (change_id, n));
CREATE TABLE comments (id TEXT PRIMARY KEY, change_id TEXT NOT NULL, n INTEGER NOT NULL, path TEXT, line INTEGER,
  side TEXT CHECK (side IN ('base','head')), body_md TEXT NOT NULL, author_id TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL);
`,
	},
	{
		n: 2,
		name: "timeline",
		sql:
			`-- tartan.changes (repo scope): the change timeline (submits, revisions, reviews, queue and land outcomes), the latest
-- review decision, and the batches a change was landed in (WP12).
CREATE TABLE timeline (id TEXT PRIMARY KEY, change_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL,
  text TEXT NOT NULL, actor TEXT, revision INTEGER);
CREATE INDEX timeline_change ON timeline(change_id, at);
ALTER TABLE changes ADD COLUMN review_json TEXT;
CREATE INDEX changes_state ON changes(state, updated_at);
CREATE TABLE batches (batch_id TEXT NOT NULL, change_id TEXT NOT NULL, attempt INTEGER NOT NULL,
  PRIMARY KEY (batch_id, change_id));
CREATE INDEX comments_change ON comments(change_id, at);
`,
	},
	{
		n: 3,
		name: "drop_selection_ref",
		sql:
			`-- tartan.changes (repo scope): tournaments were removed; drop the tournament-only selection_ref column.
ALTER TABLE changes DROP COLUMN selection_ref;
`,
	},
];
