/// <reference types="@cloudflare/vitest-pool-workers/types" />
// WP10 in workerd (vitest-pool-workers, project `land`): the real RepoDO
// (every module, DO SQLite, the real event log) answering the land facade
// over RPC, LAND instances created by RepoDO after the batch row, and
// LandWorkflow in the real Workflows engine with its steps mocked (step
// names of a full attempt, the `verdict-n` event, the K5 wait, params
// checks). Git itself runs in the Deno tests (stock git) and live: the pool
// has no container.

import { introspectWorkflowInstance } from "cloudflare:test";
import { landInstanceId, ulid } from "@tartan/contract";
import { afterAll, describe, expect, it } from "vitest";
import { settleBackground, testEnv as env } from "../../../test/env.ts";

const SHA = (n: number) => n.toString(16).padStart(40, "c");

type Modifier = Parameters<
	Parameters<
		Awaited<ReturnType<typeof introspectWorkflowInstance>>["modify"]
	>[0]
>[0];

const landed = { state: "landed", attempt: 1, landed: [] };

// The review installation's catch-up reads and the event pokes run in the
// background of these tests.
afterAll(() => settleBackground());

describe("RepoDO land module over RPC", () => {
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
