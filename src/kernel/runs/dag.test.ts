import { deepEqual, equal } from "node:assert/strict";
import { type DagJob, dagStep, runOutcome } from "./dag.ts";

const job = (id: string, needs: string[] = [], optional = false): DagJob => ({
	id,
	needs,
	optional,
});

// install → (lint optional, test) → report
const GRAPH = [
	job("install"),
	job("lint", ["install"], true),
	job("test", ["install"]),
	job("report", ["test", "lint"]),
];

Deno.test("starts roots first, then independent jobs together", () => {
	deepEqual(dagStep(GRAPH, {}).start, ["install"]);
	const after = dagStep(GRAPH, { install: "success" });
	deepEqual(after.start, ["lint", "test"]);
	equal(after.done, false);
	deepEqual(
		dagStep(GRAPH, { install: "success", lint: "running", test: "running" })
			.start,
		[],
	);
});

Deno.test("an optional failure does not block; a required failure skips dependents", () => {
	deepEqual(
		dagStep(GRAPH, { install: "success", lint: "failure", test: "success" })
			.start,
		["report"],
	);
	const failed = dagStep(GRAPH, {
		install: "success",
		lint: "success",
		test: "failure",
	});
	deepEqual(failed.skip, ["report"]);
	equal(failed.done, true);
	const root = dagStep(GRAPH, { install: "failure" });
	deepEqual(root.skip, ["lint", "test", "report"]);
	equal(root.done, true);
});

Deno.test("skips propagate to dependents declared before their need", () => {
	const graph = [job("late", ["mid"]), job("mid", ["root"]), job("root")];
	deepEqual([...dagStep(graph, { root: "cancelled" }).skip].sort(), [
		"late",
		"mid",
	]);
});

Deno.test("serial mode starts one job at a time (kernel git runs)", () => {
	const graph = [job("a"), job("b")];
	deepEqual(dagStep(graph, {}, { serial: true }).start, ["a"]);
	deepEqual(dagStep(graph, { a: "running" }, { serial: true }).start, []);
	deepEqual(dagStep(graph, { a: "success" }, { serial: true }).start, ["b"]);
});

Deno.test("run outcome", () => {
	const states = {
		install: "success",
		lint: "failure",
		test: "success",
		report: "success",
	} as const;
	equal(runOutcome(GRAPH, states), "success");
	equal(runOutcome(GRAPH, { ...states, test: "failure" }), "failure");
	equal(runOutcome(GRAPH, { ...states, report: "skipped" }), "failure");
	equal(runOutcome(GRAPH, { ...states, test: "cancelled" }), "cancelled");
	equal(runOutcome(GRAPH, { ...states, test: "cached" }), "success");
});
