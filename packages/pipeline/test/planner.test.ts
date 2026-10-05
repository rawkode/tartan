// Planner goldens (global files, `each: affected`) on the graphs WP8's
// detection produces for in-memory repos, and the cache-skip rule.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import type { FileMap } from "@tartan/testkit";
import {
	affectedOn,
	jobsToRun,
	planJobs,
	type PlannedJob,
	type PlanTrigger,
	validatePipeline,
	zeroConfigOf,
	zeroPipeline,
} from "../src/index.ts";
import {
	CARGO_REPO,
	configOf,
	createMemRepo,
	DEMO_TARTAN,
	DENO_REPO,
	GO_REPO,
	PNPM_REPO,
	withFiles,
} from "./repo.ts";

type Golden = [
	id: string,
	context: string,
	run: string,
	cwd: string,
	needs: string,
];

const golden = (jobs: readonly PlannedJob[]): Golden[] =>
	jobs.map((j) => [j.id, j.context, j.run, j.cwd ?? "", j.needs.join(",")]);

const repo = createMemRepo();

/** Zero-config plan of `files` for a change that edits `edits`. */
const zeroPlan = async (files: FileMap, edits: FileMap) => {
	const graph = await repo.graph(files);
	const zero = await zeroConfigOf(
		graph.projects,
		(p) => Promise.resolve((files as Record<string, string>)[p] ?? null),
		{ pnpmLock: "pnpm-lock.yaml" in files },
	);
	const paths = await repo.changed(files, withFiles(files, edits));
	const affected = affectedOn(graph, paths);
	const plan = planJobs(zeroPipeline(zero), graph, affected, "change");
	ok(plan.ok, plan.ok ? "" : plan.error);
	return { affected, jobs: plan.plan.jobs };
};

const pipelinePlan = async (
	files: FileMap,
	edits: FileMap,
	trigger: PlanTrigger,
) => {
	const graph = await repo.graph(files);
	// The pipeline at the base: `tartan.ci`'s repo policy in package tartan.
	const config = configOf(files) as {
		extensions: { "tartan.ci": { settings: { pipeline: unknown } } };
	};
	const parsed = validatePipeline(
		config.extensions["tartan.ci"].settings.pipeline,
	);
	ok(parsed.ok, parsed.ok ? "" : parsed.errors.join("; "));
	const paths = await repo.changed(files, withFiles(files, edits));
	const affected = affectedOn(graph, paths);
	const plan = planJobs(parsed.pipeline, graph, affected, trigger);
	ok(plan.ok, plan.ok ? "" : plan.error);
	return { affected, jobs: plan.plan.jobs };
};

const NODE_TEST = (cwd: string) =>
	`PATH="$PWD/node_modules/.bin:$PWD/${
		cwd.split("/").map(() => "..").join("/")
	}/node_modules/.bin:$PATH" sh -c 'vitest run'`;

Deno.test("golden: pnpm zero-config, an api edit runs install + test:api only", async () => {
	const { affected, jobs } = await zeroPlan(PNPM_REPO, {
		"services/api/src/middleware/limit.ts": "export const limit = 50;\n",
	});
	deepStrictEqual(affected, { projects: ["api"], global: false });
	deepStrictEqual(golden(jobs), [
		["install", "install", "pnpm install --frozen-lockfile", "", ""],
		[
			"test-api",
			"test:api",
			NODE_TEST("services/api"),
			"services/api",
			"install",
		],
	]);
});

Deno.test("golden: pnpm zero-config, a shared edit runs its dependents too", async () => {
	const { jobs } = await zeroPlan(PNPM_REPO, {
		"packages/shared/src/index.ts": "export const x = 2;\n",
	});
	deepStrictEqual(jobs.map((j) => j.context), [
		"install",
		"test:api",
		"test:shared",
		"test:web",
	]);
});

Deno.test("golden: pnpm zero-config, a global file (lockfile) affects every project", async () => {
	const { affected, jobs } = await zeroPlan(PNPM_REPO, {
		"pnpm-lock.yaml": "lockfileVersion: '9.1'\n",
	});
	equal(affected.global, true);
	deepStrictEqual(affected.globalPaths, ["pnpm-lock.yaml"]);
	equal(jobs.length, 4);
});

Deno.test("golden: pnpm zero-config uses the base's test script literally (K13)", async () => {
	const files = withFiles(PNPM_REPO, {
		"services/api/package.json": JSON.stringify({
			name: "api",
			dependencies: { shared: "workspace:*" },
			scripts: { test: "vitest run --coverage 'a b'" },
		}),
	});
	const { jobs } = await zeroPlan(files, {
		"services/api/src/middleware/limit.ts": "x\n",
	});
	equal(
		jobs[1].run,
		`PATH="$PWD/node_modules/.bin:$PWD/../../node_modules/.bin:$PATH" sh -c 'vitest run --coverage '\\''a b'\\'''`,
	);
});

Deno.test("golden: Cargo workspace, a core edit tests core and its dependent cli from the root", async () => {
	const { affected, jobs } = await zeroPlan(CARGO_REPO, {
		"crates/core/src/lib.rs": "pub fn a() { }\n",
	});
	deepStrictEqual(affected, { projects: ["cli", "core"], global: false });
	deepStrictEqual(golden(jobs), [
		["test-cli", "test:cli", "cargo test -p cli", "", ""],
		["test-core", "test:core", "cargo test -p core", "", ""],
	]);
	const lock = await zeroPlan(CARGO_REPO, { "Cargo.lock": "# lock 2\n" });
	equal(lock.affected.global, true);
});

Deno.test("golden: go.work, a billing edit tests billing in its module root", async () => {
	const { jobs } = await zeroPlan(GO_REPO, {
		"svc/billing/main.go": "package main // v2\n",
	});
	deepStrictEqual(golden(jobs), [
		[
			"test-example-com-billing",
			"test:example.com/billing",
			"go test ./...",
			"svc/billing",
			"",
		],
	]);
	const work = await zeroPlan(GO_REPO, {
		"go.work": "go 1.23\n\nuse (\n\t./svc/auth\n\t./svc/billing\n)\n",
	});
	equal(work.jobs.length, 2);
});

Deno.test("golden: deno workspace, an @x/a edit tests @x/a and its importer @x/b", async () => {
	const { jobs } = await zeroPlan(DENO_REPO, {
		"libs/a/mod.ts": "export const a = 3;\n",
	});
	deepStrictEqual(golden(jobs), [
		["test-x-a", "test:@x/a", "deno test", "libs/a", ""],
		["test-x-b", "test:@x/b", "deno test", "libs/b", ""],
	]);
});

Deno.test("golden: zero-config with nothing detected plans no jobs", async () => {
	const { jobs } = await zeroPlan({ "README.md": "hi\n" }, {
		"README.md": "ho\n",
	});
	deepStrictEqual(jobs, []);
});

Deno.test("golden: a single-package repo runs its root test script", async () => {
	const files = {
		"package.json": JSON.stringify({
			name: "solo",
			scripts: { test: "node --test" },
		}),
		"package-lock.json": "{}",
		"index.js": "1\n",
	};
	const { jobs } = await zeroPlan(files, { "index.js": "2\n" });
	deepStrictEqual(golden(jobs), [
		["install", "install", "npm install", "", ""],
		[
			"test",
			"test",
			`PATH="$PWD/node_modules/.bin:$PATH" sh -c 'node --test'`,
			"",
			"install",
		],
	]);
});

const DEMO = withFiles(PNPM_REPO, { "tartan.cue": DEMO_TARTAN });

Deno.test("golden: the pipeline's each: affected on change, land and push triggers", async () => {
	const edit = {
		"services/api/src/middleware/limit.ts": "export const limit = 1;\n",
	};
	const change = await pipelinePlan(DEMO, edit, "change");
	deepStrictEqual(golden(change.jobs), [
		["install", "install", "pnpm install --frozen-lockfile", "", ""],
		["lint-api", "lint:api", "pnpm lint", "services/api", "install"],
		["test-api", "test:api", "pnpm test", "services/api", "install"],
	]);
	ok(change.jobs[1].optional);
	const land = await pipelinePlan(DEMO, edit, "land");
	deepStrictEqual(land.jobs.map((j) => j.id), ["install", "test-api"]);
	const push = await pipelinePlan(DEMO, edit, "push");
	deepStrictEqual(push.jobs.map((j) => j.id), ["install", "test-api"]);
});

Deno.test("golden: global files and root *.cue files (policy) expand each: affected to all", async () => {
	for (
		const edit of [
			{ "pnpm-workspace.yaml": "packages:\n  - packages/*\n" },
			{ "tartan.cue": DEMO_TARTAN.replace('"15m"', '"20m"') },
			{ "env.cue": "package cuenv\n" },
			{ "tools/release.sh": "echo\n" },
		] as FileMap[]
	) {
		const { affected, jobs } = await pipelinePlan(DEMO, edit, "change");
		equal(affected.global, true, JSON.stringify(edit));
		deepStrictEqual(jobs.map((j) => j.id), [
			"install",
			"lint-api",
			"lint-shared",
			"lint-web",
			"test-api",
			"test-shared",
			"test-web",
		]);
	}
});

Deno.test("planner: per-project needs bind to the same project; each: all; cached jobs skip", async () => {
	const graph = await repo.graph(PNPM_REPO);
	const parsed = validatePipeline({
		jobs: {
			install: { run: "pnpm i" },
			build: {
				each: "affected",
				needs: ["install"],
				cwd: "{{project.root}}",
				run: "pnpm build {{project.name}}",
			},
			test: {
				each: "affected",
				needs: ["build"],
				cwd: "{{project.root}}",
				run: "pnpm test",
			},
			audit: { each: "all", run: "audit {{project.name}}" },
			report: { needs: ["test"], run: "report" },
		},
	});
	ok(parsed.ok);
	const plan = planJobs(parsed.pipeline, graph, {
		projects: ["api", "web"],
		global: false,
	}, "change");
	ok(plan.ok);
	const jobs = plan.plan.jobs;
	const byId = new Map(jobs.map((j) => [j.id, j]));
	deepStrictEqual(byId.get("test-api")!.needs, ["build-api"]);
	deepStrictEqual(byId.get("build-web")!.run, "pnpm build web");
	deepStrictEqual(byId.get("report")!.needs, ["test-api", "test-web"]);
	deepStrictEqual(
		jobs.filter((j) => j.job === "audit").map((j) => j.project),
		["api", "shared", "web"],
	);
	// Every need comes before its dependent.
	const order = jobs.map((j) => j.id);
	for (const j of jobs) {
		for (const n of j.needs) ok(order.indexOf(n) < order.indexOf(j.id));
	}
	// test-api cached, test-web not: test-web's chain runs, test-api's does not.
	const cached = new Set([
		"test-api",
		"build-api",
		"audit-api",
		"audit-shared",
		"audit-web",
		"report",
	]);
	const run = jobsToRun(jobs, cached);
	deepStrictEqual([...run].sort(), ["build-web", "install", "test-web"]);
	// Nothing cached: everything runs; everything cached: nothing runs.
	equal(jobsToRun(jobs, new Set()).size, jobs.length);
	equal(jobsToRun(jobs, new Set(jobs.map((j) => j.id))).size, 0);
});

Deno.test("planner: more than 64 jobs is a plan error, not a truncated run", async () => {
	const files: Record<string, string> = {
		"package.json": "{}",
		"pnpm-workspace.yaml": "packages:\n  - p/*\n",
	};
	for (let i = 0; i < 70; i++) {
		files[`p/m${i}/package.json`] = JSON.stringify({
			name: `m${i}`,
			scripts: { test: "t" },
		});
	}
	const graph = await repo.graph(files);
	const zero = await zeroConfigOf(
		graph.projects,
		(p) => Promise.resolve(files[p] ?? null),
		{
			pnpmLock: false,
		},
	);
	const plan = planJobs(zeroPipeline(zero), graph, {
		projects: graph.projects.map((p) => p.name),
		global: true,
	}, "change");
	ok(!plan.ok);
	ok(plan.error.includes("at most 64"), plan.error);
});
