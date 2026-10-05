// Input hashes for the result cache: stable,
// sensitive to the project's dependency closure and global files, blind to
// unrelated projects, and equal for a lane head and a land candidate with the
// same project subtrees.

import { deepStrictEqual, equal, notEqual, ok } from "node:assert/strict";
import {
	affectedOn,
	canonicalJson,
	inputHashes,
	OUTSIDE_WALK_MAX,
	outsideRoots,
	planJobs,
	validatePipeline,
} from "../src/index.ts";
import {
	createMemRepo,
	DEMO_PIPELINE,
	DEMO_TARTAN,
	PNPM_REPO,
	withFiles,
} from "./repo.ts";

const repo = createMemRepo();
const BASE = withFiles(PNPM_REPO, { "tartan.cue": DEMO_TARTAN });
const parsed = validatePipeline(DEMO_PIPELINE);
if (!parsed.ok) throw new Error("demo pipeline");

const hashesAt = async (files: typeof BASE, projects: string[]) => {
	const graph = await repo.graph(BASE);
	const plan = planJobs(
		parsed.pipeline,
		graph,
		{ projects, global: false },
		"change",
	);
	if (!plan.ok) throw new Error(plan.error);
	return await inputHashes(
		plan.plan.jobs,
		graph,
		"tartan-runner",
		repo.treeHasher(files),
		repo.treeLister(files),
	);
};

Deno.test("hash: canonical JSON sorts keys and drops undefined", () => {
	equal(
		canonicalJson({ b: 1, a: [2, { d: undefined, c: 3 }] }),
		'{"a":[2,{"c":3}],"b":1}',
	);
});

Deno.test("hash: stable, 64 hex, and per job", async () => {
	const a = await hashesAt(BASE, ["api", "web"]);
	const b = await hashesAt(BASE, ["api", "web"]);
	deepStrictEqual(a, b);
	for (const h of a.values()) ok(/^[0-9a-f]{64}$/.test(h));
	notEqual(a.get("test-api"), a.get("test-web"));
	notEqual(a.get("test-api"), a.get("lint-api"));
});

Deno.test("hash: a web edit leaves api's hash alone; a shared edit changes both", async () => {
	const before = await hashesAt(BASE, ["api", "web"]);
	const web = await hashesAt(
		withFiles(BASE, { "apps/web/src/main.ts": "import 'shared'; // 2\n" }),
		["api", "web"],
	);
	equal(web.get("test-api"), before.get("test-api"));
	notEqual(web.get("test-web"), before.get("test-web"));
	notEqual(web.get("install"), before.get("install"));
	const shared = await hashesAt(
		withFiles(BASE, {
			"packages/shared/src/index.ts": "export const x = 9;\n",
		}),
		["api", "web"],
	);
	notEqual(shared.get("test-api"), before.get("test-api"));
	notEqual(shared.get("test-web"), before.get("test-web"));
});

Deno.test("hash: a global file change invalidates every project job", async () => {
	const before = await hashesAt(BASE, ["api"]);
	const lock = await hashesAt(
		withFiles(BASE, { "pnpm-lock.yaml": "lockfileVersion: '9.9'\n" }),
		["api"],
	);
	notEqual(lock.get("test-api"), before.get("test-api"));
});

Deno.test("hash: a lane head and a candidate with the same api subtree share test-api's hash", async () => {
	const edit = {
		"services/api/src/middleware/limit.ts": "export const limit = 7;\n",
	};
	const lane = await hashesAt(withFiles(BASE, edit), ["api"]);
	// The candidate also carries another change's web edit.
	const candidate = await hashesAt(
		withFiles(BASE, {
			...edit,
			"apps/web/src/main.ts": "import 'shared'; // c\n",
		}),
		["api", "web"],
	);
	equal(candidate.get("test-api"), lane.get("test-api"));
	notEqual(candidate.get("install"), lane.get("install"));
	const graph = await repo.graph(BASE);
	deepStrictEqual(
		affectedOn(graph, ["services/api/src/middleware/limit.ts"]).projects,
		["api"],
	);
});

Deno.test("hash: the image id is part of every hash", async () => {
	const graph = await repo.graph(BASE);
	const plan = planJobs(parsed.pipeline, graph, {
		projects: ["api"],
		global: false,
	}, "change");
	if (!plan.ok) throw new Error(plan.error);
	const a = await inputHashes(
		plan.plan.jobs,
		graph,
		"img-a",
		repo.treeHasher(BASE),
		repo.treeLister(BASE),
	);
	const b = await inputHashes(
		plan.plan.jobs,
		graph,
		"img-b",
		repo.treeHasher(BASE),
		repo.treeLister(BASE),
	);
	notEqual(a.get("test-api"), b.get("test-api"));
});

Deno.test("a change only to an out-of-root file (global) changes every project job's hash", async () => {
	const files = withFiles(BASE, {
		"tsconfig.base.json": '{"compilerOptions":{}}\n',
		"vitest.workspace.ts": "export default ['services/*'];\n",
	});
	const graph = await repo.graph(files);
	const before = await hashesAt(files, ["api", "web", "shared"]);
	const edits: [string, string][] = [
		["tsconfig.base.json", '{"compilerOptions":{"strict":true}}\n'],
		["vitest.workspace.ts", "export default [];\n"],
		["docs/notes.md", "new\n"],
	];
	for (const [path, text] of edits) {
		const edit = { [path]: text };
		const affected = affectedOn(graph, [path]);
		equal(affected.global, true, path);
		const after = await hashesAt(withFiles(files, edit), [
			"api",
			"web",
			"shared",
		]);
		for (const [job, hash] of before) {
			if (job === "install") continue;
			notEqual(after.get(job), hash, `${path}: ${job} must not be cached`);
		}
	}
});

Deno.test("outsideRoots lists only entries outside every root, descending only into directories that hold one", async () => {
	const lister = repo.treeLister(withFiles(BASE, {
		"tsconfig.base.json": "{}\n",
		"packages/README.md": "packages\n",
	}));
	const listed: string[] = [];
	const entries = await outsideRoots(
		["packages/shared", "services/api", "apps/web"],
		(path) => {
			listed.push(path);
			return lister(path);
		},
	);
	deepStrictEqual(entries?.map(([p]) => p), [
		"package.json",
		"packages/README.md",
		"pnpm-lock.yaml",
		"pnpm-workspace.yaml",
		"tartan.cue",
		"tsconfig.base.json",
	]);
	deepStrictEqual(listed.sort(), ["", "apps", "packages", "services"]);
	deepStrictEqual(await outsideRoots([""], lister), []);
	// Too many directories to walk: null (the caller hashes the whole tree).
	const deep = Array.from(
		{ length: OUTSIDE_WALK_MAX + 1 },
		(_, i) => `d${i}/p`,
	);
	equal(
		await outsideRoots(
			deep,
			(path) =>
				Promise.resolve(
					path === ""
						? deep.map((r) => ({
							path: r.split("/")[0],
							hash: "0".repeat(40),
							type: "tree",
						}))
						: [],
				),
		),
		null,
	);
});

Deno.test("hash: a root *.cue edit (any package) invalidates every project job; a subdirectory .cue file only its project", async () => {
	const before = await hashesAt(BASE, ["api", "web"]);
	const env = await hashesAt(
		withFiles(BASE, { "env.cue": "package cuenv\n" }),
		["api", "web"],
	);
	notEqual(env.get("test-api"), before.get("test-api"));
	notEqual(env.get("test-web"), before.get("test-web"));
	const sub = await hashesAt(
		withFiles(BASE, { "apps/web/config.cue": "package web\n" }),
		["api", "web"],
	);
	equal(sub.get("test-api"), before.get("test-api"));
	notEqual(sub.get("test-web"), before.get("test-web"));
});
