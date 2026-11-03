// Mock API fixtures, typed from contract DTOs (WP18: mock API fixtures until
// kernel endpoints merge). Used by `VITE_TARTAN_MOCK=1` builds and the
// component tests. Extensions come from a catalog (`catalog.ts`): none by
// default.

import type {
	AgentDto,
	CommitResponse,
	EnvironmentCheck,
	HealthResponse,
	NodeDto,
	RepoLaneSettingsDto,
	ViewerDto,
	ViewResponse,
} from "@tartan/contract/api.ts";
import type { CommitMeta, FileDiff, TreeEntry } from "@tartan/contract/git.ts";
import type { ForgeSettingsDto } from "../types.ts";
import { EMPTY_CATALOG, type MockCatalog } from "./catalog.ts";

export const MOCK_NOW = Date.UTC(2026, 9, 2, 16, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

/** A lowercase ULID-shaped id (`0` + 25 chars of the Crockford alphabet). */
export const mockUlid = (n: number): string =>
	`01k6g${String(n).padStart(21, "0")}`;

export const OWNER_ID = `u_${mockUlid(1)}`;
export const REPO_ID = mockUlid(40);
export const CHANGE_ID = "kqzvmxrstnpwylokqzvmxrstnpwylokq".slice(0, 32);
export const DEFAULT_BRANCH = "main";

const sha = (seed: string): string =>
	Array.from(
		{ length: 40 },
		(_, i) =>
			"0123456789abcdef"[(seed.charCodeAt(i % seed.length) * (i + 7)) % 16],
	).join("");

export const SHAS = {
	genesis: sha("genesis"),
	c1: sha("rate-limits"),
	c2: sha("router-split"),
	c3: sha("web-shell"),
	lane: sha("lane-head"),
} as const;

// ---------------------------------------------------------------------------
// Forge, viewer, health
// ---------------------------------------------------------------------------

export const OWNER_VIEWER: ViewerDto = {
	principal: {
		id: OWNER_ID,
		handle: "rawkode",
		display: "David Flanagan",
		kind: "user",
	},
	role: 50,
	isAdmin: true,
};

export const ANONYMOUS_VIEWER: ViewerDto = { role: 0, isAdmin: false };

export const HEALTH: HealthResponse = {
	ok: true,
	product: "Tartan",
	version: "0.1.0",
	compatDate: "2026-08-15",
	stage: "dev",
	setupState: "done",
	bindings: {
		ARTIFACTS: "ok",
		LOADER: "ok",
		SANDBOX: "ok",
		AI: "ok",
		BLOBS: "ok",
	},
};

export const SETUP_CHECKS: readonly EnvironmentCheck[] = [
	{
		id: "artifacts",
		phase: "setup",
		ok: true,
		optional: false,
		message: "Artifacts is enabled on this account.",
	},
	{
		id: "loader",
		phase: "setup",
		ok: true,
		optional: false,
		message: "Dynamic Workers round-trip in 41 ms.",
	},
	{
		id: "containers",
		phase: "setup",
		ok: true,
		optional: true,
		message: "git 2.47.1 in the sandbox; merge-tree works.",
	},
	{
		id: "ai",
		phase: "setup",
		ok: true,
		optional: true,
		message: "Workers AI answered.",
	},
	{
		id: "r2",
		phase: "setup",
		ok: true,
		optional: false,
		message: "BLOBS put/get works.",
	},
	{
		id: "origin",
		phase: "setup",
		ok: false,
		optional: true,
		message: "This forge is served from *.workers.dev.",
		hint:
			"Attach your custom domain first; the OIDC redirect URI and the lane capability URLs use this origin.",
	},
];

export const FORGE_SETTINGS: ForgeSettingsDto = {
	forgeName: "Rawkode Academy",
	canonicalOrigin: "https://code.rawkode.academy",
	idp: {
		issuer: "https://id.rawkode.academy",
		clientId: "tartan-dev-8f2c",
		clientAuth: "none",
		lockedByVars: false,
	},
	pushLimits: {
		maxPushBytes: 95 * 1024 * 1024,
		maxObjectBytes: 31 * 1024 * 1024,
	},
	laneMode: "branch",
	maxLaneReposForge: 5000,
	retainedLaneRepos: 0,
	rootKeyFallback: true,
};

// ---------------------------------------------------------------------------
// Hierarchy
// ---------------------------------------------------------------------------

const node = (
	n: number,
	parentId: string | null,
	kind: NodeDto["kind"],
	path: string,
	extra: Partial<NodeDto> = {},
): NodeDto => ({
	id: mockUlid(n),
	parentId,
	kind,
	slug: path.split("/").at(-1) ?? path,
	path,
	depth: path.split("/").length - 1,
	visibility: "internal",
	archived: false,
	createdAt: MOCK_NOW - 30 * 24 * HOUR,
	...extra,
});

export const NODES: readonly NodeDto[] = [
	node(10, null, "user", "rawkode", { description: "Owner's namespace" }),
	node(11, null, "group", "acme", { description: "Acme Corp" }),
	node(12, mockUlid(11), "group", "acme/platform", {
		description: "Platform team",
	}),
	node(13, mockUlid(11), "group", "acme/docs"),
	node(40, mockUlid(12), "repo", "acme/platform/router", {
		id: REPO_ID,
		defaultBranch: DEFAULT_BRANCH,
		description: "Sample monorepo: api, web and shared packages",
		visibility: "public",
	}),
	node(41, mockUlid(12), "repo", "acme/platform/billing", {
		defaultBranch: DEFAULT_BRANCH,
	}),
	node(42, mockUlid(13), "repo", "acme/docs/handbook", {
		defaultBranch: DEFAULT_BRANCH,
	}),
	...Array.from(
		{ length: 30 },
		(_, i) =>
			node(
				100 + i,
				mockUlid(11),
				"group",
				`acme/team-${String(i + 1).padStart(2, "0")}`,
			),
	),
];

export const nodeByPath = (path: string): NodeDto | undefined =>
	NODES.find((n) => n.path === path);

// ---------------------------------------------------------------------------
// Repo content
// ---------------------------------------------------------------------------

const entry = (path: string, type: TreeEntry["type"]): TreeEntry => ({
	name: path.split("/").at(-1) ?? path,
	path,
	mode: type === "tree" ? "040000" : "100644",
	hash: sha(path),
	type,
});

export const FILES: Readonly<Record<string, string>> = {
	"README.md":
		"# router\n\nSample monorepo (pnpm): `packages/shared`, `services/api`, `apps/web`.\n",
	"package.json":
		'{\n\t"name": "router",\n\t"private": true,\n\t"workspaces": ["packages/*", "services/*", "apps/*"]\n}\n',
	"tartan.cue": "package tartan\n\nextensions: {}\n",
	"packages/shared/index.ts":
		"export const limit = (n: number): number => Math.min(n, 100);\n",
	"services/api/src/server.ts": [
		'import { limit } from "@router/shared";',
		"",
		"export const handle = (req: Request): Response => {",
		"\tconst url = new URL(req.url);",
		'\tconst n = limit(Number(url.searchParams.get("n") ?? 10));',
		"\treturn Response.json({ n });",
		"};",
		"",
	].join("\n"),
	"apps/web/src/main.ts": 'console.log("web");\n',
	"apps/web/public/logo.png": "",
};

export const BINARY_FILES: ReadonlySet<string> = new Set([
	"apps/web/public/logo.png",
]);

export const treeEntries = (dir: string): TreeEntry[] | null => {
	const prefix = dir === "" ? "" : `${dir}/`;
	const paths = Object.keys(FILES).filter((p) => p.startsWith(prefix));
	if (paths.length === 0) return null;
	const seen = new Map<string, TreeEntry>();
	for (const p of paths) {
		const rest = p.slice(prefix.length);
		const [head, ...tail] = rest.split("/");
		if (!head) continue;
		const path = `${prefix}${head}`;
		if (!seen.has(path)) {
			seen.set(path, entry(path, tail.length > 0 ? "tree" : "blob"));
		}
	}
	return [...seen.values()].sort((a, b) =>
		a.type === b.type
			? a.name.localeCompare(b.name)
			: a.type === "tree"
			? -1
			: 1
	);
};

const person = { name: "Claude (agent)", email: "claude-1@agents.tartan" };
const human = { name: "David Flanagan", email: "david@example.com" };

const commit = (
	shaValue: string,
	parent: string | null,
	subject: string,
	at: number,
	trailers: { key: string; value: string }[] = [],
	author = person,
): CommitMeta => ({
	sha: shaValue,
	treeSha: sha(`${shaValue}-tree`),
	subject,
	message: `${subject}\n\n${
		trailers.map((t) => `${t.key}: ${t.value}`).join("\n")
	}`,
	author,
	committer: { name: "Tartan", email: "kernel@tartan" },
	parents: parent ? [parent] : [],
	authoredAt: Math.floor(at / 1000),
	committedAt: Math.floor(at / 1000),
	trailers,
});

export const COMMITS: readonly CommitMeta[] = [
	commit(
		SHAS.c3,
		SHAS.c2,
		"web: app shell and theme toggle",
		MOCK_NOW - 2 * HOUR,
		[
			{ key: "Tartan-Advance", value: "adv_3" },
			{ key: "Tartan-Agent", value: "a_codex-1" },
		],
	),
	commit(
		SHAS.c2,
		SHAS.c1,
		"api: split router into modules",
		MOCK_NOW - 5 * HOUR,
		[
			{ key: "Tartan-Advance", value: "adv_2" },
			{ key: "Tartan-Work", value: "w_17" },
		],
	),
	commit(
		SHAS.c1,
		SHAS.genesis,
		"api: rate limits on /n",
		MOCK_NOW - 26 * HOUR,
		[
			{ key: "Tartan-Advance", value: "adv_1" },
			{ key: "Change-Id", value: CHANGE_ID },
		],
	),
	commit(SHAS.genesis, null, "Initial commit", MOCK_NOW - 30 * 24 * HOUR, [
		{ key: "Tartan-Advance", value: "adv_0" },
	], human),
];

const PATCH_SERVER = [
	"diff --git a/services/api/src/server.ts b/services/api/src/server.ts",
	"--- a/services/api/src/server.ts",
	"+++ b/services/api/src/server.ts",
	"@@ -1,6 +1,7 @@",
	'+import { limit } from "@router/shared";',
	"",
	" export const handle = (req: Request): Response => {",
	" \tconst url = new URL(req.url);",
	'-\tconst n = Number(url.searchParams.get("n") ?? 10);',
	'+\tconst n = limit(Number(url.searchParams.get("n") ?? 10));',
	" \treturn Response.json({ n });",
	" };",
].join("\n");

export const FILE_DIFFS: readonly FileDiff[] = [
	{
		path: "services/api/src/server.ts",
		change: "modified",
		binary: false,
		additions: 2,
		deletions: 1,
		hunks: [{ oldStart: 1, oldLines: 6, newStart: 1, newLines: 7 }],
		patch: PATCH_SERVER,
	},
	{
		path: "packages/shared/index.ts",
		change: "added",
		binary: false,
		additions: 1,
		deletions: 0,
		hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1 }],
		patch:
			"diff --git a/packages/shared/index.ts b/packages/shared/index.ts\nnew file mode 100644\n--- /dev/null\n+++ b/packages/shared/index.ts\n@@ -0,0 +1 @@\n+export const limit = (n: number): number => Math.min(n, 100);",
	},
];

export const commitResponse = (shaValue: string): CommitResponse | null => {
	const meta = COMMITS.find((c) =>
		c.sha === shaValue || c.sha.startsWith(shaValue)
	);
	return meta
		? { repo: "acme/platform/router", commit: meta, files: FILE_DIFFS }
		: null;
};

export const LANE_SETTINGS: RepoLaneSettingsDto = {
	laneMode: "branch",
	effectiveMode: "branch",
	trunkPackBytes: 4_812_334,
	maxActiveLanes: 2000,
	atticRetentionDays: 7,
	retainedLaneRepos: 0,
	maxLaneReposForge: 5000,
};

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export const AGENTS: readonly AgentDto[] = [
	{
		id: `a_${mockUlid(201)}`,
		handle: "claude-1",
		display: "Claude Code (laptop)",
		tool: "claude-code",
		model: "claude-opus",
		ownerUserId: OWNER_ID,
		createdAt: MOCK_NOW - 3 * 24 * HOUR,
		disabled: false,
		tokens: [{
			id: `t_${mockUlid(301)}`,
			nodePath: "acme/platform",
			maxRole: 30,
			expiresAt: MOCK_NOW + 4 * 24 * HOUR,
			lastUsedAt: MOCK_NOW - 3 * MIN,
			revoked: false,
		}],
	},
	{
		id: `a_${mockUlid(202)}`,
		handle: "codex-1",
		display: "Codex CLI",
		tool: "codex",
		ownerUserId: OWNER_ID,
		createdAt: MOCK_NOW - 2 * 24 * HOUR,
		disabled: false,
		tokens: [{
			id: `t_${mockUlid(302)}`,
			nodePath: "acme/platform/router",
			maxRole: 30,
			expiresAt: MOCK_NOW + 5 * 24 * HOUR,
			revoked: false,
		}],
	},
];

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const repoInfo = {
	id: REPO_ID,
	defaultBranch: DEFAULT_BRANCH,
	trunkSha: SHAS.c3,
	landingPaused: false,
};

/**
 * What the kernel's `/-/api/view` answers for a node and view
 * (src/kernel/exthost/api/view.ts): the node, its repo, and what the
 * catalog's installations contribute there.
 */
export const viewFor = (
	path: string,
	view: string,
	catalog: MockCatalog = EMPTY_CATALOG,
): ViewResponse | null => {
	const target = nodeByPath(path);
	if (!target) return null;
	const c = catalog.contribute(target, view);
	return {
		node: target,
		viewer: OWNER_VIEWER,
		view,
		...(target.kind === "repo" ? { repo: { ...repoInfo, id: target.id } } : {}),
		static: {
			tabs: [...(c.tabs ?? [])],
			nav: [...(c.nav ?? [])],
			actions: [...(c.actions ?? [])],
		},
		slots: [...(c.slots ?? [])],
		banners: [],
	};
};

export const MOCK_LIVE_EVENT_TYPES = [
	"checks.updated",
	"conflicts.escalated",
	"queue.updated",
] as const;
