// Kernel git jobs on the harness (K1/K2): genesis, ref-only
// writes with their compare-and-swap, branch-lane GC through `refWrite`,
// archive (attic ref, or summary only on an advisory veto) and the why API.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { fromRpcError, trunkRef, ZERO_SHA } from "@tartan/contract";
import { KERNEL_LANE_ACTOR } from "@tartan/contract/kernel.ts";
import { createKernelGitJobsWith } from "./gitjobs.ts";
import {
	agentActor,
	createLandHarness,
	eventsOf,
	eventTypes,
	hasGit,
	landTest,
	ROLE,
	rolesOf,
	settleObservations,
} from "./testing/harness.ts";
import {
	landRequest,
	pushLane,
	QUEUE_INST,
	submitChange,
	trunkOf,
} from "./testing/lanes.ts";

const A = "a_01k6eeeeeeeeeeeeeeeeeeeeee";
const OWNER = "u_01k6oooooooooooooooooooooo";

const jobsOf = (h: Awaited<ReturnType<typeof createLandHarness>>) =>
	createKernelGitJobsWith({
		artifacts: h.fake,
		core: () => h.core,
		land: () => h.land,
		exec: () => () => Promise.reject(new Error("no sandbox needed")),
		gates: {
			gates: () =>
				h.gates === null
					? Promise.reject(new Error("not_implemented: gates"))
					: h.gates({}),
		},
		probe: () => ({
			addedLines: () => Promise.resolve({ lines: [], truncated: false }),
			diffPaths: () => Promise.resolve({ paths: [], truncated: false }),
		}),
	});

Deno.test({
	name: "genesis writes the first commit in the Worker, once, as trunk seq 0",
	ignore: !hasGit,
	sanitizeOps: false,
	sanitizeResources: false,
	fn: async () => {
		const h = await createLandHarness({ genesis: false });
		try {
			const jobs = jobsOf(h);
			const input = {
				defaultBranch: "main",
				message: "Initial commit",
				author: { name: "Tartan", email: "tartan@git.example.test" },
			};
			const { commit } = await jobs.genesis(h.repoId, input);
			equal(h.fake.inspect.refs(h.canonical)["refs/heads/main"], commit);
			equal(await h.core.resolveRef(trunkRef("main")), commit);
			deepStrictEqual(await h.core.trunkSeqs([commit]), { [commit]: 0 });
			// Deterministic and idempotent.
			deepStrictEqual(await jobs.genesis(h.repoId, input), { commit });
			const intents = h.storage.sql.exec<{ purpose: string; state: string }>(
				"SELECT purpose, state FROM kernel_writes WHERE purpose = 'genesis'",
			).toArray();
			deepStrictEqual(intents, [{ purpose: "genesis", state: "pushed" }]);
			const repo = await h.fake.get(h.canonical);
			equal((await repo.readCommit(commit))?.message.trim(), "Initial commit");
			await settleObservations(h);
			ok(!eventTypes(h).includes("ref.tampered"));
		} finally {
			await h.close();
		}
	},
});

landTest(
	"refWrite: a stale old sha gets ng and leaves the ref alone; intents first",
	async (h) => {
		const jobs = jobsOf(h);
		const trunk = await trunkOf(h);
		const ref = "refs/tartan/attic/ln_01k6ssssssssssssssssssssss/1";
		const [created] = await jobs.refWrite(h.repoId, [{
			target: "repo",
			ref,
			expectOld: ZERO_SHA,
			newSha: trunk,
			purpose: "attic",
			ownerKind: "kernel",
			ownerId: "test",
		}]);
		deepStrictEqual(created, { ref, ok: true });
		equal(h.fake.inspect.refs(h.canonical)[ref], trunk);
		// A create of an existing ref and a delete with a wrong old sha both fail.
		const lane = await pushLane(h, { owner: A, files: { "x.txt": "x\n" } });
		const results = await jobs.refWrite(h.repoId, [
			{
				target: "repo",
				ref,
				expectOld: lane.head,
				newSha: ZERO_SHA,
				purpose: "purge",
				ownerKind: "kernel",
				ownerId: "test",
			},
		]);
		equal(results[0].ok, false);
		ok(results[0].reason && results[0].reason.length > 0);
		equal(h.fake.inspect.refs(h.canonical)[ref], trunk, "left alone");
		const states = h.storage.sql.exec<{ purpose: string; state: string }>(
			"SELECT purpose, state FROM kernel_writes WHERE ref = ? ORDER BY created_at",
			ref,
		).toArray();
		deepStrictEqual(states, [
			{ purpose: "attic", state: "pushed" },
			{ purpose: "purge", state: "abandoned" },
		]);
		// Only ref-only purposes, and a ref once per call.
		const refused = await jobs.refWrite(h.repoId, [{
			target: "repo",
			ref: "refs/heads/main",
			expectOld: trunk,
			newSha: lane.head,
			purpose: "trunk",
			ownerKind: "kernel",
			ownerId: "test",
		}]).catch((e) => fromRpcError(e).code);
		equal(refused, "invalid");
		await settleObservations(h);
		ok(!eventTypes(h).includes("ref.tampered"));
	},
);

landTest(
	"refWrite retries transient upstream failures and lands once",
	async (h) => {
		const jobs = createKernelGitJobsWith({
			artifacts: h.fake,
			core: () => h.core,
			land: () => h.land,
			exec: () => () => Promise.reject(new Error("no sandbox needed")),
			gates: { gates: () => Promise.reject(new Error("unused")) },
			probe: () => ({
				addedLines: () => Promise.resolve({ lines: [], truncated: false }),
				diffPaths: () => Promise.resolve({ paths: [], truncated: false }),
			}),
			sleep: () => Promise.resolve(),
			log: () => {},
		});
		const fault = h.fake.faults.inject({
			op: "git.receive-pack",
			fault: { kind: "error", code: "INTERNAL_ERROR" },
			times: 2,
		});
		const trunk = await trunkOf(h);
		const ref = "refs/tartan/attic/ln_01k6ssssssssssssssssssssss/9";
		const intent = {
			target: "repo",
			ref,
			expectOld: ZERO_SHA,
			newSha: trunk,
			purpose: "attic" as const,
			ownerKind: "kernel" as const,
			ownerId: "test",
		};
		deepStrictEqual(await jobs.refWrite(h.repoId, [intent]), [{
			ref,
			ok: true,
		}]);
		equal(fault.hits(), 2);
		equal(h.fake.inspect.refs(h.canonical)[ref], trunk);
		// Every retry exhausted: the error surfaces; nothing was written.
		h.fake.faults.inject({
			op: "git.receive-pack",
			fault: { kind: "error", code: "INTERNAL_ERROR" },
		});
		const failed = await jobs.refWrite(h.repoId, [{
			...intent,
			ref: `${ref}0`,
		}])
			.catch((e) => fromRpcError(e).code);
		equal(failed, "unavailable");
		equal(h.fake.inspect.refs(h.canonical)[`${ref}0`], undefined);
		h.fake.faults.clear();
		// Re-sending a write that already landed reads as applied, not refused.
		deepStrictEqual(await jobs.refWrite(h.repoId, [intent]), [{
			ref,
			ok: true,
		}]);
	},
);

landTest(
	"lane GC deletes a closed branch lane's ref through refWrite with no ref.tampered",
	async (h) => {
		const lane = submitChange(
			h,
			await pushLane(h, { owner: A, files: { "a.txt": "a\n" } }),
		);
		const request = landRequest(h, [lane]);
		await h.land.submit(request, QUEUE_INST);
		equal((await h.drive(request.batchId)).state, "landed");
		equal((await h.core.getLane(lane.laneId))?.state, "closed");
		const ref = `refs/heads/lanes/${lane.laneId}`;
		equal(h.fake.inspect.refs(h.canonical)[ref], lane.head);
		h.clock.advance(25 * 60 * 60 * 1000);
		const run = await h.core.gcLanes(h.clock.now());
		deepStrictEqual(run.deleted, [lane.laneId]);
		equal(h.fake.inspect.refs(h.canonical)[ref], undefined);
		equal((await h.core.getLane(lane.laneId))?.state, "deleted");
		await settleObservations(h);
		ok(!eventTypes(h).includes("ref.tampered"));
	},
);

landTest(
	"archive: an attic ref at the lane head; an advisory veto keeps the summary only",
	async (h) => {
		rolesOf(h).set(OWNER, ROLE.owner);
		const kept = await pushLane(h, { owner: A, files: { "k.txt": "k\n" } });
		const atticRef = "refs/tartan/attic/ln_01k6ssssssssssssssssssssss/2";
		const result = await h.core.archiveLane(
			kept.laneId,
			{ atticRef },
			agentActor(A),
		);
		deepStrictEqual(result, { kind: "ref", ref: atticRef, head: kept.head });
		equal(h.fake.inspect.refs(h.canonical)[atticRef], kept.head);
		const archived = eventsOf(h, "lane.archived")[0]?.data as {
			atticRef?: string;
		};
		equal(archived.atticRef, atticRef);

		// A veto (e.g. a leaked key) archives only the summary: no attic ref,
		// and lane GC then deletes the lane ref.
		const vetoed = await pushLane(h, { owner: A, files: { "s.txt": "key\n" } });
		h.gates = () =>
			Promise.resolve({
				calls: [],
				effective: [{
					installation: "i_01k6hhhhhhhhhhhhhhhhhhhhhh",
					ext: "acme.no-secrets@0.1.0",
					mode: "enforce",
					decision: "veto",
					message: "a key",
					basis: "answer",
				}],
				blocked: true,
			});
		const atticVetoed = "refs/tartan/attic/ln_01k6ssssssssssssssssssssss/3";
		const summary = await h.core.archiveLane(
			vetoed.laneId,
			{ atticRef: atticVetoed },
			agentActor(A),
		);
		deepStrictEqual(summary, { kind: "summary" });
		equal(h.fake.inspect.refs(h.canonical)[atticVetoed], undefined);
		h.clock.advance(60 * 1000);
		const gc = await h.core.gcLanes(h.clock.now());
		ok(gc.deleted.includes(vetoed.laneId));
		equal(
			h.fake.inspect.refs(h.canonical)[`refs/heads/lanes/${vetoed.laneId}`],
			undefined,
		);
		await settleObservations(h);
		ok(!eventTypes(h).includes("ref.tampered"));
		void KERNEL_LANE_ACTOR;
	},
);

landTest(
	"why: the RepoDO copy of the note and its reason events, by sha, prefix or path",
	async (h) => {
		const lane = submitChange(
			h,
			await pushLane(h, { owner: A, files: { "docs/why.md": "why\n" } }),
		);
		const request = landRequest(h, [lane]);
		await h.land.submit(request, QUEUE_INST);
		await h.land.contributeNote(lane.changeId, "tartan.work", {
			item: "acme/shop#1",
			why: "a reason",
		});
		const result = await h.drive(request.batchId);
		const commit = result.landed?.[0].commit as string;
		const bySha = await h.land.why({ sha: commit });
		equal(bySha?.commit, commit);
		equal(bySha?.note?.kernel.change, lane.changeId);
		deepStrictEqual(bySha?.note?.ext, {
			"tartan.work": { item: "acme/shop#1", why: "a reason" },
		});
		deepStrictEqual(
			bySha?.events.map((e) => e.type),
			["changes.submitted", "review.decided"],
		);
		equal((await h.land.why({ sha: commit.slice(0, 10) }))?.commit, commit);
		equal((await h.land.why({ path: "docs/why.md" }))?.commit, commit);
		equal(await h.land.why({ path: "nope" }), null);
		// The git note carries the same extension section.
		const repo = await h.fake.get(h.canonical);
		const tip = h.fake.inspect.refs(h.canonical)["refs/notes/tartan"];
		const blob = await repo.readFile({ ref: tip, path: commit });
		ok(blob !== null && (await (blob as Blob).text()).includes("a reason"));
	},
);
