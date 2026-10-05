// Two-phase push recording (WP5a; K17): the gateway/trigger merge in
// both orders, repeat transitions, out-of-order canonical records, phase 1
// without binding reads, phase 2 by the `diff` timer backstop, `recordDiff` and
// `laneRange`.

import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { fromRpcError, laneArtifactsName, ZERO_SHA } from "@tartan/contract";
import type { LaneOpActor, PushRow } from "@tartan/contract/kernel.ts";
import { DIFF_BACKSTOP_MS } from "../../constants.ts";
import { DIFF_GIVE_UP_MS } from "./pushes.ts";
import {
	createHarness,
	fakeRepoBackend,
	type Harness,
	principals,
	sha,
	TRUNK,
} from "./testing/harness.ts";

const pushRows = (h: Harness): PushRow[] =>
	h.storage.sql.exec<PushRow>("SELECT * FROM pushes ORDER BY at, id").toArray();

const indexOf = (h: Harness, ref: string): string | null =>
	h.storage.sql.exec<{ sha: string }>("SELECT sha FROM refs WHERE ref = ?", ref)
		.toArray()[0]?.sha ?? null;

const agentActor = (id: string): LaneOpActor => ({ kind: "agent", id });

const openBranchLane = async (h: Harness, owner: string) =>
	await h.facade.openLane({ owner, actor: agentActor(owner) });

Deno.test("phase 1 is I/O-free: no binding or probe call, one row and one slim push.accepted per ref", async () => {
	const h = await createHarness();
	const { user } = principals(h);
	h.artifactsCalls.length = 0;
	const result = await h.facade.recordPush({
		target: "repo",
		refs: [
			{ ref: "refs/heads/feat-a", before: ZERO_SHA, after: sha(10) },
			{ ref: "refs/tags/v1", before: ZERO_SHA, after: sha(11) },
		],
		principal: user,
		via: "gateway",
		requestId: "req-1",
		bytes: 1234,
	});
	deepStrictEqual(h.artifactsCalls, []);
	deepStrictEqual(h.probeCalls, []);
	equal(result.pushIds.length, 2);
	equal(result.events.length, 2);
	for (const event of result.events) {
		equal(event.type, "push.accepted");
		deepStrictEqual(Object.keys(event.data as object).sort(), [
			"after",
			"before",
			"pushId",
			"ref",
			"target",
			"via",
		]);
	}
	equal(indexOf(h, "refs/heads/feat-a"), sha(10));
	const rows = pushRows(h);
	deepStrictEqual(rows.map((r) => [r.ref, r.diff_state]), [
		["refs/heads/feat-a", "pending"],
		["refs/tags/v1", "skipped"],
	]);
	equal(rows[0].bytes, 1234);
	equal(rows[0].principal_id, user);
	// The diff backstop is armed.
	ok(h.timers.get("core", "diff") !== null);
});

Deno.test("a repeated report (same request id) is a no-op", async () => {
	const h = await createHarness();
	const { user } = principals(h);
	const report = {
		target: "repo",
		refs: [{ ref: "refs/heads/feat", before: ZERO_SHA, after: sha(10) }],
		principal: user,
		via: "gateway" as const,
		requestId: "req-1",
	};
	const first = await h.facade.recordPush(report);
	const again = await h.facade.recordPush(report);
	deepStrictEqual(again.pushIds, first.pushIds);
	deepStrictEqual(again.eventIds, first.eventIds);
	equal(pushRows(h).length, 1);
	equal(h.events.ofType("push.accepted").length, 1);
});

Deno.test("gateway then trigger: one row, gateway attribution, one push.accepted", async () => {
	const h = await createHarness();
	const { user } = principals(h);
	await h.facade.recordPush({
		target: "repo",
		refs: [{ ref: "refs/heads/feat", before: ZERO_SHA, after: sha(10) }],
		principal: user,
		via: "gateway",
		requestId: "req-1",
	});
	await h.facade.observePush({
		eventId: "evt-1",
		repoName: h.canonical,
		ref: "refs/heads/feat",
		before: ZERO_SHA,
		after: sha(10),
		at: h.clock.now(),
	});
	const rows = pushRows(h);
	equal(rows.length, 1);
	equal(rows[0].via, "gateway");
	equal(rows[0].principal_id, user);
	ok(rows[0].seen_via_json.includes("trigger"));
	equal(h.events.ofType("push.accepted").length, 1);
});

Deno.test("trigger then gateway: one row, the gateway's attribution wins", async () => {
	const h = await createHarness();
	const { user } = principals(h);
	await h.facade.observePush({
		eventId: "evt-1",
		repoName: h.canonical,
		ref: "refs/heads/feat",
		before: ZERO_SHA,
		after: sha(10),
		at: h.clock.now(),
	});
	let rows = pushRows(h);
	equal(rows.length, 1);
	equal(rows[0].via, "trigger");
	equal(rows[0].principal_id, null);
	const result = await h.facade.recordPush({
		target: "repo",
		refs: [{ ref: "refs/heads/feat", before: ZERO_SHA, after: sha(10) }],
		principal: user,
		tokenId: "tok_1",
		via: "gateway",
		requestId: "req-1",
	});
	rows = pushRows(h);
	equal(rows.length, 1);
	equal(rows[0].via, "gateway");
	equal(rows[0].principal_id, user);
	equal(rows[0].token_id, "tok_1");
	equal(rows[0].request_id, "req-1");
	ok(rows[0].seen_via_json.includes("trigger"));
	equal(h.events.ofType("push.accepted").length, 1);
	equal(result.events[0].type, "push.accepted");
	// A replay of the trigger event changes nothing.
	await h.facade.observePush({
		eventId: "evt-1",
		repoName: h.canonical,
		ref: "refs/heads/feat",
		before: ZERO_SHA,
		after: sha(10),
		at: h.clock.now(),
	});
	equal(pushRows(h).length, 1);
});

Deno.test("trigger then gateway on a lane head: parked, then explained by the gateway record (no K2)", async () => {
	const h = await createHarness();
	const { agent } = principals(h);
	const lane = await openBranchLane(h, agent);
	await h.facade.observePush({
		eventId: "evt-1",
		repoName: h.canonical.toUpperCase(),
		ref: lane.ref,
		before: ZERO_SHA,
		after: sha(20),
		at: h.clock.now(),
	});
	equal(
		h.storage.sql.exec("SELECT * FROM pending_observations").toArray().length,
		1,
	);
	await h.facade.recordPush({
		target: lane.id,
		refs: [{ ref: lane.ref, before: ZERO_SHA, after: sha(20) }],
		principal: agent,
		via: "gateway",
		requestId: "req-1",
	});
	equal(
		h.storage.sql.exec("SELECT * FROM pending_observations").toArray().length,
		0,
	);
	h.clock.advance(10 * 60 * 1000);
	await h.runTimers();
	deepStrictEqual(h.events.ofType("ref.tampered"), []);
	const after = await h.facade.getLane(lane.id);
	equal(after?.head, sha(20));
	equal(after?.quarantined, false);
	equal(after?.pushes, 1);
	equal(pushRows(h).length, 1);
	equal(pushRows(h)[0].principal_id, agent);
});

Deno.test("A→B, B→A, A→B yields three rows and three push.accepted; triggers merge one each", async () => {
	const h = await createHarness();
	const { user } = principals(h);
	const A = sha(30);
	const B = sha(31);
	const steps: [string, string][] = [[A, B], [B, A], [A, B]];
	let n = 0;
	await h.facade.recordPush({
		target: "repo",
		refs: [{ ref: "refs/heads/x", before: ZERO_SHA, after: A }],
		principal: user,
		via: "gateway",
		requestId: "req-0",
	});
	for (const [before, after] of steps) {
		n++;
		await h.facade.recordPush({
			target: "repo",
			refs: [{ ref: "refs/heads/x", before, after }],
			principal: user,
			via: "gateway",
			requestId: `req-${n}`,
		});
	}
	n = 0;
	for (const [before, after] of steps) {
		n++;
		await h.facade.observePush({
			eventId: `evt-${n}`,
			repoName: h.canonical,
			ref: "refs/heads/x",
			before,
			after,
			at: h.clock.now(),
		});
	}
	const rows = pushRows(h).filter((r) => r.before !== ZERO_SHA);
	equal(rows.length, 3);
	for (const row of rows) {
		equal(row.via, "gateway");
		ok(row.seen_via_json.includes("trigger"), row.id);
	}
	equal(h.events.ofType("push.accepted").length, 4);
	equal(indexOf(h, "refs/heads/x"), B);
});

Deno.test("out-of-order canonical records never regress the index; a CAS miss reconciles from ls-refs", async () => {
	const h = await createHarness();
	const { user } = principals(h);
	const A = sha(40);
	const B = sha(41);
	const C = sha(42);
	await h.facade.recordPush({
		target: "repo",
		refs: [{ ref: "refs/heads/y", before: ZERO_SHA, after: A }],
		principal: user,
		via: "gateway",
		requestId: "r0",
	});
	// The report of the later push (B→C) arrives before the earlier one (A→B).
	h.upstream.set(h.canonical, "refs/heads/y", C);
	const later = await h.facade.recordPush({
		target: "repo",
		refs: [{ ref: "refs/heads/y", before: B, after: C }],
		principal: user,
		via: "gateway",
		requestId: "r2",
	});
	deepStrictEqual(later.reconciled, ["refs/heads/y"]);
	equal(indexOf(h, "refs/heads/y"), C);
	const earlier = await h.facade.recordPush({
		target: "repo",
		refs: [{ ref: "refs/heads/y", before: A, after: B }],
		principal: user,
		via: "gateway",
		requestId: "r1",
	});
	deepStrictEqual(earlier.reconciled, []);
	equal(
		indexOf(h, "refs/heads/y"),
		C,
		"the older report does not regress the index",
	);
	await h.settle();
	// The miss reconciled exactly that ref, and upstream agrees.
	ok(
		h.upstream.lsRefsCalls.some((c) =>
			c.repo === h.canonical && c.prefixes.length === 1 &&
			c.prefixes[0] === "refs/heads/y"
		),
	);
	equal(indexOf(h, "refs/heads/y"), C);
	deepStrictEqual(h.events.ofType("ref.tampered"), []);
});

Deno.test("a killed phase 2 is completed by the diff timer; recordDiff is idempotent", async () => {
	const h = await createHarness();
	const { agent } = principals(h);
	const lane = await openBranchLane(h, agent);
	const pushed = await h.facade.recordPush({
		target: lane.id,
		refs: [{ ref: lane.ref, before: ZERO_SHA, after: sha(50) }],
		principal: agent,
		via: "gateway",
		requestId: "req-1",
	});
	// The gateway's waitUntil died: nothing ran phase 2.
	h.clock.advance(DIFF_BACKSTOP_MS + 1);
	await h.runTimers();
	equal(h.probeCalls.length, 1);
	deepStrictEqual(h.probeCalls[0], {
		source: { repoId: h.repoId, laneId: lane.id },
		after: sha(50),
	});
	const diffed = h.events.ofType("push.diffed");
	equal(diffed.length, 1);
	const data = diffed[0].data as Record<string, unknown>;
	equal(data.pushId, pushed.pushIds[0]);
	equal(data.rangeBase, TRUNK);
	deepStrictEqual(data.paths, ["src/a.ts"]);
	equal(
		(data.commits as { firstPushedBy: string }[])[0].firstPushedBy,
		agent,
	);
	equal(pushRows(h)[0].diff_state, "done");
	// Recording the same push again adds nothing.
	await h.facade.recordDiff(pushed.pushIds[0], {
		rangeBase: sha(99),
		rangeTruncated: false,
		diffKey: "x",
		commits: [],
		paths: [],
		truncated: false,
	});
	equal(h.events.ofType("push.diffed").length, 1);
	equal(pushRows(h)[0].range_base, TRUNK);
	// No pending row left: the timer is not re-armed.
	equal(h.timers.get("core", "diff"), null);
});

Deno.test("K17: a non-truncated range moves lanes.base_sha (a rebase); a truncated one does not", async () => {
	const h = await createHarness();
	const { agent } = principals(h);
	const lane = await openBranchLane(h, agent);
	const first = await h.facade.recordPush({
		target: lane.id,
		refs: [{ ref: lane.ref, before: ZERO_SHA, after: sha(60) }],
		principal: agent,
		via: "gateway",
		requestId: "req-1",
	});
	await h.facade.recordDiff(first.pushIds[0], {
		rangeBase: sha(61),
		rangeTruncated: false,
		diffKey: `diffs/${h.repoId}/${sha(61)}..${sha(60)}.json`,
		commits: [],
		paths: ["a"],
		truncated: false,
	});
	equal((await h.facade.getLane(lane.id))?.base, sha(61));
	const second = await h.facade.recordPush({
		target: lane.id,
		refs: [{ ref: lane.ref, before: sha(60), after: sha(62) }],
		principal: agent,
		via: "gateway",
		requestId: "req-2",
	});
	await h.facade.recordDiff(second.pushIds[0], {
		rangeBase: sha(63),
		rangeTruncated: true,
		diffKey: `diffs/${h.repoId}/${sha(63)}..${sha(62)}.json`,
		commits: [],
		paths: [],
		truncated: false,
	});
	equal(
		(await h.facade.getLane(lane.id))?.base,
		sha(61),
		"truncated: unchanged",
	);
	const range = await h.facade.laneRange(lane.id);
	deepStrictEqual(range, {
		head: sha(62),
		rangeBase: sha(63),
		rangeTruncated: true,
		diffKey: `diffs/${h.repoId}/${sha(63)}..${sha(62)}.json`,
	});
});

Deno.test("laneRange runs phase 2 for the head, once, and answers an unpushed lane without I/O", async () => {
	const h = await createHarness();
	const { agent } = principals(h);
	const lane = await openBranchLane(h, agent);
	const empty = await h.facade.laneRange(lane.id);
	deepStrictEqual(empty, {
		head: TRUNK,
		rangeBase: TRUNK,
		rangeTruncated: false,
		diffKey: `diffs/${h.repoId}/${TRUNK}..${TRUNK}.json`,
	});
	equal(h.probeCalls.length, 0);
	await h.facade.recordPush({
		target: lane.id,
		refs: [{ ref: lane.ref, before: ZERO_SHA, after: sha(70) }],
		principal: agent,
		via: "gateway",
		requestId: "req-1",
	});
	const [a, b] = await Promise.all([
		h.facade.laneRange(lane.id),
		h.facade.laneRange(lane.id),
	]);
	deepStrictEqual(a, b);
	equal(a.head, sha(70));
	equal(a.rangeBase, TRUNK);
	equal(h.probeCalls.length, 1, "phase 2 deduplicated per push");
	await rejects(
		() => h.facade.laneRange("ln_01k6c0ffee0000000000000000"),
		(e: unknown) => fromRpcError(e).code === "not_found",
	);
});

Deno.test("recordRejection ⇒ push.rejected with the valid refs", async () => {
	const h = await createHarness();
	const { agent } = principals(h);
	await h.facade.recordRejection({
		principal: agent,
		target: "repo",
		commands: [
			{ ref: "refs/heads/main", old: TRUNK, new: sha(80) },
			{ ref: "HEAD", old: ZERO_SHA, new: sha(81) },
		],
		reason: "woven-by-tartan",
		requestId: "req-9",
	});
	const [event] = h.events.ofType("push.rejected");
	deepStrictEqual(event.data, {
		target: "repo",
		refs: ["refs/heads/main"],
		reason: "woven-by-tartan",
	});
	deepStrictEqual(event.actor, { kind: "agent", id: agent });
});

Deno.test("recordPush validates its report", async () => {
	const h = await createHarness();
	const { user } = principals(h);
	for (
		const bad of [
			{ via: "trigger" },
			{ requestId: "" },
			{ principal: "nobody" },
			{ refs: [{ ref: "main", before: ZERO_SHA, after: sha(1) }] },
			{ refs: [{ ref: "refs/heads/a", before: "x", after: sha(1) }] },
			{ target: "ln_01k6c0ffee0000000000000000" },
		]
	) {
		await rejects(
			() =>
				h.facade.recordPush({
					target: "repo",
					refs: [{ ref: "refs/heads/a", before: ZERO_SHA, after: sha(1) }],
					principal: user,
					via: "gateway",
					requestId: "r",
					...bad,
				} as never),
			(e: unknown) => ["invalid", "not_found"].includes(fromRpcError(e).code),
			JSON.stringify(bad),
		);
	}
	equal(pushRows(h).length, 0);
});

Deno.test("a phase 2 that keeps failing is given up after a day; laneRange still answers", async () => {
	const h = await createHarness();
	const { agent } = principals(h);
	const lane = await openBranchLane(h, agent);
	h.setLaneDiff(() => Promise.reject(new Error("probe down")));
	await h.facade.recordPush({
		target: lane.id,
		refs: [{ ref: lane.ref, before: ZERO_SHA, after: sha(90) }],
		principal: agent,
		via: "gateway",
		requestId: "req-1",
	});
	h.clock.advance(DIFF_BACKSTOP_MS + 1);
	await h.runTimers();
	equal(pushRows(h)[0].diff_state, "pending");
	ok(h.logs.some((l) => l.message === "phase 2 failed"));
	h.clock.advance(DIFF_GIVE_UP_MS);
	await h.runTimers();
	equal(pushRows(h)[0].diff_state, "skipped");
	equal(h.timers.get("core", "diff"), null);
	h.setLaneDiff((source, after) =>
		Promise.resolve({
			rangeBase: TRUNK,
			rangeTruncated: false,
			diffKey: `diffs/${source.repoId}/${TRUNK}..${after}.json`,
			commits: [],
			paths: [],
			truncated: false,
		})
	);
	equal((await h.facade.laneRange(lane.id)).rangeBase, TRUNK);
});

Deno.test("a lane-remote push of a repo lane records target and repo_name, moves the head; its trigger merges, another attempt's repo is an orphan", async () => {
	const h = await createHarness({
		laneMode: "import",
		createRepoBackend: fakeRepoBackend(),
	});
	const { agent } = principals(h);
	const lane = await h.facade.openLane({
		owner: agent,
		actor: agentActor(agent),
	});
	const repoName = laneArtifactsName(h.repoId, lane.id.slice(3), 1);
	// WP5b's open CAS (faked): the seed verified, the lane is open at its base.
	h.storage.sql.exec(
		"UPDATE lanes SET state = 'open', head_sha = base_sha, cap_nonce = NULL, seed_phase = NULL WHERE id = ?",
		lane.id,
	);
	await h.facade.recordPush({
		target: lane.id,
		repoName,
		refs: [{ ref: "refs/heads/main", before: TRUNK, after: sha(91) }],
		principal: agent,
		via: "gateway",
		requestId: "lr-1",
		bytes: 42,
	});
	const [row] = pushRows(h);
	equal(row.target, lane.id);
	equal(row.repo_name, repoName);
	equal(row.diff_state, "pending");
	equal((await h.facade.getLane(lane.id))?.head, sha(91));
	equal(h.internal.refSync("refs/heads/main")?.sha, TRUNK, "trunk untouched");
	await h.facade.observePush({
		eventId: "evt-lr",
		repoName: repoName.toUpperCase(),
		ref: "refs/heads/main",
		before: TRUNK,
		after: sha(91),
		at: h.clock.now(),
	});
	await h.facade.observePush({
		eventId: "evt-orphan",
		repoName: laneArtifactsName(h.repoId, lane.id.slice(3), 2),
		ref: "refs/heads/main",
		before: TRUNK,
		after: sha(92),
		at: h.clock.now(),
	});
	equal(pushRows(h).length, 1);
	ok(pushRows(h)[0].seen_via_json.includes("trigger"));
	h.clock.advance(10 * 60 * 1000);
	await h.runTimers();
	deepStrictEqual(h.events.ofType("ref.tampered"), []);
	equal((await h.facade.getLane(lane.id))?.quarantined, false);
});
