// Job-graph scheduling for RunWorkflow: one sandbox per
// run, jobs in topological order, independent jobs as parallel processes.
// Pure functions over job states, so the workflow and its tests share them.

import type { JobState, RunState } from "@tartan/contract";

export type DagJob = {
	readonly id: string;
	readonly needs: readonly string[];
	readonly optional: boolean;
};

export type JobStates = Readonly<Record<string, JobState>>;

const TERMINAL_JOB: ReadonlySet<JobState> = new Set([
	"success",
	"failure",
	"skipped",
	"cancelled",
	"cached",
]);

export const isTerminalJob = (state: JobState): boolean =>
	TERMINAL_JOB.has(state);

/** A finished dependency that lets its dependents start. */
const satisfies = (job: DagJob, state: JobState): boolean =>
	state === "success" || state === "cached" ||
	(job.optional && state === "failure");

export type DagStep = {
	/** Pending jobs whose dependencies are all satisfied, in declaration order. */
	readonly start: readonly string[];
	/** Pending jobs that can never run (a dependency failed, was skipped or cancelled). */
	readonly skip: readonly string[];
	readonly running: readonly string[];
	/** True when no job is pending or running. */
	readonly done: boolean;
};

/**
 * What to do next. `serial` (kernel `git` runs, whose write-token execs kill
 * every `tartan-git` process first) starts one job at a time.
 */
export const dagStep = (
	jobs: readonly DagJob[],
	states: JobStates,
	options: { readonly serial?: boolean } = {},
): DagStep => {
	const byId = new Map(jobs.map((j) => [j.id, j]));
	const stateOf = (id: string): JobState => states[id] ?? "pending";
	const running = jobs.filter((j) => stateOf(j.id) === "running").map((j) =>
		j.id
	);
	const skip: string[] = [];
	const ready: string[] = [];
	// Skips propagate in one pass because jobs are checked in topological
	// order of discovery: a job blocked by a job skipped in this pass is
	// skipped too.
	const skipped = new Set<string>();
	for (const job of jobs) {
		if (stateOf(job.id) !== "pending") continue;
		const needs = job.needs.map((n) => byId.get(n)).filter((n) =>
			n !== undefined
		);
		const blocked = needs.some((need) =>
			skipped.has(need.id) ||
			(isTerminalJob(stateOf(need.id)) && !satisfies(need, stateOf(need.id)))
		);
		if (blocked) {
			skip.push(job.id);
			skipped.add(job.id);
			continue;
		}
		if (needs.every((need) => satisfies(need, stateOf(need.id)))) {
			ready.push(job.id);
		}
	}
	// A second pass catches dependents declared before their skipped need.
	let changed = true;
	while (changed) {
		changed = false;
		for (const job of jobs) {
			if (stateOf(job.id) !== "pending" || skipped.has(job.id)) continue;
			if (job.needs.some((n) => skipped.has(n))) {
				skip.push(job.id);
				skipped.add(job.id);
				const at = ready.indexOf(job.id);
				if (at !== -1) ready.splice(at, 1);
				changed = true;
			}
		}
	}
	const start = options.serial
		? (running.length === 0 ? ready.slice(0, 1) : [])
		: ready;
	const pendingLeft = jobs.some((j) =>
		stateOf(j.id) === "pending" && !skipped.has(j.id)
	);
	return {
		start,
		skip,
		running,
		done: running.length === 0 && !pendingLeft,
	};
};

/** The run's final state from its jobs. */
export const runOutcome = (
	jobs: readonly DagJob[],
	states: JobStates,
): Extract<RunState, "success" | "failure" | "cancelled"> => {
	const stateOf = (id: string): JobState => states[id] ?? "pending";
	if (jobs.some((j) => stateOf(j.id) === "cancelled")) return "cancelled";
	const failed = jobs.some((j) =>
		!j.optional &&
		(stateOf(j.id) === "failure" || stateOf(j.id) === "skipped" ||
			stateOf(j.id) === "pending" || stateOf(j.id) === "running")
	);
	return failed ? "failure" : "success";
};
