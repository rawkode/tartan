// The CI/review affected closure (`affectedOn`, on the graph at the base)
// agrees with WP8's `affectedBy` on every fixture, and the copies of the pure
// modules inside `tartan.review` stay identical to `tartan.ci`'s.

import { deepStrictEqual, equal } from "node:assert/strict";
import { affectedBy, globMatcher as wp8Glob } from "@tartan/monorepo";
import { affectedOn, globMatcher } from "../src/index.ts";
import {
	CARGO_REPO,
	createMemRepo,
	DEMO_TARTAN,
	DENO_REPO,
	GO_REPO,
	PNPM_REPO,
	withFiles,
} from "./repo.ts";

const PATHS: readonly (readonly string[])[] = [
	[],
	["services/api/src/middleware/limit.ts"],
	["packages/shared/src/index.ts"],
	["apps/web/src/main.ts", "services/api/test/limit.test.ts"],
	["pnpm-lock.yaml"],
	["package.json"],
	["tartan.cue"],
	["env.cue"],
	["services/api/config.cue"],
	[".tartan/pipeline.yaml"],
	["services/api/package.json"],
	["README.md"],
	["crates/core/src/lib.rs"],
	["crates/cli/src/main.rs", "Cargo.lock"],
	["svc/auth/main.go"],
	["go.work"],
	["libs/a/mod.ts"],
	["libs/b/deno.json"],
];

Deno.test("affectedOn equals WP8's affectedBy on every fixture graph", async () => {
	const repo = createMemRepo();
	for (
		const files of [
			PNPM_REPO,
			withFiles(PNPM_REPO, { "tartan.cue": DEMO_TARTAN }),
			CARGO_REPO,
			GO_REPO,
			DENO_REPO,
		]
	) {
		const graph = await repo.graph(files);
		for (const paths of PATHS) {
			deepStrictEqual(
				affectedOn(graph, paths),
				affectedBy(graph, paths),
				JSON.stringify(paths),
			);
		}
	}
});

Deno.test("globMatcher equals WP8's on a pattern × path corpus", () => {
	const patterns = [
		"*.cue",
		".tartan/**",
		"*.lock",
		"**/*.test.ts",
		"services/{api,web}/**",
		"packages/*/src/[a-m]*.ts",
		"docs/",
		"a?c",
		"**",
		"[z-a]x",
	];
	const paths = [
		"tartan.cue",
		"services/api/x.cue",
		".tartan/pipeline.yaml",
		"Cargo.lock",
		"x/y/z.test.ts",
		"services/api/a/b.ts",
		"services/web",
		"packages/shared/src/money.ts",
		"packages/shared/src/zed.ts",
		"docs",
		"abc",
		"a/c",
	];
	for (const p of patterns) {
		let ref: ((s: string) => boolean) | null = null;
		try {
			ref = wp8Glob(p);
		} catch {
			// WP8 throws on an invalid class; ours matches nothing.
		}
		const ours = globMatcher(p);
		for (const path of paths) {
			equal(ours(path), ref ? ref(path) : false, `${p} ~ ${path}`);
		}
	}
});

Deno.test("the review extension's copies of the pure modules are identical", async () => {
	const root = new URL("../../../extensions/", import.meta.url);
	for (const name of ["glob.ts", "graph.ts"]) {
		equal(
			await Deno.readTextFile(new URL(`review/src/lib/${name}`, root)),
			await Deno.readTextFile(new URL(`ci/src/pipeline/${name}`, root)),
			`extensions/review/src/lib/${name} drifted from extensions/ci/src/pipeline/${name}`,
		);
	}
});
