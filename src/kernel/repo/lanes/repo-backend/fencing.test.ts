// Seed attempts are fenced: every transition of attempt n is a CAS on
// `(state='opening', seed_attempt=n)`, every attempt uses a fresh repo name,
// and the watchdog probes before it advances. Real WP5a core + this backend on
// the land harness, FakeArtifacts' `import()` through the capability route
// stand-in.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { laneArtifactsName } from "@tartan/contract";
import {
	type IndexArtifactsInput,
	seedTimerKey,
} from "@tartan/contract/kernel.ts";
import {
	LANE_ORPHAN_AGE_MS,
	LANE_SEED_CONCURRENCY,
} from "../../../../constants.ts";
import { agentActor } from "../../../land/testing/harness.ts";
import {
	AGENTS,
	eventsOfType,
	openAs,
	repoLaneTest,
	rowOf,
} from "./testing/lanes.ts";

const imports = (h: { fake: { calls: readonly { op: string }[] } }) =>
	h.fake.calls.filter((c) => c.op === "import").length;

const until = async (check: () => boolean, ms = 2_000): Promise<void> => {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("condition not reached");
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
};

const gate = () => {
	let open!: () => void;
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
};

repoLaneTest(
	"the open transaction and a watchdog firing at once start exactly one import",
	async (h) => {
		// Attempt 1 stalls before its index upsert (an isolate that never got going).
		const stalled = gate();
		const index = h.tree.indexArtifacts.bind(h.tree);
		let calls = 0;
		(h.tree as { indexArtifacts: unknown }).indexArtifacts = async (
			input: IndexArtifactsInput,
		) => {
			if (calls++ === 0) await stalled.promise;
			return await index(input);
		};
		const lane = await openAs(h, AGENTS[0]);
		equal(rowOf(h, lane.id).seed_phase, "cap");
		h.clock.advance(60_000);
		const outcomes = await h.runTimers();
		const seed = outcomes.find((o) => o.key === seedTimerKey(lane.id));
		ok(seed?.ok, "the watchdog never throws");
		equal(seed?.retryAt, undefined, "no backoff retry");
		equal(rowOf(h, lane.id).seed_attempt, 2);
		stalled.open();
		await h.settle();
		const opened = await h.core.getLane(lane.id);
		equal(opened?.state, "open");
		equal(
			rowOf(h, lane.id).repo_name,
			laneArtifactsName(h.repoId, lane.id.slice(3), 2),
		);
		equal(imports(h), 1, "exactly one import");
		const failed = eventsOfType(h, "lane.seed_failed");
		deepStrictEqual(
			failed.map((e) => (e.data as { code: string }).code),
			["interrupted"],
		);
	},
);

repoLaneTest(
	"closeLane during an import leaves the lane closed forever; the stray repo is swept",
	async (h) => {
		// The importer already consumed the capability; its pack is in flight.
		const held = gate();
		h.capRoute.holdNext = held.promise;
		const lane = await openAs(h, AGENTS[0]);
		await until(() => h.capRoute.held === 1);
		await h.core.closeLane(lane.id, "never mind", agentActor(AGENTS[0]));
		equal(rowOf(h, lane.id).state, "closed");
		equal(rowOf(h, lane.id).cap_nonce, null, "the capability dies at once");
		held.open();
		const name = laneArtifactsName(h.repoId, lane.id.slice(3), 1);
		await until(() => h.fake.inspect.names().includes(name));
		await h.settle();
		equal(rowOf(h, lane.id).state, "closed", "never reopened");
		equal(eventsOfType(h, "lane.opened").length, 0);
		const closed = eventsOfType(h, "lane.closed");
		equal((closed[0].data as { seedCode?: string }).seedCode, "cancelled");
		// The sweep removes it once it is old enough (rule c), after an intent.
		const early = await h.core.sweepLaneRepos([name], h.clock.now());
		deepStrictEqual(early.deleted, []);
		const swept = await h.core.sweepLaneRepos(
			[name],
			h.clock.now() + LANE_ORPHAN_AGE_MS + 1,
		);
		deepStrictEqual(swept.deleted, [name]);
		ok(!h.fake.inspect.names().includes(name));
		const intents = h.storage.sql.exec(
			"SELECT purpose, state FROM kernel_writes WHERE target = ? AND purpose = 'lane-delete'",
			lane.id,
		).toArray();
		deepStrictEqual(intents, [{ purpose: "lane-delete", state: "pushed" }]);
		equal(h.index.get(name)?.state, "deleted");
		// Lane GC then finds nothing to delete and the lane reaches `deleted`.
		const run = await h.core.gcLanes(h.clock.now() + 25 * 60 * 60 * 1000);
		deepStrictEqual(run.deleted, [lane.id]);
		equal(rowOf(h, lane.id).state, "deleted");
	},
);

repoLaneTest(
	"an import that completes after its JS-side timeout lands in attempt 1's repo; the lane opens on -2",
	async (h) => {
		const held = gate();
		h.capRoute.holdNext = held.promise;
		const lane = await openAs(h, AGENTS[0]);
		await until(() => h.capRoute.held === 1);
		// Attempt 1 times out JS-side; attempt 2 imports and opens.
		await until(() => rowOf(h, lane.id).state === "open", 5_000);
		const first = laneArtifactsName(h.repoId, lane.id.slice(3), 1);
		const second = laneArtifactsName(h.repoId, lane.id.slice(3), 2);
		equal(rowOf(h, lane.id).repo_name, second);
		const codes = eventsOfType(h, "lane.seed_failed").map((e) =>
			(e.data as { code: string }).code
		);
		deepStrictEqual(codes, ["import-timeout"]);
		held.open();
		await until(() => h.fake.inspect.names().includes(first));
		await h.settle();
		equal(rowOf(h, lane.id).repo_name, second, "still on attempt 2");
		const swept = await h.core.sweepLaneRepos(
			[first, second],
			h.clock.now() + LANE_ORPHAN_AGE_MS + 1,
		);
		deepStrictEqual(swept.deleted, [first]);
		deepStrictEqual(swept.kept, [second]);
	},
	{
		repoBackendPorts: {
			bound: (kind, ms) => kind === "import" ? 40 : ms,
		},
	},
);

repoLaneTest(
	"an eviction between import and verify is resumed by the watchdog's probe without a second import",
	async (h) => {
		const parked = h.fake.faults.inject({
			op: "repo.readCommit",
			fault: { kind: "hold" },
			times: 1,
		});
		const lane = await openAs(h, AGENTS[0]);
		await until(() => rowOf(h, lane.id).seed_phase === "verifying");
		h.clock.advance(60_000);
		const outcomes = await h.runTimers();
		ok(outcomes.every((o) => o.ok));
		equal(rowOf(h, lane.id).state, "open", "the probe verified and opened");
		equal(rowOf(h, lane.id).seed_attempt, 1);
		parked.release();
		await h.settle();
		equal(imports(h), 1);
		equal(eventsOfType(h, "lane.opened").length, 1);
		equal(eventsOfType(h, "lane.seed_failed").length, 0);
	},
	{
		repoBackendPorts: {
			bound: (kind, ms) => kind === "verify" ? 600_000 : ms,
		},
	},
);

repoLaneTest(
	"a stale continuation never overwrites a fallback (CAS on the attempt)",
	async (h) => {
		const lane = await openAs(h, AGENTS[0]);
		await h.settle();
		equal(rowOf(h, lane.id).state, "open");
		// A retried RPC or second driver re-runs attempt 1 and the watchdog fires.
		await h.core.seedLane(lane.id);
		equal(rowOf(h, lane.id).state, "open");
		equal(eventsOfType(h, "lane.opened").length, 1);
		equal(eventsOfType(h, "lane.seed_failed").length, 0);
	},
);

repoLaneTest(
	"the watchdog never fails an attempt still queued in the limiter; its clock starts when it runs",
	async (h) => {
		// Eight attempts hold every limiter slot (stalled at the index upsert);
		// a ninth lane's attempt waits behind them.
		const stalled = gate();
		const index = h.tree.indexArtifacts.bind(h.tree);
		let calls = 0;
		(h.tree as { indexArtifacts: unknown }).indexArtifacts = async (
			input: IndexArtifactsInput,
		) => {
			if (calls++ < LANE_SEED_CONCURRENCY) await stalled.promise;
			return await index(input);
		};
		const owners = "jkmnpqrst".split("").map((c) => `a_01k6${c.repeat(22)}`);
		const lanes = [];
		for (const owner of owners) lanes.push(await openAs(h, owner));
		await until(() => calls === LANE_SEED_CONCURRENCY);
		const last = lanes[LANE_SEED_CONCURRENCY];
		const planned = rowOf(h, last.id).seed_deadline as number;
		// Well past the deadline planned when the ninth lane opened.
		h.clock.advance(planned - h.clock.now() + 30_000);
		await h.runTimers();
		const waiting = rowOf(h, last.id);
		equal(waiting.seed_attempt, 1, "the queued attempt was not failed");
		equal(waiting.state, "opening");
		ok(
			(waiting.seed_deadline as number) > h.clock.now(),
			"its deadline moved past now",
		);
		equal(
			eventsOfType(h, "lane.seed_failed").filter((e) =>
				(e.data as { laneId: string }).laneId === last.id
			).length,
			0,
		);
		stalled.open();
		await h.settle();
		const opened = rowOf(h, last.id);
		equal(opened.state, "open");
		equal(opened.seed_attempt, 1, "it opened on its first attempt");
	},
);
