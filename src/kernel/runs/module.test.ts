import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import type { JobGraph, RunStatus } from "@tartan/contract";
import type { RunStatusK2 } from "../bus/contract.ts";
import { OUTBOX_RETRY_AFTER_MS } from "./module.ts";
import { LIVE_TOKEN } from "./testing/fakes.ts";
import { ciGraph, REPO, runsHarness } from "./testing/runs.ts";

Deno.test("start is idempotent on idemKey and writes the row before RUNS.create", async () => {
	const h = runsHarness();
	const a = await h.runs.start({
		graph: ciGraph(),
		idemKey: "i:c1:sha:1",
		requestedBy: "i_01k6aaaaaaaaaaaaaaaaaaaaab",
	});
	const b = await h.runs.start({
		graph: ciGraph(),
		idemKey: "i:c1:sha:1",
		requestedBy: "i_01k6aaaaaaaaaaaaaaaaaaaaab",
	});
	equal(a.runId, b.runId);
	equal(h.calls.created.length, 1);
	const row = h.internal.runSync(a.runId)!;
	equal(row.instance_id, `run-${REPO}-${a.runId}`);
	equal(row.instance_created, 1);
	const status = (await h.runs.get(a.runId))! as RunStatus & RunStatusK2;
	equal(status.state, "queued");
	deepEqual(status.jobs.map((j) => [j.jobId, j.state]), [
		["install", "pending"],
		["lint", "pending"],
		["test", "pending"],
	]);
	deepEqual(h.events.appended.map((e) => e.type), [
		"run.started",
		"run.dispatched",
	]);
	equal(h.events.appended[0].node, REPO);
	deepEqual(h.events.appended[0].subject, { kind: "change", id: "c1" });
	deepEqual(h.events.appended[0].data, {
		runId: a.runId,
		state: "queued",
		kind: "ci",
		transport: "local",
		priority: "change",
		subject: { kind: "change", id: "c1" },
	});
	const dispatched = h.events.appended[1].data as Record<string, unknown>;
	equal(dispatched.via, "local");
	equal(dispatched.lagMs, 0);
	equal(status.transport, "local");
	equal(status.via, "local");
	equal(row.via, "local");
});

Deno.test("a failed RUNS.create is retried by the outbox timer in a quiet repo", async () => {
	const h = runsHarness();
	h.failNextCreates(1);
	const { runId } = await h.runs.start({
		graph: ciGraph(),
		idemKey: "k1",
		requestedBy: "kernel",
	});
	equal(h.internal.runSync(runId)!.instance_created, 0);
	const due = h.internal.runSync(runId)!.dispatch_due_at!;
	equal(due, h.clock.now() + OUTBOX_RETRY_AFTER_MS);
	equal(h.timers.get("outbox"), due);
	// No further start: the timer alone creates the instance.
	h.clock.advance(OUTBOX_RETRY_AFTER_MS);
	await h.fireOutbox();
	equal(h.internal.runSync(runId)!.instance_created, 1);
	equal(h.internal.runSync(runId)!.via, "local");
	equal(
		h.events.appended.filter((e) => e.type === "run.dispatched").length,
		1,
	);
	// Nothing is left to dispatch, so the timer is not re-armed.
	equal(h.timers.get("outbox") ?? null, null);
	// Same key again: idempotent, no second instance or event.
	await h.runs.start({
		graph: ciGraph(),
		idemKey: "k1",
		requestedBy: "kernel",
	});
	equal(h.calls.created.length, 1);
});

Deno.test("a local run's inline dispatch retried by the same key", async () => {
	const h = runsHarness();
	h.failNextCreates(1);
	const { runId } = await h.runs.start({
		graph: ciGraph(),
		idemKey: "k1",
		requestedBy: "kernel",
	});
	equal(h.internal.runSync(runId)!.instance_created, 0);
	await h.runs.start({
		graph: ciGraph(),
		idemKey: "k1",
		requestedBy: "kernel",
	});
	equal(h.internal.runSync(runId)!.instance_created, 1);
});

Deno.test("git runs and kernel subjects are kernel-only (K11)", async () => {
	const h = runsHarness();
	const git = ciGraph({
		kind: "git",
		subject: { kind: "kernel", id: "repair-1" },
		jobs: [{ id: "push", argv: ["git", "push"] }],
	});
	await rejects(
		h.runs.start({ graph: git, idemKey: "g", requestedBy: "i_x" }),
		/git runs are kernel-only/,
	);
	const ok1 = await h.runs.start({
		graph: git,
		idemKey: "g",
		requestedBy: "kernel",
	});
	ok(ok1.runId);
	await rejects(
		h.runs.start({
			graph: { ...ciGraph(), jobs: [] } as unknown as JobGraph,
			idemKey: "bad",
			requestedBy: "kernel",
		}),
		/invalid job graph/,
	);
});

Deno.test("a newer run in the same group supersedes and stops the older one", async () => {
	const h = runsHarness();
	const graph = ciGraph({ concurrencyGroup: "change:c1" });
	const first = await h.runs.start({
		graph,
		idemKey: "r1",
		requestedBy: "kernel",
	});
	await h.runs.setRunState(first.runId, "running");
	await h.runs.setJobState(first.runId, "install", { state: "running" });
	const second = await h.runs.start({
		graph,
		idemKey: "r2",
		requestedBy: "kernel",
	});
	await h.settle();
	equal((await h.runs.get(first.runId))!.state, "superseded");
	equal((await h.runs.get(second.runId))!.state, "queued");
	deepEqual(h.calls.stopped, [first.runId]);
	deepEqual(h.calls.woken, [{
		instanceId: `run-${REPO}-${first.runId}`,
		type: "job-install-a1",
		state: "cancelled",
	}]);
	const firstJobs = (await h.runs.get(first.runId))!.jobs;
	deepEqual(firstJobs.map((j) => j.state), ["cancelled", "skipped", "skipped"]);
});

Deno.test("cancel stops the sandbox before it returns, and terminal states are sticky", async () => {
	const h = runsHarness();
	const { runId } = await h.runs.start({
		graph: ciGraph(),
		idemKey: "c",
		requestedBy: "kernel",
	});
	await h.runs.setRunState(runId, "running");
	await h.runs.setJobState(runId, "install", { state: "running" });
	await h.runs.cancel(runId, "u_01k6aaaaaaaaaaaaaaaaaaaaac");
	deepEqual(h.calls.stopped, [runId]);
	equal(h.calls.woken.length, 1);
	const status = (await h.runs.get(runId))!;
	equal(status.state, "cancelled");
	// A late finalize from the sandbox cannot resurrect the job, but attaches the log.
	await h.runs.setJobState(runId, "install", {
		state: "success",
		exitCode: 0,
		logKey: "logs/x.log",
	});
	await h.runs.setRunState(runId, "success");
	const after = (await h.runs.get(runId))!;
	equal(after.state, "cancelled");
	equal(after.jobs[0].state, "cancelled");
	equal(h.internal.runSync(runId)!.state, "cancelled");
	const completed = h.events.appended.filter((e) => e.type === "run.completed");
	equal(completed.length, 1);
	deepEqual(completed[0].actor, {
		kind: "user",
		id: "u_01k6aaaaaaaaaaaaaaaaaaaaac",
	});
	// Cancel again is a no-op apart from the (idempotent) stop.
	await h.runs.cancel(runId, "u_01k6aaaaaaaaaaaaaaaaaaaaac");
	equal(
		h.events.appended.filter((e) => e.type === "run.completed").length,
		1,
	);
});

Deno.test("job transitions append job.started / job.completed once each (K3)", async () => {
	const h = runsHarness();
	const { runId } = await h.runs.start({
		graph: ciGraph(),
		idemKey: "j",
		requestedBy: "kernel",
	});
	await h.runs.setRunState(runId, "running");
	await h.runs.setJobState(runId, "install", { state: "running" });
	await h.runs.setJobState(runId, "install", { state: "running" });
	h.clock.advance(1500);
	await h.runs.setJobState(runId, "install", {
		state: "success",
		exitCode: 0,
		logKey: "logs/k",
	});
	await h.runs.setJobState(runId, "lint", { state: "skipped" });
	await rejects(
		h.runs.setJobState(runId, "nope", { state: "running" }),
		/no job/,
	);
	await rejects(
		h.runs.setJobState(runId, "test", { state: "pending" }),
		/cannot go back/,
	);
	await h.runs.setRunState(runId, "failure");
	deepEqual(h.events.appended.map((e) => e.type), [
		"run.started",
		"run.dispatched",
		"run.started",
		"job.started",
		"job.completed",
		"job.completed",
		"job.completed",
		"run.completed",
	]);
	const done = h.events.appended[4].data as Record<string, unknown>;
	equal(done.durationMs, 1500);
	equal(done.state, "success");
	const status = (await h.runs.get(runId))!;
	deepEqual(status.jobs.map((j) => j.state), ["success", "skipped", "skipped"]);
	equal(status.jobs[0].exitCode, 0);
});

Deno.test("jobLog keeps a redacted 8 KB tail; logs reads R2 once the job ended", async () => {
	const h = runsHarness();
	const { runId } = await h.runs.start({
		graph: ciGraph(),
		idemKey: "l",
		requestedBy: "kernel",
	});
	await h.runs.setJobState(runId, "install", { state: "running" });
	await h.runs.jobLog(runId, "install", `token ${LIVE_TOKEN}\n`);
	await h.runs.jobLog(runId, "install", "x".repeat(9000));
	const tail = await h.runs.logs(runId, "install");
	equal(tail.length, 8192);
	await h.runs.jobLog(runId, "test", `t ${LIVE_TOKEN}\n`);
	const testTail = await h.runs.logs(runId, "test", 100);
	equal(testTail.includes("expires"), false);
	ok(testTail.includes("art_v2_<redacted>"));

	h.logs.set("logs/full", "line 1\nline 2\n");
	await h.runs.setJobState(runId, "install", {
		state: "success",
		exitCode: 0,
		logKey: "logs/full",
	});
	equal(await h.runs.logs(runId, "install", 7), "line 2\n");
});

Deno.test("list pages newest first, by subject", async () => {
	const h = runsHarness();
	const ids: string[] = [];
	for (let i = 0; i < 5; i++) {
		h.clock.advance(10);
		ids.push(
			(await h.runs.start({
				graph: ciGraph({
					subject: { kind: "change", id: i % 2 ? "odd" : "even" },
				}),
				idemKey: `p${i}`,
				requestedBy: "kernel",
			})).runId,
		);
	}
	const page1 = await h.runs.list({ limit: 2 });
	deepEqual(page1.runs.map((r) => r.runId), [ids[4], ids[3]]);
	const page2 = await h.runs.list({ limit: 2, cursor: page1.cursor });
	deepEqual(page2.runs.map((r) => r.runId), [ids[2], ids[1]]);
	const page3 = await h.runs.list({ limit: 2, cursor: page2.cursor });
	deepEqual(page3.runs.map((r) => r.runId), [ids[0]]);
	equal(page3.cursor, undefined);
	const odd = await h.runs.list({ subject: { kind: "change", id: "odd" } });
	deepEqual(odd.runs.map((r) => r.runId), [ids[3], ids[1]]);
});
