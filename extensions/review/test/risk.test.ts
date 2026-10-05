// The risk model, owner rules and config in isolation (pure functions).

import type { Project } from "@tartan/contract";
import { validateOwners } from "../src/owners.ts";
import { reviewConfigOf } from "../src/review.ts";
import {
	assessRisk,
	type ChangedFile,
	DEFAULT_WEIGHTS,
	isTestPath,
	type RiskInput,
	routeOf,
	testScriptsChanged,
} from "../src/risk.ts";
import { equal, ok } from "./assert.ts";

const project = (
	name: string,
	root: string,
	deps: string[] = [],
	dependents: string[] = [],
): Project => ({
	name,
	root,
	deps,
	dependents,
	owners: [],
	sensitive: false,
	source: "pnpm-workspace",
	manifestPath: `${root}/package.json`,
});

const GRAPH = {
	projects: [
		project("shared", "packages/shared", [], ["api", "web"]),
		project("api", "services/api", ["shared"]),
		project("web", "apps/web", ["shared"]),
	],
	globalFiles: [{ glob: ".tartan/**" }, { glob: "pnpm-lock.yaml" }],
};

const file = (
	path: string,
	additions = 5,
	deletions = 1,
	change: ChangedFile["change"] = "modified",
): ChangedFile => ({
	path,
	change,
	additions,
	deletions,
});

const input = (over: Partial<RiskInput>): RiskInput => ({
	files: [],
	truncated: false,
	graph: GRAPH,
	rules: [],
	testScriptChanges: [],
	conflicts: [],
	track: { landed: 0, ejected: 0, vetoed: 0, reverted: 0 },
	...over,
});

Deno.test("risk: a small one-project change is low risk and auto", () => {
	const r = assessRisk(input({ files: [file("apps/web/src/a.ts")] }));
	equal(r.factors.blastRadius, 0.333);
	equal(r.factors.sensitive, 0);
	equal(r.forced, []);
	ok(r.risk < 0.1, String(r.risk));
	equal(routeOf(r, "by-exception", 0.35), "auto");
	equal(routeOf(r, "human-required", 0.35), "human");
});

Deno.test("risk: sensitivity from owner rules and sensitive projects; owners collected", () => {
	const rules = [{
		glob: "services/api/**",
		sensitivity: 3,
		owners: ["u_01k6vvvvvvvvvvvvvvvvvvvvvv"],
	}];
	const r = assessRisk(
		input({ files: [file("services/api/src/x.ts")], rules }),
	);
	equal(r.factors.sensitive, 1);
	equal(r.owners, ["u_01k6vvvvvvvvvvvvvvvvvvvvvv"]);
	equal(r.sensitivePaths, ["services/api/src/x.ts"]);
	const g = {
		...GRAPH,
		projects: GRAPH.projects.map((p) =>
			p.name === "web" ? { ...p, sensitive: true } : p
		),
	};
	equal(
		assessRisk(input({ graph: g, files: [file("apps/web/a.ts")] })).factors
			.sensitive,
		1,
	);
});

Deno.test("risk: global files, size and truncation", () => {
	const lock = assessRisk(input({ files: [file("pnpm-lock.yaml")] }));
	equal(lock.factors.blastRadius, 1);
	equal(lock.affected.global, true);
	equal(
		assessRisk(input({ files: [file("apps/web/a.ts", 200, 200)] })).factors
			.size,
		1,
	);
	const t = assessRisk(
		input({ files: [file("apps/web/a.ts")], truncated: true }),
	);
	equal(t.forced, ["truncated-diff"]);
});

Deno.test("risk: policy files and weakened tests always force a human (K13)", () => {
	// Any root *.cue file is policy (Tartan config, or another package's).
	for (const name of ["tartan.cue", "ci.cue", "env.cue"]) {
		const policy = assessRisk(input({ files: [file(name, 1, 1)] }));
		equal(policy.forced, ["policy-file"], name);
		equal(routeOf(policy, "by-exception", 1), "human");
	}
	// A subdirectory .cue file and the retired .tartan/ directory are not.
	for (const name of ["apps/web/x.cue", ".tartan/pipeline.yaml"]) {
		equal(assessRisk(input({ files: [file(name, 1, 1)] })).forced, [], name);
	}
	const scripts = assessRisk(
		input({
			files: [file("apps/web/package.json")],
			testScriptChanges: ["apps/web/package.json"],
		}),
	);
	equal(scripts.forced, ["policy-file", "weakened-tests"]);
	const deleted = assessRisk(
		input({ files: [file("services/api/test/a.test.ts", 0, 20, "deleted")] }),
	);
	equal(deleted.factors.weakenedTests, 1);
	equal(deleted.weakened.deletedTests, ["services/api/test/a.test.ts"]);
	const fewer = assessRisk(
		input({ files: [file("apps/web/src/a.spec.ts", 2, 12)] }),
	);
	equal(fewer.weakened.netTestLines, -10);
	equal(fewer.factors.weakenedTests, 0.6);
	equal(fewer.forced, ["weakened-tests"]);
	const more = assessRisk(
		input({ files: [file("apps/web/src/a.spec.ts", 12, 2)] }),
	);
	equal(more.factors.weakenedTests, 0);
	equal(assessRisk(input({ rules: null })).forced, ["owners-invalid"]);
});

Deno.test("risk: radar and track record factors; weights are configurable", () => {
	const r = assessRisk(input({
		files: [file("apps/web/a.ts")],
		conflicts: ["same_file", "textual"],
		track: { landed: 2, ejected: 1, vetoed: 1, reverted: 0 },
	}));
	equal(r.factors.radar, 1);
	equal(r.factors.trackRecord, 0.333);
	const onlyRadar = assessRisk(
		input({ files: [file("apps/web/a.ts")], conflicts: ["textual"] }),
		{
			sensitive: 0,
			blastRadius: 0,
			size: 0,
			weakenedTests: 0,
			radar: 1,
			trackRecord: 0,
		},
	);
	equal(onlyRadar.risk, 1);
	equal(DEFAULT_WEIGHTS.weakenedTests, 3);
});

Deno.test("risk: test paths and test-script comparison", () => {
	for (
		const p of [
			"a/test/x.ts",
			"a/__tests__/x.js",
			"x.test.ts",
			"a/b.spec.tsx",
			"pkg/x_test.go",
			"tests/test_a.py",
			"crates/a/tests/it.rs",
		]
	) {
		ok(isTestPath(p), p);
	}
	for (const p of ["src/testing.ts", "src/contest.ts", "docs/latest.md"]) {
		ok(!isTestPath(p), p);
	}
	const pkg = (scripts: Record<string, string>, extra = {}) =>
		JSON.stringify({ scripts, ...extra });
	ok(
		!testScriptsChanged(
			pkg({ test: "vitest" }),
			pkg({ test: "vitest" }, { dependencies: { a: "1" } }),
			false,
		),
	);
	ok(testScriptsChanged(pkg({ test: "vitest" }), pkg({ test: "true" }), false));
	ok(testScriptsChanged(pkg({ "test:unit": "a" }), pkg({}), false));
	ok(
		testScriptsChanged(pkg({ test: "vitest" }), null, false),
		"unreadable head counts",
	);
	ok(
		testScriptsChanged(pkg({ test: "vitest" }), null, true),
		"deleted manifest drops the script",
	);
	ok(
		!testScriptsChanged(null, pkg({ build: "x" }), false),
		"added without test scripts",
	);
	ok(testScriptsChanged("{", pkg({}), false), "invalid JSON counts");
});

Deno.test("owners: validate the exported rules, reject unknown keys and bad sensitivity", () => {
	const good = validateOwners({
		rules: [
			{ paths: ["a/**", "b/*.ts"], sensitivity: 2, owners: ["@team"] },
			{ paths: ["c/x.ts"] },
		],
	});
	ok(good.ok);
	if (good.ok) {
		equal(good.rules.map((r) => [r.glob, r.sensitivity, r.owners]), [
			["a/**", 2, ["@team"]],
			["b/*.ts", 2, ["@team"]],
			["c/x.ts", 0, []],
		]);
	}
	for (
		const bad of [
			{ rules: [{ paths: ["a"], sensitivity: 9 }] },
			{ rules: [{ nope: "a" }] },
			{ rules: { a: 1 } },
			{ rules: [{ paths: ["a"], owners: "x" }] },
			{ rules: [{ path: "a" }] },
			{ rules: [{ paths: [] }] },
			{ extra: 1, rules: [] },
			"rules",
			null,
		]
	) {
		ok(!validateOwners(bad).ok, JSON.stringify(bad));
	}
});

Deno.test("config: defaults, mode, threshold and partial weights", () => {
	const d = reviewConfigOf(undefined);
	equal([d.mode, d.autoThreshold], ["by-exception", 0.35]);
	const c = reviewConfigOf({
		mode: "human-required",
		autoThreshold: 0.5,
		weights: { radar: 5, size: -1, bogus: 3 },
	});
	equal([c.mode, c.autoThreshold, c.weights.radar, c.weights.size], [
		"human-required",
		0.5,
		5,
		1,
	]);
	equal(reviewConfigOf({ autoThreshold: 7 }).autoThreshold, 0.35);
});
