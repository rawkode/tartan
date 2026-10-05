import { deepStrictEqual, equal } from "node:assert/strict";
import { liveScripts, parseArgs, selectScripts } from "./run.ts";

const NAMES = [
	"run.ts",
	"run.test.ts",
	"wp05-repo-core.ts",
	"wp02-identity.ts",
	"wp07a-registry.ts",
	"wp07b-host.ts",
	"wp05-repo-core.test.ts",
	"notes.md",
];

Deno.test("live scripts are wpNN-<slug>.ts files, sorted, tests excluded", () => {
	deepStrictEqual(liveScripts(NAMES), [
		{ id: "wp02", file: "wp02-identity.ts" },
		{ id: "wp05", file: "wp05-repo-core.ts" },
		{ id: "wp07a", file: "wp07a-registry.ts" },
		{ id: "wp07b", file: "wp07b-host.ts" },
	]);
});

Deno.test("selection by WP id, all, and the error cases", () => {
	const scripts = liveScripts(NAMES);
	deepStrictEqual(selectScripts(scripts, "WP05"), {
		ok: true,
		scripts: [{ id: "wp05", file: "wp05-repo-core.ts" }],
	});
	deepStrictEqual(
		selectScripts(scripts, "wp07a"),
		{ ok: true, scripts: [{ id: "wp07a", file: "wp07a-registry.ts" }] },
	);
	equal(selectScripts(scripts, "all").ok, true);
	equal(selectScripts([], "all").ok, false);
	equal(selectScripts(scripts, "wp09").ok, false);
	equal(selectScripts(scripts, "repo").ok, false);
	equal(
		selectScripts(liveScripts(["wp05-a.ts", "wp05-b.ts"]), "wp05").ok,
		false,
	);
});

Deno.test("the target is pulled out and the rest is forwarded", () => {
	deepStrictEqual(parseArgs(["--stage", "dev", "wp05", "--verbose"]), {
		target: "wp05",
		forward: ["--stage", "dev", "--verbose"],
	});
	deepStrictEqual(parseArgs(["--", "--stage", "dev", "all"]), {
		target: "all",
		forward: ["--stage", "dev"],
	});
	deepStrictEqual(parseArgs(["--stage", "dev"]), {
		forward: ["--stage", "dev"],
	});
});
