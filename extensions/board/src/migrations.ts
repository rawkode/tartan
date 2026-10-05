// Mirror of `../migrations/*.sql` (the package files named in
// `storage.migrations`), embedded so the Worker bundle needs no text-module
// rules. `src/builtins.test.ts` fails if the two drift. Forward-only: add a
// new numbered file and entry, never edit a shipped one.

import type { ExtMigration } from "@tartan/contract";

export const migrations: readonly ExtMigration[] = [
	{
		n: 1,
		name: "init",
		sql: `-- tartan.board (node scope): boards, columns, cards.
CREATE TABLE boards (id TEXT PRIMARY KEY, node_id TEXT NOT NULL, name TEXT NOT NULL);
-- auto_rule: 'work.claimed' | 'changes.submitted' | 'queue.batched' | 'changes.landed'
CREATE TABLE columns (id TEXT PRIMARY KEY, board_id TEXT NOT NULL, name TEXT NOT NULL, ord INTEGER NOT NULL, wip INTEGER,
  auto_rule TEXT);
-- rank is a fractional index.
CREATE TABLE cards (ref TEXT PRIMARY KEY, board_id TEXT NOT NULL, column_id TEXT NOT NULL, rank TEXT NOT NULL,
  title TEXT NOT NULL, badges_json TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL);
`,
	},
	{
		n: 2,
		name: "links",
		sql:
			`-- tartan.board (node scope): the repo of each card and the changes and lanes that point at a card, so queue and lane
-- events (which carry only a change or lane id) move the right card (WP12).
ALTER TABLE cards ADD COLUMN repo_id TEXT;
ALTER TABLE cards ADD COLUMN kind TEXT NOT NULL DEFAULT 'work';
CREATE INDEX cards_column ON cards(board_id, column_id, rank);
CREATE INDEX cards_repo ON cards(repo_id);
CREATE TABLE links (link_key TEXT PRIMARY KEY, ref TEXT NOT NULL);
`,
	},
];
