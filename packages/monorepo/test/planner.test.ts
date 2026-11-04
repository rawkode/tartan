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

const forge = (name: string, deps: string[] = []) =>
	`package tartan\n\nname: "${name}"\ndeps: ${JSON.stringify(deps)}\n`;

/** The sample monorepo of the demo. */
const SAMPLE: Record<string, FileSpec> = {
	"package.json": JSON.stringify({ name: "sample", private: true }),
	"pnpm-workspace.yaml":
		"packages:\n  - packages/*\n  - services/*\n  - apps/*\n",
	"pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
	"tsconfig.json": "{}\n",
	"scripts/x.sh": "echo hi\n",
	"packages/shared/forge.cue": forge("shared"),
	"packages/shared/src/index.ts": "export const x = 1;\n",
	"services/api/forge.cue": forge("api", ["shared"]),
	"services/api/src/server.ts": "import 'shared';\n",
	"apps/web/forge.cue": forge("web", ["shared"]),
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

Deno.test("detect: the sample's graph, manifests and global defaults", async () => {
	const git = createMemGit();
	const graph = await graphOf(git, SAMPLE);
	deepStrictEqual(
		graph.projects.map((p) => [p.name, p.root, p.deps, p.dependents, p.source]),
		[
			["api", "services/api", ["shared"], [], "tartan"],
			["shared", "packages/shared", [], ["api", "web"], "tartan"],
			["web", "apps/web", ["shared"], [], "tartan"],
		],
	);
	equal(graph.projects[0].manifestPath, "services/api/forge.cue");
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
	equal(affectedBy(graph, ["apps/web/forge.cue"]).global, true);
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
		"apps/web/forge.cue": forge("web", ["shared", "api"]),
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
		paths: ["apps/web/forge.cue"],
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

Deno.test("detect: the global list and its !opt-out; a projects key names nothing; the config key moves the graph key", async () => {
	const git = createMemGit();
	const config = {
		key: "k1",
		projects: { core: { root: "packages/shared" } },
		global: ["tools/**", "!pnpm-lock.yaml"],
	};
	const view = () => createTreeView(git.objects, git.writeTree(SAMPLE));
	const graph = await detectProjects(view(), config);
	deepStrictEqual(graph.projects.map((p) => p.name), ["api", "shared", "web"]);
	deepStrictEqual(graph.globalFiles, [
		{ glob: "*.cue", source: "detector-default" },
		{ glob: "package-lock.json", source: "detector-default" },
		{ glob: "package.json", source: "detector-default" },
		{ glob: "pnpm-workspace.yaml", source: "detector-default" },
		{ glob: "tools/**", source: "config" },
	]);
	// A .tartan/pipeline.yaml or a central list in the tree is never read.
	const legacy = await graphOf(git, {
		...SAMPLE,
		".tartan/pipeline.yaml": "version: 1\nprojects:\n  x: { root: x }\n",
		".forge/projects.cue": 'package forge\n\nprojects: x: root: "x"\n',
	});
	deepStrictEqual(legacy.projects.map((p) => p.name), ["api", "shared", "web"]);
	// Another trunk config at the same tree: another manifestsTreeSha.
	const other = await detectProjects(view(), { ...config, key: "k2" });
	notEqual(other.manifestsTreeSha, graph.manifestsTreeSha);
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
		"apps/web/forge.cue": forge("web", ["shared", "api"]),
	});
	notEqual(manifestEdit.manifestsTreeSha, base.manifestsTreeSha);
	const newMember = await graphOf(git, {
		...SAMPLE,
		"apps/admin/forge.cue": forge("admin"),
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
