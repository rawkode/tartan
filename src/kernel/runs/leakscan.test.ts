// / K11 leak scan: a full simulated run (driver + RepoDO runs module +
// job runner) whose jobs and git commands print their tokens, then a scan of
// everything the run persisted or returned: Workflow params, step outputs,
// RepoDO and sandbox storage, events, R2 objects and the logs API. None may
// hold an `art_v<n>_` token or an unredacted capability path.

import { equal, ok } from "node:assert/strict";
import type { JobGraph } from "@tartan/contract";
import { driveRun } from "./driver.ts";
import { createJobRunner, type JobSinks } from "./jobs.ts";
import {
	dumpDatabase,
	fakeDoState,
	fakeSandbox,
	fakeTokens,
} from "./testing/fakes.ts";
import { ciGraph, REPO, runsHarness } from "./testing/runs.ts";
import { fakeStep } from "./testing/step.ts";

const TOKEN_LEAK = /art_v[0-9]+_(?!<redacted>)/;
const CAP_LEAK = /\/-\/cap\/(?!<redacted>)/;
const CAP_PATH =
	"/-/cap/v1/1791234567/ln_01k6aaaaaaaaaaaaaaaaaaaaaa/abcdef12/0123456789abcdef0123456789abcdef/r.git";

const scenario = async (graph: JobGraph, requestedBy: string) => {
	const h = runsHarness();
	const sandbox = fakeDoState();
	const box = fakeSandbox({
		// git prints the auth header it was given (GIT_TRACE_CURL style).
		exec: (command, options) => ({
			exitCode: 0,
			stdout: command.includes("git fetch")
				? `> ${options?.env?.GIT_CONFIG_VALUE_2 ?? ""}\nfetched ${CAP_PATH}\n`
				: "",
			stderr: "",
		}),
	});
	const tokens = fakeTokens();
	const r2 = new Map<string, string>();
	const steps = fakeStep({ onWait: () => box.settle(30) });
	const sinks: JobSinks = {
		jobLog: (_r, run, job, chunk) => h.runs.jobLog(run, job, chunk),
		setJobState: (_r, run, job, update) => h.runs.setJobState(run, job, update),
		putLog: (key, text) => {
			r2.set(key, text);
			return Promise.resolve();
		},
		notify: (_i, type, payload) => {
			steps.send(type, payload);
			return Promise.resolve();
		},
		mintToken: (source, scope) =>
			Promise.resolve(tokens.mint(`r-${source.repoId}`, scope)),
	};
	const runner = createJobRunner({
		sql: sandbox.sql,
		port: box.port,
		sinks,
		sleep: () => Promise.resolve(),
		flushMs: 5,
	});
	const { runId } = await h.runs.start({ graph, idemKey: "leak", requestedBy });
	const result = await driveRun(steps.step, {
		runs: h.runs,
		slots: {
			acquire: (kind, id) => Promise.resolve({ slotKey: `${kind}:${id}` }),
			release: () => Promise.resolve(),
			recordUsage: () => Promise.resolve(),
		},
		sandbox: {
			prepare: (input) => runner.prepare(input),
			runJob: async (input) => {
				const snapshot = await runner.runJob(input);
				const proc = box.procs.get(snapshot.processId!)!;
				// A hostile job prints its whole environment, a token and a cap path.
				box.emit(
					snapshot.processId!,
					{ type: "stdout", data: `env ${JSON.stringify(proc.env)}\n` },
					{ type: "stderr", data: `oops ${CAP_PATH}\n` },
					{ type: "exit", exitCode: 0 },
				);
				return snapshot;
			},
			reconcile: () => runner.reconcile(),
			stopRun: () => runner.stopRun(),
		},
	}, {
		repoId: REPO,
		runId,
		instanceId: `run-${REPO}-${runId}`,
		graph,
		requestedBy,
		waitMode: "event",
	});
	await box.settle(30);
	const status = (await h.runs.get(runId))!;
	const apiLogs = await Promise.all(
		status.jobs.map((j) => h.runs.logs(runId, j.jobId, 1024 * 1024)),
	);
	const sinks_ = [
		["workflow params", JSON.stringify(h.calls.created.map((c) => c.params))],
		["step outputs", JSON.stringify(steps.outputs)],
		["result", JSON.stringify(result)],
		["RepoDO storage", dumpDatabase(h.db)],
		["sandbox storage", dumpDatabase(sandbox.db)],
		["events", JSON.stringify(h.events.appended)],
		["R2", JSON.stringify([...r2.entries()])],
		["logs API", JSON.stringify(apiLogs)],
	] as const;
	return { result, tokens, sinks: sinks_, r2, box };
};

const assertClean = (
	sinks: readonly (readonly [string, string])[],
	plaintexts: readonly string[],
) => {
	for (const [name, text] of sinks) {
		equal(TOKEN_LEAK.test(text), false, `${name} holds an art_v token`);
		equal(CAP_LEAK.test(text), false, `${name} holds a capability path`);
		for (const token of plaintexts) {
			equal(text.includes(token.split("?")[0]), false, `${name} holds a token`);
		}
	}
};

Deno.test("a CI run that prints its env and a capability path leaks nothing", async () => {
	const s = await scenario(ciGraph(), "i_01k6aaaaaaaaaaaaaaaaaaaaab");
	equal(s.result.state, "success");
	equal(s.tokens.minted.length, 1, "one read token, for the checkout");
	equal(s.tokens.minted[0].scope, "read");
	ok(s.tokens.minted.every((t) => t.revoked));
	ok(s.r2.size === 3);
	ok([...s.r2.values()].every((log) => log.includes("/-/cap/<redacted>/")));
	assertClean(s.sinks, s.tokens.minted.map((t) => t.token));
});

Deno.test("a kernel git run's write token stays out of every sink (K11)", async () => {
	const graph = ciGraph({
		kind: "git",
		subject: { kind: "kernel", id: "repair-adv" },
		jobs: [
			{ id: "fetch", argv: ["git", "fetch", "origin"] },
			{ id: "push", needs: ["fetch"], argv: ["git", "push", "origin", "x:y"] },
		],
	});
	const s = await scenario(graph, "kernel");
	equal(s.result.state, "success");
	const writes = s.tokens.minted.filter((t) => t.scope === "write");
	equal(writes.length, 2, "one write token per git job");
	ok(writes.every((t) => t.revoked));
	const printed = [...s.r2.values()].join("");
	ok(printed.includes("art_v2_<redacted>"), "the printed token was redacted");
	assertClean(s.sinks, s.tokens.minted.map((t) => t.token));
});
