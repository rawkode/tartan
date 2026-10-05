// Test-only helpers for `repo`-backend lanes on WP10's land harness (the REAL
// core, event log and land modules on `node:sqlite`, FakeArtifacts on
// loopback, stock git as the sandbox, the capability route stand-in that
// `import()` pulls through).

import { type Lane, LANE_REPO_HEAD_REF, ZERO_SHA } from "@tartan/contract";
import type { LaneRow } from "@tartan/contract/kernel.ts";
import type { FileChanges } from "@tartan/testkit";
import {
	agentActor,
	createLandHarness,
	hasGit,
	type LandHarness,
	type LandHarnessOptions,
} from "../../../../land/testing/harness.ts";
import type { PushedLane } from "../../../../land/testing/lanes.ts";
import { laneRow } from "../../rows.ts";

export type RepoLaneTest = (h: LandHarness) => Promise<void>;

/** `Deno.test` on a harness whose repos default to `import` lanes. */
export const repoLaneTest = (
	name: string,
	fn: RepoLaneTest,
	options: LandHarnessOptions = {},
): void =>
	Deno.test({
		name,
		ignore: !hasGit,
		sanitizeOps: false,
		sanitizeResources: false,
		fn: async () => {
			const h = await createLandHarness({ laneMode: "import", ...options });
			try {
				await fn(h);
			} finally {
				await h.close();
			}
		},
	});

/** The lane row as RepoDO holds it (seed columns included). */
export const rowOf = (h: LandHarness, laneId: string): LaneRow =>
	laneRow(h.storage.sql, laneId) as LaneRow;

/** Opens a lane as `owner` (an agent) and returns it as `openLane` did. */
export const openAs = (h: LandHarness, owner: string): Promise<Lane> =>
	h.core.openLane({ owner, actor: agentActor(owner) });

/** Opens a lane and lets its detached seed run to the end. */
export const openSeeded = async (
	h: LandHarness,
	owner: string,
): Promise<Lane> => {
	const lane = await openAs(h, owner);
	await h.settle();
	return (await h.core.getLane(lane.id)) as Lane;
};

/** The events of one type in the repo log. */
export const eventsOfType = (h: LandHarness, type: string) =>
	h.events.read({ since: 0, limit: 100_000 }).filter((e) => e.type === type);

/**
 * A push through the lane remote, as the gateway records it: a commit on
 * `refs/heads/main` of the lane's CURRENT lane repo, then phase 1 with
 * `target` = the lane and `repoName`.
 */
export const pushRepoLane = async (
	h: LandHarness,
	input: {
		readonly laneId: string;
		readonly owner: string;
		readonly files: FileChanges;
		readonly message?: string;
	},
): Promise<PushedLane> => {
	const row = rowOf(h, input.laneId);
	if (row.repo_name === null) throw new Error("not a repo lane");
	const before = row.head_sha ?? ZERO_SHA;
	const head = h.fake.commit(row.repo_name, LANE_REPO_HEAD_REF, input.files, {
		message: input.message ?? `work on ${input.laneId}`,
		author: { name: input.owner, email: `${input.owner}@agents.test` },
		at: Math.floor(h.clock.now() / 1000),
	});
	const pushed = await h.core.recordPush({
		target: input.laneId,
		repoName: row.repo_name,
		refs: [{ ref: LANE_REPO_HEAD_REF, before, after: head }],
		principal: input.owner,
		via: "gateway",
		requestId: `req_${h.ulid()}`,
	});
	h.clock.advance(1000);
	return { laneId: input.laneId, head, pushId: pushed.pushIds[0] };
};

export const AGENTS = [
	"a_01k6eeeeeeeeeeeeeeeeeeeeee",
	"a_01k6ffffffffffffffffffffff",
	"a_01k6gggggggggggggggggggggg",
	"a_01k6hhhhhhhhhhhhhhhhhhhhhh",
] as const;
