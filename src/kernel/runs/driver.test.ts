import { deepEqual, equal, ok } from "node:assert/strict";
import {
	jobEventType,
	type JobGraph,
	type JobState,
	STEP_NAME_MAX,
} from "@tartan/contract";
import {
	type DriveInput,
	driveRun,
	RUN_POLL_MS,
	type RunServices,
} from "./driver.ts";
import { fakeStep } from "./testing/step.ts";
import { ciGraph, REPO, runsHarness } from "./testing/runs.ts";

type Outcome = JobState | "silent";

type WorldRef = {
	readonly h: ReturnType<typeof runsHarness>;
	readonly runId: string;
};

/**
 * A world for the driver: the real runs module, a slot semaphore that makes
 * the run wait `slotWaits` times, and a scripted sandbox. When the workflow
 * waits on a job, the job ends with its scripted outcome: with an event, or
 * `silent` (state recorded, event lost: the pump died) so only the poll
 * fallback can notice.
 */
const world = async (options: {
	graph?: JobGraph;
	outcomes?: Record<string, Outcome>;
	slotWaits?: number;
	checkoutExit?: number;
	waitMode?: DriveInput["waitMode"];
	onWait?: (name: string, w: WorldRef) => Promise<void> | void;
} = {}) => {
	const graph = options.graph ?? ciGraph();
	const h = runsHarness();
	const { runId } = await h.runs.start({
		graph,
		idemKey: "w",
		requestedBy: "kernel",
	});
	const started: string[] = [];
	const lost = new Set<string>();
	let reconciles = 0;
	let stops = 0;
	let slotWaits = options.slotWaits ?? 0;
	const slotCalls: string[] = [];
	const usage: number[] = [];
	const finishJob = async (jobId: string) => {
		const outcome = options.outcomes?.[jobId] ?? "success";
		const state: JobState = outcome === "silent" ? "success" : outcome;
		await h.runs.setJobState(runId, jobId, {
			state,
			exitCode: state === "success" ? 0 : 1,
		});
		if (outcome === "silent") lost.add(jobId);
		else steps.send(jobEventType(jobId, 1), { state });
	};
	const self = {
		h,
		runId,
		started,
		slotCalls,
		usage,
		get reconciles() {
			return reconciles;
		},
		get stops() {
			return stops;
		},
		steps: undefined as unknown as ReturnType<typeof fakeStep>,
	};
	const steps = fakeStep({
		onWait: async (name, type) => {
			await options.onWait?.(name, self);
			const jobId = /^job-(.+)-a1$/.exec(type)![1];
			const status = (await h.runs.get(runId))!;
			const job = status.jobs.find((j) => j.jobId === jobId)!;
			if (job.state === "running") await finishJob(jobId);
		},
	});
	self.steps = steps;
	const services: RunServices = {
		runs: h.runs,
		slots: {
			acquire: (_kind, id) => {
				slotCalls.push(id);
				if (slotWaits > 0) {
					slotWaits -= 1;
					return Promise.resolve({ wait: true as const, retryAfterMs: 7_000 });
				}
				return Promise.resolve({ slotKey: `ci:${id}` });
			},
			release: (key) => {
				slotCalls.push(`release ${key}`);
				return Promise.resolve();
			},
			recordUsage: (_kind, ms) => {
				usage.push(ms);
				return Promise.resolve();
			},
		},
		sandbox: {
			prepare: () =>
				Promise.resolve({
					exitCode: options.checkoutExit ?? 0,
					stdout: "",
					stderr: options.checkoutExit ? "fatal: no such commit" : "",
				}),
			runJob: ({ job }) => {
				started.push(job.id);
				return Promise.resolve({
					jobId: job.id,
					attempt: 1,
					phase: "running" as const,
					processId: `p-${job.id}`,
				});
			},
			reconcile: () => {
				reconciles += 1;
				return Promise.resolve([]);
			},
			stopRun: () => {
				stops += 1;
				return Promise.resolve();
			},
		},
	};
	const run = () =>
		driveRun(steps.step, services, {
			repoId: REPO,
			runId,
			instanceId: `run-${REPO}-${runId}`,
			graph,
			requestedBy: "kernel",
			waitMode: options.waitMode ?? "event",
			now: () => 1_790_000_000_000,
		});
	return Object.assign(self, { run, lost });
};

Deno.test("runs the DAG in order with events and finishes cleanly", async () => {
	const w = await world();
	const result = await w.run();
	equal(result.state, "success");
	deepEqual(w.started, ["install", "lint", "test"]);
	deepEqual(w.steps.names, [
		"register",
		"slot-0",
		"running",
		"checkout",
		"start-install-a1",
		"wait-install-a1-0",
		"state-0",
		"start-lint-a1",
		"start-test-a1",
		"wait-lint-a1-1",
		"state-1",
		"wait-test-a1-2",
		"state-2",
		"finish",
	]);
	equal((await w.h.runs.get(w.runId))!.state, "success");
	equal(w.stops, 1, "the sandbox is destroyed at finish");
	deepEqual(w.slotCalls, [w.runId, `release ci:${w.runId}`]);
	equal(w.usage.length, 1);
	for (const name of w.steps.names) ok(name.length <= STEP_NAME_MAX);
	equal(
		new Set(w.steps.names).size,
		w.steps.names.length,
		"step names are unique",
	);
});

Deno.test("a full semaphore sleeps with iteration-qualified steps (slot waiting)", async () => {
	const w = await world({ slotWaits: 2 });
	equal((await w.run()).state, "success");
	deepEqual(w.steps.names.slice(0, 7), [
		"register",
		"slot-0",
		"slot-wait-run-a1-0",
		"slot-1",
		"slot-wait-run-a1-1",
		"slot-2",
		"running",
	]);
	deepEqual(w.steps.slept, [
		{ name: "slot-wait-run-a1-0", ms: 7_000 },
		{ name: "slot-wait-run-a1-1", ms: 7_000 },
	]);
});

Deno.test("a lost event is caught by the poll fallback, which reconciles the sandbox", async () => {
	const w = await world({ outcomes: { install: "silent" } });
	equal((await w.run()).state, "success");
	ok(w.steps.names.includes("poll-install-a1-0"));
	equal(w.reconciles, 1);
	ok(!w.steps.names.includes("state-0"));
});

Deno.test("poll mode sleeps between polls instead of waiting for events", async () => {
	const w = await world({
		waitMode: "poll",
		onWait: () => undefined,
	});
	// In poll mode the onWait hook never runs, so finish jobs on each sleep.
	const original = w.steps.step.sleep;
	w.steps.step.sleep = async (name: string, ms: number) => {
		await original(name, ms);
		const status = (await w.h.runs.get(w.runId))!;
		for (const job of status.jobs) {
			if (job.state === "running") {
				await w.h.runs.setJobState(w.runId, job.jobId, {
					state: "success",
					exitCode: 0,
				});
			}
		}
	};
	equal((await w.run()).state, "success");
	ok(w.steps.names.includes("sleep-install-a1-0"));
	ok(w.steps.names.includes("poll-install-a1-0"));
	ok(
		w.steps.slept.every((s) =>
			s.name.startsWith("sleep-") ? s.ms === RUN_POLL_MS : true
		),
	);
});

Deno.test("a required failure skips dependents and fails the run; an optional one does not", async () => {
	const graph = ciGraph({
		jobs: [
			{ id: "install", run: "i" },
			{ id: "lint", needs: ["install"], run: "l", optional: true },
			{ id: "test", needs: ["install"], run: "t" },
			{ id: "report", needs: ["test"], run: "r" },
		],
	});
	const optionalOnly = await world({ graph, outcomes: { lint: "failure" } });
	equal((await optionalOnly.run()).state, "success");

	const w = await world({ graph, outcomes: { test: "failure" } });
	const result = await w.run();
	equal(result.state, "failure");
	equal(result.jobs.report, "skipped");
	ok(w.steps.names.some((n) => n.startsWith("skip-")));
	equal((await w.h.runs.get(w.runId))!.state, "failure");
});

Deno.test("a run cancelled mid-flight stops the loop and keeps its cancelled state", async () => {
	let cancelled = false;
	const w = await world({
		onWait: async (_name, self) => {
			if (cancelled) return;
			cancelled = true;
			await self.h.runs.cancel(self.runId, "u_01k6aaaaaaaaaaaaaaaaaaaaac");
		},
	});
	const result = await w.run();
	equal(result.state, "cancelled");
	deepEqual(w.started, ["install"], "nothing starts after the cancel");
	equal(w.stops, 1);
	ok(w.slotCalls.includes(`release ci:${w.runId}`));
});

Deno.test("a superseded run that never started goes straight to finish", async () => {
	const w = await world();
	await w.h.runs.setRunState(w.runId, "superseded");
	equal((await w.run()).state, "superseded");
	deepEqual(w.steps.names, ["register", "finish"]);
	deepEqual(w.started, []);
});

Deno.test("a failed checkout ends the run as error with the redacted reason", async () => {
	const w = await world({ checkoutExit: 128 });
	const result = await w.run();
	equal(result.state, "error");
	ok(result.error!.includes("fatal: no such commit"));
	equal((await w.h.runs.get(w.runId))!.state, "error");
	equal(w.stops, 1);
});
