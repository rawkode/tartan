// `lanes` rows and their mapping to the contract `Lane`
// (caps, MCP, the API). The Artifacts repo name is never part of a `Lane`:
// targets are always `{repoId, laneId}`.

import {
	EMPTY_FOOTPRINT,
	type EntityRef,
	type Footprint,
	type Lane,
	LANE_RESUME_MS,
	laneLocalBranch,
	laneRemotePath,
	type LaneState,
} from "@tartan/contract";
import type { LaneRow } from "@tartan/contract/kernel.ts";
import { first, rows } from "../core.ts";

/** Lanes a principal may write and that count against the caps. */
export const ACTIVE_STATES: readonly LaneState[] = [
	"open",
	"submitted",
	"landing",
	"lost",
];
/** Active plus `opening` (an `opening` lane counts against the caps, K16). */
export const LIVE_STATES: readonly LaneState[] = ["opening", ...ACTIVE_STATES];
export const ENDED_STATES: readonly LaneState[] = [
	"closed",
	"archived",
	"deleted",
];

export const sqlList = (values: readonly string[]): string =>
	values.map((value) => `'${value.replace(/'/g, "''")}'`).join(",");

export const LIVE_SQL = sqlList(LIVE_STATES);
export const ACTIVE_SQL = sqlList(ACTIVE_STATES);

export const laneRow = (sql: SqlStorage, laneId: string): LaneRow | null =>
	first<LaneRow>(sql, "SELECT * FROM lanes WHERE id = ?", laneId);

export const laneByRepoName = (
	sql: SqlStorage,
	repoName: string,
): LaneRow | null =>
	first<LaneRow>(sql, "SELECT * FROM lanes WHERE repo_name = ?", repoName);

export const delegatesOf = (
	lane: Pick<LaneRow, "delegates_json">,
): string[] => {
	try {
		const parsed = JSON.parse(lane.delegates_json) as unknown;
		return Array.isArray(parsed)
			? parsed.filter((value): value is string => typeof value === "string")
			: [];
	} catch {
		return [];
	}
};

export const footprintOf = (
	lane: Pick<LaneRow, "footprint_json">,
): Footprint => {
	try {
		const parsed = JSON.parse(lane.footprint_json) as Footprint;
		return {
			projects: Array.isArray(parsed.projects) ? parsed.projects : [],
			prefixes: Array.isArray(parsed.prefixes) ? parsed.prefixes : [],
		};
	} catch {
		return EMPTY_FOOTPRINT;
	}
};

export const entityOf = (
	lane: Pick<LaneRow, "entity_kind" | "entity_id">,
): EntityRef | undefined =>
	lane.entity_kind !== null && lane.entity_id !== null
		? { kind: lane.entity_kind, id: lane.entity_id }
		: undefined;

/** The owner or a listed delegate. */
export const mayWriteLane = (lane: LaneRow, principal: string): boolean =>
	lane.owner_principal === principal ||
	delegatesOf(lane).includes(principal);

export const isLive = (lane: Pick<LaneRow, "state">): boolean =>
	LIVE_STATES.includes(lane.state);
export const isActive = (lane: Pick<LaneRow, "state">): boolean =>
	ACTIVE_STATES.includes(lane.state);

/** False only for a `lost` lane past its 24 h resume window. */
export const isResumable = (lane: LaneRow, now: number): boolean =>
	lane.state !== "lost" || lane.lease_expires_at + LANE_RESUME_MS > now;

/** The local branch agents use: `lanes/<id>`, or the adopted branch's name. */
const localBranch = (lane: LaneRow): string =>
	lane.kind === "adopted"
		? lane.ref.replace(/^refs\/heads\//, "")
		: laneLocalBranch(lane.id);

export const toLane = (lane: LaneRow, repo: {
	readonly repoId: string;
	readonly path: string;
}): Lane => {
	const entity = entityOf(lane);
	return {
		id: lane.id,
		repoId: repo.repoId,
		kind: lane.kind,
		mode: lane.mode,
		...(lane.mode === "repo" && lane.seed !== null ? { seed: lane.seed } : {}),
		...(lane.seed_ms !== null ? { seedMs: lane.seed_ms } : {}),
		ref: lane.ref,
		branch: localBranch(lane),
		owner: lane.owner_principal,
		...(lane.on_behalf_of !== null ? { onBehalfOf: lane.on_behalf_of } : {}),
		delegates: delegatesOf(lane),
		...(lane.opened_by_installation !== null
			? { openedByInstallation: lane.opened_by_installation }
			: {}),
		...(entity ? { entity } : {}),
		footprint: footprintOf(lane),
		...(lane.depends_on_lane !== null
			? { dependsOnLane: lane.depends_on_lane }
			: {}),
		base: lane.base_sha,
		...(lane.head_sha !== null ? { head: lane.head_sha } : {}),
		state: lane.state,
		quarantined: lane.quarantined === 1,
		leaseExpiresAt: lane.lease_expires_at,
		...(lane.last_push_at !== null ? { lastPushAt: lane.last_push_at } : {}),
		pushes: lane.pushes,
		createdAt: lane.created_at,
		...(lane.closed_at !== null ? { closedAt: lane.closed_at } : {}),
		remote: laneRemotePath(lane, repo.path),
	};
};

/** The payload shared by the `lane.*` events of one lane. */
export const laneEventData = (
	lane: LaneRow,
	extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => {
	const entity = entityOf(lane);
	return {
		laneId: lane.id,
		...(entity ? { entity } : {}),
		owner: lane.owner_principal,
		base: lane.base_sha,
		...(lane.head_sha !== null ? { head: lane.head_sha } : {}),
		footprint: footprintOf(lane),
		mode: lane.mode,
		...(lane.mode === "repo" && lane.seed !== null ? { seed: lane.seed } : {}),
		...extra,
	};
};

export const lanesOwnedOrDelegated = (
	sql: SqlStorage,
	principal: string,
	states: string,
): LaneRow[] =>
	rows<LaneRow>(
		sql,
		`SELECT * FROM lanes WHERE state IN (${states})
		 AND (owner_principal = ? OR EXISTS (SELECT 1 FROM json_each(delegates_json) WHERE value = ?))
		 ORDER BY id`,
		principal,
		principal,
	);
