// Lanes of RepoDO core (WP5a; K2, K7, K16): opening on both
// backends, the MCP wait, K16 per operation, lane caps and the open rate,
// leases, lane GC, adoption, delegates, sync/restack, archive and purge, and
// the lane transitions WP6 and WP10 drive.

import {
	deepStrictEqual,
	equal,
	ok,
	rejects,
	throws,
} from "node:assert/strict";
import {
	fromRpcError,
	type Lane,
	LANE_DELETE_AFTER_CLOSE_MS,
	LANE_LEASE_MS,
	LANE_RESUME_MS,
	LaneSchema,
	ROLE,
	ZERO_SHA,
} from "@tartan/contract";
import {
	KERNEL_LANE_ACTOR,
	type LandingRow,
	type LaneOpActor,
	seedTimerKey,
} from "@tartan/contract/kernel.ts";
import { ROLE_CACHE_MS } from "../roles.ts";
import {
	createHarness,
	fakeRepoBackend,
	type Harness,
	principals,
	sha,
	TRUNK,
} from "../testing/harness.ts";

const agent = (id: string, extra: Partial<LaneOpActor> = {}): LaneOpActor => ({
	kind: "agent",
	id,
	...extra,
});
const user = (id: string): LaneOpActor => ({ kind: "user", id });

const deniedWith = (reason: string, code?: string) => (e: unknown) => {
	const error = fromRpcError(e);
	return error.code === "denied" && error.reason === reason &&
		(code === undefined ||
			(error.details as { code?: string })?.code === code ||
			error.text.includes(code));
};
const conflictWith = (code: string) => (e: unknown) => {
	const error = fromRpcError(e);
	return error.code === "conflict" &&
		(error.details as { code?: string })?.code === code;
};

const open = (h: Harness, owner: string, extra: Partial<LaneOpActor> = {}) =>
	h.facade.openLane({ owner, actor: agent(owner, extra) });

const push = (
	h: Harness,
	lane: Lane,
	pusher: string,
	after: string,
	before?: string,
) =>
	h.facade.recordPush({
		target: lane.id,
		refs: [{ ref: lane.ref, before: before ?? lane.head ?? ZERO_SHA, after }],
		principal: pusher,
		via: "gateway",
		requestId: `req-${after}`,
	});

const deniedEvents = (h: Harness) =>
	h.events.ofType("lane.denied").map((e) =>
		e.data as { op: string; reason: string }
	);

Deno.test("openLane on a branch repo makes no Artifacts call and opens in one transaction", async () => {
	const h = await createHarness();
	const { agent: a } = principals(h);
	h.artifactsCalls.length = 0;
	let transactions = 0;
	const tx = h.storage.transactionSync;
	h.storage.transactionSync = (closure) => {
		transactions++;
		return tx(closure);
	};
	const lane = await h.facade.openLane({
		owner: a,
		actor: agent(a, { installation: "i_01k6c0ffee0000000000000000" }),
		entity: { kind: "work", id: "01k6c0ffee0000000000000001" },
		footprint: { projects: ["api"], prefixes: ["services/api"] },
	});
	h.storage.transactionSync = tx;
	deepStrictEqual(h.artifactsCalls, []);
	equal(transactions, 1);
	LaneSchema.parse(lane);
	equal(lane.state, "open");
	equal(lane.mode, "branch");
	equal(lane.ref, `refs/heads/lanes/${lane.id}`);
	equal(lane.branch, `lanes/${lane.id}`);
	equal(lane.base, TRUNK);
	equal(lane.head, undefined);
	equal(lane.remote, "/acme/shop.git");
	equal(lane.openedByInstallation, "i_01k6c0ffee0000000000000000");
	deepStrictEqual(h.events.types().filter((t) => t.startsWith("lane.")), [
		"lane.opened",
	]);
	equal(
		(h.events.ofType("lane.opened")[0].data as { mode: string }).mode,
		"branch",
	);
	ok(h.timers.get("core", "lease") !== null, "the lease timer is armed");
});

Deno.test("[gate] openLane on a repo-mode repo returns `opening` at once while the seeder never finishes; awaitLane returns it after the timeout; a close fences the seed and releases waiters", async () => {
	const record = { started: [] as string[] };
	const h = await createHarness({
		laneMode: "import",
		createRepoBackend: fakeRepoBackend(record),
	});
	const { agent: a } = principals(h);
	const lane = await open(h, a);
	LaneSchema.parse(lane);
	equal(lane.state, "opening");
	equal(lane.mode, "repo");
	equal(lane.ref, "refs/heads/main");
	equal(lane.base, TRUNK);
	deepStrictEqual(record.started, [lane.id]);
	deepStrictEqual(h.events.types().filter((t) => t.startsWith("lane.")), [
		"lane.opening",
	]);
	const deadline = h.timers.get("core", seedTimerKey(lane.id));
	equal(deadline, h.clock.now() + 13_000, "watchdog at seed_deadline, not now");
	const seed = h.storage.sql.exec<
		{ purpose: string; state: string; new_sha: string }
	>(
		"SELECT purpose, state, new_sha FROM kernel_writes WHERE target = ?",
		lane.id,
	).toArray();
	deepStrictEqual(seed, [{
		purpose: "lane-seed",
		state: "intent",
		new_sha: TRUNK,
	}]);

	const started = Date.now();
	const waited = await h.facade.awaitLane(lane.id, 30);
	ok(Date.now() - started >= 25);
	equal(waited.state, "opening");

	// K7 never fires on an opening lane.
	h.clock.advance(LANE_LEASE_MS * 3);
	await h.runTimers();
	equal((await h.facade.getLane(lane.id))?.state, "opening");

	const waiting = h.facade.awaitLane(lane.id, 60_000);
	await h.facade.closeLane(lane.id, "no longer needed", agent(a));
	const released = await waiting;
	equal(released.state, "closed");
	const row = h.internal.laneSync(lane.id);
	equal(row?.cap_nonce, null);
	equal(h.timers.get("core", seedTimerKey(lane.id)), null);
	equal(
		h.storage.sql.exec<{ state: string }>(
			"SELECT state FROM kernel_writes WHERE target = ?",
			lane.id,
		).one().state,
		"abandoned",
	);
	const [closed] = h.events.ofType("lane.closed");
	equal((closed.data as { seedCode: string }).seedCode, "cancelled");
});

Deno.test("K16: another agent's close, sync, restack, delegate and adopt are denied with lane-op ⇒ lane.denied; a Maintainer may close", async () => {
	const h = await createHarness();
	const { agent: a } = principals(h);
	const { agent: b, user: maintainer } = principals(h);
	const laneB = await open(h, b);
	const laneA = await open(h, a);
	await push(h, laneB, b, sha(10));
	const checks: [string, () => Promise<unknown>][] = [
		["close", () => h.facade.closeLane(laneB.id, "x", agent(a))],
		["sync", () => h.facade.syncLane(laneB.id, agent(a))],
		["restack", () => h.facade.restackLane(laneB.id, laneA.id, agent(a))],
		["delegate", () => h.facade.delegateLane(laneB.id, [a], [], agent(a))],
		["purge", () => h.facade.purgeLane(laneB.id, agent(a))],
	];
	for (const [op, call] of checks) {
		await rejects(call, deniedWith("lane-op"), op);
	}
	deepStrictEqual(deniedEvents(h).map((d) => d.op), [
		"close",
		"sync",
		"restack",
		"delegate",
		"purge",
	]);
	equal(h.gitJobs.calls.length, 0, "no git job ran");
	// An agent can never adopt a branch, even one it pushed.
	await h.facade.recordPush({
		target: "repo",
		refs: [{ ref: "refs/heads/feat", before: ZERO_SHA, after: sha(11) }],
		principal: a,
		via: "gateway",
		requestId: "feat-1",
	});
	await rejects(
		() =>
			h.facade.adoptLane({
				ref: "refs/heads/feat",
				owner: a,
				actor: agent(a),
			}),
		deniedWith("lane-op"),
	);
	// An extension's background open, and an owner who is not the actor.
	await rejects(
		() =>
			h.facade.openLane({
				owner: "x_i_01k6c0ffee0000000000000000",
				actor: { kind: "ext", id: "x_i_01k6c0ffee0000000000000000" },
			}),
		deniedWith("lane-op"),
	);
	await rejects(
		() => h.facade.openLane({ owner: b, actor: agent(a) }),
		deniedWith("lane-op"),
	);
	// The read-only pre-check agrees and writes nothing.
	const before = h.events.all().length;
	deepStrictEqual(
		await h.facade.authorizeLaneOp(agent(a), laneB.id, "close"),
		{ ok: false, reason: "lane-op" },
	);
	deepStrictEqual(await h.facade.authorizeLaneOp(agent(b), laneB.id, "close"), {
		ok: true,
	});
	equal(h.events.all().length, before);
	// A Maintainer may close B's lane.
	h.tree.roles.set(maintainer, ROLE.maintainer);
	await h.facade.closeLane(laneB.id, "cleanup", user(maintainer));
	equal((await h.facade.getLane(laneB.id))?.state, "closed");
	equal(
		(await h.facade.getLane(laneB.id))?.closedAt !== undefined,
		true,
	);
});

Deno.test("K16: a delegate may sync and close but not restack or change delegates; the owner may", async () => {
	const h = await createHarness();
	const { agent: a } = principals(h);
	const { agent: d } = principals(h);
	const lane = await open(h, a);
	const other = await open(h, a);
	await h.facade.delegateLane(lane.id, [d], [], agent(a));
	deepStrictEqual((await h.facade.getLane(lane.id))?.delegates, [d]);
	equal(h.events.ofType("lane.delegated").length, 1);
	const synced = await h.facade.syncLane(lane.id, agent(d));
	deepStrictEqual(synced, { ok: true, head: sha(55) });
	equal(h.events.ofType("lane.synced").length, 1);
	await rejects(
		() => h.facade.restackLane(lane.id, other.id, agent(d)),
		deniedWith("lane-op"),
	);
	await rejects(
		() => h.facade.delegateLane(lane.id, [], [d], agent(d)),
		deniedWith("lane-op"),
	);
	const restacked = await h.facade.restackLane(lane.id, other.id, agent(a));
	deepStrictEqual(restacked, { ok: true, head: sha(56) });
	equal((await h.facade.getLane(lane.id))?.dependsOnLane, other.id);
	await h.facade.closeLane(lane.id, "done", agent(d));
	equal((await h.facade.getLane(lane.id))?.state, "closed");
});

Deno.test("the 21st active lane of a principal and the 31st open within a minute get lane-cap", async () => {
	const h = await createHarness();
	const { agent: a } = principals(h);
	const lanes: Lane[] = [];
	for (let i = 0; i < 20; i++) lanes.push(await open(h, a));
	await rejects(() => open(h, a), deniedWith("lane-cap", "per-principal"));
	for (const lane of lanes.slice(0, 10)) {
		await h.facade.closeLane(lane.id, "x", agent(a));
	}
	for (let i = 0; i < 10; i++) await open(h, a);
	// 30 opens in this minute: the next is the rate limit, not the cap.
	for (const lane of lanes.slice(10, 15)) {
		await h.facade.closeLane(lane.id, "x", agent(a));
	}
	await rejects(() => open(h, a), deniedWith("lane-cap", "open-rate"));
	h.clock.advance(61_000);
	ok(await open(h, a));
	const caps = deniedEvents(h).filter((d) => d.reason.startsWith("lane-cap"));
	equal(caps.length, 2);
	// The per-repo cap (Owner setting) applies to everyone.
	h.storage.sql.exec(
		"INSERT INTO meta (k, v) VALUES ('max_active_lanes', '16')",
	);
	const { agent: b } = principals(h);
	await rejects(() => open(h, b), deniedWith("lane-cap", "per-repo"));
});

Deno.test("[gate] K7: lease expiry → lost (resumable for 24 h by a push or a renewal), then closed; never from opening", async () => {
	const h = await createHarness();
	const { agent: a } = principals(h);
	const lane = await open(h, a);
	const second = await open(h, a);
	h.clock.advance(LANE_LEASE_MS + 1);
	await h.runTimers();
	equal((await h.facade.getLane(lane.id))?.state, "lost");
	equal(h.events.ofType("lane.lost").length, 2);
	// The owner resumes one by pushing, the other by renewing.
	await push(h, lane, a, sha(20));
	equal((await h.facade.getLane(lane.id))?.state, "open");
	const renewed = await h.facade.renewLease(second.id, a);
	equal(renewed.leaseExpiresAt, h.clock.now() + LANE_LEASE_MS);
	equal((await h.facade.getLane(second.id))?.state, "open");
	equal(
		h.events.ofType("lane.opened").filter((e) =>
			(e.data as { reason?: string }).reason === "resumed"
		).length,
		2,
	);
	await rejects(
		() => h.facade.renewLease(second.id, principals(h).agent),
		deniedWith("lane-op"),
	);
	// Lost past the resume window: closed, with lane GC scheduled.
	h.clock.advance(LANE_LEASE_MS + 1);
	await h.runTimers();
	equal((await h.facade.getLane(second.id))?.state, "lost");
	h.clock.advance(LANE_RESUME_MS + 1);
	await h.runTimers();
	const closed = await h.facade.getLane(second.id);
	equal(closed?.state, "closed");
	await rejects(
		() => h.facade.renewLease(second.id, a),
		conflictWith("lane-closed"),
	);
	equal(
		h.internal.laneSync(second.id)?.delete_after,
		(closed?.closedAt ?? 0) + LANE_DELETE_AFTER_CLOSE_MS,
	);
});

Deno.test("[gate] lane GC deletes only kind='lane' refs at the recorded head, skips a moved head (K2), never touches adopted branches", async () => {
	const h = await createHarness();
	const { agent: a, user: u } = principals(h);
	const pushed = await open(h, a);
	const moved = await open(h, a);
	const empty = await open(h, a);
	const landed = await open(h, a);
	for (
		const [lane, head] of [[pushed, sha(30)], [moved, sha(31)], [
			landed,
			sha(32),
		]] as const
	) {
		h.upstream.set(h.canonical, lane.ref, head);
		await push(h, lane, a, head);
	}
	// A human branch adopted by its last pusher.
	h.upstream.set(h.canonical, "refs/heads/feat", sha(33));
	await h.facade.recordPush({
		target: "repo",
		refs: [{ ref: "refs/heads/feat", before: ZERO_SHA, after: sha(33) }],
		principal: u,
		via: "gateway",
		requestId: "feat-1",
	});
	const adopted = await h.facade.adoptLane({
		ref: "refs/heads/feat",
		owner: u,
		actor: user(u),
	});
	equal(adopted.kind, "adopted");
	equal(adopted.head, sha(33));
	h.land.landings.set(landed.id, { lane_head: sha(32) } as LandingRow);
	for (const lane of [pushed, moved, empty, landed, adopted]) {
		await h.facade.closeLane(
			lane.id,
			"done",
			lane.kind === "adopted" ? user(u) : agent(a),
		);
	}
	// Not due yet.
	let run = await h.facade.gcLanes(h.clock.now());
	deepStrictEqual(run, { deleted: [], deferred: [], skipped: [] });
	// Someone moved `moved` after close.
	h.upstream.set(h.canonical, moved.ref, sha(34));
	h.clock.advance(LANE_DELETE_AFTER_CLOSE_MS + 1);
	run = await h.facade.gcLanes(h.clock.now());
	deepStrictEqual(
		[...run.deleted].sort(),
		[pushed.id, empty.id, landed.id].sort(),
	);
	deepStrictEqual(run.skipped, [moved.id]);
	equal(h.upstream.get(h.canonical, pushed.ref), null);
	equal(h.upstream.get(h.canonical, landed.ref), null);
	equal(h.upstream.get(h.canonical, moved.ref), sha(34));
	equal(
		h.upstream.get(h.canonical, "refs/heads/feat"),
		sha(33),
		"adopted branch untouched",
	);
	const gcWrites = h.storage.sql.exec<
		{ ref: string; expect_old: string; purpose: string }
	>(
		"SELECT ref, expect_old, purpose FROM kernel_writes WHERE purpose = 'lane-gc' ORDER BY ref",
	).toArray();
	deepStrictEqual(
		gcWrites,
		[
			{ ref: pushed.ref, expect_old: sha(30), purpose: "lane-gc" },
			{ ref: landed.ref, expect_old: sha(32), purpose: "lane-gc" },
		].sort((x, y) => x.ref.localeCompare(y.ref)),
	);
	for (const id of [pushed.id, empty.id, landed.id]) {
		equal((await h.facade.getLane(id))?.state, "deleted");
	}
	equal(h.events.ofType("lane.deleted").length, 3);
	equal((await h.facade.getLane(adopted.id))?.state, "closed");
	// The moved head went to K2 (a reconciliation observation, then quarantine).
	await h.settle();
	h.clock.advance(3 * 60 * 1000);
	await h.runTimers();
	equal((await h.facade.getLane(moved.id))?.quarantined, true);
	deepStrictEqual(h.events.ofType("ref.tampered").length, 1);
	// No GC delete triggers K1/K2 when its trigger event arrives.
	await h.facade.observePush({
		eventId: "evt-gc",
		repoName: h.canonical,
		ref: pushed.ref,
		before: sha(30),
		after: ZERO_SHA,
		at: h.clock.now(),
	});
	h.clock.advance(3 * 60 * 1000);
	await h.runTimers();
	equal(h.events.ofType("ref.tampered").length, 1);
});

Deno.test("adoptLane: the branch's last gateway pusher or a Maintainer+, never a protected or reserved ref", async () => {
	const h = await createHarness();
	const { user: u1, user: _ } = principals(h);
	const { user: u2 } = principals(h);
	await h.facade.recordPush({
		target: "repo",
		refs: [{ ref: "refs/heads/feat", before: ZERO_SHA, after: sha(40) }],
		principal: u1,
		via: "gateway",
		requestId: "feat-1",
	});
	await rejects(
		() =>
			h.facade.adoptLane({
				ref: "refs/heads/feat",
				owner: u2,
				actor: user(u2),
			}),
		deniedWith("lane-op"),
	);
	h.tree.roles.set(u2, ROLE.maintainer);
	h.clock.advance(ROLE_CACHE_MS + 1);
	const lane = await h.facade.adoptLane({
		ref: "refs/heads/feat",
		owner: u2,
		actor: user(u2),
	});
	LaneSchema.parse(lane);
	equal(lane.branch, "feat");
	await rejects(
		() =>
			h.facade.adoptLane({
				ref: "refs/heads/feat",
				owner: u1,
				actor: user(u1),
			}),
		(e: unknown) => fromRpcError(e).code === "conflict",
	);
	for (
		const ref of [
			"refs/heads/main",
			"refs/heads/lanes/x",
			"refs/tartan/x",
			"refs/tags/v1",
		]
	) {
		await rejects(
			() => h.facade.adoptLane({ ref, owner: u2, actor: user(u2) }),
			(e: unknown) => ["invalid", "not_found"].includes(fromRpcError(e).code),
			ref,
		);
	}
});

Deno.test("pushContext: own lanes and delegates, the lane pin, the target lane, adopted owners, case-folded refs and the write credential", async () => {
	const h = await createHarness();
	const { agent: a } = principals(h);
	const { agent: d } = principals(h);
	h.tree.protected = ["refs/heads/release/*"];
	const mine = await open(h, a);
	const pinned = await open(h, a);
	await h.facade.delegateLane(mine.id, [d], [], agent(a));
	h.storage.sql.exec(
		"INSERT INTO refs (ref, sha, updated_at) VALUES ('refs/heads/Feature', ?, 0)",
		sha(50),
	);
	const auth = (principal: string, scopes: string[] = ["lanes", "mcp"]) => ({
		principal,
		kind: "agent" as const,
		via: "agent-token" as const,
		scopes: scopes as never,
		nodeId: null,
		laneId: null,
		maxRole: 50 as const,
		isAdmin: false,
	});
	h.tree.roles.set(a, ROLE.developer);
	h.tree.roles.set(d, ROLE.reporter);
	const ctx = await h.facade.pushContext(auth(a), null, { laneId: mine.id });
	equal(ctx.caller.writeCredential, true);
	deepStrictEqual(
		ctx.ownLanes.map((l) => l.laneId).sort(),
		[mine.id, pinned.id].sort(),
	);
	deepStrictEqual(ctx.target?.delegates, [d]);
	equal(ctx.target?.owner, a);
	equal(ctx.target?.resumable, true);
	equal(ctx.target?.leased, false);
	deepStrictEqual(ctx.protectedPatterns, [
		"refs/heads/main",
		"refs/heads/release/*",
	]);
	ok(ctx.caseFoldedRefs.includes("refs/heads/feature"));
	ok(
		ctx.caseFoldedRefs.includes(mine.ref.toLowerCase()),
		"a lane ref before its first push",
	);
	equal(ctx.importState, "none");
	equal(ctx.landingPaused, false);
	// The pin narrows own lanes.
	const pinnedCtx = await h.facade.pushContext(auth(a), pinned.id);
	deepStrictEqual(pinnedCtx.ownLanes.map((l) => l.laneId), [pinned.id]);
	// A delegate sees the delegated lane; Reporter means no write credential.
	const delegateCtx = await h.facade.pushContext(auth(d), null);
	deepStrictEqual(delegateCtx.ownLanes.map((l) => l.laneId), [mine.id]);
	equal(delegateCtx.caller.writeCredential, false);
	// A read-scoped token holds no write credential whatever the role.
	const readOnly = await h.facade.pushContext(auth(a, ["repo:read"]), null);
	equal(readOnly.caller.writeCredential, false);
	await rejects(
		() =>
			h.facade.pushContext(auth(a), null, {
				laneId: "ln_01k6c0ffee0000000000000000",
			}),
		(e: unknown) => fromRpcError(e).code === "not_found",
	);
});

Deno.test("pushContext leases lane heads only with PUSH_LEASE_ENABLED; phase 1 releases them", async () => {
	const h = await createHarness({ pushLeases: true });
	const { agent: a } = principals(h);
	h.tree.roles.set(a, ROLE.developer);
	const lane = await open(h, a);
	const auth = {
		principal: a,
		kind: "agent" as const,
		via: "agent-token" as const,
		scopes: ["lanes" as const],
		nodeId: null,
		laneId: null,
		maxRole: 50 as const,
		isAdmin: false,
	};
	const first = await h.facade.pushContext(auth, null, undefined, {
		requestId: "r1",
		refs: [lane.ref],
	});
	equal(first.ownLanes[0].leased, false);
	const second = await h.facade.pushContext(auth, null, undefined, {
		requestId: "r2",
		refs: [lane.ref],
	});
	equal(second.ownLanes[0].leased, true, "held by r1");
	await h.facade.recordPush({
		target: lane.id,
		refs: [{ ref: lane.ref, before: ZERO_SHA, after: sha(60) }],
		principal: a,
		via: "gateway",
		requestId: "r1",
	});
	const third = await h.facade.pushContext(auth, null, undefined, {
		requestId: "r3",
		refs: [lane.ref],
	});
	equal(third.ownLanes[0].leased, false, "released by phase 1");
});

Deno.test("pushContext never leases another agent's lane, nor the caller's other lanes on a lane remote", async () => {
	const h = await createHarness({ pushLeases: true });
	const { agent: a } = principals(h);
	const { agent: b } = principals(h);
	h.tree.roles.set(a, ROLE.developer);
	h.tree.roles.set(b, ROLE.developer);
	const lane = await open(h, a);
	const other = await open(h, a);
	const auth = (principal: string) => ({
		principal,
		kind: "agent" as const,
		via: "agent-token" as const,
		scopes: ["lanes" as const],
		nodeId: null,
		laneId: null,
		maxRole: 50 as const,
		isAdmin: false,
	});
	// B pushes to A's lane over and over; the policy will refuse it.
	for (const requestId of ["rb1", "rb2"]) {
		const probe = await h.facade.pushContext(auth(b), null, {
			laneId: lane.id,
		}, { requestId, refs: [lane.ref, other.ref] });
		equal(probe.target?.leased, false);
	}
	// A's own push is not held by B's requests.
	const own = await h.facade.pushContext(auth(a), null, { laneId: lane.id }, {
		requestId: "ra",
		refs: [lane.ref, other.ref],
	});
	equal(own.target?.leased, false, "no lease from B's requests");
	// A's lease on the target works, and A's other lane is not leased by it.
	const again = await h.facade.pushContext(auth(a), null, {
		laneId: lane.id,
	}, { requestId: "ra2", refs: [lane.ref, other.ref] });
	equal(again.target?.leased, true, "held by ra");
	const otherCtx = await h.facade.pushContext(auth(a), null, {
		laneId: other.id,
	}, { requestId: "ra3", refs: [lane.ref, other.ref] });
	equal(otherCtx.target?.leased, false, "the other lane was never leased");
});

Deno.test("readContext: visible tips without hidden refs, recent tips, the caller's own branch lanes", async () => {
	const h = await createHarness();
	const { agent: a, user: u } = principals(h);
	const lane = await open(h, a);
	await push(h, lane, a, sha(70));
	await h.facade.recordPush({
		target: "repo",
		refs: [{ ref: "refs/heads/feat", before: ZERO_SHA, after: sha(71) }],
		principal: u,
		via: "gateway",
		requestId: "f1",
	});
	await h.facade.recordPush({
		target: "repo",
		refs: [{ ref: "refs/heads/feat", before: sha(71), after: sha(72) }],
		principal: u,
		via: "gateway",
		requestId: "f2",
	});
	const anon = await h.facade.readContext("anon");
	equal(anon.view, "public");
	deepStrictEqual([...anon.visibleTips].sort(), [TRUNK, sha(72)].sort());
	ok(anon.recentTips.includes(sha(71)));
	ok(!anon.recentTips.includes(sha(70)), "a hidden lane ref never counts");
	deepStrictEqual(anon.ownLanes, []);
	const member = await h.facade.readContext({
		principal: a,
		kind: "agent",
		via: "agent-token",
		scopes: ["lanes"],
		nodeId: null,
		laneId: null,
		maxRole: 50,
		isAdmin: false,
	});
	equal(member.view, "member");
	deepStrictEqual(member.ownLanes, [{
		laneId: lane.id,
		ref: lane.ref,
		headSha: sha(70),
	}]);
});

Deno.test("lane transitions: changes events move lanes (shadow and opening lanes never); WP10's land transitions; sync refused while landing", async () => {
	const h = await createHarness();
	const { agent: a } = principals(h);
	const lane = await open(h, a);
	await push(h, lane, a, sha(80));
	const append = (
		type: string,
		data: Record<string, unknown>,
		shadow = false,
	) =>
		h.storage.transactionSync(() =>
			h.events.appendSync({
				type,
				source: { kind: "kernel" },
				actor: { kind: "agent", id: a },
				node: h.nodeId,
				repo: h.repoId,
				depth: 0,
				shadow,
				data,
				idemKey: `t:${type}:${h.ulid()}`,
			})
		);
	const changeId = "zkqvzkqvzkqvzkqvzkqvzkqvzkqvzkqv";
	append("changes.submitted", {
		changeId,
		laneId: lane.id,
		revision: 1,
		head: sha(80),
		base: TRUNK,
		affected: [],
	}, true);
	equal(
		(await h.facade.getLane(lane.id))?.state,
		"open",
		"shadow events never move a lane",
	);
	append("changes.submitted", {
		changeId,
		laneId: lane.id,
		revision: 1,
		head: sha(80),
		base: TRUNK,
		affected: [],
	});
	equal((await h.facade.getLane(lane.id))?.state, "submitted");
	equal(h.internal.laneSync(lane.id)?.change_id, changeId);
	append("changes.abandoned", { changeId });
	equal((await h.facade.getLane(lane.id))?.state, "open", "found by change id");
	append("changes.submitted", {
		changeId,
		laneId: lane.id,
		revision: 2,
		head: sha(80),
		base: TRUNK,
		affected: [],
	});
	h.storage.transactionSync(() =>
		h.internal.setLaneStateSync(lane.id, "landing")
	);
	await rejects(
		() => h.facade.syncLane(lane.id, agent(a)),
		conflictWith("lane-landing"),
	);
	await rejects(
		() => h.facade.closeLane(lane.id, "x", agent(a)),
		conflictWith("lane-landing"),
	);
	throws(() =>
		h.storage.transactionSync(() =>
			h.internal.setLaneStateSync(lane.id, "closed")
		)
	);
	h.storage.transactionSync(() =>
		h.internal.setLaneStateSync(lane.id, "submitted")
	);
	h.storage.transactionSync(() =>
		h.internal.setLaneStateSync(lane.id, "landing")
	);
	h.storage.transactionSync(() =>
		h.internal.setLaneStateSync(lane.id, "landed")
	);
	await h.facade.closeLane(lane.id, "landed", KERNEL_LANE_ACTOR);
	equal((await h.facade.getLane(lane.id))?.state, "closed");
});

Deno.test("the landing freeze holds for a sync that passed its state check before LandWorkflow froze the lane", async () => {
	const h = await createHarness();
	const { agent: a } = principals(h);
	const lane = await open(h, a);
	await push(h, lane, a, sha(85));
	h.storage.transactionSync(() =>
		h.events.appendSync({
			type: "changes.submitted",
			source: { kind: "kernel" },
			actor: { kind: "agent", id: a },
			node: h.nodeId,
			repo: h.repoId,
			depth: 0,
			shadow: false,
			data: {
				changeId: "zkqvzkqvzkqvzkqvzkqvzkqvzkqvzkqv",
				laneId: lane.id,
				revision: 1,
				head: sha(85),
				base: TRUNK,
				affected: [],
			},
			idemKey: `t:submit:${h.ulid()}`,
		})
	);
	const intent = {
		target: lane.id,
		ref: lane.ref,
		expectOld: sha(85),
		newSha: sha(86),
		purpose: "lane-sync" as const,
		ownerKind: "job" as const,
		ownerId: `sync:${lane.id}`,
	};
	// The job is running (the K16 and state checks passed) when LandWorkflow
	// freezes the lane: its intent is registered after the freeze → refused.
	let registered: Promise<unknown> | null = null;
	h.gitJobs.sync = (_rid, laneId) => {
		h.storage.transactionSync(() =>
			h.internal.setLaneStateSync(laneId, "landing")
		);
		registered = h.facade.registerKernelWrite(intent);
		return registered.then(
			() => ({ ok: true as const, head: sha(86) }),
			() => ({ ok: false as const, conflicts: [] }),
		);
	};
	await h.facade.syncLane(lane.id, agent(a));
	await rejects(() => registered!, conflictWith("lane-landing"));
	equal((await h.facade.getLane(lane.id))?.head, sha(85));
	equal(h.events.ofType("lane.synced").length, 0);
	// The other order: a sync registered first blocks the freeze until it is
	// marked (or its window passes).
	h.storage.transactionSync(() =>
		h.internal.setLaneStateSync(lane.id, "submitted")
	);
	const kw = await h.facade.registerKernelWrite(intent);
	throws(
		() =>
			h.storage.transactionSync(() =>
				h.internal.setLaneStateSync(lane.id, "landing")
			),
		(e: unknown) => {
			if (!conflictWith("lane-git-job")(e)) return false;
			// Across Workers RPC only the message survives; the queue
			// provider retries this refusal by its reason (WP15).
			const wire = fromRpcError(new Error((e as Error).message));
			return wire.code === "conflict" && wire.reason === "lane-git-job";
		},
	);
	await h.facade.markKernelWrite(kw.id, "abandoned");
	h.storage.transactionSync(() =>
		h.internal.setLaneStateSync(lane.id, "landing")
	);
	equal((await h.facade.getLane(lane.id))?.state, "landing");
});

Deno.test("archive (branch: attic ref) and an Owner's purge of the lane and attic refs", async () => {
	const h = await createHarness();
	const { agent: a, user: owner } = principals(h);
	const lane = await h.facade.openLane({ owner: a, actor: agent(a) });
	h.upstream.set(h.canonical, lane.ref, sha(90));
	await push(h, lane, a, sha(90));
	const attic = `refs/tartan/attic/${lane.id}`;
	// The lane's owner may archive it.
	const result = await h.facade.archiveLane(
		lane.id,
		{ atticRef: attic },
		agent(a),
	);
	deepStrictEqual(result, { kind: "ref", ref: attic, head: sha(77) });
	const archived = await h.facade.getLane(lane.id);
	equal(archived?.state, "archived");
	equal(
		(h.events.ofType("lane.archived")[0].data as { atticRef: string }).atticRef,
		attic,
	);
	// The attic write itself (WP10) registered its intent; make it look pushed.
	const kw = await h.facade.registerKernelWrite({
		target: lane.id,
		ref: attic,
		expectOld: ZERO_SHA,
		newSha: sha(90),
		purpose: "attic",
		ownerKind: "job",
		ownerId: "archive",
	});
	h.upstream.set(h.canonical, attic, sha(90));
	await h.facade.markKernelWrite(kw.id, "pushed");
	await rejects(
		() => h.facade.purgeLane(lane.id, user(owner)),
		deniedWith("lane-op"),
	);
	h.tree.roles.set(owner, ROLE.owner);
	h.clock.advance(ROLE_CACHE_MS + 1);
	await h.facade.purgeLane(lane.id, user(owner));
	equal((await h.facade.getLane(lane.id))?.state, "deleted");
	equal(h.upstream.get(h.canonical, lane.ref), null);
	equal(h.upstream.get(h.canonical, attic), null);
	equal(
		h.storage.sql.exec("SELECT * FROM kernel_writes WHERE purpose = 'purge'")
			.toArray()
			.length,
		2,
	);
	// Purging again is a no-op.
	await h.facade.purgeLane(lane.id, user(owner));
	equal(h.events.ofType("lane.deleted").length, 1);
});

Deno.test("listLanes filters by state, owner and entity, with a cursor", async () => {
	const h = await createHarness();
	const { agent: a } = principals(h);
	const { agent: b } = principals(h);
	const created: Lane[] = [];
	for (let i = 0; i < 3; i++) created.push(await open(h, a));
	const lb = await h.facade.openLane({
		owner: b,
		actor: agent(b),
		entity: { kind: "work", id: "w1" },
	});
	await h.facade.closeLane(created[0].id, "x", agent(a));
	const page1 = await h.facade.listLanes({ owner: a, limit: 2 });
	equal(page1.lanes.length, 2);
	ok(page1.cursor !== undefined);
	const page2 = await h.facade.listLanes({
		owner: a,
		limit: 2,
		cursor: page1.cursor,
	});
	equal(page2.lanes.length, 1);
	equal(page2.cursor, undefined);
	deepStrictEqual(
		(await h.facade.listLanes({ state: ["open"] })).lanes.map((l) => l.id)
			.sort(),
		[created[1].id, created[2].id, lb.id].sort(),
	);
	deepStrictEqual(
		(await h.facade.listLanes({ entity: { kind: "work", id: "w1" } })).lanes
			.map((l) => l.id),
		[lb.id],
	);
});

Deno.test("K7 applies to open lanes only: a submitted lane is the queue's and a landing lane is frozen; land.submit refuses a quarantined lane", async () => {
	const h = await createHarness();
	const { agent: a } = principals(h);
	const submitted = await open(h, a);
	await push(h, submitted, a, sha(95));
	h.storage.sql.exec(
		"UPDATE lanes SET state = 'submitted' WHERE id = ?",
		submitted.id,
	);
	h.clock.advance(LANE_LEASE_MS * 4);
	await h.runTimers();
	equal((await h.facade.getLane(submitted.id))?.state, "submitted");
	h.storage.sql.exec(
		"UPDATE lanes SET quarantined = 1 WHERE id = ?",
		submitted.id,
	);
	throws(
		() =>
			h.storage.transactionSync(() =>
				h.internal.setLaneStateSync(submitted.id, "landing")
			),
		(e: unknown) => fromRpcError(e).code === "conflict",
	);
});
