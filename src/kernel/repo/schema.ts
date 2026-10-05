// RepoDO `core` DDL (WP5a, migrations 100–179). The whole
// `lanes` table of both backends lives here (the `repo` backend's seeder and
// capability columns included), so WP5b needs no migration of its own.
//
// Columns beyond the base schema, each needed by the contract or by the
// behaviour:
// - `lanes.change_id` (contract `LaneRow`, set by `applyLaneEventSync`).
// - `pushes` is unique on `(via, request_id, ref)`, not `(via, request_id)`:
//   one gateway request may update several refs, one row each.
// - `pending_observations.tampered_at`: an observation that raised
//   `ref.tampered` stays until an Owner acknowledges it, so `ackTampered`
//   knows which observed values to adopt.
// - `trigger_seen`: trigger event ids already handled (`observePush` is
//   idempotent per event id even when the event merged into another row).
// - `push_leases`: the U48 fallback's per-ref push leases
//   (`PUSH_LEASE_ENABLED`; unused while the switch is off).

import type { Migration } from "@tartan/contract/kernel.ts";

const CORE_TABLES = `
CREATE TABLE refs (
	ref TEXT PRIMARY KEY,
	sha TEXT NOT NULL,
	updated_at INTEGER NOT NULL,
	push_id TEXT,
	peeled TEXT,
	reconciled_at INTEGER
);
CREATE TABLE trunk_commits (
	sha TEXT PRIMARY KEY,
	seq INTEGER NOT NULL UNIQUE,
	source TEXT NOT NULL CHECK (source IN ('genesis','import','advance','seed'))
);
CREATE TABLE lanes (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL DEFAULT 'lane' CHECK (kind IN ('lane','adopted')),
	mode TEXT NOT NULL CHECK (mode IN ('repo','branch')),
	repo_name TEXT UNIQUE,
	seed TEXT CHECK (seed IN ('import')),
	seed_ms INTEGER,
	seed_attempt INTEGER NOT NULL DEFAULT 0,
	seed_phase TEXT CHECK (seed_phase IN ('cap','importing','verifying')),
	seed_deadline INTEGER,
	cap_nonce TEXT UNIQUE,
	cap_uses INTEGER NOT NULL DEFAULT 0,
	cap_consumed_at INTEGER,
	cap_outcome TEXT CHECK (cap_outcome IN ('served','trunk-moved','aborted','upstream-error')),
	ref TEXT NOT NULL,
	owner_principal TEXT NOT NULL,
	on_behalf_of TEXT,
	delegates_json TEXT NOT NULL DEFAULT '[]',
	opened_by_installation TEXT,
	entity_kind TEXT,
	entity_id TEXT,
	change_id TEXT,
	footprint_json TEXT NOT NULL DEFAULT '{"projects":[],"prefixes":[]}',
	depends_on_lane TEXT REFERENCES lanes(id),
	base_sha TEXT NOT NULL,
	head_sha TEXT,
	state TEXT NOT NULL CHECK (state IN ('opening','open','submitted','landing','landed','closed','lost','archived','deleted')),
	quarantined INTEGER NOT NULL DEFAULT 0 CHECK (quarantined IN (0, 1)),
	lease_expires_at INTEGER NOT NULL,
	last_push_at INTEGER,
	pushes INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	closed_at INTEGER,
	delete_after INTEGER,
	CHECK ((mode = 'repo') = (repo_name IS NOT NULL)),
	CHECK (mode = 'repo' OR (seed IS NULL AND cap_nonce IS NULL)),
	CHECK (kind = 'lane' OR mode = 'branch')
);
CREATE UNIQUE INDEX lanes_active_ref ON lanes(ref)
	WHERE mode = 'branch' AND state NOT IN ('closed','archived','deleted');
CREATE INDEX lanes_state ON lanes(state);
CREATE INDEX lanes_owner ON lanes(owner_principal, state);
CREATE INDEX lanes_entity ON lanes(entity_kind, entity_id);
CREATE INDEX lanes_gc ON lanes(delete_after) WHERE delete_after IS NOT NULL;
CREATE INDEX lanes_change ON lanes(change_id) WHERE change_id IS NOT NULL;
CREATE TABLE pushes (
	id TEXT PRIMARY KEY,
	at INTEGER NOT NULL,
	target TEXT NOT NULL,
	repo_name TEXT,
	bytes INTEGER,
	ref TEXT NOT NULL,
	before TEXT NOT NULL,
	after TEXT NOT NULL,
	principal_id TEXT,
	on_behalf_of TEXT,
	token_id TEXT,
	via TEXT NOT NULL CHECK (via IN ('gateway','trigger','kernel','swarm','reconcile')),
	seen_via_json TEXT NOT NULL DEFAULT '[]',
	request_id TEXT,
	kernel_write_id TEXT,
	range_base TEXT,
	range_truncated INTEGER,
	diff_state TEXT NOT NULL DEFAULT 'pending' CHECK (diff_state IN ('pending','done','skipped')),
	diff_key TEXT,
	UNIQUE (via, request_id, ref)
);
CREATE INDEX pushes_target ON pushes(target, at);
CREATE INDEX pushes_transition ON pushes(target, ref, before, after, at);
CREATE INDEX pushes_diff ON pushes(diff_state, at) WHERE diff_state = 'pending';
CREATE INDEX pushes_ref ON pushes(ref, at);
CREATE TABLE commit_firsts (
	sha TEXT PRIMARY KEY,
	principal_id TEXT,
	push_id TEXT NOT NULL,
	at INTEGER NOT NULL
);
CREATE TABLE kernel_writes (
	id TEXT PRIMARY KEY,
	target TEXT NOT NULL DEFAULT 'repo',
	ref TEXT NOT NULL,
	expect_old TEXT NOT NULL,
	new_sha TEXT NOT NULL,
	purpose TEXT NOT NULL CHECK (purpose IN ('candidate','trunk','notes','change-ref','attic','lane-sync','lane-seed','lane-gc','lane-delete','purge','genesis','seed')),
	owner_kind TEXT NOT NULL CHECK (owner_kind IN ('land','job','kernel')),
	owner_id TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('intent','pushed','observed','abandoned')),
	supersedes TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX kernel_writes_match ON kernel_writes(target, ref, new_sha);
CREATE INDEX kernel_writes_open ON kernel_writes(state, updated_at);
CREATE TABLE pending_observations (
	id TEXT PRIMARY KEY,
	target TEXT NOT NULL DEFAULT 'repo',
	repo_name TEXT,
	ref TEXT NOT NULL,
	before TEXT NOT NULL,
	after TEXT NOT NULL,
	source TEXT NOT NULL CHECK (source IN ('trigger','reconcile')),
	lane_id TEXT,
	observed_at INTEGER NOT NULL,
	recheck_at INTEGER NOT NULL,
	checks INTEGER NOT NULL DEFAULT 0,
	tampered_at INTEGER
);
CREATE INDEX pending_observations_due ON pending_observations(recheck_at)
	WHERE tampered_at IS NULL;
CREATE INDEX pending_observations_match ON pending_observations(target, ref, after);
CREATE TABLE trigger_seen (
	event_id TEXT PRIMARY KEY,
	at INTEGER NOT NULL
);
CREATE INDEX trigger_seen_at ON trigger_seen(at);
CREATE TABLE push_leases (
	lane_id TEXT NOT NULL,
	ref TEXT NOT NULL,
	request_id TEXT NOT NULL,
	expires_at INTEGER NOT NULL,
	PRIMARY KEY (lane_id, ref)
)`.trim();

/** WP5a's migrations (100–179), in order. */
export const CORE_MIGRATIONS: readonly Migration[] = [
	{
		n: 100,
		name:
			"refs, trunk_commits, lanes, pushes, commit_firsts, kernel_writes, pending_observations",
		sql: CORE_TABLES,
	},
];
