// RunWorkflow's body, written against a minimal step
// interface so it runs under the Workflows engine and under a fake in Deno
// tests. Steps, in order:
//
//   register        the run row (a run cancelled or superseded before it
//                   started goes straight to finish)
//   slot-<i>        acquire a ForgeDO job slot; a full semaphore sleeps
//                   (`slot-wait-run-a1-<i>`, no Workflow concurrency used)
//   running         queued → running
//   checkout        `prepare` in `job:<runId>` (first-start retries)
//   start-<job>-a1  `runJob` (returns after `startProcess`; idempotent, so a
//                   retried step re-attaches) for every ready job
//   wait-<job>-a1-<k> / poll-<job>-a1-<k> / state-<k>
//                   `waitForEvent("job-<job>-a1")` with the poll fallback
//                   (`WAIT_MODE`): a timed-out wait runs the sandbox's
//                   `reconcile` (finalize, timeouts, re-attach) and reads the
//                   run; an event reads the run
//   skip-<k>        dependents of failed jobs
//   finish          final state, `stopRun` (destroy), slot release,
//                   usage
//
// Every loop step carries its iteration. Tokens never appear
// in params or step outputs (K11): the sandbox mints them inside its calls.

import {
	JOB_TIMEOUT_DEFAULT_MS,
	jobEventType,
	type JobGraph,
	type JobState,
	runPollStep,
	runSlotWaitStep,
	type RunState,
	type RunStatus,
	TERMINAL_RUN_STATES,
} from "@tartan/contract";
import { type DagJob, dagStep, runOutcome } from "./dag.ts";
import type { ExecOutput, JobSnapshot } from "./jobs.ts";
import { safeText } from "./joblog.ts";
import { JOB_ATTEMPT } from "./module.ts";
import { SLOT_TTL_MAX_MS } from "./slots.ts";

/** How long one `waitForEvent` waits before the poll fallback runs. */
export const RUN_POLL_MS = 30_000;
/** Loop guard: a run never needs more iterations than this. */
export const MAX_ITERATIONS = 2_000;
/** Added to the summed job budgets for the slot lease. */
export const SLOT_MARGIN_MS = 15 * 60 * 1000;

export type StepConfig = {
	readonly retries?: {
		readonly limit: number;
		readonly delay: number;
		readonly backoff?: "constant" | "linear" | "exponential";
	};
	readonly timeout?: number;
};

/** The subset of `WorkflowStep` the driver uses. */
export type StepLike = {
	do<T>(name: string, fn: () => Promise<T>): Promise<T>;
	do<T>(name: string, config: StepConfig, fn: () => Promise<T>): Promise<T>;
	sleep(name: string, ms: number): Promise<void>;
	waitForEvent<T>(
		name: string,
		options: { type: string; timeout: number },
	): Promise<{ payload: T }>;
};

export type RunServices = {
	readonly runs: {
		get(runId: string): Promise<RunStatus | null>;
		setRunState(runId: string, state: RunState): Promise<void>;
		setJobState(
			runId: string,
			jobId: string,
			update: { state: JobState },
		): Promise<void>;
	};
	readonly slots: {
		acquire(
			kind: "ci" | "git",
			runId: string,
			ttlMs: number,
		): Promise<{ slotKey: string } | { wait: true; retryAfterMs: number }>;
		release(slotKey: string): Promise<void>;
		recordUsage(kind: string, containerMs: number): Promise<void>;
	};
	readonly sandbox: {
		prepare(input: {
			repoId: string;
			runId: string;
			instanceId: string;
			kind: "ci" | "git";
			requestedBy: string;
			source: JobGraph["source"];
			sha: string;
		}): Promise<ExecOutput>;
		runJob(input: {
			repoId: string;
			runId: string;
			instanceId: string;
			kind: "ci" | "git";
			requestedBy: string;
			job: JobGraph["jobs"][number];
			attempt: number;
			timeoutMs: number;
		}): Promise<JobSnapshot>;
		reconcile(): Promise<JobSnapshot[]>;
		stopRun(): Promise<void>;
	};
};

export type DriveInput = {
	readonly repoId: string;
	readonly runId: string;
	readonly instanceId: string;
	readonly graph: JobGraph;
	readonly requestedBy: string;
	readonly waitMode: "event" | "poll";
	readonly now?: () => number;
};

export type DriveResult = {
	readonly state: RunState;
	readonly jobs: Readonly<Record<string, JobState>>;
	readonly error?: string;
};

const TERMINAL_RUN: ReadonlySet<RunState> = new Set(TERMINAL_RUN_STATES);

type SlotStep =
	| { readonly kind: "stopped" }
	| { readonly kind: "slot"; readonly slotKey: string; readonly at: number }
	| { readonly kind: "wait"; readonly retryAfterMs: number };

/** A step-serializable view of the run: states only (no logs, no tails). */
type Compact = { state: RunState; jobs: Record<string, JobState> } | null;
const compact = (status: RunStatus | null): Compact =>
	status === null ? null : {
		state: status.state,
		jobs: Object.fromEntries(status.jobs.map((j) => [j.jobId, j.state])),
	};

export const jobTimeoutMs = (
	graph: JobGraph,
	job: JobGraph["jobs"][number],
): number => job.timeoutMs ?? graph.timeoutMs ?? JOB_TIMEOUT_DEFAULT_MS;

export const slotTtlMs = (graph: JobGraph): number =>
	Math.min(
		SLOT_TTL_MAX_MS,
		graph.jobs.reduce((sum, job) => sum + jobTimeoutMs(graph, job), 0) +
			SLOT_MARGIN_MS,
	);

export const driveRun = async (
	step: StepLike,
	services: RunServices,
	input: DriveInput,
): Promise<DriveResult> => {
	const { graph, runId } = input;
	const now = input.now ?? (() => Date.now());
	const kind = graph.kind;
	const context = {
		repoId: input.repoId,
		runId,
		instanceId: input.instanceId,
		kind,
		requestedBy: input.requestedBy,
	};
	const dagJobs: DagJob[] = graph.jobs.map((j) => ({
		id: j.id,
		needs: j.needs,
		optional: j.optional,
	}));
	let slot: { slotKey: string; at: number } | null = null;
	let states: Record<string, JobState> = Object.fromEntries(
		graph.jobs.map((j) => [j.id, "pending" as JobState]),
	);
	let failure: string | undefined;

	const finish = (): Promise<DriveResult> =>
		step.do("finish", async () => {
			const status = compact(await services.runs.get(runId));
			let state = status?.state ?? "error";
			const jobs = status?.jobs ?? states;
			if (status !== null && !TERMINAL_RUN.has(status.state)) {
				state = failure !== undefined ? "error" : runOutcome(dagJobs, jobs);
				await services.runs.setRunState(runId, state);
			}
			await services.sandbox.stopRun().catch((error) =>
				console.error("[tartan] stopRun failed", safeText(String(error)))
			);
			if (slot !== null) {
				await services.slots.release(slot.slotKey);
				await services.slots.recordUsage(kind, Math.max(0, now() - slot.at));
			}
			return {
				state,
				jobs,
				...(failure !== undefined ? { error: failure } : {}),
			};
		});

	try {
		const registered = await step.do(
			"register",
			async () => compact(await services.runs.get(runId)),
		);
		if (registered === null) {
			failure = `run ${runId} not found`;
			return await finish();
		}
		if (TERMINAL_RUN.has(registered.state)) return await finish();

		for (let i = 0;; i++) {
			if (i >= MAX_ITERATIONS) throw new Error("slot wait exceeded");
			const got = await step.do(
				`slot-${i}`,
				async (): Promise<SlotStep> => {
					const run = compact(await services.runs.get(runId));
					if (run === null || TERMINAL_RUN.has(run.state)) {
						return { kind: "stopped" };
					}
					const result = await services.slots.acquire(
						kind,
						runId,
						slotTtlMs(graph),
					);
					return "slotKey" in result
						? { kind: "slot", slotKey: result.slotKey, at: now() }
						: { kind: "wait", retryAfterMs: result.retryAfterMs };
				},
			);
			if (got.kind === "stopped") return await finish();
			if (got.kind === "slot") {
				slot = { slotKey: got.slotKey, at: got.at };
				break;
			}
			await step.sleep(
				runSlotWaitStep("run", JOB_ATTEMPT, i),
				got.retryAfterMs,
			);
		}

		await step.do("running", async () => {
			await services.runs.setRunState(runId, "running");
			return { state: "running" };
		});

		const checkout = await step.do("checkout", {
			retries: { limit: 2, delay: 5_000, backoff: "constant" },
			timeout: 15 * 60 * 1000,
		}, async () => {
			const out = await services.sandbox.prepare({
				...context,
				source: graph.source,
				sha: graph.sha,
			});
			return {
				exitCode: out.exitCode,
				detail: safeText(out.stderr || out.stdout, 1024),
			};
		});
		if (checkout.exitCode !== 0) {
			failure =
				`checkout failed (exit ${checkout.exitCode}): ${checkout.detail}`;
			return await finish();
		}

		for (let k = 0;; k++) {
			if (k >= MAX_ITERATIONS) throw new Error("job loop exceeded");
			const next = dagStep(dagJobs, states, { serial: kind === "git" });
			if (next.skip.length > 0) {
				await step.do(`skip-${k}`, async () => {
					for (const jobId of next.skip) {
						await services.runs.setJobState(runId, jobId, { state: "skipped" });
					}
					return { skipped: next.skip };
				});
				states = {
					...states,
					...Object.fromEntries(next.skip.map((id) => [id, "skipped"])),
				};
			}
			for (const jobId of next.start) {
				const job = graph.jobs.find((j) => j.id === jobId)!;
				const started = await step.do(
					`start-${jobId}-a${JOB_ATTEMPT}`,
					{ retries: { limit: 2, delay: 2_000, backoff: "constant" } },
					async () => {
						const snapshot = await services.sandbox.runJob({
							...context,
							job,
							attempt: JOB_ATTEMPT,
							timeoutMs: jobTimeoutMs(graph, job),
						});
						if (snapshot.phase !== "done") {
							await services.runs.setJobState(runId, jobId, {
								state: "running",
							});
						}
						return {
							phase: snapshot.phase,
							outcome: snapshot.outcome ?? "failure",
						};
					},
				);
				states = {
					...states,
					[jobId]: started.phase === "done" ? started.outcome : "running",
				};
			}
			const after = dagStep(dagJobs, states, { serial: kind === "git" });
			if (after.done) break;
			if (after.running.length === 0) {
				// Only skips happened this pass; the next pass starts or ends.
				continue;
			}
			const head = after.running[0];
			let woken = false;
			if (input.waitMode === "event") {
				try {
					await step.waitForEvent(`wait-${head}-a${JOB_ATTEMPT}-${k}`, {
						type: jobEventType(head, JOB_ATTEMPT),
						timeout: RUN_POLL_MS,
					});
					woken = true;
				} catch {
					woken = false;
				}
			} else {
				await step.sleep(`sleep-${head}-a${JOB_ATTEMPT}-${k}`, RUN_POLL_MS);
			}
			const run = await step.do(
				woken ? `state-${k}` : runPollStep(head, JOB_ATTEMPT, k),
				async () => {
					if (!woken) await services.sandbox.reconcile();
					return compact(await services.runs.get(runId));
				},
			);
			if (run === null) throw new Error(`run ${runId} disappeared`);
			states = { ...states, ...run.jobs };
			if (TERMINAL_RUN.has(run.state)) break;
		}
		return await finish();
	} catch (error) {
		failure = safeText(
			error instanceof Error ? error.message : String(error),
			1024,
		);
		return await finish();
	}
};
