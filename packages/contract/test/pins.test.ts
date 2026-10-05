// Lane and seam signatures of the v0.2 contract, pinned at type level
// (`deno task check` and `deno test` type-check this file), plus one runtime
// case per behavioural helper. A change to a pinned signature fails here
// before it can reach a consumer.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { EMPTY_FOOTPRINT } from "../src/common.ts";
import { KERNEL_EVENT_DATA } from "../src/events.ts";
import {
	type LaneHandle,
	laneHandleOf,
	LaneHandleSchema,
} from "../src/interfaces.ts";
import {
	type Lane,
	LANE_OPS,
	laneGitCommands,
	LaneOpSchema,
} from "../src/lanes.ts";
import type { CapMac } from "../src/security.ts";
import type {
	CreateRepoBackend,
	LaneBackend,
	RepoBackend,
	RepoBackendDeps,
} from "../src/services.ts";
import {
	type AdoptLaneInput,
	type CapContext,
	type CapReport,
	KERNEL_LANE_ACTOR,
	type LaneOpActor,
	type LaneRow,
	type OpenLaneInput,
	type PushContext,
	type PushLeaseRequest,
	type RepoCoreFacade,
	type RepoCoreInternal,
	type RepoLandInternal,
	seedTimerKey,
} from "../src/do/repo.ts";

// ---------------------------------------------------------------------------
// Type-level pins
// ---------------------------------------------------------------------------

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
	(<T>() => T extends B ? 1 : 2) ? true : false;
type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false;
/** Compiles only when `T` is `true`. */
const pin = <T extends true>(): T => true as T;
type Param<M extends keyof RepoCoreFacade, I extends number> = Parameters<
	RepoCoreFacade[M]
>[I];

// Every lane-mutating method carries the actor.
export const actorPins = [
	pin<Equal<OpenLaneInput["actor"], LaneOpActor>>(),
	pin<Equal<HasKey<OpenLaneInput, "openedByInstallation">, false>>(),
	pin<Equal<AdoptLaneInput["actor"], LaneOpActor>>(),
	pin<Equal<Param<"openLane", 0>, OpenLaneInput>>(),
	pin<Equal<Param<"adoptLane", 0>, AdoptLaneInput>>(),
	pin<Equal<Param<"closeLane", 2>, LaneOpActor>>(),
	pin<Equal<Param<"archiveLane", 2>, LaneOpActor>>(),
	pin<Equal<Param<"delegateLane", 3>, LaneOpActor>>(),
	pin<Equal<Param<"syncLane", 1>, LaneOpActor>>(),
	pin<Equal<Param<"restackLane", 2>, LaneOpActor>>(),
	pin<Equal<Param<"purgeLane", 1>, LaneOpActor>>(),
	pin<Equal<Param<"ackQuarantine", 1>, LaneOpActor>>(),
	pin<Equal<Param<"setLaneSettings", 1>, LaneOpActor>>(),
	pin<Equal<Param<"authorizeLaneOp", 0>, LaneOpActor>>(),
] as const;

// The capability state needs no expiry and reports the tip.
export const capPins = [
	pin<Equal<HasKey<CapContext, "exp">, false>>(),
	pin<Equal<CapContext["explainedTips"], readonly string[]>>(),
	pin<Equal<CapReport["upstreamTip"], string | undefined>>(),
	pin<Equal<HasKey<CapMac, "sign">, true>>(),
	pin<Equal<HasKey<CapMac, "verify">, true>>(),
] as const;

// The repo backend is a factory over the core module's deps.
export const backendPins = [
	pin<
		Equal<Parameters<CreateRepoBackend<unknown>>[0], RepoBackendDeps<unknown>>
	>(),
	pin<Equal<ReturnType<CreateRepoBackend<unknown>>, RepoBackend>>(),
	pin<Equal<HasKey<LaneBackend, "open">, false>>(),
	pin<Equal<RepoBackend["backend"], LaneBackend>>(),
	pin<Equal<HasKey<RepoBackendDeps, "core">, true>>(),
	pin<Equal<HasKey<RepoBackendDeps, "capMac">, true>>(),
	pin<Equal<HasKey<RepoBackendDeps, "forgeTree">, true>>(),
	pin<Equal<HasKey<RepoBackendDeps, "timers">, true>>(),
	pin<Equal<HasKey<RepoCoreFacade, "redriveSeeds">, true>>(),
	pin<Equal<HasKey<RepoCoreFacade, "reconcileLaneRepos">, true>>(),
] as const;

// Fetch specs, landing internals, trunk seqs, the lease.
export const seamPins = [
	pin<Equal<Param<"laneFetchSpecs", 0>, readonly string[]>>(),
	pin<Equal<Param<"trunkSeqs", 0>, readonly string[]>>(),
	pin<Equal<LaneRow["change_id"], string | null>>(),
	pin<Equal<HasKey<RepoCoreInternal, "explainsSync">, true>>(),
	pin<Equal<HasKey<RepoCoreInternal, "observeSync">, true>>(),
	pin<Equal<HasKey<RepoCoreInternal, "recordLandingSync">, true>>(),
	pin<Equal<HasKey<RepoLandInternal, "landingByLaneSync">, true>>(),
	pin<Equal<Param<"pushContext", 3>, PushLeaseRequest | undefined>>(),
	pin<Equal<PushContext["ownLanes"][number]["resumable"], boolean>>(),
	pin<Equal<PushContext["ownLanes"][number]["leased"], boolean>>(),
	pin<Equal<NonNullable<PushContext["target"]>["resumable"], boolean>>(),
	pin<
		Equal<
			Param<"recordRejection", 0>["requestId"],
			string | undefined
		>
	>(),
] as const;

Deno.test("the type-level pins hold", () => {
	for (const pins of [actorPins, capPins, backendPins, seamPins]) {
		ok(pins.every((p) => p === true));
	}
});

// ---------------------------------------------------------------------------
// Runtime cases
// ---------------------------------------------------------------------------

Deno.test("the kernel lane actor is sys_kernel, frozen", () => {
	deepStrictEqual({ ...KERNEL_LANE_ACTOR }, {
		kind: "system",
		id: "sys_kernel",
	});
	ok(Object.isFrozen(KERNEL_LANE_ACTOR));
});

Deno.test("purge is a K16 lane op, and lane.denied accepts it", () => {
	ok((LANE_OPS as readonly string[]).includes("purge"));
	equal(LaneOpSchema.parse("purge"), "purge");
	ok(
		KERNEL_EVENT_DATA["lane.denied"].safeParse({
			laneId: "ln_01k0000000000000000000000a",
			op: "purge",
			actor: "u_01k0000000000000000000000a",
			reason: "role",
		}).success,
	);
});

Deno.test("the seed watchdog key is seed:<laneId>", () => {
	equal(
		seedTimerKey("ln_01k0000000000000000000000a"),
		"seed:ln_01k0000000000000000000000a",
	);
});

const ORIGIN = "https://git.example.com/";
const BASE = "a".repeat(40);
const lane = (over: Partial<Lane>): Lane => ({
	id: "ln_01k0000000000000000000000a",
	repoId: "01k6aaaaaaaaaaaaaaaaaaaaaa",
	kind: "lane",
	mode: "repo",
	ref: "refs/heads/main",
	branch: "lanes/ln_01k0000000000000000000000a",
	owner: "a_01k0000000000000000000000a",
	delegates: [],
	footprint: EMPTY_FOOTPRINT,
	base: BASE,
	state: "open",
	quarantined: false,
	leaseExpiresAt: 0,
	pushes: 0,
	createdAt: 0,
	remote: "/acme/shop/-/lanes/ln_01k0000000000000000000000a.git",
	...over,
});

Deno.test("laneGitCommands per backend", () => {
	const remote =
		"https://git.example.com/acme/shop/-/lanes/ln_01k0000000000000000000000a.git";
	deepStrictEqual(laneGitCommands(lane({}), remote), {
		start:
			`git fetch ${remote} main && git switch -c lanes/ln_01k0000000000000000000000a FETCH_HEAD`,
		push: `git push ${remote} HEAD:refs/heads/main`,
	});
	const branch = lane({
		mode: "branch",
		ref: "refs/heads/lanes/ln_01k0000000000000000000000a",
		remote: "/acme/shop.git",
	});
	deepStrictEqual(laneGitCommands(branch, "ignored"), {
		start:
			`git fetch origin && git switch -c lanes/ln_01k0000000000000000000000a ${BASE}`,
		push:
			"git push -u origin HEAD:refs/heads/lanes/ln_01k0000000000000000000000a",
	});
	const head = "b".repeat(40);
	ok(laneGitCommands({ ...branch, head }, "x").start.endsWith(head));
});

Deno.test("laneHandleOf rebuilds remote and git; no handle once closed", () => {
	const open = laneHandleOf(lane({}), ORIGIN) as LaneHandle;
	equal(
		open.remote,
		"https://git.example.com/acme/shop/-/lanes/ln_01k0000000000000000000000a.git",
	);
	ok(open.git?.push.includes(open.remote));
	ok(LaneHandleSchema.safeParse(open).success);
	const opening = laneHandleOf(
		lane({ state: "opening" }),
		ORIGIN,
	) as LaneHandle;
	equal(opening.state, "opening");
	equal(opening.git, undefined);
	ok(LaneHandleSchema.safeParse(opening).success);
	const branch = laneHandleOf(
		lane({
			mode: "branch",
			ref: "refs/heads/lanes/ln_01k0000000000000000000000a",
			remote: "/acme/shop.git",
		}),
		ORIGIN,
	) as LaneHandle;
	equal(branch.remote, "https://git.example.com/acme/shop.git");
	ok(branch.git !== undefined, "a branch lane always carries its commands");
	for (const state of ["closed", "submitted", "deleted"] as const) {
		equal(laneHandleOf(lane({ state }), ORIGIN), null, state);
	}
});
