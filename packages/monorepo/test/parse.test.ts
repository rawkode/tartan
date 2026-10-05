// Manifest parsers: the YAML, TOML, go.work/go.mod and JSONC subsets the
// detectors rely on, and glob matching.

import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import {
	globMatcher,
	joinPath,
	parseGoMod,
	parseGoWork,
	parseJsonc,
	parseToml,
	parseYaml,
} from "../src/index.ts";

const PIPELINE = `version: 1
# no instance: field in v1
timeout: 15m                      # hard max 60m
global: [".tartan/**", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "deno.json"]   # every project affected
projects:                         # optional; otherwise auto-detected
  shared: { root: packages/shared }
  api:    { root: services/api, deps: [shared], sensitive: true, owners: ["@platform"] }
  web:    { root: apps/web, deps: [shared] }
jobs:
  install: { run: "pnpm install --frozen-lockfile" }
  lint:    { needs: [install], each: affected, cwd: "{{project.root}}", run: "pnpm lint", optional: true }
on:
  change: [install, lint, test]
  push:   { branches: ["release/*"], jobs: [install, test] }
lanes: { ci: on-submit }
`;

Deno.test("yaml: the demo pipeline", () => {
	const doc = parseYaml(PIPELINE) as Record<string, unknown>;
	equal(doc.version, 1);
	equal(doc.timeout, "15m");
	deepStrictEqual(doc.global, [
		".tartan/**",
		"package.json",
		"pnpm-lock.yaml",
		"pnpm-workspace.yaml",
		"deno.json",
	]);
	deepStrictEqual(doc.projects, {
		shared: { root: "packages/shared" },
		api: {
			root: "services/api",
			deps: ["shared"],
			sensitive: true,
			owners: ["@platform"],
		},
		web: { root: "apps/web", deps: ["shared"] },
	});
	deepStrictEqual((doc.jobs as Record<string, unknown>).lint, {
		needs: ["install"],
		each: "affected",
		cwd: "{{project.root}}",
		run: "pnpm lint",
		optional: true,
	});
	deepStrictEqual(doc.lanes, { ci: "on-submit" });
});

Deno.test("yaml: pnpm-workspace lists, nested blocks, sequences of maps, block scalars", () => {
	deepStrictEqual(
		parseYaml(
			"packages:\n  - 'packages/*'\n  - \"apps/**\"\n  - '!**/test/**'\n",
		),
		{ packages: ["packages/*", "apps/**", "!**/test/**"] },
	);
	deepStrictEqual(parseYaml("packages:\n- a\n- b\nother: x\n"), {
		packages: ["a", "b"],
		other: "x",
	});
	deepStrictEqual(
		parseYaml(
			"items:\n  - name: a\n    deps: [x, y]\n  - name: b\nnote: |\n  line 1\n  line 2\n",
		),
		{
			items: [{ name: "a", deps: ["x", "y"] }, { name: "b" }],
			note: "line 1\nline 2\n",
		},
	);
	deepStrictEqual(parseYaml("a: {x: [1, 2,\n  3], y: 'it''s'}\nb: ~\n"), {
		a: { x: [1, 2, 3], y: "it's" },
		b: null,
	});
	equal(parseYaml(""), null);
	throws(() => parseYaml("a: [1, 2\n"));
	throws(() => parseYaml("\ta: 1\n"));
});

const CARGO = `
[workspace]
resolver = "2"
members = [
  "crates/*",   # every crate
  "tools/gen",
]
exclude = ["crates/experimental"]

[workspace.dependencies]
core = { path = "crates/core", version = "0.1" }
serde = "1"

[package]
name = "root-app"
version = "0.1.0"

[dependencies]
core.workspace = true
'quoted key' = { path = "crates/x" }

[target.'cfg(unix)'.dev-dependencies]
util = { path = "crates/util" }

[[bin]]
name = "a"
[[bin]]
name = "b"
`;

Deno.test("toml: a Cargo workspace manifest", () => {
	const t = parseToml(CARGO);
	const ws = t.workspace as Record<string, unknown>;
	deepStrictEqual(ws.members, ["crates/*", "tools/gen"]);
	deepStrictEqual(ws.exclude, ["crates/experimental"]);
	deepStrictEqual((ws.dependencies as Record<string, unknown>).core, {
		path: "crates/core",
		version: "0.1",
	});
	deepStrictEqual(t.dependencies, {
		core: { workspace: true },
		"quoted key": { path: "crates/x" },
	});
	deepStrictEqual(t.target, {
		"cfg(unix)": { "dev-dependencies": { util: { path: "crates/util" } } },
	});
	deepStrictEqual(t.bin, [{ name: "a" }, { name: "b" }]);
	deepStrictEqual(
		parseToml('s = """\nmulti\nline"""\nn = 1_000\nf = 1.5\nd = 2026-10-02\n'),
		{
			s: "multi\nline",
			n: 1000,
			f: 1.5,
			d: "2026-10-02",
		},
	);
	throws(() => parseToml("a = 1\na = 2\n"));
	throws(() => parseToml("a = [1, 2\n"));
});

Deno.test("go.work and go.mod directives", () => {
	deepStrictEqual(
		parseGoWork(
			"go 1.22\n\nuse (\n\t./svc/api // api\n\t./lib/shared\n)\nuse ./tools\n",
		),
		{ use: ["./svc/api", "./lib/shared", "./tools"] },
	);
	deepStrictEqual(
		parseGoMod(
			'module example.com/api\n\ngo 1.22\n\nrequire (\n\texample.com/shared v0.0.0\n\tgithub.com/x/y v1.2.3 // indirect\n)\nrequire "example.com/z" v1\nreplace example.com/shared => ../../lib/shared\nreplace example.com/q v1 => example.com/r v2\n',
		),
		{
			module: "example.com/api",
			require: ["example.com/shared", "github.com/x/y", "example.com/z"],
			replaceLocal: [{
				module: "example.com/shared",
				path: "../../lib/shared",
			}],
		},
	);
});

Deno.test("jsonc: comments and trailing commas; invalid input is undefined", () => {
	deepStrictEqual(
		parseJsonc(
			'{\n // c\n "workspace": ["./a", "./b",], /* x */ "u": "http://x"\n}',
		),
		{ workspace: ["./a", "./b"], u: "http://x" },
	);
	equal(parseJsonc("{nope"), undefined);
});

Deno.test("globs and paths", () => {
	ok(globMatcher("packages/*")("packages/a"));
	ok(!globMatcher("packages/*")("packages/a/b"));
	ok(globMatcher("apps/**")("apps/a/b"));
	ok(globMatcher(".tartan/**")(".tartan/pipeline.yaml"));
	ok(globMatcher("**/test/**")("packages/a/test/x"));
	ok(globMatcher("{apps,libs}/*")("libs/x"));
	ok(globMatcher("./crates/*/")("crates/core"));
	ok(!globMatcher("package.json")("apps/web/package.json"));
	ok(globMatcher("**/*.lock")("a/b/c.lock"));
	ok(globMatcher("**/*.lock")("c.lock"));
	equal(joinPath("services/api", "../../lib/shared"), "lib/shared");
	equal(joinPath("a", "../../x"), null);
	equal(joinPath("./a/", "b/"), "a/b");
});
