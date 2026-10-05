// tartan.ci acceptance (K13, K14): plan on submit/revise from the base on
// trunk, affected-only jobs, result cache by input hash, land testing round
// trip echoing (attempt, candidateSha), statuses, push triggers, tools, slots,
// context.

import {
	deepStrictEqual,
	equal,
	notEqual,
	ok,
	rejects,
} from "node:assert/strict";
import { validateUi } from "@tartan/contract";
import { makeEvent } from "@tartan/testkit";
import * as ciModule from "../../../extensions/ci/src/index.ts";
import {
	AGENT,
	batch,
	change,
	CI_INST,
	createFlow,
	lane,
	REPO,
	USER,
} from "./flow.ts";
import {
	DEMO_GLOBAL,
	DEMO_PIPELINE,
	DEMO_PROJECTS,
	DEMO_TARTAN,
	PNPM_REPO,
	tartanCue,
	withFiles,
	without,
} from "./repo.ts";

const BASE_FILES = withFiles(PNPM_REPO, { "tartan.cue": DEMO_TARTAN });
const API_EDIT = {
	"services/api/src/middleware/limit.ts": "export const limit = 42;\n",
};
const WEB_EDIT = { "apps/web/src/main.ts": "import 'shared'; // banner\n" };

Deno.test("ci: submit plans only the affected project's jobs, from the base pipeline", async () => {
	const f = createFlow();
	const base = f.world.commit(BASE_FILES);
	const head = f.world.commit(withFiles(BASE_FILES, API_EDIT));
	const C = change("k");
	await f.submit({ changeId: C, laneId: lane("1"), head, base });

	equal(f.starts.length, 1);
	const run = f.starts[0].graph;
	deepStrictEqual(run.jobs.map((j) => j.id), [
		"install",
		"lint-api",
		"test-api",
	]);
	equal(run.sha, head);
	deepStrictEqual(run.source, { repoId: REPO, laneId: lane("1") });
	deepStrictEqual(run.subject, { kind: "change", id: C });
	equal(run.concurrencyGroup, `change:${C}`);
	equal(run.idemKey, `change:${C}:${head}:g1`);
	equal(run.image, "tartan-runner");
	ok(run.jobs.every((j) => /^[0-9a-f]{64}$/.test(j.inputHash ?? "")));
	// K13: every policy read is at the base, never the lane head: the
	// pipeline is repo policy read through caps.repo.policy.
	const reads = f.calls(f.ci, "repo.policy");
	ok(reads.length > 0);
	ok(
		reads.every((c) => c.args[1] === base),
		JSON.stringify(reads.map((c) => c.args[1])),
	);
	equal(f.calls(f.ci, "repo.readFile").length, 0);
	ok(f.calls(f.ci, "repo.projectGraph").every((c) => c.args[1] === base));
	// Pending statuses for every context.
	deepStrictEqual(
		f.emitted(f.ci, "checks.updated").map((e) =>
			(e.data as { context: string; state: string }).context
		),
		["install", "lint:api", "test:api"],
	);

	await f.finish("run-1");
	const done = f.emitted(f.ci, "checks.completed");
	equal(done.length, 1);
	deepStrictEqual(done[0].data, {
		subject: { kind: "change", id: C },
		sha: head,
		state: "success",
		contexts: [
			{ context: "install", state: "success" },
			{ context: "lint:api", state: "success" },
			{ context: "test:api", state: "success" },
		],
		cached: false,
	});
});

Deno.test("ci: a failing required job fails the change; an optional one does not", async () => {
	const f = createFlow();
	const base = f.world.commit(BASE_FILES);
	const head = f.world.commit(withFiles(BASE_FILES, API_EDIT));
	await f.submit({ changeId: change("k"), laneId: lane("1"), head, base });
	await f.finish("run-1", { "lint-api": "failure" }, "failure");
	equal(
		(f.emitted(f.ci, "checks.completed")[0].data as { state: string }).state,
		"success",
	);
	const head2 = f.world.commit(withFiles(BASE_FILES, {
		"services/api/src/middleware/limit.ts": "export const limit = 43;\n",
	}));
	await f.submit({
		changeId: change("m"),
		laneId: lane("2"),
		head: head2,
		base,
	});
	await f.finish("run-2", { "test-api": "failure" });
	const failed = f.emitted(f.ci, "checks.completed")[1].data as {
		state: string;
		contexts: { context: string; state: string }[];
	};
	equal(failed.state, "failure");
	deepStrictEqual(
		failed.contexts.find((c) => c.context === "test:api"),
		{ context: "test:api", state: "failure" },
	);
	// The author and the user it acts for hear about it.
	deepStrictEqual(
		f.ci.recorder.notices.map((n) => n.principal).sort(),
		[AGENT, USER].sort(),
	);
});

Deno.test("ci: a cache hit returns cached without runs.start (land candidate = tested head)", async () => {
	const f = createFlow();
	const base = f.world.commit(BASE_FILES);
	const head = f.world.commit(withFiles(BASE_FILES, API_EDIT));
	await f.submit({ changeId: change("k"), laneId: lane("1"), head, base });
	await f.finish("run-1");
	equal(f.starts.length, 1);

	const candidate = f.world.commit(withFiles(BASE_FILES, API_EDIT));
	const B = batch("b");
	await f.landTesting({
		batchId: B,
		attempt: 1,
		candidateSha: candidate,
		base,
		affected: ["api"],
	});
	equal(f.starts.length, 1, "no new run");
	equal(f.reports.length, 1);
	deepStrictEqual(f.reports[0].batchId, B);
	const v = f.reports[0].verdict as {
		attempt: number;
		candidateSha: string;
		state: string;
		runIds: string[];
		evidence: { cached: boolean };
	};
	equal(v.attempt, 1);
	equal(v.candidateSha, candidate);
	equal(v.state, "success");
	deepStrictEqual(v.runIds, ["run-1"]);
	equal(v.evidence.cached, true);
	const landDone = f.emitted(f.ci, "checks.completed").at(-1)!.data as {
		subject: unknown;
		cached: boolean;
		contexts: { state: string }[];
	};
	deepStrictEqual(landDone.subject, { kind: "land", id: B });
	equal(landDone.cached, true);
	ok(landDone.contexts.every((c) => c.state === "cached"));
});

Deno.test("ci: a candidate of two tested changes is fully cached; install is skipped, not run", async () => {
	const f = createFlow();
	const base = f.world.commit(BASE_FILES);
	const api = f.world.commit(withFiles(BASE_FILES, API_EDIT));
	const web = f.world.commit(withFiles(BASE_FILES, WEB_EDIT));
	await f.submit({ changeId: change("k"), laneId: lane("1"), head: api, base });
	await f.finish("run-1");
	await f.submit({ changeId: change("m"), laneId: lane("2"), head: web, base });
	await f.finish("run-2");
	const candidate = f.world.commit(
		withFiles(BASE_FILES, { ...API_EDIT, ...WEB_EDIT }),
	);
	await f.landTesting({
		batchId: batch("b"),
		attempt: 1,
		candidateSha: candidate,
		base,
		affected: ["api", "web"],
	});
	equal(f.starts.length, 2, "no run for the candidate");
	const v = f.reports[0].verdict as { state: string; runIds: string[] };
	equal(v.state, "success");
	deepStrictEqual(v.runIds.sort(), ["run-1", "run-2"]);
	const done = f.emitted(f.ci, "checks.completed").at(-1)!.data as {
		contexts: { context: string; state: string }[];
		cached: boolean;
	};
	deepStrictEqual(done.contexts, [
		{ context: "install", state: "skipped" },
		{ context: "test:api", state: "cached" },
		{ context: "test:web", state: "cached" },
	]);
	equal(done.cached, true);
});

Deno.test("ci: a candidate reruns only what changed since it was tested (one cached)", async () => {
	const f = createFlow();
	const base = f.world.commit(BASE_FILES);
	const api = f.world.commit(withFiles(BASE_FILES, API_EDIT));
	const web = f.world.commit(withFiles(BASE_FILES, WEB_EDIT));
	await f.submit({ changeId: change("k"), laneId: lane("1"), head: api, base });
	await f.finish("run-1");
	await f.submit({ changeId: change("m"), laneId: lane("2"), head: web, base });
	await f.finish("run-2");
	// The batch lands api r1 and a web revision CI has not seen.
	const candidate = f.world.commit(withFiles(BASE_FILES, {
		...API_EDIT,
		"apps/web/src/main.ts": "import 'shared'; // banner v2\n",
	}));
	await f.landTesting({
		batchId: batch("b"),
		attempt: 1,
		candidateSha: candidate,
		base,
		affected: ["api", "web"],
	});
	equal(f.starts.length, 3);
	deepStrictEqual(f.starts[2].graph.jobs.map((j) => j.id), [
		"install",
		"test-web",
	]);
	deepStrictEqual(f.starts[2].graph.subject, { kind: "land", id: batch("b") });
	deepStrictEqual(f.starts[2].graph.source, { repoId: REPO });
	const tool = await f.ci.tool("checks_get", {
		repo: REPO,
		subject: { kind: "land", id: batch("b") },
	}, {
		node: REPO,
		repo: REPO,
		scope: "acme",
		actor: { kind: "user", id: USER },
		mode: "enforce",
	}) as {
		checks: { context: string; state: string; cached: boolean }[];
	};
	deepStrictEqual(
		tool.checks.map((c) => [c.context, c.state, c.cached]),
		[["install", "pending", false], ["test:api", "cached", true], [
			"test:web",
			"pending",
			false,
		]],
	);
	await f.finish("run-3");
	equal(f.reports.length, 1);
	const v = f.reports[0].verdict as { runIds: string[]; state: string };
	equal(v.state, "success");
	deepStrictEqual(v.runIds.sort(), ["run-1", "run-3"]);
});

Deno.test("ci: K14 land testing round trip across attempts", async () => {
	const f = createFlow();
	const base = f.world.commit(BASE_FILES);
	const c1 = f.world.commit(withFiles(BASE_FILES, API_EDIT));
	const c2 = f.world.commit(
		withFiles(BASE_FILES, { ...API_EDIT, ...WEB_EDIT }),
	);
	const B = batch("b");
	await f.landTesting({
		batchId: B,
		attempt: 1,
		candidateSha: c1,
		base,
		affected: ["api"],
	});
	equal(f.starts.length, 1);
	deepStrictEqual(f.starts[0].graph.jobs.map((j) => j.id), [
		"install",
		"test-api",
	]);
	equal(f.starts[0].graph.concurrencyGroup, `land:${B}`);
	// Attempt 2 recomposed (a veto dropped nothing here, a new candidate): attempt 1's run is cancelled.
	await f.landTesting({
		batchId: B,
		attempt: 2,
		candidateSha: c2,
		base,
		affected: ["api", "web"],
	});
	equal(f.starts.length, 2);
	deepStrictEqual(f.cancels, ["run-1"]);
	// A redelivered land.testing starts nothing new.
	await f.landTesting({
		batchId: B,
		attempt: 2,
		candidateSha: c2,
		base,
		affected: ["api", "web"],
	});
	equal(f.starts.length, 2);
	// Attempt 1's run ends late: no verdict for it.
	await f.finish("run-1");
	equal(f.reports.length, 0);
	await f.finish("run-2");
	equal(f.reports.length, 1);
	const v = f.reports[0].verdict as {
		attempt: number;
		candidateSha: string;
		state: string;
	};
	deepStrictEqual([v.attempt, v.candidateSha, v.state], [2, c2, "success"]);
	// The same candidate announced for attempt 3 reuses the verdict, echoing 3.
	await f.landTesting({
		batchId: B,
		attempt: 3,
		candidateSha: c2,
		base,
		affected: ["api", "web"],
	});
	equal(f.starts.length, 2);
	equal(f.reports.length, 2);
	deepStrictEqual(
		[
			(f.reports[1].verdict as { attempt: number }).attempt,
			(f.reports[1].verdict as { candidateSha: string }).candidateSha,
		],
		[3, c2],
	);
});

Deno.test("ci: a candidate whose run was superseded is retested when it comes back", async () => {
	const f = createFlow();
	const base = f.world.commit(BASE_FILES);
	const c1 = f.world.commit(withFiles(BASE_FILES, API_EDIT));
	const c2 = f.world.commit(
		withFiles(BASE_FILES, { ...API_EDIT, ...WEB_EDIT }),
	);
	const B = batch("b");
	await f.landTesting({ batchId: B, attempt: 1, candidateSha: c1, base });
	await f.landTesting({ batchId: B, attempt: 2, candidateSha: c2, base });
	deepStrictEqual(f.cancels, ["run-1"]);
	// Attempt 3 recomposes to c1 again: no failure verdict from the
	// superseded plan, a fresh generation instead.
	await f.landTesting({ batchId: B, attempt: 3, candidateSha: c1, base });
	equal(f.reports.length, 0);
	equal(f.starts.length, 3);
	equal(f.starts[2].graph.idemKey, `land:${B}:${c1}:g2`);
	deepStrictEqual(f.cancels, ["run-1", "run-2"]);
	await f.finish("run-3");
	equal(f.reports.length, 1);
	const v = f.reports[0].verdict as {
		attempt: number;
		candidateSha: string;
		state: string;
	};
	deepStrictEqual([v.attempt, v.candidateSha, v.state], [3, c1, "success"]);
});

Deno.test("ci: a rejected land.report (stale attempt) is recorded, not retried forever", async () => {
	const f = createFlow({ rejectReports: true });
	const base = f.world.commit(BASE_FILES);
	const c1 = f.world.commit(withFiles(BASE_FILES, API_EDIT));
	await f.landTesting({
		batchId: batch("b"),
		attempt: 1,
		candidateSha: c1,
		base,
		affected: ["api"],
	});
	await f.finish("run-1");
	equal(f.reports.length, 1);
	ok(f.ci.logs.some((l) => l.msg === "ci: land.report rejected"));
	// Redelivering run.completed does not report again.
	await f.ci.event(
		makeEvent("run.completed", { runId: "run-1", state: "success" }),
	);
	equal(f.reports.length, 1);
});

Deno.test("ci: a lane that rewrites its ci.cue pipeline to run 'true' is tested with the base pipeline", async () => {
	const f = createFlow();
	const base = f.world.commit(BASE_FILES);
	const head = f.world.commit(withFiles(BASE_FILES, {
		...API_EDIT,
		"tartan.cue": tartanCue({
			pipeline: { jobs: { test: { run: "true" } } },
			projects: DEMO_PROJECTS,
		}),
	}));
	await f.submit({ changeId: change("k"), laneId: lane("1"), head, base });
	const jobs = f.starts[0].graph.jobs;
	ok(jobs.every((j) => j.run !== "true"), JSON.stringify(jobs));
	// Root *.cue files are global: every project's base jobs run.
	deepStrictEqual(jobs.map((j) => j.id), [
		"install",
		"lint-api",
		"lint-shared",
		"lint-web",
		"test-api",
		"test-shared",
		"test-web",
	]);
	// ... and the change fails when the base tests fail.
	await f.finish("run-1", { "test-shared": "failure" });
	equal(
		(f.emitted(f.ci, "checks.completed")[0].data as { state: string }).state,
		"failure",
	);
});

Deno.test("ci: zero-config runs the base's test scripts, not the lane's edited ones (K13)", async () => {
	const f = createFlow();
	const base = f.world.commit(PNPM_REPO);
	const head = f.world.commit(withFiles(PNPM_REPO, {
		"services/api/package.json": JSON.stringify({
			name: "api",
			dependencies: { shared: "workspace:*" },
			scripts: { test: "true" },
		}),
		...API_EDIT,
	}));
	await f.submit({ changeId: change("k"), laneId: lane("1"), head, base });
	const jobs = f.starts[0].graph.jobs;
	// A manifest change is global; every test is the base's `vitest run`.
	ok(
		jobs.filter((j) => j.id.startsWith("test-")).every((j) =>
			j.run.endsWith("sh -c 'vitest run'")
		),
	);
	ok(jobs.every((j) => !j.run.includes("'true'")));
});

Deno.test("ci: zero-config reads only the affected projects' scripts, at the base", async () => {
	const f = createFlow();
	const base = f.world.commit(PNPM_REPO);
	const head = f.world.commit(withFiles(PNPM_REPO, API_EDIT));
	await f.submit({ changeId: change("k"), laneId: lane("1"), head, base });
	deepStrictEqual(f.starts[0].graph.jobs.map((j) => j.id), [
		"install",
		"test-api",
	]);
	const reads = f.calls(f.ci, "repo.readFile").map((
		c,
	) => [c.args[1], c.args[2]]);
	deepStrictEqual(reads, [[base, "services/api/package.json"]]);
	deepStrictEqual(
		f.calls(f.ci, "repo.policy").map((c) => c.args[1]),
		[base],
	);
});

Deno.test("ci: nothing configured succeeds at once; an invalid base pipeline fails with its errors", async () => {
	const f = createFlow();
	const empty = { "README.md": "hello\n" };
	const base = f.world.commit(empty);
	const head = f.world.commit({ "README.md": "hello world\n" });
	await f.submit({ changeId: change("k"), laneId: lane("1"), head, base });
	equal(f.starts.length, 0);
	deepStrictEqual(f.emitted(f.ci, "checks.completed")[0].data, {
		subject: { kind: "change", id: change("k") },
		sha: head,
		state: "success",
		contexts: [],
		cached: false,
	});

	const broken = withFiles(PNPM_REPO, {
		"tartan.cue": tartanCue({
			pipeline: { instance: "big", jobs: { a: { run: "x" } } },
		}),
	});
	const base2 = f.world.commit(broken);
	const head2 = f.world.commit(withFiles(broken, API_EDIT));
	await f.submit({
		changeId: change("m"),
		laneId: lane("2"),
		head: head2,
		base: base2,
	});
	equal(f.starts.length, 0);
	const done = f.emitted(f.ci, "checks.completed")[1].data as {
		state: string;
		contexts: { context: string }[];
	};
	equal(done.state, "failure");
	deepStrictEqual(done.contexts, [{ context: "pipeline", state: "failure" }]);
	const got = await f.ci.tool("checks_get", {
		repo: REPO,
		changeId: change("m"),
	}, {
		node: REPO,
		repo: REPO,
		scope: "acme",
		actor: { kind: "agent", id: AGENT },
		mode: "enforce",
	}) as { checks: unknown[] };
	equal(got.checks.length, 1);
});

Deno.test("ci: lanes.ci none skips lane CI with a success", async () => {
	const f = createFlow();
	const files = withFiles(PNPM_REPO, {
		"tartan.cue": tartanCue({
			pipeline: {
				jobs: { test: { run: "pnpm test", each: "affected" } },
				lanes: { ci: "none" },
			},
		}),
	});
	const base = f.world.commit(files);
	const head = f.world.commit(withFiles(files, API_EDIT));
	await f.submit({ changeId: change("k"), laneId: lane("1"), head, base });
	equal(f.starts.length, 0);
	equal(
		(f.emitted(f.ci, "checks.completed")[0].data as { state: string }).state,
		"success",
	);
});

Deno.test("ci: events are idempotent (redelivered submit, run.completed, job events)", async () => {
	const f = createFlow();
	const base = f.world.commit(BASE_FILES);
	const head = f.world.commit(withFiles(BASE_FILES, API_EDIT));
	const ev = await f.submit({
		changeId: change("k"),
		laneId: lane("1"),
		head,
		base,
	});
	await f.ci.event(ev);
	equal(f.starts.length, 1);
	await f.ci.event(
		makeEvent("job.started", {
			runId: "run-1",
			jobId: "test-api",
			state: "running",
		}),
	);
	await f.ci.event(
		makeEvent("job.started", {
			runId: "run-1",
			jobId: "test-api",
			state: "running",
		}),
	);
	equal(
		f.emitted(f.ci, "checks.updated").filter((e) =>
			(e.data as { state: string }).state === "running"
		).length,
		1,
	);
	await f.finish("run-1");
	await f.ci.event(
		makeEvent("run.completed", { runId: "run-1", state: "success" }),
	);
	equal(f.emitted(f.ci, "checks.completed").length, 1);
	// Events of runs this installation did not start are ignored.
	await f.ci.event(
		makeEvent("run.completed", { runId: "run-x", state: "success" }),
	);
	// Run events not from the kernel are ignored.
	await f.ci.event(
		makeEvent("run.completed", { runId: "run-1", state: "failure" }, {
			source: { kind: "installation", id: CI_INST, ext: "evil@1" },
		}),
	);
	equal(f.emitted(f.ci, "checks.completed").length, 1);
});

Deno.test("ci: a retried submit after runs.start failed resumes the same plan and idemKey", async () => {
	const f = createFlow({ failStarts: 1 });
	const base = f.world.commit(BASE_FILES);
	const head = f.world.commit(withFiles(BASE_FILES, API_EDIT));
	const ev = makeEvent("changes.submitted", {
		changeId: change("k"),
		laneId: lane("1"),
		revision: 1,
		head,
		base,
		affected: [],
	}, { actor: { kind: "agent", id: AGENT } });
	await rejects(f.ci.event(ev), /unavailable/);
	equal(f.starts.length, 0);
	// The host retries the event: the stored plan resumes with the same key.
	await f.ci.event(ev);
	equal(f.starts.length, 1);
	equal(f.starts[0].graph.idemKey, `change:${change("k")}:${head}:g1`);
	equal(f.calls(f.ci, "runs.start").length, 2);
	deepStrictEqual(
		f.calls(f.ci, "runs.start").map((c) =>
			(c.args[0] as { idemKey: string }).idemKey
		),
		[`change:${change("k")}:${head}:g1`, `change:${change("k")}:${head}:g1`],
	);
});

Deno.test("ci: a new revision cancels the old run when fully cached, else supersedes it", async () => {
	const f = createFlow();
	const base = f.world.commit(BASE_FILES);
	const r1 = f.world.commit(withFiles(BASE_FILES, API_EDIT));
	const r2 = f.world.commit(
		withFiles(BASE_FILES, {
			"services/api/src/middleware/limit.ts": "export const limit = 1;\n",
		}),
	);
	const C = change("k");
	await f.submit({ changeId: C, laneId: lane("1"), head: r1, base });
	await f.submit({
		changeId: C,
		laneId: lane("1"),
		head: r2,
		base,
		revision: 2,
		type: "changes.revised",
	});
	equal(f.starts.length, 2);
	equal(f.starts[1].graph.concurrencyGroup, `change:${C}`);
	deepStrictEqual(f.cancels, ["run-1"]);
	// The superseded run's completion announces nothing.
	await f.finish("run-1", {}, "superseded");
	equal(f.emitted(f.ci, "checks.completed").length, 0);
	await f.finish("run-2");
	equal(
		(f.emitted(f.ci, "checks.completed")[0].data as { sha: string }).sha,
		r2,
	);
});

Deno.test("ci: the poll timer finalizes a run whose run.completed never arrived", async () => {
	const f = createFlow();
	const base = f.world.commit(BASE_FILES);
	const head = f.world.commit(withFiles(BASE_FILES, API_EDIT));
	await f.submit({ changeId: change("k"), laneId: lane("1"), head, base });
	ok(f.ci.recorder.timers.has("poll:run-1"));
	await f.ci.timer("poll:run-1");
	equal(f.emitted(f.ci, "checks.completed").length, 0);
	ok(f.ci.recorder.timers.has("poll:run-1"), "rescheduled while running");
	f.runs.set("run-1", f.statusOf(f.starts[0], "success", {}));
	await f.ci.timer("poll:run-1");
	equal(f.emitted(f.ci, "checks.completed").length, 1);
	ok(!f.ci.recorder.timers.has("poll:run-1"));
});

Deno.test("ci: push.diffed on a configured branch runs on.push jobs; others and lanes do not", async () => {
	const f = createFlow();
	const base = f.world.commit(BASE_FILES);
	const after = f.world.commit(withFiles(BASE_FILES, API_EDIT));
	const push = (ref: string, target = "repo") =>
		f.ci.event(makeEvent("push.diffed", {
			pushId: `p-${ref}`,
			target,
			ref,
			after,
			rangeBase: base,
			rangeTruncated: false,
			commits: [],
			paths: ["services/api/src/middleware/limit.ts"],
			truncated: false,
			diffKey: `diffs/${REPO}/${base}..${after}.json`,
		}));
	await push("refs/heads/feature/x");
	await push("refs/heads/release/1.2", lane("1"));
	equal(f.starts.length, 0);
	await push("refs/heads/release/1.2");
	equal(f.starts.length, 1);
	deepStrictEqual(f.starts[0].graph.jobs.map((j) => j.id), [
		"install",
		"test-api",
	]);
	deepStrictEqual(f.starts[0].graph.subject, {
		kind: "push",
		id: "p-refs/heads/release/1.2",
	});
	await f.finish("run-1");
	// Push subjects are not checks@1 subjects: no checks.* events.
	equal(f.emitted(f.ci, "checks.completed").length, 0);
});

Deno.test("ci: checks_rerun skips the cache and starts a new generation", async () => {
	const f = createFlow();
	const base = f.world.commit(BASE_FILES);
	const head = f.world.commit(withFiles(BASE_FILES, API_EDIT));
	const C = change("k");
	await f.submit({ changeId: C, laneId: lane("1"), head, base });
	await f.finish("run-1");
	const ctx = {
		node: REPO,
		repo: REPO,
		scope: "acme",
		actor: { kind: "agent" as const, id: AGENT },
		mode: "enforce" as const,
	};
	const out = await f.ci.tool("checks_rerun", { repo: REPO, changeId: C }, ctx);
	deepStrictEqual(out, { runId: "run-2" });
	equal(f.starts[1].graph.idemKey, `change:${C}:${head}:g2`);
	deepStrictEqual(f.starts[1].graph.jobs.map((j) => j.id), [
		"install",
		"lint-api",
		"test-api",
	]);
	await rejects(
		f.ci.tool("checks_rerun", {
			repo: REPO,
			subject: { kind: "land", id: batch("b") },
		}, ctx),
		/new attempt/,
	);
	await rejects(
		f.ci.tool("checks_rerun", { repo: REPO }, ctx),
		/changeId or subject/,
	);
	await rejects(f.ci.tool("nope", {}, ctx), /no tool/);
});

Deno.test("ci: slots render valid tartan-ui read-only; context lists the trunk test commands", async () => {
	const f = createFlow();
	const base = f.world.commit(BASE_FILES);
	const head = f.world.commit(withFiles(BASE_FILES, API_EDIT));
	const C = change("k");
	await f.submit({ changeId: C, laneId: lane("1"), head, base });
	await f.finish("run-1");
	const x = f.ci.ctx({ readOnly: true, actor: { kind: "user", id: USER } });
	for (
		const [slot, ctx] of [
			["checks", {
				slot: "change.sidebar",
				node: REPO,
				repo: REPO,
				entity: { kind: "change", id: C },
				mode: "enforce",
			}],
			["checks", {
				slot: "change.sidebar",
				node: REPO,
				repo: REPO,
				entity: { kind: "change", id: change("z") },
				mode: "enforce",
			}],
			["ci", { slot: "repo.tab", node: REPO, repo: REPO, mode: "enforce" }],
			["projects", {
				slot: "repo.sidebar",
				node: REPO,
				repo: REPO,
				mode: "enforce",
			}],
		] as const
	) {
		const doc = await ciModule.extension.render!(slot, ctx, {}, x);
		const checked = validateUi(doc);
		ok(checked.ok, `${slot}: ${checked.ok ? "" : checked.errors.join("; ")}`);
	}
	const runsDoc = JSON.stringify(
		await ciModule.extension.render!(
			"ci",
			{ slot: "repo.tab", node: REPO, repo: REPO, mode: "enforce" },
			{},
			x,
		),
	);
	ok(runsDoc.includes(`/acme/platform/router/-/runs/run-1`));
	ok(runsDoc.includes(`/acme/platform/router/-/changes/${C}`));
	// Read-only renders made no effect calls.
	const sections = await f.ci.context({
		repo: "acme/platform/router",
		repoId: REPO,
		paths: ["services/api/src/middleware/limit.ts"],
		maxBytes: 2048,
		actor: { kind: "agent", id: AGENT },
	});
	equal(sections.length, 1);
	equal(sections[0].id, "test-commands");
	ok(
		sections[0].md.includes("api: `pnpm test` (in services/api)"),
		sections[0].md,
	);
	ok(!sections[0].md.includes("web:"), sections[0].md);
	const action = await f.ci.action("rerun", { changeId: C }, {
		slot: "change.sidebar",
		node: REPO,
		repo: REPO,
		entity: { kind: "change", id: C },
		mode: "enforce",
	}, { actor: { kind: "user", id: USER } });
	ok(action.toast);
	notEqual(f.starts.length, 1);
});

Deno.test("ci: a deleted project's paths still plan from the base graph", async () => {
	const f = createFlow();
	const base = f.world.commit(BASE_FILES);
	const head = f.world.commit(
		without(BASE_FILES, "apps/web/src/main.ts", "apps/web/package.json"),
	);
	await f.submit({ changeId: change("k"), laneId: lane("1"), head, base });
	// The manifest deletion is global.
	equal(f.starts[0].graph.jobs.length, 7);
});

Deno.test("a change only to a root config file outside every project is tested, not cached", async () => {
	const f = createFlow();
	const files = withFiles(BASE_FILES, { "tsconfig.base.json": "{}\n" });
	const base = f.world.commit(files);
	// A green run of every project (a lockfile change is global).
	const lock = withFiles(files, {
		"pnpm-lock.yaml": "lockfileVersion: '9.1'\n",
	});
	const first = f.world.commit(lock);
	await f.submit({
		changeId: change("k"),
		laneId: lane("1"),
		head: first,
		base,
	});
	await f.finish("run-1");
	equal(f.starts.length, 1);
	// Only tsconfig.base.json changes: outside every root, so global, and
	// every project runs.
	const strict = f.world.commit(withFiles(lock, {
		"tsconfig.base.json": '{"compilerOptions":{"strict":true}}\n',
	}));
	await f.submit({
		changeId: change("m"),
		laneId: lane("2"),
		head: strict,
		base: first,
	});
	equal(f.starts.length, 2, "the root config change starts a run");
	const graph = f.starts[1].graph as unknown as { jobs: { id: string }[] };
	ok(
		graph.jobs.some((j) => j.id.startsWith("test-")),
		JSON.stringify(graph.jobs.map((j) => j.id)),
	);
});

// ---------------------------------------------------------------------------
// The pipeline as repo policy (ADR repo config)
// ---------------------------------------------------------------------------

Deno.test("ci: a base whose Tartan config is still evaluating keeps the check pending; repo.config.resolved plans it", async () => {
	const f = createFlow();
	const base = f.world.commit(BASE_FILES);
	const head = f.world.commit(withFiles(BASE_FILES, API_EDIT));
	f.world.policyOverrides.set(base, { state: "pending" });
	await f.submit({ changeId: change("k"), laneId: lane("1"), head, base });
	equal(f.starts.length, 0);
	deepStrictEqual(f.emitted(f.ci, "checks.completed"), []);
	const checks = await f.ci.tool("checks_get", {
		repo: REPO,
		changeId: change("k"),
	}, {
		node: REPO,
		repo: REPO,
		scope: "acme",
		actor: { kind: "agent", id: AGENT },
		mode: "enforce",
	}) as { checks: { context: string; state: string }[] };
	deepStrictEqual(
		checks.checks.map((c) => [c.context, c.state]),
		[["pipeline", "pending"]],
	);
	// The row resolves: the waiting request is planned from the base pipeline.
	f.world.policyOverrides.delete(base);
	await f.ci.event(
		makeEvent("repo.config.resolved", {
			trunkSeq: 3,
			sha: base,
			status: "ok",
		}),
	);
	equal(f.starts.length, 1);
	deepStrictEqual(f.starts[0].graph.jobs.map((j) => j.id), [
		"install",
		"lint-api",
		"test-api",
	]);
	// Nothing waits any more: a second resolution plans nothing new.
	await f.ci.event(
		makeEvent("repo.config.resolved", {
			trunkSeq: 4,
			sha: base,
			status: "ok",
		}),
	);
	equal(f.starts.length, 1);
});

Deno.test("ci: a base whose Tartan config does not evaluate plans with the last good pipeline and says so", async () => {
	const f = createFlow();
	const good = f.world.commit(BASE_FILES);
	const base = f.world.commit(withFiles(BASE_FILES, { "README.md": "x\n" }));
	const head = f.world.commit(
		withFiles(BASE_FILES, { ...API_EDIT, "README.md": "x\n" }),
	);
	f.world.policyOverrides.set(base, {
		state: "ok",
		configSha: good,
		exact: false,
		values: { pipeline: DEMO_PIPELINE },
		failed: {
			sha: base,
			message: "invalid value 12 (out of bound <=4)",
			issues: [{ path: "x", msg: "invalid value 12", pos: ["ci.cue:12:5"] }],
		},
	});
	await f.submit({ changeId: change("k"), laneId: lane("1"), head, base });
	equal(f.starts.length, 1);
	const plans = f.ci.storage.sql.exec<{ detail_json: string }>(
		"SELECT detail_json FROM plans",
	).toArray();
	const note = JSON.parse(plans[0].detail_json).configNote as string;
	ok(note.includes("does not evaluate: ci.cue:12:5"), note);
	ok(note.includes(`using the pipeline from ${good.slice(0, 12)}`), note);
});

Deno.test("ci: no Tartan config, or none with a pipeline, is zero-config; a pipeline with projects inside is invalid", async () => {
	const f = createFlow();
	// A tartan.cue with only projects: zero-config jobs over the configured
	// graph, each configured project running its own `test` command.
	const files = withFiles(PNPM_REPO, {
		"tartan.cue": tartanCue({
			projects: {
				...DEMO_PROJECTS,
				api: { ...DEMO_PROJECTS.api, test: "pnpm --filter api test" },
			},
		}),
	});
	const base = f.world.commit(files);
	const head = f.world.commit(withFiles(files, API_EDIT));
	await f.submit({ changeId: change("k"), laneId: lane("1"), head, base });
	deepStrictEqual(
		f.starts[0].graph.jobs.map((j) => [j.id, j.run, j.cwd ?? ""]),
		[["test-api", "pnpm --filter api test", "services/api"]],
	);
	const bad = withFiles(PNPM_REPO, {
		"tartan.cue": tartanCue({
			pipeline: {
				jobs: { a: { run: "x" } },
				projects: { api: { root: "services/api" } },
			},
		}),
	});
	const base2 = f.world.commit(bad);
	const head2 = f.world.commit(withFiles(bad, API_EDIT));
	await f.submit({
		changeId: change("m"),
		laneId: lane("2"),
		head: head2,
		base: base2,
	});
	const done = f.emitted(f.ci, "checks.completed").pop()!.data as {
		state: string;
	};
	equal(done.state, "failure");
});

Deno.test("ci: a lane rooted on an older trunk commit plans the trunk tip's pipeline, so a job trunk added since is required", async () => {
	const f = createFlow();
	const base = f.world.commit(BASE_FILES);
	// Trunk adds a required security-scan job to on.change after the base.
	const scan = {
		...DEMO_PIPELINE,
		jobs: {
			...DEMO_PIPELINE.jobs,
			"security-scan": { needs: ["install"], run: "scan" },
		},
		on: {
			...DEMO_PIPELINE.on,
			change: [...DEMO_PIPELINE.on.change, "security-scan"],
		},
	};
	const tip = f.world.commit(
		withFiles(BASE_FILES, {
			"tartan.cue": tartanCue({
				pipeline: scan,
				projects: DEMO_PROJECTS,
				global: DEMO_GLOBAL,
			}),
		}),
	);
	f.setTrunk(tip);
	const head = f.world.commit(withFiles(BASE_FILES, API_EDIT));
	await f.submit({ changeId: change("k"), laneId: lane("1"), head, base });
	equal(f.starts.length, 1);
	ok(
		f.starts[0].graph.jobs.some((j) => j.id === "security-scan"),
		JSON.stringify(f.starts[0].graph.jobs.map((j) => j.id)),
	);
	// The affected set still comes from the change's own range.
	ok(f.starts[0].graph.jobs.some((j) => j.id === "test-api"));
	ok(!f.starts[0].graph.jobs.some((j) => j.id === "test-web"));
});
