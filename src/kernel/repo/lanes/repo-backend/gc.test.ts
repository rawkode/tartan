// Lane-repo GC, archive and purge on the `repo` backend: a landed lane's repo
// goes 24 h after close only at the landed head and once the change ref holds
// it (else deferred, then alerted); a repo already gone is `missing`; an attic
// survives its retention; a vetoed loser goes at once.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { changeRef, LANE_REPO_HEAD_REF, ROLE } from "@tartan/contract";
import {
	ATTIC_RETENTION_DEFAULT_MS,
	LANE_DELETE_AFTER_CLOSE_MS,
} from "@tartan/contract";
import { LANE_GC_DEFER_ALERT_MS } from "../../../../constants.ts";
import { agentActor, rolesOf } from "../../../land/testing/harness.ts";
import {
	landRequest,
	QUEUE_INST,
	submitChange,
} from "../../../land/testing/lanes.ts";
import {
	AGENTS,
	eventsOfType,
	openSeeded,
	pushRepoLane,
	repoLaneTest,
	rowOf,
} from "./testing/lanes.ts";

const DAY = 24 * 60 * 60 * 1000;

/** One `repo` lane landed through LandWorkflow; returns the change. */
const landOne = async (h: Parameters<typeof rowOf>[0]) => {
	const lane = await openSeeded(h, AGENTS[0]);
	const pushed = await pushRepoLane(h, {
		laneId: lane.id,
		owner: AGENTS[0],
		files: { "src/x.ts": "export const x = 1;\n" },
	});
	const change = submitChange(h, pushed);
	const request = landRequest(h, [change]);
	await h.land.submit(request, QUEUE_INST);
	equal((await h.drive(request.batchId)).state, "landed");
	equal(rowOf(h, lane.id).state, "closed");
	return change;
};

const tampered = (h: Parameters<typeof rowOf>[0]) =>
	eventsOfType(h, "ref.tampered").length;

repoLaneTest(
	"a landed lane's repo is deleted 24 h after close at the landed head once its change ref exists",
	async (h) => {
		const change = await landOne(h);
		const name = rowOf(h, change.laneId).repo_name as string;
		const early = await h.core.gcLanes(h.clock.now() + DAY - 60_000);
		deepStrictEqual(early.deleted, [], "not before 24 h");
		const run = await h.core.gcLanes(
			h.clock.now() + LANE_DELETE_AFTER_CLOSE_MS + 60_000,
		);
		deepStrictEqual(run.deleted, [change.laneId]);
		ok(!h.fake.inspect.names().includes(name));
		equal(rowOf(h, change.laneId).state, "deleted");
		equal(h.index.get(name)?.state, "deleted");
		const deleted = eventsOfType(h, "lane.deleted").at(-1)?.data as {
			reason?: string;
		};
		equal(deleted.reason, "gc");
		// The intent was registered first and the trigger never raises K1/K2.
		const intent = h.storage.sql.exec(
			"SELECT expect_old, state FROM kernel_writes WHERE target = ? AND purpose = 'lane-delete'",
			change.laneId,
		).one();
		deepStrictEqual(intent, { expect_old: change.head, state: "pushed" });
		equal(tampered(h), 0);
	},
);

repoLaneTest(
	"without the change ref in the index GC defers, then alerts after 24 h, then deletes once it exists",
	async (h) => {
		const change = await landOne(h);
		const name = rowOf(h, change.laneId).repo_name as string;
		const ref = changeRef(change.changeId);
		const saved = h.storage.sql.exec("SELECT * FROM refs WHERE ref = ?", ref)
			.one();
		h.storage.sql.exec("DELETE FROM refs WHERE ref = ?", ref);
		const at = h.clock.now() + LANE_DELETE_AFTER_CLOSE_MS + 60_000;
		const deferred = await h.core.gcLanes(at);
		deepStrictEqual(deferred.deferred, [change.laneId]);
		ok(
			h.fake.inspect.names().includes(name),
			"kept: it may hold the only copy",
		);
		equal(
			h.notices.filter((n) =>
				(n.notice.data as { code?: string })?.code === "lane-gc-deferred"
			).length,
			0,
		);
		h.clock.set(at + LANE_GC_DEFER_ALERT_MS + 60_000);
		await h.core.gcLanes(h.clock.now());
		await h.settle();
		const alerts = h.notices.filter((n) =>
			(n.notice.data as { code?: string })?.code === "lane-gc-deferred"
		);
		equal(alerts.length, 1);
		equal(alerts[0].principal, AGENTS[0]);
		// The ref lands: GC proceeds.
		h.storage.sql.exec(
			"INSERT INTO refs (ref, sha, updated_at, push_id, peeled, reconciled_at) VALUES (?, ?, ?, ?, ?, ?)",
			saved.ref,
			saved.sha,
			saved.updated_at,
			saved.push_id,
			saved.peeled,
			saved.reconciled_at,
		);
		const run = await h.core.gcLanes(h.clock.now());
		deepStrictEqual(run.deleted, [change.laneId]);
	},
);

repoLaneTest(
	"a lane repo already gone is `missing`: the lane is deleted and nothing is tampered",
	async (h) => {
		const lane = await openSeeded(h, AGENTS[0]);
		const name = rowOf(h, lane.id).repo_name as string;
		await h.core.closeLane(lane.id, "done", agentActor(AGENTS[0]));
		await h.fake.delete(name);
		const run = await h.core.gcLanes(
			h.clock.now() + LANE_DELETE_AFTER_CLOSE_MS + 60_000,
		);
		deepStrictEqual(run.deleted, [lane.id]);
		const deleted = eventsOfType(h, "lane.deleted").at(-1)?.data as {
			reason?: string;
		};
		equal(deleted.reason, "missing");
		await h.observeAll();
		h.clock.advance(10 * 60 * 1000);
		await h.runTimers();
		equal(tampered(h), 0);
	},
);

repoLaneTest(
	"a head that moved after close is not deleted (K2 instead)",
	async (h) => {
		const lane = await openSeeded(h, AGENTS[0]);
		const name = rowOf(h, lane.id).repo_name as string;
		await h.core.closeLane(lane.id, "done", agentActor(AGENTS[0]));
		h.fake.commit(name, LANE_REPO_HEAD_REF, { "evil.ts": "x\n" }, {
			message: "foreign",
			author: { name: "x", email: "x@x.test" },
			at: 1,
			quiet: true,
		});
		const run = await h.core.gcLanes(
			h.clock.now() + LANE_DELETE_AFTER_CLOSE_MS + 60_000,
		);
		deepStrictEqual(run.skipped, [lane.id]);
		ok(h.fake.inspect.names().includes(name));
	},
);

repoLaneTest(
	"an archived loser keeps its lane repo until its attic retention; then GC deletes it",
	async (h) => {
		const lane = await openSeeded(h, AGENTS[0]);
		await pushRepoLane(h, {
			laneId: lane.id,
			owner: AGENTS[0],
			files: { "loser.ts": "x\n" },
		});
		const name = rowOf(h, lane.id).repo_name as string;
		const result = await h.core.archiveLane(lane.id, {}, agentActor(AGENTS[0]));
		equal(result.kind, "lane");
		if (result.kind === "lane") {
			equal(result.head, rowOf(h, lane.id).head_sha);
			equal(result.until, rowOf(h, lane.id).delete_after);
			ok(
				Math.abs(result.until - (h.clock.now() + ATTIC_RETENTION_DEFAULT_MS)) <
					5_000,
			);
		}
		const archived = eventsOfType(h, "lane.archived").at(-1)?.data as {
			atticHead?: string;
			atticUntil?: number;
		};
		ok(archived.atticHead && archived.atticUntil);
		const day = await h.core.gcLanes(h.clock.now() + DAY + 60_000);
		deepStrictEqual(day.deleted, []);
		ok(
			h.fake.inspect.names().includes(name),
			"the attic survives its first day",
		);
		const later = await h.core.gcLanes(
			h.clock.now() + ATTIC_RETENTION_DEFAULT_MS + 60_000,
		);
		deepStrictEqual(later.deleted, [lane.id]);
		ok(!h.fake.inspect.names().includes(name));
	},
);

repoLaneTest(
	"a vetoed loser's lane repo is deleted at once (summary only)",
	async (h) => {
		const lane = await openSeeded(h, AGENTS[0]);
		await pushRepoLane(h, {
			laneId: lane.id,
			owner: AGENTS[0],
			files: { "secret.ts": "x\n" },
		});
		const name = rowOf(h, lane.id).repo_name as string;
		h.gates = () =>
			Promise.resolve({
				calls: [],
				effective: [{
					installation: "i_01k6aaaaaaaaaaaaaaaaaaaaaa",
					ext: "acme.no-secrets",
					mode: "enforce",
					decision: "veto",
					message: "no",
				}] as never,
				blocked: true,
			});
		const result = await h.core.archiveLane(lane.id, {}, agentActor(AGENTS[0]));
		deepStrictEqual(result, { kind: "summary" });
		ok(!h.fake.inspect.names().includes(name), "deleted at once");
		equal(rowOf(h, lane.id).state, "archived");
		const run = await h.core.gcLanes(h.clock.now() + 60_000);
		deepStrictEqual(run.deleted, [lane.id]);
	},
);

repoLaneTest(
	"at the forge's lane-repo ceiling an archive keeps the summary only",
	async (h) => {
		const lane = await openSeeded(h, AGENTS[0]);
		equal(lane.mode, "repo");
		const name = rowOf(h, lane.id).repo_name as string;
		const result = await h.core.archiveLane(lane.id, {}, agentActor(AGENTS[0]));
		deepStrictEqual(result, { kind: "summary" });
		ok(!h.fake.inspect.names().includes(name));
	},
	{ laneRepoCeiling: 1 },
);

repoLaneTest(
	"an Owner's purge deletes a closed lane's repo at once",
	async (h) => {
		const lane = await openSeeded(h, AGENTS[0]);
		const name = rowOf(h, lane.id).repo_name as string;
		await h.core.closeLane(lane.id, "done", agentActor(AGENTS[0]));
		const owner = "u_01k6oooooooooooooooooooooo".replace(/o/g, "0");
		rolesOf(h).set(owner, ROLE.owner);
		await h.core.purgeLane(lane.id, { kind: "user", id: owner });
		ok(!h.fake.inspect.names().includes(name));
		equal(rowOf(h, lane.id).state, "deleted");
		const intent = h.storage.sql.exec(
			"SELECT purpose, state FROM kernel_writes WHERE target = ? AND purpose = 'purge'",
			lane.id,
		).one();
		deepStrictEqual(intent, { purpose: "purge", state: "pushed" });
		await h.observeAll();
		h.clock.advance(10 * 60 * 1000);
		await h.runTimers();
		equal(tampered(h), 0);
	},
);
