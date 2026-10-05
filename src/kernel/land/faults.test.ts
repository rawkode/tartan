// Fault injection for the Advance: crashes after a side effect, a restarted
// sandbox (cold mirror), an instance killed after the trunk push (the K5
// sweeper completes and repairs), a K5 race, an upstream 503, a moving notes
// tip, abandoned and unexplained advances, the outbox and the candidate
// cleanup.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	candidateRef,
	changeRef,
	NOTES_REF,
	trunkRef,
	ZERO_SHA,
} from "@tartan/contract";
import type { GateDispatchResult } from "@tartan/contract/kernel.ts";
import { notePaths } from "./notes.ts";
import {
	eventsOf,
	eventTypes,
	type LandHarness,
	landTest,
	settleObservations,
} from "./testing/harness.ts";
import {
	landRequest,
	pushLane,
	QUEUE_INST,
	submitChange,
	type SubmittedChange,
	trunkOf,
} from "./testing/lanes.ts";
import { createFakeStep, type FakeStep } from "./testing/step.ts";

const A = "a_01k6eeeeeeeeeeeeeeeeeeeeee";
const B = "a_01k6ffffffffffffffffffffff";

const changes = async (
	h: LandHarness,
	n: number,
	tag = "f",
): Promise<SubmittedChange[]> => {
	const out = [];
	for (let i = 0; i < n; i++) {
		out.push(
			submitChange(
				h,
				await pushLane(h, {
					owner: i % 2 === 0 ? A : B,
					files: { [`${tag}${i}.txt`]: `${tag} ${i}\n` },
				}),
			),
		);
	}
	return out;
};

const pushesTo = (h: LandHarness, ref: string): number =>
	h.execs.filter((e) =>
		e.argv[3] === "push" && e.argv.some((a) => a.endsWith(`:${ref}`))
	).length;

const notesFor = async (h: LandHarness, commits: readonly string[]) => {
	const tip = h.fake.inspect.refs(h.canonical)[NOTES_REF];
	const repo = await h.fake.get(h.canonical);
	const found: string[] = [];
	for (const commit of commits) {
		for (const path of notePaths(commit)) {
			if (await repo.readFile({ ref: tip, path }) !== null) {
				found.push(commit);
				break;
			}
		}
	}
	return found;
};

const instanceOf = (h: LandHarness, batchId: string) =>
	`land-${h.repoId}-${batchId.slice(3)}`;

landTest(
	"a crash after push-trunk re-runs the step, which skips the push and completes",
	async (h) => {
		const [a, b] = await changes(h, 2);
		const request = landRequest(h, [a, b]);
		await h.land.submit(request, QUEUE_INST);
		const step = createFakeStep({ clock: h.clock });
		step.crashAfter.add("push-trunk-1");
		const result = await h.drive(request.batchId, step);
		equal(result.state, "landed");
		equal(step.ran.filter((n) => n === "push-trunk-1").length, 2);
		equal(pushesTo(h, trunkRef("main")), 1, "trunk pushed once");
		equal(
			h.fake.inspect.refs(h.canonical)["refs/heads/main"],
			result.landed?.[1].commit,
		);
		await settleObservations(h);
		ok(!eventTypes(h).includes("ref.tampered"));
	},
);

landTest(
	"a re-run of gate-1 whose gate now allows a vetoed change keeps the veto (K8)",
	async (h) => {
		const [a, b] = await changes(h, 2);
		let runs = 0;
		// Vetoes A on the first run; allows everything after (a probe back,
		// or a timeout with onTimeout=allow).
		h.gates = (input): Promise<GateDispatchResult> => {
			const changeId = (input as { changeId: string }).changeId;
			if (changeId === a.changeId) runs += 1;
			const veto = changeId === a.changeId && runs === 1;
			return Promise.resolve({
				calls: [],
				effective: [{
					installation: "i_01k6hhhhhhhhhhhhhhhhhhhhhh",
					ext: "acme.no-secrets@0.1.0",
					mode: "enforce",
					decision: veto ? "veto" : "allow",
					message: veto ? "truncated input" : "clean",
					basis: "answer",
				}],
				blocked: veto,
			});
		};
		const request = landRequest(h, [a, b]);
		await h.land.submit(request, QUEUE_INST);
		const step = createFakeStep({ clock: h.clock });
		// recordGates committed, the step's result was lost.
		step.crashAfter.add("gate-1");
		const result = await h.drive(request.batchId, step);
		equal(step.ran.filter((n) => n === "gate-1").length, 2);
		equal(result.state, "landed");
		deepStrictEqual(result.landed?.map((l) => l.changeId), [b.changeId]);
		const status = await h.land.status(request.batchId);
		deepStrictEqual(status?.changes.map((c) => c.outcome), [
			"vetoed",
			"landed",
		]);
		// Trunk holds B only: A's squash commit was not pushed with it.
		const repo = await h.fake.get(h.canonical);
		const tip = await repo.readCommit(await trunkOf(h));
		ok(!tip?.message.includes(a.changeId), tip?.message);
		equal((await h.core.getLane(a.laneId))?.state, "submitted");
	},
);

landTest(
	"a crash after compose re-runs it from the recorded candidate",
	async (h) => {
		const [a] = await changes(h, 1);
		const request = landRequest(h, [a]);
		await h.land.submit(request, QUEUE_INST);
		const step = createFakeStep({ clock: h.clock });
		step.crashAfter.add("compose-1");
		const result = await h.drive(request.batchId, step);
		equal(result.state, "landed");
		equal(
			pushesTo(h, candidateRef(request.batchId)),
			1,
			"candidate pushed once",
		);
		equal(h.execs.filter((e) => e.argv.includes("merge-tree")).length, 1);
	},
);

landTest(
	"an eviction mid-step and a restarted sandbox (cold mirror) still land",
	async (h) => {
		const cs = await changes(h, 3);
		const request = landRequest(h, cs);
		await h.land.submit(request, QUEUE_INST);
		const step = createFakeStep({ clock: h.clock });
		const fired = new Set<string>();
		step.before = async (name) => {
			if (fired.has(name)) return;
			fired.add(name);
			if (name === "push-trunk-1") {
				// The container restarted: the mirror is gone (objects, notes work ref).
				await Deno.remove(h.mirrorRoot, { recursive: true });
				await Deno.mkdir(h.mirrorRoot, { recursive: true });
				// And the first push exec of the step dies before it runs.
				h.failExec = (argv) => argv[3] === "push";
			}
			if (name === "push-notes-1") h.failExec = (argv) => argv[3] === "push";
		};
		const result = await h.drive(request.batchId, step);
		equal(result.state, "landed");
		const commits = result.landed?.map((l) => l.commit) ?? [];
		deepStrictEqual(await notesFor(h, commits), commits);
		for (const c of cs) {
			equal(h.fake.inspect.refs(h.canonical)[changeRef(c.changeId)], c.head);
		}
		await settleObservations(h);
		ok(!eventTypes(h).includes("ref.tampered"));
	},
);

landTest(
	"an instance killed after push-trunk is completed and repaired by the K5 sweeper",
	async (h) => {
		const cs = await changes(h, 2);
		const request = landRequest(h, cs);
		await h.land.submit(request, QUEUE_INST);
		const step = createFakeStep({ clock: h.clock });
		step.failTimes.set("push-notes-1", 1_000);
		let error: unknown = null;
		try {
			await h.drive(request.batchId, step);
		} catch (e) {
			error = e;
		}
		ok(error, "the instance ends with an error after the trunk push");
		const status = await h.land.status(request.batchId);
		equal(status?.state, "advancing", "not aborted: trunk moved");
		const landed = status?.changes.map((c) => c.commit) as string[];
		equal(h.fake.inspect.refs(h.canonical)["refs/heads/main"], landed[1]);
		equal(
			h.fake.inspect.refs(h.canonical)[NOTES_REF],
			undefined,
			"no notes yet",
		);
		h.instanceStates.set(instanceOf(h, request.batchId), "errored");
		h.clock.advance(6 * 60 * 1000);
		await h.runTimers();
		await h.settle();
		const after = await h.land.status(request.batchId);
		equal(after?.state, "landed");
		deepStrictEqual(await notesFor(h, landed), landed, "notes repaired");
		for (const c of cs) {
			equal(h.fake.inspect.refs(h.canonical)[changeRef(c.changeId)], c.head);
			equal((await h.core.getLane(c.laneId))?.state, "closed");
		}
		await settleObservations(h);
		ok(
			!eventTypes(h).includes("ref.tampered"),
			"repair pushes are registered",
		);
	},
);

landTest(
	"K5: two batches race for the lock; the loser waits and lands later",
	async (h) => {
		const [a] = await changes(h, 1, "a");
		const [b] = await changes(h, 1, "b");
		const first = landRequest(h, [a]);
		const second = landRequest(h, [b]);
		await h.land.submit(first, QUEUE_INST);
		await h.land.submit(second, QUEUE_INST);
		const stepA = createFakeStep({ clock: h.clock });
		const stepB = createFakeStep({ clock: h.clock });
		let releaseA: () => void = () => {};
		const aHolding = new Promise<void>((r) => (releaseA = r));
		let aLocked: () => void = () => {};
		const aHasLock = new Promise<void>((r) => (aLocked = r));
		// A takes the lock and holds it until B has seen it held.
		stepA.before = async (name) => {
			if (name === "restack-1") {
				aLocked();
				await aHolding;
			}
		};
		let waited = false;
		stepB.before = async (name) => {
			if (name === "lock-1") await aHasLock;
			if (name === "lock-1-1") {
				waited = true;
				releaseA();
				await runA;
			}
		};
		const runA = h.drive(first.batchId, stepA);
		const resultB = await h.drive(second.batchId, stepB);
		const resultA = await runA;
		ok(waited, "B found the ref locked");
		ok(stepB.sleeps.some((s) => s.name === "k5-wait-1-0"));
		equal(resultA.state, "landed");
		equal(resultB.state, "landed");
		// B composed on A's landing in attempt 2 (trunk moved under its lock wait).
		equal(resultB.attempt, 2);
		const repo = await h.fake.get(h.canonical);
		const commitB = await repo.readCommit(resultB.landed?.[0].commit as string);
		deepStrictEqual(commitB?.parents, [resultA.landed?.[0].commit]);
		equal(eventsOf(h, "advance.stale").length, 1);
		await settleObservations(h);
		ok(!eventTypes(h).includes("ref.tampered"));
	},
);

landTest(
	"an upstream 503 on push-trunk is retried, never advance.stale",
	async (h) => {
		const [a] = await changes(h, 1);
		const request = landRequest(h, [a]);
		await h.land.submit(request, QUEUE_INST);
		const step = createFakeStep({ clock: h.clock });
		let fault: { hits(): number } | null = null;
		step.before = (name) => {
			if (name === "push-trunk-1" && fault === null) {
				fault = h.fake.faults.inject({
					op: "git.receive-pack",
					fault: { kind: "error", code: "INTERNAL_ERROR" },
					times: 1,
				});
			}
		};
		const result = await h.drive(request.batchId, step);
		equal(result.state, "landed");
		equal(result.attempt, 1);
		equal((fault as unknown as { hits(): number }).hits(), 1);
		ok(
			step.ran.filter((n) => n === "push-trunk-1").length >= 2,
			"the step retried",
		);
		equal(eventsOf(h, "advance.stale").length, 0);
	},
);

landTest(
	"a notes tip that moved is rebased on with a fresh intent and no ref.tampered",
	async (h) => {
		const [a] = await changes(h, 1, "first");
		const first = landRequest(h, [a]);
		await h.land.submit(first, QUEUE_INST);
		await h.drive(first.batchId);
		const [b] = await changes(h, 1, "second");
		const request = landRequest(h, [b]);
		await h.land.submit(request, QUEUE_INST);
		const step = createFakeStep({ clock: h.clock });
		let other: string | null = null;
		step.before = async (name) => {
			if (name !== "push-notes-1" || other !== null) return;
			// Another kernel writer (e.g. a repair) moves the notes tip first,
			// with its own registered intent.
			const tip = h.fake.inspect.refs(h.canonical)[NOTES_REF];
			h.fake.setRef(h.canonical, "refs/scratch/notes", tip, { quiet: true });
			other = h.fake.commit(h.canonical, "refs/scratch/notes", {
				[a.head]: '{"other":true}\n',
			}, { message: "Notes added by 'git notes add'", quiet: true });
			await h.core.registerKernelWrite({
				target: "repo",
				ref: NOTES_REF,
				expectOld: tip,
				newSha: other,
				purpose: "notes",
				ownerKind: "job",
				ownerId: "other-writer",
			});
			h.fake.setRef(h.canonical, NOTES_REF, other);
		};
		const result = await h.drive(request.batchId, step);
		equal(result.state, "landed");
		const tip = h.fake.inspect.refs(h.canonical)[NOTES_REF];
		const repo = await h.fake.get(h.canonical);
		const notesCommit = await repo.readCommit(tip);
		deepStrictEqual(notesCommit?.parents, [other], "rebased on the moved tip");
		deepStrictEqual(
			await notesFor(h, [result.landed?.[0].commit as string, a.head]),
			[result.landed?.[0].commit as string, a.head],
		);
		const notesIntents = h.storage.sql.exec<
			{ supersedes: string | null; state: string }
		>(
			`SELECT supersedes, state FROM kernel_writes WHERE purpose = 'notes'
		 AND owner_id = ? ORDER BY created_at`,
			`adv_${request.batchId.slice(3)}_1`,
		).toArray();
		equal(notesIntents.length, 2);
		ok(
			notesIntents[1].supersedes !== null,
			"the retry supersedes the first intent",
		);
		await settleObservations(h);
		ok(!eventTypes(h).includes("ref.tampered"));
	},
);

landTest(
	"the watchdog ends a live batch whose instance ended without ending it; a running one is left alone",
	async (h) => {
		const [a, b] = await changes(h, 2, "w");
		const dead = landRequest(h, [a]);
		await h.land.submit(dead, QUEUE_INST);
		const step = createFakeStep({ clock: h.clock });
		// gate-1 exhausts its retries (RepoDO unavailable) and so does abort-1:
		// the instance ends errored and nothing ended the batch.
		step.failTimes.set("gate-1", 1_000);
		step.failTimes.set("abort-1", 1_000);
		await h.drive(dead.batchId, step).catch(() => {});
		equal((await h.land.status(dead.batchId))?.state, "gating");
		equal((await h.core.getLane(a.laneId))?.state, "landing");
		h.instanceStates.set(instanceOf(h, dead.batchId), "errored");
		// Another batch whose instance still runs.
		const live = landRequest(h, [b]);
		await h.land.submit(live, QUEUE_INST);
		h.clock.advance(11 * 60 * 1000);
		await h.runTimers();
		const status = await h.land.status(dead.batchId);
		equal(status?.state, "failed");
		equal((status?.result as { reason: string }).reason, "abandoned");
		equal((await h.core.getLane(a.laneId))?.state, "submitted");
		ok(
			eventsOf(h, "land.failed").some((e) =>
				(e.data as { batchId: string }).batchId === dead.batchId
			),
		);
		equal((await h.land.status(live.batchId))?.state, "composing");
		equal((await h.core.getLane(b.laneId))?.state, "landing");
		// The watchdog stays armed while a live batch remains.
		ok((h.timers.get("land", "outbox") ?? 0) > h.clock.now());
	},
);

landTest(
	"K5 sweeper: an abandoned lock is released and the lanes return to submitted",
	async (h) => {
		const [a] = await changes(h, 1);
		const request = landRequest(h, [a]);
		await h.land.submit(request, QUEUE_INST);
		const step = createFakeStep({ clock: h.clock });
		// A hard kill after lock-1: the step never returns and nothing aborts.
		step.failTimes.set("restack-1", 1_000);
		step.failTimes.set("abort-1", 1_000);
		await h.drive(request.batchId, step).catch(() => {});
		equal((await h.land.status(request.batchId))?.state, "advancing");
		equal((await h.core.getLane(a.laneId))?.state, "landing");
		h.instanceStates.set(instanceOf(h, request.batchId), "errored");
		h.clock.advance(6 * 60 * 1000);
		await h.runTimers();
		const status = await h.land.status(request.batchId);
		equal(status?.state, "failed");
		deepStrictEqual(status?.result, { reason: "abandoned" });
		equal((await h.core.getLane(a.laneId))?.state, "submitted");
		ok(eventTypes(h).includes("advance.released"));
	},
);

landTest(
	"K5 sweeper: a running owner keeps its lock; an unexplained trunk pauses landing",
	async (h) => {
		const [a] = await changes(h, 1);
		const request = landRequest(h, [a]);
		await h.land.submit(request, QUEUE_INST);
		const step = createFakeStep({ clock: h.clock });
		step.failTimes.set("restack-1", 1_000);
		step.failTimes.set("abort-1", 1_000);
		await h.drive(request.batchId, step).catch(() => {});
		h.clock.advance(6 * 60 * 1000);
		await h.runTimers();
		equal(
			(await h.land.status(request.batchId))?.state,
			"advancing",
			"owner still running",
		);
		// Someone moves trunk behind the kernel's back while the owner is dead.
		const trunk = await trunkOf(h);
		h.fake.setRef(h.canonical, "refs/scratch/x", trunk, { quiet: true });
		const foreign = h.fake.commit(
			h.canonical,
			"refs/scratch/x",
			{ "x": "x\n" },
			{
				message: "foreign",
				quiet: true,
			},
		);
		h.fake.setRef(h.canonical, "refs/heads/main", foreign);
		h.instanceStates.set(instanceOf(h, request.batchId), "terminated");
		h.clock.advance(60 * 1000);
		await h.runTimers();
		const status = await h.land.status(request.batchId);
		equal(status?.state, "failed");
		equal(h.coreInternal.metaSync("landing_paused"), "1");
		equal(await trunkOf(h), trunk, "the foreign value is never adopted");
		equal((await h.core.getLane(a.laneId))?.state, "submitted");
	},
);

landTest(
	"a failed Workflow create is retried by the outbox timer",
	async (h) => {
		const [a] = await changes(h, 1);
		h.failCreates = 1;
		const request = landRequest(h, [a]);
		deepStrictEqual(await h.land.submit(request, QUEUE_INST), {
			batchId: request.batchId,
			created: true,
		});
		equal(h.instances.length, 0);
		h.clock.advance(31_000);
		await h.runTimers();
		deepStrictEqual(h.instances.map((i) => i.id), [
			instanceOf(h, request.batchId),
		]);
		deepStrictEqual(h.instances[0].params, {
			repoId: h.repoId,
			batchId: request.batchId,
		});
	},
);

landTest(
	"candidate refs are deleted 24 h after their batch ended, with registered intents",
	async (h) => {
		const [a] = await changes(h, 1);
		const request = landRequest(h, [a]);
		await h.land.submit(request, QUEUE_INST);
		equal((await h.drive(request.batchId)).state, "landed");
		const ref = candidateRef(request.batchId);
		ok(h.fake.inspect.refs(h.canonical)[ref]);
		h.clock.advance(25 * 60 * 60 * 1000);
		await h.runTimers();
		equal(h.fake.inspect.refs(h.canonical)[ref], undefined);
		await settleObservations(h);
		ok(!eventTypes(h).includes("ref.tampered"));
	},
);

landTest(
	"the candidate sweep is never pushed out, writes at most 32 refs a call, and walks past cleaned batches",
	async (h) => {
		const HOUR = 60 * 60 * 1000;
		const [a, b] = await changes(h, 2, "s");
		const first = landRequest(h, [a]);
		await h.land.submit(first, QUEUE_INST);
		equal((await h.drive(first.batchId)).state, "landed");
		const t0 = h.clock.now();
		equal(h.timers.get("land", "candidates"), t0 + 24 * HOUR);
		// (a) A later batch end keeps the earlier sweep time.
		h.clock.advance(23 * HOUR);
		const second = landRequest(h, [b]);
		await h.land.submit(second, QUEUE_INST);
		equal((await h.drive(second.batchId)).state, "landed");
		const t1 = h.clock.now();
		equal(h.timers.get("land", "candidates"), t0 + 24 * HOUR);
		// Older ended batches: 60 whose candidate is already gone (c), then 40
		// whose candidate ref is still indexed (b: more than 32 deletions).
		const trunk = await trunkOf(h);
		const fakeBatch = (i: number, finishedAt: number) => {
			const id = `lb_${h.ulid()}`;
			h.storage.sql.exec(
				`INSERT INTO land_batches (id, instance_id, ref, instance_created, requested_by, base_sha,
				 changes_json, reason_json, test_policy, state, request_hash, created_at, finished_at)
				 VALUES (?, ?, 'refs/heads/main', 1, ?, ?, '[]', '{}', 'none', 'failed', ?, ?, ?)`,
				id,
				`inst-${id}`,
				QUEUE_INST,
				trunk,
				`h${i}`,
				finishedAt,
				finishedAt,
			);
			return id;
		};
		for (let i = 0; i < 60; i++) fakeBatch(i, t0 - 3 * HOUR + i);
		const indexed: string[] = [];
		for (let i = 0; i < 40; i++) {
			const id = fakeBatch(100 + i, t0 - 2 * HOUR + i);
			const row = h.coreInternal.registerKernelWriteSync({
				target: "repo",
				ref: candidateRef(id),
				expectOld: ZERO_SHA,
				newSha: trunk,
				purpose: "candidate",
				ownerKind: "kernel",
				ownerId: `candidates:${id}`,
			});
			h.coreInternal.applyKernelWriteSync(row.id);
			indexed.push(candidateRef(id));
		}
		h.clock.set(t0 + 25 * HOUR);
		for (let i = 0; i < 6; i++) {
			const outcomes = await h.runTimers();
			ok(
				outcomes.every((o) => o.ok !== false),
				JSON.stringify(outcomes),
			);
			h.clock.advance(61_000);
		}
		const unswept = h.storage.sql.exec<{ id: string }>(
			"SELECT id FROM land_batches WHERE candidate_swept = 0",
		).toArray().map((r) => r.id);
		deepStrictEqual(unswept, [second.batchId], "only the young batch is left");
		equal(
			h.fake.inspect.refs(h.canonical)[candidateRef(first.batchId)],
			undefined,
		);
		ok(h.fake.inspect.refs(h.canonical)[candidateRef(second.batchId)]);
		ok(
			!h.logs.some((l) => /at most 32/.test(JSON.stringify(l))),
			"no refWrite over 32 intents",
		);
		// The sweep rearmed itself for the young batch.
		equal(h.timers.get("land", "candidates"), t1 + 24 * HOUR);
	},
);

void ((_: FakeStep) => {});
