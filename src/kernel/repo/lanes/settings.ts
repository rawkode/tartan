// A repo's lane settings (WP5a): the Owner's lane mode override
// (`meta.lane_mode`), the active lane cap (`meta.max_active_lanes`) and the
// attic retention (`meta.attic_retention_ms`), plus what the `repo` backend
// records in `meta` for display (breaker, size flag, trunk pack estimate) and
// the lane repos this repo retains.
//
// Every value lives in `meta` and `lanes`, whose DDL is WP5a's for both
// backends, so the core module serves the settings itself: they answer on the
// `branch` backend (M1) without WP5b's `RepoBackend`.
// WP5b's seeder only writes the breaker and size keys this module reads.

import {
	ATTIC_RETENTION_DEFAULT_MS,
	invalid,
	type LaneMode,
	LaneModeSchema,
	type RepoLaneSettingsDto,
	type RepoLaneSettingsRequest,
} from "@tartan/contract";
import type { LaneBreakerState } from "@tartan/contract/kernel.ts";
import {
	MAX_ACTIVE_LANES,
	MAX_ACTIVE_LANES_REPO_BACKEND,
	MAX_LANE_REPOS_FORGE,
} from "../../../constants.ts";
import { type Core, getMeta, getMetaNumber, scalar, setMeta } from "../core.ts";
import { configuredLaneMode } from "./facade.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The lane modes an Owner may pick as the repo's override: lanes in their own
 * Artifacts repo created with `import()` (WP5b's `repo` backend, milestone
 * M2), or branch lanes. The forge default (`LANE_MODE`) is a separate switch
 * the integrator flips after the live proof.
 */
export const OWNER_LANE_MODES: readonly LaneMode[] = ["import", "branch"];

export type LaneSettingsDeps = {
	readonly core: Core;
	/** The modes an Owner may choose (default `OWNER_LANE_MODES`). */
	readonly modes?: readonly LaneMode[];
};

const breakerOf = (core: Core): LaneBreakerState | null => {
	const raw = getMeta(core.sql, "lane_breaker");
	if (raw === null) return null;
	try {
		const value = JSON.parse(raw) as unknown;
		return typeof value === "object" && value !== null
			? value as LaneBreakerState
			: null;
	} catch {
		return null;
	}
};

/** The repo's lane settings, read from `meta` and `lanes`. */
export const readLaneSettings = (core: Core): RepoLaneSettingsDto => {
	const now = core.clock.now();
	const laneMode = configuredLaneMode(core);
	const breaker = breakerOf(core);
	const degraded = breaker?.until !== undefined && breaker.until > now &&
			LaneModeSchema.safeParse(breaker.degradedTo).success
		? { mode: breaker.degradedTo as LaneMode, until: breaker.until }
		: null;
	const tooLargeUntil = getMetaNumber(core.sql, "import_too_large_until");
	const retentionMs = getMetaNumber(core.sql, "attic_retention_ms") ??
		ATTIC_RETENTION_DEFAULT_MS;
	return {
		laneMode,
		effectiveMode: degraded?.mode ?? laneMode,
		...(degraded ? { degradedUntil: degraded.until } : {}),
		...(tooLargeUntil !== null && tooLargeUntil > now
			? { importTooLargeUntil: tooLargeUntil }
			: {}),
		trunkPackBytes: getMetaNumber(core.sql, "trunk_pack_bytes"),
		maxActiveLanes: getMetaNumber(core.sql, "max_active_lanes") ??
			(laneMode === "branch"
				? MAX_ACTIVE_LANES
				: MAX_ACTIVE_LANES_REPO_BACKEND),
		atticRetentionDays: Math.max(1, Math.round(retentionMs / DAY_MS)),
		retainedLaneRepos: scalar(
			core.sql,
			"SELECT COUNT(*) AS n FROM lanes WHERE mode = 'repo' AND state <> 'deleted'",
		),
		maxLaneReposForge: MAX_LANE_REPOS_FORGE,
	};
};

export const createLaneSettings = (deps: LaneSettingsDeps) => {
	const { core } = deps;
	const modes = deps.modes ?? OWNER_LANE_MODES;
	return {
		get: (): RepoLaneSettingsDto => readLaneSettings(core),
		/** After the caller's Owner check; `input` is already parsed. */
		set: (input: RepoLaneSettingsRequest): RepoLaneSettingsDto => {
			const mode = input.laneMode;
			// Re-sending the configured mode (the form posts it back) is no change.
			if (
				mode !== undefined && mode !== null && !modes.includes(mode) &&
				mode !== configuredLaneMode(core)
			) {
				throw invalid(
					`lane mode ${mode} is not available on this forge yet: lanes in their own repository arrive with milestone M2`,
				);
			}
			core.tx(() => {
				if (mode !== undefined) setMeta(core.sql, "lane_mode", mode);
				if (input.maxActiveLanes !== undefined) {
					setMeta(core.sql, "max_active_lanes", input.maxActiveLanes);
				}
				if (input.atticRetentionDays !== undefined) {
					setMeta(
						core.sql,
						"attic_retention_ms",
						input.atticRetentionDays * DAY_MS,
					);
				}
			});
			return readLaneSettings(core);
		},
	};
};

export type LaneSettings = ReturnType<typeof createLaneSettings>;
