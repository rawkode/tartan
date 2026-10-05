/// <reference types="@cloudflare/vitest-pool-workers/types" />
// WP10 in workerd (vitest-pool-workers, project `land`): the real RepoDO
// (every module, DO SQLite, the real event log) answering the land facade
// over RPC, LAND instances created by RepoDO after the batch row, and
// LandWorkflow in the real Workflows engine with its steps mocked (step
// names of a full attempt, the `verdict-n` event, the K5 wait, params
// checks). Git itself runs in the Deno tests (stock git) and live: the pool
// has no container.

import {
	introspectWorkflowInstance,
	runInDurableObject,
} from "cloudflare:test";
import {
	changeIdFromBytes,
	FORGE_DO_NAME,
	fromRpcError,
	landInstanceId,
	repoDoName,
	ulid,
} from "@tartan/contract";
import type { RegistryFacade } from "@tartan/contract/kernel.ts";
import { afterAll, describe, expect, it } from "vitest";
import { settleBackground, testEnv as env } from "../../../test/env.ts";

const SHA = (n: number) => n.toString(16).padStart(40, "c");
const CHANGES_INST = "i_01k6aaaaaaaaaaaaaaaaaaaaaa";
/** A review installation that is not the provider in force at the node. */
const OTHER_REVIEW_INST = "i_01k6bbbbbbbbbbbbbbbbbbbbbb";
const QUEUE_INST = "i_01k6cccccccccccccccccccccc";
const AGENT = "a_01k6eeeeeeeeeeeeeeeeeeeeee";
const OWNER = "u_01k6ffffffffffffffffffffff";

/**
 * The repo's node in the forge's tree (WP3) with the `review@1` provider in
 * force there (WP7a): lane.open gates and K4's provider check ask them.
 */
const nodeWithReview = async () => {
	const forge = env.FORGE.getByName(FORGE_DO_NAME);
	const node = await forge.tree().createRoot({
		kind: "group",
		slug: `land-${ulid()}`,
		owner: OWNER,
	});
	// Typed through the contract facade (the RPC stub types are too deep).
	const registry = forge.registry() as unknown as RegistryFacade;
	const review = await registry.install(OWNER, {
		extId: "tartan.review",
		version: "0.1.0",
		node: node.path,
		mode: "enforce",
	});
	return { nodeId: node.id, reviewInst: review.id };
};

type Modifier = Parameters<
	Parameters<
		Awaited<ReturnType<typeof introspectWorkflowInstance>>["modify"]
	>[0]
>[0];

/** A RepoDO with a trunk, one branch lane with a pushed head, submitted and approved. */
const repoWithChange = async () => {
	// A repo's id is its node's id (WP3); this node is a root group.
	const { nodeId: repoId, reviewInst } = await nodeWithReview();
	const repo = env.REPO.getByName(repoDoName(repoId));
	const trunk = SHA(1);
	await repo.core().init({
		repoId,
		nodeId: repoId,
		path: "acme/shop",
		defaultBranch: "main",
		refs: { "refs/heads/main": trunk },
	});
	const lane = await repo.core().openLane({
		owner: AGENT,
		actor: { kind: "agent", id: AGENT },
	});
	const head = SHA(2);
	// Typed by hand: the RPC stub types are too deep.
	const pushed = (await repo.core().recordPush({
		target: "repo",
		refs: [{ ref: lane.ref, before: "0".repeat(40), after: head }],
		principal: AGENT,
		via: "gateway",
		requestId: `req_${ulid()}`,
	})) as unknown as { readonly pushIds: readonly string[] };
	// Phase 2 of the push (`push.diffed`): with repository config on, a
	// change whose range is unknown counts as touching the root `*.cue`
	// files (K13.3).
	await repo.core().recordDiff(pushed.pushIds[0], {
		rangeBase: trunk,
		rangeTruncated: false,
		diffKey: `diffs/${repoId}/${trunk}..${head}.json`,
		commits: [],
		paths: ["src/app.ts"],
		truncated: false,
	});
	const changeId = changeIdFromBytes(
		crypto.getRandomValues(new Uint8Array(16)),
	);
	const common = { node: repoId, repo: repoId, depth: 0, shadow: false };
	const submitted = await repo.events().append({
		...common,
		type: "changes.submitted",
		source: {
			kind: "installation",
			id: CHANGES_INST,
			ext: "tartan.changes@1.0.0",
		},
		actor: { kind: "agent", id: AGENT },
		data: {
			changeId,
			laneId: lane.id,
			revision: 1,
			head,
			base: trunk,
			affected: [],
		},
		idemKey: `t:${changeId}:s`,
	});
	const approved = await repo.events().append({
		...common,
		type: "review.decided",
		source: {
			kind: "installation",
			id: reviewInst,
			ext: "tartan.review@1.0.0",
		},
		actor: { kind: "system", id: "sys_kernel" },
		data: {
			changeId,
			revision: 1,
			head,
			decision: "approve",
			route: "auto",
			decidedBy: { kind: "system", id: "sys_kernel" },
		},
		idemKey: `t:${changeId}:a`,
	});
	const batchId = `lb_${ulid()}`;
	const request = {
		batchId,
		repo: { id: repoId },
		ref: "refs/heads/main",
		batch: [{
			changeId,
			laneId: lane.id,
			head,
			title: "A change",
			message: "Why it exists.",
			trailers: [],
		}],
		reason: { events: [submitted.id, approved.id], summary: "test" },
		testPolicy: "none" as const,
	};
	return { repoId, repo, lane, head, trunk, changeId, batchId, request };
};

const landed = { state: "landed", attempt: 1, landed: [] };

// The review installation's catch-up reads and the event pokes run in the
// background of these tests.
afterAll(() => settleBackground());

describe("RepoDO land module over RPC", () => {
	it("submit runs K4 on the real log, freezes the lane, writes the row, then creates the LAND instance", async () => {
		const t = await repoWithChange();
		const instanceId = landInstanceId(t.repoId, t.batchId);
		const instance = await introspectWorkflowInstance(env.LAND, instanceId);
		await instance.modify(async (m: Modifier) => {
			await m.disableSleeps();
			// Steps are mocked: this test is about RepoDO creating the instance.
			await m.mockStepResult({ name: "load" }, {
				state: "landed",
				attempt: 1,
				ref: "refs/heads/main",
				testPolicy: "none",
			});
		});
		try {
			// A chain without the approval is refused and freezes nothing.
			const refused = await t.repo.land().submit(
				{
					...t.request,
					reason: {
						...t.request.reason,
						events: t.request.reason.events.slice(0, 1),
					},
				},
				QUEUE_INST,
			).catch((e: unknown) => fromRpcError(e));
			expect(refused).toMatchObject({ code: "invalid" });
			// K4: an approval from another installation than the review@1
			// provider in force at the node (WP3's tree, WP7a's registry) does
			// not count.
			const foreign = await t.repo.events().append({
				node: t.repoId,
				repo: t.repoId,
				depth: 0,
				shadow: false,
				type: "review.decided",
				source: {
					kind: "installation",
					id: OTHER_REVIEW_INST,
					ext: "tartan.review@1.0.0",
				},
				actor: { kind: "system", id: "sys_kernel" },
				data: {
					changeId: t.changeId,
					revision: 1,
					head: t.head,
					decision: "approve",
					route: "auto",
					decidedBy: { kind: "system", id: "sys_kernel" },
				},
				idemKey: `t:${t.changeId}:other`,
			});
			const notProvider = await t.repo.land().submit(
				{
					...t.request,
					reason: {
						...t.request.reason,
						events: [t.request.reason.events[0], foreign.id],
					},
				},
				QUEUE_INST,
			).catch((e: unknown) => fromRpcError(e));
			expect(notProvider).toMatchObject({ code: "invalid" });
			expect(String((notProvider as Error).message)).toContain("no approval");
			expect((await t.repo.core().getLane(t.lane.id))?.state).toBe("submitted");

			expect(await t.repo.land().submit(t.request, QUEUE_INST)).toEqual({
				batchId: t.batchId,
				created: true,
			});
			expect((await t.repo.core().getLane(t.lane.id))?.state).toBe("landing");
			const status = await t.repo.land().status(t.batchId);
			expect(status).toMatchObject({
				batchId: t.batchId,
				repoId: t.repoId,
				state: "composing",
				attempt: 1,
				baseSha: t.trunk,
				changes: [{
					changeId: t.changeId,
					laneId: t.lane.id,
					outcome: "pending",
				}],
			});
			await instance.waitForStatus("complete");
			const flag = await runInDurableObject(
				t.repo,
				(_i, state) =>
					state.storage.sql.exec<{ instance_created: number }>(
						"SELECT instance_created FROM land_batches WHERE id = ?",
						t.batchId,
					).one().instance_created,
			);
			expect(flag).toBe(1);
			// Idempotent resubmit; the same id with other content conflicts.
			expect(await t.repo.land().submit(t.request, QUEUE_INST)).toEqual({
				batchId: t.batchId,
				created: false,
			});
			const other = await t.repo.land().submit(
				{ ...t.request, testPolicy: "checks" },
				QUEUE_INST,
			).catch((e: unknown) => fromRpcError(e));
			expect(other).toMatchObject({ code: "conflict" });
		} finally {
			await instance.dispose();
		}
	});

	it("K14 over RPC: verdicts only for the current attempt and candidate, first wins", async () => {
		const t = await repoWithChange();
		const instance = await introspectWorkflowInstance(
			env.LAND,
			landInstanceId(t.repoId, t.batchId),
		);
		await instance.modify(async (m: Modifier) => {
			await m.disableSleeps();
			await m.mockStepResult({ name: "load" }, {
				state: "landed",
				attempt: 1,
				ref: "refs/heads/main",
				testPolicy: "checks",
			});
		});
		try {
			await t.repo.land().submit(
				{ ...t.request, testPolicy: "checks" },
				QUEUE_INST,
			);
			const land = t.repo.land();
			await land.recordCompose(t.batchId, 1, t.head, [{
				changeId: t.changeId,
				commit: t.head,
			}]);
			await land.setBatchState(t.batchId, "gating");
			await land.setBatchState(t.batchId, "testing", { affected: ["*"] });
			const verdict = (
				candidateSha: string,
				attempt = 1,
				state: "success" | "failure" = "success",
			) =>
				land.report(t.batchId, {
					attempt,
					candidateSha,
					state,
					runIds: [],
					evidence: null,
				}, "i_ci");
			expect(await verdict(SHA(9))).toEqual({
				accepted: false,
				reason: "wrong-candidate",
			});
			expect(await verdict(t.head, 2)).toEqual({
				accepted: false,
				reason: "stale-attempt",
			});
			expect(await verdict(t.head)).toEqual({ accepted: true });
			expect(await verdict(t.head, 1, "failure")).toEqual({
				accepted: false,
				reason: "duplicate",
			});
			expect(await land.verdict(t.batchId, 1, t.head)).toMatchObject({
				state: "success",
			});
			expect(await land.verdict(t.batchId, 2, t.head)).toBeNull();
		} finally {
			await instance.dispose();
		}
	});
});

describe("LandWorkflow (introspectWorkflowInstance)", () => {
	it("rejects params that name no batch, or another instance, as non-retryable", async () => {
		const id = `land-bad-${crypto.randomUUID()}`;
		const instance = await introspectWorkflowInstance(env.LAND, id);
		try {
			await env.LAND.create({ id, params: { repoId: "x", batchId: "y" } });
			await instance.waitForStatus("errored");
			expect((await instance.getError()).message).toContain(
				"NonRetryableError",
			);
		} finally {
			await instance.dispose();
		}
		const repoId = ulid();
		const batchId = `lb_${ulid()}`;
		const other = `land-${ulid()}-${ulid()}`;
		const mismatch = await introspectWorkflowInstance(env.LAND, other);
		try {
			await env.LAND.create({ id: other, params: { repoId, batchId } });
			await mismatch.waitForStatus("errored");
			expect((await mismatch.getError()).message).toContain(
				"NonRetryableError",
			);
		} finally {
			await mismatch.dispose();
		}
	});

	it("runs a full attempt in the engine: compose, gate, test with verdict-1, K5 wait, pushes, complete", async () => {
		const repoId = ulid();
		const batchId = `lb_${ulid()}`;
		const id = landInstanceId(repoId, batchId);
		const candidate = SHA(5);
		const composed = {
			kind: "composed",
			base: SHA(1),
			candidate,
			landed: [{
				changeId: "zkqvzkqvzkqvzkqvzkqvzkqvzkqvzkqv",
				laneId: "ln_01k6eeeeeeeeeeeeeeeeeeeeee",
				head: SHA(2),
				commit: candidate,
				parent: SHA(1),
			}],
			conflicted: [],
			date: 1,
		};
		const lock = {
			kind: "locked",
			advanceId: `adv_${batchId.slice(3)}_1`,
			expectOld: SHA(1),
		};
		const done = {
			state: "landed",
			attempt: 1,
			landed: [{
				changeId: "zkqvzkqvzkqvzkqvzkqvzkqvzkqvzkqv",
				commit: candidate,
			}],
		};
		const instance = await introspectWorkflowInstance(env.LAND, id);
		await instance.modify(async (m: Modifier) => {
			await m.disableSleeps();
			await m.mockStepResult({ name: "load" }, {
				state: "composing",
				attempt: 1,
				ref: "refs/heads/main",
				testPolicy: "checks",
			});
			await m.mockStepResult({ name: "compose-1" }, composed);
			await m.mockStepResult({ name: "gate-1" }, { vetoed: [] });
			await m.mockStepResult({ name: "test-1" }, { mocked: true });
			await m.mockEvent({
				type: "verdict-1",
				payload: { attempt: 1, candidateSha: candidate, state: "success" },
			});
			await m.mockStepResult({ name: "lock-1" }, { kind: "wait" });
			await m.mockStepResult({ name: "lock-1-1" }, lock);
			await m.mockStepResult({ name: "restack-1" }, {
				kind: "restacked",
				newSha: candidate,
				notesBase: "0".repeat(40),
				notesTip: SHA(7),
				changeRefs: [],
			});
			await m.mockStepResult({ name: "push-trunk-1" }, { kind: "pushed" });
			await m.mockStepResult({ name: "push-notes-1" }, { mocked: true });
			await m.mockStepResult({ name: "push-refs-1" }, { mocked: true });
			await m.mockStepResult({ name: "complete-1" }, done);
		});
		try {
			await env.LAND.create({ id, params: { repoId, batchId } });
			await instance.waitForStatus("complete");
			expect(await instance.getOutput()).toEqual(done);
		} finally {
			await instance.dispose();
		}
	});

	it("a stale restack starts attempt 2 under attempt-qualified step names", async () => {
		const repoId = ulid();
		const batchId = `lb_${ulid()}`;
		const id = landInstanceId(repoId, batchId);
		const composed = (n: number) => ({
			kind: "composed",
			base: SHA(n),
			candidate: SHA(10 + n),
			landed: [{
				changeId: "zkqvzkqvzkqvzkqvzkqvzkqvzkqvzkqv",
				laneId: "ln_01k6eeeeeeeeeeeeeeeeeeeeee",
				head: SHA(2),
				commit: SHA(10 + n),
				parent: SHA(n),
			}],
			conflicted: [],
			date: 1,
		});
		const instance = await introspectWorkflowInstance(env.LAND, id);
		await instance.modify(async (m: Modifier) => {
			await m.disableSleeps();
			await m.mockStepResult({ name: "load" }, {
				state: "composing",
				attempt: 1,
				ref: "refs/heads/main",
				testPolicy: "none",
			});
			await m.mockStepResult({ name: "compose-1" }, composed(1));
			await m.mockStepResult({ name: "gate-1" }, { vetoed: [] });
			await m.mockStepResult({ name: "lock-1" }, {
				kind: "locked",
				advanceId: `adv_${batchId.slice(3)}_1`,
				expectOld: SHA(3),
			});
			await m.mockStepResult({ name: "restack-1" }, { kind: "stale" });
			await m.mockStepResult({ name: "next-1" }, { attempt: 2 });
			await m.mockStepResult({ name: "compose-2" }, composed(3));
			await m.mockStepResult({ name: "gate-2" }, { vetoed: [] });
			await m.mockStepResult({ name: "lock-2" }, {
				kind: "locked",
				advanceId: `adv_${batchId.slice(3)}_2`,
				expectOld: SHA(3),
			});
			await m.mockStepResult({ name: "restack-2" }, {
				kind: "restacked",
				newSha: SHA(13),
				notesBase: "0".repeat(40),
				notesTip: SHA(7),
				changeRefs: [],
			});
			await m.mockStepResult({ name: "push-trunk-2" }, { kind: "pushed" });
			await m.mockStepResult({ name: "push-notes-2" }, { mocked: true });
			await m.mockStepResult({ name: "push-refs-2" }, { mocked: true });
			await m.mockStepResult({ name: "complete-2" }, {
				state: "landed",
				attempt: 2,
				landed: [],
			});
		});
		try {
			await env.LAND.create({ id, params: { repoId, batchId } });
			await instance.waitForStatus("complete");
			expect(await instance.getOutput()).toEqual({
				state: "landed",
				attempt: 2,
				landed: [],
			});
		} finally {
			await instance.dispose();
		}
	});
});

void landed;
