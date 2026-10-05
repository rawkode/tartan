// land.submit (K4, K1, K2), compose outcomes (conflicts with
// regions, vetoes and the recompose), attempt-bound verdicts (K14),
// lane release on every non-landing outcome and the head check at
// complete-n, on the land harness (real modules, stock git).

import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { candidateRef, fromRpcError, trunkRef } from "@tartan/contract";
import type { GateDispatchResult } from "@tartan/contract/kernel.ts";
import {
	agentActor,
	eventsOf,
	eventTypes,
	landTest,
	providerEvent,
	settleObservations,
} from "./testing/harness.ts";
import {
	landRequest,
	newChangeId,
	pushLane,
	QUEUE_INST,
	submitChange,
	trunkOf,
} from "./testing/lanes.ts";
import { createFakeStep } from "./testing/step.ts";

const A = "a_01k6eeeeeeeeeeeeeeeeeeeeee";
const B = "a_01k6ffffffffffffffffffffff";
const C = "a_01k6gggggggggggggggggggggg";

const code = async (p: Promise<unknown>): Promise<string> => {
	try {
		await p;
	} catch (error) {
		const e = fromRpcError(error);
		return `${e.code}${e.reason ? `(${e.reason})` : ""}: ${e.text}`;
	}
	return "ok";
};

landTest(
	"K4: an empty, a foreign or a queue-only reason chain is refused",
	async (h) => {
		const lane = await pushLane(h, { owner: A, files: { "a.txt": "a\n" } });
		const change = submitChange(h, lane);
		// Empty: the schema requires at least one event.
		ok(
			(await code(
				h.land.submit(landRequest(h, [change], { events: [] }), QUEUE_INST),
			))
				.startsWith("invalid"),
		);
		// A well-formed id that is not in this repo's log.
		const foreign = await code(
			h.land.submit(
				landRequest(h, [change], {
					events: [...change.events, "01k6zzzzzzzzzzzzzzzzzzzzzz"],
				}),
				QUEUE_INST,
			),
		);
		ok(foreign.startsWith("invalid: reason-chain"), foreign);
		// The queue provider's own events never suffice.
		const queued = providerEvent(h, {
			type: "queue.enqueued",
			installation: QUEUE_INST,
			data: { changeId: change.changeId, partition: "*" },
		});
		const queueOnly = await code(
			h.land.submit(landRequest(h, [change], { events: [queued] }), QUEUE_INST),
		);
		ok(queueOnly.startsWith("invalid: reason-chain"), queueOnly);
		// Submitted but never approved.
		const unapproved = await code(
			h.land.submit(
				landRequest(h, [change], { events: [change.events[0]] }),
				QUEUE_INST,
			),
		);
		ok(unapproved.includes("no approval"), unapproved);
		// Nothing was frozen or created by the refusals.
		equal((await h.core.getLane(lane.laneId))?.state, "submitted");
		equal(h.instances.length, 0);
		// The full chain lands.
		const request = landRequest(h, [change]);
		await h.land.submit(request, QUEUE_INST);
		equal((await h.drive(request.batchId)).state, "landed");
	},
);

landTest(
	"head-moved and an approval of another head are refused",
	async (h) => {
		const lane = await pushLane(h, { owner: A, files: { "a.txt": "a\n" } });
		const change = submitChange(h, lane);
		const other = await pushLane(h, { owner: B, files: { "b.txt": "b\n" } });
		const moved = await code(
			h.land.submit(
				landRequest(h, [{ ...change, head: other.head }]),
				QUEUE_INST,
			),
		);
		ok(moved.startsWith("conflict: head-moved"), moved);
		const lane2 = await pushLane(h, { owner: C, files: { "c.txt": "c\n" } });
		const stale = submitChange(h, lane2, { approvalHead: lane.head });
		const approval = await code(
			h.land.submit(landRequest(h, [stale]), QUEUE_INST),
		);
		ok(approval.includes("another head"), approval);
	},
);

landTest(
	"submit is idempotent on the batch id; other content is a conflict",
	async (h) => {
		const lane = await pushLane(h, { owner: A, files: { "a.txt": "a\n" } });
		const change = submitChange(h, lane);
		const request = landRequest(h, [change]);
		deepStrictEqual(await h.land.submit(request, QUEUE_INST), {
			batchId: request.batchId,
			created: true,
		});
		deepStrictEqual(await h.land.submit(request, QUEUE_INST), {
			batchId: request.batchId,
			created: false,
		});
		equal(h.instances.length, 1);
		const other = await code(
			h.land.submit({ ...request, testPolicy: "checks" }, QUEUE_INST),
		);
		ok(other.startsWith("conflict: batch-exists"), other);
	},
);

landTest(
	"K1: landing_paused refuses a submit; K2: a quarantined lane cannot be submitted",
	async (h) => {
		const lane = await pushLane(h, { owner: A, files: { "a.txt": "a\n" } });
		const change = submitChange(h, lane);
		h.storage.transactionSync(() => h.coreInternal.setLandingPausedSync(true));
		const paused = await code(
			h.land.submit(landRequest(h, [change]), QUEUE_INST),
		);
		ok(paused.startsWith("denied(landing-paused)"), paused);
		h.storage.transactionSync(() => h.coreInternal.setLandingPausedSync(false));

		// A foreign write to the lane head (no gateway record) quarantines it.
		const trunk = await trunkOf(h);
		const scratch = "refs/scratch/foreign";
		h.fake.setRef(h.canonical, scratch, trunk, { quiet: true });
		const foreign = h.fake.commit(h.canonical, scratch, { "evil.txt": "x\n" }, {
			message: "foreign",
			quiet: true,
		});
		h.fake.setRef(h.canonical, `refs/heads/lanes/${lane.laneId}`, foreign);
		await settleObservations(h);
		equal(h.coreInternal.laneSync(lane.laneId)?.quarantined, 1);
		const quarantined = await code(
			h.land.submit(landRequest(h, [change]), QUEUE_INST),
		);
		ok(quarantined.startsWith("conflict: lane-quarantined"), quarantined);
	},
);

landTest(
	"a conflict is recorded with its regions; the batch lands the rest and releases the lane",
	async (h) => {
		// Trunk gets a shared file first.
		const seed = submitChange(
			h,
			await pushLane(h, {
				owner: C,
				files: { "shared.txt": "l1\nl2\nl3\n" },
			}),
		);
		const first = landRequest(h, [seed]);
		await h.land.submit(first, QUEUE_INST);
		equal((await h.drive(first.batchId)).state, "landed");
		const a = submitChange(
			h,
			await pushLane(h, { owner: A, files: { "shared.txt": "l1\nA\nl3\n" } }),
		);
		const b = submitChange(
			h,
			await pushLane(h, { owner: B, files: { "shared.txt": "l1\nB\nl3\n" } }),
		);
		const request = landRequest(h, [a, b]);
		await h.land.submit(request, QUEUE_INST);
		const result = await h.drive(request.batchId);
		equal(result.state, "landed");
		deepStrictEqual(result.landed?.map((l) => l.changeId), [a.changeId]);
		const [conflicted] = eventsOf(h, "land.conflicted");
		const data = conflicted.data as {
			changeId: string;
			paths: string[];
			conflictsWith: string[];
			regions: { path: string; regions: { oursStart: number }[] }[];
		};
		equal(data.changeId, b.changeId);
		deepStrictEqual(data.paths, ["shared.txt"]);
		deepStrictEqual(data.conflictsWith, [a.changeId]);
		equal(data.regions[0].path, "shared.txt");
		equal(data.regions[0].regions[0].oursStart, 2);
		// B's lane is back to `submitted` (pushes reopen); A's is closed.
		equal((await h.core.getLane(b.laneId))?.state, "submitted");
		equal((await h.core.getLane(a.laneId))?.state, "closed");
		const status = await h.land.status(request.batchId);
		deepStrictEqual(
			status?.changes.map((c) => c.outcome),
			["landed", "conflicted"],
		);
		await settleObservations(h);
		ok(!eventTypes(h).includes("ref.tampered"));
	},
);

landTest(
	"a batch whose every change conflicts ends conflicted and releases its lanes",
	async (h) => {
		const seed = submitChange(
			h,
			await pushLane(h, { owner: C, files: { "s.txt": "1\n2\n3\n" } }),
		);
		const first = landRequest(h, [seed]);
		await h.land.submit(first, QUEUE_INST);
		await h.drive(first.batchId);
		// Lane based on the old trunk, editing the line trunk also changed.
		const stale = await pushLane(h, {
			owner: A,
			files: { "s.txt": "1\nX\n3\n" },
			parent: (await h.land.status(first.batchId))?.baseSha,
		});
		const change = submitChange(h, stale);
		const late = submitChange(
			h,
			await pushLane(h, { owner: B, files: { "s.txt": "1\nY\n3\n" } }),
		);
		const mid = landRequest(h, [late]);
		await h.land.submit(mid, QUEUE_INST);
		await h.drive(mid.batchId);
		const request = landRequest(h, [change]);
		await h.land.submit(request, QUEUE_INST);
		const result = await h.drive(request.batchId);
		equal(result.state, "conflicted");
		equal((await h.core.getLane(change.laneId))?.state, "submitted");
		const failed = eventsOf(h, "land.failed").at(-1)?.data as {
			reason: string;
		};
		equal(failed.reason, "conflicted");
	},
);

landTest(
	"a vetoed change is dropped and the rest is recomposed in attempt 2",
	async (h) => {
		const a = submitChange(
			h,
			await pushLane(h, { owner: A, files: { "a.txt": "a\n" } }),
		);
		const b = submitChange(
			h,
			await pushLane(h, { owner: B, files: { "b.txt": "b\n" } }),
		);
		const trunk = await trunkOf(h);
		const seen: string[] = [];
		h.gates = (input): Promise<GateDispatchResult> => {
			const changeId = (input as { changeId: string }).changeId;
			seen.push(changeId);
			const veto = changeId === a.changeId;
			return Promise.resolve({
				calls: [],
				effective: [{
					installation: "i_01k6hhhhhhhhhhhhhhhhhhhhhh",
					ext: "acme.no-secrets@0.1.0",
					mode: "enforce",
					decision: veto ? "veto" : "allow",
					message: veto ? "a secret" : "clean",
					basis: "answer",
				}],
				blocked: veto,
			});
		};
		const request = landRequest(h, [a, b]);
		await h.land.submit(request, QUEUE_INST);
		const result = await h.drive(request.batchId);
		equal(result.state, "landed");
		deepStrictEqual(result.landed?.map((l) => l.changeId), [b.changeId]);
		// Attempt 2 composed B alone on trunk.
		const repo = await h.fake.get(h.canonical);
		const commit = await repo.readCommit(result.landed?.[0].commit as string);
		deepStrictEqual(commit?.parents, [trunk]);
		ok(
			commit?.message.includes(
				`Tartan-Advance: adv_${request.batchId.slice(3)}_2`,
			),
		);
		deepStrictEqual(seen, [a.changeId, b.changeId, b.changeId]);
		const vetoed = eventsOf(h, "land.vetoed")[0]?.data as { changeId: string };
		equal(vetoed.changeId, a.changeId);
		equal(eventsOf(h, "gate.decided").length, 3);
		equal((await h.core.getLane(a.laneId))?.state, "submitted");
		const status = await h.land.status(request.batchId);
		equal(status?.attempt, 2);
		deepStrictEqual(status?.changes.map((c) => c.outcome), [
			"vetoed",
			"landed",
		]);
		// The candidate ref of attempt 1 was moved to attempt 2's candidate.
		equal(
			h.fake.inspect.refs(h.canonical)[candidateRef(request.batchId)],
			result.landed?.[0].commit,
		);
		await settleObservations(h);
		ok(!eventTypes(h).includes("ref.tampered"));
	},
);

landTest(
	"the ref.advance gate input carries the composed commit as head and the approved lane head as laneHead",
	async (h) => {
		const a = submitChange(
			h,
			await pushLane(h, { owner: A, files: { "a.txt": "a\n" } }),
		);
		const inputs: { head: string; laneHead?: string; changeId: string }[] = [];
		h.gates = (input): Promise<GateDispatchResult> => {
			inputs.push(input as (typeof inputs)[number]);
			return Promise.resolve({ calls: [], effective: [], blocked: false });
		};
		const request = landRequest(h, [a]);
		await h.land.submit(request, QUEUE_INST);
		const result = await h.drive(request.batchId);
		equal(result.state, "landed");
		equal(inputs.length, 1);
		equal(inputs[0].changeId, a.changeId);
		equal(inputs[0].laneHead, a.head, "the head approvals bind to (K4)");
		equal(inputs[0].head, result.landed?.[0].commit);
		ok(inputs[0].head !== a.head, "the squash commit is not the lane head");
	},
);

landTest(
	"a batch whose only change is vetoed ends vetoed and releases the lane",
	async (h) => {
		const a = submitChange(
			h,
			await pushLane(h, { owner: A, files: { "a.txt": "a\n" } }),
		);
		h.gates = () =>
			Promise.resolve({
				calls: [],
				effective: [{
					installation: "i_01k6hhhhhhhhhhhhhhhhhhhhhh",
					ext: "acme.no-secrets@0.1.0",
					mode: "enforce",
					decision: "veto",
					message: "no",
					basis: "answer",
				}],
				blocked: true,
			});
		const request = landRequest(h, [a]);
		await h.land.submit(request, QUEUE_INST);
		equal((await h.drive(request.batchId)).state, "vetoed");
		equal((await h.core.getLane(a.laneId))?.state, "submitted");
		equal(await trunkOf(h), (await h.land.status(request.batchId))?.baseSha);
	},
);

landTest(
	"K14: verdicts are bound to (attempt, candidate); the event and the poll both work",
	async (h) => {
		const a = submitChange(
			h,
			await pushLane(h, { owner: A, files: { "a.txt": "a\n" } }),
		);
		const request = landRequest(h, [a], { testPolicy: "checks" });
		await h.land.submit(request, QUEUE_INST);
		const step = createFakeStep({ clock: h.clock });
		step.onWait = async (name) => {
			if (name !== "verdict-1-1") return;
			const st = await h.land.status(request.batchId);
			const cand = st?.candidateSha as string;
			// The wrong candidate, a wrong attempt, then the real verdict.
			deepStrictEqual(
				await h.land.report(request.batchId, {
					attempt: 1,
					candidateSha: a.head,
					state: "success",
					runIds: [],
					evidence: null,
				}, "i_ci"),
				{ accepted: false, reason: "wrong-candidate" },
			);
			deepStrictEqual(
				await h.land.report(request.batchId, {
					attempt: 2,
					candidateSha: cand,
					state: "success",
					runIds: [],
					evidence: null,
				}, "i_ci"),
				{ accepted: false, reason: "stale-attempt" },
			);
			deepStrictEqual(
				await h.land.report(request.batchId, {
					attempt: 1,
					candidateSha: cand,
					state: "success",
					runIds: ["run_1"],
					evidence: { ok: true },
				}, "i_ci"),
				{ accepted: true },
			);
			// First verdict wins.
			deepStrictEqual(
				await h.land.report(request.batchId, {
					attempt: 1,
					candidateSha: cand,
					state: "failure",
					runIds: [],
					evidence: null,
				}, "i_ci"),
				{ accepted: false, reason: "duplicate" },
			);
			for (const e of h.sentEvents.splice(0)) step.send(e.type, e.payload);
		};
		const result = await h.drive(request.batchId, step);
		equal(result.state, "landed");
		// One timed-out wait, one poll, then the event.
		deepStrictEqual(step.waits, ["verdict-1-0", "verdict-1-1"]);
		ok(step.ran.includes("poll-1-0"));
		const testing = eventsOf(h, "land.testing")[0]?.data as {
			attempt: number;
			candidateSha: string;
		};
		equal(testing.attempt, 1);
		const repo = await h.fake.get(h.canonical);
		const note = await repo.readCommit(result.landed?.[0].commit as string);
		ok(note);
	},
);

landTest(
	"K14: a late attempt-1 verdict during attempt 2 is refused, and the poll ignores attempt-1 rows",
	async (h) => {
		const a = submitChange(
			h,
			await pushLane(h, { owner: A, files: { "a.txt": "a\n" } }),
		);
		const request = landRequest(h, [a], { testPolicy: "checks" });
		await h.land.submit(request, QUEUE_INST);
		const id = request.batchId;
		// Attempt 1 by hand: candidate, testing, a verdict, then stale.
		const cand1 = a.head;
		await h.land.recordCompose(id, 1, cand1, [{
			changeId: a.changeId,
			commit: cand1,
		}]);
		await h.land.setBatchState(id, "gating");
		await h.land.setBatchState(id, "testing", { affected: ["*"] });
		deepStrictEqual(
			await h.land.report(id, {
				attempt: 1,
				candidateSha: cand1,
				state: "success",
				runIds: [],
				evidence: null,
			}, "i_ci"),
			{ accepted: true },
		);
		deepStrictEqual(await h.land.nextAttempt(id, "stale"), { attempt: 2 });
		const trunk = await trunkOf(h);
		await h.land.recordCompose(id, 2, trunk, [{
			changeId: a.changeId,
			commit: trunk,
		}]);
		await h.land.setBatchState(id, "gating");
		await h.land.setBatchState(id, "testing", { affected: ["*"] });
		deepStrictEqual(
			await h.land.report(id, {
				attempt: 1,
				candidateSha: cand1,
				state: "success",
				runIds: [],
				evidence: null,
			}, "i_ci"),
			{ accepted: false, reason: "stale-attempt" },
		);
		equal(await h.land.verdict(id, 2, cand1), null);
		equal(await h.land.verdict(id, 2, trunk), null);
		ok(await h.land.verdict(id, 1, cand1));
		// Locking attempt 2 without its own verdict is refused.
		const lock = await code(
			h.land.beginAdvance(id, 2, `land-${h.repoId}-${id.slice(3)}`),
		);
		ok(lock.includes("no passing verdict"), lock);
	},
);

landTest("a red verdict fails the batch and releases its lanes", async (h) => {
	const a = submitChange(
		h,
		await pushLane(h, { owner: A, files: { "a.txt": "a\n" } }),
	);
	const request = landRequest(h, [a], { testPolicy: "checks" });
	await h.land.submit(request, QUEUE_INST);
	const step = createFakeStep({ clock: h.clock });
	step.before = async (name) => {
		if (name !== "poll-1-0") return;
		const st = await h.land.status(request.batchId);
		await h.land.report(request.batchId, {
			attempt: 1,
			candidateSha: st?.candidateSha as string,
			state: "failure",
			runIds: ["run_1"],
			evidence: null,
		}, "i_ci");
	};
	const result = await h.drive(request.batchId, step);
	equal(result.state, "failed");
	equal(result.reason, "tests");
	equal((await h.core.getLane(a.laneId))?.state, "submitted");
});

landTest(
	"a head that moved under the freeze reopens the lane at complete-n",
	async (h) => {
		const a = submitChange(
			h,
			await pushLane(h, { owner: A, files: { "a.txt": "a\n" } }),
		);
		const request = landRequest(h, [a]);
		await h.land.submit(request, QUEUE_INST);
		const step = createFakeStep({ clock: h.clock });
		step.before = async (name) => {
			if (name !== "complete-1") return;
			// Fault injection: a write the freeze should have refused lands on
			// the lane (recorded as a push), so its head is no longer the landed one.
			await pushLane(h, {
				owner: A,
				laneId: a.laneId,
				files: { "late.txt": "late\n" },
			});
		};
		const result = await h.drive(request.batchId, step);
		equal(result.state, "landed");
		const lane = await h.core.getLane(a.laneId);
		equal(lane?.state, "open", "reopened, never closed");
		equal(h.landInternal.landingByLaneSync(a.laneId)?.lane_head, a.head);
	},
);

landTest(
	"a head first pushed by another agent lands with both named",
	async (h) => {
		h.principals.set(A, {
			id: A,
			kind: "agent",
			handle: "claude-1",
			display: "Claude",
			email: null,
			agentTool: "claude-code",
			agentModel: "opus",
		});
		h.principals.set(B, {
			id: B,
			kind: "agent",
			handle: "codex-2",
			display: "Codex",
			email: null,
			agentTool: "codex",
			agentModel: "gpt-5-codex",
		});
		const theirs = await pushLane(h, {
			owner: B,
			files: { "b.txt": "b\n" },
		});
		await h.core.recordDiff(theirs.pushId as string, {
			rangeBase: await trunkOf(h),
			rangeTruncated: false,
			diffKey: "diffs/x.json",
			commits: [{ sha: theirs.head, subject: "b", trailers: [] }],
			paths: ["b.txt"],
			truncated: false,
		});
		// A points its own lane at B's commit and pushes it.
		const mine = await pushLane(h, {
			owner: A,
			files: {},
			head: theirs.head,
			rangeCommits: [theirs.head],
		});
		const change = submitChange(h, mine);
		const request = landRequest(h, [change]);
		await h.land.submit(request, QUEUE_INST);
		const result = await h.drive(request.batchId);
		equal(result.state, "landed");
		const repo = await h.fake.get(h.canonical);
		const message = (await repo.readCommit(result.landed?.[0].commit as string))
			?.message ?? "";
		ok(message.includes("Tartan-Agent: claude-1 (claude-code/opus)"), message);
		ok(
			message.includes(
				`Co-authored-by: codex-2 <agent+${B}@agents.git.example.test>`,
			),
			message,
		);
		const note = await h.land.whyNote(
			`adv_${request.batchId.slice(3)}_1`,
			change.changeId,
		);
		deepStrictEqual(note.kernel.firstPushers, [{ principal: B, commits: 1 }]);
		equal(note.kernel.provenance, "complete");
		// The author of the squash commit is the lane owner.
		equal(
			(await repo.readCommit(result.landed?.[0].commit as string))?.author.name,
			"Claude",
		);
	},
);

landTest(
	"git runs as tartan-git, pushes as tartan-push, and no token leaks",
	async (h) => {
		const changes = [];
		for (const [i, owner] of [A, B].entries()) {
			changes.push(
				submitChange(
					h,
					await pushLane(h, { owner, files: { [`f${i}.txt`]: `${i}\n` } }),
				),
			);
		}
		const request = landRequest(h, changes);
		await h.land.submit(request, QUEUE_INST);
		const step = createFakeStep({ clock: h.clock });
		const result = await h.drive(request.batchId, step);
		equal(result.state, "landed");
		const TOKEN = /art_v[0-9]+_/;
		ok(h.execs.length > 5);
		for (const exec of h.execs) {
			const sub = exec.argv[3];
			const writes = Object.values(exec.env).some((v) => TOKEN.test(v)) &&
				sub === "push";
			if (sub === "push") equal(exec.uid, "tartan-push", exec.argv.join(" "));
			else equal(exec.uid, "tartan-git", exec.argv.join(" "));
			ok(!exec.argv.some((a) => TOKEN.test(a)), "no token in argv");
			void writes;
		}
		ok(h.execs.some((e) => e.argv.includes("merge-tree")));
		// Params, step outputs, events and every stored row are token-free.
		ok(!TOKEN.test(JSON.stringify(h.instances)), "params");
		ok(
			!TOKEN.test(JSON.stringify([...step.results.entries()])),
			"step outputs",
		);
		ok(
			!TOKEN.test(JSON.stringify(h.events.read({ since: 0, limit: 100_000 }))),
			"events",
		);
		const tables = h.storage.sql.exec<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'table'",
		).toArray().map((t) => t.name);
		for (const table of tables) {
			const rows = h.storage.sql.exec(`SELECT * FROM "${table}"`).toArray();
			ok(!TOKEN.test(JSON.stringify(rows)), `table ${table}`);
		}
		ok(!TOKEN.test(JSON.stringify(h.logs)), "logs");
	},
);

landTest(
	"a foreign write to main during a 20-batch run pauses landing and never becomes a base",
	async (h) => {
		const landed: string[] = [];
		let foreign: string | null = null;
		let failedAt = -1;
		for (let i = 0; i < 20; i++) {
			const change = submitChange(
				h,
				await pushLane(h, {
					owner: [A, B, C][i % 3],
					files: { [`n${i}.txt`]: `${i}\n` },
				}),
			);
			const request = landRequest(h, [change]);
			if (foreign !== null) {
				const refused = await code(h.land.submit(request, QUEUE_INST));
				ok(refused.startsWith("denied(landing-paused)"), refused);
				continue;
			}
			await h.land.submit(request, QUEUE_INST);
			const step = createFakeStep({ clock: h.clock });
			if (i === 9) {
				step.before = (name) => {
					if (name !== "lock-1" || foreign !== null) return;
					const scratch = "refs/scratch/foreign";
					const trunk = h.fake.inspect.refs(h.canonical)["refs/heads/main"];
					h.fake.setRef(h.canonical, scratch, trunk, { quiet: true });
					foreign = h.fake.commit(h.canonical, scratch, { "x.txt": "x\n" }, {
						message: "foreign",
						quiet: true,
					});
					h.fake.setRef(h.canonical, "refs/heads/main", foreign);
				};
			}
			const result = await h.drive(request.batchId, step);
			if (result.state === "landed") {
				landed.push(result.landed?.[0].commit as string);
			} else {
				failedAt = i;
				equal(result.reason, "trunk-unexplained");
				equal((await h.core.getLane(change.laneId))?.state, "submitted");
			}
		}
		equal(failedAt, 9);
		equal(landed.length, 9);
		equal(h.coreInternal.metaSync("landing_paused"), "1");
		// The index never adopted the foreign value, and no advance used it.
		equal(await h.core.resolveRef(trunkRef("main")), landed.at(-1));
		const bases = h.storage.sql.exec<{ expect_old: string }>(
			"SELECT expect_old FROM advances",
		).toArray().map((r) => r.expect_old);
		ok(!bases.includes(foreign as unknown as string));
		await settleObservations(h);
		ok(
			eventTypes(h).includes("ref.tampered"),
			"the foreign write is a K1 event",
		);
		void rejects;
		void newChangeId;
		void agentActor;
	},
);
