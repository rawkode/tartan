// RepoDO `land` DDL (WP10, migrations 350–399).
//
// The land tables (`land_batches`, `land_verdicts`, `advances` with the K5
// partial unique index, `landings`, `note_sections`, `gate_replays`) plus
// what the Advance needs beyond them:
// - `land_batches.request_hash`: `submit` is idempotent on the batch id
//   with the same content, and different content is `conflict`;
// - `land_changes`: one row per change of a batch, the per-change state the
//   Advance carries between steps (outcome, the composed commit, the lane
//   head it was composed from, paths, conflict regions, gate decisions and
//   the attribution the squash message was composed with).

import type { Migration } from "@tartan/contract/kernel.ts";

export const LAND_MIGRATIONS: readonly Migration[] = [
	{
		n: 350,
		name: "land",
		sql: [
			`CREATE TABLE land_batches (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL UNIQUE,
  ref TEXT NOT NULL,
  instance_created INTEGER NOT NULL DEFAULT 0,
  requested_by TEXT NOT NULL,
  partition_key TEXT,
  base_sha TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  candidate_sha TEXT,
  changes_json TEXT NOT NULL,
  reason_json TEXT NOT NULL,
  affected_json TEXT,
  test_policy TEXT NOT NULL CHECK (test_policy IN ('checks','none')),
  state TEXT NOT NULL CHECK (state IN ('composing','gating','testing','advancing','landed','conflicted','vetoed','failed','stale','cancelled')),
  result_json TEXT,
  request_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  finished_at INTEGER)`,
			"CREATE INDEX land_batches_state ON land_batches(state, created_at)",
			"CREATE INDEX land_batches_outbox ON land_batches(created_at) WHERE instance_created = 0",
			`CREATE TABLE land_verdicts (
  batch_id TEXT NOT NULL REFERENCES land_batches(id),
  attempt INTEGER NOT NULL,
  candidate_sha TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('success','failure')),
  run_ids_json TEXT NOT NULL,
  evidence_json TEXT,
  reported_by TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (batch_id, attempt))`,
			`CREATE TABLE advances (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES land_batches(id),
  attempt INTEGER NOT NULL,
  ref TEXT NOT NULL,
  expect_old TEXT NOT NULL,
  new_sha TEXT,
  owner_instance TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  step TEXT NOT NULL DEFAULT 'locked' CHECK (step IN ('locked','restacked','trunk-pushed','notes-pushed','refs-pushed')),
  state TEXT NOT NULL CHECK (state IN ('locked','pushing','done','stale','failed','released')),
  evidence_reused INTEGER NOT NULL DEFAULT 0,
  gate_results_json TEXT,
  chain_seq INTEGER,
  chain_head TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  UNIQUE (batch_id, attempt))`,
			"CREATE UNIQUE INDEX advances_one_inflight ON advances(ref) WHERE state IN ('locked','pushing')",
			"CREATE INDEX advances_lease ON advances(lease_until) WHERE state IN ('locked','pushing')",
			`CREATE TABLE landings (
  commit_sha TEXT PRIMARY KEY,
  advance_id TEXT NOT NULL,
  change_id TEXT NOT NULL,
  lane_id TEXT NOT NULL,
  lane_head TEXT NOT NULL,
  trunk_seq INTEGER NOT NULL UNIQUE,
  paths_json TEXT NOT NULL,
  projects_json TEXT NOT NULL,
  at INTEGER NOT NULL)`,
			"CREATE INDEX landings_lane ON landings(lane_id, at)",
			"CREATE INDEX landings_change ON landings(change_id)",
			"CREATE INDEX landings_advance ON landings(advance_id)",
			`CREATE TABLE note_sections (
  change_id TEXT NOT NULL,
  ext_id TEXT NOT NULL,
  section_json TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (change_id, ext_id))`,
			`CREATE TABLE gate_replays (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  advances_json TEXT NOT NULL,
  results_json TEXT,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL)`,
			`CREATE TABLE land_changes (
  batch_id TEXT NOT NULL REFERENCES land_batches(id),
  change_id TEXT NOT NULL,
  lane_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  head TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending','landed','conflicted','vetoed')),
  attempt INTEGER,
  commit_sha TEXT,
  paths_json TEXT,
  conflict_json TEXT,
  gates_json TEXT,
  provenance_json TEXT,
  PRIMARY KEY (batch_id, change_id))`,
			"CREATE INDEX land_changes_lane ON land_changes(lane_id)",
		].join(";\n"),
	},
	{
		// The candidate sweep selects only batches whose
		// candidate ref was not deleted yet, oldest first.
		n: 351,
		name: "land_candidate_swept",
		sql: [
			"ALTER TABLE land_batches ADD COLUMN candidate_swept INTEGER NOT NULL DEFAULT 0",
			"CREATE INDEX land_batches_candidates ON land_batches(finished_at, id) WHERE finished_at IS NOT NULL AND candidate_swept = 0",
		].join(";\n"),
	},
];
