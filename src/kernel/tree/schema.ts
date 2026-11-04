// ForgeDO `tree` migrations (WP3, range 200–299): the
// unbounded hierarchy (`nodes` with a materialized `path`), redirects of moved
// nodes, grants, protected-ref patterns and the Artifacts index of canonical
// and lane repos.

import type { Migration } from "@tartan/contract/kernel.ts";

const NODES = `CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES nodes(id),
  kind TEXT NOT NULL CHECK (kind IN ('user','group','repo')),
  slug TEXT NOT NULL CHECK (length(slug) BETWEEN 1 AND 64 AND slug GLOB '[a-z0-9]*' AND slug NOT GLOB '*[^a-z0-9-]*'),
  path TEXT NOT NULL UNIQUE,
  depth INTEGER NOT NULL CHECK (depth >= 0),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','internal','public')),
  artifacts_name TEXT UNIQUE,
  default_branch TEXT,
  description TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, archived_at INTEGER,
  CHECK ((kind = 'repo') = (artifacts_name IS NOT NULL)),
  CHECK ((parent_id IS NULL) = (depth = 0)),
  CHECK (kind <> 'user' OR depth = 0),
  CHECK (kind <> 'repo' OR depth >= 1));
CREATE INDEX nodes_parent ON nodes(parent_id, slug)`;

/**
 * Repos at any level, the top included: SQLite cannot drop a CHECK, so `nodes`
 * is rebuilt without `kind <> 'repo' OR depth >= 1`. Foreign keys stay on, and
 * grants, redirects and protected_refs point at this table, so the checks are
 * deferred to the commit: dropping the table counts their rows as violations,
 * and inserting the same ids again clears them. Parents go in before children.
 * The pragma goes back off at the end: Durable Object SQLite can hold this write in
 * a longer implicit transaction, and later writes in it must fail where they stand.
 */
const NODES_REPOS_AT_ANY_DEPTH = `PRAGMA defer_foreign_keys = ON;
CREATE TABLE nodes_rebuild AS SELECT * FROM nodes;
DROP TABLE nodes;
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES nodes(id),
  kind TEXT NOT NULL CHECK (kind IN ('user','group','repo')),
  slug TEXT NOT NULL CHECK (length(slug) BETWEEN 1 AND 64 AND slug GLOB '[a-z0-9]*' AND slug NOT GLOB '*[^a-z0-9-]*'),
  path TEXT NOT NULL UNIQUE,
  depth INTEGER NOT NULL CHECK (depth >= 0),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','internal','public')),
  artifacts_name TEXT UNIQUE,
  default_branch TEXT,
  description TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, archived_at INTEGER,
  CHECK ((kind = 'repo') = (artifacts_name IS NOT NULL)),
  CHECK ((parent_id IS NULL) = (depth = 0)),
  CHECK (kind <> 'user' OR depth = 0));
CREATE INDEX nodes_parent ON nodes(parent_id, slug);
INSERT INTO nodes SELECT * FROM nodes_rebuild ORDER BY depth;
DROP TABLE nodes_rebuild;
PRAGMA defer_foreign_keys = OFF`;

const REDIRECTS =
	`CREATE TABLE redirects (old_path TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES nodes(id), created_at INTEGER NOT NULL)`;

const GRANTS =
	`CREATE TABLE grants (node_id TEXT NOT NULL REFERENCES nodes(id), principal_id TEXT NOT NULL,
  role INTEGER NOT NULL CHECK (role IN (10,20,30,40,50)),
  granted_by TEXT NOT NULL, expires_at INTEGER, created_at INTEGER NOT NULL, PRIMARY KEY (node_id, principal_id));
CREATE INDEX grants_principal ON grants(principal_id)`;

const PROTECTED_REFS =
	`CREATE TABLE protected_refs (node_id TEXT NOT NULL REFERENCES nodes(id), pattern TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (node_id, pattern))`;

const ARTIFACTS_INDEX = `CREATE TABLE artifacts_index (name TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('repo','lane')),
  repo_id TEXT NOT NULL,
  lane_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','live','deleted')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK ((kind = 'lane') = (lane_id IS NOT NULL)));
CREATE UNIQUE INDEX artifacts_index_repo ON artifacts_index(repo_id) WHERE kind = 'repo';
CREATE INDEX artifacts_index_lane ON artifacts_index(lane_id) WHERE kind = 'lane';
CREATE INDEX artifacts_index_state ON artifacts_index(state, updated_at)`;

export const TREE_MIGRATIONS: readonly Migration[] = [
	{
		n: 200,
		name: "nodes, redirects, grants, protected_refs, artifacts_index",
		sql: [NODES, REDIRECTS, GRANTS, PROTECTED_REFS, ARTIFACTS_INDEX].join(
			";\n",
		),
	},
	{
		n: 201,
		name: "nodes: repos at any depth",
		sql: NODES_REPOS_AT_ANY_DEPTH,
	},
];
