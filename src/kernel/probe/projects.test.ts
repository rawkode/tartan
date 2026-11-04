// RepoProbe and RepoDO's probe module: RepoProbe computes the graph of a commit
// once and RepoDO keeps its fields; a graph from an earlier detector is
// recomputed; a duplicate-name pair goes through the `projects` mirror (its
// `name` primary key).

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import type { ProjectGraph } from "@tartan/contract";
import type { ModuleDeps, RepoInternals } from "@tartan/contract/kernel.ts";
import { createMemGit } from "../../../packages/monorepo/test/memgit.ts";
import {
	TARTAN_DEMO_FILES,
	TARTAN_DEMO_PROJECTS,
} from "../../../packages/monorepo/test/fixtures/tartan-demo.ts";
import type { Env } from "../../env.ts";
import { createTestStorage } from "../tree/testing/sqlite.ts";
import { createProbeModule, PROBE_MIGRATIONS } from "./module.ts";
import { createRepoProbe } from "./probe.ts";
import { isCurrentGraph, storedExtras } from "./projects.ts";
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

Deno.test("RepoProbe computes the graph at a commit once; the second read does not re-detect", async () => {
	const h = harnessOf(TARTAN_DEMO_FILES);
	const probe = createRepoProbe(h.deps);
	const graph = await probe.projectGraph(REPO, h.sha);
	equal(graph.projects.length, TARTAN_DEMO_PROJECTS.length);
	equal(graph.detector, "tartan");
	equal(graph.fidelity, "scan");
	equal(graph.configKey, "off");
	ok(isCurrentGraph(graph));
	ok(h.state.graphs.has(h.sha));
	const reads = h.store.calls.length;
	ok(reads > 0, "the first read walked the tree");
	// Another isolate, with no memo: served from RepoDO's cache.
	deepStrictEqual(
		await createRepoProbe({ ...h.deps, graphMemo: new Map() }).projectGraph(
			REPO,
			h.sha,
		),
		graph,
	);
	equal(h.store.calls.length, reads, "no object read on the second graph read");
	deepStrictEqual(
		await probe.affected(REPO, h.sha, h.sha, { graphAt: h.sha }),
		{ projects: [], global: false },
	);
});

Deno.test("a tree with no package tartan directory has no projects, whatever workspace it declares", async () => {
	const h = harnessOf({
		"package.json": '{"name":"x","workspaces":["p/*"]}\n',
		"p/a/package.json": '{"name":"a"}\n',
		"tartan.cue": "package tartan\n",
	});
	const graph = await createRepoProbe(h.deps).projectGraph(REPO, h.sha);
	deepStrictEqual(graph.projects, []);
	equal(graph.detector, "tartan");
});

Deno.test("a stored graph from an earlier detector is recomputed", async () => {
	const h = harnessOf(TARTAN_DEMO_FILES);
	h.state.graphs.set(h.sha, {
		sha: h.sha,
		manifestsTreeSha: "b".repeat(64),
		projects: [],
		globalFiles: [],
		configKey: "off",
		detector: "cuenv",
	} as unknown as ProjectGraph);
	const graph = await createRepoProbe(h.deps).projectGraph(REPO, h.sha);
	equal(graph.detector, "tartan");
	equal(graph.projects.length, TARTAN_DEMO_PROJECTS.length);
	equal(h.state.graphs.get(h.sha)?.detector, "tartan");
});

Deno.test("storedExtras keeps exactly the detector's graph fields", () => {
	const graph = {
		sha: "a".repeat(40),
		manifestsTreeSha: "b".repeat(64),
		projects: [],
		globalFiles: [],
		configKey: "off",
		detector: "tartan",
		fidelity: "scan",
		skipped: ["x"],
		warnings: [],
		truncated: true,
		packages: { "a/forge.cue": "tartan" },
		unrelated: 1,
	} as unknown as ProjectGraph;
	deepStrictEqual(storedExtras(graph), {
		detector: "tartan",
		fidelity: "scan",
		skipped: ["x"],
		warnings: [],
		truncated: true,
		packages: { "a/forge.cue": "tartan" },
	});
});

Deno.test("RepoDO probe module: a graph round-trips with its fields; a duplicate pair fits the mirror", async () => {
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
		"a/forge.cue": 'package tartan\n\nname: "api"\n',
		"b/forge.cue": 'package tartan\n\nname: "api"\n',
	});
	const graph = await createRepoProbe(h.deps).projectGraph(REPO, h.sha);
	await facade.putProjects(graph);
	const back = (await facade.projects(h.sha))!;
	deepStrictEqual(back, graph);
	deepStrictEqual(back.projects.map((p) => [p.name, p.declaredName]), [
		["api", undefined],
		["api@b", "api"],
	]);
	const mirrored = storage.sql.exec<{ name: string; source: string }>(
		"SELECT name, source FROM projects ORDER BY name",
	).toArray();
	deepStrictEqual(mirrored.map((r) => [r.name, r.source]), [
		["api", "tartan"],
		["api@b", "tartan"],
	]);
	deepStrictEqual(internal.projectsSync(graph.manifestsTreeSha), graph);
});
