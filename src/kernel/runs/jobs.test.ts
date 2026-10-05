import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import {
	type GitSource,
	type JobSpec,
	JobSpecSchema,
	type JobState,
} from "@tartan/contract";
import {
	CHECKOUT_DIR,
	createJobRunner,
	jobProcessId,
	type JobSinks,
	STALE_START_MS,
} from "./jobs.ts";
import { KILL_CONTENT_UID } from "./shell.ts";
import {
	fakeDoState,
	fakeSandbox,
	fakeTokens,
	LIVE_TOKEN,
} from "./testing/fakes.ts";

const REPO = "01k6aaaaaaaaaaaaaaaaaaaaaa";
const RUN = "01k6bbbbbbbbbbbbbbbbbbbbbb";
const LANE = "ln_01k6cccccccccccccccccccccc";
const SHA = "b".repeat(40);
const INSTANCE = `run-${REPO}-${RUN}`;

const spec = (input: Partial<JobSpec> & { id: string }): JobSpec =>
	JobSpecSchema.parse({ run: "pnpm test", ...input });

/** The repo a source lives in, as RepoDO resolves it (canonical or lane repo). */
const repoOf = (source: GitSource): string =>
	source.laneId === undefined
		? `r-${source.repoId}`
		: `l-${source.repoId}-${source.laneId.slice(3)}`;

export const sinksHarness = () => {
	const tokens = fakeTokens();
	const log: { chunk: string; at: number }[] = [];
	const states: { jobId: string; state: JobState; exitCode?: number }[] = [];
	const notified: { type: string; state: JobState }[] = [];
	const r2 = new Map<string, string>();
	const sinks: JobSinks = {
		jobLog: (_repo, _run, _job, chunk) => {
			log.push({ chunk, at: Date.now() });
			return Promise.resolve();
		},
		setJobState: (_repo, _run, jobId, update) => {
			states.push({ jobId, ...update });
			return Promise.resolve();
		},
		putLog: (key, text) => {
			r2.set(key, text);
			return Promise.resolve();
		},
		notify: (_instance, type, payload) => {
			notified.push({ type, state: payload.state });
			return Promise.resolve();
		},
		mintToken: (source, scope) =>
			Promise.resolve(tokens.mint(repoOf(source), scope)),
	};
	return { sinks, tokens, log, states, notified, r2 };
};

const setup = (options: Parameters<typeof fakeSandbox>[0] = {}) => {
	const state = fakeDoState();
	const box = fakeSandbox(options);
	const kernel = sinksHarness();
	let now = 1_790_000_000_000;
	const make = () =>
		createJobRunner({
			sql: state.sql,
			port: box.port,
			sinks: kernel.sinks,
			now: () => now,
			sleep: () => Promise.resolve(),
			flushMs: 10,
		});
	return {
		state,
		box,
		kernel,
		runner: make(),
		/** A new runner over the same storage: the DO after an eviction. */
		restart: make,
		advance: (ms: number) => {
			now += ms;
		},
	};
};

const ctx = {
	repoId: REPO,
	runId: RUN,
	instanceId: INSTANCE,
	kind: "ci" as const,
	requestedBy: "i_x",
};

Deno.test("checkout fetches the SHA with a read token for exactly the lane's repo, then revokes it", async () => {
	const t = setup();
	const out = await t.runner.prepare({
		...ctx,
		source: { repoId: REPO, laneId: LANE },
		sha: SHA,
	});
	equal(out.exitCode, 0);
	equal(t.box.keepAlive, true, "job sandboxes keep alive until destroy");
	const fetch = t.box.execs.find((e) => e.command.includes("git fetch"))!;
	ok(fetch.command.startsWith("setpriv --reuid=tartan-git"));
	ok(fetch.command.includes(SHA));
	const [minted] = t.kernel.tokens.minted;
	equal(minted.repo, `l-${REPO}-${LANE.slice(3)}`);
	equal(minted.scope, "read");
	const env = fetch.options!.env!;
	equal(env.GIT_CONFIG_VALUE_2, `Authorization: Bearer ${minted.token}`);
	ok(env.GIT_CONFIG_KEY_2.includes(`/l-${REPO}-`));
	// FakeArtifacts semantics: the lane token never authorizes the canonical repo.
	equal(t.kernel.tokens.allows(minted.token, `r-${REPO}`, "read"), false);
	equal(minted.revoked, true);
	equal(fetch.command.includes(minted.token), false, "never in argv");
});

Deno.test("a cold start's 500 is retried (3 tries, 2 s backoff)", async () => {
	const t = setup({ failFirstCalls: 2 });
	equal(
		(await t.runner.prepare({ ...ctx, source: { repoId: REPO }, sha: SHA }))
			.exitCode,
		0,
	);
	const t3 = setup({ failFirstCalls: 3 });
	await rejects(
		t3.runner.prepare({ ...ctx, source: { repoId: REPO }, sha: SHA }),
		/Default session initialization was invalidated/,
	);
});

Deno.test("runJob is idempotent across retries and re-attaches after an eviction", async () => {
	const t = setup();
	const input = {
		...ctx,
		job: spec({ id: "test", cwd: "apps/web" }),
		attempt: 1,
		timeoutMs: 60_000,
	};
	const first = await t.runner.runJob(input);
	const again = await t.runner.runJob(input);
	equal(first.processId, again.processId);
	equal(t.box.procs.size, 1);
	const proc = t.box.procs.get(first.processId!)!;
	ok(proc.command.startsWith("setpriv --reuid=tartan-git"));
	equal(proc.cwd, `${CHECKOUT_DIR}/apps/web`);
	equal(
		Object.keys(proc.env).some((k) => k.startsWith("GIT_CONFIG")),
		false,
		"CI jobs get no token at all",
	);
	t.box.emit(first.processId!, { type: "stdout", data: "one\n" });
	await t.box.settle();
	await new Promise((r) => setTimeout(r, 30));

	// The DO is evicted: the pump is gone; a retried start step re-attaches.
	t.box.dropStreams();
	await t.box.settle();
	const restarted = t.restart();
	const third = await restarted.runJob(input);
	equal(third.processId, first.processId);
	equal(t.box.procs.size, 1, "no second process");
	t.box.emit(first.processId!, { type: "stdout", data: "two\n" }, {
		type: "exit",
		exitCode: 0,
	});
	await t.box.settle();
	const text = [...t.kernel.r2.values()][0];
	equal(text, "one\ntwo\n", "replayed output is not logged twice");
	deepEqual(t.kernel.states.at(-1), {
		jobId: "test",
		state: "success",
		exitCode: 0,
		logKey: `logs/${REPO}/${RUN}/test.log`,
	});
	deepEqual(t.kernel.notified, [{ type: "job-test-a1", state: "success" }]);
	equal(restarted.jobState("test", 1)!.phase, "done");
});

Deno.test("logs are redacted line by line, flushed live and archived on exit", async () => {
	const t = setup();
	const { processId } = await t.runner.runJob({
		...ctx,
		job: spec({ id: "build" }),
		attempt: 1,
		timeoutMs: 60_000,
	});
	const line = `push with ${LIVE_TOKEN} done\n`;
	const cut = line.indexOf("expires");
	const emittedAt = Date.now();
	t.box.emit(processId!, { type: "stdout", data: line.slice(0, cut) });
	t.box.emit(processId!, { type: "stdout", data: line.slice(cut) });
	t.box.emit(processId!, { type: "stderr", data: "warn\n" });
	await t.box.settle();
	await new Promise((r) => setTimeout(r, 40));
	ok(t.kernel.log.length > 0, "flushed before the job ended");
	ok(t.kernel.log[0].at - emittedAt < 2_000, "live within 2 s");
	t.box.emit(processId!, { type: "exit", exitCode: 3 });
	await t.box.settle();
	const archived = t.kernel.r2.get(`logs/${REPO}/${RUN}/build.log`)!;
	const live = t.kernel.log.map((l) => l.chunk).join("");
	for (const text of [archived, live]) {
		equal(text.includes("expires="), false);
		ok(text.includes("art_v2_<redacted>"));
	}
	ok(archived.includes("warn\n"));
	equal(t.kernel.states.at(-1)!.state, "failure");
	equal(t.kernel.states.at(-1)!.exitCode, 3);
});

Deno.test("kernel git jobs get a write token after pkill, as tartan-push; others are refused (K11)", async () => {
	const t = setup();
	const git = {
		...ctx,
		kind: "git" as const,
		requestedBy: "kernel",
		job: spec({
			id: "push",
			run: undefined,
			argv: ["git", "push", "origin", "x"],
		}),
		attempt: 1,
		timeoutMs: 60_000,
	};
	const { processId } = await t.runner.runJob(git);
	const pkill = t.box.execs.findIndex((e) => e.command === KILL_CONTENT_UID);
	ok(pkill !== -1, "pkill -u tartan-git ran first");
	const proc = t.box.procs.get(processId!)!;
	ok(proc.command.startsWith("setpriv --reuid=tartan-push"));
	const [minted] = t.kernel.tokens.minted;
	deepEqual([minted.repo, minted.scope], [`r-${REPO}`, "write"]);
	equal(proc.env.GIT_CONFIG_VALUE_2, `Authorization: Bearer ${minted.token}`);
	t.box.emit(processId!, { type: "exit", exitCode: 0 });
	await t.box.settle();
	equal(minted.revoked, true, "revoked when the job ended");

	// The next job's env carries nothing from the previous exec.
	const next = await t.runner.runJob({
		...ctx,
		job: spec({ id: "after" }),
		attempt: 1,
		timeoutMs: 60_000,
	});
	const nextEnv = t.box.procs.get(next.processId!)!.env;
	equal(JSON.stringify(nextEnv).includes(minted.token), false);

	await rejects(
		t.runner.runJob({
			...git,
			requestedBy: "i_x",
			job: spec({ id: "p2", run: undefined, argv: ["git", "push"] }),
		}),
		/kernel git jobs only/,
	);
	await rejects(
		t.runner.runJob({
			...ctx,
			job: spec({ id: "esc", cwd: "../.." }),
			attempt: 1,
			timeoutMs: 1,
		}),
		/inside the checkout/,
	);
});

Deno.test("the watchdog finalizes silent exits and lost processes", async () => {
	const t = setup();
	const a = await t.runner.runJob({
		...ctx,
		job: spec({ id: "a" }),
		attempt: 1,
		timeoutMs: 60_000,
	});
	const b = await t.runner.runJob({
		...ctx,
		job: spec({ id: "b" }),
		attempt: 1,
		timeoutMs: 60_000,
	});
	t.box.exitSilently(a.processId!, 0);
	t.box.procs.delete(b.processId!);
	const snapshots = await t.runner.reconcile();
	deepEqual(snapshots.map((s) => [s.jobId, s.phase, s.outcome]), [
		["a", "done", "success"],
		["b", "done", "failure"],
	]);
	ok(t.kernel.r2.get(`logs/${REPO}/${RUN}/b.log`)!.includes("process lost"));
	equal(t.box.destroyed, 0);
});

Deno.test("a job over its timeout is killed, finalized, its siblings cancelled and the sandbox destroyed", async () => {
	const t = setup();
	const slow = await t.runner.runJob({
		...ctx,
		job: spec({ id: "slow" }),
		attempt: 1,
		timeoutMs: 5_000,
	});
	const other = await t.runner.runJob({
		...ctx,
		job: spec({ id: "other" }),
		attempt: 1,
		timeoutMs: 600_000,
	});
	t.advance(5_001);
	await t.runner.reconcile();
	await t.box.settle();
	equal(t.box.procs.get(slow.processId!)!.status, "killed");
	equal(t.box.procs.get(other.processId!)!.status, "killed");
	const finals = Object.fromEntries(
		t.kernel.states.map((s) => [s.jobId, s.state]),
	);
	deepEqual(finals, { slow: "failure", other: "cancelled" });
	const slowState = t.kernel.states.find((s) => s.jobId === "slow")!;
	equal(
		slowState.exitCode,
		undefined,
		"the timeout verdict wins over exit 143",
	);
	ok(
		t.kernel.r2.get(`logs/${REPO}/${RUN}/slow.log`)!.includes(
			"timeout after 5 s",
		),
	);
	equal(t.box.destroyed, 1);
	deepEqual(t.kernel.notified.map((n) => n.type).sort(), [
		"job-other-a1",
		"job-slow-a1",
	]);
});

Deno.test("stopRun kills, finalizes as cancelled and destroys; a stale start is failed", async () => {
	const t = setup();
	await t.runner.runJob({
		...ctx,
		job: spec({ id: "x" }),
		attempt: 1,
		timeoutMs: 60_000,
	});
	await t.runner.stopRun();
	await t.box.settle();
	equal(t.box.destroyed, 1);
	equal(t.kernel.states.at(-1)!.state, "cancelled");

	const s = setup();
	s.state.sql.exec(
		"CREATE TABLE IF NOT EXISTS job_state (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
	);
	s.state.sql.exec(
		"INSERT INTO job_state (k, v) VALUES ('job:y:a1', ?)",
		JSON.stringify({
			...ctx,
			jobId: "y",
			attempt: 1,
			phase: "starting",
			startedAt: 1_790_000_000_000,
			deadline: 0,
			seen: { stdout: 0, stderr: 0 },
			logSeq: 0,
		}),
	);
	s.advance(STALE_START_MS + 1);
	await s.runner.reconcile();
	equal(s.kernel.states.at(-1)!.state, "failure");
});

Deno.test("a start whose answer was lost after the process launched never starts a second copy (retry, step retry, watchdog)", async () => {
	const t = setup();
	const input = {
		...ctx,
		job: spec({ id: "build" }),
		attempt: 1,
		timeoutMs: 60_000,
	};
	const realStart = t.box.port.startProcess;
	const realGet = t.box.port.getProcess;
	// The launch happens, its answer is lost (the RPC disconnects).
	let lose = 1;
	t.box.port.startProcess = async (command, opts) => {
		const out = await realStart(command, opts);
		if (lose-- > 0) throw new Error("rpc disconnected");
		return out;
	};
	const first = await t.runner.runJob(input);
	equal(t.box.procs.size, 1, "the in-step retry found the launched process");
	equal(first.phase, "running");
	equal(first.processId, jobProcessId(RUN, "build", 1));

	// The whole start step fails after the launch (lookups fail too), and the
	// Workflow retries the step: the retry adopts the process.
	const second = { ...input, job: spec({ id: "lint" }) };
	lose = 1;
	t.box.port.getProcess = () => Promise.reject(new Error("rpc disconnected"));
	await rejects(t.runner.runJob(second));
	equal(t.box.procs.size, 2);
	t.box.port.getProcess = realGet;
	const adopted = await t.runner.runJob(second);
	equal(adopted.phase, "running");
	equal(adopted.processId, jobProcessId(RUN, "lint", 1));
	equal(t.box.procs.size, 2, "no second copy of lint");

	// A record stuck in `starting` whose process exists is watched, not failed.
	const third = { ...input, job: spec({ id: "docs" }) };
	lose = 1;
	t.box.port.getProcess = () => Promise.reject(new Error("rpc disconnected"));
	await rejects(t.runner.runJob(third));
	t.box.port.getProcess = realGet;
	t.advance(STALE_START_MS + 1);
	await t.runner.reconcile();
	equal(
		t.kernel.states.some((s) => s.jobId === "docs" && s.state === "failure"),
		false,
	);
	equal(t.box.procs.size, 3);
	t.box.emit(jobProcessId(RUN, "docs", 1), { type: "exit", exitCode: 0 });
	await t.box.settle();
	await new Promise((r) => setTimeout(r, 30));
	await t.runner.reconcile();
	equal(
		t.kernel.states.filter((s) => s.jobId === "docs").at(-1)?.state,
		"success",
	);
});
