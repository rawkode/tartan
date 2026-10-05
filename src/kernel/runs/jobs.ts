// The job runner inside TartanSandbox `job:<runId>`,
// written against two ports so it is testable without a container: the
// sandbox (`SandboxPort`, the Sandbox SDK's process API) and the kernel
// (`JobSinks`: RepoDO, R2, the run's Workflow instance, Artifacts tokens).
//
// - `prepare` checks the run's commit out once (`git fetch --depth=1 <remote>
//   <sha>` as `tartan-git`, never a branch name) with a read token for exactly
//   the repo that holds it (the canonical repo, or the lane's repo through
//   `laneFetchSpecs`), minted inside the call, passed in that one exec's
//   environment and revoked afterwards.
// - `runJob` starts one process and returns at once. It is idempotent: a
//   retried Workflow step finds the job's row in `job_state` and re-attaches
//   (U18). CI jobs run as `tartan-git` with no token at all; jobs of a
//   kernel `git` run (`requestedBy: "kernel"`) get a write token for the
//   canonical repo and run as `tartan-push` after `pkill -u tartan-git`
//   (K11).
// - The log pump (`ctx.waitUntil`) redacts line by line, appends to
//   `job_log`, flushes to RepoDO every 500 ms (tail + live view), and on exit
//   archives the full log to R2, records the job state, revokes the job's
//   token and sends `job-<jobId>-a<attempt>` to the Workflow.
// - `reconcile` is the watchdog (60 s, `Container.schedule()`) and the
//   Workflow's poll fallback: it finalizes exited jobs, re-attaches a lost
//   pump, retries a failed finalize and enforces each job's timeout (kill,
//   `failure`, every other job of the run cancelled, `destroy()`).

import {
	type GitSource,
	jobEventType,
	type JobSpec,
	type JobState,
	redactSecrets,
} from "@tartan/contract";
import {
	createLineRedactor,
	jobLogKey,
	type LineRedactor,
	LOG_FLUSH_MS,
	safeText,
} from "./joblog.ts";
import {
	asUid,
	gitAuthEnv,
	KILL_CONTENT_UID,
	RUNNER_HOME,
	safeRelativePath,
	shellAsUid,
	WORKSPACE_ROOT,
} from "./shell.ts";

/** Checkout directory of a job sandbox (one run per sandbox). */
export const CHECKOUT_DIR = `${WORKSPACE_ROOT}/src`;
/** Watchdog period. */
export const WATCHDOG_S = 60;
/** First calls into a sandbox retry: 3 tries, 2 s backoff. */
export const START_TRIES = 3;
export const START_BACKOFF_MS = 2_000;
/** Checkout gets a 10-minute budget (the read token's TTL). */
export const CHECKOUT_TIMEOUT_MS = 10 * 60 * 1000;
/** A job stuck in `starting` this long (a crash mid-start) is failed. */
export const STALE_START_MS = 5 * 60 * 1000;

export type ProcessStatus =
	| "starting"
	| "running"
	| "completed"
	| "failed"
	| "killed"
	| "error";

export type ProcessInfo = {
	readonly status: ProcessStatus;
	readonly exitCode?: number | null;
};

export type LogEvent = {
	readonly type: "stdout" | "stderr" | "exit" | "error" | "complete" | string;
	readonly data?: string;
	readonly exitCode?: number | null;
};

export type ExecOutput = {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
};

export type PortExecOptions = {
	readonly env?: Readonly<Record<string, string>>;
	readonly cwd?: string;
	readonly timeoutMs?: number;
};

/** The Sandbox SDK surface the runner uses (sessionless execs only). */
export type SandboxPort = {
	exec(command: string, options?: PortExecOptions): Promise<ExecOutput>;
	/** `processId` names the process, so a retried start finds it (`getProcess`). */
	startProcess(
		command: string,
		options?: PortExecOptions & { readonly processId?: string },
	): Promise<{ readonly id: string }>;
	getProcess(id: string): Promise<ProcessInfo | null>;
	killProcess(id: string): Promise<void>;
	streamLogs(id: string): Promise<AsyncIterable<LogEvent>>;
	destroy(): Promise<void>;
	setKeepAlive(on: boolean): Promise<void>;
	/** Schedules `reconcile` (deduplicated by the adapter). */
	scheduleWatchdog(delaySeconds: number): Promise<void>;
	waitUntil(work: Promise<unknown>): void;
};

export type MintedToken = {
	readonly remote: string;
	readonly token: string;
	readonly revoke: () => Promise<void>;
};

/** Kernel side effects of a job sandbox. */
export type JobSinks = {
	jobLog(
		repoId: string,
		runId: string,
		jobId: string,
		chunk: string,
	): Promise<void>;
	setJobState(
		repoId: string,
		runId: string,
		jobId: string,
		update: { state: JobState; exitCode?: number; logKey?: string },
	): Promise<void>;
	putLog(key: string, text: string): Promise<void>;
	notify(
		instanceId: string,
		type: string,
		payload: { state: JobState; exitCode?: number },
	): Promise<void>;
	/** A short-lived token scoped to exactly the repo that holds `source`. */
	mintToken(source: GitSource, scope: "read" | "write"): Promise<MintedToken>;
};

export type RunContext = {
	readonly repoId: string;
	readonly runId: string;
	readonly instanceId: string;
	readonly kind: "ci" | "git";
	readonly requestedBy: string;
};

export type PrepareInput = RunContext & {
	readonly source: GitSource;
	readonly sha: string;
};

export type RunJobInput = RunContext & {
	readonly job: JobSpec;
	readonly attempt: number;
	readonly timeoutMs: number;
};

type Phase = "starting" | "running" | "finalizing" | "done";

/** One job's durable record (`job_state`, key `job:<jobId>:a<attempt>`). */
export type JobRecord = RunContext & {
	readonly jobId: string;
	readonly attempt: number;
	readonly phase: Phase;
	readonly processId?: string;
	readonly startedAt: number;
	readonly deadline: number;
	/** Characters of each stream already logged (re-attach skips them). */
	readonly seen: { readonly stdout: number; readonly stderr: number };
	readonly logSeq: number;
	readonly outcome?: JobState;
	readonly exitCode?: number;
	readonly reason?: string;
};

export type JobSnapshot = {
	readonly jobId: string;
	readonly attempt: number;
	readonly phase: Phase;
	readonly processId?: string;
	readonly outcome?: JobState;
	readonly exitCode?: number;
	readonly reason?: string;
};

export type JobRunnerDeps = {
	readonly sql: SqlStorage;
	readonly port: SandboxPort;
	readonly sinks: JobSinks;
	readonly now?: () => number;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly flushMs?: number;
};

const SCHEMA = [
	"CREATE TABLE IF NOT EXISTS job_state (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
	"CREATE TABLE IF NOT EXISTS job_log (job TEXT NOT NULL, seq INTEGER NOT NULL, chunk TEXT NOT NULL, PRIMARY KEY (job, seq))",
];

const jobKey = (jobId: string, attempt: number): string =>
	`job:${jobId}:a${attempt}`;

/**
 * The sandbox process id of one job attempt of one run. Deterministic, so a
 * start retried after `startProcess` succeeded but its answer was lost finds
 * the process it launched instead of launching a second one; the run id keeps
 * a reused (git) sandbox's old records apart.
 */
export const jobProcessId = (
	runId: string,
	jobId: string,
	attempt: number,
): string => `job-${runId}-${jobId}-a${attempt}`;

const TERMINAL_STATUS: ReadonlySet<ProcessStatus> = new Set([
	"completed",
	"failed",
	"killed",
	"error",
]);

/** Retries `fn` (first calls into a sandbox: a new app's first start may 500). */
export const withStartRetries = async <T>(
	fn: () => Promise<T>,
	sleep: (ms: number) => Promise<void>,
	tries = START_TRIES,
): Promise<T> => {
	let last: unknown;
	for (let i = 0; i < tries; i++) {
		try {
			return await fn();
		} catch (error) {
			last = error;
			if (i < tries - 1) await sleep(START_BACKOFF_MS);
		}
	}
	throw last;
};

type Pump = {
	readonly redactors: Record<"stdout" | "stderr", LineRedactor>;
	buffer: string;
	timer?: ReturnType<typeof setTimeout>;
};

export type JobRunner = ReturnType<typeof createJobRunner>;

export const createJobRunner = (deps: JobRunnerDeps) => {
	const { sql, port, sinks } = deps;
	const now = deps.now ?? (() => Date.now());
	const sleep = deps.sleep ??
		((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const flushMs = deps.flushMs ?? LOG_FLUSH_MS;
	for (const statement of SCHEMA) sql.exec(statement);

	const pumps = new Map<string, Pump>();
	const finalizing = new Map<string, Promise<void>>();

	const read = (key: string): JobRecord | null => {
		const row = sql.exec<{ v: string }>(
			"SELECT v FROM job_state WHERE k = ?",
			key,
		).toArray()[0];
		return row === undefined ? null : JSON.parse(row.v) as JobRecord;
	};
	const write = (key: string, record: JobRecord): void => {
		sql.exec(
			"INSERT INTO job_state (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
			key,
			JSON.stringify(record),
		);
	};
	const update = (key: string, patch: Partial<JobRecord>): JobRecord => {
		const current = read(key);
		if (current === null) throw new Error(`no job record ${key}`);
		const next = { ...current, ...patch };
		write(key, next);
		return next;
	};
	const records = (): JobRecord[] =>
		sql.exec<{ v: string }>(
			"SELECT v FROM job_state WHERE k LIKE 'job:%' ORDER BY k",
		).toArray().map((row) => JSON.parse(row.v) as JobRecord);

	const snapshot = (r: JobRecord): JobSnapshot => ({
		jobId: r.jobId,
		attempt: r.attempt,
		phase: r.phase,
		...(r.processId !== undefined ? { processId: r.processId } : {}),
		...(r.outcome !== undefined ? { outcome: r.outcome } : {}),
		...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}),
		...(r.reason !== undefined ? { reason: r.reason } : {}),
	});

	// ----------------------------------------------------------------- logs

	/** Persists buffered output and sends it to RepoDO (best effort). */
	const flush = async (key: string): Promise<void> => {
		const pump = pumps.get(key);
		if (pump === undefined || pump.buffer === "") return;
		const chunk = pump.buffer;
		pump.buffer = "";
		const record = read(key);
		if (record === null) return;
		await sinks.jobLog(record.repoId, record.runId, record.jobId, chunk).catch(
			(error) =>
				console.error("[tartan] job log flush failed", safeText(String(error))),
		);
	};

	const scheduleFlush = (key: string): void => {
		const pump = pumps.get(key);
		if (pump === undefined || pump.timer !== undefined) return;
		pump.timer = setTimeout(() => {
			pump.timer = undefined;
			void flush(key);
		}, flushMs);
	};

	/** Appends redacted text to the durable log and the flush buffer. */
	const appendLog = (key: string, text: string, seen: JobRecord["seen"]) => {
		if (text === "" && seen === undefined) return;
		const record = read(key);
		if (record === null) return;
		const seq = record.logSeq + 1;
		if (text !== "") {
			sql.exec(
				"INSERT INTO job_log (job, seq, chunk) VALUES (?, ?, ?)",
				key,
				seq,
				text,
			);
		}
		update(key, { seen, logSeq: text === "" ? record.logSeq : seq });
		const pump = pumps.get(key);
		if (pump !== undefined && text !== "") {
			pump.buffer += text;
			scheduleFlush(key);
		}
	};

	const fullLog = (key: string): string =>
		sql.exec<{ chunk: string }>(
			"SELECT chunk FROM job_log WHERE job = ? ORDER BY seq",
			key,
		).toArray().map((row) => row.chunk).join("");

	// ------------------------------------------------------------- finalize

	const finalize = (
		key: string,
		result: { outcome: JobState; exitCode?: number; reason?: string },
	): Promise<void> => {
		const running = finalizing.get(key);
		if (running !== undefined) return running;
		const work = (async () => {
			const record = read(key);
			if (record === null || record.phase === "done") return;
			const pump = pumps.get(key);
			if (pump !== undefined) {
				if (pump.timer !== undefined) clearTimeout(pump.timer);
				pump.timer = undefined;
				const rest = pump.redactors.stdout.end() + pump.redactors.stderr.end();
				appendLog(key, rest, read(key)!.seen);
			}
			// A verdict recorded before a kill (timeout, run stopped) wins over
			// the exit the kill itself produces.
			const verdict = record.reason !== undefined
				? {
					outcome: record.outcome ?? result.outcome,
					reason: record.reason,
				}
				: result;
			const current = record.phase === "finalizing" ? record : update(key, {
				phase: "finalizing",
				outcome: verdict.outcome,
				...(verdict.exitCode !== undefined
					? { exitCode: verdict.exitCode }
					: {}),
				...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
			});
			if (verdict.reason !== undefined && record.phase !== "finalizing") {
				appendLog(
					key,
					`\n[tartan] job ended: ${verdict.reason}\n`,
					read(key)!.seen,
				);
			}
			await flush(key);
			const logKey = jobLogKey(current.repoId, current.runId, current.jobId);
			await sinks.putLog(logKey, redactSecrets(fullLog(key)));
			const outcome = current.outcome ?? result.outcome;
			await sinks.setJobState(current.repoId, current.runId, current.jobId, {
				state: outcome,
				...(current.exitCode !== undefined
					? { exitCode: current.exitCode }
					: {}),
				logKey,
			});
			await sinks.notify(
				current.instanceId,
				jobEventType(current.jobId, current.attempt),
				{
					state: outcome,
					...(current.exitCode !== undefined
						? { exitCode: current.exitCode }
						: {}),
				},
			);
			update(key, { phase: "done" });
			sql.exec("DELETE FROM job_log WHERE job = ?", key);
			pumps.delete(key);
			await revokeFor(key);
		})().finally(() => finalizing.delete(key));
		finalizing.set(key, work);
		return work;
	};

	const exitOutcome = (exitCode: number | null | undefined) =>
		exitCode === 0 ? { outcome: "success" as const, exitCode: 0 } : {
			outcome: "failure" as const,
			...(typeof exitCode === "number" ? { exitCode } : {}),
		};

	// ----------------------------------------------------------------- pump

	const pumpLoop = async (key: string, processId: string): Promise<void> => {
		let exited: number | null | undefined = undefined;
		try {
			const stream = await port.streamLogs(processId);
			const skip = { ...read(key)!.seen };
			const seen = { ...skip };
			const counted = { stdout: 0, stderr: 0 };
			for await (const event of stream) {
				if (event.type === "stdout" || event.type === "stderr") {
					const data = event.data ?? "";
					const stream = event.type;
					const before = counted[stream];
					counted[stream] += data.length;
					const fresh = before >= skip[stream]
						? data
						: data.slice(Math.max(0, skip[stream] - before));
					if (fresh === "") continue;
					seen[stream] = Math.max(seen[stream], counted[stream]);
					const pump = pumps.get(key);
					if (pump === undefined) return;
					appendLog(key, pump.redactors[stream].push(fresh), { ...seen });
				} else if (event.type === "exit" || event.type === "complete") {
					exited = event.exitCode ?? null;
					break;
				}
			}
		} catch (error) {
			console.error("[tartan] log pump ended", safeText(String(error)));
		}
		if (exited !== undefined) {
			await finalize(key, exitOutcome(exited)).catch((error) =>
				console.error("[tartan] finalize failed", safeText(String(error)))
			);
			return;
		}
		// The stream ended without an exit event: the watchdog decides.
		pumps.delete(key);
	};

	const ensurePump = (key: string): void => {
		const record = read(key);
		if (
			record === null || record.phase !== "running" ||
			record.processId === undefined || pumps.has(key)
		) return;
		pumps.set(key, {
			redactors: { stdout: createLineRedactor(), stderr: createLineRedactor() },
			buffer: "",
		});
		port.waitUntil(pumpLoop(key, record.processId));
	};

	// ------------------------------------------------------------- checkout

	const prepare = async (input: PrepareInput): Promise<ExecOutput> => {
		write("run", {
			...input,
			jobId: "",
			attempt: 0,
			phase: "running",
			startedAt: now(),
			deadline: 0,
			seen: { stdout: 0, stderr: 0 },
			logSeq: 0,
		});
		await withStartRetries(() => port.setKeepAlive(true), sleep);
		const done = await withStartRetries(
			() =>
				port.exec(
					asUid("tartan-git", ["git", "-C", CHECKOUT_DIR, "rev-parse", "HEAD"]),
				),
			sleep,
		);
		if (done.exitCode === 0 && done.stdout.trim() === input.sha) {
			return { exitCode: 0, stdout: "already checked out\n", stderr: "" };
		}
		const setup = await port.exec(
			`rm -rf ${CHECKOUT_DIR} && install -d -o tartan-git -g tartan-git ${CHECKOUT_DIR}`,
		);
		if (setup.exitCode !== 0) return redactOutput(setup);
		const token = await sinks.mintToken(input.source, "read");
		try {
			const script = [
				'cd "$1"',
				"git init -q .",
				'git fetch -q --depth=1 --no-tags "$2" "$3"',
				'git checkout -q --detach "$3"',
				'test "$(git rev-parse HEAD)" = "$3"',
			].join(" && ");
			const out = await port.exec(
				asUid("tartan-git", [
					"bash",
					"-eo",
					"pipefail",
					"-c",
					script,
					"checkout",
					CHECKOUT_DIR,
					token.remote,
					input.sha,
				]),
				{
					env: {
						HOME: RUNNER_HOME["tartan-git"],
						...gitAuthEnv([{ remote: token.remote, token: token.token }]),
					},
					timeoutMs: CHECKOUT_TIMEOUT_MS,
				},
			);
			return redactOutput(out);
		} finally {
			await token.revoke().catch(() => undefined);
		}
	};

	const redactOutput = (out: ExecOutput): ExecOutput => ({
		exitCode: out.exitCode,
		stdout: safeText(out.stdout, 8192),
		stderr: safeText(out.stderr, 8192),
	});

	// ----------------------------------------------------------------- jobs

	/** Moves a `starting` record whose process exists to `running` (it is watched from now on). */
	const adopt = async (
		key: string,
		processId: string,
	): Promise<JobSnapshot> => {
		const record = update(key, { phase: "running", processId });
		ensurePump(key);
		await port.scheduleWatchdog(WATCHDOG_S);
		return snapshot(record);
	};

	/** The process of a start that may have happened, or null. */
	const startedProcess = (processId: string) =>
		port.getProcess(processId).catch(() => null);

	const runJob = async (
		input: RunJobInput,
	): Promise<JobSnapshot> => {
		const key = jobKey(input.job.id, input.attempt);
		const processIdWanted = jobProcessId(
			input.runId,
			input.job.id,
			input.attempt,
		);
		const existing = read(key);
		if (existing !== null && existing.phase !== "starting") {
			ensurePump(key);
			return snapshot(existing);
		}
		if (
			existing !== null && await startedProcess(processIdWanted) !== null
		) {
			// A retried start step whose first start launched the process.
			return await adopt(key, processIdWanted);
		}
		const job = input.job;
		const cwd = safeRelativePath(job.cwd ?? "");
		if (cwd === null) {
			throw new Error(`job ${job.id}: cwd must stay inside the checkout`);
		}
		const startedAt = now();
		write(key, {
			repoId: input.repoId,
			runId: input.runId,
			instanceId: input.instanceId,
			kind: input.kind,
			requestedBy: input.requestedBy,
			jobId: job.id,
			attempt: input.attempt,
			phase: "starting",
			startedAt,
			deadline: startedAt + input.timeoutMs,
			seen: { stdout: 0, stderr: 0 },
			logSeq: 0,
		});
		const baseEnv: Record<string, string> = {
			...(job.env ?? {}),
			CI: "true",
			TARTAN_RUN_ID: input.runId,
			TARTAN_JOB_ID: job.id,
		};
		let command: string;
		let env: Record<string, string>;
		let revoke: (() => Promise<void>) | undefined;
		if (job.argv !== undefined) {
			// Kernel git jobs only (K1, K11): a write token for the canonical
			// repo, in this exec's env, after every content process is killed.
			if (input.kind !== "git" || input.requestedBy !== "kernel") {
				throw new Error(`job ${job.id}: argv jobs are kernel git jobs only`);
			}
			const token = await sinks.mintToken({ repoId: input.repoId }, "write");
			revoke = token.revoke;
			await port.exec(KILL_CONTENT_UID);
			command = asUid("tartan-push", job.argv);
			env = {
				...baseEnv,
				HOME: RUNNER_HOME["tartan-push"],
				...gitAuthEnv([{ remote: token.remote, token: token.token }]),
			};
		} else {
			command = shellAsUid("tartan-git", job.run!);
			env = { ...baseEnv, HOME: RUNNER_HOME["tartan-git"] };
		}
		let processId: string;
		try {
			processId = (await withStartRetries(
				async () =>
					// A try whose answer was lost may have started it already.
					await startedProcess(processIdWanted) !== null
						? { id: processIdWanted }
						: await port.startProcess(command, {
							env,
							cwd: cwd === "" ? CHECKOUT_DIR : `${CHECKOUT_DIR}/${cwd}`,
							processId: processIdWanted,
						}),
				sleep,
			)).id;
		} catch (error) {
			await revoke?.().catch(() => undefined);
			throw error;
		}
		const record = update(key, { phase: "running", processId });
		if (revoke !== undefined) revokers.set(key, revoke);
		ensurePump(key);
		await port.scheduleWatchdog(WATCHDOG_S);
		return snapshot(record);
	};

	/** Write tokens live in memory only; a restart lets them expire (5 min). */
	const revokers = new Map<string, () => Promise<void>>();
	const revokeFor = async (key: string): Promise<void> => {
		const revoke = revokers.get(key);
		revokers.delete(key);
		await revoke?.().catch(() => undefined);
	};

	const killAll = async (except?: string): Promise<void> => {
		for (const record of records()) {
			const key = jobKey(record.jobId, record.attempt);
			if (key === except || record.phase !== "running") continue;
			update(key, { outcome: "cancelled", reason: "run stopped" });
			if (record.processId !== undefined) {
				await port.killProcess(record.processId).catch(() => undefined);
			}
			await finalize(key, { outcome: "cancelled", reason: "run stopped" })
				.catch((error) =>
					console.error("[tartan] finalize failed", safeText(String(error)))
				);
			await revokeFor(key);
		}
	};

	/**
	 * The watchdog and poll fallback. Returns the snapshots after the pass;
	 * reschedules itself while a job is live.
	 */
	const reconcile = async (): Promise<JobSnapshot[]> => {
		let timedOut = false;
		for (const record of records()) {
			const key = jobKey(record.jobId, record.attempt);
			try {
				if (record.phase === "finalizing") {
					await finalize(key, { outcome: record.outcome ?? "failure" });
					await revokeFor(key);
					continue;
				}
				if (record.phase === "starting") {
					if (now() - record.startedAt > STALE_START_MS) {
						const pid = jobProcessId(
							record.runId,
							record.jobId,
							record.attempt,
						);
						if (await startedProcess(pid) !== null) {
							// It did start: watch it rather than leave it unmonitored.
							await adopt(key, pid);
						} else {
							await finalize(key, { outcome: "failure", reason: "start lost" });
						}
					}
					continue;
				}
				if (record.phase !== "running" || record.processId === undefined) {
					continue;
				}
				const info = await port.getProcess(record.processId);
				if (info === null) {
					await finalize(key, {
						outcome: "failure",
						reason: "process lost (container restarted)",
					});
					await revokeFor(key);
				} else if (TERMINAL_STATUS.has(info.status)) {
					await finalize(key, exitOutcome(info.exitCode));
					await revokeFor(key);
				} else if (now() > record.deadline) {
					const reason = `timeout after ${
						Math.round((record.deadline - record.startedAt) / 1000)
					} s`;
					update(key, { outcome: "failure", reason });
					await port.killProcess(record.processId).catch(() => undefined);
					await finalize(key, { outcome: "failure", reason });
					await revokeFor(key);
					await killAll(key);
					timedOut = true;
				} else {
					ensurePump(key);
				}
			} catch (error) {
				console.error("[tartan] watchdog", key, safeText(String(error)));
			}
		}
		if (timedOut) {
			await port.destroy().catch(() => undefined);
		} else if (records().some((r) => r.phase !== "done")) {
			await port.scheduleWatchdog(WATCHDOG_S);
		}
		return records().map(snapshot);
	};

	/** Cancel, supersede, slot expiry and the run's own finish. */
	const stopRun = async (): Promise<void> => {
		await killAll();
		await port.destroy();
	};

	const jobState = (jobId: string, attempt: number): JobSnapshot | null => {
		const record = read(jobKey(jobId, attempt));
		return record === null ? null : snapshot(record);
	};

	return { prepare, runJob, reconcile, stopRun, jobState };
};
