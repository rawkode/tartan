// `lanes_sync` and `lanes_restack` (WP10 git jobs behind WP5a's facade): a
// server-side rebase in the mirror that keeps each commit's author and message,
// pushed with a lease into the lane's OWN storage only (its lane repo on the
// `repo` backend, its branch ref on `branch`), registered first as a
// `lane-sync` intent with target = the lane, so no `ref.tampered`. Conflicts
// are reported with their regions and nothing is written.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { fromRpcError, LANE_REPO_HEAD_REF, trunkRef } from "@tartan/contract";
import {
	AGENTS,
	openSeeded,
	pushRepoLane,
	repoLaneTest,
	rowOf,
} from "../repo/lanes/repo-backend/testing/lanes.ts";
import { agentActor, type LandHarness, landTest } from "./testing/harness.ts";
import {
	landRequest,
	pushLane,
	QUEUE_INST,
	submitChange,
	trunkOf,
} from "./testing/lanes.ts";

const commitOf = async (h: LandHarness, repo: string, sha: string) =>
	await (await h.fake.get(repo)).readCommit(sha);

const landOne = async (
	h: LandHarness,
	lane: { laneId: string; head: string; pushId?: string },
) => {
	const change = submitChange(h, lane);
	const request = landRequest(h, [change]);
	await h.land.submit(request, QUEUE_INST);
	const result = await h.drive(request.batchId);
	equal(result.state, "landed");
	return result;
};

const noTamper = async (h: LandHarness): Promise<void> => {
	await h.observeAll();
	for (let i = 0; i < 3; i++) {
		h.clock.advance(10 * 60 * 1000);
		await h.runTimers();
		await h.settle();
	}
	const types = h.events.read({ since: 0, limit: 10_000 }).map((e) => e.type);
	ok(!types.includes("ref.tampered"), `ref.tampered: ${types}`);
	for (
		const row of h.storage.sql.exec("SELECT id, quarantined FROM lanes")
			.toArray()
	) equal(row.quarantined, 0, `lane ${row.id} quarantined`);
};

const syncIntents = (h: LandHarness, laneId: string) =>
	h.storage.sql.exec(
		"SELECT target, ref, state, purpose FROM kernel_writes WHERE purpose = 'lane-sync' AND target = ?",
		laneId,
	).toArray();

landTest(
	"sync rebases a branch lane onto a moved trunk, author kept, pushed to its own ref only",
	async (h) => {
		const x = await pushLane(h, {
			owner: AGENTS[0],
			files: { "src/x.ts": "export const x = 1;\n" },
		});
		const y = await pushLane(h, {
			owner: AGENTS[1],
			files: { "src/y.ts": "export const y = 2;\n" },
			message: "add y",
		});
		await landOne(h, x);
		const trunk = await trunkOf(h);
		const result = await h.core.syncLane(y.laneId, agentActor(AGENTS[1]));
		ok(result.ok, JSON.stringify(result));
		if (!result.ok) return;
		const rebased = await commitOf(h, h.canonical, result.head);
		deepStrictEqual(rebased?.parents, [trunk]);
		equal(rebased?.author.name, AGENTS[1]);
		equal(rebased?.message.trim(), "add y");
		const lane = await h.core.getLane(y.laneId);
		equal(lane?.head, result.head);
		equal(h.fake.inspect.refs(h.canonical)[lane?.ref as string], result.head);
		deepStrictEqual(syncIntents(h, y.laneId), [{
			target: y.laneId,
			ref: lane?.ref,
			state: "pushed",
			purpose: "lane-sync",
		}]);
		ok(
			h.events.read({ since: 0, limit: 10_000 }).some((e) =>
				e.type === "lane.synced"
			),
		);
		await noTamper(h);
	},
);

landTest(
	"a sync conflict reports its paths and regions and writes nothing",
	async (h) => {
		const x = await pushLane(h, {
			owner: AGENTS[0],
			files: { "src/shared.ts": "export const v = 'x';\n" },
		});
		const y = await pushLane(h, {
			owner: AGENTS[1],
			files: { "src/shared.ts": "export const v = 'y';\n" },
		});
		await landOne(h, x);
		const before = (await h.core.getLane(y.laneId))?.head;
		const result = await h.core.syncLane(y.laneId, agentActor(AGENTS[1]));
		equal(result.ok, false);
		if (result.ok) return;
		deepStrictEqual(result.conflicts.map((c) => c.path), ["src/shared.ts"]);
		ok(result.conflicts[0].regions.length >= 1);
		equal((await h.core.getLane(y.laneId))?.head, before);
		deepStrictEqual(syncIntents(h, y.laneId), []);
	},
);

landTest(
	"a sync of a lane already on trunk is a no-op (no intent, no push)",
	async (h) => {
		const y = await pushLane(h, {
			owner: AGENTS[1],
			files: { "src/y.ts": "y\n" },
		});
		const result = await h.core.syncLane(y.laneId, agentActor(AGENTS[1]));
		deepStrictEqual(result, { ok: true, head: y.head });
		deepStrictEqual(syncIntents(h, y.laneId), []);
	},
);

landTest(
	"sync is refused while the lane is landing (the freeze)",
	async (h) => {
		const y = await pushLane(h, {
			owner: AGENTS[1],
			files: { "src/y.ts": "y\n" },
		});
		const change = submitChange(h, y);
		await h.land.submit(landRequest(h, [change]), QUEUE_INST);
		equal((await h.core.getLane(y.laneId))?.state, "landing");
		const refused = await h.core.syncLane(y.laneId, agentActor(AGENTS[1]))
			.catch((e: unknown) => e);
		equal(fromRpcError(refused).code, "conflict");
	},
);

repoLaneTest(
	"sync of a repo lane fetches from two repos and pushes only into its lane repo",
	async (h) => {
		const a = await openSeeded(h, AGENTS[0]);
		const b = await openSeeded(h, AGENTS[1]);
		const pushedA = await pushRepoLane(h, {
			laneId: a.id,
			owner: AGENTS[0],
			files: { "src/a.ts": "a\n" },
			message: "add a",
		});
		const pushedB = await pushRepoLane(h, {
			laneId: b.id,
			owner: AGENTS[1],
			files: { "src/b.ts": "b\n" },
		});
		await landOne(h, pushedB);
		const trunk = await h.core.resolveRef(trunkRef("main")) as string;
		const canonicalBefore = h.fake.inspect.refs(h.canonical);
		const name = rowOf(h, a.id).repo_name as string;
		const execsBefore = h.execs.length;
		const result = await h.core.syncLane(a.id, agentActor(AGENTS[0]));
		ok(result.ok, JSON.stringify(result));
		if (!result.ok) return;
		const rebased = await commitOf(h, name, result.head);
		deepStrictEqual(rebased?.parents, [trunk]);
		equal(rebased?.author.name, AGENTS[0]);
		equal(rebased?.message.trim(), "add a");
		deepStrictEqual(h.fake.inspect.refs(name), {
			[LANE_REPO_HEAD_REF]: result.head,
		});
		deepStrictEqual(
			h.fake.inspect.refs(h.canonical),
			canonicalBefore,
			"nothing written to the canonical repo",
		);
		equal(rowOf(h, a.id).head_sha, result.head);
		// The push exec carried one token, for the lane repo alone.
		const push = h.execs.slice(execsBefore).find((e) =>
			e.argv.includes("push")
		);
		ok(push !== undefined);
		ok(push.argv.includes(h.fake.remote(name)));
		const headers = Object.entries(push.env).filter(([k, v]) =>
			k.startsWith("GIT_CONFIG_KEY_") && v.endsWith(".extraHeader")
		).map(([, v]) => v);
		deepStrictEqual(headers, [`http.${h.fake.remote(name)}.extraHeader`]);
		equal(push.uid, "tartan-push");
		deepStrictEqual(syncIntents(h, a.id), [{
			target: a.id,
			ref: LANE_REPO_HEAD_REF,
			state: "pushed",
			purpose: "lane-sync",
		}]);
		void pushedA;
		await noTamper(h);
	},
);

repoLaneTest(
	"restack of a repo lane onto another lane replays only its own commits on that lane's head",
	async (h) => {
		const a = await openSeeded(h, AGENTS[0]);
		const b = await openSeeded(h, AGENTS[1]);
		await pushRepoLane(h, {
			laneId: a.id,
			owner: AGENTS[0],
			files: { "src/a.ts": "a\n" },
			message: "add a",
		});
		const pushedB = await pushRepoLane(h, {
			laneId: b.id,
			owner: AGENTS[1],
			files: { "src/b.ts": "b\n" },
		});
		const result = await h.core.restackLane(a.id, b.id, agentActor(AGENTS[0]));
		ok(result.ok, JSON.stringify(result));
		if (!result.ok) return;
		const name = rowOf(h, a.id).repo_name as string;
		const rebased = await commitOf(h, name, result.head);
		deepStrictEqual(rebased?.parents, [pushedB.head], "on B's head");
		equal(rebased?.message.trim(), "add a");
		equal(rowOf(h, a.id).depends_on_lane, b.id);
		equal(rowOf(h, a.id).head_sha, result.head);
		// B's lane repo is untouched.
		deepStrictEqual(
			h.fake.inspect.refs(rowOf(h, b.id).repo_name as string),
			{ [LANE_REPO_HEAD_REF]: pushedB.head },
		);
		await noTamper(h);
	},
);
