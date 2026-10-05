// Test-only: lanes, pushes and land requests for the land harness. A lane
// push writes real git objects into the fake canonical repo and records the
// push as the gateway would (phase 1); the fake's trigger event for it is
// fed to `observePush` by `observeAll`, so K1/K2 see every transition.

import {
	changeIdFromBytes,
	type LandRequest,
	trunkRef,
	ZERO_SHA,
} from "@tartan/contract";
import type { FileChanges } from "@tartan/testkit";
import { agentActor, type LandHarness, providerEvent } from "./harness.ts";

export const CHANGES_INST = "i_01k6aaaaaaaaaaaaaaaaaaaaaa";
export const REVIEW_INST = "i_01k6bbbbbbbbbbbbbbbbbbbbbb";
export const QUEUE_INST = "i_01k6cccccccccccccccccccccc";

export const newChangeId = (): string =>
	changeIdFromBytes(crypto.getRandomValues(new Uint8Array(16)));

export const trunkOf = async (h: LandHarness): Promise<string> =>
	(await h.core.resolveRef(trunkRef("main"))) as string;

export type PushedLane = {
	readonly laneId: string;
	readonly head: string;
	readonly pushId?: string;
};

/** Opens a branch lane for `owner` (unless `laneId`) and pushes one commit. */
export const pushLane = async (
	h: LandHarness,
	input: {
		readonly owner: string;
		readonly files: FileChanges;
		readonly message?: string;
		readonly laneId?: string;
		/** Push as this principal instead of the owner (a delegate). */
		readonly pusher?: string;
		/** The parent commit (default: the lane head, else trunk). */
		readonly parent?: string;
		/** Point the lane at this existing commit instead of a new one. */
		readonly head?: string;
		/** Run phase 2 with this lane range (commit_firsts). */
		readonly rangeCommits?: readonly string[];
	},
): Promise<PushedLane> => {
	const lane = input.laneId !== undefined
		? await h.core.getLane(input.laneId)
		: await h.core.openLane({
			owner: input.owner,
			actor: agentActor(input.owner),
		});
	if (lane === null) throw new Error("no lane");
	const before = lane.head ?? ZERO_SHA;
	const parent = input.parent ??
		(before !== ZERO_SHA ? before : await trunkOf(h));
	let head = input.head;
	if (head === undefined) {
		const scratch = `refs/scratch/${lane.id}`;
		h.fake.setRef(h.canonical, scratch, parent, { quiet: true });
		head = h.fake.commit(h.canonical, scratch, input.files, {
			message: input.message ?? `work on ${lane.id}`,
			author: { name: input.owner, email: `${input.owner}@agents.test` },
			at: Math.floor(h.clock.now() / 1000),
			quiet: true,
		});
		h.fake.setRef(h.canonical, scratch, null, { quiet: true });
	}
	h.fake.setRef(h.canonical, lane.ref, head);
	const pushed = await h.core.recordPush({
		target: "repo",
		refs: [{ ref: lane.ref, before, after: head }],
		principal: input.pusher ?? input.owner,
		via: "gateway",
		requestId: `req_${h.ulid()}`,
	});
	const pushId = pushed.pushIds[0];
	if (input.rangeCommits !== undefined) {
		await h.core.recordDiff(pushId, {
			rangeBase: await trunkOf(h),
			rangeTruncated: false,
			diffKey: `diffs/${h.repoId}/${head}.json`,
			commits: input.rangeCommits.map((sha) => ({
				sha,
				subject: "work",
				trailers: [],
			})),
			paths: Object.keys(input.files),
			truncated: false,
		});
	}
	h.clock.advance(1000);
	return { laneId: lane.id, head, pushId };
};

export type SubmittedChange = PushedLane & {
	readonly changeId: string;
	readonly events: readonly string[];
};

/** `changes.submitted` (moves the lane to `submitted`) and an auto approval. */
export const submitChange = (
	h: LandHarness,
	lane: PushedLane,
	options: {
		readonly changeId?: string;
		readonly approve?: boolean;
		readonly approvalHead?: string;
		readonly reviewer?: string;
	} = {},
): SubmittedChange => {
	const changeId = options.changeId ?? newChangeId();
	const submitted = providerEvent(h, {
		type: "changes.submitted",
		installation: CHANGES_INST,
		data: {
			changeId,
			laneId: lane.laneId,
			revision: 1,
			head: lane.head,
			base: lane.head,
			affected: [],
		},
	});
	const events = [submitted];
	if (options.approve !== false) {
		events.push(providerEvent(h, {
			type: "review.decided",
			installation: options.reviewer ?? REVIEW_INST,
			data: {
				changeId,
				revision: 1,
				head: options.approvalHead ?? lane.head,
				decision: "approve",
				route: "auto",
				decidedBy: { kind: "agent", id: "a_01k6dddddddddddddddddddddd" },
			},
		}));
	}
	return { ...lane, changeId, events };
};

export const landRequest = (
	h: LandHarness,
	changes: readonly SubmittedChange[],
	options: {
		readonly batchId?: string;
		readonly testPolicy?: "checks" | "none";
		readonly events?: readonly string[];
	} = {},
): LandRequest => ({
	batchId: options.batchId ?? `lb_${h.ulid()}`,
	repo: { id: h.repoId },
	ref: "refs/heads/main",
	batch: changes.map((c, i) => ({
		changeId: c.changeId,
		laneId: c.laneId,
		head: c.head,
		title: `Change ${i + 1}`,
		message: `Why change ${i + 1} exists.`,
		trailers: [
			{ key: "Tartan-Change", value: c.changeId },
			{ key: "Tartan-Work", value: `acme/shop#${i + 1}` },
			{ key: "Tartan-Agent", value: "forged by the provider" },
		],
	})),
	reason: {
		events: [...(options.events ?? changes.flatMap((c) => c.events))],
		summary: "weave partition [*] batch 1",
	},
	testPolicy: options.testPolicy ?? "none",
});
