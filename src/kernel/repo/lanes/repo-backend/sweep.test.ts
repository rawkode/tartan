// The orphan sweep: a lane repo of a lane that OPENED is never the sweep's;
// superseded attempts, repos of lanes closed while `opening`, of lanes that
// fell back to `branch`, and `l-*` repos with no lane row are deleted once
// older than 15 minutes, each after a `lane-delete` intent. Driven through the
// real `repoBackend` cron body.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { createUlid, laneArtifactsName } from "@tartan/contract";
import { LANE_ORPHAN_AGE_MS } from "../../../../constants.ts";
import { agentActor } from "../../../land/testing/harness.ts";
import { runRepoBackendCron } from "./cron.ts";
import { orphanVerdict } from "./sweep.ts";
import {
	AGENTS,
	openAs,
	openSeeded,
	pushRepoLane,
	repoLaneTest,
	rowOf,
} from "./testing/lanes.ts";
import type { LaneRow } from "@tartan/contract/kernel.ts";

const until = async (check: () => boolean, ms = 2_000): Promise<void> => {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("condition not reached");
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
};

const name = (repoId: string, laneId: string, attempt = 1) =>
	laneArtifactsName(repoId, laneId.slice(3), attempt);

repoLaneTest(
	"the sweep keeps an archived loser and a closed lane, and deletes every orphan after an intent",
	async (h) => {
		// An archived loser and a closed lane: both opened, so never swept.
		const loser = await openSeeded(h, AGENTS[0]);
		await pushRepoLane(h, {
			laneId: loser.id,
			owner: AGENTS[0],
			files: { "a.ts": "a\n" },
		});
		const archived = await h.core.archiveLane(
			loser.id,
			{},
			agentActor(AGENTS[0]),
		);
		equal(archived.kind, "lane");
		const closed = await openSeeded(h, AGENTS[1]);
		await h.core.closeLane(closed.id, "done", agentActor(AGENTS[1]));
		// A superseded attempt: attempt 1's repo exists but did not verify.
		h.fake.faults.inject({
			op: "repo.readCommit",
			fault: { kind: "error", code: "INTERNAL_ERROR" },
			times: 1,
		});
		const superseded = await openSeeded(h, AGENTS[2]);
		equal(superseded.state, "open");
		equal(rowOf(h, superseded.id).seed_attempt, 2);
		// A lane closed while `opening`, its pack already in flight.
		let release!: () => void;
		h.capRoute.holdNext = new Promise((resolve) => {
			release = resolve;
		});
		const cancelled = await openAs(h, AGENTS[3]);
		await until(() => h.capRoute.held === 1);
		await h.core.closeLane(cancelled.id, "cancel", agentActor(AGENTS[3]));
		release();
		await until(() =>
			h.fake.inspect.names().includes(name(h.repoId, cancelled.id))
		);
		await h.settle();
		// A lane that fell back to branch after two imported, unverified repos.
		h.fake.faults.inject({
			op: "repo.readCommit",
			fault: { kind: "error", code: "INTERNAL_ERROR" },
			times: 2,
		});
		const fellBack = await openSeeded(h, AGENTS[0]);
		equal(fellBack.mode, "branch");
		// An `l-*` repo of this family with no lane row at all.
		const stray = laneArtifactsName(h.repoId, createUlid()(), 1);
		await h.fake.create(stray);

		const keep = [
			name(h.repoId, loser.id),
			name(h.repoId, closed.id),
			name(h.repoId, superseded.id, 2),
		];
		const orphans = [
			name(h.repoId, superseded.id, 1),
			name(h.repoId, cancelled.id, 1),
			name(h.repoId, fellBack.id, 1),
			name(h.repoId, fellBack.id, 2),
		];
		for (const n of [...keep, ...orphans, stray]) {
			ok(h.fake.inspect.names().includes(n), `${n} exists`);
		}
		const cron = (now: number) =>
			runRepoBackendCron({
				artifacts: h.fake,
				tree: h.tree,
				core: () => h.core,
				log: () => {},
			}, now);
		// Too young: nothing goes (the stray name is first seen now).
		const early = await cron(h.clock.now());
		deepStrictEqual(early.swept.deleted, []);
		ok(early.swept.kept.includes(stray));
		// 16 minutes on, every orphan goes.
		const first = await cron(h.clock.now() + LANE_ORPHAN_AGE_MS + 60_000);
		deepStrictEqual(
			[...first.swept.deleted].sort(),
			[...orphans, stray].sort(),
		);
		// A later run finds nothing more to do.
		const second = await cron(
			h.clock.now() + 2 * (LANE_ORPHAN_AGE_MS + 60_000),
		);
		deepStrictEqual(second.swept.deleted, []);
		for (const n of keep) ok(h.fake.inspect.names().includes(n), `${n} kept`);
		for (const n of [...orphans, stray]) {
			ok(!h.fake.inspect.names().includes(n), `${n} deleted`);
			equal(h.index.get(n)?.state ?? "deleted", "deleted");
		}
		// Each deletion of a lane's repo registered its intent first.
		for (const laneId of [superseded.id, cancelled.id, fellBack.id]) {
			const intents = h.storage.sql.exec(
				"SELECT COUNT(*) AS n FROM kernel_writes WHERE target = ? AND purpose = 'lane-delete' AND state = 'pushed'",
				laneId,
			).one().n;
			ok(Number(intents) >= 1, `intent for ${laneId}`);
		}
		equal(rowOf(h, loser.id).state, "archived");
		equal(rowOf(h, closed.id).state, "closed");
	},
);

Deno.test("orphanVerdict: the exact orphan predicate", () => {
	const row = (over: Partial<LaneRow>): LaneRow =>
		({
			id: "ln_x",
			repo_name: "l-a-b",
			state: "open",
			seed_attempt: 1,
			seed_ms: 10,
			...over,
		}) as LaneRow;
	deepStrictEqual(orphanVerdict("l-a-b", 1, null), { delete: true, rule: "a" });
	equal(
		orphanVerdict("l-a-b", 1, row({ repo_name: "l-a-b-2", seed_attempt: 2 }))
			.delete,
		true,
	);
	equal(
		orphanVerdict(
			"l-a-b-2",
			2,
			row({ repo_name: "l-a-b", state: "opening", seed_attempt: 2 }),
		).delete,
		false,
		"a live attempt",
	);
	equal(
		orphanVerdict(
			"l-a-b",
			1,
			row({ repo_name: null, mode: "branch" } as Partial<LaneRow>),
		).delete,
		true,
	);
	deepStrictEqual(
		orphanVerdict("l-a-b", 1, row({ state: "closed", seed_ms: null })),
		{ delete: true, rule: "c" },
	);
	equal(
		orphanVerdict("l-a-b", 1, row({ state: "closed" })).delete,
		false,
		"opened: GC's",
	);
	equal(orphanVerdict("l-a-b", 1, row({ state: "archived" })).delete, false);
	equal(
		orphanVerdict("l-a-b", 1, row({ state: "opening", seed_ms: null })).delete,
		false,
	);
});
