// Mirror of `../migrations/*.sql` (the package files named in
// `storage.migrations`), embedded so the Worker bundle needs no text-module
// rules. `src/builtins.test.ts` fails if the two drift. Forward-only: add a
// new numbered file and entry, never edit a shipped one.

import type { ExtMigration } from "@tartan/contract";

export const migrations: readonly ExtMigration[] = [
	{
		n: 1,
		name: "init",
		sql: `-- tartan.epics (node scope): epics and their cross-repo work items.
CREATE TABLE epics (id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE, title TEXT NOT NULL, why TEXT,
  state TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE epic_items (epic_id TEXT NOT NULL, work_ref TEXT NOT NULL, repo_id TEXT NOT NULL, state TEXT NOT NULL,
  PRIMARY KEY (epic_id, work_ref));
`,
	},
];
