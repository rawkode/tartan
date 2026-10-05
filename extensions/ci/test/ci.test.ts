// tartan.ci in isolation, through ext-api's host-like harness with scripted
// caps (no fixture repos: those flows are in `packages/pipeline/test/`).

import {
	CiJobGraphSchema,
	type Envelope,
	type ProjectGraph,
	validateUi,
} from "@tartan/contract";
import { createTestHarness } from "@tartan/ext-api/testing.ts";
import { ciConfigOf, DEFAULT_IMAGE } from "../src/ci.ts";
import { extension, migrations } from "../src/index.ts";
import { testCommandsOf } from "../src/policy.ts";
import { zeroPipeline } from "../src/pipeline/index.ts";
import { equal, ok } from "./assert.ts";

const REPO = "01k6rrrrrrrrrrrrrrrrrrrrrr";
const LANE = `ln_01k6${"1".repeat(22)}`;
const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const CHANGE = "k".repeat(32);

const GRAPH: ProjectGraph = {
	sha: BASE,
	manifestsTreeSha: "0".repeat(64),
	projects: [
		{
			name: "api",
			root: "services/api",
			deps: [],
			dependents: [],
			owners: [],
			sensitive: false,
			source: "go.work",
			testCmd: "go test ./...",
			manifestPath: "services/api/go.mod",
		},
		{
			name: "web",
			root: "apps/web",
			deps: [],
			dependents: [],
			owners: [],
			sensitive: false,
			source: "go.work",
			testCmd: "go test ./...",
			manifestPath: "apps/web/go.mod",
		},
	],
	globalFiles: [{ glob: "*.cue", source: "detector-default" }],
};

const event = (type: string, data: unknown, kernel = true): Envelope => ({
	id: "01k6eeeeeeeeeeeeeeeeeeeeee",
	seq: 1,
	stream: `repo:${REPO}`,
	type,
	v: 1,
	source: kernel
		? { kind: "kernel" }
		: { kind: "installation", id: "i_01k6gggggggggggggggggggggg", ext: "x@1" },
	actor: { kind: "agent", id: "a_01k6aaaaaaaaaaaaaaaaaaaaaa" },
	node: REPO,
	repo: REPO,
	depth: 0,
	shadow: false,
	at: 0,
	data,
});

const harness = () => {
	const starts: unknown[] = [];
	const h = createTestHarness({
		module: extension,
		migrations,
		grants: {
			repo: "read",
			runs: ["start", "cancel"],
			"land.report": true,
			notify: true,
			"events.read": ["changes.*", "land.*", "run.*", "job.*", "push.*"],
		},
		install: { scopeKey: `repo:${REPO}`, extId: "tartan.ci" },
		handlers: {
			"repo.readFile": () => null,
			// No config of package tartan at the base: zero-config.
			"repo.policy": () => ({ state: "none" }),
			// Trunk has no commit yet: change checks read the base.
			"repo.info": () => ({ id: REPO, trunkSha: null }),
			"repo.projectGraph": () => GRAPH,
			"repo.diffPaths": () => ({
				paths: [{ path: "apps/web/main.go", change: "modified" }],
				truncated: false,
			}),
			"repo.treeHash": (_r: unknown, _sha: string, path: string) =>
				`${path.length}`.padStart(40, "0"),
			"repo.readTree": () => [],
			"runs.start": (g: unknown) => {
				starts.push(g);
				return { runId: `run-${starts.length}` };
			},
		},
	});
	return { h, starts };
};

Deno.test("ci: the graph handed to runs.start is a valid CiJobGraph", async () => {
	const { h, starts } = harness();
	await h.event(event("changes.submitted", {
		changeId: CHANGE,
		laneId: LANE,
		revision: 1,
		head: HEAD,
		base: BASE,
		affected: [],
	}, false));
	equal(starts.length, 1);
	const { idemKey: _key, ...graph } = starts[0] as { idemKey: string };
	const parsed = CiJobGraphSchema.safeParse(graph);
	ok(parsed.success, JSON.stringify(parsed.error?.issues));
	equal((graph as { jobs: { id: string }[] }).jobs.map((j) => j.id), [
		"test-web",
	]);
	equal((graph as { image: string }).image, DEFAULT_IMAGE);
});

Deno.test("ci: land.testing and push.diffed only from the kernel", async () => {
	const { h, starts } = harness();
	await h.event(event("land.testing", {
		batchId: "lb_01k6bbbbbbbbbbbbbbbbbbbbbb",
		attempt: 1,
		candidateSha: HEAD,
		base: BASE,
		affected: ["web"],
	}, false));
	equal(starts.length, 0);
	equal(h.recorder.calls.length, 0);
});

Deno.test("ci: config and test commands", () => {
	equal(ciConfigOf({ image: "custom@sha256:1" }).image, "custom@sha256:1");
	equal(ciConfigOf({ image: "" }).image, DEFAULT_IMAGE);
	equal(ciConfigOf(null).image, DEFAULT_IMAGE);
	const pipeline = zeroPipeline({
		projects: [
			{
				name: "api",
				root: "services/api",
				run: "go test ./...",
				cwd: "services/api",
				node: false,
			},
		],
	});
	equal(
		testCommandsOf({
			mode: "zero",
			sha: BASE,
			graph: GRAPH,
			pipeline,
			zero: { projects: [] },
		}),
		[
			{
				project: "api",
				root: "services/api",
				commands: [{
					context: "test:api",
					run: "go test ./...",
					cwd: "services/api",
				}],
			},
		],
	);
});

Deno.test("ci: renders without data are valid empty states", async () => {
	const { h } = harness();
	await h.init();
	const x = h.ctx({
		readOnly: true,
		actor: { kind: "user", id: "u_01k6vvvvvvvvvvvvvvvvvvvvvv" },
	});
	for (const slot of ["checks", "ci", "projects", "unknown"]) {
		const doc = await extension.render!(
			slot,
			{ node: REPO, mode: "enforce" },
			{},
			x,
		);
		ok(validateUi(doc).ok, slot);
	}
	equal(
		await extension.context!({
			repo: "acme/r",
			repoId: REPO,
			maxBytes: 2048,
			actor: { kind: "agent", id: "a_01k6aaaaaaaaaaaaaaaaaaaaaa" },
		}, x),
		[],
	);
});
