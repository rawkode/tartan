// Registry DDL for repository config (WP25, reviewed by WP7a; ForgeDO
// migrations 310–319 inside the registry's 300–399; ADR repo config,
// "Applying results").
//
// - `config_approvals`: an Owner's approval of a package version for
//   repository config at a node (ancestor-or-self of the repos it binds),
//   with the package sha256, the grants snapshot and the background role
//   that installations made from it get.
// - `config_approval_requests`: approvals waiting for their package's
//   self-check (`kind = 'approval'`), and an installed package version's
//   own self-check (`kind = 'check'`).
// - `installations` gains its source (`manual` | `repo-config`), the trunk
//   commit and input key it came from, the approval it is bound to, the
//   Owner's kill switch and the Owner's repo-overrides opt-in.
// - `packages.config_cue`: a published package's `config.cue` text;
//   `packages.config_checked`: the input key of its passing self-check
//   (NULL until then: the package is absent from every generated schema).
// - `repo_config_overlays`: settings a repository overlays on an inherited
//   installation, for that installation's ExtensionDO of that repo only.
// - `repo_config_state`: what is applied per repo node, and the fence.
// - `repo_config_dirty`: the outbox that pokes RepoDOs after a registry
//   change (`meta.config_epoch`).
// - `repo_config_watch`: repos whose RepoDO evaluated trunk config; a
//   registry change pokes them too, even before anything was applied there
//   (a first config the registry or CUE denied re-evaluates once allowed).
// - `repo_config_disabled`: an Owner's kill switch per (repo, extension),
//   kept apart from the installation row so that reconcile, a version change
//   or a revalidation cannot reset it; only an Owner clears it.
// - `repo_config_state.hold_id` (314): the gate-missing hold's
//   generation, moved by every gate loss, so an Owner's keep-last-good in
//   RepoDO covers only the losses it saw.
//
// Repo policy (the pipeline, the owners, the projects) is never stored here:
// RepoDO keeps the trunk config history it is read from.

import type { Migration } from "@tartan/contract/kernel.ts";

export const REPO_CONFIG_REGISTRY_MIGRATIONS: readonly Migration[] = [
	{
		n: 310,
		name: "registry: repo config approvals",
		sql: [
			`CREATE TABLE config_approvals (node_id TEXT NOT NULL REFERENCES nodes(id), ext_id TEXT NOT NULL,
  version TEXT NOT NULL, package_sha256 TEXT NOT NULL, grants_json TEXT NOT NULL,
  background_role INTEGER NOT NULL DEFAULT 20 CHECK (background_role IN (10,20,30,40)),
  needs_reapproval INTEGER NOT NULL DEFAULT 0,
  approved_by TEXT NOT NULL, approved_at INTEGER NOT NULL, PRIMARY KEY (node_id, ext_id),
  FOREIGN KEY (ext_id, version) REFERENCES packages(ext_id, version))`,
			"CREATE INDEX config_approvals_ext ON config_approvals(ext_id)",
			`CREATE TABLE config_approval_requests (id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'approval' CHECK (kind IN ('approval','check')),
  node_id TEXT NOT NULL, ext_id TEXT NOT NULL, version TEXT NOT NULL,
  background_role INTEGER NOT NULL, requested_by TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('checking','approved','refused','superseded')),
  input_key TEXT NOT NULL, result_json TEXT, at INTEGER NOT NULL)`,
			"CREATE INDEX config_approval_requests_target ON config_approval_requests(node_id, ext_id, at)",
			"CREATE INDEX config_approval_requests_pkg ON config_approval_requests(ext_id, version, state)",
		].join(";\n"),
	},
	{
		n: 311,
		name:
			"registry: installation source, packages.config_cue and config_checked",
		sql: [
			"ALTER TABLE installations ADD COLUMN source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','repo-config'))",
			"ALTER TABLE installations ADD COLUMN source_sha TEXT",
			"ALTER TABLE installations ADD COLUMN source_key TEXT",
			"ALTER TABLE installations ADD COLUMN approval_node TEXT",
			"ALTER TABLE installations ADD COLUMN owner_disabled INTEGER NOT NULL DEFAULT 0",
			"ALTER TABLE installations ADD COLUMN repo_overrides INTEGER NOT NULL DEFAULT 0",
			"CREATE INDEX installations_source ON installations(source, ext_id)",
			"ALTER TABLE packages ADD COLUMN config_cue TEXT",
			"ALTER TABLE packages ADD COLUMN config_checked TEXT",
		].join(";\n"),
	},
	{
		n: 312,
		name: "registry: repo config overlays, state, dirty outbox",
		sql: [
			`CREATE TABLE repo_config_overlays (installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  repo_node_id TEXT NOT NULL REFERENCES nodes(id), settings_json TEXT NOT NULL,
  source_sha TEXT NOT NULL, source_key TEXT NOT NULL, PRIMARY KEY (installation_id, repo_node_id))`,
			"CREATE INDEX repo_config_overlays_repo ON repo_config_overlays(repo_node_id)",
			`CREATE TABLE repo_config_state (node_id TEXT PRIMARY KEY REFERENCES nodes(id),
  applied_seq INTEGER NOT NULL, applied_epoch INTEGER NOT NULL, applied_key TEXT NOT NULL,
  applied_sha TEXT NOT NULL, hold_reason TEXT, principals_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL)`,
			`CREATE TABLE repo_config_dirty (node_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL,
  due_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)`,
			"CREATE INDEX repo_config_dirty_due ON repo_config_dirty(due_at)",
		].join(";\n"),
	},
	{
		n: 313,
		name: "registry: repo config watch set and the Owner's kill switch",
		sql: [
			"CREATE TABLE repo_config_watch (node_id TEXT PRIMARY KEY, at INTEGER NOT NULL)",
			`CREATE TABLE repo_config_disabled (repo_node_id TEXT NOT NULL, ext_id TEXT NOT NULL,
  disabled_by TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (repo_node_id, ext_id))`,
			`INSERT OR IGNORE INTO repo_config_disabled (repo_node_id, ext_id, disabled_by, at)
  SELECT node_id, ext_id, installed_by, COALESCE(mode_changed_at, installed_at) FROM installations
  WHERE source = 'repo-config' AND owner_disabled = 1`,
		].join(";\n"),
	},
	{
		n: 314,
		name: "registry: repo config hold generation",
		sql: [
			"ALTER TABLE repo_config_state ADD COLUMN hold_id INTEGER NOT NULL DEFAULT 0",
			"UPDATE repo_config_state SET hold_id = 1 WHERE hold_reason IS NOT NULL",
		].join(";\n"),
	},
];
