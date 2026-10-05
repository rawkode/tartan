// The CI pipeline (ADR repo config): `tartan.ci`'s repo
// policy, authored in the repository's package `tartan` as
// `extensions: "tartan.ci": settings: pipeline: {timeout, jobs, on, lanes}`
// and read at the change's base on trunk through `caps.repo.policy` (K13).
// This module validates the exported JSON value.
//
// Strict: unknown keys are errors, so a typo never silently drops a job, and
// an `instance` key anywhere is refused with a pointer to v2. CUE's
// closedness already gave the author positioned errors; this check is the
// boundary (CUE never is). `projects` and `global` are not pipeline keys:
// they are the kernel's top-level fields of package `tartan` (the project
// graph reads them).
//
// Templates: `run` and `cwd` of an `each` job may use `{{project.root}}` and
// `{{project.name}}`; nothing else is expanded.

import { RESERVED_ENV_PREFIXES } from "@tartan/contract";

/** Declared job ids leave room for a `-<project>` suffix within JOB_ID_RE. */
export const PIPELINE_JOB_ID_RE = /^[a-z0-9][a-z0-9-]{0,29}$/;
export const PIPELINE_MAX_JOBS = 32;
export const PIPELINE_TIMEOUT_MAX_MS = 60 * 60 * 1000;
export const PIPELINE_TIMEOUT_DEFAULT_MS = 15 * 60 * 1000;
/** Where the pipeline lives in package `tartan` (for messages). */
export const PIPELINE_LOCATION =
	'extensions: "tartan.ci": settings: pipeline' as const;
/** The repo-policy key `tartan.ci` declares (`config.repoPolicy`). */
export const PIPELINE_POLICY_KEY = "pipeline" as const;

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
const TEMPLATE_RE = /\{\{\s*([^}]*?)\s*\}\}/g;
const TEMPLATE_VARS = new Set(["project.root", "project.name"]);

export type LaneCiMode = "on-push" | "on-submit" | "none";
export type EachMode = "affected" | "all";

export type PipelineJob = {
	readonly id: string;
	/**
	 * Zero-config only (never parsed from YAML): the job is pinned to one
	 * project, planned only when it is affected, and shown as `<name>:<project>`.
	 */
	readonly name?: string;
	readonly project?: string;
	readonly run: string;
	readonly needs: readonly string[];
	readonly each?: EachMode;
	readonly cwd?: string;
	readonly optional: boolean;
	readonly timeoutMs?: number;
	readonly env: Readonly<Record<string, string>>;
};

export type Pipeline = {
	readonly timeoutMs: number;
	/** In declaration order. */
	readonly jobs: readonly PipelineJob[];
	readonly on: {
		readonly change: readonly string[];
		readonly land: readonly string[];
		readonly push: {
			readonly branches: readonly string[];
			readonly jobs: readonly string[];
		};
	};
	readonly lanes: { readonly ci: LaneCiMode };
};

export type PipelineResult =
	| { readonly ok: true; readonly pipeline: Pipeline }
	| { readonly ok: false; readonly errors: readonly string[] };

type Obj = { readonly [key: string]: unknown };

const isObj = (v: unknown): v is Obj =>
	v !== null && typeof v === "object" && !Array.isArray(v);

const DURATION_RE = /^(\d{1,7})(ms|s|m|h)$/;
const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;

/** `15m`, `90s`, `1h`, `500ms` → milliseconds; null when malformed. */
export const parseDuration = (value: unknown): number | null => {
	if (typeof value !== "string") return null;
	const m = DURATION_RE.exec(value.trim());
	if (!m) return null;
	return Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
};

/** Validates an exported pipeline value (see the header). */
export const validatePipeline = (doc: unknown): PipelineResult => {
	const errors: string[] = [];
	const err = (path: string, message: string) =>
		errors.push(`${path}: ${message}`);

	if (!isObj(doc)) return { ok: false, errors: ["(root): expected a mapping"] };

	const knownKeys = (o: Obj, path: string, allowed: readonly string[]) => {
		for (const key of Object.keys(o)) {
			if (key === "instance") {
				err(
					path === "" ? "instance" : `${path}.instance`,
					"not supported in v1: the instance type is fixed per container class; v2 JobBox adds it",
				);
			} else if (!allowed.includes(key)) {
				err(path === "" ? key : `${path}.${key}`, "unknown key");
			}
		}
	};
	const strings = (
		v: unknown,
		path: string,
	): string[] => {
		if (v === undefined || v === null) return [];
		if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
			err(path, "expected a list of strings");
			return [];
		}
		return v as string[];
	};

	for (const key of ["projects", "global"]) {
		if (Object.hasOwn(doc, key)) {
			err(
				key,
				`not a pipeline key: ${key} is a top-level field of package tartan (the project graph reads it)`,
			);
		}
	}
	knownKeys(
		Object.fromEntries(
			Object.entries(doc).filter(([k]) => k !== "projects" && k !== "global"),
		),
		"",
		["timeout", "jobs", "on", "lanes"],
	);

	let timeoutMs = PIPELINE_TIMEOUT_DEFAULT_MS;
	if (doc.timeout !== undefined) {
		const ms = parseDuration(doc.timeout);
		if (ms === null || ms <= 0) err("timeout", "a duration such as 15m");
		else if (ms > PIPELINE_TIMEOUT_MAX_MS) err("timeout", "at most 60m");
		else timeoutMs = ms;
	}

	const jobs: PipelineJob[] = [];
	if (!isObj(doc.jobs) || Object.keys(doc.jobs).length === 0) {
		err("jobs", "at least one job");
	} else if (Object.keys(doc.jobs).length > PIPELINE_MAX_JOBS) {
		err("jobs", `at most ${PIPELINE_MAX_JOBS}`);
	} else {
		for (const [id, spec] of Object.entries(doc.jobs)) {
			const path = `jobs.${id}`;
			if (!PIPELINE_JOB_ID_RE.test(id)) {
				err(path, "job ids are lowercase letters, digits and -, ≤ 30");
				continue;
			}
			if (!isObj(spec)) {
				err(path, "expected a mapping");
				continue;
			}
			knownKeys(spec, path, [
				"run",
				"needs",
				"each",
				"cwd",
				"optional",
				"timeout",
				"env",
			]);
			if (typeof spec.run !== "string" || spec.run.trim() === "") {
				err(`${path}.run`, "a shell command is required");
				continue;
			}
			if (spec.run.length > 8192) err(`${path}.run`, "at most 8192 chars");
			let each: EachMode | undefined;
			if (spec.each !== undefined) {
				if (spec.each === "affected" || spec.each === "all") each = spec.each;
				else err(`${path}.each`, "affected or all");
			}
			if (spec.cwd !== undefined && typeof spec.cwd !== "string") {
				err(`${path}.cwd`, "a path");
			}
			for (const [field, text] of [["run", spec.run], ["cwd", spec.cwd]]) {
				if (typeof text !== "string") continue;
				for (const m of text.matchAll(TEMPLATE_RE)) {
					if (!TEMPLATE_VARS.has(m[1])) {
						err(`${path}.${field}`, `unknown template {{${m[1]}}}`);
					} else if (each === undefined) {
						err(`${path}.${field}`, `{{${m[1]}}} needs each:`);
					}
				}
			}
			if (spec.optional !== undefined && typeof spec.optional !== "boolean") {
				err(`${path}.optional`, "true or false");
			}
			let jobTimeout: number | undefined;
			if (spec.timeout !== undefined) {
				const ms = parseDuration(spec.timeout);
				if (ms === null || ms <= 0 || ms > PIPELINE_TIMEOUT_MAX_MS) {
					err(`${path}.timeout`, "a duration up to 60m");
				} else jobTimeout = ms;
			}
			const env: Record<string, string> = {};
			if (spec.env !== undefined && spec.env !== null) {
				if (!isObj(spec.env)) err(`${path}.env`, "expected a mapping");
				else {
					for (const [name, value] of Object.entries(spec.env)) {
						if (!ENV_NAME_RE.test(name)) {
							err(`${path}.env.${name}`, "env names are A-Z, 0-9 and _");
						} else if (RESERVED_ENV_PREFIXES.some((p) => name.startsWith(p))) {
							err(`${path}.env.${name}`, "reserved for the kernel");
						} else if (
							typeof value !== "string" && typeof value !== "number" &&
							typeof value !== "boolean"
						) {
							err(`${path}.env.${name}`, "a scalar");
						} else env[name] = String(value);
					}
				}
			}
			jobs.push({
				id,
				run: spec.run,
				needs: strings(spec.needs, `${path}.needs`),
				...(each ? { each } : {}),
				...(typeof spec.cwd === "string" ? { cwd: spec.cwd } : {}),
				optional: spec.optional === true,
				...(jobTimeout !== undefined ? { timeoutMs: jobTimeout } : {}),
				env,
			});
		}
	}

	const ids = new Set(jobs.map((j) => j.id));
	for (const job of jobs) {
		for (const need of job.needs) {
			if (!ids.has(need)) err(`jobs.${job.id}.needs`, `unknown job ${need}`);
		}
	}
	if (errors.length === 0 && hasCycle(jobs)) err("jobs", "needs form a cycle");

	const all = jobs.map((j) => j.id);
	const triggerJobs = (v: unknown, path: string): string[] => {
		if (v === undefined) return all;
		const list = strings(v, path);
		for (const id of list) {
			if (!ids.has(id)) err(path, `unknown job ${id}`);
		}
		return list;
	};
	let on: Pipeline["on"] = {
		change: all,
		land: all,
		push: { branches: [], jobs: [] },
	};
	if (doc.on !== undefined && doc.on !== null) {
		if (!isObj(doc.on)) err("on", "expected a mapping");
		else {
			knownKeys(doc.on, "on", ["change", "land", "push"]);
			let push: Pipeline["on"]["push"] = { branches: [], jobs: [] };
			if (doc.on.push !== undefined && doc.on.push !== null) {
				if (!isObj(doc.on.push)) err("on.push", "expected a mapping");
				else {
					knownKeys(doc.on.push, "on.push", ["branches", "jobs"]);
					push = {
						branches: strings(doc.on.push.branches, "on.push.branches"),
						jobs: triggerJobs(doc.on.push.jobs, "on.push.jobs"),
					};
				}
			}
			on = {
				change: triggerJobs(doc.on.change, "on.change"),
				land: triggerJobs(doc.on.land, "on.land"),
				push,
			};
		}
	}

	let laneCi: LaneCiMode = "on-submit";
	if (doc.lanes !== undefined && doc.lanes !== null) {
		if (!isObj(doc.lanes)) err("lanes", "expected a mapping");
		else {
			knownKeys(doc.lanes, "lanes", ["ci"]);
			const ci = doc.lanes.ci;
			if (ci === "on-push" || ci === "on-submit" || ci === "none") laneCi = ci;
			else if (ci !== undefined) err("lanes.ci", "on-push, on-submit or none");
		}
	}

	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		pipeline: {
			timeoutMs,
			jobs,
			on,
			lanes: { ci: laneCi },
		},
	};
};

const hasCycle = (jobs: readonly PipelineJob[]): boolean => {
	const byId = new Map(jobs.map((j) => [j.id, j]));
	const state = new Map<string, 1 | 2>();
	const visit = (id: string): boolean => {
		const s = state.get(id);
		if (s === 2) return false;
		if (s === 1) return true;
		state.set(id, 1);
		for (const need of byId.get(id)?.needs ?? []) {
			if (visit(need)) return true;
		}
		state.set(id, 2);
		return false;
	};
	return jobs.some((j) => visit(j.id));
};
