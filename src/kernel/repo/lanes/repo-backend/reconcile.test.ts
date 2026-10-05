// K1/K2 for lane repos (K2): the seed (its trigger event, if any, and a
// reconciliation of the seeded `main`) raises nothing; a foreign write to a
// lane repo's `main`, a new tag in a lane repo or a lane repo deleted under an
// open lane quarantines that lane only, found by the trigger or by
// reconciliation alone.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { LANE_REPO_HEAD_REF } from "@tartan/contract";
import { LANE_RECONCILE_PER_S } from "../../../../constants.ts";
import {
	AGENTS,
	eventsOfType,
	openSeeded,
	pushRepoLane,
	repoLaneTest,
	rowOf,
} from "./testing/lanes.ts";

const pastGrace = async (h: Parameters<typeof rowOf>[0]) => {
	for (let i = 0; i < 3; i++) {
		h.clock.advance(10 * 60 * 1000);
		await h.runTimers();
		await h.settle();
	}
};

const foreignCommit = (
	h: Parameters<typeof rowOf>[0],
	name: string,
	quiet: boolean,
) =>
	h.fake.commit(name, LANE_REPO_HEAD_REF, { "evil.ts": "x\n" }, {
		message: "foreign",
		author: { name: "x", email: "x@x.test" },
		at: 1,
		quiet,
	});

repoLaneTest(
	"the seed's trigger event and a reconciliation of the seeded main raise nothing",
	async (h) => {
		const imported = await openSeeded(h, AGENTS[0]);
		const pushed = await pushRepoLane(h, {
			laneId: imported.id,
			owner: AGENTS[0],
			files: { "a.ts": "a\n" },
		});
		await h.observeAll();
		const run = await h.core.reconcileLaneRepos(h.clock.now());
		equal(run.checked, 1);
		equal(run.observed, 0);
		await pastGrace(h);
		equal(eventsOfType(h, "ref.tampered").length, 0);
		equal(rowOf(h, imported.id).quarantined, 0);
		equal(rowOf(h, imported.id).head_sha, pushed.head);
	},
);

repoLaneTest(
	"with the trigger off, reconciliation alone finds a foreign write to a lane repo and quarantines that lane only",
	async (h) => {
		const victim = await openSeeded(h, AGENTS[0]);
		const bystander = await openSeeded(h, AGENTS[1]);
		foreignCommit(h, rowOf(h, victim.id).repo_name as string, true);
		const run = await h.core.reconcileLaneRepos(h.clock.now());
		equal(run.checked, 2);
		equal(run.observed, 1);
		await pastGrace(h);
		equal(rowOf(h, victim.id).quarantined, 1);
		equal(rowOf(h, bystander.id).quarantined, 0);
		const paused = h.storage.sql.exec(
			"SELECT v FROM meta WHERE k = 'landing_paused'",
		).toArray()[0]?.v ?? "0";
		equal(paused, "0", "landing elsewhere continues");
	},
);

repoLaneTest(
	"the trigger event of a foreign write quarantines the lane",
	async (h) => {
		const lane = await openSeeded(h, AGENTS[0]);
		foreignCommit(h, rowOf(h, lane.id).repo_name as string, false);
		await h.observeAll();
		await pastGrace(h);
		equal(rowOf(h, lane.id).quarantined, 1);
	},
);

repoLaneTest("a new tag in a lane repo quarantines that lane", async (h) => {
	const lane = await openSeeded(h, AGENTS[0]);
	const name = rowOf(h, lane.id).repo_name as string;
	h.fake.setRef(name, "refs/tags/sneaky", lane.base, { quiet: true });
	const run = await h.core.reconcileLaneRepos(h.clock.now());
	equal(run.observed, 1);
	await pastGrace(h);
	equal(rowOf(h, lane.id).quarantined, 1);
});

repoLaneTest(
	"a lane repo deleted under an open lane is observed as main → zeros",
	async (h) => {
		const lane = await openSeeded(h, AGENTS[0]);
		await h.fake.delete(rowOf(h, lane.id).repo_name as string);
		const run = await h.core.reconcileLaneRepos(h.clock.now());
		deepStrictEqual(run, { checked: 1, observed: 1 });
		// WP5a's K2 rules decide what the observation means (its push log
		// explains zeros → the seeded base as a stale read); such a lane can
		// never land, since compose reads it by SHA from its lane repo.
	},
);

repoLaneTest(
	"reconciliation is paced and idle lanes are read at most hourly",
	async (h) => {
		await openSeeded(h, AGENTS[0]);
		await openSeeded(h, AGENTS[1]);
		await openSeeded(h, AGENTS[2]);
		const before = h.clock.now();
		const run = await h.core.reconcileLaneRepos(before);
		equal(run.checked, 3);
		ok(
			h.clock.now() - before >= 2 * Math.ceil(1000 / LANE_RECONCILE_PER_S),
			"≤ 2 reads per second",
		);
		const again = await h.core.reconcileLaneRepos(h.clock.now() + 60_000);
		deepStrictEqual(again, { checked: 0, observed: 0 });
		const hourly = await h.core.reconcileLaneRepos(h.clock.now() + 61 * 60_000);
		equal(hourly.checked, 3);
	},
);
