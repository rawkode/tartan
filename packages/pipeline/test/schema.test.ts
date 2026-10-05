// The CI pipeline (ADR repo config): `tartan.ci`'s repo
// policy in package `tartan`, validated as the exported JSON value. CUE gave
// the author positioned errors; this validator is the boundary.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { parseDuration, validatePipeline } from "../src/index.ts";
import { DEMO_PIPELINE } from "./repo.ts";

const errorsOf = (value: unknown): string[] => {
	const r = validatePipeline(value);
	ok(!r.ok, "expected errors");
	return [...r.errors];
};

const job = (extra: Record<string, unknown> = {}) => ({ run: "x", ...extra });

Deno.test("schema: the demo pipeline validates with defaults and triggers", () => {
	const r = validatePipeline(DEMO_PIPELINE);
	ok(r.ok, r.ok ? "" : r.errors.join("; "));
	const p = r.pipeline;
	equal(p.timeoutMs, 15 * 60 * 1000);
	deepStrictEqual(p.jobs.map((j) => [j.id, j.each ?? null, j.optional]), [
		["install", null, false],
		["lint", "affected", true],
		["test", "affected", false],
	]);
	deepStrictEqual(p.on.change, ["install", "lint", "test"]);
	deepStrictEqual(p.on.land, ["install", "test"]);
	deepStrictEqual(p.on.push, {
		branches: ["release/*"],
		jobs: ["install", "test"],
	});
	equal(p.lanes.ci, "on-submit");
});

Deno.test("schema: triggers default to every job; lanes.ci and timeouts validate", () => {
	const r = validatePipeline({
		jobs: { a: job(), b: { run: "y", needs: ["a"] } },
		lanes: { ci: "none" },
	});
	ok(r.ok);
	deepStrictEqual(r.pipeline.on.change, ["a", "b"]);
	deepStrictEqual(r.pipeline.on.land, ["a", "b"]);
	deepStrictEqual(r.pipeline.on.push.jobs, []);
	equal(r.pipeline.lanes.ci, "none");
	equal(parseDuration("90s"), 90_000);
	equal(parseDuration("1h"), 3_600_000);
	equal(parseDuration("15"), null);
	equal(parseDuration(15), null);
});

Deno.test("schema: instance is refused with a pointer to v2", () => {
	const top = errorsOf({ instance: "standard-2", jobs: { a: job() } });
	ok(
		top.some((e) => e.startsWith("instance:") && e.includes("v2")),
		top.join(),
	);
	const one = errorsOf({ jobs: { a: job({ instance: "big" }) } });
	ok(one.some((e) => e.startsWith("jobs.a.instance:")), one.join());
});

Deno.test("schema: projects and global are not pipeline keys (top-level fields of package tartan)", () => {
	const errors = errorsOf({
		jobs: { a: job() },
		projects: { api: { root: "services/api" } },
		global: ["package.json"],
	});
	ok(errors.some((e) => e.startsWith("projects: not a pipeline key")));
	ok(errors.some((e) => e.startsWith("global: not a pipeline key")));
	// The retired `version` key is an unknown key now.
	ok(
		errorsOf({ version: 1, jobs: { a: job() } }).includes(
			"version: unknown key",
		),
	);
});

Deno.test("schema: strict errors name the path", () => {
	const cases: [unknown, string][] = [
		[{ jobs: {} }, "jobs:"],
		[{ jobz: 1, jobs: { a: job() } }, "jobz: unknown key"],
		[{ jobs: { a: job({ needs: ["b"] }) } }, "jobs.a.needs: unknown job b"],
		[
			{ jobs: { a: job({ needs: ["b"] }), b: { run: "y", needs: ["a"] } } },
			"jobs: needs form a cycle",
		],
		[{ jobs: { a: { run: "cd {{project.root}}" } } }, "needs each:"],
		[
			{ jobs: { a: { run: "{{secret}}", each: "affected" } } },
			"unknown template",
		],
		[
			{ jobs: { a: job({ env: { GIT_CONFIG_COUNT: 1 } }) } },
			"reserved for the kernel",
		],
		[{ jobs: { a: job({ each: "some" }) } }, "jobs.a.each:"],
		[{ timeout: "2h", jobs: { a: job() } }, "timeout: at most 60m"],
		[{ jobs: { Bad_Id: job() } }, "jobs.Bad_Id:"],
		[{ jobs: { a: job() }, on: { change: ["z"] } }, "on.change: unknown job z"],
		[{ jobs: { a: { needs: [] } } }, "jobs.a.run:"],
		[{ jobs: { a: job() }, lanes: { ci: "always" } }, "lanes.ci:"],
		["a string", "(root): expected a mapping"],
	];
	for (const [value, expected] of cases) {
		const errors = errorsOf(value);
		ok(
			errors.some((e) => e.includes(expected)),
			`${JSON.stringify(value)} → ${errors.join("; ")}`,
		);
	}
});
