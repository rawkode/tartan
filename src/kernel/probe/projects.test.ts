// RepoProbe and RepoDO's probe module with `TARTAN_PROJECTS` (WP25 slice
// A′): `scan` computes cuenv graphs at a commit and RepoDO keeps their
// fields; a graph cached under the other mode is recomputed; `off` is the
// graph without cuenv; a duplicate-name pair goes through the `projects`
// mirror (its `name` primary key).

import { deepStrictEqual, equal, notEqual, ok } from "node:assert/strict";
import type { ProjectGraph } from "@tartan/contract";
import type { ModuleDeps, RepoInternals } from "@tartan/contract/kernel.ts";
import { createMemGit } from "../../../packages/monorepo/test/memgit.ts";
import { CUENV_DEMO_FILES } from "../../../packages/monorepo/test/fixtures/cuenv-demo.ts";
import type { Env } from "../../env.ts";
import { createTestStorage } from "../tree/testing/sqlite.ts";
import { createProbeModule, PROBE_MIGRATIONS } from "./module.ts";
import { createRepoProbe } from "./probe.ts";
import { graphMode, storedExtras } from "./projects.ts";
import { createHarness, type Fixture } from "./test/fixture-store.ts";

const REPO = "01k6aaaaaaaaaaaaaaaaaaaaaa";

const b64 = (bytes: Uint8Array): string => {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
};

/** A one-commit fixture (the probe harness's shape) holding `files`. */
const fixtureOf = (
	files: Readonly<Record<string, string>>,
): { fixture: Fixture; sha: string } => {
	const git = createMemGit();
	const tree = git.writeTree(files);
	const trees: Record<string, unknown[]> = {};
	const blobs: Record<string, string> = {};
	for (const [hash, o] of git.store) {
		if (o.kind === "tree") trees[hash] = o.entries;
		else blobs[hash] = b64(o.bytes);
	}
	const sha = tree.slice(0, 32) + "c0ffee00";
	const commit = {
		hash: sha,
		treeHash: tree,
		message: "fixture",
		author: { name: "t", email: "t@example.com" },
		committer: { name: "t", email: "t@example.com" },
		parents: [],
	};
	return {
		sha,
		fixture: {
			trunk: [sha],
			refs: {},
			lanes: {},
			pairs: [],
			objects: { commits: { [sha]: commit }, trees, blobs },
		} as unknown as Fixture,
	};
};

const harnessOf = (files: Readonly<Record<string, string>>) => {
	const { fixture, sha } = fixtureOf(files);
	const h = createHarness(fixture);
	h.store.setRepo(`r-${REPO}`, [sha]);
	return { ...h, sha };
};

const v031 = (g: ProjectGraph) => g;

Deno.test("scan: RepoProbe computes the cuenv graph at a commit, once", async () => {
	const h = harnessOf(CUENV_DEMO_FILES);
	const probe = createRepoProbe({ ...h.deps, projects: "scan" });
	const graph = v031(await probe.projectGraph(REPO, h.sha));
	equal(graph.projects.length, 38);
	equal(graph.detector, "cuenv");
	equal(graph.fidelity, "scan");
	equal(graph.layers?.length, 3);
	equal(graph.configKey, "off");
	equal(graphMode(graph), "scan");
	ok(h.state.graphs.has(h.sha));
	const reads = h.store.calls.length;
	deepStrictEqual(
		await createRepoProbe({ ...h.deps, projects: "scan" }).projectGraph(
			REPO,
			h.sha,
		),
		graph,
	);
	equal(h.store.calls.length, reads, "the cached graph is served");
	deepStrictEqual(
		await probe.affected(REPO, h.sha, h.sha, { graphAt: h.sha }),
		{ projects: [], global: false },
	);
});

Deno.test("off: the same tree is the workspace graph, with no cuenv fields", async () => {
	const h = harnessOf(CUENV_DEMO_FILES);
	const graph = await createRepoProbe(h.deps).projectGraph(REPO, h.sha);
	equal(graphMode(graph), "off");
	deepStrictEqual(storedExtras(graph), {});
	ok(graph.projects.every((p) => p.source === "npm-workspaces"));
	ok(graph.projects.some((p) => p.name === "@rawkodeacademy/content"));
});

Deno.test("a switch flip recomputes a graph cached under the other mode", async () => {
	const h = harnessOf(CUENV_DEMO_FILES);
	const off = await createRepoProbe(h.deps).projectGraph(REPO, h.sha);
	// A new isolate (a redeploy) with scan: the cached off graph is not served.
	const scan = await createRepoProbe({
		...h.deps,
		graphMemo: new Map(),
		projects: "scan",
	}).projectGraph(REPO, h.sha);
	equal(graphMode(scan), "scan");
	notEqual(scan.manifestsTreeSha, off.manifestsTreeSha);
	equal(graphMode(h.state.graphs.get(h.sha)!), "scan");
	// And back.
	const again = await createRepoProbe({ ...h.deps, graphMemo: new Map() })
		.projectGraph(REPO, h.sha);
	deepStrictEqual(again, off);
});

Deno.test("storedExtras keeps exactly the cuenv graph fields", () => {
	const graph = {
		sha: "a".repeat(40),
		manifestsTreeSha: "b".repeat(64),
		projects: [],
		globalFiles: [],
		configKey: "off",
		detector: "cuenv",
		fidelity: "scan",
		layers: [{ root: "", paths: ["env.cue"] }],
		skipped: ["x"],
		warnings: [],
		truncated: true,
		packages: { "env.cue": "cuenv" },
		rootProject: { name: "r" },
		unrelated: 1,
	} as unknown as ProjectGraph;
	deepStrictEqual(storedExtras(graph), {
		detector: "cuenv",
		fidelity: "scan",
		layers: [{ root: "", paths: ["env.cue"] }],
		skipped: ["x"],
		warnings: [],
		truncated: true,
		packages: { "env.cue": "cuenv" },
		rootProject: { name: "r" },
	});
});

Deno.test("RepoDO probe module: a cuenv graph round-trips with its fields; a duplicate pair fits the mirror", async () => {
	const storage = createTestStorage();
	for (const m of PROBE_MIGRATIONS) storage.sql.exec(m.sql);
	const { facade, internal } = createProbeModule(
		{
			sql: storage.sql,
			storage,
			ctx: { storage } as unknown as DurableObjectState,
			clock: { now: () => 1_000 },
		} as unknown as ModuleDeps<Env, RepoInternals>,
	);
	const h = harnessOf({
		"cue.mod/module.cue": 'module: "example.com/m"\n',
		"a/env.cue": 'package cuenv\n\nschema.#Project\nname: "api"\n',
		"b/env.cue": 'package cuenv\n\nschema.#Project\nname: "api"\n',
		"env.cue": "package cuenv\n\nschema.#Base\n",
	});
	const graph = await createRepoProbe({ ...h.deps, projects: "scan" })
		.projectGraph(REPO, h.sha);
	await facade.putProjects(graph);
	const back = v031((await facade.projects(h.sha))!);
	deepStrictEqual(back, v031(graph));
	deepStrictEqual(back.projects.map((p) => [p.name, p.cuenvName]), [
		["api", undefined],
		["api@b", "api"],
	]);
	deepStrictEqual(back.layers, [{ root: "", paths: ["env.cue"] }]);
	const mirrored = storage.sql.exec<{ name: string; source: string }>(
		"SELECT name, source FROM projects ORDER BY name",
	).toArray();
	deepStrictEqual(mirrored.map((r) => [r.name, r.source]), [
		["api", "cuenv"],
		["api@b", "cuenv"],
	]);
	deepStrictEqual(internal.projectsSync(graph.manifestsTreeSha), graph);
});
