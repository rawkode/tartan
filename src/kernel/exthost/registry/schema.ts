// Registry DDL (WP7a, ForgeDO migrations 300–399). The indexes serve the
// resolution queries (installations by node, contributions by kind and key).
//
// `installations.node_id REFERENCES nodes(id)` names WP3's `nodes` table
// (migration 200–299, applied first). SQLite checks the reference when a
// row is written, so creating the table never depends on WP3.

import type { Migration } from "@tartan/contract/kernel.ts";
import { REPO_CONFIG_REGISTRY_MIGRATIONS } from "./repoconfig/schema.ts";

/** WP7a's tables (300–309) and repository config's (310–319, WP23). */
export const REGISTRY_MIGRATIONS: readonly Migration[] = [
	{
		n: 300,
		name: "registry: packages, installations, contributions",
		sql: [
			`CREATE TABLE packages (ext_id TEXT NOT NULL, version TEXT NOT NULL,
  runtime TEXT NOT NULL CHECK (runtime IN ('builtin','js','wasm')),
  manifest_json TEXT NOT NULL, sha256 TEXT NOT NULL, r2_prefix TEXT,
  imports_json TEXT,
  published_by TEXT NOT NULL, published_at INTEGER NOT NULL, PRIMARY KEY (ext_id, version))`,
			`CREATE TABLE installations (id TEXT PRIMARY KEY, ext_id TEXT NOT NULL, version TEXT NOT NULL,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  mode TEXT NOT NULL CHECK (mode IN ('enforce','shadow','disabled')),
  storage_scope TEXT NOT NULL CHECK (storage_scope IN ('node','repo')),
  runtime_override TEXT CHECK (runtime_override IN ('builtin','js','wasm')),
  config_json TEXT NOT NULL DEFAULT '{}', grants_json TEXT NOT NULL,
  background_role INTEGER NOT NULL DEFAULT 20 CHECK (background_role IN (10,20,30,40)),
  locked INTEGER NOT NULL DEFAULT 0,
  backfill TEXT NOT NULL DEFAULT 'none' CHECK (backfill IN ('none','30d','all')),
  pack TEXT, installed_by TEXT NOT NULL, installed_at INTEGER NOT NULL, mode_changed_at INTEGER,
  UNIQUE (ext_id, node_id, mode))`,
			"CREATE INDEX installations_node ON installations(node_id)",
			`CREATE TABLE contributions (installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('provides','slot','tool','gate','echo','subscribe','context','protocol','settings')),
  key TEXT NOT NULL,
  data_json TEXT NOT NULL, PRIMARY KEY (installation_id, kind, key))`,
			"CREATE INDEX contributions_kind_key ON contributions(kind, key)",
		].join(";\n"),
	},
	...REPO_CONFIG_REGISTRY_MIGRATIONS,
];
