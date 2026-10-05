// Mirror of `../migrations/*.sql` (the package files named in
// `storage.migrations`), embedded so the Worker bundle needs no text-module
// rules. `src/builtins.test.ts` fails if the two drift. Forward-only: add a
// new numbered file and entry, never edit a shipped one.

import type { ExtMigration } from "@tartan/contract";

export const migrations: readonly ExtMigration[] = [
	{
		n: 1,
		name: "init",
		sql: `-- tartan.work (repo scope): work items, claims, comments.
CREATE TABLE items (id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('issue','intent','resolve')), title TEXT NOT NULL, why TEXT NOT NULL DEFAULT '',
  acceptance_json TEXT NOT NULL DEFAULT '[]', footprint_json TEXT NOT NULL DEFAULT '{"projects":[],"prefixes":[]}',
  parent_ref TEXT, origin_json TEXT NOT NULL DEFAULT '{}',
  mode TEXT NOT NULL DEFAULT 'single' CHECK (mode IN ('single','tournament')), k INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL CHECK (state IN ('open','claimed','in_review','done','abandoned')),
  priority INTEGER NOT NULL DEFAULT 2, labels_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
-- External-content FTS index; kept in sync by the extension code, not by triggers.
CREATE VIRTUAL TABLE items_fts USING fts5(title, why, content='items', content_rowid='rowid');
CREATE TABLE claims (item_id TEXT NOT NULL, lane_id TEXT NOT NULL, principal_id TEXT NOT NULL, candidate INTEGER,
  state TEXT NOT NULL CHECK (state IN ('active','submitted','won','lost','released','landed','lease_lost')),
  plan TEXT, claimed_at INTEGER NOT NULL, ended_at INTEGER, PRIMARY KEY (item_id, lane_id));
CREATE TABLE comments (id TEXT PRIMARY KEY, item_id TEXT NOT NULL, author_id TEXT NOT NULL, body_md TEXT NOT NULL, at INTEGER NOT NULL);
`,
	},
	{
		n: 2,
		name: "links",
		sql:
			`-- tartan.work (repo scope): the change a claim was submitted as, the landed commit of an item, and negative knowledge
-- passed through from selection@1 (WP12).
ALTER TABLE claims ADD COLUMN change_id TEXT;
ALTER TABLE items ADD COLUMN landed_commit TEXT;
CREATE INDEX claims_lane ON claims(lane_id);
CREATE INDEX claims_change ON claims(change_id);
CREATE INDEX items_commit ON items(landed_commit);
CREATE TABLE knowledge (id TEXT PRIMARY KEY, item_id TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}', at INTEGER NOT NULL);
CREATE INDEX knowledge_item ON knowledge(item_id);
`,
	},
	{
		n: 3,
		name: "drop_tournament",
		sql:
			`-- tartan.work (repo scope): tournaments were removed. Drop the tournament-only columns (items.mode,
-- items.k, claims.candidate) and the negative-knowledge table; claims a tournament decided end as released. The
-- claims.state CHECK still lists 'won' and 'lost' (a CHECK change needs a table rebuild); nothing writes them.
UPDATE claims SET state = 'released', ended_at = COALESCE(ended_at, claimed_at) WHERE state IN ('won', 'lost');
ALTER TABLE items DROP COLUMN mode;
ALTER TABLE items DROP COLUMN k;
ALTER TABLE claims DROP COLUMN candidate;
DROP TABLE knowledge;
`,
	},
];
