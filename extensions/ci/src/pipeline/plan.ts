// The JobGraph planner: which jobs of a pipeline
// run for a trigger and an affected set, expanded per project and ordered.
//
// - The trigger (`on.change`, `on.land`, `on.push.jobs`) selects jobs, plus
//   everything they need, transitively.
// - `each: affected` expands a job once per affected project, `each: all`
//   once per project; a job pinned to a project (zero-config) is planned
//   only when that project is affected; other jobs run once.
// - A need on an expanded job means "the same project's instance" when both
//   sides expand per project, else every instance; a need on a job with no
//   instance is dropped.
// - Planned ids satisfy `JOB_ID_RE` (`<job>-<project slug>`, de-duplicated);
//   the check context is `<job>` or `<job>:<project>`.
//
// Pure: the caller resolves the policy (pipeline at the base, K13), the
// graph at the base and the affected set first.

import { JOB_ID_RE, topoOrder } from "@tartan/contract";
import type { Affected } from "@tartan/contract";
import { createProjectIndex, type GraphLike } from "./graph.ts";
import type { Pipeline, PipelineJob } from "./schema.ts";

/** Jobs per run (`CiJobGraphSchema`). */
export const PLAN_MAX_JOBS = 64;

export type PlanTrigger = "change" | "land" | "push";

export type PlannedJob = {
	/** Run-level job id (`JOB_ID_RE`). */
	readonly id: string;
	/** Check context shown on the change: `test` or `test:api`. */
	readonly context: string;
	/** The declared job it came from. */
	readonly job: string;
	readonly project?: string;
	readonly run: string;
	readonly cwd?: string;
	readonly needs: readonly string[];
	readonly optional: boolean;
	readonly timeoutMs?: number;
	readonly env: Readonly<Record<string, string>>;
};

export type Plan = {
	readonly jobs: readonly PlannedJob[];
	readonly timeoutMs: number;
};

export type PlanResult =
	| { readonly ok: true; readonly plan: Plan }
	| { readonly ok: false; readonly error: string };

/** A project name as a job-id fragment. */
export const slug = (name: string): string =>
	name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
		.slice(0, 28) || "root";

const substitute = (
	text: string,
	project: { readonly name: string; readonly root: string } | undefined,
): string =>
	project === undefined ? text : text.replace(
		/\{\{\s*project\.(root|name)\s*\}\}/g,
		(_, key: string) => key === "root" ? project.root : project.name,
	);

/** The jobs a trigger selects, with their needs, in declaration order. */
export const selectJobs = (
	pipeline: Pipeline,
	trigger: PlanTrigger,
): PipelineJob[] => {
	const wanted = trigger === "change"
		? pipeline.on.change
		: trigger === "land"
		? pipeline.on.land
		: pipeline.on.push.jobs;
	const byId = new Map(pipeline.jobs.map((j) => [j.id, j]));
	const picked = new Set<string>();
	const queue = [...wanted];
	while (queue.length > 0) {
		const id = queue.pop()!;
		const job = byId.get(id);
		if (job === undefined || picked.has(id)) continue;
		picked.add(id);
		queue.push(...job.needs);
	}
	return pipeline.jobs.filter((j) => picked.has(j.id));
};

/** Plans `pipeline` for `trigger` on `graph` (at the base) and `affected`. */
export const planJobs = (
	pipeline: Pipeline,
	graph: GraphLike,
	affected: Affected,
	trigger: PlanTrigger,
): PlanResult => {
	const index = createProjectIndex(graph);
	const affectedSet = new Set(affected.projects);
	const selected = selectJobs(pipeline, trigger);

	type Instance = { readonly id: string; readonly project?: string };
	const instances = new Map<string, Instance[]>();
	const used = new Set<string>();
	const uniqueId = (base: string): string => {
		let id = base.slice(0, 60).replace(/-+$/, "");
		for (let n = 2; used.has(id) || !JOB_ID_RE.test(id); n++) {
			const suffix = `-${n}`;
			id = `${base.slice(0, 60 - suffix.length).replace(/-+$/, "")}${suffix}`;
			if (n > 999) throw new Error(`cannot name job ${base}`);
		}
		used.add(id);
		return id;
	};

	const projectsFor = (job: PipelineJob): (string | undefined)[] => {
		if (job.project !== undefined) {
			return affectedSet.has(job.project) ? [job.project] : [];
		}
		if (job.each === "affected") {
			return [...affectedSet].filter((p) => index.project(p) !== null).sort();
		}
		if (job.each === "all") return [...index.allNames];
		return [undefined];
	};
	const perProject = (job: PipelineJob): boolean =>
		job.each !== undefined || job.project !== undefined;

	// Instance ids first, so needs can refer to any declared job.
	for (const job of selected) {
		const name = job.name ?? job.id;
		instances.set(
			job.id,
			projectsFor(job).map((project) => ({
				id: uniqueId(
					project === undefined ? name : `${name}-${slug(project)}`,
				),
				...(project !== undefined ? { project } : {}),
			})),
		);
	}

	const byId = new Map(selected.map((j) => [j.id, j]));
	const planned: PlannedJob[] = [];
	for (const job of selected) {
		const name = job.name ?? job.id;
		for (const inst of instances.get(job.id) ?? []) {
			const needs = job.needs.flatMap((need) => {
				const targets = instances.get(need) ?? [];
				const needJob = byId.get(need);
				if (
					inst.project !== undefined && needJob !== undefined &&
					perProject(needJob) && perProject(job)
				) {
					const same = targets.filter((t) => t.project === inst.project);
					if (same.length > 0) return same.map((t) => t.id);
				}
				return targets.map((t) => t.id);
			});
			const project = inst.project === undefined
				? undefined
				: index.project(inst.project) ??
					{ name: inst.project, root: "" };
			const cwd = job.cwd === undefined
				? undefined
				: substitute(job.cwd, project);
			planned.push({
				id: inst.id,
				context: inst.project === undefined ? name : `${name}:${inst.project}`,
				job: job.id,
				...(inst.project !== undefined ? { project: inst.project } : {}),
				run: substitute(job.run, project),
				...(cwd !== undefined && cwd !== "" ? { cwd } : {}),
				needs: [...new Set(needs)],
				optional: job.optional,
				...(job.timeoutMs !== undefined ? { timeoutMs: job.timeoutMs } : {}),
				env: job.env,
			});
		}
	}

	if (planned.length > PLAN_MAX_JOBS) {
		return {
			ok: false,
			error:
				`the plan has ${planned.length} jobs; a run holds at most ${PLAN_MAX_JOBS}`,
		};
	}
	const order = topoOrder(planned);
	if (order === null) return { ok: false, error: "job needs form a cycle" };
	const byPlanned = new Map(planned.map((j) => [j.id, j]));
	return {
		ok: true,
		plan: {
			jobs: order.map((id) => byPlanned.get(id)!),
			timeoutMs: pipeline.timeoutMs,
		},
	};
};

/**
 * The jobs that must run given the cached ones: every job without a cache
 * hit, plus everything such a job needs (a fresh sandbox has no outputs of
 * a skipped job, so an `install` needed by an uncached test runs again).
 * A support job (no project, needed by another job, e.g. `install`) runs
 * only for a job that runs: its hash covers the whole tree, so it would
 * otherwise never hit the cache on a land candidate.
 */
export const jobsToRun = (
	jobs: readonly PlannedJob[],
	cached: ReadonlySet<string>,
): Set<string> => {
	const byId = new Map(jobs.map((j) => [j.id, j]));
	const needed = new Set(jobs.flatMap((j) => j.needs));
	const support = (j: PlannedJob) =>
		j.project === undefined && needed.has(j.id);
	const run = new Set<string>();
	const queue = jobs.filter((j) => !cached.has(j.id) && !support(j)).map((
		j,
	) => j.id);
	while (queue.length > 0) {
		const id = queue.pop()!;
		if (run.has(id)) continue;
		run.add(id);
		queue.push(...(byId.get(id)?.needs ?? []));
	}
	return run;
};
