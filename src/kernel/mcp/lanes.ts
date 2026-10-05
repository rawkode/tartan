// Lane handles in MCP results (WP11).
//
// - Every lane handle in a tool result is rebuilt from the kernel's lane row
//   with `laneHandleOf`, whichever provider built it: `remote` becomes the
//   absolute URL on the canonical origin and `git.start`/`git.push` are the
//   commands of the lane's backend.
// - Lane-handle completion: `openLane` and `caps.lanes.open` return at once,
//   so a `repo` lane can still be `opening`. For such a handle the host
//   calls `awaitLane(laneId, LANE_OPEN_WAIT_MS)` here, per MCP request and
//   outside any ExtensionDO, and answers with the completed handle (or
//   `opening` for the agent to poll with `lanes_get`).
// - A lane closed while `opening` has no handle: `conflict("lane closed
//   while opening")` with `{laneId, state}`.

import {
	conflict,
	type Lane,
	LANE_OPEN_WAIT_MS,
	type LaneGitCommands,
	laneGitCommands,
	type LaneHandle,
	laneHandleOf,
	LaneIdSchema,
	type LaneState,
} from "@tartan/contract";
import type { McpRepoPorts } from "./ports.ts";

/** States in which the owner may push the lane: git commands are shown. */
const PUSHABLE: readonly LaneState[] = ["open", "submitted", "lost"];

/** The absolute lane remote on the canonical origin. */
export const absoluteRemote = (lane: Lane, origin: string): string =>
	`${origin.replace(/\/+$/, "")}${lane.remote}`;

/** A lane as `lanes_get` / `lanes_list` show it: the handle fields plus state details. */
export type LaneView = {
	readonly id: string;
	readonly kind: Lane["kind"];
	readonly mode: Lane["mode"];
	readonly state: LaneState;
	readonly owner: string;
	readonly onBehalfOf?: string;
	readonly delegates: readonly string[];
	readonly remote: string;
	readonly ref: string;
	readonly branch: string;
	readonly base: string;
	readonly head?: string;
	readonly quarantined: boolean;
	readonly leaseExpiresAt: number;
	readonly lastPushAt?: number;
	readonly pushes: number;
	readonly entity?: Lane["entity"];
	readonly footprint: Lane["footprint"];
	readonly dependsOnLane?: string;
	readonly git?: LaneGitCommands;
};

export const laneView = (lane: Lane, origin: string): LaneView => {
	const remote = absoluteRemote(lane, origin);
	return {
		id: lane.id,
		kind: lane.kind,
		mode: lane.mode,
		state: lane.state,
		owner: lane.owner,
		...(lane.onBehalfOf ? { onBehalfOf: lane.onBehalfOf } : {}),
		delegates: [...lane.delegates],
		remote,
		ref: lane.ref,
		branch: lane.branch,
		base: lane.base,
		...(lane.head ? { head: lane.head } : {}),
		quarantined: lane.quarantined,
		leaseExpiresAt: lane.leaseExpiresAt,
		...(lane.lastPushAt !== undefined ? { lastPushAt: lane.lastPushAt } : {}),
		pushes: lane.pushes,
		...(lane.entity ? { entity: lane.entity } : {}),
		footprint: lane.footprint,
		...(lane.dependsOnLane ? { dependsOnLane: lane.dependsOnLane } : {}),
		...(PUSHABLE.includes(lane.state)
			? { git: laneGitCommands(lane, remote) }
			: {}),
	};
};

/** `laneHandleOf`, or the `conflict` a lane without a handle answers. */
export const requireHandle = (lane: Lane, origin: string): LaneHandle => {
	const handle = laneHandleOf(lane, origin);
	if (handle === null) {
		throw conflict(
			lane.state === "closed" || lane.state === "deleted"
				? "lane closed while opening"
				: `lane is ${lane.state}`,
			{ laneId: lane.id, state: lane.state },
		);
	}
	return handle;
};

/**
 * The lane once it left `opening` (or as it is when `waitMs` ran out): the
 * wait runs in RepoDO's in-memory waiter (`awaitLane`), never inside an
 * ExtensionDO, so concurrent claims wait in parallel.
 */
export const settleLane = async (
	core: Pick<McpRepoPorts["core"], "awaitLane">,
	lane: Lane,
	waitMs: number = LANE_OPEN_WAIT_MS,
): Promise<Lane> =>
	lane.state === "opening" && waitMs > 0
		? await core.awaitLane(lane.id, waitMs)
		: lane;

/**
 * Completes the `lane` field of a structured tool result (`work_claim`,
 * `lanes_open`, any interface tool whose schema returns a lane): the kernel's
 * row is read (awaited while `opening`) and the handle rebuilt. Returns the
 * rewritten result and the lane, or the result unchanged when it carries no
 * lane handle.
 */
export const completeLaneField = async (
	core: Pick<McpRepoPorts["core"], "awaitLane">,
	value: unknown,
	origin: string,
	waitMs: number = LANE_OPEN_WAIT_MS,
): Promise<{ value: unknown; lane?: Lane }> => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { value };
	}
	const record = value as Record<string, unknown>;
	const field = record.lane;
	if (typeof field !== "object" || field === null) return { value };
	const id = (field as { id?: unknown }).id;
	if (!LaneIdSchema.safeParse(id).success) return { value };
	// `awaitLane` answers at once for a lane that is not `opening`, so this is
	// one RPC either way; the kernel's state wins over the provider's.
	const current = await core.awaitLane(id as string, waitMs);
	return {
		value: { ...record, lane: requireHandle(current, origin) },
		lane: current,
	};
};
