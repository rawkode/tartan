// The project detector: a project is any non-root directory holding a
// `package tartan` file, under any filename; nothing else makes one.

import { deepStrictEqual, equal, notEqual, ok } from "node:assert/strict";
import type { Project } from "@tartan/contract";
import {
	affectedBy,
	createTreeView,
	type DetectedGraph,
	detectProjects,
} from "../src/index.ts";
import {
	MAX_PACKAGE_CLAUSES,
	MAX_PROJECT_ISSUES,
	MAX_TARTAN_PROJECTS,
	MAX_WALK_DEPTH,
	MAX_WALK_DIRS,
} from "../src/tartan/limits.ts";
import { createMemGit, type FileSpec } from "./memgit.ts";
import {
	FORGE,
	TARTAN_DEMO_FILES,
	TARTAN_DEMO_PROJECTS,
} from "./fixtures/tartan-demo.ts";

const detect = async (
	files: Readonly<Record<string, FileSpec>>,
): Promise<DetectedGraph & { git: ReturnType<typeof createMemGit> }> => {
	const git = createMemGit();
	const graph = await detectProjects(
		createTreeView(git.objects, git.writeTree(files)),
	);
	return { ...graph, git };
};

const byName = (graph: DetectedGraph, name: string): Project => {
	const p = graph.projects.find((x) => x.name === name);
	if (!p) throw new Error(`no project ${name}`);
	return p;
};

const names = (graph: DetectedGraph) => graph.projects.map((p) => p.name);

const named = (name: string) => FORGE(`name: "${name}"\n`);

// ---------------------------------------------------------------------------
// The demo
// ---------------------------------------------------------------------------

Deno.test("demo: its projects with their names, roots, manifests and fields", async () => {
	const graph = await detect(TARTAN_DEMO_FILES);
	deepStrictEqual(
		[...graph.projects].map((p) => [p.name, p.root, p.manifestPath]).sort(),
		TARTAN_DEMO_PROJECTS.map(([name, root, manifest]) => [
			name,
			root,
			`${root}/${manifest}`,
		]).sort(),
	);
	equal(graph.detector, "tartan");
	equal(graph.fidelity, "scan");
	deepStrictEqual(graph.skipped, []);
	equal(graph.truncated, undefined);
	for (const p of graph.projects) {
		equal(p.source, "tartan");
		equal(p.key, p.root);
		equal(p.fidelity, "scan");
		equal(p.testCmd, undefined);
	}
	const web = byName(graph, "rawkode-academy-website");
	deepStrictEqual(web.deps, [
		"rawkode-academy-design-system",
		"rawkode-academy-platform-notifications",
	]);
	deepStrictEqual(byName(graph, "rawkode-academy-design-system").dependents, [
		"rawkode-academy-website",
	]);
	deepStrictEqual(byName(graph, "rawkode-academy-content").extensions, {
		"rawkode.issues": { enabled: false },
	});
	deepStrictEqual(web.extensions, { "rawkode.issues": { enabled: true } });
});

Deno.test("demo: globals are every root *.cue, the module, and the root's lockfiles", async () => {
	const graph = await detect(TARTAN_DEMO_FILES);
	deepStrictEqual(graph.globalFiles.map((g) => g.glob), [
		"*.cue",
		"bun.lock",
		"cue.mod/**",
		"package-lock.json",
		"package.json",
	]);
});

Deno.test("demo: package clauses of the .cue files read", async () => {
	const graph = await detect(TARTAN_DEMO_FILES);
	equal(graph.packages?.["tartan.cue"], "tartan");
	equal(graph.packages?.["tools/codegen/service.cue"], "codegen");
	equal(graph.packages?.["packages/design-system/forge.cue"], "tartan");
	equal(graph.packages?.["cue.mod/module.cue"], undefined);
});

Deno.test("affected: an edit is its project and dependents; what no project claims is global", async () => {
	const graph = await detect(TARTAN_DEMO_FILES);
	const of = (...paths: string[]) => affectedBy(graph, paths);
	deepStrictEqual(of("packages/design-system/src/button.ts"), {
		projects: ["rawkode-academy-design-system", "rawkode-academy-website"],
		global: false,
	});
	deepStrictEqual(of("projects/rawkode.academy/website/CLAUDE.md").projects, [
		"rawkode-academy-website",
	]);
	for (
		const path of [
			"tartan.cue",
			"cue.mod/module.cue",
			"bun.lock",
			"tools/gen.sh",
			"projects/rawkode.academy/AGENTS.md",
		]
	) {
		equal(of(path).global, true, path);
	}
	equal(of("packages/design-system/forge.cue").global, true, "a manifest");
});

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

Deno.test("rule: any filename, no module root, directory name unless a literal name", async () => {
	const graph = await detect({
		"services/api/whatever.cue": FORGE(),
		"services/web/forge.cue": named("site"),
	});
	deepStrictEqual(
		graph.projects.map((p) => [p.name, p.root, p.nameSource, p.manifestPath]),
		[
			["api", "services/api", "directory", "services/api/whatever.cue"],
			["site", "services/web", "literal", "services/web/forge.cue"],
		],
	);
	deepStrictEqual(graph.warnings, []);
});

Deno.test("rule: a directory name is slugged for the project's name", async () => {
	const graph = await detect({ "Svc/My App/forge.cue": FORGE() });
	deepStrictEqual(names(graph), ["my-app"]);
});

Deno.test("rule: no package tartan directory means no projects, and no fallback", async () => {
	for (
		const files of [
			{ "README.md": "# x\n" },
			{ "tartan.cue": FORGE(), "cue.mod/module.cue": 'module: "m"\n' },
			{
				"package.json": '{"name":"x","workspaces":["p/*"]}\n',
				"p/a/package.json": '{"name":"a"}\n',
			},
			{
				"Cargo.toml": '[workspace]\nmembers = ["c/*"]\n',
				"c/a/Cargo.toml": '[package]\nname = "a"\n',
			},
			{
				"pnpm-workspace.yaml": "packages:\n  - p/*\n",
				"p/a/package.json": "{}",
			},
			{ "go.work": "use ./a\n", "a/go.mod": "module a\n" },
			{ "deno.json": '{"workspace":["a"]}', "a/deno.json": '{"name":"a"}' },
			{
				"cue.mod/module.cue": 'module: "m"\n',
				"a/env.cue": 'package cuenv\n\nschema.#Project\nname: "a"\n',
			},
			{ ".forge/projects.cue": 'package forge\n\nprojects: a: root: "a"\n' },
			{ "other/x.cue": "package other\n" },
			{ "other/x.cue": "// package tartan\npackage other\n" },
			{ "other/y.cue": 'import "strings"\n\npackage tartan\n' },
		] as Record<string, string>[]
	) {
		const graph = await detect(files);
		deepStrictEqual(graph.projects, [], Object.keys(files).join());
		equal(graph.detector, "tartan");
	}
});

Deno.test("rule: root *.cue files stay repository config, not a project", async () => {
	const graph = await detect({
		"tartan.cue": named("the-repo"),
		"a/forge.cue": FORGE(),
	});
	deepStrictEqual(names(graph), ["a"]);
	equal(affectedBy(graph, ["tartan.cue"]).global, true);
});

Deno.test("rule: the CUE loader's exclusions do not make a project", async () => {
	const graph = await detect({
		"a/_hidden.cue": FORGE(),
		"b/.hidden.cue": FORGE(),
		"c/x_tool.cue": FORGE(),
		"d/x_test.cue": FORGE(),
		"e/x_tool.cue": FORGE(),
		"e/forge.cue": named("kept"),
		"f/forge.cue.bak": FORGE(),
	});
	deepStrictEqual(names(graph), ["kept"]);
	deepStrictEqual(graph.packages, { "e/forge.cue": "tartan" });
});

Deno.test("rule: skipped directories hide their files; a nested cue.mod is not a boundary", async () => {
	const graph = await detect({
		".hidden/forge.cue": FORGE(),
		"_private/forge.cue": FORGE(),
		"node_modules/x/forge.cue": FORGE(),
		"dist/forge.cue": FORGE(),
		"vendor/forge.cue": FORGE(),
		"target/forge.cue": FORGE(),
		"testdata/forge.cue": FORGE(),
		"cue.mod/pkg/x/forge.cue": FORGE(),
		"sub/cue.mod/pkg/x/forge.cue": FORGE(),
		"sub/cue.mod/module.cue": 'module: "sub"\n',
		"sub/forge.cue": FORGE(),
		"sub/inner/forge.cue": FORGE(),
		"ok/forge.cue": FORGE(),
	});
	deepStrictEqual(names(graph), ["inner", "ok", "sub"]);
	deepStrictEqual(graph.skipped, []);
});

Deno.test("rule: a clause past a long header counts", async () => {
	const header = "// licence\n".repeat(500);
	const graph = await detect({ "a/forge.cue": `${header}${FORGE()}` });
	deepStrictEqual(names(graph), ["a"]);
});

Deno.test("rule: a file too large to read is a warning, never a silent miss", async () => {
	const graph = await detect({
		"big/forge.cue": `package tartan\n// ${"x".repeat(1024 * 1024)}\n`,
		"ok/forge.cue": FORGE(),
	});
	deepStrictEqual(names(graph), ["ok"]);
	deepStrictEqual(graph.warnings?.map((w) => [w.code, w.path]), [
		["cue-too-large", "big/forge.cue"],
	]);
});

Deno.test("rule: a hostile file costs its project only its own facts, never the graph", async () => {
	const nested = `package tartan\n${"a: ".repeat(5_000)}\n`;
	const graph = await detect({
		"bomb/forge.cue": nested,
		"ok/forge.cue": FORGE(),
	});
	deepStrictEqual(names(graph), ["bomb", "ok"]);
});

Deno.test("rule: deps and issues per project are capped, so the graph stays storable", async () => {
	const many = Array.from({ length: 30_000 }, (_, i) => `"d${i}"`).join(",");
	const graph = await detect({
		"a/forge.cue": `package tartan\ndeps: [${many}]\n`,
	});
	const project = graph.projects.find((p) => p.name === "a")!;
	const issues = project.issues ?? [];
	equal(issues.length, MAX_PROJECT_ISSUES);
	equal(issues[0].code, "too-many-deps");
	equal(issues.at(-1)?.code, "issues-truncated");
	ok(JSON.stringify(graph).length < 64 * 1024, "well under SQLite's limit");
});

Deno.test("rule: a literal name a name cannot hold says so, and the directory names the project", async () => {
	const graph = await detect({
		"svc/forge.cue": 'package tartan\nname: "a:b"\n',
	});
	const project = graph.projects.find((p) => p.root === "svc")!;
	equal(project.name, "svc");
	deepStrictEqual(project.issues?.map((i) => i.code), ["invalid-name"]);
});

Deno.test("rule: an attribute before the clause counts, with a warning", async () => {
	const graph = await detect({ "a/forge.cue": `@if(prod)\n${FORGE()}` });
	deepStrictEqual(names(graph), ["a"]);
	deepStrictEqual(graph.warnings?.map((w) => w.code), ["package-attribute"]);
});

Deno.test("rule: a symlink or submodule is no project file", async () => {
	const graph = await detect({
		"a/forge.cue": { mode: "120000", content: "../b/forge.cue" },
		"b/forge.cue": FORGE(),
	});
	deepStrictEqual(names(graph), ["b"]);
	deepStrictEqual(graph.warnings?.map((w) => [w.code, w.path]), [
		["cue-not-regular", "a/forge.cue"],
	]);
});

// ---------------------------------------------------------------------------
// Names, deps, extensions
// ---------------------------------------------------------------------------

Deno.test("names: computed or over-long fall back to the directory, with an issue", async () => {
	const graph = await detect({
		"computed/forge.cue": FORGE('name: strings.ToLower("X")\n'),
		"long/forge.cue": named("x".repeat(129)),
		"fine/forge.cue": named("x".repeat(128)),
	});
	const of = (root: string) => graph.projects.find((p) => p.root === root)!;
	deepStrictEqual(
		[of("computed").name, of("computed").nameSource],
		["computed", "directory"],
	);
	deepStrictEqual(of("computed").issues?.map((i) => i.code), ["computed-name"]);
	equal(of("long").name, "long");
	deepStrictEqual(of("long").issues?.map((i) => i.code), ["name-too-long"]);
	equal(of("fine").name, "x".repeat(128));
	equal(of("fine").issues, undefined);
});

Deno.test("names: two projects with one name are unique by construction, through affected", async () => {
	const graph = await detect({
		"a/forge.cue": named("dup"),
		"b/forge.cue": named("dup"),
	});
	deepStrictEqual(
		graph.projects.map((p) => [p.name, p.declaredName, p.slug]),
		[["dup", undefined, "dup"], ["dup@b", "dup", "dup-b"]],
	);
	deepStrictEqual(affectedBy(graph, ["b/x.ts"]).projects, ["dup@b"]);
});

Deno.test("names: several files in one directory make one project; the manifest is forge.cue", async () => {
	const graph = await detect({
		"a/1.cue": FORGE('deps: ["c"]\n'),
		"a/forge.cue": FORGE('deps: ["b"]\n'),
		"a/z.cue": named("alpha"),
		"a/other.cue": "package other\n",
		"b/2.cue": FORGE(),
		"b/1.cue": FORGE(),
		"c/forge.cue": FORGE(),
	});
	const a = byName(graph, "alpha");
	deepStrictEqual(a.deps, ["b", "c"]);
	equal(a.manifestPath, "a/forge.cue");
	equal(byName(graph, "b").manifestPath, "b/1.cue");
});

Deno.test("deps: an unknown or self dep is dropped, an unknown one with an issue", async () => {
	const graph = await detect({
		"a/forge.cue": FORGE('deps: ["a", "b", "nope"]\n'),
		"b/forge.cue": FORGE('deps: strings.Split("a", ",")\n'),
	});
	deepStrictEqual(byName(graph, "a").deps, ["b"]);
	deepStrictEqual(byName(graph, "a").issues?.map((i) => i.code), [
		"unknown-dep",
	]);
	deepStrictEqual(byName(graph, "b").issues?.map((i) => i.code), [
		"computed-deps",
	]);
	deepStrictEqual(byName(graph, "b").dependents, ["a"]);
});

Deno.test("extensions: both forms; an unreadable form stays enabled with a project warning", async () => {
	const graph = await detect({
		"one/forge.cue": FORGE('extensions: "rawkode.issues": enabled: false\n'),
		"block/forge.cue": FORGE(
			'extensions: {\n\t"rawkode.issues": {\n\t\tenabled: false\n\t}\n}\n',
		),
		"on/forge.cue": FORGE('extensions: "rawkode.issues": enabled: true\n'),
		"plain/forge.cue": FORGE(),
		"weird/forge.cue": FORGE(
			'extensions: "rawkode.issues": enabled: *false | bool\n',
		),
		"split/1.cue": FORGE('extensions: "rawkode.issues": enabled: false\n'),
		"split/2.cue": FORGE('extensions: "rawkode.issues": enabled: true\n'),
		"second/1.cue": FORGE(),
		"second/2.cue": FORGE('extensions: "rawkode.issues": enabled: false\n'),
	});
	const enabled = (name: string) =>
		byName(graph, name).extensions?.["rawkode.issues"].enabled;
	equal(enabled("one"), false);
	equal(enabled("block"), false);
	equal(enabled("on"), true);
	equal(enabled("plain"), true);
	equal(enabled("second"), false);
	equal(enabled("weird"), true);
	deepStrictEqual(byName(graph, "weird").issues?.map((i) => i.code), [
		"extension-config-unread",
	]);
	equal(enabled("split"), true);
	deepStrictEqual(byName(graph, "split").issues?.map((i) => i.code), [
		"extension-config-unread",
	]);
	ok(graph.warnings?.some((w) => w.code === "extension-config-unread"));
	equal(byName(graph, "plain").issues, undefined);
});

Deno.test("nesting: a project under a project keeps both; the longest root wins", async () => {
	const graph = await detect({
		"a/forge.cue": FORGE(),
		"a/b/forge.cue": FORGE(),
	});
	deepStrictEqual(names(graph), ["a", "b"]);
	deepStrictEqual(byName(graph, "b").issues?.map((i) => i.code), [
		"nested-project",
	]);
	deepStrictEqual(affectedBy(graph, ["a/b/x.ts"]).projects, ["b"]);
	deepStrictEqual(affectedBy(graph, ["a/x.ts"]).projects, ["a"]);
});

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

Deno.test(`limits: ${MAX_TARTAN_PROJECTS + 1} projects keep the first ${MAX_TARTAN_PROJECTS} by path`, async () => {
	const files: Record<string, string> = {};
	for (let i = 0; i <= MAX_TARTAN_PROJECTS; i++) {
		const n = String(i).padStart(3, "0");
		files[`p/${n}/forge.cue`] = named(`p${n}`);
	}
	const graph = await detect(files);
	equal(graph.projects.length, MAX_TARTAN_PROJECTS);
	ok(!graph.projects.some((p) => p.name === `p${MAX_TARTAN_PROJECTS}`));
	ok(graph.skipped?.includes("project-limit"));
});

Deno.test(`limits: a directory at depth ${MAX_WALK_DEPTH + 1} truncates the walk; every path is global`, async () => {
	const deep = Array.from({ length: MAX_WALK_DEPTH + 1 }, (_, i) => `d${i}`)
		.join("/");
	const graph = await detect({
		"a/forge.cue": FORGE(),
		"a/x.ts": "export {};\n",
		[`${deep}/f.txt`]: "deep\n",
	});
	equal(graph.truncated, true);
	deepStrictEqual(graph.skipped, ["depth-limit"]);
	const a = affectedBy(graph, ["a/x.ts"]);
	ok(a.global);
	deepStrictEqual(a.projects, ["a"]);
	// One level shallower is not truncated.
	const fine = await detect({
		"a/forge.cue": FORGE(),
		[`${deep.split("/").slice(0, -1).join("/")}/f.txt`]: "x\n",
	});
	equal(fine.truncated, undefined);
});

Deno.test(`limits: more than ${MAX_WALK_DIRS} directories truncate the walk`, async () => {
	const files: Record<string, string> = { "a/forge.cue": FORGE() };
	for (let i = 0; i < MAX_WALK_DIRS; i++) files[`many/d${i}/f.txt`] = "x\n";
	const graph = await detect(files);
	equal(graph.truncated, true);
	ok(graph.skipped?.includes("dir-limit"));
});

Deno.test(`limits: more than ${MAX_PACKAGE_CLAUSES} .cue files truncate; every path is global`, async () => {
	const files: Record<string, string> = {};
	for (let i = 0; i <= MAX_PACKAGE_CLAUSES; i++) {
		files[`many/f${String(i).padStart(4, "0")}.cue`] = "package other\n";
	}
	files["zz/forge.cue"] = FORGE();
	const graph = await detect(files);
	equal(graph.truncated, true);
	ok(graph.skipped?.includes("packages-limit"));
	deepStrictEqual(names(graph), [], "zz sorts past the limit");
	ok(graph.globalFiles.some((g) => g.glob === "**"));
	equal(affectedBy(graph, ["zz/x.ts"]).global, true);
});

// ---------------------------------------------------------------------------
// The graph key: fact files only
// ---------------------------------------------------------------------------

Deno.test("key: source files do not change it; a .cue file or a config key does", async () => {
	const keyOf = async (changes: Record<string, string>) =>
		(await detect({ ...TARTAN_DEMO_FILES, ...changes })).manifestsTreeSha;
	const base = await keyOf({});
	equal(base, await keyOf({}));
	equal(
		await keyOf({ "packages/design-system/src/new.ts": "export {};\n" }),
		base,
	);
	equal(await keyOf({ "content/next.md": "# Next\n" }), base);
	equal(await keyOf({ "projects/new-site/README.md": "# New\n" }), base);
	for (
		const change of [
			{ "packages/design-system/forge.cue": named("renamed") },
			{ "projects/rawkode.academy/website/extra.cue": "package other\n" },
			{ "projects/new-site/forge.cue": FORGE() },
		] as Record<string, string>[]
	) {
		notEqual(await keyOf(change), base, Object.keys(change)[0]);
	}
});

Deno.test("key: the walk reads each .cue blob once and nothing else", async () => {
	const git = createMemGit();
	const tree = git.writeTree(TARTAN_DEMO_FILES);
	await detectProjects(createTreeView(git.objects, tree));
	const cue =
		Object.keys(TARTAN_DEMO_FILES).filter((p) =>
			p.endsWith(".cue") && !p.startsWith("cue.mod/")
		).length;
	equal(git.reads.blob, cue);
});
