// Lane-remote table tests (one per row and caller kind: owner, delegate, other
// agent, a token pinned to another lane, a caller without a write
// credential) and property tests for `laneRepoPolicy`, the lane remote's
// receive-pack policy (`repo` backend).

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	laneId,
	type LaneState,
	RESERVED_REF_PARENTS,
	RESERVED_REF_PREFIXES,
	ROLE,
	ulid,
	ZERO_SHA,
} from "@tartan/contract";
import type {
	PushCaller,
	PushCommand,
	PushContext,
	RefPolicyReason,
} from "@tartan/contract/kernel.ts";
import { laneRepoPolicy } from "./policy.ts";

const sha = (n: number): string => (n + 1).toString(16).padStart(40, "d");
const HEAD = sha(1);
const NEXT = sha(2);
const MAIN = "refs/heads/main";

const OWNER = `a_${ulid()}`;
const DELEGATE = `a_${ulid()}`;
const OTHER = `a_${ulid()}`;
const LANE = laneId(ulid());
const OTHER_LANE = laneId(ulid());

type Target = NonNullable<PushContext["target"]>;

const target = (over: Partial<Target> = {}): Target => ({
	laneId: LANE,
	mode: "repo",
	state: "open",
	owner: OWNER,
	delegates: [DELEGATE],
	headSha: HEAD,
	quarantined: false,
	resumable: true,
	leased: false,
	...over,
});

const context = (
	over: Partial<Target> = {},
	writeCredential = true,
): PushContext => ({
	caller: { kind: "agent", writeCredential },
	ownLanes: [],
	target: target(over),
	adopted: [],
	protectedPatterns: ["refs/heads/main"],
	defaultBranch: "main",
	caseFoldedRefs: ["refs/heads/main"],
	importState: "none",
	landingPaused: false,
});

const caller = (
	principal: string,
	over: Partial<PushCaller> = {},
): PushCaller => ({
	principal,
	kind: "agent",
	role: ROLE.developer,
	laneId: null,
	forgeOwner: false,
	...over,
});

const update = (ref = MAIN, old = HEAD, next = NEXT): PushCommand => ({
	ref,
	old,
	new: next,
});

const verdict = (
	command: PushCommand,
	who: PushCaller = caller(OWNER),
	ctx: PushContext = context(),
): RefPolicyReason | "allow" => {
	const [decision] = laneRepoPolicy(ctx, [command], who);
	return decision.allow ? "allow" : decision.reason;
};

Deno.test("L0: malformed refnames, reserved parents and case variants for everyone", () => {
	for (const who of [caller(OWNER), caller(DELEGATE), caller(OTHER)]) {
		for (
			const ref of ["HEAD", "main", "refs/heads/a..b", "refs/heads/x.lock"]
		) {
			equal(verdict(update(ref), who), "invalid-ref", ref);
		}
		equal(
			verdict(update(`refs/heads/${"x".repeat(250)}`), who),
			"invalid-ref",
		);
		for (const parent of RESERVED_REF_PARENTS) {
			equal(verdict(update(parent), who), "reserved-parent", parent);
		}
		for (
			const ref of ["refs/heads/Main", "refs/heads/MAIN", "Refs/heads/main"]
		) {
			const result = verdict(update(ref), who);
			ok(
				result === "case-collision" || result === "invalid-ref",
				`${ref}: ${result}`,
			);
		}
		equal(verdict(update("refs/heads/Main"), who), "case-collision");
		for (const prefix of RESERVED_REF_PREFIXES) {
			const variant = prefix.replace("tartan", "Tartan").replace(
				"lanes",
				"Lanes",
			);
			if (variant === prefix) continue;
			equal(verdict(update(`${variant}x/y`), who), "case-collision", variant);
		}
	}
});

Deno.test("L1: an inactive lane refuses every push (lane-opening, lane-closed)", () => {
	equal(
		verdict(update(), caller(OWNER), context({ state: "opening" })),
		"lane-opening",
	);
	equal(
		verdict(update(), caller(OTHER), context({ state: "opening" })),
		"lane-opening",
	);
	for (const state of ["closed", "archived", "deleted", "landed"] as const) {
		equal(
			verdict(update(), caller(OWNER), context({ state })),
			"lane-closed",
			state,
		);
		equal(
			verdict(update(), caller(DELEGATE), context({ state })),
			"lane-closed",
		);
	}
	equal(
		verdict(
			update(),
			caller(OWNER),
			context({ state: "lost", resumable: false }),
		),
		"lane-closed",
	);
	equal(
		verdict(
			update(),
			caller(OWNER),
			context({ state: "lost", resumable: true }),
		),
		"allow",
	);
	equal(
		verdict(update(), caller(OWNER), context({ state: "submitted" })),
		"allow",
	);
});

Deno.test("L2: a landing lane is frozen for everyone", () => {
	for (const who of [caller(OWNER), caller(DELEGATE), caller(OTHER)]) {
		equal(
			verdict(update(), who, context({ state: "landing" })),
			"lane-landing",
		);
	}
});

Deno.test("L3: refs/heads/main for the owner and delegates, at the recorded head, with a write credential", () => {
	equal(verdict(update(), caller(OWNER)), "allow");
	equal(verdict(update(), caller(DELEGATE)), "allow");
	// Users may own lanes too.
	equal(
		verdict(update(), caller(OWNER, { kind: "user" })),
		"allow",
	);
	// Anyone else.
	equal(verdict(update(), caller(OTHER)), "not-your-lane");
	// A token pinned to another lane (the gateway's role bound refuses it
	// earlier; the table refuses it too).
	equal(
		verdict(update(), caller(OWNER, { laneId: OTHER_LANE })),
		"not-your-lane",
	);
	equal(verdict(update(), caller(OWNER, { laneId: LANE })), "allow");
	// No write credential (a read-scoped token, a downgraded role).
	equal(
		verdict(update(), caller(OWNER), context({}, false)),
		"no-write-credential",
	);
	// Stale old, forced update from the right old, the U48 lease.
	equal(verdict(update(MAIN, sha(7))), "stale-old");
	equal(verdict(update(MAIN, HEAD, sha(8))), "allow");
	equal(
		verdict(update(), caller(OWNER), context({ leased: true })),
		"stale-old",
	);
	// A create only while the lane repo has no main.
	equal(verdict(update(MAIN, ZERO_SHA)), "stale-old");
	equal(
		verdict(update(MAIN, ZERO_SHA), caller(OWNER), context({ headSha: null })),
		"allow",
	);
	equal(
		verdict(update(MAIN, HEAD), caller(OWNER), context({ headSha: null })),
		"stale-old",
	);
	// A quarantined lane's owner may push (re-attribution clears it, K2).
	equal(
		verdict(update(), caller(OWNER), context({ quarantined: true })),
		"allow",
	);
});

Deno.test("L4: a delete of main is refused for everyone", () => {
	for (const who of [caller(OWNER), caller(DELEGATE), caller(OTHER)]) {
		equal(verdict(update(MAIN, HEAD, ZERO_SHA), who), "use-lanes-close");
	}
});

Deno.test("L5: any other ref is refused for everyone", () => {
	for (const who of [caller(OWNER), caller(DELEGATE), caller(OTHER)]) {
		for (
			const ref of [
				"refs/heads/feature",
				"refs/heads/main2",
				"refs/heads/lanes/" + LANE,
				"refs/tags/v1",
				"refs/notes/tartan",
				"refs/tartan/changes/x",
				"refs/notes/commits",
				"refs/pull/1/head",
			]
		) {
			equal(verdict(update(ref), who), "lane-main-only", ref);
		}
	}
});

Deno.test("fail closed: no target lane, or a branch-backend target, refuses everything", () => {
	const noTarget = { ...context(), target: undefined };
	equal(verdict(update(), caller(OWNER), noTarget), "not-your-lane");
	equal(
		verdict(update(), caller(OWNER), context({ mode: "branch" })),
		"not-your-lane",
	);
});

Deno.test("one decision per command, in order", () => {
	const decisions = laneRepoPolicy(
		context(),
		[update(), update("refs/heads/x")],
		caller(OWNER),
	);
	deepStrictEqual(decisions, [
		{ ref: MAIN, allow: true },
		{ ref: "refs/heads/x", allow: false, reason: "lane-main-only" },
	]);
});

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

const prng = (seed: number) => {
	let state = seed >>> 0 || 1;
	const next = () => {
		state ^= state << 13;
		state >>>= 0;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		return state;
	};
	return {
		int: (n: number) => next() % n,
		pick: <T>(items: readonly T[]): T => items[next() % items.length],
		bool: () => (next() & 1) === 1,
	};
};

const STATES: readonly LaneState[] = [
	"opening",
	"open",
	"submitted",
	"landing",
	"landed",
	"closed",
	"lost",
	"archived",
	"deleted",
];

Deno.test("property: no ref but refs/heads/main is ever writable; never while opening or landing; never a stale old; never a delete; only the owner or a delegate", () => {
	const rand = prng(0x1a7e_9411);
	const segments = [
		"heads",
		"tags",
		"notes",
		"tartan",
		"lanes",
		"main",
		"Main",
		"MAIN",
		"x",
		"feature",
		"tartan-work",
		"pull",
	];
	let allowed = 0;
	for (let i = 0; i < 20_000; i++) {
		const ref = rand.int(3) === 0
			? MAIN
			: `refs/${
				Array.from({ length: 1 + rand.int(3) }, () => rand.pick(segments)).join(
					"/",
				)
			}`;
		const state = rand.pick(STATES);
		const headSha = rand.int(4) === 0 ? null : HEAD;
		const old = rand.pick([HEAD, ZERO_SHA, sha(5)]);
		const next = rand.int(5) === 0 ? ZERO_SHA : NEXT;
		const principal = rand.pick([OWNER, DELEGATE, OTHER]);
		const pin = rand.pick([null, LANE, OTHER_LANE]);
		const writeCredential = rand.int(4) !== 0;
		const leased = rand.int(6) === 0;
		const ctx = context(
			{ state, headSha, leased, resumable: rand.bool() },
			writeCredential,
		);
		const who = caller(principal, {
			laneId: pin,
			kind: rand.bool() ? "agent" : "user",
		});
		const command = { ref, old, new: next };
		const result = verdict(command, who, ctx);
		if (result !== "allow") continue;
		allowed++;
		equal(ref, MAIN, `case ${i}`);
		ok(state !== "opening" && state !== "landing", `case ${i}: ${state}`);
		ok(
			["open", "submitted", "lost"].includes(state),
			`case ${i}: inactive ${state}`,
		);
		ok(next !== ZERO_SHA, `case ${i}: a delete`);
		ok(
			principal === OWNER || principal === DELEGATE,
			`case ${i}: ${principal}`,
		);
		ok(pin === null || pin === LANE, `case ${i}: pinned elsewhere`);
		ok(writeCredential, `case ${i}: no write credential`);
		ok(!leased, `case ${i}: leased`);
		ok(
			headSha === null ? old === ZERO_SHA : old === headSha,
			`case ${i}: stale old ${old} vs ${headSha}`,
		);
	}
	ok(allowed > 50, `allowed ${allowed}`);
});

Deno.test("property: one rejected command rejects the push (some decision is a refusal)", () => {
	const rand = prng(0x0b5e_55ed);
	for (let i = 0; i < 500; i++) {
		const commands = Array.from(
			{ length: 1 + rand.int(4) },
			() => rand.bool() ? update() : update(`refs/heads/x${rand.int(9)}`),
		);
		const decisions = laneRepoPolicy(context(), commands, caller(OWNER));
		equal(decisions.length, commands.length);
		const anyOther = commands.some((c) => c.ref !== MAIN);
		equal(decisions.some((d) => !d.allow), anyOther, `case ${i}`);
	}
});
