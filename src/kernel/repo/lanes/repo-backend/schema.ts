// The `repo` lane backend's own tables (WP5b, RepoDO `core` 180–199). The
// `lanes` DDL of both backends is WP5a's; these tables only hold what the
// seeder, lane GC, reconciliation and the orphan sweep need to remember across
// attempts and evictions:
//
// - `lane_seed_attempts`: one row per seed attempt (the fallback rules count
//   retries per lane, the breaker counts lanes with a platform-side failure,
//   and `fetchSpec` needs each lane repo's remote synchronously);
// - `lane_repo_sightings`: when the orphan sweep first saw an `l-*` name that
//   has no `artifacts_index` row (its age);
// - `lane_repo_upkeep`: per-lane reconciliation pacing and lane GC's
//   deferral clock (the 24 h change-ref alert).

import type { Migration } from "@tartan/contract/kernel.ts";

export const REPO_BACKEND_MIGRATIONS: readonly Migration[] = [
	{
		n: 180,
		name: "repo-backend: seed attempts, sightings, upkeep",
		sql: `
CREATE TABLE lane_seed_attempts (
	lane_id TEXT NOT NULL,
	attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 9),
	seed TEXT NOT NULL CHECK (seed IN ('import')),
	repo_name TEXT NOT NULL UNIQUE,
	base_sha TEXT NOT NULL,
	remote TEXT,
	started_at INTEGER NOT NULL,
	ended_at INTEGER,
	outcome TEXT CHECK (outcome IN ('open','failed','fenced')),
	code TEXT,
	PRIMARY KEY (lane_id, attempt)
);
CREATE TABLE lane_repo_sightings (
	name TEXT PRIMARY KEY,
	first_seen_at INTEGER NOT NULL
);
CREATE TABLE lane_repo_upkeep (
	lane_id TEXT PRIMARY KEY,
	reconciled_at INTEGER,
	gc_deferred_since INTEGER,
	gc_alerted_at INTEGER
);
`,
	},
];

/** One `lane_seed_attempts` row. */
export type SeedAttemptRow = {
	lane_id: string;
	attempt: number;
	seed: "import";
	repo_name: string;
	base_sha: string;
	remote: string | null;
	started_at: number;
	ended_at: number | null;
	outcome: "open" | "failed" | "fenced" | null;
	code: string | null;
};

export type UpkeepRow = {
	lane_id: string;
	reconciled_at: number | null;
	gc_deferred_since: number | null;
	gc_alerted_at: number | null;
};
