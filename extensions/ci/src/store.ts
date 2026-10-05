// tartan.ci storage (`migrations/0001_init.sql`, `0002_runs.sql`): typed
// reads and writes over the extension's own SQLite. Raw SQL, typed mappers.

import type { Check, Sql } from "@tartan/contract";
import { db, json } from "@tartan/ext-api";
import type { PlannedJob } from "./pipeline/index.ts";

/** `checks@1` check states. */
export type CheckState = Check["state"];

export type SubjectKind = "change" | "land" | "push";

/**
 * `planned` (row written, run not started yet: a retry resumes at the start),
 * `running`, then a terminal state. `superseded` when a newer run of the
 * same subject replaced it.
 */
export type PlanState =
	/** The base's Tartan config is still evaluating (ADR repo config): planned again once it resolves. */
	| "waiting"
	| "planned"
	| "running"
	| "success"
	| "failure"
	| "cancelled"
	| "superseded";

export const TERMINAL_PLAN_STATES: readonly PlanState[] = [
	"success",
	"failure",
	"cancelled",
	"superseded",
];

/** A planned job as stored (with its input hash and cache outcome). */
export type StoredJob = PlannedJob & {
	readonly inputHash: string;
	/** Run id of the cached success it reuses, when not re-run. */
	readonly cachedRun?: string;
	/** True when the job is part of the run. */
	readonly runs: boolean;
};

export type PlanDetail = {
	/** The repo (this installation's repo). */
	readonly repoId?: string;
	/** The pushed ref of a `push` subject. */
	readonly ref?: string;
	/** The pipeline's run timeout. */
	readonly timeoutMs?: number;
	/** Policy the plan used: `pipeline` (at the base), `zero` or `invalid`. */
	readonly policy?: "pipeline" | "zero" | "invalid";
	/**
	 * The base's Tartan config does not evaluate, so the last good pipeline
	 * was used (ADR repo config): what failed and where the pipeline came from.
	 */
	readonly configNote?: string;
	readonly errors?: readonly string[];
	readonly note?: string;
	readonly affected?: readonly string[];
	readonly global?: boolean;
	/** The change's author (notified on failure) and on-behalf-of user. */
	readonly author?: string;
	readonly onBehalfOf?: string;
	readonly workRef?: string;
	readonly image?: string;
	/** land.report outcome. */
	readonly reported?: "accepted" | "rejected";
	readonly reportError?: string;
};

export type PlanRow = {
	readonly subjectKind: SubjectKind;
	readonly subjectId: string;
	readonly sha: string;
	readonly runId: string | null;
	readonly jobs: readonly StoredJob[];
	readonly state: PlanState;
	readonly createdAt: number;
	readonly base: string | null;
	readonly laneId: string | null;
	readonly attempt: number | null;
	readonly revision: number | null;
	readonly gen: number;
	readonly notified: boolean;
	readonly detail: PlanDetail;
	readonly finishedAt: number | null;
};

type RawPlan = {
	subject_kind: string;
	subject_id: string;
	sha: string;
	run_id: string | null;
	jobs_json: string;
	state: string;
	created_at: number;
	base: string | null;
	lane_id: string | null;
	attempt: number | null;
	revision: number | null;
	gen: number;
	notified: number;
	detail_json: string;
	finished_at: number | null;
};

const toPlan = (r: RawPlan): PlanRow => ({
	subjectKind: r.subject_kind as SubjectKind,
	subjectId: r.subject_id,
	sha: r.sha,
	runId: r.run_id,
	jobs: json.decode<StoredJob[]>(r.jobs_json, []),
	state: r.state as PlanState,
	createdAt: r.created_at,
	base: r.base,
	laneId: r.lane_id,
	attempt: r.attempt,
	revision: r.revision,
	gen: r.gen,
	notified: r.notified === 1,
	detail: json.decode<PlanDetail>(r.detail_json, {}),
	finishedAt: r.finished_at,
});

export type CheckRow = {
	readonly subjectKind: SubjectKind;
	readonly subjectId: string;
	readonly sha: string;
	readonly context: string;
	readonly state: CheckState;
	readonly runId: string | null;
	readonly cached: boolean;
	readonly project: string | null;
	readonly jobId: string | null;
	readonly updatedAt: number;
};

type RawCheck = {
	subject_kind: string;
	subject_id: string;
	sha: string;
	context: string;
	state: string;
	run_id: string | null;
	cached: number;
	project: string | null;
	job_id: string | null;
	updated_at: number;
};

const toCheck = (r: RawCheck): CheckRow => ({
	subjectKind: r.subject_kind as SubjectKind,
	subjectId: r.subject_id,
	sha: r.sha,
	context: r.context,
	state: r.state as CheckState,
	runId: r.run_id,
	cached: r.cached === 1,
	project: r.project,
	jobId: r.job_id,
	updatedAt: r.updated_at,
});

const PLAN_COLUMNS =
	"subject_kind, subject_id, sha, run_id, jobs_json, state, created_at, base, lane_id, attempt, revision, gen, notified, detail_json, finished_at";

export const createStore = (sql: Sql) => {
	const d = db(sql);

	const plan = (
		kind: SubjectKind,
		id: string,
		sha: string,
	): PlanRow | null => {
		const r = d.first<RawPlan>(
			`SELECT ${PLAN_COLUMNS} FROM plans WHERE subject_kind = ? AND subject_id = ? AND sha = ?`,
			kind,
			id,
			sha,
		);
		return r ? toPlan(r) : null;
	};

	const planByRun = (runId: string): PlanRow | null => {
		const r = d.first<RawPlan>(
			`SELECT ${PLAN_COLUMNS} FROM plans WHERE run_id = ?`,
			runId,
		);
		return r ? toPlan(r) : null;
	};

	/** The newest plan of a subject (any sha). */
	const latestPlan = (kind: SubjectKind, id: string): PlanRow | null => {
		const r = d.first<RawPlan>(
			`SELECT ${PLAN_COLUMNS} FROM plans WHERE subject_kind = ? AND subject_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
			kind,
			id,
		);
		return r ? toPlan(r) : null;
	};

	const recentPlans = (limit: number): PlanRow[] =>
		d.all<RawPlan>(
			`SELECT ${PLAN_COLUMNS} FROM plans ORDER BY created_at DESC, rowid DESC LIMIT ?`,
			limit,
		).map(toPlan);

	const writePlan = (p: PlanRow): void => {
		d.run(
			`INSERT INTO plans (${PLAN_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (subject_kind, subject_id, sha) DO UPDATE SET
			   run_id = excluded.run_id, jobs_json = excluded.jobs_json, state = excluded.state,
			   created_at = excluded.created_at, base = excluded.base, lane_id = excluded.lane_id,
			   attempt = excluded.attempt, revision = excluded.revision, gen = excluded.gen,
			   notified = excluded.notified, detail_json = excluded.detail_json,
			   finished_at = excluded.finished_at`,
			p.subjectKind,
			p.subjectId,
			p.sha,
			p.runId,
			json.encode(p.jobs),
			p.state,
			p.createdAt,
			p.base,
			p.laneId,
			p.attempt,
			p.revision,
			p.gen,
			p.notified ? 1 : 0,
			json.encode(p.detail),
			p.finishedAt,
		);
	};

	const checks = (kind: SubjectKind, id: string, sha: string): CheckRow[] =>
		d.all<RawCheck>(
			"SELECT * FROM checks WHERE subject_kind = ? AND subject_id = ? AND sha = ? ORDER BY context",
			kind,
			id,
			sha,
		).map(toCheck);

	const writeCheck = (c: CheckRow): void => {
		d.run(
			`INSERT INTO checks (subject_kind, subject_id, sha, context, state, run_id, cached, updated_at, project, job_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (subject_kind, subject_id, sha, context) DO UPDATE SET
			   state = excluded.state, run_id = excluded.run_id, cached = excluded.cached,
			   updated_at = excluded.updated_at, project = excluded.project, job_id = excluded.job_id`,
			c.subjectKind,
			c.subjectId,
			c.sha,
			c.context,
			c.state,
			c.runId,
			c.cached ? 1 : 0,
			c.updatedAt,
			c.project,
			c.jobId,
		);
	};

	const clearChecks = (kind: SubjectKind, id: string, sha: string): void => {
		d.run(
			"DELETE FROM checks WHERE subject_kind = ? AND subject_id = ? AND sha = ?",
			kind,
			id,
			sha,
		);
	};

	/** Latest check per project (the project status sidebar). */
	const projectStatus = (): CheckRow[] =>
		d.all<RawCheck>(
			`SELECT c.* FROM checks c
			 JOIN (SELECT project, MAX(updated_at) AS at FROM checks WHERE project IS NOT NULL GROUP BY project) l
			   ON c.project = l.project AND c.updated_at = l.at
			 ORDER BY c.project, c.context`,
		).map(toCheck);

	const cacheHits = (
		hashes: readonly string[],
	): Map<string, string> => {
		if (hashes.length === 0) return new Map();
		const rows = d.all<{ input_hash: string; run_id: string }>(
			"SELECT input_hash, run_id FROM cache WHERE input_hash IN (SELECT value FROM json_each(?))",
			JSON.stringify(hashes),
		);
		return new Map(rows.map((r) => [r.input_hash, r.run_id]));
	};

	const remember = (
		inputHash: string,
		jobId: string,
		project: string | undefined,
		runId: string,
		at: number,
	): void => {
		d.run(
			`INSERT INTO cache (input_hash, job_id, project, run_id, at) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT (input_hash) DO NOTHING`,
			inputHash,
			jobId,
			project ?? null,
			runId,
			at,
		);
	};

	const writePolicy = (
		sha: string,
		mode: string,
		commands: unknown,
		at: number,
	): void => {
		d.run(
			`INSERT INTO policy (k, sha, mode, commands_json, at) VALUES ('latest', ?, ?, ?, ?)
			 ON CONFLICT (k) DO UPDATE SET sha = excluded.sha, mode = excluded.mode,
			   commands_json = excluded.commands_json, at = excluded.at`,
			sha,
			mode,
			json.encode(commands),
			at,
		);
	};

	const policy = (): {
		sha: string;
		mode: string;
		commands: TestCommand[];
	} | null => {
		const r = d.first<{ sha: string; mode: string; commands_json: string }>(
			"SELECT sha, mode, commands_json FROM policy WHERE k = 'latest'",
		);
		return r
			? {
				sha: r.sha,
				mode: r.mode,
				commands: json.decode<TestCommand[]>(r.commands_json, []),
			}
			: null;
	};

	/**
	 * Plan requests waiting for the base's Tartan config to resolve (its trunk
	 * row was `pending`); replayed on `repo.config.resolved`.
	 */
	const writeConfigWait = (
		kind: SubjectKind,
		id: string,
		sha: string,
		request: unknown,
		at: number,
	): void => {
		d.run(
			`INSERT INTO config_waits (subject_kind, subject_id, sha, request_json, at) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT (subject_kind, subject_id, sha) DO UPDATE SET request_json = excluded.request_json, at = excluded.at`,
			kind,
			id,
			sha,
			json.encode(request),
			at,
		);
	};

	/** Takes (and removes) every waiting request, oldest first. */
	const takeConfigWaits = (): unknown[] => {
		const rows = d.all<{ request_json: string }>(
			"SELECT request_json FROM config_waits ORDER BY at",
		);
		d.run("DELETE FROM config_waits");
		return rows.map((r) => json.decode<unknown>(r.request_json, null)).filter(
			(r) => r !== null,
		);
	};

	return {
		plan,
		planByRun,
		latestPlan,
		recentPlans,
		writePlan,
		checks,
		writeCheck,
		clearChecks,
		projectStatus,
		cacheHits,
		remember,
		writePolicy,
		policy,
		writeConfigWait,
		takeConfigWaits,
		tx: d.tx,
	};
};
export type Store = ReturnType<typeof createStore>;

/** One project's test commands under the policy at a base (context@1). */
export type TestCommand = {
	readonly project: string;
	readonly root: string;
	readonly commands: readonly {
		readonly context: string;
		readonly run: string;
		readonly cwd?: string;
	}[];
};
