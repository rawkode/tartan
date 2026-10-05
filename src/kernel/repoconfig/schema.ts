// RepoDO `repoconfig` DDL (WP25, migrations 400–429; ADR repo config,
// "Cache and state").
//
// - `config_evals`: the content-addressed cache (input key → envelope),
//   with each root `*.cue` file's `[name, oid, sha256]` and where it first
//   ran;
// - `config_jobs`: evaluations dispatched to a `cue:*` sandbox and their
//   deadlines (the watchdog re-dispatches);
// - `config_head`: the state machine (one row) and the fence's trunk
//   position `obs_seq`, a monotonic count of trunk observations;
// - `config_apply_intents`: fenced applies, completed by the `apply` timer
//   with idempotent retries; `row_seq` names the trunk config row the
//   answer resolves;
// - `config_trunk`: the trunk config history repo policy is read from (one
//   row per trunk commit at which the root `*.cue` files changed, keyed by
//   `trunk_commits.seq`; never rewritten by a registry re-evaluation; the
//   newest 50 are kept);
// - `config_previews`: the latest preview per lane;
// - `policy_signoffs`: kernel-recorded sign-offs (K13.3), bound to the root
//   `*.cue` digest at the head;
// - `config_lane_paths`: whether a lane head's range touches a policy path,
//   from its `push.diffed`.
//
// Migration 401 (review fixes): `config_jobs` is keyed by (input key,
// family), so a trunk evaluation never joins or is answered by a preview
// job of the same key, and a preview never re-marks a trunk job; the head
// records what an Owner's keep-last-good covers (the pending row, ForgeDO's
// gate-missing hold, or both); a trunk row keeps the signers of the landing
// that opened it; an apply intent records its cause; a preview row counts
// its retries.
//
// Migration 402: ForgeDO's gate-missing hold carries a
// generation (`forge_hold_id`), and `override_gate` now names the generation
// an Owner's keep-last-good covers, so a later gate loss holds again; the
// head records since when lands are held and which hold the Owners were
// told about.
//
// Migration 403: the switch as the repo last saw it
// (`enabled_state`, `off_tip`) and the boot row (`boot_seq`): turning the
// switch on drops the trunk history it may no longer match and opens the
// tip's row, whose config nobody signed, so it is not repo policy until a
// Maintainer applies it.
//
// The applied installations and overlays live only in ForgeDO.

import type { Migration } from "@tartan/contract/kernel.ts";

export const REPO_CONFIG_MIGRATIONS: readonly Migration[] = [
	{
		n: 400,
		name: "repoconfig",
		sql: [
			`CREATE TABLE config_evals (input_key TEXT PRIMARY KEY, evaluator TEXT NOT NULL,
  schema_key TEXT NOT NULL, origin TEXT NOT NULL CHECK (origin IN ('trunk','preview')),
  files_json TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('ok','error')),
  code TEXT, resolved_json TEXT, error_json TEXT, first_sha TEXT NOT NULL, first_lane TEXT,
  cue_version TEXT, finished_at INTEGER NOT NULL, used_at INTEGER NOT NULL)`,
			"CREATE INDEX config_evals_used ON config_evals(used_at)",
			`CREATE TABLE config_jobs (input_key TEXT PRIMARY KEY,
  class TEXT NOT NULL CHECK (class IN ('trunk','apply','external','registry','preview')),
  sha TEXT NOT NULL, lane_id TEXT, schema_key TEXT NOT NULL, epoch INTEGER NOT NULL,
  files_json TEXT NOT NULL, sandbox TEXT NOT NULL, principal TEXT,
  dispatched_at INTEGER, deadline_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER)`,
			`CREATE TABLE config_head (id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL CHECK (status IN ('unconfigured','current','pending','failed','stale','needs-apply')),
  obs_seq INTEGER NOT NULL DEFAULT 0, trunk_sha TEXT,
  pending_seq INTEGER, pending_sha TEXT, pending_key TEXT, pending_cause TEXT,
  pending_row_seq INTEGER,
  pending_principals_json TEXT, pending_removal_ok INTEGER NOT NULL DEFAULT 0,
  hold INTEGER NOT NULL DEFAULT 0, override_by TEXT,
  applied_seq INTEGER, applied_epoch INTEGER, applied_sha TEXT, applied_key TEXT,
  applied_principals_json TEXT, applied_at INTEGER,
  forge_hold TEXT, epoch_seen INTEGER NOT NULL DEFAULT 0,
  external_due INTEGER NOT NULL DEFAULT 0, external_cause TEXT, external_by TEXT,
  registry_due INTEGER NOT NULL DEFAULT 0,
  plan_json TEXT, plan_key TEXT, failure_json TEXT, unavailable_until INTEGER,
  eval_attempts INTEGER NOT NULL DEFAULT 0, last_eval_at INTEGER, reeval_at INTEGER, cue_version TEXT,
  root_files_json TEXT, legacy_dir INTEGER NOT NULL DEFAULT 0, trunk_pruned_seq INTEGER,
  updated_at INTEGER NOT NULL)`,
			`CREATE TABLE config_apply_intents (trunk_seq INTEGER NOT NULL, epoch INTEGER NOT NULL,
  input_key TEXT NOT NULL, schema_key TEXT NOT NULL, sha TEXT NOT NULL, principals_json TEXT NOT NULL,
  explicit INTEGER NOT NULL DEFAULT 0, removal INTEGER NOT NULL DEFAULT 0, row_seq INTEGER,
  state TEXT NOT NULL CHECK (state IN ('pending','done','refused')),
  attempts INTEGER NOT NULL DEFAULT 0, answer_json TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY (trunk_seq, epoch))`,
			"CREATE INDEX config_apply_intents_pending ON config_apply_intents(state, trunk_seq)",
			`CREATE TABLE config_trunk (trunk_seq INTEGER PRIMARY KEY, sha TEXT NOT NULL,
  policy_digest TEXT, input_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','ok','error','none')),
  code TEXT, message TEXT, issues_json TEXT, at INTEGER NOT NULL)`,
			`CREATE TABLE config_previews (lane_id TEXT PRIMARY KEY, head_sha TEXT NOT NULL,
  input_key TEXT, status TEXT NOT NULL, requested_by TEXT NOT NULL, result_json TEXT,
  updated_at INTEGER NOT NULL)`,
			"CREATE INDEX config_previews_key ON config_previews(input_key)",
			`CREATE TABLE policy_signoffs (lane_id TEXT NOT NULL, head TEXT NOT NULL,
  event_id TEXT NOT NULL, signed_by TEXT NOT NULL, policy_digest TEXT,
  revoked_at INTEGER, at INTEGER NOT NULL, PRIMARY KEY (lane_id, head))`,
			`CREATE TABLE config_lane_paths (lane_id TEXT NOT NULL, head TEXT NOT NULL,
  touched INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (lane_id, head))`,
		].join(";\n"),
	},
	{
		n: 401,
		name:
			"repoconfig: job families, override scope, row signers, intent cause, preview retries",
		sql: [
			`CREATE TABLE config_jobs_v2 (input_key TEXT NOT NULL,
  family TEXT NOT NULL CHECK (family IN ('trunk','preview')),
  class TEXT NOT NULL CHECK (class IN ('trunk','apply','external','registry','preview')),
  sha TEXT NOT NULL, lane_id TEXT, schema_key TEXT NOT NULL, epoch INTEGER NOT NULL,
  files_json TEXT NOT NULL, sandbox TEXT NOT NULL, principal TEXT,
  dispatched_at INTEGER, deadline_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER,
  PRIMARY KEY (input_key, family))`,
			`INSERT INTO config_jobs_v2 (input_key, family, class, sha, lane_id, schema_key, epoch, files_json,
  sandbox, principal, dispatched_at, deadline_at, attempts, next_at)
  SELECT input_key, CASE WHEN class = 'preview' THEN 'preview' ELSE 'trunk' END, class, sha, lane_id,
  schema_key, epoch, files_json, sandbox, principal, dispatched_at, deadline_at, attempts, next_at
  FROM config_jobs`,
			"DROP TABLE config_jobs",
			"ALTER TABLE config_jobs_v2 RENAME TO config_jobs",
			"ALTER TABLE config_head ADD COLUMN override_pending INTEGER NOT NULL DEFAULT 0",
			"ALTER TABLE config_head ADD COLUMN override_gate INTEGER NOT NULL DEFAULT 0",
			"UPDATE config_head SET override_pending = 1 WHERE override_by IS NOT NULL AND pending_sha IS NOT NULL",
			"UPDATE config_head SET override_gate = 1 WHERE override_by IS NOT NULL AND forge_hold IS NOT NULL",
			"ALTER TABLE config_trunk ADD COLUMN principals_json TEXT",
			"ALTER TABLE config_apply_intents ADD COLUMN cause TEXT",
			"ALTER TABLE config_previews ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",
		].join(";\n"),
	},
	{
		n: 402,
		name: "repoconfig: hold generation, held since, hold notice",
		sql: [
			"ALTER TABLE config_head ADD COLUMN forge_hold_id INTEGER NOT NULL DEFAULT 0",
			"ALTER TABLE config_head ADD COLUMN held_since INTEGER",
			"ALTER TABLE config_head ADD COLUMN hold_noticed TEXT",
			"UPDATE config_head SET forge_hold_id = 1 WHERE forge_hold IS NOT NULL",
		].join(";\n"),
	},
	{
		n: 403,
		name: "repoconfig: the switch's transitions and the unsigned boot row",
		sql: [
			"ALTER TABLE config_head ADD COLUMN enabled_state INTEGER NOT NULL DEFAULT 0",
			"ALTER TABLE config_head ADD COLUMN off_tip TEXT",
			"ALTER TABLE config_head ADD COLUMN boot_seq INTEGER",
			// A repo that already ran with the switch on is on.
			`UPDATE config_head SET enabled_state = 1 WHERE applied_key IS NOT NULL
  OR status <> 'unconfigured' OR EXISTS (SELECT 1 FROM config_trunk)`,
		].join(";\n"),
	},
];
