// RepoDO `runs` module (WP9, migrations 300–349): the run and job registry of
// one repo family.
//
// - `start` is idempotent on `idemKey` and writes the run row before
//   `RUNS.create`: the instance id is deterministic
//   (`run-<repoUlid>-<runUlid>`) and a create that finds the instance is
//   "exists".
// - `dispatch` is the only path that creates a run's Workflow instance
//   (WP26). Each run records its transport, chosen at start (`../bus/
//   transport.ts`): `local` dispatches inline after the commit; `k2` leaves
//   it to the global log's `workloads` consumer. The flip of
//   `instance_created` appends `run.dispatched{via}` exactly once, and
//   concurrent calls (the consumer, the backstop) share one create.
// - The `outbox` timer is the backstop and the retry: it dispatches every
//   live run still undispatched at its `dispatch_due_at` (a `k2` run after
//   `K2_DISPATCH_GRACE_MS` with `via: "backstop"`, a `local` run whose inline
//   create failed 30 s later), so a quiet repo never strands a run.
// - A newer run in the same `concurrencyGroup` supersedes older live runs in
//   the same transaction; their sandboxes are destroyed and their waiting
//   workflows woken afterwards, as `cancel` does.
// - Terminal states are sticky for runs and jobs, so late callbacks (a pump
//   finalizing after a cancel) never resurrect anything.
// - Every state change appends exactly one event in its transaction (K3):
//   `run.started` (queued, with kind, transport and priority; then running),
//   `run.dispatched`, `job.started`, `job.completed`, `run.completed`.
// - Kernel `git` graphs are accepted only from `requestedBy: "kernel"`;
//   write tokens are minted only for those runs (K11), by the sandbox.

import {
	conflict,
	type EntityRef,
	eventIdemKey,
	invalid,
	isUlid,
	jobEventType,
	JobGraphSchema,
	jobSandboxName,
	type JobState,
	notFound,
	principalKind,
	runInstanceId,
	type RunKind,
	type RunState,
	type RunStatus,
	SYS_KERNEL,
	TERMINAL_RUN_STATES,
} from "@tartan/contract";
import {
	type DoModule,
	type JobRow,
	type Migration,
	MIGRATION_RANGES,
	type ModuleDeps,
	type RepoInternals,
	type RepoRunsFacade,
	type RunRow,
} from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import { K2_DISPATCH_GRACE_MS, OUTBOX_DISPATCH_BATCH } from "../bus/config.ts";
import type {
	BusRelayInternal,
	DispatchOutcome,
	RunDispatchVia,
	RunPriority,
	RunsDispatchFacade,
	RunStatusK2,
	RunTransport,
} from "../bus/contract.ts";
import { k2Env } from "../bus/k2.ts";
import { workloadTransportOf } from "../bus/switches.ts";
import { armNoLaterThan } from "../bus/timers.ts";
import { createTransportPort, type TransportPort } from "../bus/transport.ts";
import {
	appendTail,
	JOB_TAIL_BYTES,
	safeText,
	secretSafeTail,
} from "./joblog.ts";
import type { RunWorkflowParams } from "./workflow.ts";

export const RUNS_MIGRATIONS: readonly Migration[] = [
	{
		n: 300,
		name: "runs",
		sql:
			`CREATE TABLE runs (id TEXT PRIMARY KEY, instance_id TEXT NOT NULL UNIQUE,
  idem_key TEXT NOT NULL UNIQUE,
  instance_created INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL CHECK (kind IN ('ci','git','agent')),
  requested_by TEXT NOT NULL,
  subject_kind TEXT, subject_id TEXT,
  lane_id TEXT, sha TEXT NOT NULL,
  graph_json TEXT NOT NULL, concurrency_group TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued','running','success','failure','cancelled','superseded','error')),
  created_at INTEGER NOT NULL, finished_at INTEGER);
CREATE INDEX runs_subject ON runs(subject_kind, subject_id, created_at);
CREATE INDEX runs_group ON runs(concurrency_group, created_at);
CREATE INDEX runs_outbox ON runs(instance_created, created_at)`,
	},
	{
		n: 301,
		name: "jobs",
		sql:
			`CREATE TABLE jobs (run_id TEXT NOT NULL, job_id TEXT NOT NULL, project TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','running','success','failure','skipped','cancelled','cached')),
  exit_code INTEGER, started_at INTEGER, finished_at INTEGER, log_key TEXT, tail TEXT,
  PRIMARY KEY (run_id, job_id))`,
	},
	{
		n: 302,
		name: "runs_transport",
		sql: [
			"ALTER TABLE runs ADD COLUMN transport TEXT NOT NULL DEFAULT 'local' CHECK (transport IN ('k2','local'))",
			"ALTER TABLE runs ADD COLUMN dispatch_due_at INTEGER",
			"ALTER TABLE runs ADD COLUMN via TEXT CHECK (via IN ('k2','backstop','local'))",
			"ALTER TABLE runs ADD COLUMN dispatched_at INTEGER",
			"UPDATE runs SET dispatch_due_at = created_at WHERE instance_created = 0",
			"CREATE INDEX runs_due ON runs(instance_created, dispatch_due_at)",
		].join(";\n"),
	},
];

/** A run row with the transport columns of migration 302 (WP26). */
export type RunRowK2 = RunRow & {
	transport: RunTransport;
	dispatch_due_at: number | null;
	via: RunDispatchVia | null;
	dispatched_at: number | null;
};

/** `RepoRunsFacade` with `dispatch`. */
export type RepoRunsFacadeK2 = RepoRunsFacade & RunsDispatchFacade;

/** `RepoRunsInternal` over the migration-302 row. */
export type RepoRunsInternalK2 = {
	runSync(runId: string): RunRowK2 | null;
};

/** The outbox timer key (`REPO_TIMERS.runs`). */
export const OUTBOX_TIMER = "outbox";

/** Attempt of every job in v1 (a re-run is a new run). */
export const JOB_ATTEMPT = 1;
/** A failed instance create is retried this long after (and an inline dispatch's backstop). */
export const OUTBOX_RETRY_AFTER_MS = 30_000;
const LIST_LIMIT_DEFAULT = 20;
const LIST_LIMIT_MAX = 100;

const TERMINAL_RUN: ReadonlySet<RunState> = new Set(TERMINAL_RUN_STATES);
const TERMINAL_JOB: ReadonlySet<JobState> = new Set([
	"success",
	"failure",
	"skipped",
	"cancelled",
	"cached",
]);

/** Side effects outside RepoDO, injectable for tests. */
export type RunsEffects = {
	/** `RUNS.create`; "exists" when the deterministic id is already taken. */
	createInstance(
		instanceId: string,
		params: RunWorkflowParams,
	): Promise<"created" | "exists">;
	/** Destroys the run's `job:<runId>` sandbox. */
	stopSandbox(runId: string): Promise<void>;
	/** Wakes a workflow waiting on a job event. */
	wake(
		instanceId: string,
		type: string,
		payload: { state: JobState },
	): Promise<void>;
	/** The last `tailBytes` of an archived job log, or null. */
	readLog(key: string, tailBytes: number): Promise<string | null>;
};

const isExistsError = (error: unknown): boolean =>
	/already.?exist|duplicate|exists/i.test(
		error instanceof Error ? error.message : String(error),
	);

export const envRunsEffects = (env: Env): RunsEffects => ({
	createInstance: async (instanceId, params) => {
		try {
			await env.RUNS.create({ id: instanceId, params });
			return "created";
		} catch (error) {
			if (isExistsError(error)) return "exists";
			throw error;
		}
	},
	stopSandbox: async (runId) => {
		await env.SANDBOX.getByName(jobSandboxName(runId)).stopRun();
	},
	wake: async (instanceId, type, payload) => {
		const instance = await env.RUNS.get(instanceId);
		await instance.sendEvent({ type, payload });
	},
	readLog: async (key, tailBytes) => {
		const object = await env.BLOBS.get(key, { range: { suffix: tailBytes } });
		return object === null ? null : await object.text();
	},
});

type Siblings = RepoInternals;
type Deps = ModuleDeps<Env, Siblings>;

export type RepoRunsModuleOptions = {
	readonly effects?: (env: Env) => RunsEffects;
	/** Background work after a transaction (defaults to `ctx.waitUntil`). */
	readonly background?: (deps: Deps, work: Promise<unknown>) => void;
	/** Per-run transport selection (default: the switch, bindings, relay and consumer). */
	readonly transport?: (deps: Deps) => TransportPort;
};

/** Why a run exists, from its subject. */
export const priorityOf = (
	subject: { readonly kind: string } | undefined,
): RunPriority =>
	subject?.kind === "land" || subject?.kind === "change" ||
		subject?.kind === "push"
		? subject.kind
		: "manual";

const VIAS: ReadonlySet<string> = new Set(["k2", "backstop", "local"]);

const defaultTransport = (deps: Deps): TransportPort =>
	createTransportPort({
		maximum: workloadTransportOf(deps.env),
		env: k2Env(deps.env),
		relay: () =>
			(deps.modules as RepoInternals & { bus?: BusRelayInternal }).bus
				?.stateSync() ?? null,
		clock: deps.clock,
	});

const toStatus = (
	run: RunRowK2,
	jobs: readonly JobRow[],
): RunStatus & RunStatusK2 => {
	const graph = JSON.parse(run.graph_json) as { source: { repoId: string } };
	return {
		runId: run.id,
		repoId: graph.source.repoId,
		// `agent` runs are out of v1; JobGraphSchema never yields one.
		kind: run.kind as RunKind,
		state: run.state,
		...(run.subject_kind !== null && run.subject_id !== null
			? { subject: { kind: run.subject_kind, id: run.subject_id } }
			: {}),
		sha: run.sha,
		requestedBy: run.requested_by,
		createdAt: run.created_at,
		...(run.finished_at !== null ? { finishedAt: run.finished_at } : {}),
		transport: run.transport,
		...(run.via !== null ? { via: run.via } : {}),
		...(run.dispatched_at !== null ? { dispatchedAt: run.dispatched_at } : {}),
		jobs: jobs.map((job) => ({
			jobId: job.job_id,
			...(job.project !== null ? { project: job.project } : {}),
			state: job.state,
			...(job.exit_code !== null ? { exitCode: job.exit_code } : {}),
			...(job.started_at !== null ? { startedAt: job.started_at } : {}),
			...(job.finished_at !== null ? { finishedAt: job.finished_at } : {}),
			...(job.state === "cached" ? { cached: true } : {}),
			...(job.tail !== null ? { tail: job.tail } : {}),
		})),
	};
};

/** Runs `fn` and turns a synchronous throw into a rejection. */
const settled = <T>(fn: () => T): Promise<T> => {
	try {
		return Promise.resolve(fn());
	} catch (error) {
		return Promise.reject(error);
	}
};

const encodeCursor = (run: RunRow): string => `${run.created_at}.${run.id}`;
const decodeCursor = (
	cursor: string | undefined,
): { at: number; id: string } | null => {
	if (cursor === undefined) return null;
	const m = /^([0-9]{1,16})\.([0-9a-z]{26})$/.exec(cursor);
	if (m === null) throw invalid("bad cursor");
	return { at: Number(m[1]), id: m[2] };
};

export const createRepoRunsModule = (
	options: RepoRunsModuleOptions = {},
): DoModule<RepoRunsFacadeK2, RepoRunsInternalK2, Env, Siblings> => ({
	name: "runs",
	range: MIGRATION_RANGES.repo.runs,
	migrations: RUNS_MIGRATIONS,
	create: (deps) => {
		const { sql, ctx, clock, ids, modules } = deps;
		const effects = (options.effects ?? envRunsEffects)(deps.env);
		const transportPort = (options.transport ?? defaultTransport)(deps);
		const background = options.background ??
			((d: Deps, work: Promise<unknown>) => d.ctx.waitUntil(work));
		const later = (work: () => Promise<unknown>): void =>
			background(
				deps,
				work().catch((error) =>
					console.error(
						"[tartan] runs background work failed",
						safeText(String(error)),
					)
				),
			);

		const runSync = (runId: string): RunRowK2 | null =>
			sql.exec<RunRowK2>("SELECT * FROM runs WHERE id = ?", runId)
				.toArray()[0] ?? null;
		const jobsSync = (runId: string): JobRow[] =>
			sql.exec<JobRow>(
				"SELECT * FROM jobs WHERE run_id = ? ORDER BY rowid",
				runId,
			).toArray();
		const jobSync = (runId: string, jobId: string): JobRow | null =>
			sql.exec<JobRow>(
				"SELECT * FROM jobs WHERE run_id = ? AND job_id = ?",
				runId,
				jobId,
			).toArray()[0] ?? null;
		const requireRun = (runId: string): RunRowK2 => {
			const run = runSync(runId);
			if (run === null) throw notFound(`no run ${runId}`);
			return run;
		};

		const repoOf = (run: RunRow): string =>
			(JSON.parse(run.graph_json) as { source: { repoId: string } }).source
				.repoId;
		const subjectOf = (run: RunRow): EntityRef | undefined =>
			run.subject_kind !== null && run.subject_id !== null
				? { kind: run.subject_kind, id: run.subject_id }
				: undefined;

		const appendSync = (
			run: RunRow,
			type:
				| "run.started"
				| "run.dispatched"
				| "job.started"
				| "job.completed"
				| "run.completed",
			data: Record<string, unknown>,
			key: { scope: string; n: number },
			by?: string,
		): void => {
			const repoId = repoOf(run);
			const subject = subjectOf(run);
			const kind = by === undefined ? null : principalKind(by);
			modules.events.appendSync({
				type,
				source: { kind: "kernel" },
				actor: kind === null || by === undefined
					? { kind: "system", id: SYS_KERNEL }
					: { kind, id: by },
				node: repoId,
				repo: repoId,
				...(subject ? { subject } : {}),
				depth: 0,
				shadow: false,
				data: { runId: run.id, ...data, ...(subject ? { subject } : {}) },
				idemKey: eventIdemKey("runs", key.scope, type, key.n),
			});
		};

		const repoIdMeta = (): string | null =>
			sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'repo_id'")
				.toArray()[0]?.v ?? null;

		/** Ends every non-terminal job of a run (cancel, supersede, error). */
		const endJobsSync = (
			run: RunRow,
			now: number,
		): { running: string[] } => {
			const running: string[] = [];
			for (const job of jobsSync(run.id)) {
				if (TERMINAL_JOB.has(job.state)) continue;
				if (job.state === "running") running.push(job.job_id);
				const state: JobState = job.state === "running"
					? "cancelled"
					: "skipped";
				sql.exec(
					"UPDATE jobs SET state = ?, finished_at = ? WHERE run_id = ? AND job_id = ?",
					state,
					now,
					run.id,
					job.job_id,
				);
				appendSync(run, "job.completed", {
					jobId: job.job_id,
					state,
					...(job.project !== null ? { project: job.project } : {}),
				}, { scope: `${run.id}/${job.job_id}`, n: 0 });
			}
			return { running };
		};

		/** Moves a live run to a terminal state; returns the jobs that were running. */
		const finishRunSync = (
			run: RunRow,
			state: RunState,
			now: number,
			by?: string,
		): { running: string[] } | null => {
			if (TERMINAL_RUN.has(run.state)) return null;
			const ended = endJobsSync(run, now);
			sql.exec(
				"UPDATE runs SET state = ?, finished_at = ? WHERE id = ?",
				state,
				now,
				run.id,
			);
			appendSync(
				run,
				"run.completed",
				{
					state,
					durationMs: Math.max(0, now - run.created_at),
				},
				{ scope: run.id, n: 0 },
				by,
			);
			return ended;
		};

		/** Destroys the sandbox and wakes the jobs a stopped run was waiting on. */
		const stopEffects = async (
			run: RunRow,
			running: readonly string[],
			state: JobState,
		): Promise<void> => {
			const results = await Promise.allSettled([
				effects.stopSandbox(run.id),
				...running.map((jobId) =>
					effects.wake(run.instance_id, jobEventType(jobId, JOB_ATTEMPT), {
						state,
					})
				),
			]);
			const failed = results.filter((r) => r.status === "rejected");
			if (failed.length > 0) {
				console.error(
					"[tartan] run stop effects failed",
					run.id,
					failed.map((r) =>
						safeText(String((r as PromiseRejectedResult).reason))
					)
						.join("; "),
				);
			}
		};

		/** Arms the outbox no later than `at` (in or right after a transaction). */
		const armOutbox = (at: number): void =>
			armNoLaterThan(deps.timers, OUTBOX_TIMER, at, clock.now());

		/** The earliest `dispatch_due_at` of a live, undispatched run. */
		const nextDueSync = (): number | null =>
			sql.exec<{ at: number | null }>(
				`SELECT MIN(dispatch_due_at) AS at FROM runs WHERE instance_created = 0
				 AND state IN ('queued','running') AND dispatch_due_at IS NOT NULL`,
			).one().at;

		const dispatchOnce = async (
			runId: string,
			via: RunDispatchVia,
		): Promise<DispatchOutcome> => {
			const run = runSync(runId);
			if (run === null) return "unknown-run";
			if (run.state === "superseded") return "superseded";
			if (TERMINAL_RUN.has(run.state)) return "terminal";
			if (run.instance_created === 1) return "already";
			try {
				await effects.createInstance(run.instance_id, {
					repoId: repoOf(run),
					runId: run.id,
					graph: JSON.parse(run.graph_json),
					requestedBy: run.requested_by,
				});
			} catch (error) {
				// The row stays the outbox entry; the timer retries it.
				const retryAt = clock.now() + OUTBOX_RETRY_AFTER_MS;
				ctx.storage.transactionSync(() => {
					sql.exec(
						"UPDATE runs SET dispatch_due_at = ? WHERE id = ? AND instance_created = 0",
						retryAt,
						runId,
					);
					armOutbox(retryAt);
				});
				throw error;
			}
			const now = clock.now();
			return ctx.storage.transactionSync((): DispatchOutcome => {
				const fresh = runSync(runId);
				if (fresh === null) return "unknown-run";
				if (fresh.instance_created === 1) return "already";
				sql.exec(
					"UPDATE runs SET instance_created = 1, via = ?, dispatched_at = ? WHERE id = ?",
					via,
					now,
					runId,
				);
				appendSync(fresh, "run.dispatched", {
					state: fresh.state,
					via,
					lagMs: Math.max(0, now - fresh.created_at),
				}, { scope: runId, n: 0 });
				return "dispatched";
			});
		};

		// One create per run at a time: the consumer and the backstop share it.
		const inflight = new Map<string, Promise<DispatchOutcome>>();
		const dispatchRun = (
			runId: string,
			via: RunDispatchVia,
		): Promise<DispatchOutcome> => {
			const running = inflight.get(runId);
			if (running !== undefined) return running;
			const work = dispatchOnce(runId, via).finally(() =>
				inflight.delete(runId)
			);
			inflight.set(runId, work);
			return work;
		};

		/** Inline dispatch of a `local` run; a failure is left to the outbox timer. */
		const dispatchLocal = async (runId: string): Promise<void> => {
			try {
				await dispatchRun(runId, "local");
			} catch (error) {
				console.error(
					"[tartan] run instance create failed",
					runId,
					safeText(String(error)),
				);
			}
		};

		/** The `outbox` timer: dispatches due runs, then re-arms at the next due time. */
		const runOutbox = async (): Promise<void> => {
			const now = clock.now();
			const due = sql.exec<RunRowK2>(
				`SELECT * FROM runs WHERE instance_created = 0
				 AND state IN ('queued','running') AND dispatch_due_at IS NOT NULL
				 AND dispatch_due_at <= ? ORDER BY dispatch_due_at, id LIMIT ?`,
				now,
				OUTBOX_DISPATCH_BATCH,
			).toArray();
			for (const run of due) {
				const via: RunDispatchVia = run.transport === "k2"
					? "backstop"
					: "local";
				await dispatchRun(run.id, via).catch((error) =>
					console.error(
						"[tartan] run instance create failed",
						run.id,
						safeText(String(error)),
					)
				);
			}
			const next = nextDueSync();
			if (next !== null) armOutbox(Math.max(next, clock.now()));
		};

		// Rows left undispatched by an older version or a lost alarm.
		const pending = nextDueSync();
		if (pending !== null) armOutbox(pending);

		const facade: RepoRunsFacadeK2 = {
			start: async ({ graph: input, idemKey, requestedBy }) => {
				if (
					typeof idemKey !== "string" || idemKey === "" || idemKey.length > 300
				) {
					throw invalid("idemKey required (≤ 300 chars)");
				}
				if (typeof requestedBy !== "string" || requestedBy === "") {
					throw invalid("requestedBy required");
				}
				const byIdemKey = (): RunRowK2 | undefined =>
					sql.exec<RunRowK2>(
						"SELECT * FROM runs WHERE idem_key = ?",
						idemKey,
					).toArray()[0];
				const startedAlready = async (existing: RunRowK2) => {
					if (
						existing.instance_created === 0 && existing.transport === "local"
					) {
						await dispatchLocal(existing.id);
					}
					return { runId: existing.id };
				};
				const existing = byIdemKey();
				if (existing !== undefined) return await startedAlready(existing);
				const parsed = JobGraphSchema.safeParse(input);
				if (!parsed.success) {
					throw invalid(
						`invalid job graph: ${parsed.error.issues[0]?.message}`,
					);
				}
				const graph = parsed.data;
				if (graph.kind === "git" && requestedBy !== "kernel") {
					throw invalid("git runs are kernel-only");
				}
				if (graph.subject?.kind === "kernel" && requestedBy !== "kernel") {
					throw invalid("kernel subjects are kernel-only");
				}
				const repoId = graph.source.repoId;
				const metaRepo = repoIdMeta();
				if (metaRepo !== null && metaRepo !== repoId) {
					throw invalid("source.repoId is not this repo");
				}
				if (!isUlid(repoId)) throw invalid("source.repoId must be a ulid");
				const transport = await transportPort.choose({
					kind: graph.kind,
					requestedBy,
				});
				const now = clock.now();
				// `k2`: the consumer dispatches; the backstop after the grace.
				// `local`: inline below; the timer is the retry if that fails.
				const dueAt = transport === "k2" ? now + K2_DISPATCH_GRACE_MS : now;
				const backstopAt = transport === "k2"
					? dueAt
					: now + OUTBOX_RETRY_AFTER_MS;
				const runId = ids.ulid();
				const instanceId = runInstanceId(repoId, runId);
				const superseded: { run: RunRowK2; running: string[] }[] = [];
				let raced: RunRowK2 | undefined;
				const run = ctx.storage.transactionSync(() => {
					// `transportPort.choose` may await an RPC (the k2 health read),
					// which opens the input gate: a concurrent start with the same
					// key may have inserted its run meanwhile.
					raced = byIdemKey();
					if (raced !== undefined) return null;
					sql.exec(
						`INSERT INTO runs (id, instance_id, idem_key, instance_created, kind,
						 requested_by, subject_kind, subject_id, lane_id, sha, graph_json,
						 concurrency_group, state, created_at, transport, dispatch_due_at)
						 VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
						runId,
						instanceId,
						idemKey,
						graph.kind,
						requestedBy,
						graph.subject?.kind ?? null,
						graph.subject?.id ?? null,
						graph.source.laneId ?? null,
						graph.sha,
						JSON.stringify(graph),
						graph.concurrencyGroup ?? null,
						now,
						transport,
						dueAt,
					);
					for (const job of graph.jobs) {
						sql.exec(
							"INSERT INTO jobs (run_id, job_id, project, state) VALUES (?, ?, ?, 'pending')",
							runId,
							job.id,
							job.project ?? null,
						);
					}
					const row = runSync(runId)!;
					appendSync(row, "run.started", {
						state: "queued",
						kind: graph.kind,
						transport,
						priority: priorityOf(graph.subject),
					}, {
						scope: runId,
						n: 0,
					});
					armOutbox(backstopAt);
					if (graph.concurrencyGroup !== undefined) {
						const older = sql.exec<RunRowK2>(
							`SELECT * FROM runs WHERE concurrency_group = ? AND id <> ?
							 AND state IN ('queued','running')`,
							graph.concurrencyGroup,
							runId,
						).toArray();
						for (const old of older) {
							const ended = finishRunSync(old, "superseded", now);
							if (ended) superseded.push({ run: old, running: ended.running });
						}
					}
					return row;
				});
				if (run === null) return await startedAlready(raced!);
				for (const { run: old, running } of superseded) {
					later(() => stopEffects(old, running, "cancelled"));
				}
				if (run.transport === "local") await dispatchLocal(runId);
				return { runId };
			},

			dispatch: (runId, input) => {
				if (typeof runId !== "string" || !isUlid(runId)) {
					return Promise.reject(invalid("runId must be a ulid"));
				}
				const via = input?.via;
				if (typeof via !== "string" || !VIAS.has(via)) {
					return Promise.reject(invalid("via is k2, backstop or local"));
				}
				return dispatchRun(runId, via as RunDispatchVia);
			},

			get: (runId) =>
				settled(() => {
					const run = runSync(runId);
					return run === null ? null : toStatus(run, jobsSync(run.id));
				}),

			list: ({ subject, cursor, limit }) =>
				settled(() => {
					const take = Math.min(
						LIST_LIMIT_MAX,
						Math.max(1, limit ?? LIST_LIMIT_DEFAULT),
					);
					const after = decodeCursor(cursor);
					const where: string[] = [];
					const args: (string | number)[] = [];
					if (subject !== undefined) {
						where.push("subject_kind = ? AND subject_id = ?");
						args.push(subject.kind, subject.id);
					}
					if (after !== null) {
						where.push("(created_at < ? OR (created_at = ? AND id < ?))");
						args.push(after.at, after.at, after.id);
					}
					const rows = sql.exec<RunRowK2>(
						`SELECT * FROM runs ${
							where.length ? `WHERE ${where.join(" AND ")}` : ""
						} ORDER BY created_at DESC, id DESC LIMIT ?`,
						...args,
						take + 1,
					).toArray();
					const page = rows.slice(0, take);
					return {
						runs: page.map((run) => toStatus(run, jobsSync(run.id))),
						...(rows.length > take
							? { cursor: encodeCursor(page[page.length - 1]) }
							: {}),
					};
				}),

			cancel: async (runId, by) => {
				const run = requireRun(runId);
				const now = clock.now();
				const ended = ctx.storage.transactionSync(() =>
					finishRunSync(run, "cancelled", now, by)
				);
				// Awaited, so a cancelled run's container is gone when this returns;
				// the workflow's poll fallback covers a lost wake-up.
				await stopEffects(run, ended?.running ?? [], "cancelled");
			},

			setRunState: (runId, state) =>
				settled(() => {
					const run = requireRun(runId);
					const now = clock.now();
					ctx.storage.transactionSync(() => {
						if (TERMINAL_RUN.has(run.state) || run.state === state) return;
						if (state === "queued") {
							throw conflict(`run ${runId} cannot go back to queued`);
						}
						if (state === "running") {
							sql.exec("UPDATE runs SET state = 'running' WHERE id = ?", runId);
							appendSync(run, "run.started", { state: "running" }, {
								scope: runId,
								n: 1,
							});
							return;
						}
						finishRunSync(run, state, now);
					});
				}),

			setJobState: (runId, jobId, update) =>
				settled(() => {
					const run = requireRun(runId);
					const now = clock.now();
					ctx.storage.transactionSync(() => {
						const job = jobSync(runId, jobId);
						if (job === null) throw notFound(`no job ${jobId} in run ${runId}`);
						if (update.state === "pending") {
							throw invalid("a job cannot go back to pending");
						}
						if (TERMINAL_JOB.has(job.state)) {
							// Sticky; a late finalize may still attach the archived log.
							if (update.logKey !== undefined && job.log_key === null) {
								sql.exec(
									"UPDATE jobs SET log_key = ? WHERE run_id = ? AND job_id = ?",
									update.logKey,
									runId,
									jobId,
								);
							}
							return;
						}
						if (update.state === "running") {
							if (job.state === "running") return;
							sql.exec(
								"UPDATE jobs SET state = 'running', started_at = ? WHERE run_id = ? AND job_id = ?",
								now,
								runId,
								jobId,
							);
							appendSync(run, "job.started", {
								jobId,
								state: "running",
								...(job.project !== null ? { project: job.project } : {}),
							}, { scope: `${runId}/${jobId}`, n: 0 });
							return;
						}
						sql.exec(
							`UPDATE jobs SET state = ?, exit_code = ?, finished_at = ?,
						 log_key = COALESCE(?, log_key) WHERE run_id = ? AND job_id = ?`,
							update.state,
							update.exitCode ?? null,
							now,
							update.logKey ?? null,
							runId,
							jobId,
						);
						appendSync(run, "job.completed", {
							jobId,
							state: update.state,
							...(job.project !== null ? { project: job.project } : {}),
							...(job.started_at !== null
								? { durationMs: Math.max(0, now - job.started_at) }
								: {}),
							...(update.state === "cached" ? { cached: true } : {}),
						}, { scope: `${runId}/${jobId}`, n: 0 });
					});
				}),

			jobLog: (runId, jobId, chunk) =>
				settled(() => {
					const job = jobSync(runId, jobId);
					if (job === null) throw notFound(`no job ${jobId} in run ${runId}`);
					sql.exec(
						"UPDATE jobs SET tail = ? WHERE run_id = ? AND job_id = ?",
						appendTail(job.tail ?? "", chunk, JOB_TAIL_BYTES),
						runId,
						jobId,
					);
				}),

			logs: async (runId, jobId, tailBytes = JOB_TAIL_BYTES) => {
				const job = jobSync(runId, jobId);
				if (job === null) throw notFound(`no job ${jobId} in run ${runId}`);
				const bytes = Math.max(1, Math.min(tailBytes, 1024 * 1024));
				if (job.log_key !== null && TERMINAL_JOB.has(job.state)) {
					// One byte more than asked: whether the window starts inside a
					// run of secret characters (a token's tail) is then known.
					const text = await effects.readLog(job.log_key, bytes + 1);
					if (text !== null) return secretSafeTail(text, bytes);
				}
				return secretSafeTail(job.tail ?? "", bytes);
			},
		};

		return {
			facade,
			internal: { runSync },
			onTimer: (key) => key === OUTBOX_TIMER ? runOutbox() : undefined,
		};
	},
});

export const repoRunsModule = createRepoRunsModule();
