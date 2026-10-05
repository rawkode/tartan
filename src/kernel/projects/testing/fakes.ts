// Fakes for the projects API's Deno tests (WP25 slice A′): the demo-shaped
// cuenv graph at a trunk tip, a repo node, SHA reads over the fixture's
// objects, the providers of work@1 and changes@1, and their list tools with
// the tools' own role check. Plain module (no `cloudflare:*`).

import {
	type Change,
	denied,
	type InstallationInForce,
	type NodeDto,
	type ProjectGraph,
	type ToolContext,
	type WorkItem,
} from "@tartan/contract";
import type { AuthContext } from "@tartan/contract/kernel.ts";
import { createTreeView, detectProjects } from "@tartan/monorepo";
import { createMemGit } from "../../../../packages/monorepo/test/memgit.ts";
import { CUENV_DEMO_FILES } from "../../../../packages/monorepo/test/fixtures/cuenv-demo.ts";
import type { RouteContext } from "../../../router.ts";
import type { RepoReads } from "../../browse/reader.ts";
import { createProjectsHandler } from "../api.ts";
import type { ProjectsDeps } from "../deps.ts";

export const REPO_ID = "01k6aaaaaaaaaaaaaaaaaaaaaa";
export const OWNER = "u_01k6owner0000000000000000";
export const GUEST = "u_01k6guest0000000000000000";
export const TIP = "a".repeat(40);
export const OLD = "b".repeat(40);
export const DS = "rawkode-academy-design-system";
export const WEB = "rawkode-academy-website";

const git = createMemGit();
const TREE = git.writeTree(CUENV_DEMO_FILES);
const detected = await detectProjects(
	createTreeView(git.objects, TREE),
	undefined,
	{ cuenv: true },
);
export const GRAPH = {
	sha: TIP,
	manifestsTreeSha: detected.manifestsTreeSha,
	projects: detected.projects,
	globalFiles: detected.globalFiles,
	configKey: "off",
	...detected.extras,
} as ProjectGraph;

export const item = (
	n: number,
	footprint: { projects?: string[]; prefixes?: string[] },
	state = "open",
): WorkItem =>
	({
		ref: `rawkode/academy#${n}`,
		kind: "issue",
		title: `item ${n}`,
		why: "",
		acceptance: [],
		footprint: {
			projects: footprint.projects ?? [],
			prefixes: footprint.prefixes ?? [],
		},
		mode: "single",
		k: 1,
		state,
		claims: n === 1
			? [{ principal: OWNER, laneId: `ln_${"0".repeat(26)}`, state: "active" }]
			: [],
		labels: [],
		priority: 2,
	}) as unknown as WorkItem;

const change = (id: string, revisions: string[][]): Change =>
	({
		changeId: id.padEnd(32, "x"),
		repo: "rawkode/academy",
		laneId: `ln_${"1".repeat(26)}`,
		title: `change ${id}`,
		summary: "",
		author: OWNER,
		revisions: revisions.map((affected, i) => ({
			n: i + 1,
			head: TIP,
			base: TIP,
			affected,
			diffstat: { files: 1, additions: 1, deletions: 0 },
			at: 1_000 + i,
		})),
		state: "submitted",
	}) as unknown as Change;

export const ITEMS = [
	item(1, { projects: [DS], prefixes: ["packages/design-system"] }),
	item(2, { prefixes: ["packages/design-system/src/"] }),
	item(3, { projects: [WEB] }),
	item(4, { projects: ["packages/design-system"] }, "done"),
	item(5, { prefixes: ["packages"] }),
];
const ALL = GRAPH.projects.map((p) => p.name);
export const CHANGES = [
	change("c1", [[DS, WEB]]),
	change("c2", [[WEB]]),
	change("c3", [[...ALL, "*"]]),
	change("c4", []),
	change("c5", [[DS], [WEB]]),
];

const providerOf = (iface: string): InstallationInForce =>
	({
		installation: {
			id: iface === "work@1" ? "i_work" : "i_changes",
			storageScope: "repo",
		},
		manifest: { id: iface === "work@1" ? "tartan.work" : "tartan.changes" },
		depth: 0,
	}) as unknown as InstallationInForce;

export type Fakes = {
	visibility: NodeDto["visibility"];
	roles: Map<string, number>;
	trunkSha: string | null;
	providers: boolean;
	items: readonly WorkItem[];
	changes: readonly Change[];
	calls: { name: string; args: Record<string, unknown>; ctx: ToolContext }[];
	graphCalls: string[];
	cached: Map<string, ProjectGraph>;
	admit: (k: string) => boolean;
	mode: "off" | "scan";
};

export const fakes = (over: Partial<Fakes> = {}): Fakes => ({
	visibility: "public",
	roles: new Map([[OWNER, 50], [GUEST, 10]]),
	trunkSha: TIP,
	providers: true,
	items: ITEMS,
	changes: CHANGES,
	calls: [],
	graphCalls: [],
	cached: new Map([[OLD, { ...GRAPH, sha: OLD }]]),
	admit: () => true,
	mode: "scan",
	...over,
});

const reads = (): RepoReads => ({
	commit: (sha) =>
		Promise.resolve(
			sha === TIP
				? {
					hash: TIP,
					treeHash: TREE,
					message: "tip",
					author: { name: "t", email: "t@x" },
					committer: { name: "t", email: "t@x" },
					parents: [],
				} as never
				: null,
		),
	tree: (sha) => {
		const o = git.store.get(sha);
		return Promise.resolve(o?.kind === "tree" ? o.entries as never : null);
	},
	blob: (sha) => {
		const o = git.store.get(sha);
		return Promise.resolve(
			o?.kind === "blob"
				? new Blob([o.bytes as Uint8Array<ArrayBuffer>])
				: null,
		);
	},
	log: () => Promise.reject(new Error("unused")),
	file: () => Promise.reject(new Error("unused")),
	close: () => {},
});

/** A paged tool answer the way `tartan.work`/`tartan.changes` page (cursor = offset). */
const paged = <T>(all: readonly T[], args: Record<string, unknown>) => {
	const from = Number(args.cursor ?? 0);
	const limit = Number(args.limit ?? 50);
	const page = all.slice(from, from + limit);
	return {
		page,
		...(from + limit < all.length ? { cursor: String(from + limit) } : {}),
	};
};

export const depsOf = (f: Fakes): ProjectsDeps => ({
	mode: f.mode,
	tree: () =>
		({
			node: (id: string) =>
				Promise.resolve(
					id === REPO_ID
						? {
							id: REPO_ID,
							parentId: null,
							kind: "repo",
							slug: "academy",
							path: "rawkode/academy",
							depth: 1,
							visibility: f.visibility,
							archived: false,
							createdAt: 0,
							defaultBranch: "main",
						} as NodeDto
						: null,
				),
			effectiveRole: (principals: string[]) =>
				Promise.resolve(
					Math.max(0, ...principals.map((p) => f.roles.get(p) ?? 0)) as never,
				),
		}) as never,
	repo: () => ({
		info: () => Promise.resolve({ trunkSha: f.trunkSha } as never),
		trunkSeqs: (shas) =>
			Promise.resolve(
				Object.fromEntries(
					shas.filter((s) => s === TIP || s === OLD).map((s, i) => [s, i]),
				),
			),
	}),
	cachedGraph: (_repo, sha) => Promise.resolve(f.cached.get(sha) ?? null),
	graph: (_repo, sha) => {
		f.graphCalls.push(sha);
		return Promise.resolve({ ...GRAPH, sha });
	},
	reads: () => Promise.resolve(reads()),
	provider: (iface) => Promise.resolve(f.providers ? providerOf(iface) : null),
	callTool: (_provider, _repo, name, args, ctx) => {
		const a = args as Record<string, unknown>;
		f.calls.push({ name, args: a, ctx });
		// The tool's own role check (work@1 and changes@1 list tools need Reporter).
		if ((f.roles.get(ctx.actor.id) ?? 0) < 20) {
			return Promise.reject(denied("role", `${name} needs role 20`));
		}
		if (name === "work_list") {
			const { page, ...rest } = paged(
				f.items.filter((i) => a.state === undefined || i.state === a.state),
				a,
			);
			return Promise.resolve({ items: page, ...rest });
		}
		const { page, ...rest } = paged(f.changes, a);
		return Promise.resolve({ changes: page, ...rest });
	},
	admit: f.admit,
});

export const authOf = (principal: string): AuthContext => ({
	principal,
	kind: "user",
	via: "session",
	scopes: [],
	nodeId: null,
	laneId: null,
	maxRole: 50,
	isAdmin: false,
});

export const get = async <T>(
	f: Fakes,
	rest: string,
	auth: AuthContext | null = authOf(OWNER),
	repoId = REPO_ID,
): Promise<{ status: number; body: T }> => {
	const path = `/-/api/repos/${repoId}/projects${rest}`;
	const url = new URL(`https://code.example.com${path}`);
	const m = /^\/-\/api\/repos\/([^/]+)\/projects(?:\/(.+))?$/.exec(
		url.pathname,
	)!;
	const handler = createProjectsHandler(() => depsOf(f));
	const res = await handler({
		req: new Request(url),
		url,
		params: { repoId: m[1], ...(m[2] ? { rest: m[2] } : {}) },
		auth,
	} as unknown as RouteContext);
	return { status: res.status, body: await res.json() as T };
};
