// The repository-config evaluator job in TartanSandbox (`cue:trunk`,
// `cue:preview:<k>`; ADR repo config, "When and where evaluation runs" and
// "The evaluator job"). WP23 writes it, WP9 reviews it.
//
// - `cueSubmit` enqueues and returns at once (`{accepted, jobId, warm}`):
//   no caller ever awaits an evaluation. The sandbox drains its
//   queue in `waitUntil`, one job at a time under its own mutex, in strict
//   priority on `cue:trunk` (trunk and explicit applies, then trunk moves
//   outside the Advance, registry re-evaluations, self-checks).
// - Single flight by input key: a duplicate submit joins the queued or
//   running job and adds its sink.
// - Previews (`cue:preview:<k>` only): one lane in flight per principal
//   (a newer push of that lane queues behind its running preview), the
//   latest request per lane replaces a queued one, a per-principal hourly
//   budget and a bounded queue that answers `rate_limited`.
// - One job = one size-capped bundle written with `writeFile`, then one
//   exec of `containers/runner/cue-job.sh` as `tartan-git`, which unpacks
//   into a private `mktemp -d`, re-checks every name, writes the forge
//   module's `cue.mod/module.cue` with a module path fresh for the job, runs
//   `cue export -E --out json .:tartan` under a SIGKILL timeout, RLIMIT_AS,
//   RLIMIT_FSIZE, OOM priority and an empty environment with
//   `CUE_REGISTRY=none`, and prints one JSON line. The CLI selects package
//   `tartan` among the root `*.cue` files (ADR repo config).
// - The envelope goes back through a sink (`envCueSinks`): RepoDO's
//   `repoconfig().cueResult` or the registry's `selfCheckResult`.
//
// The container holds no token and no secret: files in, JSON out.

import {
	CUE_EVAL_CONTRACT,
	CUE_EVALUATOR_ID,
	CUE_JOB_PRIORITY,
	CUE_JOB_VERSION,
	CUE_VERSION,
	type CueJobInput,
	type CueJobSink,
	type CueSubmitResult,
	type EvalLimits,
	type EvalResponse,
	FORGE_BINDING_FILE,
	hostEvalError,
	isEvalOk,
	parseEvalResponse,
	REPO_CONFIG_LIMITS,
} from "@tartan/contract";
import {
	isLoadIssue,
	normalizeCueErrors,
	refusedImport,
	refusedImportMessage,
	summarizeIssues,
} from "../repoconfig/issues.ts";
import { createMutex } from "./exec.ts";
import { asUid, KILL_CONTENT_UID } from "./shell.ts";

// ---------------------------------------------------------------------------
// The bundle
// ---------------------------------------------------------------------------

/** Where the image installs the job (Dockerfile cue stage). */
export const CUE_JOB_SCRIPT = "/opt/tartan-cue/cue-job.sh";
/**
 * Bundles are written here by the root control server: a root-owned 0755
 * directory the image creates, so `tartan-git` can read a bundle but never
 * create, replace or link an entry (in world-writable `/tmp`, a leftover
 * job process could plant a symlink at a guessed path).
 */
export const CUE_BUNDLE_DIR = "/opt/tartan-cue/bundles";
/** One file per job, removed after the exec. */
export const cueBundlePath = (jobId: string): string =>
	`${CUE_BUNDLE_DIR}/bundle-${jobId}.json`;

/**
 * Paths a bundle may hold (module-root-relative): the forge's schema
 * package files, its binding file `~tartan.cue` and the repository's
 * validated root `<name>.cue` files (any package). No repository name can
 * equal a forge name: those hold a `/` or a `~`. The job writes
 * `cue.mod/module.cue` itself (a module path fresh per job), so a bundle
 * never carries one. `cue-job.sh` re-checks the same rule before it writes
 * anything.
 */
export const CUE_BUNDLE_PATH_RE =
	/^(cue\.mod\/pkg\/tartan\.dev\/ext\/ext\.cue|cue\.mod\/pkg\/tartan\.dev\/ext\/x\/[a-z0-9_]{1,64}\/settings\.cue|~tartan\.cue|[A-Za-z0-9_.-]+\.cue)$/;

const toBase64 = (text: string): string => {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
};

export type BundleResult =
	| { readonly ok: true; readonly json: string }
	| { readonly ok: false; readonly message: string };

/** `{"v":1,"files":{"<path>":"<base64>"}}`, at most `bundleBytes`. */
export const buildCueBundle = (
	files: Readonly<Record<string, string>>,
): BundleResult => {
	const out: Record<string, string> = {};
	for (const [path, text] of Object.entries(files)) {
		if (!CUE_BUNDLE_PATH_RE.test(path)) {
			return { ok: false, message: `not a bundle path: ${path.slice(0, 200)}` };
		}
		out[path] = toBase64(text);
	}
	if (!Object.hasOwn(out, FORGE_BINDING_FILE)) {
		return { ok: false, message: `a bundle needs ${FORGE_BINDING_FILE}` };
	}
	const json = JSON.stringify({ v: 1, files: out });
	if (json.length > REPO_CONFIG_LIMITS.bundleBytes) {
		return {
			ok: false,
			message:
				`bundle of ${json.length} bytes exceeds ${REPO_CONFIG_LIMITS.bundleBytes}`,
		};
	}
	return { ok: true, json };
};

/**
 * The one exec of a job, run as root by the sandbox's control server: the
 * job drops to `tartan-git` itself (no new privileges), every process left
 * by `tartan-git` afterwards is killed, so nothing a job started outlives it
 * into the next repository's job, then the bundle is
 * removed (root's file in the bundle directory), and stale bundles of
 * crashed jobs are wiped.
 */
export const cueJobCommand = (
	jobId: string,
	limits: EvalLimits,
	/** Dev probes only: no RLIMIT_AS, so the instance OOM backstop is measured. */
	options: { readonly unboundedAddressSpace?: boolean } = {},
): string => {
	if (!/^[a-z0-9_]{1,64}$/.test(jobId)) throw new Error("unsafe job id");
	const bundle = cueBundlePath(jobId);
	const job = asUid("tartan-git", [
		"env",
		"-i",
		"PATH=/usr/local/bin:/usr/bin:/bin",
		`CUE_JOB_TIMEOUT_S=${Math.floor(limits.wallClockS)}`,
		`CUE_JOB_VM_KIB=${
			options.unboundedAddressSpace === true
				? "unlimited"
				: Math.floor(limits.addressSpaceKiB)
		}`,
		`CUE_JOB_FSIZE_KIB=${Math.floor(limits.outputFileKiB)}`,
		`CUE_JOB_OUT_BYTES=${Math.floor(limits.jsonBytes)}`,
		`CUE_JOB_ERR_BYTES=${Math.floor(limits.stderrBytes)}`,
		CUE_JOB_SCRIPT,
		bundle,
	], { noNewPrivs: true });
	return [
		`find ${CUE_BUNDLE_DIR} -maxdepth 1 -name 'bundle-*.json' -mmin +10 -delete 2>/dev/null`,
		`${job}; rc=$?`,
		KILL_CONTENT_UID,
		`rm -f ${bundle}`,
		"exit $rc",
	].join("; ");
};

// ---------------------------------------------------------------------------
// The classifier: the job's JSON line → tartan.cue-eval/1
// ---------------------------------------------------------------------------

/** Exit codes `cue-job.sh` reports (cue's own: 0 ok, 1 CUE errors). */
export const CUE_JOB_EXIT = {
	ok: 0,
	cueErrors: 1,
	/** The Go runtime aborted (out of memory under RLIMIT_AS). */
	goFatal: 2,
	/** The job could not set up its directory or limits. */
	setup: 70,
	/** The unpacker refused the bundle (a name or size rule). */
	rejected: 71,
	/** The wall clock (normalized from a SIGKILL after the limit). */
	timeout: 124,
	/** SIGKILL before the wall clock: the instance OOM killer. */
	killed: 137,
	/**
	 * The file cap: SIGXFSZ, or the output file at RLIMIT_FSIZE after cue
	 * exited 1 (its Go runtime ignores SIGXFSZ; the job normalizes it).
	 */
	fileSize: 153,
} as const;

/** The one line `cue-job.sh` prints. */
export type CueJobOutput = {
	readonly job: number;
	readonly cue: string | null;
	readonly rc: number;
	readonly ms: number;
	readonly out: string;
	readonly outBytes: number;
	readonly err: string;
	readonly errBytes: number;
};

const parseJobOutput = (stdout: string): CueJobOutput | null => {
	const line = stdout.trim().split("\n").pop() ?? "";
	try {
		const v = JSON.parse(line) as Record<string, unknown>;
		const num = (x: unknown) =>
			typeof x === "number" && Number.isFinite(x) ? x : null;
		if (
			num(v.job) === null || num(v.rc) === null ||
			typeof v.out !== "string" || typeof v.err !== "string"
		) {
			return null;
		}
		return {
			job: v.job as number,
			cue: typeof v.cue === "string" ? v.cue : null,
			rc: v.rc as number,
			ms: num(v.ms) ?? 0,
			out: v.out,
			outBytes: num(v.outBytes) ?? v.out.length,
			err: v.err,
			errBytes: num(v.errBytes) ?? v.err.length,
		};
	} catch {
		return null;
	}
};

const headText = (text: string, max = 300): string =>
	text.length > max ? `${text.slice(0, max)}…` : text;

/**
 * Classifies one job. Never throws: anything unexpected is `INTERNAL`,
 * which is never cached. A version mismatch between the job, the binary
 * and the evaluator id is `INTERNAL` too.
 */
export const classifyCueJob = (
	stdout: string,
	options: {
		readonly evaluator?: string;
		readonly limits?: Pick<EvalLimits, "jsonBytes" | "wallClockS">;
	} = {},
): EvalResponse => {
	const evaluator = options.evaluator ?? CUE_EVALUATOR_ID;
	const limits = options.limits ?? {
		jsonBytes: REPO_CONFIG_LIMITS.jsonBytes,
		wallClockS: REPO_CONFIG_LIMITS.wallClockS,
	};
	const out = parseJobOutput(stdout);
	if (out === null) {
		return hostEvalError("INTERNAL", "the job printed no result line", {
			evaluator,
		});
	}
	const base = {
		version: CUE_EVAL_CONTRACT,
		evaluator,
		cueVersion: out.cue,
		ms: Math.max(0, Math.round(out.ms)),
	} as const;
	const fail = (
		code: Parameters<typeof hostEvalError>[0],
		message: string,
		issues: EvalResponse["issues"] = [],
	): EvalResponse => ({
		...base,
		error: {
			code,
			message: message.slice(0, REPO_CONFIG_LIMITS.issueMessageBytes),
		},
		issues: [...issues],
	});
	if (out.job !== CUE_JOB_VERSION) {
		return fail(
			"INTERNAL",
			`job version ${out.job}, expected ${CUE_JOB_VERSION}`,
		);
	}
	if (out.rc === CUE_JOB_EXIT.rejected) {
		return fail("INVALID_INPUT", `bundle rejected: ${headText(out.err)}`);
	}
	if (out.rc === CUE_JOB_EXIT.setup) {
		return fail("INTERNAL", `job setup failed: ${headText(out.err)}`);
	}
	if (out.cue !== CUE_VERSION) {
		return fail(
			"INTERNAL",
			`cue ${out.cue ?? "missing"} in the image, expected ${CUE_VERSION}`,
		);
	}
	switch (out.rc) {
		case CUE_JOB_EXIT.ok: {
			if (out.outBytes > limits.jsonBytes) {
				return fail(
					"LIMIT_EXCEEDED",
					`exported JSON of ${out.outBytes} bytes exceeds ${limits.jsonBytes}`,
				);
			}
			let value: unknown;
			try {
				value = JSON.parse(out.out);
			} catch {
				return fail("INTERNAL", "cue exited 0 with output that is not JSON");
			}
			return parseEvalResponse({ ...base, ok: value, issues: [] }, limits);
		}
		case CUE_JOB_EXIT.timeout:
			return fail(
				"TIMEOUT",
				`evaluation stopped after ${limits.wallClockS} s (SIGKILL)`,
			);
		case CUE_JOB_EXIT.fileSize:
			return fail(
				"LIMIT_EXCEEDED",
				"output or error text reached the file cap",
			);
		case CUE_JOB_EXIT.killed:
			return fail("LIMIT_EXCEEDED", "killed by the instance memory limit");
		case CUE_JOB_EXIT.goFatal:
			return /out of memory|cannot allocate memory/i.test(out.err)
				? fail("LIMIT_EXCEEDED", "address-space limit reached")
				: fail("INTERNAL", `cue aborted: ${headText(out.err)}`);
		case CUE_JOB_EXIT.cueErrors: {
			const issues = normalizeCueErrors(out.err);
			if (issues.length === 0) {
				return fail("INTERNAL", "cue exited 1 without errors");
			}
			// The import rule (ADR repo config): only the standard library and
			// tartan.dev/ext resolve; anything else is the author's input.
			const refused = refusedImport(issues);
			if (refused !== null) {
				return fail("INVALID_INPUT", refusedImportMessage(refused), issues);
			}
			return fail(
				issues.some(isLoadIssue) ? "LOAD_INSTANCE" : "BUILD_VALUE",
				summarizeIssues(issues),
				issues,
			);
		}
		default:
			return fail("INTERNAL", `exit ${out.rc}: ${headText(out.err)}`);
	}
};

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

export const CUE_QUEUE_SCHEMA = [
	`CREATE TABLE IF NOT EXISTS cue_jobs (input_key TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE,
  class TEXT NOT NULL, priority INTEGER NOT NULL, principal TEXT, lane_id TEXT,
  request_json TEXT NOT NULL, sinks_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','running')),
  enqueued_at INTEGER NOT NULL, started_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0)`,
	"CREATE INDEX IF NOT EXISTS cue_jobs_next ON cue_jobs(state, priority, enqueued_at)",
	`CREATE TABLE IF NOT EXISTS cue_budget (principal TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL, count INTEGER NOT NULL)`,
	// The poison-input breaker: crashes per input key, and
	// when an input last evaluated.
	`CREATE TABLE IF NOT EXISTS cue_poison (input_key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL, first_at INTEGER NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS cue_state (k TEXT PRIMARY KEY, v INTEGER NOT NULL)`,
];

type CueJobRow = {
	input_key: string;
	id: string;
	class: string;
	priority: number;
	principal: string | null;
	lane_id: string | null;
	request_json: string;
	sinks_json: string;
	state: "queued" | "running";
	enqueued_at: number;
	started_at: number | null;
	attempts: number;
};

export type CueExecResult = {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
};

/** What the queue needs from its sandbox. */
export type CuePort = {
	/** False without a container (`--no-containers`, vitest). */
	available(): boolean;
	/** Whether the container is running now (deadline 30 s, else 75 s). */
	warm(): boolean;
	writeFile(path: string, content: string): Promise<void>;
	exec(command: string, timeoutMs: number): Promise<CueExecResult>;
	waitUntil(work: Promise<unknown>): void;
};

export type CueSinks = {
	/** `origin`: this sandbox's role (a preview never answers for trunk). */
	deliver(
		sink: CueJobSink,
		inputKey: string,
		envelope: EvalResponse,
		origin: "trunk" | "preview",
	): Promise<void>;
};

export type CueQueueDeps = {
	readonly sql: SqlStorage;
	readonly port: CuePort;
	readonly sinks: CueSinks;
	/** `preview` on `cue:preview:<k>`, `trunk` on `cue:trunk`. */
	readonly role: "trunk" | "preview";
	readonly now?: () => number;
	readonly ids?: () => string;
	readonly log?: (message: string, data: Record<string, unknown>) => void;
	readonly sleep?: (ms: number) => Promise<void>;
};

/** At most this many queued jobs on `cue:trunk` (memory bound). */
export const CUE_TRUNK_QUEUE_MAX = 1000;
/** A job whose run outlived this is reset (an evicted DO). */
export const CUE_RUNNING_STALE_MS = 2 * 60 * 1000;
/** The exec's own transport timeout (the job kills cue at 10 s). */
export const CUE_EXEC_TIMEOUT_MS = 60_000;
const HOUR_MS = 60 * 60 * 1000;
const START_TRIES = 3;
const START_BACKOFF_MS = 2_000;
/**
 * An input whose job crashed the exec or the container this many times,
 * while other inputs evaluated in between, is answered `LIMIT_EXCEEDED`
 * (cacheable), so its repo goes `failed` instead of retrying it forever on
 * the shared evaluator.
 */
export const CUE_POISON_FAILURES = 2;

const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const sinkKey = (s: CueJobSink): string =>
	s.kind === "repo" ? `repo:${s.repoId}` : `approval:${s.requestId}`;

let counter = 0;
const defaultIds = (): string =>
	`cj_${Date.now().toString(36)}${(counter++).toString(36)}${
		Math.floor(Math.random() * 1e9).toString(36)
	}`;

export const createCueQueue = (deps: CueQueueDeps) => {
	const { sql, port, sinks } = deps;
	const now = deps.now ?? (() => Date.now());
	const ids = deps.ids ?? defaultIds;
	const sleep = deps.sleep ??
		((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const log = deps.log ??
		((message: string, data: Record<string, unknown>) =>
			console.error(`[tartan] cue: ${message}`, JSON.stringify(data)));
	for (const statement of CUE_QUEUE_SCHEMA) sql.exec(statement);
	const lock = createMutex();
	let draining = false;

	const rows = (query: string, ...bindings: unknown[]): CueJobRow[] =>
		sql.exec<CueJobRow>(query, ...bindings).toArray();
	const queued = (): number =>
		sql.exec<{ n: number }>(
			"SELECT COUNT(*) AS n FROM cue_jobs WHERE state = 'queued'",
		).toArray()[0]?.n ?? 0;

	const refuse = (
		reason: "rate_limited" | "too_large" | "unavailable" | "invalid",
		message: string,
	): CueSubmitResult => ({ accepted: false, reason, message });

	/** The hourly preview budget; charges one when it allows. */
	const charge = (principal: string): boolean => {
		const t = now();
		const row = sql.exec<{ window_start: number; count: number }>(
			"SELECT window_start, count FROM cue_budget WHERE principal = ?",
			principal,
		).toArray()[0];
		if (row === undefined || t - row.window_start >= HOUR_MS) {
			sql.exec(
				`INSERT INTO cue_budget (principal, window_start, count) VALUES (?, ?, 1)
				 ON CONFLICT (principal) DO UPDATE SET window_start = excluded.window_start, count = 1`,
				principal,
				t,
			);
			return true;
		}
		if (row.count >= REPO_CONFIG_LIMITS.previewsPerHour) return false;
		sql.exec(
			"UPDATE cue_budget SET count = count + 1 WHERE principal = ?",
			principal,
		);
		return true;
	};

	const submit = (job: CueJobInput): CueSubmitResult => {
		if (!port.available()) {
			return refuse(
				"unavailable",
				"containers are not enabled for this deployment",
			);
		}
		const key = job.request.inputKey;
		if (!/^[0-9a-f]{64}$/.test(key)) return refuse("invalid", "inputKey");
		if (job.request.version !== CUE_EVAL_CONTRACT) {
			return refuse("invalid", "request version");
		}
		const isPreview = job.class === "preview";
		if (isPreview !== (deps.role === "preview")) {
			return refuse(
				"invalid",
				isPreview
					? "previews never run on cue:trunk"
					: "kernel work never runs on a preview sandbox",
			);
		}
		const bundle = buildCueBundle(job.request.files);
		if (!bundle.ok) return refuse("too_large", bundle.message);
		const t = now();
		const existing = rows("SELECT * FROM cue_jobs WHERE input_key = ?", key)[0];
		if (existing !== undefined) {
			const list = JSON.parse(existing.sinks_json) as CueJobSink[];
			if (!list.some((s) => sinkKey(s) === sinkKey(job.sink))) {
				list.push(job.sink);
				sql.exec(
					"UPDATE cue_jobs SET sinks_json = ? WHERE input_key = ?",
					JSON.stringify(list),
					key,
				);
			}
			const priority = CUE_JOB_PRIORITY[job.class];
			if (priority < existing.priority) {
				sql.exec(
					"UPDATE cue_jobs SET priority = ?, class = ? WHERE input_key = ?",
					priority,
					job.class,
					key,
				);
			}
			kick();
			return {
				accepted: true,
				jobId: existing.id,
				warm: port.warm(),
				ahead: aheadOf(existing.input_key),
				joined: true,
			};
		}
		if (isPreview) {
			const principal = job.principal ?? "";
			if (principal === "") {
				return refuse("invalid", "a preview names its principal");
			}
			if (job.laneId !== undefined) {
				// The latest request per lane replaces a queued one.
				sql.exec(
					"DELETE FROM cue_jobs WHERE state = 'queued' AND principal = ? AND lane_id = ?",
					principal,
					job.laneId,
				);
			}
			// One lane in flight per principal: a newer push of the lane whose
			// preview is running queues behind it (its own queued one was
			// replaced above); another lane waits its turn.
			const inFlight = sql.exec<{ n: number }>(
				`SELECT COUNT(*) AS n FROM cue_jobs WHERE principal = ?
				 AND (? IS NULL OR lane_id IS NULL OR lane_id <> ?)`,
				principal,
				job.laneId ?? null,
				job.laneId ?? null,
			).toArray()[0]?.n ?? 0;
			if (inFlight > 0) {
				return refuse("rate_limited", "one preview in flight per principal");
			}
			if (queued() >= REPO_CONFIG_LIMITS.previewQueue) {
				return refuse("rate_limited", "the preview queue is full");
			}
			if (!charge(principal)) {
				return refuse(
					"rate_limited",
					`at most ${REPO_CONFIG_LIMITS.previewsPerHour} previews per hour`,
				);
			}
		} else if (queued() >= CUE_TRUNK_QUEUE_MAX) {
			return refuse("rate_limited", "the evaluator queue is full");
		}
		const id = ids().replace(/[^a-z0-9_]/g, "_").slice(0, 64);
		sql.exec(
			`INSERT INTO cue_jobs (input_key, id, class, priority, principal, lane_id, request_json,
			   sinks_json, state, enqueued_at, started_at, attempts)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL, 0)`,
			key,
			id,
			job.class,
			CUE_JOB_PRIORITY[job.class],
			job.principal ?? null,
			job.laneId ?? null,
			JSON.stringify({
				version: job.request.version,
				evaluator: job.request.evaluator,
				inputKey: key,
				limits: job.request.limits,
				bundle: bundle.json,
			}),
			JSON.stringify([job.sink]),
			t,
		);
		const warm = port.warm();
		kick();
		return {
			accepted: true,
			jobId: id,
			warm,
			ahead: aheadOf(key),
			joined: false,
		};
	};

	const aheadOf = (key: string): number => {
		const row = rows("SELECT * FROM cue_jobs WHERE input_key = ?", key)[0];
		if (row === undefined) return 0;
		return sql.exec<{ n: number }>(
			`SELECT COUNT(*) AS n FROM cue_jobs WHERE input_key <> ? AND
			 (state = 'running' OR priority < ? OR (priority = ? AND enqueued_at < ?))`,
			key,
			row.priority,
			row.priority,
			row.enqueued_at,
		).toArray()[0]?.n ?? 0;
	};

	const next = (): CueJobRow | null => {
		const t = now();
		// A run that outlived its exec is from an evicted instance: retry it.
		sql.exec(
			"UPDATE cue_jobs SET state = 'queued' WHERE state = 'running' AND started_at < ?",
			t - CUE_RUNNING_STALE_MS,
		);
		return rows(
			"SELECT * FROM cue_jobs WHERE state = 'queued' ORDER BY priority, enqueued_at LIMIT 1",
		)[0] ?? null;
	};

	const deliver = async (row: CueJobRow, envelope: EvalResponse) => {
		const list = JSON.parse(row.sinks_json) as CueJobSink[];
		sql.exec("DELETE FROM cue_jobs WHERE input_key = ?", row.input_key);
		await Promise.all(list.map(async (sink) => {
			for (let i = 0; i < START_TRIES; i++) {
				try {
					await sinks.deliver(sink, row.input_key, envelope, deps.role);
					return;
				} catch (error) {
					if (i === START_TRIES - 1) {
						// The caller's watchdog re-dispatches; the result is not lost twice.
						log("result delivery failed", {
							sink: sink.kind,
							inputKey: row.input_key,
							error: errorText(error).slice(0, 300),
						});
					} else {
						await sleep(START_BACKOFF_MS);
					}
				}
			}
		}));
	};

	/** The job crashed: the exec or the container failed, or the run was interrupted. */
	const crashed = (envelope: EvalResponse): boolean =>
		!isEvalOk(envelope) &&
		(envelope.error.code === "EVALUATOR_UNAVAILABLE" ||
			(envelope.error.code === "INTERNAL" &&
				/interrupted|printed no result line/.test(envelope.error.message)));

	/**
	 * The poison-input breaker: counts an input's crashes; once it crashed
	 * `CUE_POISON_FAILURES` times while other inputs evaluated in between
	 * (so it is the input, not an outage), it is answered `LIMIT_EXCEEDED`.
	 */
	const breaker = (row: CueJobRow, envelope: EvalResponse): EvalResponse => {
		const t = now();
		if (!crashed(envelope)) {
			sql.exec("DELETE FROM cue_poison WHERE input_key = ?", row.input_key);
			sql.exec(
				`INSERT INTO cue_state (k, v) VALUES ('last_ok', ?)
				 ON CONFLICT (k) DO UPDATE SET v = excluded.v`,
				t,
			);
			return envelope;
		}
		sql.exec(
			`INSERT INTO cue_poison (input_key, failures, first_at) VALUES (?, 1, ?)
			 ON CONFLICT (input_key) DO UPDATE SET failures = failures + 1`,
			row.input_key,
			t,
		);
		const poison = sql.exec<{ failures: number; first_at: number }>(
			"SELECT failures, first_at FROM cue_poison WHERE input_key = ?",
			row.input_key,
		).toArray()[0];
		const lastOk = sql.exec<{ v: number }>(
			"SELECT v FROM cue_state WHERE k = 'last_ok'",
		).toArray()[0]?.v ?? null;
		if (
			poison === undefined || poison.failures < CUE_POISON_FAILURES ||
			lastOk === null || lastOk <= poison.first_at
		) {
			return envelope;
		}
		sql.exec("DELETE FROM cue_poison WHERE input_key = ?", row.input_key);
		log("poison input answered LIMIT_EXCEEDED", {
			inputKey: row.input_key,
			failures: poison.failures,
		});
		return hostEvalError(
			"LIMIT_EXCEEDED",
			`the evaluator crashed on this input ${poison.failures} times while other inputs evaluated`,
			{ evaluator: envelope.evaluator },
		);
	};

	const runOne = async (row: CueJobRow): Promise<EvalResponse> => {
		const request = JSON.parse(row.request_json) as {
			readonly evaluator: string;
			readonly limits: EvalLimits;
			readonly bundle: string;
		};
		let last: unknown;
		for (let i = 0; i < START_TRIES; i++) {
			try {
				await port.writeFile(cueBundlePath(row.id), request.bundle);
				const out = await port.exec(
					cueJobCommand(row.id, request.limits),
					CUE_EXEC_TIMEOUT_MS,
				);
				return classifyCueJob(out.stdout, {
					evaluator: request.evaluator,
					limits: request.limits,
				});
			} catch (error) {
				last = error;
				if (i < START_TRIES - 1) await sleep(START_BACKOFF_MS);
			}
		}
		return hostEvalError(
			"EVALUATOR_UNAVAILABLE",
			`the evaluator could not run: ${errorText(last).slice(0, 300)}`,
			{ evaluator: request.evaluator },
		);
	};

	/** Drains the queue, one job at a time, in priority order. */
	const drain = (): Promise<number> =>
		lock(async () => {
			let done = 0;
			for (;;) {
				const row = next();
				if (row === null) return done;
				sql.exec(
					"UPDATE cue_jobs SET state = 'running', started_at = ?, attempts = attempts + 1 WHERE input_key = ?",
					now(),
					row.input_key,
				);
				if (row.attempts >= START_TRIES) {
					await deliver(
						row,
						breaker(
							row,
							hostEvalError("INTERNAL", "the job was interrupted three times"),
						),
					);
					continue;
				}
				const envelope = breaker(row, await runOne(row));
				await deliver(row, envelope);
				done += 1;
			}
		});

	const kick = (): void => {
		if (draining) return;
		draining = true;
		port.waitUntil(
			drain().catch((error) => {
				log("drain failed", { error: errorText(error).slice(0, 300) });
			}).finally(() => {
				draining = false;
				if (queued() > 0) kick();
			}),
		);
	};

	return {
		submit,
		drain,
		/** Runs `fn` under the queue's own mutex: no job runs meanwhile (dev probes). */
		exclusive: <T>(fn: () => Promise<T>): Promise<T> => lock(fn),
		/** Jobs queued or running (tests, diagnostics). */
		list: () =>
			rows("SELECT * FROM cue_jobs ORDER BY priority, enqueued_at").map((
				r,
			) => ({
				inputKey: r.input_key,
				id: r.id,
				class: r.class,
				state: r.state,
				principal: r.principal,
				laneId: r.lane_id,
			})),
	};
};

export type CueQueue = ReturnType<typeof createCueQueue>;
