// JobGraph: the input of `caps.runs.start` and RunWorkflow. `packages/pipeline`
// (WP14) plans the `tartan.ci` pipeline (repo policy, ADR repo config) into
// this shape; kernel git jobs (WP10) build it directly with `argv`.

import { z } from "zod";
import { GitSourceSchema, RepoRefSchema, ShaSchema } from "./common.ts";
import { JOB_ID_RE } from "./ids.ts";

export const RUN_KINDS = ["ci", "git"] as const; // `agent` is out of v1
export const RunKindSchema = z.enum(RUN_KINDS);
export type RunKind = z.infer<typeof RunKindSchema>;

export const RUN_STATES = [
	"queued",
	"running",
	"success",
	"failure",
	"cancelled",
	"superseded",
	"error",
] as const;
export type RunState = typeof RUN_STATES[number];
export const TERMINAL_RUN_STATES: readonly RunState[] = [
	"success",
	"failure",
	"cancelled",
	"superseded",
	"error",
];

export const JOB_STATES = [
	"pending",
	"running",
	"success",
	"failure",
	"skipped",
	"cancelled",
	"cached",
] as const;
export type JobState = typeof JOB_STATES[number];

/** Hard max per job/run ("hard max 60m"). */
export const JOB_TIMEOUT_MAX_MS = 60 * 60 * 1000;
export const JOB_TIMEOUT_DEFAULT_MS = 15 * 60 * 1000;

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
/** Env names the kernel injects per exec; a graph may not set them (K11). */
export const RESERVED_ENV_PREFIXES = ["GIT_CONFIG_", "TARTAN_", "ARTIFACTS_"];

export const JobSpecSchema = z.strictObject({
	id: z.string().regex(JOB_ID_RE),
	project: z.string().max(128).optional(),
	needs: z.array(z.string().regex(JOB_ID_RE)).max(64).default([]),
	cwd: z.string().max(1024).optional(),
	/** Shell command (CI jobs). Exactly one of `run` and `argv`. */
	run: z.string().min(1).max(8192).optional(),
	/** Argument vector (kernel git jobs, `exec(argv, {env})`). */
	argv: z.array(z.string().max(8192)).min(1).max(256).optional(),
	env: z.record(z.string().regex(ENV_NAME_RE), z.string().max(8192)).optional(),
	optional: z.boolean().default(false),
	timeoutMs: z.number().int().positive().max(JOB_TIMEOUT_MAX_MS).optional(),
	/** Result-cache key: sha256 of job spec, image id, closure tree hashes, global blobs. */
	inputHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).superRefine((job, ctx) => {
	if ((job.run === undefined) === (job.argv === undefined)) {
		ctx.addIssue({
			code: "custom",
			message: "exactly one of run and argv",
			path: ["run"],
		});
	}
	for (const name of Object.keys(job.env ?? {})) {
		if (RESERVED_ENV_PREFIXES.some((p) => name.startsWith(p))) {
			ctx.addIssue({
				code: "custom",
				message: `env ${name} is reserved for the kernel`,
				path: ["env", name],
			});
		}
	}
});
export type JobSpec = z.output<typeof JobSpecSchema>;
export type JobSpecInput = z.input<typeof JobSpecSchema>;

export const JobSubjectSchema = z.strictObject({
	kind: z.enum(["change", "land", "push", "kernel"]),
	id: z.string().min(1).max(200),
});

const graphShape = {
	repo: RepoRefSchema,
	kind: RunKindSchema,
	subject: JobSubjectSchema.optional(),
	/**
	 * What to check out: a lane source is fetched from that lane's repo
	 * (`repo` backend) or the canonical repo (`branch`), with a read token for
	 * that one repo; a candidate lives on canonical.
	 */
	source: GitSourceSchema,
	sha: ShaSchema,
	jobs: z.array(JobSpecSchema).min(1).max(64),
	/** A newer run in the same group supersedes older ones (e.g. one change). */
	concurrencyGroup: z.string().max(200).optional(),
	timeoutMs: z.number().int().positive().max(JOB_TIMEOUT_MAX_MS).optional(),
	/** Runner image id, part of every input hash. */
	image: z.string().max(200).optional(),
};

const checkGraph = (
	graph: {
		readonly jobs: readonly { readonly id: string; readonly needs: string[] }[];
	},
	ctx: z.RefinementCtx,
): void => {
	const ids = graph.jobs.map((j) => j.id);
	const known = new Set(ids);
	if (known.size !== ids.length) {
		ctx.addIssue({
			code: "custom",
			message: "duplicate job ids",
			path: ["jobs"],
		});
		return;
	}
	graph.jobs.forEach((job, i) => {
		for (const need of job.needs) {
			if (!known.has(need)) {
				ctx.addIssue({
					code: "custom",
					message: `unknown dependency ${need}`,
					path: ["jobs", i, "needs"],
				});
			}
		}
	});
	if (topoOrder(graph.jobs) === null) {
		ctx.addIssue({
			code: "custom",
			message: "job graph has a cycle",
			path: ["jobs"],
		});
	}
};

/**
 * The kernel's job graph (`RepoRunsFacade.start`): CI runs and kernel git
 * jobs (`kind: "git"`, `argv`, `subject.kind: "kernel"`). Only kernel modules
 * build `kind: "git"` graphs, and WP9 injects Artifacts write tokens only into
 * runs with `requestedBy: "kernel"` (K1, K11). Extensions use `CiJobGraphSchema`.
 */
export const JobGraphSchema = z.strictObject(graphShape).superRefine(
	checkGraph,
);
export type JobGraph = z.output<typeof JobGraphSchema>;
export type JobGraphInput = z.input<typeof JobGraphSchema>;

/** A CI job: shell `run` only (no `argv`, which is the kernel git-job form). */
export const CiJobSpecSchema = JobSpecSchema.safeExtend({
	run: z.string().min(1).max(8192),
	argv: z.never().optional(),
});

/**
 * `caps.runs.start` input: CI only. `kind` is `ci`, jobs use
 * `run`, the subject is a change, land candidate or push, and
 * `createKernelCaps` additionally requires `source.repoId` to be the resolved
 * `repo` (K12). Kernel git jobs (`kind: "git"`, `argv`, `subject.kind:
 * "kernel"`) are never reachable from an extension.
 */
export const CiJobGraphSchema = z.strictObject({
	...graphShape,
	kind: z.literal("ci"),
	subject: z.strictObject({
		kind: z.enum(["change", "land", "push"]),
		id: z.string().min(1).max(200),
	}).optional(),
	jobs: z.array(CiJobSpecSchema).min(1).max(64),
}).superRefine(checkGraph);
export type CiJobGraph = z.output<typeof CiJobGraphSchema>;
export type CiJobGraphInput = z.input<typeof CiJobGraphSchema>;

/** Kahn order by declaration order; null on a cycle or an unknown dependency. */
export const topoOrder = (
	jobs: readonly { readonly id: string; readonly needs?: readonly string[] }[],
): string[] | null => {
	const ids = new Set(jobs.map((j) => j.id));
	const remaining = new Map(
		jobs.map((j) => [j.id, new Set(j.needs ?? [])] as const),
	);
	for (const deps of remaining.values()) {
		for (const d of deps) if (!ids.has(d)) return null;
	}
	const order: string[] = [];
	while (remaining.size > 0) {
		const ready = jobs.find((j) =>
			remaining.has(j.id) && remaining.get(j.id)!.size === 0
		);
		if (!ready) return null;
		order.push(ready.id);
		remaining.delete(ready.id);
		for (const deps of remaining.values()) deps.delete(ready.id);
	}
	return order;
};

export type JobStatus = {
	readonly jobId: string;
	readonly project?: string;
	readonly state: JobState;
	readonly exitCode?: number;
	readonly startedAt?: number;
	readonly finishedAt?: number;
	readonly cached?: boolean;
	/** Redacted, last 8 KB. */
	readonly tail?: string;
};

/** How a CI run reaches its Workflow: through the global log's consumer, or inline (WP26). */
export const RUN_TRANSPORTS = ["k2", "local"] as const;
export type RunTransport = typeof RUN_TRANSPORTS[number];

/** Who created a run's Workflow instance (`run.dispatched.via`, WP26). */
export const RUN_DISPATCH_VIAS = ["k2", "backstop", "local"] as const;
export type RunDispatchVia = typeof RUN_DISPATCH_VIAS[number];

export type RunStatus = {
	readonly runId: string;
	readonly repoId: string;
	readonly kind: RunKind;
	readonly state: RunState;
	readonly subject?: { readonly kind: string; readonly id: string };
	readonly sha: string;
	readonly requestedBy: string;
	readonly createdAt: number;
	readonly finishedAt?: number;
	/** The run's recorded transport (absent on runs older than the global log). */
	readonly transport?: RunTransport;
	/** Who created its Workflow instance, once it was dispatched. */
	readonly via?: RunDispatchVia;
	/** When its Workflow instance was created. */
	readonly dispatchedAt?: number;
	readonly jobs: readonly JobStatus[];
};

/** Combined job/run caps. */
export const JOB_SLOT_DEFAULTS = { total: 6, ci: 4, git: 2, agent: 2 } as const;
export const DAILY_CONTAINER_BUDGET_VCPU_MIN = 600;
