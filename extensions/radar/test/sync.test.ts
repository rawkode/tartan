// tartan.radar event handling: lane ranges (K17), opening
// lanes, both backends), notices to both owners, dedupe per severity,
// avoided/predicted/materialized, trunk drift, suppression.

import { CONFLICTS_EVENTS } from "@tartan/contract";
import {
	advanced,
	agentId,
	conflicts,
	createRadar,
	createWorld,
	emitted,
	equal,
	laneEnded,
	laneOpened,
	notices,
	ok,
	pushed,
	putLane,
	sha,
	stats,
	touches,
} from "./kit.ts";

const API = "services/api/src/middleware/limit.ts";
const API2 = "services/api/src/routes.ts";
const WEB = "apps/web/src/page.tsx";

/** Two open branch lanes, both known to radar. */
const twoLanes = async () => {
	const r = createRadar();
	const a = putLane(r.world, { n: 1, handle: "claude-code" });
	const b = putLane(r.world, { n: 2, handle: "codex-2" });
	await r.deliver(laneOpened(a), laneOpened(b));
	return { r, a, b };
};

Deno.test("a lane's first push (a create) touches exactly its range paths", async () => {
	const { r, a } = await twoLanes();
	await r.deliver(pushed(r.world, a.id, { after: sha(10), paths: [API, WEB] }));
	equal(touches(r, a.id), [WEB, API].sort());
	// The event carried the shared diff: no caps re-read of the range.
	equal(
		r.recorder.calls.filter((c) => c.method === "repo.diffPaths").length,
		0,
	);
	equal(
		r.recorder.calls.filter((c) => c.method === "repo.laneRange").length,
		0,
	);
	const lane =
		r.q<{ head_sha: string; range_base: string; touches_at: string }>(
			"SELECT head_sha, range_base, touches_at FROM lanes WHERE lane_id = ?",
			a.id,
		)[0];
	equal(lane, { head_sha: sha(10), range_base: sha(1), touches_at: sha(10) });
});

Deno.test("a second push keeps the first push's touches (the range is cumulative)", async () => {
	const { r, a } = await twoLanes();
	await r.deliver(pushed(r.world, a.id, { after: sha(10), paths: [API] }));
	await r.deliver(
		pushed(r.world, a.id, { after: sha(11), paths: [API, API2] }),
	);
	equal(touches(r, a.id), [API, API2].sort());
});

Deno.test("the fallback without a diffKey reads caps.repo.laneRange, never (base, after)", async () => {
	const { r, a } = await twoLanes();
	r.world.ranges.set(a.id, {
		head: sha(12),
		rangeBase: sha(5),
		rangeTruncated: false,
		diffKey: "k",
	});
	r.world.diffs.set(`${sha(5)}..${sha(12)}`, {
		paths: [
			{ path: API, change: "modified", project: "api" },
			{ path: "docs/new.md", oldPath: "docs/old.md", change: "renamed" },
		],
		truncated: false,
	});
	await r.deliver(
		pushed(r.world, a.id, {
			after: sha(12),
			rangeBase: sha(9),
			paths: ["ignored.ts"],
			diffKey: "",
		}),
	);
	const calls = r.recorder.calls.filter((c) =>
		c.method === "repo.laneRange" || c.method === "repo.diffPaths"
	);
	equal(calls.map((c) => c.method), ["repo.laneRange", "repo.diffPaths"]);
	equal(calls[1].args, [
		{ repoId: r.world.lanes.get(a.id)!.repoId, laneId: a.id },
		sha(5),
		sha(12),
	]);
	equal(touches(r, a.id), ["docs/new.md", "docs/old.md", API].sort());
	equal(
		r.q("SELECT range_base FROM lanes WHERE lane_id = ?", a.id)[0],
		{ range_base: sha(5) },
	);
});

Deno.test("after a rebase onto a newer trunk the landed paths leave the touches and the drift", async () => {
	const { r, a, b } = await twoLanes();
	await r.deliver(pushed(r.world, a.id, { after: sha(10), paths: [API] }));
	await r.deliver(pushed(r.world, b.id, { after: sha(20), paths: [API, WEB] }));
	equal(conflicts(r, "open").map((c) => [c.severity, c.path]), [[
		"same_file",
		API,
	]]);
	// a lands: trunk moves sha(1) → sha(30).
	await r.deliver(
		advanced(sha(1), sha(30), [{
			laneId: a.id,
			changeId: "c".repeat(32),
			commit: sha(30),
		}]),
	);
	const open = conflicts(r, "open");
	equal(open.map((c) => [c.a, c.b, c.severity, c.path]), [[
		b.id,
		"trunk",
		"trunk_drift",
		API,
	]]);
	equal(stats(r).materialized, 1);
	// b rebases onto sha(30): its range no longer has API, and its base moved.
	await r.deliver(
		pushed(r.world, b.id, { after: sha(21), rangeBase: sha(30), paths: [WEB] }),
	);
	equal(touches(r, b.id), [WEB]);
	equal(conflicts(r, "open"), []);
});

Deno.test("a lane whose base precedes the landing still drifts; one based after it does not", async () => {
	const { r, a, b } = await twoLanes();
	await r.deliver(pushed(r.world, a.id, { after: sha(10), paths: [API] }));
	await r.deliver(
		advanced(sha(1), sha(30), [{
			laneId: a.id,
			changeId: "d".repeat(32),
			commit: sha(30),
		}]),
	);
	// b pushes for the first time, still on the old base: drift on API.
	await r.deliver(
		pushed(r.world, b.id, { after: sha(20), rangeBase: sha(1), paths: [API] }),
	);
	equal(conflicts(r, "open").map((c) => c.severity), ["trunk_drift"]);
	// A third lane based on sha(30) touching API does not drift.
	const c = putLane(r.world, { n: 3, base: sha(30) });
	await r.deliver(laneOpened(c));
	await r.deliver(
		pushed(r.world, c.id, { after: sha(40), rangeBase: sha(30), paths: [API] }),
	);
	ok(
		!conflicts(r, "open").some((x) => x.a === c.id && x.b === "trunk"),
		"no drift for a lane based on the landing",
	);
});

Deno.test("repo lanes: an opening lane has no touches and raises no conflict until lane.opened", async () => {
	const r = createRadar();
	const a = putLane(r.world, { n: 1 });
	await r.deliver(laneOpened(a));
	await r.deliver(pushed(r.world, a.id, { after: sha(10), paths: [API] }));
	const b = putLane(r.world, { n: 2, mode: "repo", state: "opening" });
	// A stray push.diffed for the opening lane: ignored (the gateway refuses
	// such pushes; radar does not trust the event alone).
	await r.deliver(pushed(r.world, b.id, { after: sha(20), paths: [API] }));
	equal(touches(r, b.id), []);
	equal(conflicts(r), []);
	const check = await r.tool(
		"conflicts_check",
		{ repo: "acme/platform/router", paths: [API] },
		r.toolCtx(agentId(9)),
	) as { results: { lanes: { laneId: string }[] }[] };
	equal(check.results[0].lanes.map((l) => l.laneId), [a.id]);
	// Opened: it joins, and its push conflicts.
	r.world.lanes.set(b.id, { ...r.world.lanes.get(b.id)!, state: "open" });
	await r.deliver(laneOpened(r.world.lanes.get(b.id)!));
	await r.deliver(pushed(r.world, b.id, { after: sha(21), paths: [API] }));
	equal(conflicts(r, "open").map((c) => c.severity), ["same_file"]);
});

Deno.test("notices go to both owners with suggestions; each names the other lane's own fetch command", async () => {
	const r = createRadar();
	const repoLane = putLane(r.world, { n: 1, mode: "repo", handle: "codex-2" });
	const branchLane = putLane(r.world, { n: 2, handle: "claude-code" });
	await r.deliver(laneOpened(repoLane), laneOpened(branchLane));
	await r.deliver(
		pushed(r.world, repoLane.id, { after: sha(10), paths: [API] }),
	);
	await r.deliver(
		pushed(r.world, branchLane.id, { after: sha(20), paths: [API] }),
	);
	const sent = notices(r);
	equal(sent.length, 2);
	const toBranch = sent.find((n) => n.principal === branchLane.owner)!;
	const toRepo = sent.find((n) => n.principal === repoLane.owner)!;
	ok(toBranch && toRepo, "both owners are told");
	// The pusher (branch lane) is told to coordinate or stack onto the repo
	// lane: its lane remote's `main`.
	ok(
		toBranch.notice.text.includes(
			`git fetch /acme/platform/router/-/lanes/${repoLane.id}.git main`,
		),
		toBranch.notice.text,
	);
	ok(
		toBranch.notice.text.includes("inbox_send to codex-2"),
		toBranch.notice.text,
	);
	// The other owner gets the branch lane's ref.
	ok(
		toRepo.notice.text.includes(
			`git fetch origin refs/heads/lanes/${branchLane.id}`,
		),
		toRepo.notice.text,
	);
	equal(toBranch.notice.kind, "conflict");
	equal(toBranch.notice.severity, "warn");
	equal(toBranch.notice.data.suggestion, "coordinate");
	ok(typeof toBranch.notice.data.conflictId === "string");
});

Deno.test("dedupe per severity: an unchanged overlap is announced once; a new path is announced", async () => {
	const { r, a, b } = await twoLanes();
	await r.deliver(pushed(r.world, a.id, { after: sha(10), paths: [API] }));
	await r.deliver(pushed(r.world, b.id, { after: sha(20), paths: [API] }));
	equal(notices(r).length, 2);
	await r.deliver(pushed(r.world, b.id, { after: sha(21), paths: [API] }));
	await r.deliver(pushed(r.world, a.id, { after: sha(11), paths: [API] }));
	equal(notices(r).length, 2, "same severity, same paths: no new notice");
	await r.deliver(
		pushed(r.world, b.id, { after: sha(22), paths: [API, API2] }),
	);
	await r.deliver(
		pushed(r.world, a.id, { after: sha(12), paths: [API, API2] }),
	);
	equal(notices(r).length, 4, "the new shared path is announced to both");
	ok(notices(r)[3].notice.text.includes(API2));
	equal(emitted(r, "conflicts.detected").length, 2);
});

Deno.test("resolved on a later push increments avoided and emits conflicts.cleared{avoided}", async () => {
	const { r, a, b } = await twoLanes();
	await r.deliver(pushed(r.world, a.id, { after: sha(10), paths: [API] }));
	await r.deliver(pushed(r.world, b.id, { after: sha(20), paths: [API] }));
	equal(stats(r).predicted, 1);
	await r.deliver(pushed(r.world, b.id, { after: sha(21), paths: [WEB] }));
	equal(conflicts(r, "open"), []);
	equal(conflicts(r, "cleared").map((c) => c.avoided), [1]);
	equal(stats(r).avoided, 1);
	const cleared = emitted(r, "conflicts.cleared");
	equal(cleared.map((e) => (e.data as { avoided: boolean }).avoided), [true]);
	ok(CONFLICTS_EVENTS["conflicts.cleared"].safeParse(cleared[0].data).success);
	// Re-detection is a new prediction.
	await r.deliver(pushed(r.world, b.id, { after: sha(22), paths: [API] }));
	equal(conflicts(r, "open").length, 1);
	equal(stats(r).predicted, 2);
});

Deno.test("events carry the conflicts@1 payloads (K10)", async () => {
	const { r, a, b } = await twoLanes();
	await r.deliver(pushed(r.world, a.id, { after: sha(10), paths: [API] }));
	await r.deliver(pushed(r.world, b.id, { after: sha(20), paths: [API] }));
	await r.deliver(pushed(r.world, b.id, { after: sha(21), paths: [WEB] }));
	const all = emitted(r);
	ok(all.length >= 2, "events were emitted");
	for (const e of all) {
		const schema = CONFLICTS_EVENTS[e.type as keyof typeof CONFLICTS_EVENTS];
		ok(schema, `known type ${e.type}`);
		ok(
			schema.safeParse(e.data).success,
			`${e.type}: ${JSON.stringify(e.data)}`,
		);
		const o = e.options as { subject: { kind: string }; idemKey: string };
		equal(o.subject.kind, "conflict");
		ok(o.idemKey.startsWith("ev_"), "stable idempotency key");
	}
});

Deno.test("replaying the same push is a no-op (idempotent)", async () => {
	const { r, a, b } = await twoLanes();
	await r.deliver(pushed(r.world, a.id, { after: sha(10), paths: [API] }));
	const ev = pushed(r.world, b.id, { after: sha(20), paths: [API] });
	await r.deliver(ev);
	const before = [notices(r).length, emitted(r).length, stats(r).predicted];
	await r.deliver(ev);
	equal([notices(r).length, emitted(r).length, stats(r).predicted], before);
});

Deno.test("a stale push.diffed (the lane moved on) is skipped", async () => {
	const { r, a, b } = await twoLanes();
	await r.deliver(pushed(r.world, a.id, { after: sha(10), paths: [API] }));
	const old = pushed(r.world, b.id, { after: sha(20), paths: [API] });
	r.world.lanes.set(b.id, { ...r.world.lanes.get(b.id)!, head: sha(21) });
	await r.deliver(old);
	equal(touches(r, b.id), []);
});

Deno.test("trunk drift: a landing touching an open lane's path tells its owner to rebase", async () => {
	const { r, a, b } = await twoLanes();
	await r.deliver(pushed(r.world, b.id, { after: sha(20), paths: [API2] }));
	// a lands without radar ever seeing its touches: paths come from the
	// landed commit's own diff against its parent.
	r.world.diffs.set(`${sha(1)}..${sha(30)}`, {
		paths: [{ path: API2, change: "modified" }],
		truncated: false,
	});
	await r.deliver(
		advanced(sha(1), sha(30), [{
			laneId: a.id,
			changeId: "e".repeat(32),
			commit: sha(30),
		}]),
	);
	const drift = conflicts(r, "open");
	equal(drift.map((c) => [c.a, c.b, c.severity, c.suggestion]), [[
		b.id,
		"trunk",
		"trunk_drift",
		"rebase",
	]]);
	const n = notices(r).find((x) => x.principal === b.owner)!;
	equal(n.notice.kind, "trunk_drift");
	ok(
		n.notice.text.includes("git fetch origin main && git rebase FETCH_HEAD"),
		n.notice.text,
	);
	// The same advance again records nothing new.
	const count = notices(r).length;
	equal(conflicts(r, "open").length, 1);
	ok(count >= 1);
});

Deno.test("declared overlaps at claim: recorded, and only the earlier lane's owner is told (info)", async () => {
	const r = createRadar();
	const a = putLane(r.world, {
		n: 1,
		footprint: { prefixes: ["services/api/src/middleware"] },
		entity: { kind: "work", id: "acme/platform/router#38" },
		handle: "codex-2",
	});
	r.world.work.set("acme/platform/router#38", {
		title: "per-tenant quotas",
		why: "noisy tenants",
	});
	r.world.work.set("acme/platform/router#42", {
		title: "rate limiting",
		why: "abuse",
	});
	await r.deliver(laneOpened(a));
	const b = putLane(r.world, {
		n: 2,
		footprint: { prefixes: ["services/api/src"], projects: ["api"] },
		entity: { kind: "work", id: "acme/platform/router#42" },
		handle: "claude-code",
	});
	await r.deliver(laneOpened(b));
	equal(conflicts(r, "open").map((c) => [c.severity, c.path]), [[
		"declared",
		"services/api/src/middleware",
	]]);
	const sent = notices(r);
	equal(sent.map((n) => [n.principal, n.notice.severity]), [[a.owner, "info"]]);
	ok(sent[0].notice.text.includes('#42 "rate limiting"'), sent[0].notice.text);
	equal(emitted(r), [], "declared rows are advisory: no conflicts.* events");
});

Deno.test("touches under another lane's declared footprint are a declared overlap", async () => {
	const r = createRadar();
	const a = putLane(r.world, {
		n: 1,
		footprint: { prefixes: ["services/api"] },
	});
	const b = putLane(r.world, { n: 2 });
	await r.deliver(laneOpened(a), laneOpened(b));
	await r.deliver(pushed(r.world, b.id, { after: sha(20), paths: [API] }));
	equal(conflicts(r, "open").map((c) => [c.severity, c.path]), [[
		"declared",
		"services/api",
	]]);
});

Deno.test("same project, different files: same_project, advisory (proceed, no notice)", async () => {
	const { r, a, b } = await twoLanes();
	await r.deliver(pushed(r.world, a.id, { after: sha(10), paths: [API] }));
	await r.deliver(pushed(r.world, b.id, { after: sha(20), paths: [API2] }));
	equal(conflicts(r, "open").map((c) => [c.severity, c.path, c.suggestion]), [[
		"same_project",
		"project:api",
		"proceed",
	]]);
	equal(notices(r), []);
	equal(stats(r).predicted ?? 0, 0);
});

Deno.test("a lane stacked on another (its range carries the other's head) is not in conflict with it", async () => {
	const { r, a, b } = await twoLanes();
	await r.deliver(pushed(r.world, a.id, { after: sha(10), paths: [API] }));
	await r.deliver(
		pushed(r.world, b.id, {
			after: sha(20),
			paths: [API, API2],
			commits: [sha(20), sha(10)],
		}),
	);
	equal(conflicts(r, "open"), []);
});

Deno.test("a second claim of the same work item is told to yield", async () => {
	const r = createRadar();
	const w = { kind: "work", id: "acme/platform/router#7" };
	const a = putLane(r.world, { n: 1, entity: w });
	const b = putLane(r.world, { n: 2, entity: w });
	await r.deliver(laneOpened(a), laneOpened(b));
	await r.deliver(pushed(r.world, a.id, { after: sha(10), paths: [API] }));
	await r.deliver(pushed(r.world, b.id, { after: sha(20), paths: [API] }));
	equal(conflicts(r, "open").map((c) => c.suggestion), ["yield"]);
});

Deno.test("a submitted lane is ahead: the other is told to stack onto it", async () => {
	const { r, a, b } = await twoLanes();
	await r.deliver(pushed(r.world, a.id, { after: sha(10), paths: [API] }));
	await r.deliver({
		...laneOpened(a),
		type: "changes.submitted",
		data: {
			changeId: "f".repeat(32),
			laneId: a.id,
			revision: 1,
			head: sha(10),
			base: sha(1),
		},
	});
	await r.deliver(pushed(r.world, b.id, { after: sha(20), paths: [API] }));
	equal(conflicts(r, "open").map((c) => c.suggestion), ["stack"]);
	const toB = notices(r).find((n) => n.principal === b.owner)!;
	ok(toB.notice.text.includes(`stack onto ${a.id}`), toB.notice.text);
});

Deno.test("closing a lane clears its conflicts (avoided when announced); a lost lease is not avoided", async () => {
	const { r, a, b } = await twoLanes();
	const c = putLane(r.world, { n: 3 });
	await r.deliver(laneOpened(c));
	await r.deliver(pushed(r.world, a.id, { after: sha(10), paths: [API] }));
	await r.deliver(pushed(r.world, b.id, { after: sha(20), paths: [API] }));
	await r.deliver(pushed(r.world, c.id, { after: sha(30), paths: [API] }));
	equal(conflicts(r, "open").length, 3);
	await r.deliver(laneEnded("lane.lost", c));
	equal(stats(r).avoided ?? 0, 0);
	equal(conflicts(r, "open").length, 1);
	await r.deliver(laneEnded("lane.closed", b));
	equal(stats(r).avoided, 1);
	equal(conflicts(r, "open"), []);
	equal(touches(r, b.id), []);
	equal(touches(r, c.id), [API], "a lost lane keeps its touches for a resume");
});

Deno.test("landing with an open file overlap counts it as materialized and clears it", async () => {
	const { r, a, b } = await twoLanes();
	await r.deliver(pushed(r.world, a.id, { after: sha(10), paths: [API] }));
	await r.deliver(pushed(r.world, b.id, { after: sha(20), paths: [API] }));
	await r.deliver(
		advanced(sha(1), sha(30), [{
			laneId: b.id,
			changeId: "a".repeat(32),
			commit: sha(30),
		}]),
	);
	equal(stats(r), { predicted: 1, materialized: 1 });
	const cleared = emitted(r, "conflicts.cleared");
	equal(cleared.map((e) => (e.data as { avoided: boolean }).avoided), [false]);
	equal(conflicts(r, "open").map((c) => [c.a, c.b, c.severity]), [[
		a.id,
		"trunk",
		"trunk_drift",
	]]);
});

Deno.test("activation seeds the projection with lanes that opened earlier", async () => {
	const world = createWorld();
	const a = putLane(world, { n: 1, footprint: { prefixes: ["services/api"] } });
	putLane(world, { n: 2, state: "closed" });
	const r = createRadar(world);
	await r.init();
	equal(
		r.q("SELECT lane_id, state FROM lanes ORDER BY lane_id"),
		[{ lane_id: a.id, state: "open" }],
	);
	equal(
		r.q("SELECT kind, value FROM footprints WHERE lane_id = ?", a.id),
		[{ kind: "prefix", value: "services/api" }],
	);
});

Deno.test("a push for a lane radar never saw is projected through caps first", async () => {
	const r = createRadar();
	const a = putLane(r.world, { n: 1, handle: "codex-2" });
	await r.deliver(laneOpened(a));
	await r.deliver(pushed(r.world, a.id, { after: sha(10), paths: [API] }));
	const late = putLane(r.world, { n: 5, handle: "late-agent" });
	await r.deliver(pushed(r.world, late.id, { after: sha(50), paths: [API] }));
	equal(conflicts(r, "open").length, 1);
	equal(
		r.q("SELECT owner_label FROM lanes WHERE lane_id = ?", late.id),
		[{ owner_label: "late-agent" }],
	);
});
