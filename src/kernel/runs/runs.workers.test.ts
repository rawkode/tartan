/// <reference types="@cloudflare/vitest-pool-workers/types" />
// WP9 in workerd (vitest-pool-workers, project `runs`): the runs and slots
// modules over real DO SQLite and RPC, TartanSandbox without a container
// (the pool and `--no-containers` render), and RunWorkflow in the real
// Workflows engine with its sandbox and RepoDO steps mocked (DAG, slot
// waiting, poll fallback, supersede, timeout).

import {
	introspectWorkflowInstance,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import {
	type JobGraphInput,
	jobSandboxName,
	runInstanceId,
} from "@tartan/contract";
import { COMMON_DDL } from "@tartan/contract/kernel.ts";
import { describe, expect, it } from "vitest";
import { testEnv as env, uniqueName } from "../../../test/env.ts";
import { createDoHost } from "../../do/host.ts";
import { createRepoRunsModule, type RunsEffects } from "./module.ts";
import { SLOT_TIMER_PREFIX } from "./slots.ts";

const REPO = "01k6aaaaaaaaaaaaaaaaaaaaaa";
const SHA = "c".repeat(40);

const graph = (extra: Partial<JobGraphInput> = {}): JobGraphInput => ({
	repo: { id: REPO },
	kind: "ci",
	subject: { kind: "change", id: "c1" },
	source: { repoId: REPO },
	sha: SHA,
	jobs: [
		{ id: "install", run: "pnpm install" },
		{ id: "lint", needs: ["install"], run: "pnpm lint", optional: true },
		{ id: "test", needs: ["install"], run: "pnpm test" },
	],
	...extra,
});

// ---------------------------------------------------------------------------
// Runs module over DO SQLite (a test host with a fake event log)
// ---------------------------------------------------------------------------

describe("runs module in a Durable Object", () => {
	it("starts idempotently, supersedes, cancels and keeps terminal states over RPC", async () => {
		await runInDurableObject(
			env.REPO.getByName(uniqueName("runs-host")),
			async (_instance, state) => {
				const appended: string[] = [];
				const stopped: string[] = [];
				const effects: RunsEffects = {
					createInstance: () => Promise.resolve("created"),
					stopSandbox: (runId) => {
						stopped.push(runId);
						return Promise.resolve();
					},
					wake: () => Promise.resolve(),
					readLog: () => Promise.resolve(null),
				};
				const host = createDoHost({
					kind: "test",
					ctx: state,
					env,
					modules: {
						runs: createRepoRunsModule({ effects: () => effects }),
						events: {
							name: "events",
							range: [200, 249] as const,
							migrations: [],
							create: () => ({
								facade: {},
								internal: {
									appendSync: (input: { type: string }) => {
										appended.push(input.type);
										return {
											id: "e",
											seq: appended.length,
											hash: "0",
											created: true,
										};
									},
								},
							}),
						},
					},
					common: [{
						n: 1,
						name: "base",
						sql: `${COMMON_DDL.meta};\n${COMMON_DDL.timers}`,
					}],
				});
				await host.ready;
				const runs = host.facade("runs");
				const g = graph({ concurrencyGroup: "change:c1" });
				const a = await runs.start({
					graph: g as never,
					idemKey: "k1",
					requestedBy: "kernel",
				});
				expect(
					(await runs.start({
						graph: g as never,
						idemKey: "k1",
						requestedBy: "kernel",
					})).runId,
				).toBe(a.runId);
				const b = await runs.start({
					graph: g as never,
					idemKey: "k2",
					requestedBy: "kernel",
				});
				expect((await runs.get(a.runId))?.state).toBe("superseded");
				await runs.setRunState(b.runId, "running");
				await runs.setJobState(b.runId, "install", { state: "running" });
				await runs.cancel(b.runId, "sys_kernel");
				expect(stopped).toEqual(expect.arrayContaining([a.runId, b.runId]));
				const status = await runs.get(b.runId);
				expect(status?.state).toBe("cancelled");
				expect(status?.jobs.map((j) => j.state)).toEqual([
					"cancelled",
					"skipped",
					"skipped",
				]);
				expect(appended.filter((t) => t === "run.completed")).toHaveLength(2);
				const error = await runs.setJobState(b.runId, "nope", {
					state: "running",
				}).catch((e: unknown) => e);
				expect(String(error)).toContain("no job nope");
			},
		);
	});

	it("the real RepoDO serves reads (no run, empty list)", async () => {
		const runs = env.REPO.getByName(`repo:${REPO}`).runs();
		expect(await runs.get("01k6zzzzzzzzzzzzzzzzzzzzzz")).toBeNull();
		expect((await runs.list({})).runs).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Slots on the real ForgeDO (timers + alarm)
// ---------------------------------------------------------------------------

describe("job slots on ForgeDO", () => {
	it("caps concurrent CI slots and frees an expired one after destroying its sandbox", async () => {
		const forge = env.FORGE.getByName(uniqueName("slots"));
		const slots = forge.slots();
		const runIds = ["r1", "r2", "r3", "r4"].map((r) =>
			`01k6${r}`.padEnd(26, "0")
		);
		for (const id of runIds) {
			expect(await slots.acquire("ci", id, 600_000)).toEqual({
				slotKey: `ci:${id}`,
			});
		}
		const fifth = await slots.acquire("ci", "01k6r5".padEnd(26, "0"), 600_000);
		expect(fifth).toMatchObject({ wait: true });
		// Expire r1's lease and fire the ForgeDO alarm.
		await runInDurableObject(forge, (_i, state) => {
			state.storage.sql.exec(
				"UPDATE job_slots SET expires_at = 1 WHERE run_id = ?",
				runIds[0],
			);
			state.storage.sql.exec(
				"UPDATE _timers SET at = 1 WHERE key = ?",
				`${SLOT_TIMER_PREFIX}ci:${runIds[0]}`,
			);
			return state.storage.setAlarm(Date.now() + 60_000);
		});
		expect(await runDurableObjectAlarm(forge)).toBe(true);
		const left = await runInDurableObject(
			forge,
			(_i, state) =>
				state.storage.sql.exec<{ run_id: string }>(
					"SELECT run_id FROM job_slots ORDER BY run_id",
				).toArray().map((r) => r.run_id),
		);
		expect(left).toEqual(runIds.slice(1));
		expect(
			await slots.acquire("ci", "01k6r5".padEnd(26, "0"), 600_000),
		).toEqual({ slotKey: `ci:${"01k6r5".padEnd(26, "0")}` });
		await slots.recordUsage("ci", 1234);
		const day = new Date().toISOString().slice(0, 10);
		expect(await slots.usage(day)).toEqual([
			{ day, kind: "ci", container_ms: 1234, runs: 1 },
		]);
	});
});

// ---------------------------------------------------------------------------
// TartanSandbox without a container
// ---------------------------------------------------------------------------

describe("TartanSandbox without a container", () => {
	it("constructs, answers state calls and stops cleanly; container calls fail clearly", async () => {
		const box = env.SANDBOX.getByName(
			jobSandboxName("01k6dddddddddddddddddddddd"),
		);
		expect(await box.jobState("x", 1)).toBeNull();
		expect(await box.runnerInfo()).toBeNull();
		expect(await box.reconcile()).toEqual([]);
		await box.stopRun();
		const error = await box.gitExec(["git", "--version"]).catch((e: unknown) =>
			e
		);
		expect(String(error)).toMatch(/containers are not enabled/);
	});
});

// ---------------------------------------------------------------------------
// RunWorkflow in the Workflows engine
// ---------------------------------------------------------------------------

const RUN = "01k6eeeeeeeeeeeeeeeeeeeeee";

/** Starts a run instance whose RepoDO/sandbox steps are mocked by `steps`. */
const startRun = async (
	runId: string,
	mock: (
		m: Parameters<
			Parameters<
				Awaited<ReturnType<typeof introspectWorkflowInstance>>["modify"]
			>[0]
		>[0],
	) => Promise<void>,
	g: JobGraphInput = graph(),
) => {
	const id = runInstanceId(REPO, runId);
	const instance = await introspectWorkflowInstance(env.RUNS, id);
	await instance.modify(async (m) => {
		await m.disableSleeps();
		await mock(m);
	});
	await env.RUNS.create({
		id,
		params: { repoId: REPO, runId, graph: g, requestedBy: "kernel" },
	});
	return instance;
};

const running = { phase: "running", outcome: "failure" };
const jobsState = (
	state: string,
	jobs: Record<string, string>,
) => ({ state, jobs });
const FINISH = { state: "success", jobs: {} };

describe("RunWorkflow (introspectWorkflowInstance)", () => {
	it("runs the DAG: install, then lint and test, each woken by its job event", async () => {
		const instance = await startRun(RUN, async (m) => {
			await m.mockStepResult({ name: "register" }, jobsState("queued", {}));
			await m.mockStepResult({ name: "slot-0" }, {
				kind: "slot",
				slotKey: `ci:${RUN}`,
				at: 1,
			});
			await m.mockStepResult({ name: "running" }, { state: "running" });
			await m.mockStepResult({ name: "checkout" }, { exitCode: 0, detail: "" });
			await m.mockStepResult({ name: "start-install-a1" }, running);
			await m.mockEvent({
				type: "job-install-a1",
				payload: { state: "success" },
			});
			await m.mockStepResult(
				{ name: "state-0" },
				jobsState("running", {
					install: "success",
					lint: "pending",
					test: "pending",
				}),
			);
			await m.mockStepResult({ name: "start-lint-a1" }, running);
			await m.mockStepResult({ name: "start-test-a1" }, running);
			await m.mockEvent({ type: "job-lint-a1", payload: { state: "success" } });
			await m.mockStepResult(
				{ name: "state-1" },
				jobsState("running", {
					install: "success",
					lint: "success",
					test: "running",
				}),
			);
			await m.mockEvent({ type: "job-test-a1", payload: { state: "success" } });
			await m.mockStepResult(
				{ name: "state-2" },
				jobsState("running", {
					install: "success",
					lint: "success",
					test: "success",
				}),
			);
			await m.mockStepResult({ name: "finish" }, FINISH);
		});
		try {
			await instance.waitForStatus("complete");
			expect(await instance.getOutput()).toEqual(FINISH);
		} finally {
			await instance.dispose();
		}
	});

	it("waits for a slot with slot-wait steps, then proceeds", async () => {
		const runId = "01k6ffffffffffffffffffffff";
		const instance = await startRun(runId, async (m) => {
			await m.mockStepResult({ name: "register" }, jobsState("queued", {}));
			await m.mockStepResult({ name: "slot-0" }, {
				kind: "wait",
				retryAfterMs: 5_000,
			});
			await m.mockStepResult({ name: "slot-1" }, {
				kind: "wait",
				retryAfterMs: 5_000,
			});
			await m.mockStepResult({ name: "slot-2" }, {
				kind: "slot",
				slotKey: `ci:${runId}`,
				at: 1,
			});
			await m.mockStepResult({ name: "running" }, { state: "running" });
			await m.mockStepResult({ name: "checkout" }, {
				exitCode: 1,
				detail: "x",
			});
			await m.mockStepResult({ name: "finish" }, { state: "error", jobs: {} });
		}, graph({ jobs: [{ id: "only", run: "true" }] }));
		try {
			await instance.waitForStatus("complete");
			expect(await instance.getOutput()).toEqual({ state: "error", jobs: {} });
		} finally {
			await instance.dispose();
		}
	});

	it("falls back to a poll step when the job event never arrives, and stops on a timeout failure", async () => {
		const runId = "01k6gggggggggggggggggggggg";
		const instance = await startRun(runId, async (m) => {
			await m.mockStepResult({ name: "register" }, jobsState("queued", {}));
			await m.mockStepResult({ name: "slot-0" }, {
				kind: "slot",
				slotKey: `ci:${runId}`,
				at: 1,
			});
			await m.mockStepResult({ name: "running" }, { state: "running" });
			await m.mockStepResult({ name: "checkout" }, { exitCode: 0, detail: "" });
			await m.mockStepResult({ name: "start-install-a1" }, running);
			await m.forceEventTimeout({ name: "wait-install-a1-0" });
			// The poll's reconcile found the job over its timeout: failure.
			await m.mockStepResult(
				{ name: "poll-install-a1-0" },
				jobsState("running", {
					install: "failure",
					lint: "pending",
					test: "pending",
				}),
			);
			await m.mockStepResult({ name: "skip-1" }, { skipped: ["lint", "test"] });
			await m.mockStepResult({ name: "finish" }, {
				state: "failure",
				jobs: {},
			});
		});
		try {
			await instance.waitForStatus("complete");
			expect(await instance.getOutput()).toEqual({
				state: "failure",
				jobs: {},
			});
		} finally {
			await instance.dispose();
		}
	});

	it("stops waiting when the run is superseded", async () => {
		const runId = "01k6hhhhhhhhhhhhhhhhhhhhhh";
		const instance = await startRun(runId, async (m) => {
			await m.mockStepResult({ name: "register" }, jobsState("queued", {}));
			await m.mockStepResult({ name: "slot-0" }, {
				kind: "slot",
				slotKey: `ci:${runId}`,
				at: 1,
			});
			await m.mockStepResult({ name: "running" }, { state: "running" });
			await m.mockStepResult({ name: "checkout" }, { exitCode: 0, detail: "" });
			await m.mockStepResult({ name: "start-install-a1" }, running);
			// The supersede woke the waiting job with `cancelled`.
			await m.mockEvent({
				type: "job-install-a1",
				payload: { state: "cancelled" },
			});
			await m.mockStepResult(
				{ name: "state-0" },
				jobsState("superseded", {
					install: "cancelled",
					lint: "skipped",
					test: "skipped",
				}),
			);
			await m.mockStepResult({ name: "finish" }, {
				state: "superseded",
				jobs: {},
			});
		});
		try {
			await instance.waitForStatus("complete");
			expect(await instance.getOutput()).toEqual({
				state: "superseded",
				jobs: {},
			});
		} finally {
			await instance.dispose();
		}
	});
});
