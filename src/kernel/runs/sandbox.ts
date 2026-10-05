// TartanSandbox (`job:<runUlid>` | `git:<repoUlid>` | `selftest` | `cue:trunk`
// | `cue:preview:<k>`; the `cue:*` evaluators of repository config, ADR repo
// config, start with `enableInternet: false` and serve only `cueSubmit`): real
// git and toolchains in a container, as a `Sandbox` subclass from
// `@cloudflare/sandbox` 0.12.1 whose custom RPC goes through the DO stub.
//
// Its alarm belongs to the container library (`@cloudflare/containers` re-arms
// it and drives `keepAlive`), so this class never overrides the alarm handler,
// never sets an alarm itself and never uses the WP0 timer multiplexer
// (`src/do/sandbox.test.ts` checks it). The 60 s job watchdog, which also
// enforces each job's timeout, runs on the library's `this.schedule()` (method
// `watchdog`).
//
// Every exec is sessionless (`enableDefaultSession: false` in SDK terms):
// env, `export` and `cd` never persist between execs, so a per-exec token
// never reaches the next command.
//
// This class is a thin adapter: the job runner (`jobs.ts`) and the
// serialized git exec (`exec.ts`) hold the logic.
//
// No container: in the vitest pool and in a `--no-containers` render the DO
// has no `ctx.container`, which the library's constructor rejects. The class
// then runs on an inert container whose `start` fails with an explicit
// "containers unavailable" error, so the DO still constructs (health, the
// instantiation test) and every container call fails clearly.

import { parseSSEStream, Sandbox } from "@cloudflare/sandbox";
import {
	CUE_TRUNK_SANDBOX,
	type CueJobInput,
	type CueSubmitResult,
	DEFAULT_EVAL_LIMITS,
	FORGE_DO_NAME,
	type GitSource,
	invalid,
	notFound,
	repoArtifactsName,
	repoDoName,
	unavailable,
} from "@tartan/contract";
import {
	type GitExecOptions,
	type GitExecResult,
	SANDBOX_READ_TOKEN_TTL_S,
	SANDBOX_WRITE_TOKEN_TTL_S,
} from "@tartan/contract/kernel.ts";
import { withRpc } from "../../do/dispose.ts";
import type { Env } from "../../env.ts";
import {
	buildCueBundle,
	classifyCueJob,
	createCueQueue,
	CUE_EXEC_TIMEOUT_MS,
	cueBundlePath,
	cueJobCommand,
	type CueQueue,
	type CueSinks,
} from "./cue.ts";
import {
	CUE_PROBE_COMMANDS,
	type CueProbeInput,
	type CueProbeResult,
	summarize,
} from "./cueprobe.ts";
import { createSerializedGitExec, WARM_SLEEP_AFTER } from "./exec.ts";
import {
	createJobRunner,
	type ExecOutput,
	type JobRunner,
	type JobSinks,
	type JobSnapshot,
	type LogEvent,
	type PrepareInput,
	type RunJobInput,
	type SandboxPort,
} from "./jobs.ts";
import { safeText } from "./joblog.ts";
import { createSelftest, type RunnerInfo } from "./selftest.ts";

/**
 * The SDK's sessionless execution token (what `getSandbox(…, {
 * enableDefaultSession: false })` sends for every call).
 */
const SESSIONLESS = "__DISABLE_SESSION__";

export const CONTAINERS_UNAVAILABLE =
	"containers are not enabled for this deployment (--no-containers)";

/** A stand-in for `ctx.container` when the class has no container. */
const inertContainer = {
	running: false,
	start: () => {
		throw unavailable(CONTAINERS_UNAVAILABLE);
	},
	monitor: () => Promise.reject(unavailable(CONTAINERS_UNAVAILABLE)),
	destroy: () => Promise.resolve(),
	signal: () => undefined,
	getTcpPort: () => {
		throw unavailable(CONTAINERS_UNAVAILABLE);
	},
	setInactivityTimeout: () => Promise.resolve(),
};

/**
 * Gives a container-less state the inert container as an own property (the
 * runtime brand-checks the state object, so it cannot be wrapped).
 */
const withContainer = (ctx: DurableObjectState): DurableObjectState => {
	if (ctx.container === undefined) {
		Object.defineProperty(ctx, "container", {
			value: inertContainer,
			configurable: true,
		});
	}
	return ctx;
};

/** Kernel sinks of a job sandbox, from the Worker's bindings. */
export const envJobSinks = (env: Env): JobSinks => ({
	jobLog: async (repoId, runId, jobId, chunk) => {
		await env.REPO.getByName(repoDoName(repoId)).runs().jobLog(
			runId,
			jobId,
			chunk,
		);
	},
	setJobState: async (repoId, runId, jobId, update) => {
		await env.REPO.getByName(repoDoName(repoId)).runs().setJobState(
			runId,
			jobId,
			update,
		);
	},
	putLog: async (key, text) => {
		await env.BLOBS.put(key, text, {
			httpMetadata: { contentType: "text/plain; charset=utf-8" },
		});
	},
	notify: async (instanceId, type, payload) => {
		const instance = await env.RUNS.get(instanceId);
		await instance.sendEvent({ type, payload });
	},
	mintToken: (source, scope) => mintSourceToken(env, source, scope),
});

/**
 * Where a repository-config job's envelope goes: RepoDO's `cueResult`, or
 * the registry's approval self-check (ADR repo config).
 */
export const envCueSinks = (env: Env): CueSinks => ({
	// Each delivery disposes its facade stub when it settles, so the
	// callee's call context closes.
	deliver: async (sink, inputKey, envelope, origin) => {
		if (sink.kind === "repo") {
			await withRpc(
				() => env.REPO.getByName(repoDoName(sink.repoId)).repoconfig(),
				(f) => f.cueResult(inputKey, envelope, origin),
			);
			return;
		}
		await withRpc(
			() => env.FORGE.getByName(FORGE_DO_NAME).registry(),
			(r) => r.selfCheckResult(sink.requestId, envelope),
		);
	},
});

/** `trunk` for `cue:trunk`, `preview` for `cue:preview:<k>`, else null. */
export const cueRoleOf = (
	name: string | undefined,
): "trunk" | "preview" | null =>
	name === CUE_TRUNK_SANDBOX
		? "trunk"
		: name !== undefined && /^cue:preview:[0-9]{1,2}$/.test(name)
		? "preview"
		: null;

/**
 * A token for exactly the Artifacts repo that holds `source` (K11): the
 * canonical `r-<repoUlid>`, or for a lane the repo `laneFetchSpecs` names
 * (its current lane repo on the `repo` backend, canonical on `branch`).
 * Read tokens live 10 min, write tokens 5 min; the caller revokes after use.
 */
export const mintSourceToken = async (
	env: Env,
	source: GitSource,
	scope: "read" | "write",
): Promise<{ remote: string; token: string; revoke: () => Promise<void> }> => {
	let name = repoArtifactsName(source.repoId);
	let remote: string | undefined;
	if (source.laneId !== undefined) {
		if (scope === "write") {
			throw unavailable("lane write tokens are minted by kernel git jobs");
		}
		const [spec] = await env.REPO.getByName(repoDoName(source.repoId)).core()
			.laneFetchSpecs([source.laneId]);
		if (spec === undefined) throw notFound(`no lane ${source.laneId}`);
		name = spec.token.artifactsName;
		remote = spec.remote;
	}
	const repo = await env.ARTIFACTS.get(name);
	remote ??= (await repo.info()).remote;
	const minted = await repo.createToken(
		scope,
		scope === "write" ? SANDBOX_WRITE_TOKEN_TTL_S : SANDBOX_READ_TOKEN_TTL_S,
	);
	return {
		remote,
		token: minted.plaintext,
		revoke: async () => {
			await (await env.ARTIFACTS.get(name)).revokeToken(minted.id);
		},
	};
};

export class TartanSandbox extends Sandbox<Env> {
	readonly #jobs: JobRunner;
	readonly #git: ReturnType<typeof createSerializedGitExec>;
	readonly #selftest: ReturnType<typeof createSelftest>;
	/** The repository-config queue of a `cue:*` sandbox (null elsewhere). */
	readonly #cue: CueQueue | null;
	/** False without a container: container calls then fail at once. */
	readonly #available: boolean;

	constructor(ctx: DurableObjectState, env: Env) {
		const available = ctx.container !== undefined;
		const state = withContainer(ctx);
		super(state as ConstructorParameters<typeof Sandbox<Env>>[0], env);
		this.#available = available;
		const sql = state.storage.sql;
		const port: SandboxPort = {
			exec: (command, options) => this.#exec(command, options),
			startProcess: async (command, options) => {
				this.#requireContainer();
				const proc = await this.startProcess(command, {
					...(options?.env ? { env: { ...options.env } } : {}),
					...(options?.cwd ? { cwd: options.cwd } : {}),
					...(options?.processId ? { processId: options.processId } : {}),
					autoCleanup: false,
				}, SESSIONLESS);
				return { id: proc.id };
			},
			getProcess: async (id) => {
				this.#requireContainer();
				const proc = await this.getProcess(id, SESSIONLESS);
				return proc === null
					? null
					: { status: proc.status, exitCode: proc.exitCode ?? null };
			},
			killProcess: async (id) => {
				this.#requireContainer();
				await this.killProcess(id, undefined, SESSIONLESS);
			},
			streamLogs: async (id) => {
				this.#requireContainer();
				return parseSSEStream<LogEvent>(await this.streamProcessLogs(id));
			},
			destroy: () => this.#destroy(),
			setKeepAlive: (on) => this.setKeepAlive(on),
			scheduleWatchdog: async (delaySeconds) => {
				const at = Date.now() + delaySeconds * 1000;
				const row = sql.exec<{ v: string }>(
					"SELECT v FROM job_state WHERE k = 'watchdog'",
				).toArray()[0];
				if (row !== undefined && Number(row.v) > Date.now()) return;
				sql.exec(
					"INSERT INTO job_state (k, v) VALUES ('watchdog', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
					String(at),
				);
				await this.schedule(delaySeconds, "watchdog");
			},
			waitUntil: (work) => this.ctx.waitUntil(work),
		};
		this.#jobs = createJobRunner({ sql, port, sinks: envJobSinks(env) });
		this.#git = createSerializedGitExec({
			port: {
				exec: (command, options) => this.#exec(command, options),
				warm: async () => {
					await this.setKeepAlive(false);
					await this.setSleepAfter(WARM_SLEEP_AFTER);
				},
			},
		});
		this.#selftest = createSelftest({
			sql,
			exec: (command) => this.#exec(command, { timeoutMs: 120_000 }),
			destroy: () => this.#destroy(),
		});
		const role = cueRoleOf(state.id.name);
		if (role !== null) {
			// The evaluators never reach the network (the job is hermetic
			// through CUE_REGISTRY=none as well).
			this.enableInternet = false;
		}
		this.#cue = role === null ? null : createCueQueue({
			sql,
			role,
			sinks: envCueSinks(env),
			port: {
				available: () => this.#available,
				warm: () => this.ctx.container?.running === true,
				writeFile: async (path, content) => {
					this.#requireContainer();
					await this.writeFile(path, content, { sessionId: SESSIONLESS });
				},
				exec: (command, timeoutMs) => this.#exec(command, { timeoutMs }),
				waitUntil: (work) => this.ctx.waitUntil(work),
			},
		});
	}

	#requireContainer(): void {
		if (!this.#available) throw unavailable(CONTAINERS_UNAVAILABLE);
	}

	/** Nothing to destroy without a container, or when it is not running. */
	#destroy(): Promise<void> {
		return this.#available && this.ctx.container?.running === true
			? this.destroy()
			: Promise.resolve();
	}

	#exec(
		command: string,
		options?: {
			env?: Readonly<Record<string, string>>;
			cwd?: string;
			timeoutMs?: number;
		},
	): Promise<ExecOutput> {
		if (!this.#available) {
			return Promise.reject(unavailable(CONTAINERS_UNAVAILABLE));
		}
		return this.execWithSessionToken(command, SESSIONLESS, {
			...(options?.env ? { env: { ...options.env } } : {}),
			...(options?.cwd ? { cwd: options.cwd } : {}),
			...(options?.timeoutMs ? { timeout: options.timeoutMs } : {}),
		}).then((r) => ({
			exitCode: r.exitCode,
			stdout: r.stdout,
			stderr: r.stderr,
		}));
	}

	/** Checks the run's commit out once (`job:<runId>`). */
	async prepare(input: PrepareInput): Promise<ExecOutput> {
		return await this.#jobs.prepare(input);
	}

	/** Starts (or re-attaches to) one job; returns once its process started. */
	async runJob(input: RunJobInput): Promise<JobSnapshot> {
		return await this.#jobs.runJob(input);
	}

	jobState(jobId: string, attempt: number): JobSnapshot | null {
		return this.#jobs.jobState(jobId, attempt);
	}

	/** The poll fallback: finalizes exited jobs, enforces timeouts, re-attaches. */
	async reconcile(): Promise<JobSnapshot[]> {
		return await this.#jobs.reconcile();
	}

	/** Kills every job and destroys the container (finish, cancel, supersede, slot expiry). */
	async stopRun(): Promise<void> {
		await this.#jobs.stopRun();
	}

	/**
	 * The `Container.schedule()` callback: the 60 s watchdog. Clears
	 * its own marker first, so the pass may schedule the next one.
	 */
	async watchdog(): Promise<void> {
		this.ctx.storage.sql.exec("DELETE FROM job_state WHERE k = 'watchdog'");
		try {
			await this.#jobs.reconcile();
		} catch (error) {
			console.error("[tartan] watchdog failed", safeText(String(error)));
		}
	}

	/**
	 * One kernel git command (`GitExec` for `git:<repoId>`): argv only,
	 * serialized per sandbox, `tartan-git` by default, `tartan-push` after
	 * `pkill -u tartan-git`.
	 * Named `gitExec` because `Sandbox.exec(command)` is the SDK's own.
	 */
	async gitExec(
		argv: readonly string[],
		options?: GitExecOptions,
	): Promise<GitExecResult> {
		return await this.#git.exec(argv, options);
	}

	/** The deploy warm-up (`selftest`), rate-limited in this DO. */
	async selftest(): Promise<
		RunnerInfo | { limited: true; retryAfterMs: number }
	> {
		return await this.#selftest.run();
	}

	/** The last selftest result, without touching the container. */
	runnerInfo(): RunnerInfo | null {
		return this.#selftest.last();
	}

	/**
	 * Repository config (`cue:trunk`, `cue:preview:<k>`): enqueues one
	 * evaluation and returns at once; the envelope arrives through the job's
	 * sink. Single-flight by input key; previews are rate-limited.
	 */
	cueSubmit(job: CueJobInput): CueSubmitResult {
		if (this.#cue === null) {
			return {
				accepted: false,
				reason: "invalid",
				message: "this sandbox does not evaluate repository config",
			};
		}
		return this.#cue.submit(job);
	}

	/**
	 * Dev stages only (`TARTAN_STAGE ^dev`, `TARTAN_DEV_TOOLS=1`): one fixed
	 * probe of this evaluator sandbox under the queue's mutex
	 * (`src/kernel/runs/cueprobe.ts`).
	 */
	async cueProbe(input: CueProbeInput): Promise<CueProbeResult> {
		const cue = this.#cue;
		if (cue === null) throw invalid("not a repository-config evaluator");
		if (
			!/^dev/.test(this.env.TARTAN_STAGE) || this.env.TARTAN_DEV_TOOLS !== "1"
		) {
			throw notFound("no such probe");
		}
		this.#requireContainer();
		const sandbox = this.ctx.id.name ?? "";
		return await cue.exclusive(async () => {
			const warm = this.ctx.container?.running === true;
			const started = Date.now();
			let output: string | undefined;
			let result: CueProbeResult["result"];
			if (input.probe === "info" || input.probe === "net") {
				const out = await this.#exec(CUE_PROBE_COMMANDS[input.probe], {
					timeoutMs: 60_000,
				});
				output = safeText(`${out.stdout}${out.stderr}`).slice(0, 8192);
			} else {
				const limits = { ...DEFAULT_EVAL_LIMITS, ...(input.limits ?? {}) };
				const bundle = buildCueBundle(input.files ?? {});
				if (!bundle.ok) throw invalid(bundle.message);
				const id = `probe_${Date.now().toString(36)}`;
				await this.writeFile(cueBundlePath(id), bundle.json, {
					sessionId: SESSIONLESS,
				});
				const before = input.probe === "oom"
					? (await this.#exec(CUE_PROBE_COMMANDS.pid1, { timeoutMs: 30_000 }))
						.stdout.trim()
					: "";
				const out = await this.#exec(
					cueJobCommand(id, limits, {
						unboundedAddressSpace: input.probe === "oom",
					}),
					{ timeoutMs: CUE_EXEC_TIMEOUT_MS + limits.wallClockS * 1000 },
				);
				result = summarize(classifyCueJob(out.stdout, { limits }));
				if (input.probe === "oom") {
					// The OOM victim, and whether the control server's instance
					// survived it: read after the job, before `healthy`.
					try {
						const after = await this.#exec(CUE_PROBE_COMMANDS.victim, {
							timeoutMs: 30_000,
						});
						output = safeText(
							`pid1-start-before: ${before}\n${after.stdout}${after.stderr}`,
						).slice(0, 8192);
					} catch (error) {
						output = `pid1-start-before: ${before}\nvictim read failed: ${
							String(error).slice(0, 200)
						}`;
					}
				}
			}
			const ms = Date.now() - started;
			let healthy = false;
			try {
				healthy = (await this.#exec("true", { timeoutMs: 30_000 }))
					.exitCode === 0;
			} catch {
				healthy = false;
			}
			return {
				probe: input.probe,
				sandbox,
				ms,
				...(output === undefined ? {} : { output }),
				...(result === undefined ? {} : { result }),
				healthy,
				warm,
			};
		});
	}
}
