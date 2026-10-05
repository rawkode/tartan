// Project detection, affected closure, K6 disjointness and input hashes on
// in-memory monorepos (`web` ⇒ web only, global file ⇒ all, root tsconfig.json
// or scripts/x.sh ⇒ all, a landing of a global-file change, input-hash
// stability and sensitivity).

import { deepStrictEqual, equal, notEqual, ok } from "node:assert/strict";
import {
	affectedBy,
	checkDisjoint,
	createTreeView,
	detectProjects,
	diffTrees,
	inputHash,
	touchedPaths,
} from "../src/index.ts";
import { createMemGit, type FileSpec, type MemGit } from "./memgit.ts";

const pkg = (name: string, deps: Record<string, string> = {}, test = true) =>
	JSON.stringify({
		name,
		dependencies: deps,
		...(test ? { scripts: { test: "vitest" } } : {}),
	});

/** The sample monorepo of the demo. */
const SAMPLE: Record<string, FileSpec> = {
	"package.json": JSON.stringify({ name: "sample", private: true }),
	"pnpm-workspace.yaml":
		"packages:\n  - packages/*\n  - services/*\n  - apps/*\n",
	"pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
	"tsconfig.json": "{}\n",
	"scripts/x.sh": "echo hi\n",
	"packages/shared/package.json": pkg("shared"),
	"packages/shared/src/index.ts": "export const x = 1;\n",
	"services/api/package.json": pkg("api", { shared: "workspace:*" }),
	"services/api/src/server.ts": "import 'shared';\n",
	"apps/web/package.json": pkg("web", { shared: "workspace:^" }),
	"apps/web/src/main.ts": "import 'shared';\n",
};

const graphOf = async (git: MemGit, files: Record<string, FileSpec>) =>
	await detectProjects(createTreeView(git.objects, git.writeTree(files)));

const changedPaths = async (
	git: MemGit,
	before: Record<string, FileSpec>,
	after: Record<string, FileSpec>,
) =>
	touchedPaths(
		(await diffTrees(
			{ objects: git.objects, tree: git.writeTree(before) },
			{ objects: git.objects, tree: git.writeTree(after) },
		)).changes,
	);

Deno.test("detect: pnpm sample monorepo graph, manifests, test commands, defaults", async () => {
	const git = createMemGit();
	const graph = await graphOf(git, SAMPLE);
	deepStrictEqual(
		graph.projects.map((p) => [p.name, p.root, p.deps, p.dependents, p.source]),
		[
			["api", "services/api", ["shared"], [], "pnpm-workspace"],
			["shared", "packages/shared", [], ["api", "web"], "pnpm-workspace"],
			["web", "apps/web", ["shared"], [], "pnpm-workspace"],
		],
	);
	equal(graph.projects[0].manifestPath, "services/api/package.json");
	equal(graph.projects[0].testCmd, "pnpm test");
	deepStrictEqual(graph.globalFiles, [
		{ glob: "*.cue", source: "detector-default" },
		{ glob: "package-lock.json", source: "detector-default" },
		{ glob: "package.json", source: "detector-default" },
		{ glob: "pnpm-lock.yaml", source: "detector-default" },
		{ glob: "pnpm-workspace.yaml", source: "detector-default" },
	]);
	ok(/^[0-9a-f]{64}$/.test(graph.manifestsTreeSha));
});

Deno.test("affected: shared ⇒ shared+api+web; web ⇒ web; global file ⇒ all; out-of-root paths ⇒ all", async () => {
	const git = createMemGit();
	const graph = await graphOf(git, SAMPLE);
	const shared = await changedPaths(git, SAMPLE, {
		...SAMPLE,
		"packages/shared/src/index.ts": "export const x = 2;\n",
	});
	deepStrictEqual(affectedBy(graph, shared), {
		projects: ["api", "shared", "web"],
		global: false,
	});
	deepStrictEqual(affectedBy(graph, ["apps/web/src/main.ts"]), {
		projects: ["web"],
		global: false,
	});
	for (
		const path of [
			"pnpm-lock.yaml",
			"tsconfig.json",
			"scripts/x.sh",
			"tartan.cue",
			"env.cue",
		]
	) {
		deepStrictEqual(affectedBy(graph, [path]), {
			projects: ["api", "shared", "web"],
			global: true,
			globalPaths: [path],
		}, path);
	}
	// A project manifest is global for K6.
	equal(affectedBy(graph, ["apps/web/package.json"]).global, true);
});

Deno.test("K6: a landing adding api to web's deps makes a later api batch non-disjoint", async () => {
	const git = createMemGit();
	const base = await graphOf(git, SAMPLE);
	const batch = ["services/api/src/server.ts"];
	// On base B the api batch is disjoint from a web-only landing.
	deepStrictEqual(
		checkDisjoint(base, batch, [{ id: "L0", paths: ["apps/web/src/main.ts"] }])
			.disjoint,
		true,
	);
	const atT = {
		...SAMPLE,
		"apps/web/package.json": pkg("web", {
			shared: "workspace:^",
			api: "workspace:*",
		}),
	};
	const landing = {
		id: "L1",
		paths: await changedPaths(git, SAMPLE, atT),
	};
	const graphAtT = await graphOf(git, atT);
	deepStrictEqual(graphAtT.projects.find((p) => p.name === "api")?.dependents, [
		"web",
	]);
	const result = checkDisjoint(graphAtT, batch, [landing]);
	equal(result.disjoint, false);
	deepStrictEqual(result.affected.projects, ["api", "web"]);
	deepStrictEqual(result.reasons, [{
		kind: "landing-global",
		landing: "L1",
		paths: ["apps/web/package.json"],
	}]);
	// Even a later web-only landing now overlaps the api batch on graph T.
	const later = checkDisjoint(graphAtT, batch, [{
		id: "L2",
		paths: ["apps/web/src/main.ts"],
	}]);
	deepStrictEqual(later.reasons, [{
		kind: "overlap",
		landing: "L2",
		projects: ["web"],
	}]);
});

Deno.test("detect: npm workspaces (yarn-style object too) link any dep naming a member", async () => {
	const git = createMemGit();
	const graph = await graphOf(git, {
		"package.json": JSON.stringify({ workspaces: { packages: ["libs/*"] } }),
		"libs/a/package.json": pkg("@acme/a", { "@acme/b": "^1.0.0" }, false),
		"libs/b/package.json": pkg("@acme/b"),
		"libs/notapkg/README.md": "x\n",
	});
	deepStrictEqual(
		graph.projects.map((p) => [p.name, p.deps, p.source, p.testCmd ?? null]),
		[
			["@acme/a", ["@acme/b"], "npm-workspaces", null],
			["@acme/b", [], "npm-workspaces", "npm test"],
		],
	);
});

Deno.test("detect: pnpm ignores registry-version deps on workspace names", async () => {
	const git = createMemGit();
	const graph = await graphOf(git, {
		"pnpm-workspace.yaml": "packages: ['p/*']\n",
		"p/a/package.json": pkg("a", { b: "^1.0.0" }),
		"p/b/package.json": pkg("b"),
	});
	deepStrictEqual(graph.projects.map((p) => p.deps), [[], []]);
});

Deno.test("detect: deno workspace, Cargo workspace and go.work in one repo", async () => {
	const git = createMemGit();
	const graph = await graphOf(git, {
		"deno.jsonc": '{ // root\n "workspace": ["./deno/core", "./deno/cli",] }',
		"deno/core/deno.json": JSON.stringify({
			name: "@x/core",
			exports: "./mod.ts",
		}),
		"deno/cli/deno.json": JSON.stringify({
			name: "@x/cli",
			imports: { "@x/core": "jsr:@x/core@^1" },
		}),
		"Cargo.toml":
			'[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/skip"]\n[workspace.dependencies]\nengine = { path = "crates/engine" }\n',
		"crates/engine/Cargo.toml": '[package]\nname = "engine"\n',
		"crates/cli/Cargo.toml":
			'[package]\nname = "cli-rs"\n[dependencies]\nengine.workspace = true\n[dev-dependencies]\nhelper = { path = "../helper" }\n',
		"crates/helper/Cargo.toml": '[package]\nname = "helper"\n',
		"crates/skip/Cargo.toml": '[package]\nname = "skip"\n',
		"go.work": "go 1.22\nuse (\n  ./go/api\n  ./go/shared\n)\n",
		"go/api/go.mod":
			"module example.com/api\nrequire example.com/shared v0.0.0\n",
		"go/shared/go.mod": "module example.com/shared\n",
	});
	deepStrictEqual(
		graph.projects.map((
			p,
		) => [p.name, p.root, p.deps, p.source, p.manifestPath]),
		[
			[
				"@x/cli",
				"deno/cli",
				["@x/core"],
				"deno-workspace",
				"deno/cli/deno.json",
			],
			["@x/core", "deno/core", [], "deno-workspace", "deno/core/deno.json"],
			[
				"cli-rs",
				"crates/cli",
				["engine", "helper"],
				"cargo",
				"crates/cli/Cargo.toml",
			],
			["engine", "crates/engine", [], "cargo", "crates/engine/Cargo.toml"],
			[
				"example.com/api",
				"go/api",
				["example.com/shared"],
				"go.work",
				"go/api/go.mod",
			],
			["example.com/shared", "go/shared", [], "go.work", "go/shared/go.mod"],
			["helper", "crates/helper", [], "cargo", "crates/helper/Cargo.toml"],
		],
	);
	deepStrictEqual(graph.globalFiles.map((g) => g.glob), [
		"*.cue",
		"Cargo.lock",
		"Cargo.toml",
		"deno.jsonc",
		"deno.lock",
		"go.work",
		"go.work.sum",
	]);
});

Deno.test("detect: the configured projects of package tartan win; global list and !opt-out; the config key moves the graph key", async () => {
	const git = createMemGit();
	const config = {
		key: "k1",
		projects: {
			core: { root: "packages/shared" },
			svc: {
				root: "services/api",
				deps: ["core", "nope"],
				sensitive: true,
				owners: ["@platform"],
			},
			docs: { root: "docs" },
		},
		global: ["tools/**", "!pnpm-lock.yaml"],
	};
	const graph = await detectProjects(
		createTreeView(git.objects, git.writeTree(SAMPLE)),
		config,
	);
	deepStrictEqual(
		graph.projects.map((
			p,
		) => [
			p.name,
			p.root,
			p.deps,
			p.sensitive,
			p.source,
			p.manifestPath ?? null,
		]),
		[
			[
				"core",
				"packages/shared",
				[],
				false,
				"tartan-config",
				"packages/shared/package.json",
			],
			["docs", "docs", [], false, "tartan-config", null],
			[
				"svc",
				"services/api",
				["core"],
				true,
				"tartan-config",
				"services/api/package.json",
			],
		],
	);
	// A .tartan/pipeline.yaml in the tree is never read (ADR repo config).
	const legacy = await graphOf(git, {
		...SAMPLE,
		".tartan/pipeline.yaml": "version: 1\nprojects:\n  x: { root: x }\n",
	});
	ok(legacy.projects.every((p) => p.source === "pnpm-workspace"));
	// Another trunk config at the same tree: another manifestsTreeSha.
	const other = await detectProjects(
		createTreeView(git.objects, git.writeTree(SAMPLE)),
		{ ...config, key: "k2" },
	);
	notEqual(other.manifestsTreeSha, graph.manifestsTreeSha);
	deepStrictEqual(graph.globalFiles, [
		{ glob: "*.cue", source: "detector-default" },
		{ glob: "package-lock.json", source: "detector-default" },
		{ glob: "package.json", source: "detector-default" },
		{ glob: "pnpm-workspace.yaml", source: "detector-default" },
		{ glob: "tools/**", source: "config" },
	]);
});

Deno.test("manifestsTreeSha: stable across source edits, moves with manifests and new members", async () => {
	const git = createMemGit();
	const base = await graphOf(git, SAMPLE);
	const sourceEdit = await graphOf(git, {
		...SAMPLE,
		"apps/web/src/main.ts": "changed\n",
		"apps/web/src/new.ts": "new\n",
	});
	equal(sourceEdit.manifestsTreeSha, base.manifestsTreeSha);
	const manifestEdit = await graphOf(git, {
		...SAMPLE,
		"apps/web/package.json": pkg("web", {
			shared: "workspace:^",
			api: "workspace:*",
		}),
	});
	notEqual(manifestEdit.manifestsTreeSha, base.manifestsTreeSha);
	const newMember = await graphOf(git, {
		...SAMPLE,
		"apps/admin/package.json": pkg("admin"),
	});
	notEqual(newMember.manifestsTreeSha, base.manifestsTreeSha);
	equal(newMember.projects.length, 4);
});

Deno.test("inputHash: stable, sensitive to the dependency closure and global files only", async () => {
	const git = createMemGit();
	const job = { spec: { run: "pnpm test" }, imageId: "sha256:abc" };
	const hashFor = async (files: Record<string, FileSpec>, project: string) => {
		const view = createTreeView(git.objects, git.writeTree(files));
		return await inputHash(view, await detectProjects(view), project, job);
	};
	const web = await hashFor(SAMPLE, "web");
	equal(await hashFor(SAMPLE, "web"), web);
	ok(/^[0-9a-f]{64}$/.test(web));
	// api is outside web's closure: unchanged.
	equal(
		await hashFor({ ...SAMPLE, "services/api/src/server.ts": "x\n" }, "web"),
		web,
	);
	// shared is in web's closure: changed.
	notEqual(
		await hashFor({ ...SAMPLE, "packages/shared/src/index.ts": "y\n" }, "web"),
		web,
	);
	// a global file: changed.
	notEqual(await hashFor({ ...SAMPLE, "pnpm-lock.yaml": "v2\n" }, "web"), web);
	// another job spec or image: changed.
	const view = createTreeView(git.objects, git.writeTree(SAMPLE));
	notEqual(
		await inputHash(view, await detectProjects(view), "web", {
			...job,
			imageId: "sha256:def",
		}),
		web,
	);
});
