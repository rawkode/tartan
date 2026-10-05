// The `repo` lane backend (WP5b): each lane is its own Artifacts repo
// `l-<repoUlid>-<laneUlid>[-<n>]`, created with `import()` from the capability
// route, with branch lanes as the fallback. It is part of RepoDO's `core`
// module: WP5a's module creates it once per RepoDO with
// `createRepoBackend(deps)` (contract `RepoBackend`, `RepoBackendDeps`) and
// delegates to it; the transaction-by-transaction split between WP5a and WP5b
// is written down in contract `services.ts`.
//
// - `backend.ts`: the `repo` `LaneBackend` (remoteFor, readTip, fetchSpec, gc)
// - `seeder.ts`: planOpening, the fenced attempts, fallback, breaker strikes,
//   the `seed:<laneId>` watchdog and the re-drive (rules in `plan.ts`)
// - `capstate.ts`: capContext, capUse, capReport
// - `gc.ts`: lane GC, archive and purge on this backend
// - `sweep.ts`: the orphan sweep; `reconcile.ts`: lane-repo reconciliation
// - `selftest.ts`: the post-claim self-test and its Owner route
// - `cron.ts`: the `repoBackend` cron task
// RepoDO migrations 180–199 are this backend's (`schema.ts`).

import {
	invalid,
	type RepoLaneSettingsRequest,
	RepoLaneSettingsRequestSchema,
} from "@tartan/contract";
import type {
	CreateRepoBackend,
	Migration,
	MigrationRange,
	RepoBackend,
	RepoBackendDeps,
} from "@tartan/contract/kernel.ts";
import type { Env } from "../../../../env.ts";
import type { Core } from "../../core.ts";
import { createLaneSettings, readLaneSettings } from "../settings.ts";
import { createRepoLaneBackend } from "./backend.ts";
import { createCapState } from "./capstate.ts";
import { createCtx, defaultPorts, type RepoBackendPorts } from "./context.ts";
import { createLaneRepoGc } from "./gc.ts";
import { createLaneRepoReconciler } from "./reconcile.ts";
import { REPO_BACKEND_MIGRATIONS } from "./schema.ts";
import { createSeeder } from "./seeder.ts";
import { createSweep } from "./sweep.ts";

export { handleLaneSelfTest, runLaneSelfTest } from "./selftest.ts";
export type { RepoBackendPorts } from "./context.ts";

/** RepoDO `core` migration numbers reserved for this backend. */
export const REPO_BACKEND_MIGRATION_RANGE = [
	180,
	199,
] as const satisfies MigrationRange;

/** This backend's own migrations; part of the `core` module's list. */
export const repoBackendMigrations: readonly Migration[] =
	REPO_BACKEND_MIGRATIONS;

/** The `repo` backend with some ports replaced (tests). */
export const createRepoBackendWith = (
	deps: RepoBackendDeps<Env>,
	overrides: Partial<RepoBackendPorts> = {},
): RepoBackend => {
	const ctx = createCtx(deps, { ...defaultPorts(deps), ...overrides });
	const seeder = createSeeder(ctx, {
		ceilingCache: { reached: false, at: 0 },
	});
	const caps = createCapState(ctx);
	const gc = createLaneRepoGc(ctx);
	const sweep = createSweep(ctx);
	const reconciler = createLaneRepoReconciler(ctx);
	// The lane settings are WP5a's `meta` reads and writes; the core module
	// serves them itself (`lanes/settings.ts`). These answer the same.
	const settingsCore = (): Core =>
		({
			sql: deps.sql,
			tx: (closure: () => unknown) => deps.storage.transactionSync(closure),
			clock: deps.clock,
			ports: { laneMode: ctx.ports.laneMode },
		}) as unknown as Core;
	return {
		backend: createRepoLaneBackend(ctx, gc),
		planOpening: seeder.planOpening,
		startAttempt: seeder.startAttempt,
		seedLane: seeder.seedLane,
		onSeedTimer: seeder.onSeedTimer,
		redriveSeeds: seeder.redriveSeeds,
		capContext: caps.capContext,
		capUse: caps.capUse,
		capReport: caps.capReport,
		archive: gc.archive,
		purge: gc.purge,
		sweepLaneRepos: sweep.sweepLaneRepos,
		reconcileLaneRepos: reconciler.reconcileLaneRepos,
		laneSettings: () => Promise.resolve(readLaneSettings(settingsCore())),
		setLaneSettings: (input: RepoLaneSettingsRequest) => {
			const parsed = RepoLaneSettingsRequestSchema.safeParse(input);
			if (!parsed.success) throw invalid("invalid lane settings");
			return Promise.resolve(
				createLaneSettings({ core: settingsCore() }).set(parsed.data),
			);
		},
	};
};

/**
 * WP5b's factory (contract `CreateRepoBackend`): the `repo` `LaneBackend`,
 * the seeder (`planOpening` inside WP5a's open transaction, `startAttempt`
 * after it, the `seed:<laneId>` watchdog, the re-drive), the capability
 * state, archive and purge on this backend, the orphan sweep, lane-repo
 * reconciliation and the lane settings.
 */
export const createRepoBackend: CreateRepoBackend<Env> = (deps) =>
	createRepoBackendWith(deps);
