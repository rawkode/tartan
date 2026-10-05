// The simulated swarm's pure parts: planning (cap, shards,
// cohorts, unique principals), commits built in memory and accepted by a
// real git receive-pack (FakeArtifacts), the agent loop (claim → pushes →
// submit → read-your-writes), overlap on hot files, the wrong-lane probe,
// retries after errors, hand-over of an agent mid-lane to a fresh runtime,
// and a paced round.

import {
	deepStrictEqual as assertEquals,
	match as assertMatch,
	ok as assert,
} from "node:assert/strict";
import { SwarmRequestSchema } from "@tartan/contract";
import {
	createRuntime,
	emptyStats,
	newAgent,
	ownContent,
	probeWrongLane,
	redactError,
	type SimAgentState,
	type SimConfig,
	type SimPort,
	tick,
} from "./agent.ts";
import {
	estimateSubrequests,
	runRound,
	SUBREQUESTS_PER_REQUEST,
} from "./cohort.ts";
import { buildCommit, treeStateOf } from "./gittree.ts";
import {
	cohortInstanceId,
	cohortPrefix,
	planSwarm,
	SWARM_LIMITS,
} from "./plan.ts";
import { HOT_FILES, SAMPLE_FILES } from "./sample.ts";
import { createFakeForge } from "./testing/fakeforge.ts";

const SWARM = "swarm-01k6zzzzzzzzzzzzzzzzzzzzzz";

const request = (over: Record<string, unknown> = {}) =>
	SwarmRequestSchema.parse({
		repo: "rawkode/platform/edge/router",
		agents: 300,
		workItems: 600,
		minutes: 10,
		...over,
	});

const cfgFor = (repo: string, over: Partial<SimConfig> = {}): SimConfig => ({
	swarmId: SWARM,
	repo,
	itemsPerAgent: 2,
	pushesPerItem: 2,
	overlap: 0,
	hotFiles: 0,
	now: () => 1_790_000_000_000,
	...over,
});

const runUntilDone = async (
	rt: ReturnType<typeof createRuntime>,
	start: SimAgentState,
	stats = emptyStats(),
	limit = 50,
): Promise<SimAgentState> => {
	let s = start;
	for (let i = 0; i < limit && s.phase !== "done"; i++) {
		s = await tick(rt, s, stats);
	}
	return s;
};

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

Deno.test("plan: 300 agents by default cap, 50 per shard, one cohort per shard", () => {
	const plan = planSwarm({ swarmId: SWARM, request: request(), now: 1000 });
	assertEquals(plan.agents, 300);
	assertEquals(plan.capped, false);
	assertEquals(plan.namespace, "rawkode");
	assertEquals(plan.simGroup, "rawkode/sim");
	assertEquals(plan.shards.length, 6);
	assertEquals(plan.shards[0]!.path, "rawkode/sim/router-01");
	assertEquals(plan.cohorts.map((c) => c.agents.length), [
		50,
		50,
		50,
		50,
		50,
		50,
	]);
	assertEquals(plan.itemsPerAgent, 2);
	assertEquals(plan.endsAt, 1000 + 10 * 60_000);
	const handles = plan.cohorts.flatMap((c) => c.agents);
	assertEquals(new Set(handles).size, 300, "no two agents share a principal");
	for (const c of plan.cohorts) {
		assertMatch(c.prefix, /^[a-z0-9-]{1,20}$/);
		assert(c.agents.every((a, i) => a === `${c.prefix}-${i + 1}`));
	}
});

Deno.test("plan: more than the cap is capped and said so; the cap can be raised to 1,000", () => {
	const capped = planSwarm({
		swarmId: SWARM,
		request: request({ agents: 1000 }),
		now: 0,
	});
	assertEquals(capped.agents, SWARM_LIMITS.defaultCap);
	assertEquals(capped.capped, true);
	const full = planSwarm({
		swarmId: SWARM,
		request: request({ agents: 1000 }),
		now: 0,
		cap: 5000,
	});
	assertEquals(full.agents, 1000);
	assertEquals(full.shards.length, 20);
	assertEquals(full.shards.at(-1)!.path, "rawkode/sim/router-20");
	const odd = planSwarm({
		swarmId: SWARM,
		request: request({ agents: 120 }),
		now: 0,
	});
	assertEquals(odd.cohorts.map((c) => c.agents.length), [40, 40, 40]);
	assertEquals(cohortInstanceId(SWARM, 3, 2), `${SWARM}-c03-g2`);
	assertEquals(cohortPrefix(SWARM, 0), "sim-zzzzzzzz-c01");
});

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

Deno.test("commits built in memory are accepted by receive-pack and carry only what changed", async () => {
	const forge = await createFakeForge(SAMPLE_FILES);
	const port = forge.portFor("a1");
	const stats = emptyStats();
	const rt = createRuntime(port, cfgFor(forge.repo));
	const claimed = await tick(rt, newAgent("a1"), stats);
	assertEquals(claimed.phase, "lane");
	const pushed = await tick(rt, claimed, stats);
	assertEquals(stats.errors, 0, stats.lastError);
	assertEquals(forge.refs()[claimed.lane!.ref], pushed.head);
	// The new file, its new directory, and every sibling unchanged.
	assertEquals(
		await forge.readFileAt(pushed.head!, pushed.own!),
		ownContent("a1", 1),
	);
	assertEquals(
		await forge.readFileAt(pushed.head!, "services/api/src/router.ts"),
		SAMPLE_FILES["services/api/src/router.ts"],
	);
	assertEquals(
		(await forge.readTreeAt(pushed.head!, ""))?.sort(),
		Object.keys(SAMPLE_FILES).map((p) => p.split("/")[0]!)
			.filter((v, i, a) => a.indexOf(v) === i).sort(),
	);
	// Trunk did not move: agents write only their lanes.
	assertEquals(forge.refs()["refs/heads/main"], forge.trunk);
});

Deno.test("buildCommit refuses an empty edit list", async () => {
	let threw = false;
	try {
		await buildCommit({
			state: treeStateOf("a".repeat(40)),
			read: () => Promise.resolve([]),
			edits: [],
			message: "x",
			author: { name: "a", email: "a@x", at: 0 },
		});
	} catch {
		threw = true;
	}
	assert(threw);
});

// ---------------------------------------------------------------------------
// The agent loop
// ---------------------------------------------------------------------------

Deno.test("an agent claims, pushes, submits and reads its own writes, item after item", async () => {
	const forge = await createFakeForge(SAMPLE_FILES);
	const stats = emptyStats();
	const rt = createRuntime(forge.portFor("a1"), cfgFor(forge.repo));
	const done = await runUntilDone(rt, newAgent("a1"), stats);
	assertEquals(done.phase, "done");
	assertEquals(done.items, 2);
	assertEquals(stats.claims, 2);
	assertEquals(stats.pushes, 4);
	assertEquals(stats.submits, 2);
	assertEquals(stats.rywChecks, 2);
	assertEquals(stats.rywMismatches, 0);
	assertEquals(stats.errors, 0, stats.lastError);
	assertEquals(forge.changes.size, 2);
	for (const change of forge.changes.values()) {
		const ref = `refs/heads/lanes/${change.lane}`;
		assertEquals(change.head, forge.refs()[ref]);
	}
	// The MCP tools a real agent uses, in its loop's order.
	assertEquals(
		forge.calls.filter((c) => c.startsWith("a1 ")).slice(0, 4),
		["a1 work_create", "a1 work_claim", "a1 repo_tree", "a1 repo_tree"],
	);
	assert(stats.requests > 0);
	assertEquals(
		estimateSubrequests(stats),
		stats.requests * SUBREQUESTS_PER_REQUEST,
	);
});

Deno.test("with overlap 1 every push lands on a hot file, on top of trunk's content", async () => {
	const forge = await createFakeForge(SAMPLE_FILES);
	const cfg = cfgFor(forge.repo, { overlap: 1, hotFiles: 1, itemsPerAgent: 1 });
	const heads: Record<string, string> = {};
	for (const agent of ["a1", "a2"]) {
		const stats = emptyStats();
		const rt = createRuntime(forge.portFor(agent), cfg);
		let s = await tick(rt, newAgent(agent), stats);
		s = await tick(rt, s, stats);
		s = await tick(rt, s, stats);
		assertEquals(stats.errors, 0, stats.lastError);
		heads[agent] = s.head!;
	}
	const hot = HOT_FILES[0]!;
	for (const agent of ["a1", "a2"]) {
		const text = await forge.readFileAt(heads[agent]!, hot);
		assert(text!.startsWith(SAMPLE_FILES[hot]!), "on top of trunk");
		assert(text!.includes(`// ${agent}: `), "the agent's own lines");
		assertEquals(text!.split("\n").filter((l) => l.startsWith("//")).length, 2);
	}
});

Deno.test("a push to another agent's lane is refused", async () => {
	const forge = await createFakeForge(SAMPLE_FILES);
	const stats = emptyStats();
	const victim = await tick(
		createRuntime(forge.portFor("victim"), cfgFor(forge.repo)),
		newAgent("victim"),
		stats,
	);
	const refused = await probeWrongLane(
		forge.portFor("prober"),
		victim.lane!,
		victim.head,
		stats,
	);
	assertEquals(refused, "refused");
	assertEquals(forge.refs()[victim.lane!.ref], undefined, "nothing written");
});

Deno.test("the wrong-lane probe counts only the ownership verdict as refused", async () => {
	const forge = await createFakeForge(SAMPLE_FILES);
	const victim = await tick(
		createRuntime(forge.portFor("victim"), cfgFor(forge.repo)),
		newAgent("victim"),
		emptyStats(),
	);
	const lane = victim.lane!;
	const pushed: string[] = [];
	const port = (
		answer: () => Promise<{ ref: string; ok: boolean; reason?: string }[]>,
		head?: string,
	): SimPort => ({
		tool: (name) =>
			name === "lanes_get" && head !== undefined
				? Promise.resolve({ lane: { id: lane.id, head } })
				: Promise.reject(new Error("unavailable")),
		push: (_remote, commands) => {
			pushed.push(commands[0].old);
			return answer();
		},
	});
	const refusedAs = (reason: string) => () =>
		Promise.resolve([{ ref: lane.ref, ok: false, reason }]);
	const probe = (p: SimPort) =>
		probeWrongLane(p, lane, victim.head, emptyStats(), forge.repo);
	assertEquals(await probe(port(refusedAs("not-your-lane"))), "refused");
	assertEquals(await probe(port(refusedAs("stale-old"))), "inconclusive");
	assertEquals(await probe(port(refusedAs("lane-landing"))), "inconclusive");
	assertEquals(
		await probe(port(() => Promise.reject(new Error("HTTP 500")))),
		"inconclusive",
	);
	assertEquals(
		await probe(
			port(() =>
				Promise.reject(new Error("HTTP 403: push rejected: not-your-lane"))
			),
		),
		"refused",
	);
	assertEquals(
		await probe(port(() => Promise.resolve([{ ref: lane.ref, ok: true }]))),
		"accepted",
	);
	// The push names the victim's head as the gateway knows it now.
	const now = "e".repeat(40);
	await probe(port(refusedAs("not-your-lane"), now));
	assertEquals(pushed.at(-1), now);
});

Deno.test("an error is counted, redacted, and the next tick retries", async () => {
	const forge = await createFakeForge(SAMPLE_FILES);
	forge.failClaims(1);
	const stats = emptyStats();
	const rt = createRuntime(forge.portFor("a1"), cfgFor(forge.repo));
	const failed = await tick(rt, newAgent("a1"), stats);
	assertEquals(failed.phase, "idle");
	assertEquals(stats.errors, 1);
	assertMatch(stats.lastError!, /work_claim: unavailable/);
	const retried = await tick(rt, failed, stats);
	assertEquals(retried.phase, "lane");
	assertEquals(
		redactError(new Error("bad tagt_abcDEF123_x token\nsecond line")),
		"bad tagt_[redacted] token",
	);
});

Deno.test("an agent handed over mid-lane continues from its head with fresh caches", async () => {
	const forge = await createFakeForge(SAMPLE_FILES);
	const cfg = cfgFor(forge.repo, {
		overlap: 0.5,
		hotFiles: 3,
		pushesPerItem: 3,
	});
	const stats = emptyStats();
	let s = await tick(
		createRuntime(forge.portFor("a1"), cfg),
		newAgent("a1"),
		stats,
	);
	const first = createRuntime(forge.portFor("a1"), cfg);
	s = await tick(first, s, stats);
	// The successor gets JSON state only: no tree or file cache.
	const resumed: SimAgentState = JSON.parse(JSON.stringify(s));
	const second = createRuntime(forge.portFor("a1"), cfg);
	s = await tick(second, resumed, stats);
	s = await tick(second, s, stats);
	assertEquals(stats.errors, 0, stats.lastError);
	assertEquals(s.pushes, 3);
	assertEquals(forge.refs()[s.lane!.ref], s.head);
	s = await tick(second, s, stats);
	assertEquals(stats.rywMismatches, 0);
	assertEquals(s.phase, "idle");
});

/** Wall time sped up 2,000×: one simulated minute is 30 ms. */
const fastClock = (speed = 2000) => {
	const start = 1_790_000_000_000;
	const t0 = performance.now();
	return {
		now: () => start + (performance.now() - t0) * speed,
		sleep: (ms: number) =>
			new Promise<void>((resolve) => setTimeout(resolve, ms / speed)),
	};
};

Deno.test("a paced round: concurrent agents, bounded by the round, probe refused", async () => {
	const forge = await createFakeForge(SAMPLE_FILES);
	const clock = fastClock();
	const cfg = cfgFor(forge.repo, { itemsPerAgent: 3, now: clock.now });
	const started = clock.now();
	const result = await runRound({
		cfg,
		agents: ["a1", "a2", "a3"].map(newAgent),
		portOf: (h) => forge.portFor(h),
		round: 0,
		roundMs: 60_000,
		paceMs: 10_000,
		now: clock.now,
		sleep: clock.sleep,
		probe: true,
	});
	const took = clock.now() - started;
	assertEquals(result.stats.errors, 0, result.stats.lastError);
	assertEquals(result.probe, "refused");
	assert(took >= 50_000 && took < 120_000, `the round took ${took} ms`);
	for (const agent of result.agents) {
		// One action every 5–15 s for 60 s, after a start spread over 10 s.
		assert(
			agent.ticks >= 3 && agent.ticks <= 12,
			`${agent.handle}: ${agent.ticks}`,
		);
	}
	assert(result.stats.claims >= 3);
	assert(result.stats.pushes >= 3);
	const stopped = await runRound({
		cfg,
		agents: result.agents,
		portOf: (h) => forge.portFor(h),
		round: 1,
		roundMs: 60_000,
		paceMs: 10_000,
		now: clock.now,
		sleep: clock.sleep,
		probe: false,
		stopped: () => true,
	});
	assertEquals(stopped.stats.requests, 0, "a stopped swarm acts no more");
});
