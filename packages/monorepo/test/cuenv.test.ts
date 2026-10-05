// WP25 slice A′ acceptance (and the off-mode goldens): the Tier 0 cuenv
// detector as the primary of the detector chain,
// on the demo-shaped fixture, adversarial trees and the goldens of repos
// without a cuenv module.

import { deepStrictEqual, equal, notEqual, ok } from "node:assert/strict";
import {
	affectedBy,
	createTreeView,
	type DetectedGraph,
	detectProjects,
	sha256Hex,
} from "../src/index.ts";
import {
	MAX_CUENV_PROJECTS,
	MAX_WALK_DEPTH,
	MAX_WALK_DIRS,
} from "../src/cuenv/limits.ts";
import type { Project } from "@tartan/contract";
import { createMemGit, type FileSpec } from "./memgit.ts";
import {
	CUENV_DEMO_FILES,
	CUENV_DEMO_LAYERS,
	CUENV_DEMO_NESTED,
	CUENV_DEMO_PROJECTS,
} from "./fixtures/cuenv-demo.ts";
import { GOLDEN_REPOS } from "./fixtures/goldens.ts";

const detect = async (
	files: Readonly<Record<string, FileSpec>>,
	cuenv = true,
): Promise<DetectedGraph & { git: ReturnType<typeof createMemGit> }> => {
	const git = createMemGit();
	const graph = await detectProjects(
		createTreeView(git.objects, git.writeTree(files)),
		undefined,
		{ cuenv },
	);
	return { ...graph, git };
};

const projectsOf = (graph: DetectedGraph) =>
	graph.projects as readonly Project[];

const byName = (graph: DetectedGraph, name: string): Project => {
	const p = projectsOf(graph).find((x) => x.name === name);
	if (!p) throw new Error(`no project ${name}`);
	return p;
};

const env = (body: string) =>
	`package cuenv\n\nimport "github.com/cuenv/cuenv/schema"\n\n${body}`;
const projectEnv = (name: string) =>
	env(`schema.#Project\n\nname: "${name}"\n`);
const MODULE = { "cue.mod/module.cue": 'module: "example.com/m"\n' };

// ---------------------------------------------------------------------------
// Test 1: the demo-shaped fixture
// ---------------------------------------------------------------------------

Deno.test("demo: 38 cuenv projects with their names, roots, slugs and layers", async () => {
	const graph = await detect(CUENV_DEMO_FILES);
	const projects = projectsOf(graph);
	equal(projects.length, 38);
	deepStrictEqual(
		projects.map((p) => [p.name, p.root]).sort(),
		CUENV_DEMO_PROJECTS.map(([name, root]) => [name, root]).sort(),
	);
	for (const p of projects) {
		equal(p.source, "cuenv");
		equal(p.key, p.root);
		equal(p.slug, p.name);
		equal(p.nameSource, "literal");
		equal(p.fidelity, "scan");
		equal(p.manifestPath, `${p.root}/env.cue`);
		equal(p.testCmd, undefined);
		deepStrictEqual(p.owners, []);
		equal(p.issues, undefined, p.name);
	}
	deepStrictEqual(byName(graph, "rawkode-academy-design-system").layers, [""]);
	deepStrictEqual(byName(graph, "rawkode-academy-website").layers, [
		"",
		"projects",
		"projects/rawkode.academy",
	]);
	deepStrictEqual(byName(graph, "rawkode-cloud").layers, ["", "projects"]);
	const extras = graph.extras!;
	equal(extras.detector, "cuenv");
	equal(extras.fidelity, "scan");
	equal(extras.truncated, undefined);
	equal(extras.rootProject, undefined);
	deepStrictEqual(extras.skipped, [CUENV_DEMO_NESTED]);
	deepStrictEqual(extras.layers, [
		{ root: "", paths: ["env.cue", "tartan.cue"] },
		{ root: "projects", paths: ["projects/env.cue"] },
		{
			root: "projects/rawkode.academy",
			paths: [
				"projects/rawkode.academy/codegen/platform-service.cue",
				"projects/rawkode.academy/env.cue",
			],
		},
	]);
	deepStrictEqual(extras.layers!.map((l) => l.root), CUENV_DEMO_LAYERS);
	// 38 projects under the root, 36 under projects/, 26 under rawkode.academy.
	for (
		const [layer, n] of [["", 38], ["projects", 36], [
			"projects/rawkode.academy",
			26,
		]] as const
	) {
		equal(projects.filter((p) => p.layers!.includes(layer)).length, n, layer);
	}
});

Deno.test("demo: workspace edges are lifted onto the containing cuenv projects", async () => {
	const graph = await detect(CUENV_DEMO_FILES);
	deepStrictEqual(byName(graph, "rawkode-academy-website").deps, [
		"rawkode-academy-design-system",
		"rawkode-academy-platform-notifications",
	]);
	deepStrictEqual(byName(graph, "rawkode-academy-studio").deps, [
		"rawkode-academy-platform-notifications",
	]);
	deepStrictEqual(byName(graph, "rawkode-academy-design-system").dependents, [
		"rawkode-academy-website",
	]);
	deepStrictEqual(
		byName(graph, "rawkode-academy-platform-notifications").dependents,
		["rawkode-academy-studio", "rawkode-academy-website"],
	);
	// content/ has no env.cue: a warning, no project, no edge.
	deepStrictEqual(
		graph.extras!.warnings!.map((w) => [w.code, w.path]),
		[
			["workspace-member-without-project", "content"],
			[
				"workspace-member-without-project",
				"projects/rawkode.academy/platform/youtube-scraper",
			],
			["edge-dropped", "projects/rawkode.academy/website"],
		],
	);
});

Deno.test("demo: globals are bun.lock, package.json, cue.mod/** and every root *.cue", async () => {
	const graph = await detect(CUENV_DEMO_FILES);
	deepStrictEqual(graph.globalFiles, [
		{ glob: "*.cue", source: "detector-default" },
		{ glob: "bun.lock", source: "detector-default" },
		{ glob: "cue.mod/**", source: "detector-default" },
		{ glob: "package-lock.json", source: "detector-default" },
		{ glob: "package.json", source: "detector-default" },
	]);
});

Deno.test("demo: package clauses of every .cue blob outside the nested module", async () => {
	const packages = (await detect(CUENV_DEMO_FILES)).extras!.packages!;
	const counts: Record<string, number> = {};
	for (const clause of Object.values(packages)) {
		counts[String(clause)] = (counts[String(clause)] ?? 0) + 1;
	}
	// 41 env.cue + 13 service.cue; the codegen file; the two config files;
	// the clause-less policy.cue. Nothing under the nested module.
	deepStrictEqual(counts, { cuenv: 54, codegen: 1, tartan: 2, null: 1 });
	equal(
		packages["presentations/lets-meet-cdktf-python/cdktf/policy.cue"],
		null,
	);
	equal(packages["packages/design-system/tartan.cue"], "tartan");
	ok(Object.keys(packages).every((p) => !p.startsWith(CUENV_DEMO_NESTED)));
	ok(!("cue.mod/module.cue" in packages));
});

// ---------------------------------------------------------------------------
// Test 4 (A′ subset): affected = root containment, manifests global, out-of-root paths global
// ---------------------------------------------------------------------------

Deno.test("affected: a design-system edit is design-system + website (2 of 38)", async () => {
	const graph = await detect(CUENV_DEMO_FILES);
	const all = graph.projects.map((p) => p.name).sort();
	const of = (...paths: string[]) => affectedBy(graph, paths);
	deepStrictEqual(of("packages/design-system/src/button.ts"), {
		projects: ["rawkode-academy-design-system", "rawkode-academy-website"],
		global: false,
	});
	deepStrictEqual(
		of("projects/rawkode.academy/website/README.md").projects,
		["rawkode-academy-website"],
	);
	// A path inside the nested module belongs to its enclosing project.
	deepStrictEqual(of(`${CUENV_DEMO_NESTED}/config.cue`).projects, [
		"code-rawkode-academy",
	]);
	for (
		const path of [
			"env.cue",
			"tartan.cue",
			"cue.mod/module.cue",
			"bun.lock",
			"package.json",
			// Layers are global in A′ (the global-path rule as written; scoped globals come later).
			"projects/rawkode.academy/env.cue",
			"projects/rawkode.academy/codegen/platform-service.cue",
			// Outside every root.
			"content/courses/intro.md",
			"README.md",
			// A project's manifest (its env.cue) is global, as every manifest is.
			"packages/design-system/env.cue",
		]
	) {
		const a = of(path);
		ok(a.global, path);
		deepStrictEqual(a.projects, all);
	}
});

// ---------------------------------------------------------------------------
// Test 5 and the goldens: the chain without cuenv, byte for byte
// ---------------------------------------------------------------------------

/** `main`'s detector on these trees (before WP25): key and sha256 of the graph JSON. */
const MAIN_GOLDENS = {
	pnpm: [
		"b57722fee2f247a9869ef6439535cad460ebe31aa2675c9937d4fcb135a1ae33",
		"959a9a9e063b65ee8549ef3900b925ae199e6bed89df62a42d086c375df015a9",
	],
	bun: [
		"c41422852aca65b9717e1e41e62b11225b5843054e2a26292fceb07e17702496",
		"bb6781553c541a42df0c290ff0e2f16f83077924b68fdf5d40eb390b48afa2ff",
	],
	cargo: [
		"d42b1a0e847d2ec6022a0410f88ac3976fcb2b4f5aba99aaa89d125dacd31381",
		"f61b5e8862150fbdc31c7b3a15c7a72d5979db3a6475189303d0c3e688ed834e",
	],
} as const;

for (const [repo, [key, json]] of Object.entries(MAIN_GOLDENS)) {
	const files = GOLDEN_REPOS[repo as keyof typeof GOLDEN_REPOS];
	Deno.test(`chain (${repo}): off is byte-identical to the detector before WP25`, async () => {
		const git = createMemGit();
		const view = () => createTreeView(git.objects, git.writeTree(files));
		const plain = await detectProjects(view());
		const off = await detectProjects(view(), undefined, { cuenv: false });
		deepStrictEqual(off, plain);
		equal(off.manifestsTreeSha, key);
		equal(await sha256Hex(JSON.stringify(off)), json);
		equal(off.extras, undefined);
	});
	Deno.test(`chain (${repo}): scan gives the same projects and globals, and names its detector`, async () => {
		const off = await detect(files, false);
		const scan = await detect(files, true);
		deepStrictEqual(scan.projects, off.projects);
		deepStrictEqual(scan.globalFiles, off.globalFiles);
		deepStrictEqual(scan.extras, { detector: "workspaces", fidelity: "exact" });
		// The scan read one more fact (no cue.mod/module.cue), so its key differs.
		notEqual(scan.manifestsTreeSha, off.manifestsTreeSha);
	});
}

Deno.test("chain: a repo with pnpm and cuenv names projects by cuenv and takes edges from pnpm", async () => {
	const files = {
		...MODULE,
		"package.json": '{"name":"root","private":true}\n',
		"pnpm-workspace.yaml": "packages:\n  - libs/*\n  - apps/*\n",
		"pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
		"libs/core/package.json":
			'{"name":"@x/core","scripts":{"test":"vitest"}}\n',
		"libs/core/env.cue": projectEnv("core-lib"),
		"apps/web/package.json":
			'{"name":"@x/web","dependencies":{"@x/core":"workspace:*"}}\n',
		"apps/web/src/main.ts": "export {};\n",
		"apps/web/env.cue": projectEnv("web-app"),
		"apps/cli/package.json": '{"name":"@x/cli"}\n',
	};
	const scan = await detect(files);
	deepStrictEqual(
		projectsOf(scan).map((p) => [p.name, p.root, p.deps, p.source]),
		[
			["core-lib", "libs/core", [], "cuenv"],
			["web-app", "apps/web", ["core-lib"], "cuenv"],
		],
	);
	deepStrictEqual(
		scan.extras!.warnings!.map((w) => [w.code, w.path]),
		[["workspace-member-without-project", "apps/cli"]],
	);
	ok(scan.globalFiles.some((g) => g.glob === "pnpm-lock.yaml"));
	// Without the option the same tree is a pnpm graph.
	const off = await detect(files, false);
	deepStrictEqual(off.projects.map((p) => p.name), [
		"@x/cli",
		"@x/core",
		"@x/web",
	]);
});

Deno.test("chain: configured projects of package tartan still win over cuenv", async () => {
	const git = createMemGit();
	const graph = await detectProjects(
		createTreeView(
			git.objects,
			git.writeTree({ ...MODULE, "a/env.cue": projectEnv("a") }),
		),
		{ key: "k1", projects: { api: { root: "a" } }, global: [] },
		{ cuenv: true },
	);
	deepStrictEqual(graph.projects.map((p) => [p.name, p.source]), [[
		"api",
		"tartan-config",
	]]);
	deepStrictEqual(graph.extras, { detector: "config", fidelity: "exact" });
});

Deno.test("chain: a cuenv module with layers only falls back to the workspace detectors", async () => {
	const graph = await detect({
		...MODULE,
		"env.cue": env("schema.#Base\n"),
		"package.json": '{"name":"r","workspaces":["pkgs/*"]}\n',
		"pkgs/a/package.json": '{"name":"a"}\n',
	});
	deepStrictEqual(graph.projects.map((p) => [p.name, p.source]), [[
		"a",
		"npm-workspaces",
	]]);
	equal(graph.extras!.detector, "workspaces");
});

// ---------------------------------------------------------------------------
// Test 2: adversarial trees
// ---------------------------------------------------------------------------

Deno.test("adversarial: no cue.mod/module.cue means no cuenv detector at all", async () => {
	const graph = await detect({ "a/env.cue": projectEnv("a") });
	deepStrictEqual(graph.projects, []);
	equal(graph.extras!.detector, "workspaces");
	const dirModule = await detect({
		"cue.mod/module.cue/x": "not a file\n",
		"a/env.cue": projectEnv("a"),
	});
	deepStrictEqual(dirModule.projects, []);
});

Deno.test("adversarial: candidates are regular env.cue blobs of ≤ 64 KiB in package cuenv", async () => {
	const graph = await detect({
		...MODULE,
		"ok/env.cue": projectEnv("ok"),
		"other/env.cue": 'package other\n\nschema.#Project\nname: "other"\n',
		"attr/env.cue": `@if(prod)\n${projectEnv("attr")}`,
		"big/env.cue": projectEnv("big") + `// ${"x".repeat(65 * 1024)}\n`,
		"link/env.cue": { content: "../ok/env.cue", mode: "120000" },
		"exec/env.cue": { content: projectEnv("exec"), mode: "100755" },
		"neither/env.cue": env("env: {}\n"),
	});
	deepStrictEqual(graph.projects.map((p) => p.name), ["exec", "ok"]);
	const codes = graph.extras!.warnings!.map((w) => [w.code, w.path]);
	deepStrictEqual(codes, [
		["env-cue-not-regular", "link/env.cue"],
		["package-attribute", "attr/env.cue"],
		["env-cue-too-large", "big/env.cue"],
		["unknown-env-cue", "neither/env.cue"],
	]);
	equal(graph.extras!.packages!["other/env.cue"], "other");
});

Deno.test("adversarial: a computed or over-long name falls back to the directory slug", async () => {
	const graph = await detect({
		...MODULE,
		"svc/My Service/env.cue": env("schema.#Project\nname: _svc.name\n"),
		"long/env.cue": env(`schema.#Project\nname: "${"n".repeat(129)}"\n`),
	});
	const [long, svc] = projectsOf(graph);
	deepStrictEqual([long.name, long.nameSource], ["long", "unresolved"]);
	deepStrictEqual(long.issues!.map((i) => i.code), [
		"name-too-long",
		"computed-name",
	]);
	deepStrictEqual([svc.name, svc.root, svc.nameSource], [
		"my-service",
		"svc/My Service",
		"unresolved",
	]);
	deepStrictEqual(svc.issues!.map((i) => i.code), ["computed-name"]);
});

Deno.test("adversarial: two projects with one name are unique by construction, through affected", async () => {
	const graph = await detect({
		...MODULE,
		"a/env.cue": projectEnv("api"),
		"b/env.cue": projectEnv("api"),
		"b/x.ts": "export {};\n",
	});
	deepStrictEqual(
		projectsOf(graph).map((p) => [p.name, p.root, p.cuenvName, p.slug]),
		[["api", "a", undefined, "api"], ["api@b", "b", "api", "api-b"]],
	);
	for (const p of projectsOf(graph)) {
		deepStrictEqual(p.issues!.map((i) => i.code), ["duplicate-name"]);
	}
	deepStrictEqual(affectedBy(graph, ["b/x.ts"]).projects, ["api@b"]);
	// Radar area keys and CI job ids are derived from names: still distinct.
	equal(new Set(graph.projects.map((p) => `project:${p.name}`)).size, 2);
});

Deno.test("adversarial: a project under a project keeps both; the longest root wins", async () => {
	const graph = await detect({
		...MODULE,
		"outer/env.cue": projectEnv("outer"),
		"outer/inner/env.cue": projectEnv("inner"),
		"outer/inner/x.ts": "export {};\n",
		"outer/y.ts": "export {};\n",
	});
	deepStrictEqual(graph.projects.map((p) => p.name), ["inner", "outer"]);
	deepStrictEqual(byName(graph, "inner").issues!.map((i) => i.code), [
		"nested-project",
	]);
	deepStrictEqual(affectedBy(graph, ["outer/inner/x.ts"]).projects, ["inner"]);
	deepStrictEqual(affectedBy(graph, ["outer/y.ts"]).projects, ["outer"]);
});

Deno.test("adversarial: a root env.cue with #Project names the repository, not a project", async () => {
	const graph = await detect({
		...MODULE,
		"env.cue": projectEnv("cuenv"),
		"crates/core/env.cue": projectEnv("core"),
	});
	deepStrictEqual(graph.projects.map((p) => p.name), ["core"]);
	deepStrictEqual(graph.extras!.rootProject, { name: "cuenv" });
	ok(
		affectedBy(graph, ["src/main.rs"]).global,
		"the global-path rule is unchanged",
	);
});

Deno.test("adversarial: skipped directories and nested modules hide their env.cue", async () => {
	const graph = await detect({
		...MODULE,
		".hidden/env.cue": projectEnv("hidden"),
		"_private/env.cue": projectEnv("private"),
		"node_modules/x/env.cue": projectEnv("dep"),
		"dist/env.cue": projectEnv("built"),
		"vendor/env.cue": projectEnv("vendored"),
		"sub/cue.mod/module.cue": 'module: "sub"\n',
		"sub/env.cue": projectEnv("nested-module"),
		"ok/env.cue": projectEnv("ok"),
	});
	deepStrictEqual(graph.projects.map((p) => p.name), ["ok"]);
	deepStrictEqual(graph.extras!.skipped, ["sub"]);
});

Deno.test(`adversarial: ${MAX_CUENV_PROJECTS + 1} projects keep the first ${MAX_CUENV_PROJECTS} by path`, async () => {
	const files: Record<string, string> = { ...MODULE };
	for (let i = 0; i <= MAX_CUENV_PROJECTS; i++) {
		const n = String(i).padStart(3, "0");
		files[`p/${n}/env.cue`] = projectEnv(`p${n}`);
	}
	const graph = await detect(files);
	equal(graph.projects.length, MAX_CUENV_PROJECTS);
	ok(!graph.projects.some((p) => p.name === `p${MAX_CUENV_PROJECTS}`));
	ok(graph.extras!.skipped!.includes("project-limit"));
});

Deno.test(`adversarial: a directory at depth ${MAX_WALK_DEPTH + 1} truncates the walk; every path is global`, async () => {
	const deep = Array.from({ length: MAX_WALK_DEPTH + 1 }, (_, i) => `d${i}`)
		.join("/");
	const graph = await detect({
		...MODULE,
		"a/env.cue": projectEnv("a"),
		"a/x.ts": "export {};\n",
		[`${deep}/f.txt`]: "deep\n",
	});
	equal(graph.extras!.truncated, true);
	deepStrictEqual(graph.extras!.skipped, ["depth-limit"]);
	const a = affectedBy(graph, ["a/x.ts"]);
	ok(a.global);
	deepStrictEqual(a.projects, ["a"]);
	// One level shallower is not truncated.
	const ok12 = await detect({
		...MODULE,
		"a/env.cue": projectEnv("a"),
		[`${deep.split("/").slice(0, -1).join("/")}/f.txt`]: "x\n",
	});
	equal(ok12.extras!.truncated, undefined);
});

Deno.test(`adversarial: more than ${MAX_WALK_DIRS} directories truncate the walk`, async () => {
	const files: Record<string, string> = {
		...MODULE,
		"a/env.cue": projectEnv("a"),
	};
	for (let i = 0; i < MAX_WALK_DIRS; i++) files[`many/d${i}/f.txt`] = "x\n";
	const graph = await detect(files);
	equal(graph.extras!.truncated, true);
	ok(graph.extras!.skipped!.includes("dir-limit"));
});

// ---------------------------------------------------------------------------
// The graph key: fact files only
// ---------------------------------------------------------------------------

Deno.test("key: source files do not change it; env.cue, module.cue, a new .cue or directory do", async () => {
	const keyOf = async (changes: Record<string, string>) =>
		(await detect({ ...CUENV_DEMO_FILES, ...changes })).manifestsTreeSha;
	const base = await keyOf({});
	equal(base, await keyOf({}));
	equal(
		await keyOf({ "packages/design-system/src/new.ts": "export {};\n" }),
		base,
	);
	equal(await keyOf({ "content/courses/next.md": "# Next\n" }), base);
	for (
		const change of [
			{ "packages/design-system/env.cue": projectEnv("renamed") },
			{ "cue.mod/module.cue": 'module: "other"\n' },
			{ "projects/rawkode.academy/website/extra.cue": "package cuenv\n" },
			{ "projects/new-site/README.md": "# New\n" },
		] as Record<string, string>[]
	) {
		notEqual(await keyOf(change), base, Object.keys(change)[0]);
	}
});

Deno.test("key: the walk reads each tree once and only the .cue and manifest blobs", async () => {
	const git = createMemGit();
	const tree = git.writeTree(CUENV_DEMO_FILES);
	await detectProjects(createTreeView(git.objects, tree), undefined, {
		cuenv: true,
	});
	const cue =
		Object.keys(CUENV_DEMO_FILES).filter((p) =>
			p.endsWith(".cue") && !p.startsWith(`${CUENV_DEMO_NESTED}/`) &&
			!p.startsWith("cue.mod/")
		).length;
	const manifests =
		Object.keys(CUENV_DEMO_FILES).filter((p) => p.endsWith("package.json"))
			.length;
	ok(git.reads.blob <= cue + manifests + 2, `${git.reads.blob} blob reads`);
});
