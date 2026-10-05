// K1 and K2 (WP5a): kernel writes observed by the trigger or by reconciliation
// never raise `ref.tampered`; a foreign write to a protected ref does after the
// grace window and pauses landing; a foreign write to a lane quarantines that
// lane only; only a lane's CURRENT lane repo feeds K2; the cron finds foreign
// writes with the trigger disabled.

import {
	deepStrictEqual,
	equal,
	ok,
	rejects,
	throws,
} from "node:assert/strict";
import {
	fromRpcError,
	laneArtifactsName,
	ROLE,
	ZERO_SHA,
} from "@tartan/contract";
import type {
	AdvanceRow,
	KernelWriteIntent,
	LaneOpActor,
	PushRow,
} from "@tartan/contract/kernel.ts";
import { OBSERVE_GRACE_MS } from "./observe.ts";
import { ROLE_CACHE_MS } from "./roles.ts";
import {
	createHarness,
	fakeRepoBackend,
	type Harness,
	principals,
	sha,
	TRUNK,
} from "./testing/harness.ts";

const agentActor = (id: string): LaneOpActor => ({ kind: "agent", id });

let eventN = 0;
const trigger = (
	h: Harness,
	ref: string,
	before: string,
	after: string,
	repoName = h.canonical,
) =>
	h.facade.observePush({
		eventId: `evt-${++eventN}`,
		repoName,
		ref,
		before,
		after,
		at: h.clock.now(),
	});

const afterGrace = async (h: Harness) => {
	h.clock.advance(OBSERVE_GRACE_MS + 1);
	await h.runTimers();
};

const meta = (h: Harness, key: string) => h.internal.metaSync(key as never);

const intent = (
	h: Harness,
	partial:
		& Partial<KernelWriteIntent>
		& Pick<KernelWriteIntent, "ref" | "newSha" | "purpose">,
) =>
	h.facade.registerKernelWrite({
		target: "repo",
		expectOld: ZERO_SHA,
		ownerKind: "land",
		ownerId: "land-x",
		...partial,
	});

Deno.test("K1: kernel writes seen by the trigger never raise ref.tampered (trigger before completeAdvance, duplicates, candidate, notes retry, change ref, attic, lane-gc, lane-sync)", async () => {
	const h = await createHarness();
	const { agent } = principals(h);
	const lane = await h.facade.openLane({
		owner: agent,
		actor: agentActor(agent),
	});
	// The owner pushed the lane (head H1).
	const H1 = sha(100);
	await h.facade.recordPush({
		target: lane.id,
		refs: [{ ref: lane.ref, before: ZERO_SHA, after: H1 }],
		principal: agent,
		via: "gateway",
		requestId: "g1",
	});

	// Trunk: intent registered at restack-n, the trigger arrives before the
	// workflow marks it pushed and before completeAdvance.
	const T1 = sha(101);
	const trunk = await intent(h, {
		ref: "refs/heads/main",
		expectOld: TRUNK,
		newSha: T1,
		purpose: "trunk",
	});
	await trigger(h, "refs/heads/main", TRUNK, T1);
	// The same event redelivered, and a second event id for the same update.
	await h.facade.observePush({
		eventId: `evt-${eventN}`,
		repoName: h.canonical,
		ref: "refs/heads/main",
		before: TRUNK,
		after: T1,
		at: h.clock.now(),
	});
	await trigger(h, "refs/heads/main", TRUNK, T1);
	await h.facade.markKernelWrite(trunk.id, "pushed");
	h.storage.transactionSync(() => h.internal.applyKernelWriteSync(trunk.id));

	// A candidate, a notes push whose first intent was superseded (it landed
	// anyway), a change ref and an attic ref.
	const C = sha(102);
	const candidateRef = "refs/tartan/candidates/01k6c0ffee0000000000000000";
	await intent(h, { ref: candidateRef, newSha: C, purpose: "candidate" });
	const n1 = await intent(h, {
		ref: "refs/notes/tartan",
		newSha: sha(103),
		purpose: "notes",
	});
	await intent(h, {
		ref: "refs/notes/tartan",
		expectOld: sha(110),
		newSha: sha(104),
		purpose: "notes",
		supersedes: n1.id,
	});
	const changeRef = "refs/tartan/changes/zkqvzkqvzkqvzkqvzkqvzkqvzkqvzkqv";
	await intent(h, { ref: changeRef, newSha: H1, purpose: "change-ref" });
	const atticRef = "refs/tartan/attic/ln_01k6c0ffee0000000000000000";
	await intent(h, {
		target: lane.id,
		ref: atticRef,
		newSha: H1,
		purpose: "attic",
		ownerKind: "job",
	});
	await trigger(h, candidateRef, ZERO_SHA, C);
	await trigger(h, "refs/notes/tartan", ZERO_SHA, sha(103));
	await trigger(h, "refs/notes/tartan", sha(103), sha(104));
	await trigger(h, changeRef, ZERO_SHA, H1);
	await trigger(h, atticRef, ZERO_SHA, H1);

	// lane-sync (head H1 → H2) by a kernel job, then lane-gc after close.
	const H2 = sha(105);
	await intent(h, {
		target: lane.id,
		ref: lane.ref,
		expectOld: H1,
		newSha: H2,
		purpose: "lane-sync",
		ownerKind: "job",
	});
	await trigger(h, lane.ref, H1, H2);
	equal((await h.facade.getLane(lane.id))?.head, H2, "lane-sync applied");
	await intent(h, {
		target: lane.id,
		ref: lane.ref,
		expectOld: H2,
		newSha: ZERO_SHA,
		purpose: "lane-gc",
		ownerKind: "kernel",
	});
	await trigger(h, lane.ref, H2, ZERO_SHA);

	await afterGrace(h);
	await afterGrace(h);
	deepStrictEqual(h.events.ofType("ref.tampered"), []);
	equal(meta(h, "landing_paused"), "0");
	equal(
		h.storage.sql.exec("SELECT * FROM pending_observations").toArray().length,
		0,
	);
	equal(meta(h, "trunk_sha"), T1);
	equal((await h.facade.getLane(lane.id))?.quarantined, false);
	// One push row per transition; the trunk row is attributed to the kernel.
	const trunkRows = h.storage.sql.exec<PushRow>(
		"SELECT * FROM pushes WHERE ref = 'refs/heads/main'",
	).toArray();
	equal(trunkRows.length, 1);
	equal(trunkRows[0].via, "kernel");
	equal(trunkRows[0].kernel_write_id, trunk.id);
});

Deno.test("K1: a foreign write to main is parked, raises ref.tampered after the grace window and pauses landing; an Owner ack adopts it", async () => {
	const h = await createHarness();
	const { user } = principals(h);
	const X = sha(200);
	h.upstream.set(h.canonical, "refs/heads/main", X);
	await trigger(h, "refs/heads/main", TRUNK, X);
	h.clock.advance(OBSERVE_GRACE_MS - 1000);
	await h.runTimers();
	deepStrictEqual(
		h.events.ofType("ref.tampered"),
		[],
		"not before the grace window",
	);
	await afterGrace(h);
	const [tampered] = h.events.ofType("ref.tampered");
	deepStrictEqual(
		{ ...(tampered.data as Record<string, unknown>), parkedAt: 0 },
		{
			target: "repo",
			ref: "refs/heads/main",
			before: TRUNK,
			after: X,
			source: "trigger",
			parkedAt: 0,
		},
	);
	equal(meta(h, "landing_paused"), "1");
	equal(meta(h, "drifted"), "1");
	equal(meta(h, "trunk_sha"), TRUNK, "the unexplained value is never adopted");
	equal((await h.facade.info()).landingPaused, true);

	await rejects(
		() => h.facade.ackTampered(user),
		(e: unknown) => fromRpcError(e).code === "denied",
	);
	h.tree.roles.set(user, ROLE.owner);
	h.clock.advance(ROLE_CACHE_MS + 1);
	await h.facade.ackTampered(user);
	equal(meta(h, "landing_paused"), "0");
	equal(meta(h, "drifted"), "0");
	equal(meta(h, "trunk_sha"), X);
	equal(h.events.ofType("ref.reconciled").length, 1);
});

Deno.test("explains() and K1 deferral match only an exact new_sha (open intents, un-completed Advances)", async () => {
	const h = await createHarness();
	const explains = (ref: string, value: string) =>
		h.storage.transactionSync(() => h.internal.explainsSync(ref, value));
	const kw = await intent(h, {
		ref: "refs/heads/main",
		expectOld: TRUNK,
		newSha: sha(300),
		purpose: "trunk",
	});
	equal(explains("refs/heads/main", sha(300)), true);
	equal(explains("refs/heads/main", sha(301)), false, "another sha");
	equal(explains("refs/heads/other", sha(300)), false, "another ref");
	await h.facade.markKernelWrite(kw.id, "observed");
	equal(explains("refs/heads/main", sha(300)), false, "no longer open");
	h.land.inflight.set("refs/heads/main", {
		id: "adv_x_1",
		new_sha: sha(302),
	} as AdvanceRow);
	equal(explains("refs/heads/main", sha(302)), true, "an un-completed Advance");
	// An observation equal to the in-flight Advance's new_sha is explained,
	// also when a second event reports it again…
	await trigger(h, "refs/heads/main", sha(300), sha(302));
	await trigger(h, "refs/heads/main", sha(300), sha(302));
	// …one that differs is not.
	await trigger(h, "refs/heads/main", sha(302), sha(303));
	await afterGrace(h);
	const tampered = h.events.ofType("ref.tampered");
	equal(tampered.length, 1);
	equal((tampered[0].data as { after: string }).after, sha(303));
});

Deno.test("K2: a foreign write to a lane quarantines that lane only; landing elsewhere continues; the owner's next push or an Owner ack clears it", async () => {
	const h = await createHarness();
	const { agent, user } = principals(h);
	const lane = await h.facade.openLane({
		owner: agent,
		actor: agentActor(agent),
	});
	const other = await h.facade.openLane({
		owner: agent,
		actor: agentActor(agent),
	});
	const H1 = sha(400);
	await h.facade.recordPush({
		target: lane.id,
		refs: [{ ref: lane.ref, before: ZERO_SHA, after: H1 }],
		principal: agent,
		via: "gateway",
		requestId: "g1",
	});
	const F = sha(401);
	await trigger(h, lane.ref, H1, F);
	await afterGrace(h);
	const [tampered] = h.events.ofType("ref.tampered");
	equal((tampered.data as { laneId: string }).laneId, lane.id);
	const quarantined = await h.facade.getLane(lane.id);
	equal(quarantined?.quarantined, true);
	equal(quarantined?.head, F, "the head is what the lane ref holds now");
	equal((await h.facade.getLane(other.id))?.quarantined, false);
	equal(meta(h, "landing_paused"), "0", "landing elsewhere is not paused");

	// changes_submit and land.submit refuse a quarantined lane.
	throws(
		() =>
			h.storage.transactionSync(() =>
				h.events.appendSync({
					type: "changes.submitted",
					source: { kind: "kernel" },
					actor: { kind: "agent", id: agent },
					node: h.nodeId,
					repo: h.repoId,
					depth: 0,
					shadow: false,
					data: {
						changeId: "zkqvzkqvzkqvzkqvzkqvzkqvzkqvzkqv",
						laneId: lane.id,
						revision: 1,
						head: F,
						base: TRUNK,
						affected: [],
					},
					idemKey: "x:submit:1",
				})
			),
		(e: unknown) => fromRpcError(e).code === "conflict",
	);
	equal(
		h.events.ofType("changes.submitted").length,
		0,
		"the append rolled back",
	);
	await h.facade.archiveLane(lane.id, {}, agentActor(agent)).then(
		() => ok(false, "archive must refuse"),
		(e: unknown) => equal(fromRpcError(e).code, "conflict"),
	);

	// The owner's next gateway push re-attributes the head.
	await h.facade.recordPush({
		target: lane.id,
		refs: [{ ref: lane.ref, before: F, after: sha(402) }],
		principal: agent,
		via: "gateway",
		requestId: "g2",
	});
	equal((await h.facade.getLane(lane.id))?.quarantined, false);

	// Another foreign write, then an Owner acknowledges.
	await trigger(h, lane.ref, sha(402), sha(403));
	await afterGrace(h);
	equal((await h.facade.getLane(lane.id))?.quarantined, true);
	await rejects(
		() => h.facade.ackQuarantine(lane.id, { kind: "user", id: user }),
		(e: unknown) => fromRpcError(e).code === "denied",
	);
	h.tree.roles.set(user, ROLE.owner);
	h.clock.advance(ROLE_CACHE_MS + 1);
	await h.facade.ackQuarantine(lane.id, { kind: "user", id: user });
	equal((await h.facade.getLane(lane.id))?.quarantined, false);
});

Deno.test("with the trigger disabled, the cron's reconciliation finds a foreign lane write (K2) and a foreign main write (K1)", async () => {
	const h = await createHarness();
	const { agent } = principals(h);
	const lane = await h.facade.openLane({
		owner: agent,
		actor: agentActor(agent),
	});
	const H1 = sha(500);
	h.upstream.set(h.canonical, lane.ref, H1);
	await h.facade.recordPush({
		target: lane.id,
		refs: [{ ref: lane.ref, before: ZERO_SHA, after: H1 }],
		principal: agent,
		via: "gateway",
		requestId: "g1",
	});
	// Foreign writes straight to Artifacts; no trigger event arrives.
	h.upstream.set(h.canonical, lane.ref, sha(501));
	h.upstream.set(h.canonical, "refs/heads/main", sha(502));
	const { changed } = await h.facade.reconcile();
	deepStrictEqual(changed.sort(), ["refs/heads/main", lane.ref].sort());
	await afterGrace(h);
	const tampered = h.events.ofType("ref.tampered").map((e) =>
		e.data as { ref: string; source: string; laneId?: string }
	);
	deepStrictEqual(
		tampered.map((t) => [t.ref, t.source, t.laneId ?? null]).sort(),
		[
			["refs/heads/main", "reconcile", null],
			[lane.ref, "reconcile", lane.id],
		].sort(),
	);
	equal((await h.facade.getLane(lane.id))?.quarantined, true);
	equal(meta(h, "landing_paused"), "1");
});

Deno.test("reconciliation of a repo with 1,000 lane refs reads only the prefixes it needs", async () => {
	const h = await createHarness();
	for (let i = 0; i < 1000; i++) {
		h.upstream.set(
			h.canonical,
			`refs/heads/lanes/ln_01k6c0ffee${String(i).padStart(16, "0")}`,
			sha(600 + i),
		);
	}
	h.tree.protected = ["refs/heads/release/*"];
	await h.facade.reconcile();
	const [call] = h.upstream.lsRefsCalls;
	deepStrictEqual([...call.prefixes].sort(), [
		"refs/heads/main",
		"refs/heads/release/",
		"refs/notes/tartan",
		"refs/tartan/",
	]);
	ok(!call.prefixes.includes("refs/heads/"));
	// With an active branch lane the lane namespace is read, still not all heads.
	const { agent } = principals(h);
	await h.facade.openLane({ owner: agent, actor: agentActor(agent) });
	h.upstream.lsRefsCalls.length = 0;
	await h.facade.reconcile();
	ok(h.upstream.lsRefsCalls[0].prefixes.includes("refs/heads/lanes/"));
	ok(!h.upstream.lsRefsCalls[0].prefixes.includes("refs/heads/"));
});

Deno.test("only the lane's CURRENT lane repo feeds K2; an uppercase name maps; other l-* names are orphans; the seed is explained", async () => {
	const record = { started: [] as string[] };
	const h = await createHarness({
		laneMode: "import",
		createRepoBackend: fakeRepoBackend(record),
	});
	const { agent } = principals(h);
	const lane = await h.facade.openLane({
		owner: agent,
		actor: agentActor(agent),
	});
	equal(lane.state, "opening");
	const current = laneArtifactsName(h.repoId, lane.id.slice(3), 1);
	const superseded = laneArtifactsName(h.repoId, lane.id.slice(3), 2);
	// A trigger event from another attempt's repo (or a swept one) is ignored.
	await trigger(h, "refs/heads/main", ZERO_SHA, sha(700), superseded);
	await trigger(
		h,
		"refs/heads/evil",
		ZERO_SHA,
		sha(701),
		superseded.toUpperCase(),
	);
	// The seed's own event (if the import fires one) matches its lane-seed intent.
	await trigger(h, "refs/heads/main", ZERO_SHA, TRUNK, current.toUpperCase());
	await afterGrace(h);
	deepStrictEqual(h.events.ofType("ref.tampered"), []);
	equal((await h.facade.getLane(lane.id))?.quarantined, false);
	ok(h.logs.some((l) => l.data.why === "orphan lane repo"));
	// A foreign ref in the lane's current repo quarantines it.
	await trigger(h, "refs/tags/x", ZERO_SHA, sha(702), current);
	await afterGrace(h);
	const [tampered] = h.events.ofType("ref.tampered");
	equal((tampered.data as { laneId: string }).laneId, lane.id);
	equal((tampered.data as { target: string }).target, lane.id);
	equal((await h.facade.getLane(lane.id))?.quarantined, true);
});

Deno.test("late trigger events of a deleted lane are ignored", async () => {
	const h = await createHarness();
	const { agent } = principals(h);
	const lane = await h.facade.openLane({
		owner: agent,
		actor: agentActor(agent),
	});
	await h.facade.recordPush({
		target: lane.id,
		refs: [{ ref: lane.ref, before: ZERO_SHA, after: sha(800) }],
		principal: agent,
		via: "gateway",
		requestId: "g1",
	});
	h.storage.sql.exec(
		"UPDATE lanes SET state = 'deleted' WHERE id = ?",
		lane.id,
	);
	h.clock.advance(60 * 60 * 1000);
	// The push's own event, an hour late, and a late delete.
	await trigger(h, lane.ref, ZERO_SHA, sha(800));
	await trigger(h, lane.ref, sha(800), ZERO_SHA);
	await afterGrace(h);
	deepStrictEqual(h.events.ofType("ref.tampered"), []);
	equal((await h.facade.getLane(lane.id))?.quarantined, false);
	// A new value nobody pushed is still a foreign write.
	await trigger(h, lane.ref, ZERO_SHA, sha(801));
	await afterGrace(h);
	equal(h.events.ofType("ref.tampered").length, 1);
});

Deno.test("observeSync (WP5b's lane-repo reconciliation) ignores names other than the lane's current repo", async () => {
	const h = await createHarness({
		laneMode: "import",
		createRepoBackend: fakeRepoBackend(),
	});
	const { agent } = principals(h);
	const lane = await h.facade.openLane({
		owner: agent,
		actor: agentActor(agent),
	});
	const current = laneArtifactsName(h.repoId, lane.id.slice(3), 1);
	h.storage.transactionSync(() => {
		h.internal.observeSync({
			target: lane.id,
			repoName: laneArtifactsName(h.repoId, lane.id.slice(3), 3),
			ref: "refs/heads/main",
			before: ZERO_SHA,
			after: sha(900),
		});
		h.internal.observeSync({
			target: lane.id,
			repoName: current,
			ref: "refs/heads/other",
			before: ZERO_SHA,
			after: sha(901),
		});
	});
	const parked = h.storage.sql.exec<{ repo_name: string; lane_id: string }>(
		"SELECT repo_name, lane_id FROM pending_observations",
	).toArray();
	deepStrictEqual(parked, [{ repo_name: current, lane_id: lane.id }]);
});

Deno.test("K1: an unexplained mismatch the cron keeps seeing is reported once, until an Owner acknowledges", async () => {
	const h = await createHarness();
	h.upstream.set(h.canonical, "refs/heads/main", sha(950));
	for (let run = 0; run < 3; run++) {
		// An idle repo is reconciled once a day: step past that each run.
		h.clock.advance(24 * 60 * 60 * 1000 + 1);
		const { changed } = await h.facade.reconcile();
		deepStrictEqual(changed, ["refs/heads/main"]);
		await afterGrace(h);
	}
	equal(h.events.ofType("ref.reconciled").length, 3);
	equal(h.events.ofType("ref.tampered").length, 1);
	equal(meta(h, "trunk_sha"), TRUNK);
	equal(
		h.storage.sql.exec("SELECT * FROM pending_observations").toArray().length,
		1,
	);
});

// ---------------------------------------------------------------------------
// Reconciliation and parked observations race attributed
// pushes. None of these may quarantine a lane or move its head backwards.
// ---------------------------------------------------------------------------

const lanePush = (
	h: Harness,
	laneId: string,
	ref: string,
	principal: string,
	before: string,
	after: string,
	requestId: string,
) => {
	h.upstream.set(h.canonical, ref, after);
	return h.facade.recordPush({
		target: laneId,
		refs: [{ ref, before, after }],
		principal,
		via: "gateway",
		requestId,
	});
};

const pendingCount = (h: Harness) =>
	h.storage.sql.exec("SELECT * FROM pending_observations").toArray().length;

Deno.test("a cron reconcile whose ls-refs answer predates an owner push neither quarantines the lane nor moves its head back", async () => {
	const h = await createHarness();
	const { agent } = principals(h);
	const lane = await h.facade.openLane({
		owner: agent,
		actor: agentActor(agent),
	});
	const H1 = sha(1100);
	const H2 = sha(1101);
	await lanePush(h, lane.id, lane.ref, agent, ZERO_SHA, H1, "g1");
	// ls-refs reads H1; the owner's push H1→H2 is recorded before it returns.
	h.upstream.inFlight = async () => {
		await lanePush(h, lane.id, lane.ref, agent, H1, H2, "g2");
	};
	const { changed } = await h.facade.reconcile();
	deepStrictEqual(changed, [], "a ref written during ls-refs is not compared");
	equal(pendingCount(h), 0);
	await afterGrace(h);
	await afterGrace(h);
	deepStrictEqual(h.events.ofType("ref.tampered"), []);
	const after = await h.facade.getLane(lane.id);
	equal(after?.quarantined, false);
	equal(after?.head, H2);
	equal(h.internal.refSync(lane.ref)?.sha, H2);
	// The next run sees agreement.
	deepStrictEqual((await h.facade.reconcile()).changed, []);
});

Deno.test("an observation that recorded pushes superseded (a stale ls-refs answer, a late trigger) is explained, never raised or applied", async () => {
	const h = await createHarness();
	const { agent } = principals(h);
	const lane = await h.facade.openLane({
		owner: agent,
		actor: agentActor(agent),
	});
	const H1 = sha(1110);
	const H2 = sha(1111);
	await lanePush(h, lane.id, lane.ref, agent, ZERO_SHA, H1, "g1");
	await lanePush(h, lane.id, lane.ref, agent, H1, H2, "g2");
	// A reconciliation that read H1 after H1→H2 was recorded.
	h.storage.transactionSync(() =>
		h.internal.observeSync({
			target: lane.id,
			repoName: null,
			ref: lane.ref,
			before: H2,
			after: H1,
		})
	);
	equal(pendingCount(h), 0, "a stale H2→H1 is explained at once");
	// The trigger of 0→H1, delivered after the merge window.
	h.clock.advance(11 * 60 * 1000);
	await trigger(h, lane.ref, ZERO_SHA, H1);
	equal(pendingCount(h), 0, "a late trigger is explained at once");
	// Parked first, superseded later: upstream holds H3 that no push recorded
	// yet (H2→H3 parked), then the owner's push H3→H4 is recorded.
	const H3 = sha(1112);
	const H4 = sha(1113);
	h.upstream.set(h.canonical, lane.ref, H3);
	deepStrictEqual((await h.facade.reconcile()).changed, [lane.ref]);
	equal(pendingCount(h), 1);
	await lanePush(h, lane.id, lane.ref, agent, H3, H4, "g3");
	await h.settle();
	await afterGrace(h);
	await afterGrace(h);
	equal(pendingCount(h), 0);
	deepStrictEqual(h.events.ofType("ref.tampered"), []);
	const after = await h.facade.getLane(lane.id);
	equal(after?.quarantined, false);
	equal(after?.head, H4);
	equal(h.internal.refSync(lane.ref)?.sha, H4);
});

Deno.test("upstream moved A→B→C before the gateway recorded either push: the parked A→C is explained by the recorded chain", async () => {
	const h = await createHarness();
	const { agent } = principals(h);
	const lane = await h.facade.openLane({
		owner: agent,
		actor: agentActor(agent),
	});
	const A = sha(1120);
	const B = sha(1121);
	const C = sha(1122);
	await lanePush(h, lane.id, lane.ref, agent, ZERO_SHA, A, "g1");
	h.upstream.set(h.canonical, lane.ref, C);
	deepStrictEqual((await h.facade.reconcile()).changed, [lane.ref]);
	equal(pendingCount(h), 1, "A→C is parked");
	await lanePush(h, lane.id, lane.ref, agent, A, B, "g2");
	await lanePush(h, lane.id, lane.ref, agent, B, C, "g3");
	await afterGrace(h);
	await afterGrace(h);
	deepStrictEqual(h.events.ofType("ref.tampered"), []);
	equal(pendingCount(h), 0);
	const after = await h.facade.getLane(lane.id);
	equal(after?.quarantined, false);
	equal(after?.head, C);
});

Deno.test("a merged observation repairs an index and lane head that fell behind the latest recorded push, and never reverts a later one", async () => {
	const h = await createHarness();
	const { agent } = principals(h);
	const lane = await h.facade.openLane({
		owner: agent,
		actor: agentActor(agent),
	});
	const H1 = sha(1130);
	const H2 = sha(1131);
	await lanePush(h, lane.id, lane.ref, agent, ZERO_SHA, H1, "g1");
	await lanePush(h, lane.id, lane.ref, agent, H1, H2, "g2");
	// The state an earlier bug left: index and head back at H1.
	h.storage.sql.exec("UPDATE lanes SET head_sha = ? WHERE id = ?", H1, lane.id);
	h.storage.sql.exec("UPDATE refs SET sha = ? WHERE ref = ?", H1, lane.ref);
	await trigger(h, lane.ref, H1, H2);
	equal((await h.facade.getLane(lane.id))?.head, H2);
	equal(h.internal.refSync(lane.ref)?.sha, H2);
	// A→B, B→A recorded; a trigger for the first A→B merges, the index stays A.
	await lanePush(h, lane.id, lane.ref, agent, H2, H1, "g3");
	await trigger(h, lane.ref, ZERO_SHA, H1);
	equal((await h.facade.getLane(lane.id))?.head, H1);
	equal(h.internal.refSync(lane.ref)?.sha, H1);
	deepStrictEqual(h.events.ofType("ref.tampered"), []);
});

Deno.test("ackTampered acknowledges only the tampered refs it read; one raised during its upstream read stays and keeps landing paused", async () => {
	const h = await createHarness();
	const { user } = principals(h);
	h.tree.roles.set(user, ROLE.owner);
	const X = sha(1200);
	h.upstream.set(h.canonical, "refs/heads/main", X);
	await trigger(h, "refs/heads/main", TRUNK, X);
	await afterGrace(h);
	equal(meta(h, "landing_paused"), "1");
	// While the acknowledgement reads upstream, another foreign write is
	// raised (the observe timer marked it tampered).
	const candidate = "refs/tartan/candidates/01k6c0ffee0000000000000001";
	h.upstream.inFlight = () => {
		h.storage.sql.exec(
			`INSERT INTO pending_observations (id, target, repo_name, ref, before, after, source,
			   lane_id, observed_at, recheck_at, checks, tampered_at)
			 VALUES ('ob_late', 'repo', NULL, ?, ?, ?, 'trigger', NULL, ?, ?, 1, ?)`,
			candidate,
			ZERO_SHA,
			sha(1201),
			h.clock.now(),
			h.clock.now(),
			h.clock.now(),
		);
		return Promise.resolve();
	};
	await h.facade.ackTampered(user);
	equal(meta(h, "trunk_sha"), X, "the acknowledged ref is adopted");
	equal(h.internal.refSync(candidate), null, "the late one is not");
	deepStrictEqual(
		h.storage.sql.exec<{ id: string }>("SELECT id FROM pending_observations")
			.toArray().map((r) => r.id),
		["ob_late"],
	);
	equal(meta(h, "landing_paused"), "1");
	equal(meta(h, "drifted"), "1");
	const [ack] = h.events.ofType("ref.acknowledged");
	deepStrictEqual(ack.data, {
		refs: ["refs/heads/main"],
		landingPaused: true,
	});
	deepStrictEqual(ack.actor, { kind: "user", id: user });
	// A second acknowledgement adopts the late one and resumes landing.
	await h.facade.ackTampered(user);
	equal(meta(h, "landing_paused"), "0");
	equal(
		(h.events.ofType("ref.acknowledged")[1].data as { landingPaused: boolean })
			.landingPaused,
		false,
	);
});

Deno.test("K3: an Owner's acknowledgement of a quarantined lane appends ref.acknowledged in the same transaction", async () => {
	const h = await createHarness();
	const { agent, user } = principals(h);
	h.tree.roles.set(user, ROLE.owner);
	const lane = await h.facade.openLane({
		owner: agent,
		actor: agentActor(agent),
	});
	await lanePush(h, lane.id, lane.ref, agent, ZERO_SHA, sha(1300), "g1");
	await trigger(h, lane.ref, sha(1300), sha(1301));
	await afterGrace(h);
	equal((await h.facade.getLane(lane.id))?.quarantined, true);
	await h.facade.ackQuarantine(lane.id, { kind: "user", id: user });
	equal((await h.facade.getLane(lane.id))?.quarantined, false);
	const acks = h.events.ofType("ref.acknowledged");
	equal(acks.length, 1);
	deepStrictEqual(acks[0].data, { laneId: lane.id });
	deepStrictEqual(acks[0].actor, { kind: "user", id: user });
	deepStrictEqual(acks[0].subject, { kind: "lane", id: lane.id });
	// Acknowledging a lane with nothing to clear changes nothing and appends nothing.
	await h.facade.ackQuarantine(lane.id, { kind: "user", id: user });
	equal(h.events.ofType("ref.acknowledged").length, 1);
});
