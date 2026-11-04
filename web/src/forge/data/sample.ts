// Sample data for the forge shell, in memory only. The next step replaces this
// module and `store.ts` with kernel API calls; nothing outside `forge/data/`
// imports either of them (`test/source-audit.spec.ts`).

import type { Commit, ForgeEvent, ForgeNode, Issue } from "./model.ts";

const group = (
	name: string,
	description: string,
	children: ForgeNode[],
): ForgeNode => ({
	name,
	kind: "group",
	description,
	children,
	deps: [],
});

export const repoNode = (
	name: string,
	description: string,
	extra: Partial<ForgeNode> = {},
	children: ForgeNode[] = [],
): ForgeNode => ({
	name,
	kind: "repo",
	description,
	children,
	deps: [],
	...extra,
});

export const groupNode = (name: string, description: string) =>
	group(name, description, []);

const project = (
	name: string,
	path: string,
	description: string,
	extra: Partial<ForgeNode> = {},
): ForgeNode => ({
	name,
	kind: "project",
	path,
	description,
	children: [],
	deps: [],
	...extra,
});

export const buildTree = () =>
	group(
		"~",
		"Everything you keep here. Groups nest as deep as you like, and repos sit at any level.",
		[
			group("oss", "Things published for other people.", [
				group("devtools", "Tools for building software.", [
					group("build", "Build systems and everything around them.", [
						repoNode(
							"kiln",
							"Task runner and build graph for polyglot repos.",
							{},
							[
								project(
									"core",
									"crates/core",
									"Workspace model, task graph and cache keys.",
									{ releases: [["core/v1.8.0", "10d"]] },
								),
								project("cli", "crates/cli", "The kiln command.", {
									deps: ["core"],
									releases: [["cli/v1.8.0", "10d"]],
								}),
								project(
									"lsp",
									"crates/lsp",
									"Language server for kiln.toml and the task graph.",
									{
										deps: ["core"],
										readme: true,
										releases: [["lsp/v0.9.2", "12d"], ["lsp/v0.9.1", "5w"], [
											"lsp/v0.9.0",
											"2mo",
										]],
									},
								),
								project(
									"registry",
									"services/registry",
									"Hosted package registry.",
									{ deps: ["core"], releases: [["registry/v2.3.1", "14d"]] },
								),
								project(
									"vscode",
									"editors/vscode",
									"Editor extension that wraps lsp.",
									{ deps: ["lsp"], releases: [["vscode/v0.9.2", "12d"]] },
								),
								project(
									"action",
									"integrations/action",
									"CI action that runs kiln with a shared cache.",
									{ deps: ["cli"], releases: [["action/v3.0.0", "11d"]] },
								),
								project("docs", "site/docs", "Documentation site.", {
									fail: "Link checker found 3 broken links.",
									releases: [],
								}),
								project("root", ".", "Anything no other project claims.", {
									releases: [],
								}),
							],
						),
						repoNode(
							"kiln-examples",
							"Sample repos used by the kiln test suite.",
							{ releases: [["v0.3.0", "6w"]] },
						),
						repoNode("remote-cache", "Content-addressed cache server.", {
							releases: [["v2.1.0", "3w"]],
						}),
					]),
					group("editors", "Editor grammars and plugins.", [
						repoNode("treesitter-kiln", "Tree-sitter grammar for kiln.toml.", {
							releases: [["v0.4.1", "2mo"]],
						}),
					]),
					repoNode("git-tools", "Small git helpers.", {
						releases: [["v1.2.0", "9d"]],
					}),
				]),
				group("libraries", "Reusable libraries.", [
					group("rust", "Rust crates.", [
						repoNode("semver-lite", "Version parsing without dependencies.", {
							releases: [["v0.7.0", "11d"]],
						}),
						repoNode(
							"toml-patch",
							"Edit TOML while keeping comments and layout.",
							{ releases: [["v1.0.2", "4w"]] },
						),
					]),
				]),
			]),
			group("infra", "Machines and services I run.", [
				group("homelab", "Hardware at home.", [
					repoNode("nodes", "Host configuration for every machine.", {
						releases: [],
					}),
					repoNode("dns", "Zones and split-horizon records.", { releases: [] }),
				]),
				group("cloud", "Anything rented.", [
					repoNode("edge", "Reverse proxies and certificates.", {
						releases: [],
					}),
					repoNode(
						"platform",
						"The services everything else runs behind.",
						{},
						[
							project(
								"shared",
								"libs/shared",
								"Config, tracing and retry helpers.",
								{ releases: [["shared/v0.6.0", "3w"]] },
							),
							project(
								"gateway",
								"services/gateway",
								"Routing, auth and rate limits.",
								{
									deps: ["shared"],
									releases: [["gateway/v0.6.1", "4d"], [
										"gateway/v0.6.0",
										"3w",
									]],
								},
							),
							project(
								"metrics",
								"services/metrics",
								"Collects and stores service metrics.",
								{ deps: ["shared"], releases: [["metrics/v0.3.0", "2w"]] },
							),
							project(
								"deploy",
								"deploy/terraform",
								"Infrastructure for every service.",
								{ releases: [] },
							),
							project("root", ".", "Anything no other project claims.", {
								releases: [],
							}),
						],
					),
				]),
			]),
			group("clients", "Paid work, kept private.", [
				group("halden", "Halden Joinery.", [
					repoNode("site", "Marketing site.", { releases: [] }),
				]),
			]),
			group("writing", "Words.", [
				group("talks", "Slides and demos.", [
					group("2026", "This year.", [
						repoNode(
							"monorepo-lessons",
							"Talk on moving everything to one repo.",
							{ releases: [] },
						),
					]),
				]),
				repoNode("blog", "Posts and drafts.", { releases: [] }),
			]),
			repoNode("dotfiles", "Shell and editor configuration.", { releases: [] }),
		],
	);

const BUILD = "oss/devtools/build/";
export const KILN = `${BUILD}kiln`;
export const PLATFORM = "infra/cloud/platform";

export const defaultIssues = (): Issue[] => {
	const rows: [string, number, string, string, string][] = [
		[
			`${KILN}:lsp`,
			128,
			"Go-to-definition fails across workspace members",
			"bug",
			"2h",
		],
		[
			`${KILN}:core`,
			311,
			"Cache key ignores environment passthrough",
			"bug",
			"5h",
		],
		[
			`${KILN}:root`,
			9,
			"Release script assumes a clean worktree",
			"chore",
			"6h",
		],
		[
			`${PLATFORM}:gateway`,
			24,
			"Rate limit counters reset on every deploy",
			"bug",
			"7h",
		],
		[
			"infra/homelab/nodes",
			19,
			"Rebuild nas-02 with the new ZFS pool layout",
			"chore",
			"8h",
		],
		[
			`${KILN}:lsp`,
			131,
			"Hover shows a stale task graph after editing kiln.toml",
			"bug",
			"1d",
		],
		[
			`${KILN}:cli`,
			207,
			"kiln run --affected should accept a change id",
			"feature",
			"1d",
		],
		[
			`${BUILD}remote-cache`,
			44,
			"Evict by last read, not last write",
			"feature",
			"2d",
		],
		[
			`${KILN}:registry`,
			58,
			"Yank endpoint returns 500 on scoped packages",
			"bug",
			"2d",
		],
		[
			`${PLATFORM}:metrics`,
			11,
			"Retention setting is ignored for new series",
			"bug",
			"2d",
		],
		[
			`${KILN}:lsp`,
			119,
			"Semantic tokens for task references",
			"feature",
			"3d",
		],
		[
			"clients/halden/site",
			7,
			"Contact form drops non-ASCII names",
			"bug",
			"3d",
		],
		[
			`${KILN}:docs`,
			76,
			"Monorepo guide still uses the old workspace syntax",
			"docs",
			"4d",
		],
		[
			"oss/libraries/rust/toml-patch",
			6,
			"Comments vanish when a table is removed",
			"bug",
			"4d",
		],
		[
			`${KILN}:core`,
			298,
			"Parallelism limit ignored inside nested workspaces",
			"bug",
			"5d",
		],
		[
			"infra/cloud/edge",
			8,
			"Certificate renewal alert fires twice",
			"bug",
			"5d",
		],
		[
			`${KILN}:vscode`,
			40,
			"Task graph panel loses its scroll position",
			"bug",
			"6d",
		],
		["infra/homelab/nodes", 17, "Move backups off the old pool", "chore", "6d"],
		[
			`${KILN}:lsp`,
			112,
			"Completion for task names in kiln.toml",
			"feature",
			"1w",
		],
		[
			"writing/blog",
			23,
			"Draft: what moving to one repo actually changed",
			"draft",
			"1w",
		],
		[`${KILN}:cli`, 199, "Shell completions for fish", "feature", "1w"],
		[
			`${PLATFORM}:deploy`,
			16,
			"Split the state file by environment",
			"chore",
			"1w",
		],
		[
			`${BUILD}remote-cache`,
			41,
			"Report hit rate per project",
			"feature",
			"1w",
		],
		[
			"oss/devtools/git-tools",
			14,
			"Stacked rebase loses the base commit",
			"bug",
			"1w",
		],
		[
			`${KILN}:core`,
			287,
			"Task graph snapshot grows without bound",
			"bug",
			"2w",
		],
		[
			`${KILN}:lsp`,
			104,
			"Workspace symbol search is slow over 5k files",
			"perf",
			"2w",
		],
		[
			"infra/homelab/dns",
			6,
			"Split-horizon record for forge.internal",
			"chore",
			"2w",
		],
		[
			`${KILN}:registry`,
			52,
			"Show download counts per version",
			"feature",
			"2w",
		],
		[
			`${PLATFORM}:gateway`,
			19,
			"Trace ids for upstream retries",
			"feature",
			"2w",
		],
		[
			"oss/libraries/rust/semver-lite",
			18,
			"Reject leading zeros in pre-release ids",
			"bug",
			"2w",
		],
		[
			"clients/halden/site",
			6,
			"Gallery images load at full size",
			"perf",
			"2w",
		],
		[`${BUILD}kiln-examples`, 3, "Add a multi-member fixture", "feature", "2d"],
		[`${KILN}:docs`, 71, "Landing page hero image is too large", "docs", "3w"],
		[`${PLATFORM}:shared`, 7, "Drop the vendored retry helper", "chore", "3w"],
		[
			`${KILN}:core`,
			264,
			"Derive macro errors point at the wrong span",
			"bug",
			"3w",
		],
		[`${KILN}:cli`, 188, "kiln fmt wraps long task lists badly", "bug", "3w"],
		["infra/homelab/nodes", 15, "Label every disk by bay", "chore", "3w"],
		["infra/cloud/edge", 5, "Drop the old staging hostnames", "chore", "4w"],
		[
			"oss/devtools/git-tools",
			11,
			"Document the worktree helper",
			"docs",
			"4w",
		],
		[`${BUILD}remote-cache`, 37, "Compress blobs at rest", "feature", "5w"],
		[
			"oss/libraries/rust/semver-lite",
			12,
			"Add a range intersection helper",
			"feature",
			"5w",
		],
		["writing/blog", 21, "Fix the RSS feed dates", "bug", "6w"],
		[
			"writing/talks/2026/monorepo-lessons",
			2,
			"Cut the talk to 25 minutes",
			"draft",
			"6w",
		],
		["clients/halden/site", 4, "Add the new workshop address", "chore", "6w"],
		[
			"infra/homelab/nodes",
			12,
			"Replace the failing fan in nas-01",
			"chore",
			"2mo",
		],
	];
	return rows.map(([where, n, title, tag, age]) => {
		const issue: Issue = {
			id: `${where}#${n}`,
			where,
			n,
			title,
			tag,
			age,
			closed: false,
			labels: [tag],
			affected: [],
			log: [],
			past: [],
		};
		return where === `${KILN}:lsp` && n === 128
			? {
				...issue,
				labels: ["bug", "protocol"],
				found: "lsp/v0.9.2",
				affected: [`${KILN}:core`],
				rich: true,
			}
			: issue;
	});
};

const commitRows = (
	rows: readonly (readonly [string, string, string, string])[],
): Commit[] =>
	rows.map(([sha, subject, projects, age]) => ({
		sha,
		subject,
		projects: projects.split(" "),
		age,
	}));

const commitLog: Record<string, Commit[]> = {
	[KILN]: commitRows([
		["7e01b4c", "Add task graph snapshot format", "core", "3w"],
		["19af3d2", "Snapshot-based --affected", "core cli", "3w"],
		["c2d8e10", "Fix link to the install guide", "docs", "3w"],
		["58b1f7a", "Publish with provenance", "registry action root", "19d"],
		["0ad4e63", "Document --affected", "cli docs", "19d"],
		["b93c7d1", "Diagnostics for unknown tasks", "lsp", "18d"],
		["44e0ac9", "Expose task spans from the parser", "core lsp", "17d"],
		["e17f2b6", "Highlight task references", "lsp vscode", "16d"],
		["6cd90a3", "Retry uploads with backoff", "registry", "14d"],
		["a5720ef", "Release lsp 0.9.2", "lsp vscode", "12d"],
		["3f8c1d4", "Bump the action runtime", "action", "11d"],
		["d06b9e7", "Scoped package names", "core cli lsp registry", "10d"],
		["82ea4f0", "Guide to scoped packages", "docs", "9d"],
		["17c3b5a", "Trim parser allocations", "core", "8d"],
		["f4a92c8", "Watch kiln.toml from the extension", "vscode", "7d"],
		["2b6de01", "Restart the server on config change", "lsp vscode", "6d"],
		["90fd7c3", "Hash declared inputs only", "core", "6d"],
		["c81e4a6", "Tidy the release scripts", "root", "5d"],
		["5ea07b2", "Cache auth for the action", "cli action", "5d"],
		["3d19f6e", "Move docs to the new theme", "docs", "4d"],
		["b70c2a9", "Member index data structure", "core", "3d"],
		["6f1ea83", "Longest-prefix lookup in the index", "core", "3d"],
		["08dc5b7", "Nested workspace fixtures", "core cli lsp", "2d"],
		["e3a6d19", "Debounce diagnostics", "lsp", "2d"],
		[
			"7b42c0f",
			"Shared version for all crates",
			"core cli lsp registry root",
			"1d",
		],
		[
			"a41c9e2",
			"Pin the toolchain",
			"core cli lsp registry vscode action root",
			"1d",
		],
		["1ce8b70", "Add a link checker", "docs", "9h"],
		["9d57ae4", "Trace spans for task execution", "core cli", "3h"],
	]),
	[PLATFORM]: commitRows([
		["4be17a0", "Add the shared retry helper", "shared", "4w"],
		[
			"91c0d3e",
			"Route through the shared config",
			"shared gateway metrics",
			"3w",
		],
		["d2f86b1", "Release gateway 0.6.0", "gateway", "3w"],
		["60ae29c", "Move state to object storage", "deploy", "3w"],
		["b7713fd", "Store metrics in daily blocks", "metrics", "2w"],
		["2ec94a8", "Pin provider versions", "deploy root", "2w"],
		["f03b6d7", "Trace requests through the gateway", "shared gateway", "10d"],
		["7a15ce2", "Reject oversized headers", "gateway", "4d"],
		["c6d2e91", "Add a staging environment", "deploy", "2d"],
		["18fa07b", "Tidy the Makefile", "root", "11h"],
	]),
};

export const commitsFor = (repo: string) => commitLog[repo] ?? [];

export const hours = (age: string) => {
	const m = /^(\d+)(h|d|w|mo)$/.exec(age);
	return m
		? Number(m[1]) *
			{ h: 1, d: 24, w: 168, mo: 720 }[m[2] as "h" | "d" | "w" | "mo"]
		: 0;
};

const otherEvents: [string, string, string, string][] = [
	["infra/homelab/nodes", "c70f2e8", "Rebuild nas-02 pool layout", "8h"],
	[
		`${BUILD}remote-cache`,
		"e11b03a",
		"Evict by last read, behind a flag",
		"2d",
	],
	[`${BUILD}kiln-examples`, "77a0c19", "Add a multi-member fixture", "2d"],
	["clients/halden/site", "f2c61d0", "Accept non-ASCII names", "3d"],
	["dotfiles", "02fe9c7", "Switch terminal font", "3d"],
	[
		"oss/libraries/rust/toml-patch",
		"8e30b15",
		"Keep comments on removed keys",
		"4d",
	],
	["infra/cloud/edge", "a93e77c", "Rotate certificates", "5d"],
	[`${BUILD}remote-cache`, "4cd81f2", "Bound the upload queue", "6d"],
	["writing/blog", "6ab02e4", "Draft: moving to one repo", "1w"],
	["oss/devtools/git-tools", "b20e6d4", "Add a stacked rebase helper", "9d"],
	["oss/libraries/rust/semver-lite", "d19c7aa", "Parse build metadata", "11d"],
	[
		"oss/devtools/editors/treesitter-kiln",
		"1fa93cd",
		"Highlight task references",
		"16d",
	],
	["infra/homelab/dns", "40bd1a6", "Add forge.internal zone", "2w"],
	["writing/talks/2026/monorepo-lessons", "39de5b1", "Outline the talk", "2w"],
];

export const events: ForgeEvent[] = [
	...Object.entries(commitLog).flatMap(([repo, log]) =>
		log.map((c) => ({
			repo,
			sha: c.sha,
			subject: c.subject,
			age: c.age,
			projects: c.projects,
		}))
	),
	...otherEvents.map(([repo, sha, subject, age]) => ({
		repo,
		sha,
		subject,
		age,
		projects: [],
	})),
].sort((a, b) => hours(a.age) - hours(b.age));
