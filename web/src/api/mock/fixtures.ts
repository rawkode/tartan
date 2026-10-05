// Mock API fixtures, typed from contract DTOs (WP18: mock API fixtures until
// kernel endpoints merge). Used by `VITE_TARTAN_MOCK=1` builds and the
// component tests. Every slot document here must pass the contract's
// `validateUi()` (`test/fixtures.spec.ts`).

import type {
	AgentDto,
	CommitResponse,
	EnvironmentCheck,
	HealthResponse,
	InstallationDto,
	NodeDto,
	PackageDto,
	RepoLaneSettingsDto,
	SlotInstanceDto,
	StaticContributionDto,
	ViewerDto,
	ViewResponse,
} from "@tartan/contract/api.ts";
import type { CommitMeta, FileDiff, TreeEntry } from "@tartan/contract/git.ts";
import type { Manifest } from "@tartan/contract/manifest.ts";
import type { UiDoc } from "@tartan/contract/ui.ts";
import type { ForgeSettingsDto } from "../types.ts";
import { HUD_DOCS } from "./hud.ts";

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
	"tartan.cue": [
		"package tartan",
		"",
		'extensions: "tartan.ci": settings: pipeline: {',
		'\tjobs: test: { each: "affected", cwd: "{{project.root}}", run: "pnpm test" }',
		'\ton: change: ["test"]',
		"}",
		"",
	].join("\n"),
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
// Extensions
// ---------------------------------------------------------------------------

const manifest = (
	id: string,
	name: string,
	description: string,
	extra: Partial<Manifest> = {},
): Manifest => ({
	schema: 1,
	kind: "extension",
	id,
	name,
	description,
	version: "0.1.0",
	api: "tartan:ext@0.1.0",
	runtime: "builtin",
	entry: { builtin: id },
	storage: { scope: "repo", mode: "sql", quotaMB: 256 },
	permissions: { repo: "read" },
	backfill: "none",
	onError: "skip",
	...extra,
});

const pkg = (m: Manifest): PackageDto => ({
	extId: m.id,
	version: m.version,
	runtime: m.runtime,
	manifest: m,
	sha256: sha(m.id).repeat(2).slice(0, 64),
	publishedBy: "sys_kernel",
	publishedAt: MOCK_NOW - 30 * 24 * HOUR,
	bundled: true,
});

export const PACKAGES: readonly PackageDto[] = [
	pkg(
		manifest(
			"tartan.work",
			"Work",
			"Work items, claims and footprints (work@1)",
			{
				permissions: { repo: "read", lanes: ["open"], notify: true },
			},
		),
	),
	pkg(
		manifest(
			"tartan.changes",
			"Changes",
			"Changes, revisions and threads (changes@1)",
		),
	),
	pkg(
		manifest(
			"tartan.radar",
			"Conflict Radar",
			"Predicts conflicts between lanes (conflicts@1)",
			{
				permissions: {
					repo: "read",
					notes: true,
					notify: true,
					"events.read": ["lane.*", "push.*"],
				},
			},
		),
	),
	pkg(manifest("tartan.ci", "CI", "Affected-only CI in sandboxes", {
		permissions: { repo: "read", runs: ["start", "cancel"] },
	})),
	pkg(
		manifest("tartan.review", "Review", "Review routing and evidence bundles"),
	),
	pkg(
		manifest(
			"tartan.weave",
			"Weave",
			"Merge queue: serial trains to trunk (queue@1)",
			{
				provides: ["queue@1"],
				permissions: {
					repo: "read",
					land: ["refs/heads/main"],
					"land.report": true,
				},
				contributes: {
					settings: {
						type: "object",
						properties: {
							trainSize: { type: "integer", title: "Train size", default: 1 },
							label: {
								type: "string",
								title: "Queue label <script>",
								default: "main",
							},
						},
					},
				},
			},
		),
	),
	pkg(
		manifest(
			"tartan.fifo",
			"FIFO",
			"Merge queue: first in, first out, one change at a time (queue@1)",
			{
				provides: ["queue@1"],
				permissions: {
					repo: "read",
					land: ["refs/heads/main"],
					"land.report": true,
				},
			},
		),
	),
	...([
		[
			"tartan.pack.swarm",
			"Swarm",
			"Agent swarm protocol: claims, lanes, radar, review by exception, Weave",
			[
				"tartan.work",
				"tartan.changes",
				"tartan.radar",
				"tartan.ci",
				"tartan.review",
				"tartan.weave",
			],
		],
		["tartan.pack.classic", "Classic", "Branches and reviewed changes", [
			"tartan.changes",
			"tartan.ci",
			"tartan.review",
		]],
	] as const).map(([id, name, description, members]) =>
		pkg(manifest(id, name, description, {
			kind: "pack",
			storage: { scope: "node", mode: "sql", quotaMB: 256 },
			permissions: { repo: "none" },
			members: members.map((m) => ({ id: m, version: "0.1.0" })),
		}))
	),
	pkg(
		manifest("tartan.board", "Board", "Kanban over work items", {
			storage: { scope: "node", mode: "sql", quotaMB: 256 },
		}),
	),
	pkg(
		manifest("tartan.epics", "Epics", "Epics across repos", {
			storage: { scope: "node", mode: "sql", quotaMB: 256 },
		}),
	),
	pkg(
		manifest("tartan.hud", "HUD", "Heads-up display for a subtree", {
			storage: { scope: "node", mode: "sql", quotaMB: 256 },
		}),
	),
	pkg(
		manifest(
			"acme.no-secrets",
			"No secrets",
			"Rust/WASM gate that blocks credentials",
			{
				runtime: "wasm",
				entry: { js: "dist/index.js", wasm: ["dist/gate.wasm"] },
				permissions: { repo: "read" },
				gates: [{
					point: "ref.advance",
					timeoutMs: 1500,
					default: "allow",
				}],
			},
		),
	),
];

const installation = (
	n: number,
	extId: string,
	nodePath: string,
	extra: Partial<InstallationDto> = {},
): InstallationDto => ({
	id: `i_${mockUlid(n)}`,
	extId,
	version: "0.1.0",
	nodeId: nodeByPath(nodePath)?.id ?? mockUlid(11),
	nodePath,
	mode: "enforce",
	storageScope: "repo",
	config: {},
	grants: PACKAGES.find((p) => p.extId === extId)?.manifest.permissions ?? {
		repo: "none",
	},
	backgroundRole: 20,
	locked: false,
	backfill: "none",
	pack: "tartan.pack.swarm",
	installedBy: OWNER_ID,
	installedAt: MOCK_NOW - 20 * 24 * HOUR,
	...extra,
});

export const INSTALLATIONS: readonly InstallationDto[] = [
	installation(501, "tartan.work", "acme"),
	installation(502, "tartan.changes", "acme"),
	installation(503, "tartan.radar", "acme"),
	installation(504, "tartan.ci", "acme"),
	installation(505, "tartan.review", "acme"),
	installation(506, "tartan.weave", "acme", {
		backgroundRole: 30,
		config: { trainSize: 1, label: "main" },
	}),
	installation(507, "tartan.board", "acme", { storageScope: "node" }),
	installation(508, "tartan.epics", "acme", { storageScope: "node" }),
	// In shadow mode: the demo replays it over history, then promotes it.
	installation(509, "acme.no-secrets", "acme", {
		pack: undefined,
		mode: "shadow",
	}),
	installation(510, "tartan.hud", "acme", {
		storageScope: "node",
		pack: undefined,
	}),
];

export const instId = (extId: string): string =>
	INSTALLATIONS.find((i) => i.extId === extId)?.id ?? `i_${mockUlid(599)}`;

// ---------------------------------------------------------------------------
// Views and slots
// ---------------------------------------------------------------------------

const staticTab = (
	extId: string,
	slot: StaticContributionDto["slot"],
	id: string,
	label: string,
	order: number,
	route?: string,
): StaticContributionDto => ({
	installationId: instId(extId),
	ext: extId,
	slot,
	id,
	label,
	order,
	...(route ? { route } : {}),
});

const instance = (
	extId: string,
	slot: SlotInstanceDto["slot"],
	id: string,
	order: number,
	title?: string,
	refreshOn: readonly string[] = [],
): SlotInstanceDto => ({
	installationId: instId(extId),
	ext: extId,
	slot,
	id,
	order,
	refreshOn,
	cache: "viewer",
	...(title ? { title } : {}),
});

const repoNode = nodeByPath("acme/platform/router") as NodeDto;

const repoInfo = {
	id: REPO_ID,
	defaultBranch: DEFAULT_BRANCH,
	trunkSha: SHAS.c3,
	landingPaused: false,
};

const noStatic = { tabs: [], nav: [], actions: [] } as const;

/** tartan.hud's metrics, in force on `acme` and everything below it. */
const HUD_METRICS = [
	"active-lanes",
	"predicted-conflicts",
	"conflicts-avoided",
	"landed-per-hour",
	"needed-a-human",
] as const;

/**
 * The `hud` and `home` views: tartan.hud (node scope, installed on
 * `acme`) on every node under `acme`; on the router repo also its
 * repo-scoped contributors (radar, the Weave, review).
 */
const hudSlots = (target: NodeDto, view: "hud" | "home"): SlotInstanceDto[] => {
	if (target.path !== "acme" && !target.path.startsWith("acme/")) return [];
	const isRouter = target.id === REPO_ID;
	if (view === "hud") {
		return [
			...HUD_METRICS.map((id, i): SlotInstanceDto => ({
				installationId: instId("tartan.hud"),
				ext: "tartan.hud",
				slot: "hud.metric",
				id,
				order: i + 1,
				refreshOn: [],
				cache: "role",
			})),
			...(isRouter
				? [
					{
						...instance("tartan.radar", "hud.metric", "conflicts-avoided", 0),
						cache: "role" as const,
					},
					{
						...instance("tartan.weave", "hud.metric", "landed-per-hour", 0),
						cache: "role" as const,
					},
				]
				: []),
		].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
	}
	return [
		instance("tartan.hud", "home.section", "swarm", 0, undefined, [
			"lane.*",
			"conflicts.*",
			"ref.advanced",
			"review.*",
		]),
		...(isRouter
			? [instance("tartan.review", "home.section", "attention", 0)]
			: []),
	];
};

// The mock lists what the kernel's `/-/api/view` lists for these views
// (src/kernel/exthost/api/view.ts) from the installed extensions, with the
// slot ids, routes and labels of their real manifests (`extensions/*/
// tartan.json`); `test/mock-parity.spec.ts` checks every one against the
// manifests, so the SPA is never built against ids the kernel does not serve.
export const viewFor = (path: string, view: string): ViewResponse | null => {
	const target = nodeByPath(path);
	if (!target) return null;
	const base = {
		node: target,
		viewer: OWNER_VIEWER,
		view,
		static: noStatic,
		slots: [] as SlotInstanceDto[],
		banners: [] as ViewResponse["banners"],
	};
	const [first = ""] = view.split("/");
	if (first === "hud" || first === "home") {
		return {
			...base,
			...(target.kind === "repo"
				? { repo: { ...repoInfo, id: target.id } }
				: {}),
			slots: hudSlots(target, first),
		};
	}
	if (target.kind !== "repo") {
		const nodeTabs = [
			staticTab("tartan.board", "node.tab", "board", "Board", 0, "board"),
			staticTab("tartan.epics", "node.tab", "epics", "Epics", 0, "epics"),
		];
		const tab = nodeTabs.find((t) => t.route === first);
		return {
			...base,
			static: {
				...noStatic,
				tabs: nodeTabs,
				nav: [
					staticTab("tartan.board", "nav.global", "nav", "Board", 0, "board"),
					staticTab("tartan.epics", "nav.global", "nav", "Epics", 0, "epics"),
				],
			},
			// No first-party extension contributes `node.section`.
			slots: tab
				? [instance(tab.ext, "node.tab", tab.id, 0, undefined, ["work.*"])]
				: [],
		};
	}
	if (target.id !== REPO_ID) {
		return { ...base, repo: { ...repoInfo, id: target.id } };
	}
	// Kernel order: `order` (0 everywhere), then the label.
	const repoTabs = [
		staticTab("tartan.board", "repo.tab", "repo-board", "Board", 0, "board"),
		staticTab("tartan.ci", "repo.tab", "ci", "CI", 0, "ci"),
		staticTab("tartan.changes", "repo.tab", "changes", "Changes", 0, "changes"),
		staticTab("tartan.radar", "repo.tab", "radar", "Radar", 0, "radar"),
		staticTab(
			"acme.no-secrets",
			"repo.tab",
			"secrets",
			"Secrets",
			0,
			"secrets",
		),
		staticTab("tartan.weave", "repo.tab", "weave", "Weave", 0, "weave"),
		staticTab("tartan.work", "repo.tab", "work", "Work", 0, "work"),
	];
	const actions = [
		staticTab("tartan.work", "repo.header.action", "new-work", "New work", 0),
	];
	const repoView = (
		slots: SlotInstanceDto[],
		tabs: StaticContributionDto[] = repoTabs,
	): ViewResponse => ({
		...base,
		node: repoNode,
		repo: repoInfo,
		static: { ...noStatic, tabs, actions },
		slots,
	});
	const sidebar = instance(
		"tartan.ci",
		"repo.sidebar",
		"projects",
		0,
		undefined,
		[
			"checks.*",
		],
	);
	if (first === "changes" && view.split("/")[1]) {
		return repoView([
			instance("tartan.changes", "change.tab", "diff", 0, undefined),
			instance("tartan.changes", "change.tab", "revisions", 0, undefined),
			instance("tartan.changes", "change.panel", "overview", -10, undefined, [
				"changes.*",
				"review.*",
				"queue.*",
				"land.*",
			]),
			instance("tartan.changes", "change.panel", "threads", 0, undefined, [
				"changes.*",
			]),
			instance("tartan.review", "change.panel", "evidence", 0, undefined, [
				"review.*",
				"checks.*",
			]),
			instance("tartan.ci", "change.sidebar", "checks", 0, undefined, [
				"checks.*",
				"run.*",
				"job.*",
			]),
			instance("tartan.radar", "change.sidebar", "conflicts", 0, undefined, [
				"conflicts.*",
			]),
			instance("acme.no-secrets", "change.sidebar", "findings", 0, undefined, [
				"gate.decided",
			]),
			instance("tartan.weave", "change.sidebar", "position", 0, undefined, [
				"queue.*",
				"land.*",
			]),
			instance("acme.no-secrets", "change.gate", "no-secrets", 0),
		], [
			...repoTabs,
			staticTab("tartan.changes", "change.tab", "diff", "Diff", 0, "diff"),
			staticTab(
				"tartan.changes",
				"change.tab",
				"revisions",
				"Revisions",
				0,
				"revisions",
			),
		]);
	}
	if (first === "work" && view.split("/")[1]) {
		return repoView([
			instance("tartan.work", "work.panel", "item", 0, undefined, [
				"work.*",
				"changes.*",
			]),
			instance("tartan.epics", "work.sidebar", "epic", 0, undefined, [
				"work.*",
			]),
		]);
	}
	if (/^lanes\/ln_[0-9a-z]{26}$/.test(view)) {
		return repoView([
			instance("tartan.radar", "lane.badge", "severity", 0, undefined, [
				"conflicts.*",
			]),
			instance("tartan.changes", "lane.sidebar", "change", 0, undefined, [
				"changes.*",
			]),
		]);
	}
	if (first === "") return repoView([sidebar]);
	if (first === "blob") {
		return repoView([
			instance("tartan.radar", "file.banner", "editing", 0, undefined, [
				"conflicts.*",
				"push.diffed",
			]),
			sidebar,
		]);
	}
	const tab = repoTabs.find((t) => t.route === first);
	return repoView(
		tab
			? [
				instance(tab.ext, "repo.tab", tab.id, 0, undefined, [
					"work.*",
					"changes.*",
					"conflicts.*",
				]),
			]
			: [],
	);
};

const changeHref = `/acme/platform/router/-/changes/${CHANGE_ID}`;

const BOARD: UiDoc = {
	v: 1,
	refreshOn: ["work.*"],
	root: {
		t: "board",
		columns: [
			{ id: "open", title: "Open" },
			{ id: "claimed", title: "Claimed", wip: 3 },
			{ id: "review", title: "In review" },
			{ id: "done", title: "Landed" },
		],
		cards: [
			{
				id: "w_17",
				col: "claimed",
				title: "Add rate limits to /n",
				href: "/acme/platform/router/-/work/w_17",
				badges: ["claude-1", "services/api"],
			},
			{
				id: "w_18",
				col: "open",
				title: "Fix flaky router test",
				badges: ["apps/web"],
			},
			{
				id: "w_19",
				col: "review",
				title: "Split router into modules",
				href: changeHref,
				badges: ["codex-1"],
			},
			{ id: "w_12", col: "done", title: "Web shell" },
		],
		moveAction: { id: "move" },
	},
};

/**
 * Slot documents by `<extId>/<slot>/<contribution id>`, every key a real
 * manifest contribution (`test/mock-parity.spec.ts`). Forms post the way
 * the real extensions read them (field values at the top level).
 */
export const SLOT_DOCS: Readonly<Record<string, UiDoc>> = {
	"tartan.work/repo.tab/work": {
		v: 1,
		refreshOn: ["work.*", "changes.*"],
		root: {
			t: "stack",
			children: [
				{
					t: "row",
					children: [
						{ t: "stat", label: "Open", value: 2 },
						{ t: "stat", label: "Done", value: 1 },
					],
				},
				{
					t: "table",
					columns: ["#", "Title", "Kind", "State", "Claims"],
					rows: [
						[
							17,
							{
								t: "link",
								text: "Add rate limits to /n",
								href: "/acme/platform/router/-/work/w_17",
							},
							"issue",
							{ t: "badge", text: "claimed", tone: "info" },
							1,
						],
						[18, "Fix flaky router test", "issue", {
							t: "badge",
							text: "open",
							tone: "neutral",
						}, 0],
					],
				},
				{
					t: "section",
					title: "New work item",
					children: [{
						t: "form",
						fields: [
							{ t: "input", name: "title", label: "Title", required: true },
							{
								t: "select",
								name: "kind",
								label: "Kind",
								options: ["issue", "intent"],
								value: "issue",
							},
							{ t: "textarea", name: "why", label: "Why" },
							{
								t: "textarea",
								name: "acceptance",
								label: "Acceptance (one per line)",
							},
						],
						submit: { text: "Create", action: { id: "create" } },
					}],
				},
			],
		},
	},
	"tartan.board/repo.tab/repo-board": BOARD,
	"tartan.board/node.tab/board": BOARD,
	"tartan.epics/node.tab/epics": {
		v: 1,
		root: {
			t: "list",
			items: [{
				t: "link",
				text: "Public API hardening",
				href: "/acme/-/epics",
			}],
		},
	},
	"tartan.changes/repo.tab/changes": {
		v: 1,
		root: {
			t: "table",
			columns: ["Change", "Lane", "State", "Checks"],
			rows: [
				[
					{ t: "link", text: "api: rate limits on /n", href: changeHref },
					{ t: "label", text: "ln_claude-1 · branch", mono: true },
					{ t: "badge", text: "submitted", tone: "info" },
					{ t: "badge", text: "3/3 passed", tone: "success" },
				],
				[
					"web: fix flaky test",
					{ t: "label", text: "ln_codex-1 · branch", mono: true },
					{ t: "badge", text: "open", tone: "neutral" },
					{ t: "badge", text: "running", tone: "info" },
				],
			],
		},
	},
	"tartan.radar/repo.tab/radar": {
		v: 1,
		root: {
			t: "stack",
			children: [
				{ t: "heading", text: "Predicted conflicts", level: 2 },
				{
					t: "matrix",
					rows: [{ id: "l1", label: "claude-1" }, {
						id: "l2",
						label: "codex-1",
					}, { id: "l3", label: "claude-2" }],
					cols: [{ id: "f1", label: "server.ts" }, {
						id: "f2",
						label: "index.ts",
					}, { id: "f3", label: "main.ts" }],
					cells: [
						{
							r: "l1",
							c: "f1",
							level: 4,
							label: "4",
							action: {
								id: "ack",
								payload: { conflictId: "cf_1", resolution: "ignore" },
							},
						},
						{ r: "l2", c: "f1", level: 3, label: "3" },
						{ r: "l2", c: "f3", level: 1 },
						{ r: "l3", c: "f2", level: 2 },
					],
				},
			],
		},
	},
	"tartan.ci/repo.tab/ci": {
		v: 1,
		root: {
			t: "table",
			columns: ["Run", "Projects", "Status"],
			rows: [[
				{ t: "link", text: "run 41", href: "/acme/platform/router/-/runs" },
				"services/api, packages/shared",
				{ t: "badge", text: "passed", tone: "success" },
			]],
		},
	},
	"tartan.weave/repo.tab/weave": {
		v: 1,
		root: {
			t: "stack",
			gap: 1,
			children: [
				{ t: "stat", label: "Queued", value: 2 },
				{ t: "sparkline", values: [1, 2, 2, 3, 1, 0, 2, 4, 3, 2] },
			],
		},
	},
	"acme.no-secrets/repo.tab/secrets": {
		v: 1,
		root: { t: "empty", text: "No secrets found on main" },
	},
	"tartan.ci/repo.sidebar/projects": {
		v: 1,
		root: {
			t: "kv",
			items: [
				{
					k: "services/api",
					v: { t: "badge", text: "passed", tone: "success" },
				},
				{ k: "apps/web", v: { t: "badge", text: "running", tone: "info" } },
				{
					k: "packages/shared",
					v: { t: "badge", text: "passed", tone: "success" },
				},
			],
		},
	},
	"tartan.radar/file.banner/editing": {
		v: 1,
		root: {
			t: "alert",
			tone: "warning",
			title: "2 lanes are editing this file",
			body: {
				t: "text",
				text: "claude-1 and codex-1 have pushes touching this path.",
			},
		},
	},
	"tartan.changes/change.tab/diff": {
		v: 1,
		root: {
			t: "diff",
			repo: "acme/platform/router",
			base: SHAS.c3,
			head: SHAS.lane,
			source: "lane ln_claude-1 (branch) vs main",
		},
	},
	"tartan.changes/change.tab/revisions": {
		v: 1,
		root: {
			t: "card",
			title: "api: rate limits on /n",
			children: [
				{
					t: "kv",
					items: [
						{ k: "Change", v: { t: "label", text: CHANGE_ID, mono: true } },
						{ k: "Lane", v: "ln_claude-1 (branch backend)" },
						{ k: "Work", v: "Rate limit the public API per token" },
						{
							k: "Author",
							v: {
								t: "row",
								gap: 1,
								children: [{ t: "avatar", principal: "a_claude_1" }, {
									t: "text",
									text: "claude-1 on behalf of rawkode",
								}],
							},
						},
						{ k: "State", v: { t: "badge", text: "submitted", tone: "info" } },
					],
				},
				{
					t: "timeline",
					items: [
						{
							at: MOCK_NOW - 3 * HOUR,
							text: "Lane opened from main",
							actor: "claude-1",
							tone: "info",
						},
						{
							at: MOCK_NOW - 2 * HOUR,
							text: "r1: pushed 2 commits (packages/shared)",
							actor: "claude-1",
						},
						{
							at: MOCK_NOW - HOUR,
							text: "Submitted for review",
							actor: "claude-1",
							tone: "success",
						},
					],
				},
			],
		},
	},
	"tartan.changes/change.panel/overview": {
		v: 1,
		refreshOn: ["changes.*", "review.*", "queue.*", "land.*"],
		root: {
			t: "stack",
			children: [
				{ t: "heading", text: "api: rate limits on /n", level: 2 },
				{
					t: "row",
					children: [{ t: "badge", text: "submitted", tone: "info" }],
				},
				{
					t: "kv",
					items: [
						{ k: "Change", v: { t: "code", text: CHANGE_ID } },
						{
							k: "Lane",
							v: {
								t: "link",
								text: "ln_claude-1",
								href: "/acme/platform/router/-/lanes",
							},
						},
						{ k: "Author", v: { t: "avatar", principal: "a_claude_1" } },
						{ k: "Revision", v: `1 at ${SHAS.lane.slice(0, 12)}` },
						{ k: "Diffstat", v: "2 files, +41 −3" },
					],
				},
				{
					t: "markdown",
					md: "Rate limits the public API per token (token bucket).",
				},
				{
					t: "section",
					title: "Timeline",
					children: [{
						t: "timeline",
						items: [
							{
								at: MOCK_NOW - HOUR,
								text: "Submitted for review",
								actor: "claude-1",
							},
						],
					}],
				},
				{
					t: "button",
					text: "Abandon",
					tone: "danger",
					action: {
						id: "abandon",
						payload: { changeId: CHANGE_ID },
						confirm: "Abandon this change?",
					},
				},
			],
		},
	},
	"tartan.changes/change.panel/threads": {
		v: 1,
		refreshOn: ["changes.*"],
		root: {
			t: "stack",
			children: [
				{
					t: "card",
					title: "services/api/src/server.ts:5",
					children: [
						{
							t: "timeline",
							items: [{
								at: MOCK_NOW - HOUR,
								text: "Rate limit the public API per token, not per IP.",
								actor: OWNER_ID,
							}],
						},
						{
							t: "button",
							text: "Resolve",
							action: { id: "resolve", payload: { commentId: "cm_1" } },
						},
					],
				},
				{
					t: "form",
					fields: [
						{ t: "textarea", name: "body", label: "Comment", required: true },
						{ t: "input", name: "path", label: "File (optional)" },
						{ t: "input", name: "line", label: "Line (optional)" },
					],
					submit: {
						text: "Comment",
						action: { id: "comment", payload: { changeId: CHANGE_ID } },
					},
				},
			],
		},
	},
	"tartan.review/change.panel/evidence": {
		v: 1,
		root: {
			t: "stack",
			gap: 2,
			children: [
				{
					t: "markdown",
					md:
						"### Evidence\n\n- Tests: **3/3** affected projects passed\n- Radar: no predicted conflicts at submit\n- Diff: 2 files, +3 −1\n\nSee the [pipeline](/acme/platform/router/-/runs) or the [docs](https://example.com/tartan/review).",
				},
				{
					t: "row",
					children: [
						{
							t: "button",
							text: "Approve",
							tone: "success",
							action: {
								id: "approve",
								payload: { changeId: CHANGE_ID, revision: 1 },
							},
						},
						{
							t: "button",
							text: "Request changes",
							tone: "danger",
							action: {
								id: "request_changes",
								payload: { changeId: CHANGE_ID, revision: 1 },
							},
						},
					],
				},
			],
		},
	},
	"tartan.ci/change.sidebar/checks": {
		v: 1,
		refreshOn: ["checks.*"],
		root: {
			t: "table",
			columns: ["Job", "Project", "Status", "Seconds"],
			rows: [
				["test", "services/api", {
					t: "badge",
					text: "passed",
					tone: "success",
				}, 74],
				["test", "packages/shared", {
					t: "badge",
					text: "passed",
					tone: "success",
				}, 12],
				["lint", "services/api", {
					t: "badge",
					text: "passed",
					tone: "success",
				}, 9],
			],
		},
	},
	"tartan.radar/change.sidebar/conflicts": {
		v: 1,
		root: {
			t: "alert",
			tone: "success",
			title: "No predicted conflicts",
			body: {
				t: "text",
				text: "Checked against 3 open lanes at the last push.",
			},
		},
	},
	"acme.no-secrets/change.sidebar/findings": {
		v: 1,
		root: { t: "text", text: "No credentials in r1.", tone: "muted" },
	},
	"tartan.weave/change.sidebar/position": {
		v: 1,
		root: {
			t: "stack",
			gap: 1,
			children: [
				{ t: "text", text: "Position 1 of 2 in the serial train." },
				{ t: "progress", value: 1, max: 2, label: "Queue" },
				{
					t: "button",
					text: "Withdraw",
					action: {
						id: "withdraw",
						payload: { changeId: CHANGE_ID },
						confirm: "Withdraw from the queue?",
					},
				},
			],
		},
	},
	"acme.no-secrets/change.gate/no-secrets": {
		v: 1,
		root: { t: "badge", text: "gate: allow", tone: "success" },
	},
	"tartan.work/work.panel/item": {
		v: 1,
		root: {
			t: "card",
			title: "Add rate limits to /n",
			children: [
				{
					t: "markdown",
					md:
						"Clamp `n` to **100** in `services/api`.\n\nFootprint: `services/api/**`, `packages/shared/**`.",
				},
				{
					t: "kv",
					items: [{ k: "Claimed by", v: "claude-1" }, {
						k: "Footprint",
						v: "services/api/**, packages/shared/**",
					}],
				},
				{
					t: "form",
					fields: [{
						t: "textarea",
						name: "body",
						label: "Comment",
						required: true,
					}],
					submit: {
						text: "Comment",
						action: {
							id: "comment",
							payload: { ref: "acme/platform/router#17" },
						},
					},
				},
			],
		},
	},
	"tartan.epics/work.sidebar/epic": {
		v: 1,
		root: {
			t: "list",
			items: [{
				t: "link",
				text: "Epic: public API hardening",
				href: "/acme/-/epics",
			}],
		},
	},
	"tartan.radar/lane.badge/severity": {
		v: 1,
		root: {
			t: "badge",
			text: "1 predicted conflict: packages/shared/src/config.ts",
			tone: "warning",
		},
	},
	"tartan.changes/lane.sidebar/change": {
		v: 1,
		root: {
			t: "list",
			items: [{ t: "link", text: "api: rate limits on /v1", href: changeHref }],
		},
	},
	...HUD_DOCS,
};

export const MOCK_LIVE_EVENT_TYPES = [
	"checks.updated",
	"conflicts.escalated",
	"queue.updated",
] as const;
