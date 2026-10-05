// Ref-policy table tests (one per row and caller kind) and property tests for
// the canonical receive-pack policy, the write precheck and the views (M1).

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
	AuthContext,
	PushCaller,
	PushCommand,
	RefPolicyReason,
} from "@tartan/contract/kernel.ts";
import {
	canonicalPushPolicy,
	canonicalWritePrecheck,
	fold,
	type GatewayPushContext,
	globMatch,
	mayReceivePack,
	memberView,
	publicView,
} from "./policy.ts";

const sha = (n: number): string => (n + 1).toString(16).padStart(40, "c");
const H1 = sha(1);
const H2 = sha(2);
const TRUNK = sha(9);

const USER = `u_${ulid()}`;
const OTHER_USER = `u_${ulid()}`;
const AGENT = `a_${ulid()}`;
const LANE_A = laneId(ulid());
const LANE_B = laneId(ulid());
const LANE_R = laneId(ulid());
const laneRef = (id: string) => `refs/heads/lanes/${id}`;

type OwnLane = GatewayPushContext["ownLanes"][number];

const lane = (id: string, over: Partial<OwnLane> = {}): OwnLane => ({
	laneId: id,
	mode: "branch",
	ref: laneRef(id),
	state: "open",
	headSha: H1,
	resumable: true,
	leased: false,
	...over,
});

const context = (
	over: Partial<GatewayPushContext> = {},
): GatewayPushContext => ({
	caller: { kind: "agent", writeCredential: true },
	ownLanes: [lane(LANE_A)],
	adopted: [],
	protectedPatterns: ["refs/heads/main", "release/*"],
	defaultBranch: "main",
	caseFoldedRefs: [
		"refs/heads/main",
		"refs/heads/feat",
		"refs/tags/v1",
		laneRef(LANE_A),
		laneRef(LANE_B),
	],
	refNames: ["refs/heads/main", "refs/heads/feat", "refs/tags/v1"],
	importState: "none",
	landingPaused: false,
	...over,
});

const agent = (over: Partial<PushCaller> = {}): PushCaller => ({
	principal: AGENT,
	kind: "agent",
	role: ROLE.developer,
	laneId: null,
	forgeOwner: false,
	...over,
});

const user = (over: Partial<PushCaller> = {}): PushCaller => ({
	principal: USER,
	kind: "user",
	role: ROLE.developer,
	laneId: null,
	forgeOwner: false,
	...over,
});

const update = (ref: string, old = H1, next = H2): PushCommand => ({
	ref,
	old,
	new: next,
});
const create = (ref: string, next = H2): PushCommand => ({
	ref,
	old: ZERO_SHA,
	new: next,
});
const remove = (ref: string, old = H1): PushCommand => ({
	ref,
	old,
	new: ZERO_SHA,
});

/** The verdict of one command: `"allow"` or the `ng` reason. */
const verdict = (
	command: PushCommand,
	caller: PushCaller,
	ctx: GatewayPushContext = context({
		caller: { kind: caller.kind, writeCredential: true },
	}),
): RefPolicyReason | "allow" => {
	const [decision] = canonicalPushPolicy(ctx, [command], caller);
	return decision.allow ? "allow" : decision.reason;
};

const userCtx = (over: Partial<GatewayPushContext> = {}) =>
	context({
		caller: { kind: "user", writeCredential: true },
		ownLanes: [],
		...over,
	});

// ---------------------------------------------------------------------------
// The table, row by row
// ---------------------------------------------------------------------------

Deno.test("row 0: malformed refnames are invalid-ref for everyone", () => {
	for (
		const ref of [
			"HEAD",
			"main",
			"refs/x",
			"refs/heads/a..b",
			"refs/heads/a b",
			"refs/heads/x.lock",
			"refs/heads/ctl\u0001",
			`refs/heads/${"a".repeat(250)}`,
			"refs/heads/trailing/",
			"REFS/heads/x",
		]
	) {
		equal(verdict(create(ref), user(), userCtx()), "invalid-ref", ref);
		equal(verdict(create(ref), agent()), "invalid-ref", ref);
	}
});

Deno.test("row 0: reserved parents are reserved-parent, in every row including import mode", () => {
	for (const parent of RESERVED_REF_PARENTS) {
		equal(verdict(create(parent), user(), userCtx()), "reserved-parent");
		equal(verdict(create(parent), agent()), "reserved-parent");
		equal(
			verdict(
				create(parent),
				user({ forgeOwner: true }),
				userCtx({ importState: "importing", protectedPatterns: [] }),
			),
			"reserved-parent",
		);
	}
});

Deno.test("row 0: case variants of reserved names, existing refs, adopted lanes and protected matches are case-collision", () => {
	const ctx = userCtx({
		adopted: [{ ref: "refs/heads/Adopted-Feat", owner: USER, delegates: [] }],
		caseFoldedRefs: [
			...context().caseFoldedRefs,
			"refs/heads/adopted-feat",
			"refs/heads/mixedcase",
		],
		refNames: [...(context().refNames ?? []), "refs/heads/MixedCase"],
	});
	for (
		const ref of [
			"refs/heads/Lanes",
			"refs/Heads/lanes/x",
			"refs/heads/Lanes/ln_x",
			"refs/Tartan/changes/x",
			"refs/heads/TARTAN/x",
			"refs/notes/Tartan",
			"refs/notes/TARTAN/x",
			"refs/Tartan-work/x",
			"refs/Notes/lanes/x/ai",
			"refs/heads/Main",
			"refs/heads/MAIN",
			"refs/heads/Feat",
			"refs/tags/V1",
			"refs/heads/Release/1.0",
			"refs/heads/adopted-feat",
			"refs/heads/mixedcase",
		]
	) {
		equal(verdict(update(ref), user(), ctx), "case-collision", ref);
	}
	// The exact spelling of an existing mixed-case ref is an ordinary update.
	equal(verdict(update("refs/heads/MixedCase"), user(), ctx), "allow");
	equal(verdict(update("refs/heads/feat"), user(), ctx), "allow");
	// A case variant of a live lane ref collides even without `refNames`.
	equal(
		verdict(
			update(`refs/heads/lanes/${LANE_B.toUpperCase()}`),
			agent(),
		),
		"case-collision",
	);
});

Deno.test("row 1: an importing repo takes pushes from the forge Owner only, to heads and tags", () => {
	const ctx = userCtx({ importState: "importing", protectedPatterns: [] });
	const owner = user({ forgeOwner: true, role: ROLE.owner });
	equal(verdict(update("refs/heads/main"), owner, ctx), "allow");
	equal(verdict(create("refs/tags/v2"), owner, ctx), "allow");
	equal(verdict(create("refs/heads/feature"), owner, ctx), "allow");
	equal(verdict(create("refs/notes/commits"), owner, ctx), "repo-importing");
	equal(verdict(create("refs/tartan/changes/x"), owner, ctx), "repo-importing");
	equal(verdict(create(laneRef(LANE_A)), owner, ctx), "repo-importing");
	equal(
		verdict(update("refs/heads/main"), user({ role: ROLE.owner }), ctx),
		"repo-importing",
	);
	equal(
		verdict(
			update("refs/heads/main"),
			agent(),
			context({ importState: "importing" }),
		),
		"repo-importing",
	);
	equal(
		verdict(
			update("refs/heads/main"),
			agent({ forgeOwner: true }),
			context({ importState: "importing" }),
		),
		"repo-importing",
	);
});

Deno.test("row 2: protected refs are woven-by-tartan for users and agents", () => {
	equal(
		verdict(update("refs/heads/main"), user({ role: ROLE.owner }), userCtx()),
		"woven-by-tartan",
	);
	equal(verdict(update("refs/heads/main"), agent()), "woven-by-tartan");
	equal(
		verdict(create("refs/heads/release/1.0"), user(), userCtx()),
		"woven-by-tartan",
	);
	equal(
		verdict(remove("refs/heads/main"), user(), userCtx()),
		"woven-by-tartan",
	);
	// The default branch is protected even when no pattern lists it.
	equal(
		verdict(
			update("refs/heads/trunk"),
			user(),
			userCtx({
				defaultBranch: "trunk",
				protectedPatterns: [],
				caseFoldedRefs: ["refs/heads/trunk"],
				refNames: ["refs/heads/trunk"],
			}),
		),
		"woven-by-tartan",
	);
	// Patterns never match lane refs.
	equal(
		verdict(
			update(laneRef(LANE_A)),
			agent(),
			context({ protectedPatterns: ["**"] }),
		),
		"allow",
	);
});

Deno.test("row 3: kernel namespaces are kernel-only", () => {
	for (
		const ref of [
			"refs/tartan/changes/zz",
			"refs/tartan/attic/ln_x",
			"refs/heads/tartan/x",
			"refs/tartan-work/a/trunk",
			"refs/notes/tartan",
			"refs/notes/tartan/x",
		]
	) {
		equal(
			verdict(update(ref), user({ role: ROLE.owner }), userCtx()),
			"kernel-only",
			ref,
		);
		equal(verdict(update(ref), agent()), "kernel-only", ref);
	}
});

Deno.test("row 4: the owner's own active, non-landing branch lane with the index head as old", () => {
	equal(verdict(update(laneRef(LANE_A)), agent()), "allow");
	// Forced updates are updates: any new id, the old must be the index head.
	equal(verdict(update(laneRef(LANE_A), H1, sha(77)), agent()), "allow");
	equal(verdict(update(laneRef(LANE_A), sha(5)), agent()), "stale-old");
	// A create only while the lane has no head.
	equal(verdict(create(laneRef(LANE_A)), agent()), "stale-old");
	equal(
		verdict(
			create(laneRef(LANE_A)),
			agent(),
			context({ ownLanes: [lane(LANE_A, { headSha: null })] }),
		),
		"allow",
	);
	equal(
		verdict(
			update(laneRef(LANE_A)),
			agent(),
			context({ ownLanes: [lane(LANE_A, { headSha: null })] }),
		),
		"stale-old",
	);
	// Frozen while landing.
	equal(
		verdict(
			update(laneRef(LANE_A)),
			agent(),
			context({ ownLanes: [lane(LANE_A, { state: "landing" })] }),
		),
		"lane-landing",
	);
	// submitted and lost (inside the resume window) stay writable.
	for (const state of ["submitted", "lost"] as LaneState[]) {
		equal(
			verdict(
				update(laneRef(LANE_A)),
				agent(),
				context({ ownLanes: [lane(LANE_A, { state })] }),
			),
			"allow",
			state,
		);
	}
	equal(
		verdict(
			update(laneRef(LANE_A)),
			agent(),
			context({
				ownLanes: [lane(LANE_A, { state: "lost", resumable: false })],
			}),
		),
		"lane-closed",
	);
	// No write credential (a read-scoped token, a downgraded role).
	equal(
		verdict(
			update(laneRef(LANE_A)),
			agent(),
			context({ caller: { kind: "agent", writeCredential: false } }),
		),
		"no-write-credential",
	);
	// Held by another request's push lease (U48 fallback).
	equal(
		verdict(
			update(laneRef(LANE_A)),
			agent(),
			context({ ownLanes: [lane(LANE_A, { leased: true })] }),
		),
		"stale-old",
	);
	// A delegate's lane is in its ownLanes the same way (RepoDO derives it).
	equal(
		verdict(
			update(laneRef(LANE_A)),
			user(),
			userCtx({ ownLanes: [lane(LANE_A)] }),
		),
		"allow",
	);
});

Deno.test("row 4: a lane-pinned token's ownLanes hold only the pinned lane, so other lanes are not-your-lane", () => {
	// RepoDO narrows ownLanes to the pin (`pushContext(…, tokenLaneId)`).
	const pinned = context({ ownLanes: [lane(LANE_A)] });
	equal(
		verdict(update(laneRef(LANE_A)), agent({ laneId: LANE_A }), pinned),
		"allow",
	);
	equal(
		verdict(create(laneRef(LANE_B)), agent({ laneId: LANE_A }), pinned),
		"not-your-lane",
	);
});

Deno.test("row 5: other lanes, unknown lanes, deeper paths, deletes and repo-backend lanes", () => {
	equal(verdict(create(laneRef(LANE_B)), agent()), "not-your-lane");
	equal(verdict(update(laneRef(LANE_B)), agent()), "not-your-lane");
	equal(verdict(create(laneRef(laneId(ulid()))), agent()), "not-your-lane");
	equal(verdict(create(`${laneRef(LANE_A)}/deeper`), agent()), "not-your-lane");
	equal(
		verdict(create("refs/heads/lanes/not-a-lane"), agent()),
		"not-your-lane",
	);
	equal(verdict(remove(laneRef(LANE_A)), agent()), "use-lanes-close");
	equal(verdict(remove(laneRef(LANE_B)), agent()), "not-your-lane");
	// A `repo`-backend lane's id is never writable on the canonical repo.
	const repoLane = context({
		ownLanes: [lane(LANE_R, { mode: "repo", ref: "refs/heads/main" })],
	});
	equal(verdict(create(laneRef(LANE_R)), agent(), repoLane), "not-your-lane");
	equal(verdict(create(laneRef(LANE_B)), user(), userCtx()), "not-your-lane");
});

Deno.test("row 6: agent notes of the caller's own branch lane (stretch)", () => {
	const notes = (id: string, name = "agent-trace") =>
		`refs/notes/lanes/${id}/${name}`;
	equal(verdict(create(notes(LANE_A)), agent()), "allow");
	equal(verdict(create(notes(LANE_A, "ai")), agent()), "allow");
	equal(verdict(create(notes(LANE_A, "other")), agent()), "not-your-lane");
	equal(verdict(create(notes(LANE_B)), agent()), "not-your-lane");
	equal(
		verdict(
			create(notes(LANE_A)),
			agent(),
			context({ ownLanes: [lane(LANE_A, { state: "landing" })] }),
		),
		"lane-landing",
	);
	equal(verdict(remove(notes(LANE_A)), agent()), "use-lanes-close");
});

Deno.test("row 7: an adopted lane's head for its owner and delegates only, never agents", () => {
	const adoptedRef = "refs/heads/adopted";
	const ctx = (over: Partial<GatewayPushContext> = {}) =>
		userCtx({
			adopted: [{ ref: adoptedRef, owner: USER, delegates: [OTHER_USER] }],
			caseFoldedRefs: [...context().caseFoldedRefs, adoptedRef],
			refNames: [...(context().refNames ?? []), adoptedRef],
			...over,
		});
	equal(verdict(update(adoptedRef), user(), ctx()), "allow");
	equal(
		verdict(update(adoptedRef), user({ principal: OTHER_USER }), ctx()),
		"allow",
	);
	equal(
		verdict(update(adoptedRef), user({ principal: `u_${ulid()}` }), ctx()),
		"lane-owned",
	);
	equal(
		verdict(
			update(adoptedRef),
			agent(),
			ctx({ caller: { kind: "agent", writeCredential: true } }),
		),
		"lane-owned",
	);
	equal(
		verdict(
			update(adoptedRef),
			user(),
			ctx({
				ownLanes: [lane(laneId(ulid()), { ref: adoptedRef, state: "landing" })],
			}),
		),
		"lane-landing",
	);
	equal(
		verdict(
			update(adoptedRef),
			user(),
			ctx({ caller: { kind: "user", writeCredential: false } }),
		),
		"no-write-credential",
	);
});

Deno.test("row 8: other branches for users with a write credential; agents push only to their lanes", () => {
	equal(verdict(create("refs/heads/feat-x"), user(), userCtx()), "allow");
	equal(verdict(update("refs/heads/feat"), user(), userCtx()), "allow");
	equal(verdict(remove("refs/heads/feat"), user(), userCtx()), "allow");
	equal(
		verdict(
			create("refs/heads/feat-x"),
			user(),
			userCtx({ caller: { kind: "user", writeCredential: false } }),
		),
		"no-write-credential",
	);
	equal(verdict(create("refs/heads/feat-x"), agent()), "agents-lanes-only");
	equal(verdict(update("refs/heads/feat"), agent()), "agents-lanes-only");
});

Deno.test("row 9: tags need Maintainer+; agents never tag", () => {
	equal(
		verdict(create("refs/tags/v2"), user({ role: ROLE.maintainer }), userCtx()),
		"allow",
	);
	equal(
		verdict(create("refs/tags/v2"), user({ role: ROLE.owner }), userCtx()),
		"allow",
	);
	equal(
		verdict(create("refs/tags/v2"), user({ role: ROLE.developer }), userCtx()),
		"tags-maintainer",
	);
	equal(
		verdict(create("refs/tags/v2"), agent({ role: ROLE.owner })),
		"tags-maintainer",
	);
	equal(
		verdict(
			create("refs/tags/v2"),
			user({ role: ROLE.maintainer }),
			userCtx({ caller: { kind: "user", writeCredential: false } }),
		),
		"no-write-credential",
	);
});

Deno.test("row 10: everything else is unsupported-ref", () => {
	for (
		const ref of [
			"refs/notes/commits",
			"refs/pull/1/head",
			"refs/for/main",
			"refs/meta/config",
			"refs/changes/01/1/1",
			"refs/remotes/origin/main",
		]
	) {
		equal(
			verdict(create(ref), user({ role: ROLE.owner }), userCtx()),
			"unsupported-ref",
			ref,
		);
		equal(verdict(create(ref), agent()), "unsupported-ref", ref);
	}
});

Deno.test("decisions come back per command, in order", () => {
	const decisions = canonicalPushPolicy(
		context(),
		[update(laneRef(LANE_A)), update("refs/heads/main"), create("refs/tags/x")],
		agent(),
	);
	deepStrictEqual(decisions, [
		{ ref: laneRef(LANE_A), allow: true },
		{ ref: "refs/heads/main", allow: false, reason: "woven-by-tartan" },
		{ ref: "refs/tags/x", allow: false, reason: "tags-maintainer" },
	]);
});

// ---------------------------------------------------------------------------
// The canonical write precheck and the views
// ---------------------------------------------------------------------------

Deno.test("precheck: users need a write credential; agents an own active branch lane", () => {
	ok(canonicalWritePrecheck(userCtx(), user()));
	ok(
		!canonicalWritePrecheck(
			userCtx({ caller: { kind: "user", writeCredential: false } }),
			user(),
		),
	);
	ok(canonicalWritePrecheck(context(), agent()));
	ok(!canonicalWritePrecheck(context({ ownLanes: [] }), agent()));
	ok(
		!canonicalWritePrecheck(
			context({
				ownLanes: [lane(LANE_R, { mode: "repo", ref: "refs/heads/main" })],
			}),
			agent(),
		),
	);
	ok(
		!canonicalWritePrecheck(
			context({ ownLanes: [lane(LANE_A, { state: "closed" })] }),
			agent(),
		),
	);
	ok(
		!canonicalWritePrecheck(
			context({
				ownLanes: [lane(LANE_A, { state: "lost", resumable: false })],
			}),
			agent(),
		),
	);
	ok(
		canonicalWritePrecheck(
			context({ ownLanes: [lane(LANE_A, { state: "landing" })] }),
			agent(),
		),
	);
});

const auth = (over: Partial<AuthContext> = {}): AuthContext => ({
	principal: USER,
	kind: "user",
	via: "pat",
	scopes: ["repo:read", "repo:write"],
	nodeId: null,
	laneId: null,
	maxRole: ROLE.owner,
	isAdmin: false,
	...over,
});

const node = (visibility: "public" | "internal" | "private") => ({
	id: ulid(),
	parentId: null,
	kind: "repo" as const,
	slug: "shop",
	path: "acme/shop",
	depth: 1,
	visibility,
	archived: false,
	createdAt: 0,
});

Deno.test("views: the public view is anonymous, roleless, Guest or a token that does not cover the repo", () => {
	const pub = node("public");
	ok(publicView(null, { node: pub, role: 0 }));
	ok(publicView(auth(), { node: pub, role: 0 }));
	ok(publicView(auth(), { node: pub, role: ROLE.guest }));
	ok(publicView(auth({ scopes: ["mcp"] }), { node: pub, role: ROLE.owner }));
	ok(!publicView(auth(), { node: pub, role: ROLE.reporter }));
	ok(
		!publicView(auth({ via: "session", scopes: [] }), {
			node: pub,
			role: ROLE.reporter,
		}),
	);
	ok(!publicView(null, { node: node("private"), role: 0 }));
	ok(!publicView(auth(), { node: node("internal"), role: 0 }));
	ok(memberView(auth({ scopes: ["repo:read"] }), ROLE.reporter));
	ok(!memberView(auth({ scopes: ["lanes", "mcp"] }), ROLE.developer));
	ok(!memberView(null, ROLE.owner));
});

Deno.test("receive-pack gate: Developer+ with the lanes or repo:write scope", () => {
	ok(mayReceivePack(auth(), ROLE.developer));
	ok(mayReceivePack(auth({ scopes: ["lanes"] }), ROLE.developer));
	ok(mayReceivePack(auth({ via: "session", scopes: [] }), ROLE.developer));
	ok(!mayReceivePack(auth({ scopes: ["repo:read"] }), ROLE.owner));
	ok(!mayReceivePack(auth(), ROLE.reporter));
});

Deno.test("globMatch: `*` within a segment, `**` across, bare patterns under refs/heads/", () => {
	ok(globMatch("release/*", "refs/heads/release/1.0"));
	ok(!globMatch("release/*", "refs/heads/release/1/2"));
	ok(globMatch("release/**", "refs/heads/release/1/2"));
	ok(globMatch("refs/tags/v*", "refs/tags/v1.2"));
	ok(!globMatch("main", "refs/heads/main2"));
	ok(globMatch("**", "refs/heads/anything/at/all"));
	ok(globMatch("a*b*c", "refs/heads/aXbYc"));
	ok(!globMatch("a*b*c", "refs/heads/aXbY"));
	// Linear: a pathological pattern finishes at once.
	const start = performance.now();
	ok(!globMatch(`${"*a".repeat(40)}*b`, `refs/heads/${"a".repeat(200)}`));
	ok(performance.now() - start < 1000);
});

// ---------------------------------------------------------------------------
// Property tests (seeded)
// ---------------------------------------------------------------------------

const rng = (seed: number) => {
	let state = seed >>> 0;
	return () => {
		state = (state * 1_664_525 + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
};

const pick = <T>(random: () => number, list: readonly T[]): T =>
	list[Math.floor(random() * list.length)];

const flipCase = (random: () => number, text: string): string =>
	[...text].map((c) => random() < 0.5 ? c.toUpperCase() : c.toLowerCase())
		.join("");

const STATES: LaneState[] = [
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

const randomRef = (random: () => number, lanes: readonly string[]): string => {
	const lanesPart = pick(random, lanes);
	const base = pick(random, [
		"refs/heads/main",
		"refs/heads/feat",
		`refs/heads/x${Math.floor(random() * 50)}`,
		"refs/tags/v1",
		`refs/tags/t${Math.floor(random() * 50)}`,
		"refs/notes/tartan",
		"refs/notes/commits",
		"refs/tartan/changes/a",
		"refs/heads/tartan/x",
		"refs/tartan-work/b/trunk",
		laneRef(lanesPart),
		`${laneRef(lanesPart)}/deep`,
		`refs/notes/lanes/${lanesPart}/agent-trace`,
		...RESERVED_REF_PARENTS,
		"refs/pull/1/head",
		"refs/heads/release/2",
	]);
	return random() < 0.3 ? flipCase(random, base) : base;
};

const randomCommand = (random: () => number, ref: string): PushCommand => {
	const roll = random();
	return roll < 0.2
		? create(ref, sha(Math.floor(random() * 5)))
		: roll < 0.35
		? remove(ref, sha(Math.floor(random() * 5)))
		: update(
			ref,
			sha(Math.floor(random() * 5)),
			sha(10 + Math.floor(random() * 5)),
		);
};

const randomContext = (
	random: () => number,
	lanes: readonly string[],
	kind: "user" | "agent",
): GatewayPushContext => {
	const own = lanes.filter(() => random() < 0.5).map((id) =>
		lane(id, {
			mode: random() < 0.8 ? "branch" : "repo",
			state: pick(random, STATES),
			headSha: random() < 0.2 ? null : sha(Math.floor(random() * 5)),
			resumable: random() < 0.8,
			leased: random() < 0.1,
		})
	);
	return context({
		caller: { kind, writeCredential: random() < 0.8 },
		ownLanes: own,
		importState: random() < 0.15 ? "importing" : "none",
		caseFoldedRefs: [
			"refs/heads/main",
			"refs/heads/feat",
			"refs/tags/v1",
			...lanes.map(laneRef),
		],
	});
};

const CASES = 4_000;

Deno.test("property: an agent is never allowed a ref outside its own active, non-landing branch lanes", () => {
	const random = rng(0x5eed);
	const lanes = Array.from({ length: 4 }, () => laneId(ulid()));
	for (let i = 0; i < CASES; i++) {
		const ctx = randomContext(random, lanes, "agent");
		const command = randomCommand(random, randomRef(random, lanes));
		const [decision] = canonicalPushPolicy(
			ctx,
			[command],
			agent({ role: pick(random, [10, 20, 30, 40, 50] as const) }),
		);
		if (!decision.allow) continue;
		const target = ctx.ownLanes.find((own) =>
			own.mode === "branch" &&
			(command.ref === own.ref ||
				command.ref.startsWith(`refs/notes/lanes/${own.laneId}/`))
		);
		ok(target !== undefined, `allowed outside own lanes: ${command.ref}`);
		ok(target.state !== "landing", "allowed while landing");
		ok(
			["open", "submitted", "landing", "lost"].includes(target.state),
			`allowed in ${target.state}`,
		);
		ok(
			target.state !== "lost" || target.resumable,
			"allowed past the resume window",
		);
		ok(ctx.caller.writeCredential, "allowed without a write credential");
		ok(ctx.importState === "none", "agent allowed in import mode");
		ok(command.new !== ZERO_SHA, "agent deleted a ref");
		if (command.ref === target.ref) {
			equal(command.old, target.headSha ?? ZERO_SHA, "old ≠ index head");
			ok(!target.leased, "allowed a leased head");
		}
	}
});

Deno.test("property: a reserved prefix or reserved parent, in any letter case, is never allowed (import mode included)", () => {
	const random = rng(0xcafe);
	const lanes = Array.from({ length: 3 }, () => laneId(ulid()));
	const reserved = [
		...RESERVED_REF_PARENTS,
		...RESERVED_REF_PREFIXES.map((p) => `${p}x/y`),
		"refs/notes/tartan",
	];
	for (let i = 0; i < CASES; i++) {
		const kind = random() < 0.5 ? "user" : "agent";
		const ctx = randomContext(random, lanes, kind);
		const ref = flipCase(random, pick(random, reserved));
		const command = randomCommand(random, ref);
		const caller = kind === "user"
			? user({ role: ROLE.owner, forgeOwner: random() < 0.5 })
			: agent();
		const [decision] = canonicalPushPolicy(ctx, [command], caller);
		ok(!decision.allow, `reserved name allowed: ${ref}`);
	}
	// The exact lane refs are reserved prefixes too, but row 4 lets their
	// owners write them: only spellings outside the lane grammar are checked
	// above (`x/y` under each prefix).
});

Deno.test("property: a case variant of an existing ref, an adopted lane's ref or a protected match is never allowed", () => {
	const random = rng(0xbeef);
	const existing = ["refs/heads/feat", "refs/heads/Mixed", "refs/tags/v1"];
	const adopted = "refs/heads/adopted-x";
	for (let i = 0; i < CASES; i++) {
		const base = pick(random, [
			...existing,
			adopted,
			"refs/heads/main",
			"refs/heads/release/9",
		]);
		const ref = flipCase(random, base);
		const ctx = userCtx({
			caseFoldedRefs: [...existing, adopted, "refs/heads/main"].map(fold),
			refNames: [...existing, adopted, "refs/heads/main"],
			adopted: [{ ref: adopted, owner: USER, delegates: [] }],
			protectedPatterns: ["refs/heads/main", "release/*"],
		});
		const [decision] = canonicalPushPolicy(
			ctx,
			[update(ref)],
			user({ role: ROLE.owner }),
		);
		if (ref !== base) ok(!decision.allow, `case variant allowed: ${ref}`);
		if (decision.allow) {
			ok(
				existing.includes(ref) || ref === adopted,
				`allowed: ${ref}`,
			);
		}
	}
});

Deno.test("property: a downgraded user or read-scoped token never writes", () => {
	const random = rng(0xd00d);
	const lanes = Array.from({ length: 3 }, () => laneId(ulid()));
	for (let i = 0; i < CASES; i++) {
		const kind: "user" | "agent" = random() < 0.5 ? "user" : "agent";
		const ctx: GatewayPushContext = {
			...randomContext(random, lanes, kind),
			caller: { kind, writeCredential: false },
			importState: "none" as const,
		};
		const command = randomCommand(random, randomRef(random, lanes));
		const caller = kind === "user" ? user({ role: ROLE.owner }) : agent();
		const [decision] = canonicalPushPolicy(ctx, [command], caller);
		ok(!decision.allow, `write without a credential: ${command.ref}`);
		ok(!canonicalWritePrecheck(ctx, caller) || kind === "agent");
	}
});

Deno.test("property: a repo-backend lane id under refs/heads/lanes/ is never writable on the canonical repo", () => {
	const random = rng(0x1a4e);
	for (let i = 0; i < CASES; i++) {
		const id = laneId(ulid());
		const ctx = context({
			ownLanes: [
				lane(id, {
					mode: "repo",
					ref: "refs/heads/main",
					state: pick(random, STATES),
				}),
			],
			caseFoldedRefs: [laneRef(id)],
		});
		const command = randomCommand(random, laneRef(id));
		const [decision] = canonicalPushPolicy(
			ctx,
			[command],
			agent({ laneId: random() < 0.5 ? id : null }),
		);
		ok(!decision.allow);
	}
});

Deno.test("property: a lane update whose old differs from the index head is stale-old", () => {
	const random = rng(0x01d);
	for (let i = 0; i < CASES; i++) {
		const head = sha(Math.floor(random() * 5));
		const old = sha(Math.floor(random() * 5));
		const ctx = context({ ownLanes: [lane(LANE_A, { headSha: head })] });
		const [decision] = canonicalPushPolicy(ctx, [
			update(laneRef(LANE_A), old, sha(30)),
		], agent());
		if (old === head) ok(decision.allow);
		else {deepStrictEqual(decision, {
				ref: laneRef(LANE_A),
				allow: false,
				reason: "stale-old",
			});}
	}
});

Deno.test("property: TRUNK is never writable by anyone", () => {
	const random = rng(0x7a7a);
	for (let i = 0; i < 500; i++) {
		const kind = random() < 0.5 ? "user" : "agent";
		const ctx = randomContext(random, [LANE_A], kind);
		const command = update("refs/heads/main", TRUNK, sha(40));
		const caller = kind === "user"
			? user({ role: ROLE.owner, forgeOwner: false })
			: agent();
		const [decision] = canonicalPushPolicy(ctx, [command], caller);
		ok(!decision.allow);
	}
});
