// Test fixture for the WP7a HTTP handlers: the real registry over node:sqlite
// fakes, a tree facade and an `authorize` that follow WP3's documented rules
// (grants up the tree, Owner at roots, credential bounds via `boundRole`,
// `scopesAllow`, public visibility for anonymous readers), a RepoDO core
// fake and a recording ExtensionDO fake. Test-only.

import {
	type AddedLine,
	type Advance,
	boundRole,
	type BuiltinPackage,
	denied,
	type EffectiveRole,
	type GateDecision,
	type GateInput,
	type Lane,
	type NodeDto,
	PERMISSION_MIN_ROLE,
	scopesAllow,
	type SlotContext,
	unauthenticated,
} from "@tartan/contract";
import {
	actorBoundsOf,
	type AuthContext,
	type Authorize,
	type GateReplayRow,
	type NodeRow,
} from "@tartan/contract/kernel.ts";
import { createRegistry } from "../../registry/module.ts";
import { REGISTRY_MIGRATIONS } from "../../registry/schema.ts";
import {
	bundled,
	manifest,
	registryFixture,
} from "../../registry/test/fakes.ts";
import type { ApiDeps, ApiLogEntry, ExtHostApi } from "../deps.ts";

export const OWNER = "u_owner";

export const toDto = (row: NodeRow): NodeDto => ({
	id: row.id,
	parentId: row.parent_id,
	kind: row.kind,
	slug: row.slug,
	path: row.path,
	depth: row.depth,
	visibility: row.visibility,
	...(row.default_branch ? { defaultBranch: row.default_branch } : {}),
	archived: row.archived_at !== null,
	createdAt: row.created_at,
});

export type HostCall = {
	readonly method:
		| "render"
		| "action"
		| "gate"
		| "console"
		| "deadLetters"
		| "breaker"
		| "resetBreaker"
		| "deleteData";
	readonly installationId: string;
	readonly scope: unknown;
	readonly args: unknown[];
};

export const PACKAGES = [
	bundled(manifest("tartan.work", {
		provides: ["work@1"],
		contributes: {
			slots: [
				{
					slot: "repo.tab",
					id: "work",
					label: "Work",
					route: "work",
					when: "node.kind == 'repo'",
				},
				{
					slot: "repo.header.action",
					id: "new-work",
					label: "New work",
					when: "node.kind == 'repo'",
					role: 30,
				},
				{ slot: "work.panel", id: "item", dynamic: true },
				{ slot: "repo.sidebar", id: "mine", dynamic: true },
			],
		},
	})),
	bundled(manifest("tartan.board", {
		storage: { scope: "node" },
		contributes: {
			slots: [
				{ slot: "nav.global", id: "nav", label: "Board", order: 5 },
				{ slot: "node.tab", id: "board", label: "Board", route: "board" },
				{ slot: "hud.metric", id: "wip", dynamic: true, cache: "role" },
				{ slot: "node.section", id: "summary", dynamic: true, role: 40 },
			],
		},
	})),
	bundled(manifest("tartan.changes", {
		contributes: {
			slots: [
				{
					slot: "repo.tab",
					id: "changes",
					label: "Changes",
					route: "changes",
					when: "node.kind == 'repo'",
				},
				{ slot: "change.tab", id: "diff", label: "Diff", route: "diff" },
				{
					slot: "change.tab",
					id: "revisions",
					label: "Revisions",
					route: "revisions",
					order: 10,
				},
				{ slot: "change.panel", id: "threads", dynamic: true },
			],
		},
	})),
	bundled(manifest("tartan.radar", {
		provides: ["conflicts@1"],
		contributes: {
			slots: [
				{ slot: "file.banner", id: "editing", dynamic: true },
				{ slot: "lane.badge", id: "severity", dynamic: true },
			],
		},
	})),
];

/** A pack of `tartan.work` (repo storage) and `tartan.board` (node storage). */
export const PACK = bundled(manifest("tartan.pack.swarm", {
	kind: "pack",
	storage: { scope: "node" },
	members: [
		{ id: "tartan.work", version: "0.1.0" },
		{ id: "tartan.board", version: "0.1.0" },
	],
}));

export const apiFixture = (extra: readonly BuiltinPackage[] = []) => {
	const fx = registryFixture(REGISTRY_MIGRATIONS, OWNER);
	const packages = [...PACKAGES, ...extra];
	const registry = createRegistry(fx.deps, { builtins: () => packages });
	registry.registerBuiltinsSync(packages);
	fx.tree.add("acme");
	fx.tree.add("acme/platform/router", "repo");
	fx.tree.add("acme/platform/edge", "repo");
	fx.tree.add("other/secret", "repo");
	fx.db.db.prepare("UPDATE nodes SET visibility = 'public' WHERE path = ?").run(
		"acme/platform/edge",
	);
	const calls: HostCall[] = [];
	let hostReply: (method: "render" | "action") => unknown = (method) =>
		method === "render"
			? { v: 1, root: { t: "text", text: "hello" } }
			: { v: 1, toast: { tone: "success", text: "done" } };
	const lanes = new Map<string, Lane>();
	let repoInfoFails = false;
	const sha = "a".repeat(40);
	/** Advances per repo, newest first (the land facade's `advances`). */
	const advances = new Map<string, Advance[]>();
	/** Added lines per `base..head` (the probe's `addedLines`). */
	const added = new Map<string, AddedLine[]>();
	const replays = new Map<string, GateReplayRow>();
	let gateReply: (input: GateInput) => Promise<GateDecision> = () =>
		Promise.resolve({ decision: "allow", message: "fine" });

	const authorize: Authorize = (auth, target, perm) => {
		const row = fx.tree.nodeSync(target.node.id);
		if (row === null) return Promise.reject(denied("scope"));
		if (auth === null) {
			if (row.visibility === "public" && PERMISSION_MIN_ROLE[perm] <= 20) {
				return Promise.resolve(20);
			}
			return Promise.reject(unauthenticated());
		}
		const granted = fx.tree.effectiveRoleSync([auth.principal], row.id, 0);
		const bounds = actorBoundsOf(auth);
		const within = bounds.nodeId === null ||
			fx.tree.isWithinSync(bounds.nodeId, row.id);
		if (!within) return Promise.reject(denied("scope"));
		const role = boundRole(granted, bounds, {
			withinTokenNode: within,
			laneId: target.laneId ?? null,
		});
		if (!scopesAllow(bounds.scopes, perm)) {
			return Promise.reject(denied("scopes"));
		}
		if (role < PERMISSION_MIN_ROLE[perm]) {
			return Promise.reject(denied("role"));
		}
		return Promise.resolve(role as EffectiveRole);
	};

	const ext = (installationId: string, scope: unknown): ExtHostApi => ({
		render: (...args) => {
			calls.push({ method: "render", installationId, scope, args });
			return Promise.resolve(hostReply("render") as never);
		},
		action: (...args) => {
			calls.push({ method: "action", installationId, scope, args });
			return Promise.resolve(hostReply("action") as never);
		},
		console: (...args) => {
			calls.push({ method: "console", installationId, scope, args });
			return Promise.resolve([
				{ seq: args[0] + 1, at: 1, level: "info", msg: "hello" },
			]);
		},
		deadLetters: (...args) => {
			calls.push({ method: "deadLetters", installationId, scope, args });
			return Promise.resolve([
				{ event_id: "e_1", stream: "forge", attempts: 5, error: "x", at: 1 },
			]);
		},
		breaker: () => {
			calls.push({ method: "breaker", installationId, scope, args: [] });
			return Promise.resolve({
				state: "open",
				until: 900_000,
				trips: 1,
				recentStrikes: 3,
				strikes: [{ seq: 3, at: 3, method: "render", kind: "cpu" }],
			});
		},
		resetBreaker: (...args) => {
			calls.push({ method: "resetBreaker", installationId, scope, args });
			return Promise.resolve({
				state: "closed",
				until: null,
				trips: 0,
				recentStrikes: 0,
				strikes: [],
			});
		},
		gate: (point, input, ctx) => {
			calls.push({
				method: "gate",
				installationId,
				scope,
				args: [point, input, ctx],
			});
			return gateReply(input);
		},
		deleteData: () => {
			calls.push({ method: "deleteData", installationId, scope, args: [] });
			return deleteFails.has(installationId)
				? Promise.reject(new Error("host down"))
				: Promise.resolve();
		},
	});
	const deleteFails = new Set<string>();
	const logs: ApiLogEntry[] = [];
	/** RepoDO event heads by repo id (default 7); an Error makes `head` fail. */
	const eventHeads = new Map<string, number | Error>();
	/** Each `events(repo).head()` read, with the host renders made before it. */
	const headReads: { repoId: string; rendersBefore: number }[] = [];

	const blobsStore = new Map<string, Uint8Array>();
	const deps: ApiDeps = {
		registry: () => registry.facade,
		tree: () => ({
			resolvePath: (path) => {
				const row = fx.tree.nodeByPathSync(path);
				return Promise.resolve(
					row === null ? null : { node: toDto(row), rest: "" },
				);
			},
			node: (id) => {
				const row = fx.tree.nodeSync(id);
				return Promise.resolve(row === null ? null : toDto(row));
			},
			// WP3's listing: children by path, two per page (callers follow the
			// cursor); `below` is a role somewhere under the child above its own.
			childrenAccess: (parentId, principals, cursor) => {
				const rows = fx.db.db.prepare(
					parentId === null
						? "SELECT id, path FROM nodes WHERE parent_id IS NULL ORDER BY path"
						: "SELECT id, path FROM nodes WHERE parent_id = ? ORDER BY path",
				).all(...(parentId === null ? [] : [parentId])) as {
					id: string;
					path: string;
				}[];
				const role = (id: string) =>
					fx.tree.effectiveRoleSync(principals, id, 0);
				const start = Number(cursor ?? "0");
				const end = start + 2;
				return Promise.resolve({
					nodes: rows.slice(start, end).map((row) => {
						const own = role(row.id);
						const descendants = fx.db.db.prepare(
							"SELECT id FROM nodes WHERE path LIKE ?",
						).all(`${row.path}/%`) as { id: string }[];
						return {
							node: toDto(fx.tree.nodeSync(row.id)!),
							granted: own,
							below: descendants.some((d) => role(d.id) > own),
							openBelow: null,
						};
					}),
					...(end < rows.length ? { cursor: String(end) } : {}),
				});
			},
			// Two repos per page, so callers must follow the cursor.
			listRepos: (options = {}) => {
				const all = fx.db.db.prepare(
					"SELECT id, path FROM nodes WHERE kind = 'repo' ORDER BY path",
				).all() as { id: string; path: string }[];
				const start = Number(options.cursor ?? "0");
				const end = start + 2;
				return Promise.resolve({
					repos: all.slice(start, end),
					...(end < all.length ? { cursor: String(end) } : {}),
				});
			},
		}),
		identity: () => ({
			principal: (id) =>
				Promise.resolve({
					id,
					kind: "user",
					handle: id.replace(/^u_/, ""),
					display: id.toUpperCase(),
					email: null,
					email_verified: 0,
					owner_user_id: null,
					agent_tool: null,
					agent_model: null,
					is_admin: 0,
					created_at: 0,
					disabled_at: null,
				}),
		}),
		authorize,
		repo: (repoId) => ({
			info: () =>
				repoInfoFails ? Promise.reject(new Error("down")) : Promise.resolve({
					id: repoId,
					nodeId: repoId,
					path: fx.tree.nodeSync(repoId)?.path ?? "",
					defaultBranch: "main",
					visibility: "private",
					trunkSha: sha,
					landingPaused: false,
				}),
			resolveRef: (ref) =>
				Promise.resolve(
					ref === "main" || ref === "refs/heads/main" ? sha : null,
				),
			getLane: (laneId) => Promise.resolve(lanes.get(laneId) ?? null),
		}),
		events: (repoId) => ({
			head: () => {
				headReads.push({
					repoId,
					rendersBefore: calls.filter((c) => c.method === "render").length,
				});
				const head = eventHeads.get(repoId) ?? 7;
				return head instanceof Error
					? Promise.reject(head)
					: Promise.resolve(head);
			},
		}),
		land: (repoId) => ({
			advances: ({ cursor, limit = 50 } = {}) => {
				const all = advances.get(repoId) ?? [];
				const start = Number(cursor ?? "0");
				const page = all.slice(start, start + limit);
				return Promise.resolve({
					advances: page,
					...(start + limit < all.length
						? { cursor: String(start + limit) }
						: {}),
				});
			},
			recordReplay: (r) => {
				replays.set(r.id, {
					id: r.id,
					installation_id: r.installationId,
					advances_json: JSON.stringify(r.results.map((x) => x.advanceId)),
					results_json: JSON.stringify(r.results),
					state: r.state,
					created_at: 0,
				});
				return Promise.resolve();
			},
			replay: (id) => Promise.resolve(replays.get(id) ?? null),
		}),
		probe: () => ({
			addedLines: (_source, base, head) => {
				const lines = added.get(`${base}..${head}`) ?? [];
				return Promise.resolve({ lines, truncated: false });
			},
			diffPaths: (_source, base, head) =>
				Promise.resolve({
					paths: [
						...new Set(
							(added.get(`${base}..${head}`) ?? []).map((l) => l.path),
						),
					]
						.map((path) => ({ path, status: "A" as const })),
					truncated: false,
				} as never),
		}),
		ext: ext as ApiDeps["ext"],
		blobs: () =>
			({
				put: (key: string, value: Uint8Array) => {
					blobsStore.set(key, value);
					return Promise.resolve(null);
				},
			}) as unknown as R2Bucket,
		log: (entry) => {
			logs.push(entry);
		},
	};
	return {
		fx,
		registry,
		deps,
		calls,
		logs,
		/** Makes `deleteData` fail for an installation's hosts. */
		failDelete: (installationId: string) => {
			deleteFails.add(installationId);
		},
		lanes,
		blobsStore,
		sha,
		advances,
		added,
		replays,
		setGateReply: (fn: typeof gateReply) => {
			gateReply = fn;
		},
		setHostReply: (fn: typeof hostReply) => {
			hostReply = fn;
		},
		failRepoInfo: () => {
			repoInfoFails = true;
		},
		eventHeads,
		headReads,
		nodeId: (path: string) => fx.tree.node(path).id,
	};
};

export type ApiFixture = ReturnType<typeof apiFixture>;

export const session = (
	principal: string,
	extra: Partial<AuthContext> = {},
): AuthContext => ({
	principal,
	kind: "user",
	via: "session",
	scopes: [],
	nodeId: null,
	laneId: null,
	maxRole: 50,
	isAdmin: false,
	...extra,
});

export const agentToken = (
	principal: string,
	extra: Partial<AuthContext> = {},
): AuthContext => ({
	principal,
	kind: "agent",
	via: "agent-token",
	scopes: ["api", "repo:read", "repo:write", "lanes"],
	nodeId: null,
	laneId: null,
	maxRole: 30,
	isAdmin: false,
	...extra,
});

export const renderedCtx = (call: HostCall): SlotContext =>
	call.args[1] as SlotContext;
