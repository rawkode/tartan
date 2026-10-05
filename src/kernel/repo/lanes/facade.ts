// The `LaneBackend` facade (WP5a): one implementation per backend, chosen per
// lane by `lanes.mode`. The `repo` backend is WP5b's (`RepoBackend.backend`,
// from `./repo-backend/index.ts`), the `branch` backend WP5a's (`./branch.ts`).
// Which backend a NEW lane gets is decided in the open transaction (`ops.ts`):
// the repo's configured mode (`meta.lane_mode`, else `LANE_MODE`); anything but
// `branch` asks WP5b's `planOpening` (breaker, size flags, fallback chain,
// forge ceiling).

import type { LaneBackendName, LaneMode } from "@tartan/contract";
import type {
	LaneBackend,
	LaneRow,
	RepoBackend,
} from "@tartan/contract/kernel.ts";
import { type Core, getMeta } from "../core.ts";

export type LaneBackends = Readonly<Record<LaneBackendName, LaneBackend>>;

/** Both backends, keyed by `lanes.mode`. */
export const createLaneBackends = (parts: {
	readonly branch: LaneBackend;
	readonly repo: Pick<RepoBackend, "backend">;
}): LaneBackends => ({
	repo: parts.repo.backend,
	branch: parts.branch,
});

export const backendOf = (
	backends: LaneBackends,
	lane: Pick<LaneRow, "mode">,
): LaneBackend => backends[lane.mode];

const LANE_MODE_VALUES: readonly LaneMode[] = ["import", "branch"];

/** The repo's configured lane mode: `meta.lane_mode`, else the forge's `LANE_MODE`. */
export const configuredLaneMode = (core: Core): LaneMode => {
	const own = getMeta(core.sql, "lane_mode");
	return own !== null && (LANE_MODE_VALUES as readonly string[]).includes(own)
		? own as LaneMode
		: core.ports.laneMode;
};
