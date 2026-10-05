// ForgeDO `tree` module (WP3, migrations 200–299): nodes,
// redirects, grants, protected refs, artifacts_index (canonical and lane
// repos, with the forge-wide lane-repo ceiling), repo create and import.
// Timer `tree` (`tree:create:<repoId>`: roll back a create that never
// finished). The facade is the contract's `TreeFacade` plus WP3's own
// additions (`TreeExtras`, used only by WP3's routes); the internal API is
// `TreeInternal`, for sibling modules inside one `transactionSync`.

import {
	type EffectiveRole,
	invalid,
	type NodeDto,
	repoDoName,
	type Visibility,
} from "@tartan/contract";
import {
	type DoModule,
	type ForgeInternals,
	MIGRATION_RANGES,
	type ModuleDeps,
	type NodeRow,
	type TreeFacade,
	type TreeInternal,
} from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import {
	countLaneReposSync,
	indexArtifactsSync,
	listArtifactsIndexSync,
	lookupArtifactsSync,
} from "./artifacts.ts";
import {
	errorText,
	type RepoSetupPort,
	type TreeContext,
	type TreeLog,
	type TreePorts,
} from "./context.ts";
import { createGenesis, type GenesisCore } from "./genesis.ts";
import {
	archiveNodeSync,
	childrenSync,
	createGroupSync,
	createRootSync,
	grantSync,
	listReposSync,
	moveNodeSync,
	protectedRefsSync,
	requireNode,
	resolvePathSync,
	revokeSync,
	type RootInput,
} from "./nodes.ts";
import { ancestorPaths } from "./paths.ts";
import { CREATE_TIMER_PREFIX, createRepoCreation } from "./repos.ts";
import { createRoles } from "./roles.ts";
import { TREE_MIGRATIONS } from "./schema.ts";
import { first, grantRows, nodeById, nodeByPath, nodeDto } from "./store.ts";

/** One child with what the caller's grants say about it (WP3's listing). */
export type ChildAccess = {
	readonly node: NodeDto;
	/** The principals' grants role at the child (inherited included). */
	readonly granted: EffectiveRole;
	/** A grant strictly below the child. */
	readonly below: boolean;
	/** The most open visibility strictly below the child. */
	readonly openBelow: Visibility | null;
};

/** WP3's additions to the contract facade (its routes only). */
export type TreeExtras = {
	/** `createRoot` with visibility and description (root groups from the API). */
	createRootNode(input: RootInput): Promise<NodeDto>;
	childrenAccess(
		nodeId: string | null,
		principals: readonly string[],
		cursor?: string,
	): Promise<{ nodes: ChildAccess[]; cursor?: string }>;
	/** After RepoDO's `importComplete`: the node's default branch ⇒ forge `repo.imported`. */
	importCompleted(
		by: string,
		repoId: string,
		defaultBranch: string,
	): Promise<NodeDto>;
};

export type TreeKernelFacade = TreeFacade & TreeExtras;

export type TreeModuleOptions = {
	/** Artifacts, RepoDO core, genesis (tests: fakes). */
	readonly ports?: (deps: ModuleDeps<Env, ForgeInternals>) => TreePorts;
	readonly log?: TreeLog;
};

const consoleLog: TreeLog = (message, data) =>
	console.error(`[tartan] tree: ${message}`, JSON.stringify(data));

/** The real ports: `env.ARTIFACTS`, RepoDO `core`, WP3's in-Worker genesis. */
export const envTreePorts = (
	deps: Pick<ModuleDeps<Env, ForgeInternals>, "env" | "clock">,
): TreePorts => {
	const core = (repoId: string) =>
		deps.env.REPO.getByName(repoDoName(repoId)).core();
	return {
		artifacts: deps.env.ARTIFACTS,
		repo: (repoId) => core(repoId) as unknown as RepoSetupPort,
		genesis: createGenesis({
			core: (repoId) => core(repoId) as unknown as GenesisCore,
			clock: deps.clock,
		}),
	};
};

/** A facade whose methods may answer synchronously (`promising` wraps them). */
type MaybeSync<T> = {
	[K in keyof T]: T[K] extends (...args: infer A) => Promise<infer R>
		? (...args: A) => R | Promise<R>
		: T[K];
};

/**
 * Every facade method answers with a promise: a synchronous throw (a check,
 * a refused transaction) becomes a rejection, as it would over RPC.
 */
const promising = <T extends object>(facade: MaybeSync<T>): T =>
	Object.fromEntries(
		Object.entries(facade).map(([name, method]) => [
			name,
			(...args: unknown[]) => {
				try {
					return Promise.resolve(
						(method as (...a: unknown[]) => unknown)(...args),
					);
				} catch (error) {
					return Promise.reject(error);
				}
			},
		]),
	) as T;

const OPENNESS = ["private", "internal", "public"] as const;

export const createTreeModule = (
	options: TreeModuleOptions = {},
): DoModule<TreeKernelFacade, TreeInternal, Env, ForgeInternals> => ({
	name: "tree",
	range: MIGRATION_RANGES.forge.tree,
	migrations: TREE_MIGRATIONS,
	create: (deps) => {
		const log = options.log ?? consoleLog;
		const roles = createRoles({
			sql: deps.sql,
			identity: () => deps.modules.identity,
		});
		const c: TreeContext = {
			sql: deps.sql,
			tx: (fn) => deps.storage.transactionSync(fn),
			clock: deps.clock,
			ids: deps.ids,
			roles,
			timers: deps.timers,
			ports: (options.ports ?? envTreePorts)(deps),
			events: () => deps.modules.events,
			identity: () => deps.modules.identity,
			log,
			waitUntil: (promise) => {
				const ctx = deps.ctx as Partial<DurableObjectState>;
				if (typeof ctx.waitUntil === "function") ctx.waitUntil(promise);
				else promise.catch(() => {});
			},
		};
		const repos = createRepoCreation(c);
		const now = () => c.clock.now();

		/** RepoDO path caches of the repos a move touched (best effort). */
		const refreshPaths = (moved: readonly NodeRow[]): void => {
			for (const repo of moved.slice(0, 200)) {
				c.waitUntil(
					c.ports.repo(repo.id).init({
						repoId: repo.id,
						nodeId: repo.id,
						path: repo.path,
						defaultBranch: repo.default_branch ?? "main",
					}).catch((error) =>
						log("repo path refresh failed", {
							repoId: repo.id,
							error: errorText(error),
						})
					),
				);
			}
			if (moved.length > 200) {
				log("repo path refresh capped", { repos: moved.length });
			}
		};

		const openBelow = (node: NodeRow): Visibility | null => {
			const row = first<{ v: number | null }>(
				c.sql,
				`SELECT MAX(CASE visibility WHEN 'public' THEN 2 WHEN 'internal' THEN 1 ELSE 0 END) AS v
				 FROM nodes WHERE path > ?1 || '/' AND path < ?1 || '0'`,
				node.path,
			);
			const v = row?.v ?? null;
			return v === null || v === 0 ? null : OPENNESS[v];
		};

		const facade: TreeKernelFacade = promising<TreeKernelFacade>({
			resolvePath: (path: string) => resolvePathSync(c, path),
			node: (id: string) => {
				const row = typeof id === "string" ? nodeById(c.sql, id) : null;
				return row === null ? null : nodeDto(row);
			},
			children: (nodeId: string | null, cursor?: string) => {
				if (nodeId !== null) requireNode(c, nodeId);
				const page = childrenSync(c, nodeId, cursor);
				return {
					nodes: page.nodes.map(nodeDto),
					...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
				};
			},
			createRoot: (input) => nodeDto(c.tx(() => createRootSync(c, input))),
			createRootNode: (input) => nodeDto(c.tx(() => createRootSync(c, input))),
			createNode: (by, input) =>
				nodeDto(c.tx(() => createGroupSync(c, by, input))),
			createRepo: (by, input) => repos.createRepo(by, input),
			importRepo: (by, input) => repos.importRepo(by, input),
			// Repository config (ADR repo config): a move or an archive changes
			// which approvals and ancestor installations bind below the node, so
			// the registry drops the repo-config rows and overlays that no longer
			// bind, and moves the schema epoch, in the same transaction.
			moveNode: (by, nodeId, to) => {
				const result = c.tx(() => {
					const moved = moveNodeSync(c, by, nodeId, to);
					if (!("unchanged" in moved)) {
						deps.modules.registry.revalidateRepoConfigSync(by, nodeId);
					}
					return moved;
				});
				if ("repos" in result) refreshPaths(result.repos);
				return nodeDto(result.node);
			},
			archiveNode: (by, nodeId) => {
				c.tx(() => {
					archiveNodeSync(c, by, nodeId);
					deps.modules.registry.revalidateRepoConfigSync(by, nodeId);
				});
			},
			effectiveRole: (principals, nodeId) => {
				if (!Array.isArray(principals)) throw invalid("principals is a list");
				return roles.at(principals, nodeId, now());
			},
			grant: (by, nodeId, principal, role, expiresAt) => {
				c.tx(() => grantSync(c, by, nodeId, principal, role, expiresAt));
			},
			revoke: (by, nodeId, principal) => {
				c.tx(() => revokeSync(c, by, nodeId, principal));
			},
			grants: (nodeId) => grantRows(c.sql, requireNode(c, nodeId).id),
			protectedRefs: (nodeId) => protectedRefsSync(c, nodeId),
			listRepos: (o) => listReposSync(c, o),
			indexArtifacts: (input) => c.tx(() => indexArtifactsSync(c, input)),
			lookupArtifacts: (name) => lookupArtifactsSync(c, name),
			listArtifactsIndex: (state, olderThan) =>
				listArtifactsIndexSync(c, state, olderThan),
			countLaneRepos: () => countLaneReposSync(c),
			childrenAccess: (nodeId, principals, cursor) => {
				if (!Array.isArray(principals)) throw invalid("principals is a list");
				if (nodeId !== null) requireNode(c, nodeId);
				const page = childrenSync(c, nodeId, cursor);
				const at = now();
				return {
					nodes: page.nodes.map((row) => ({
						node: nodeDto(row),
						granted: roles.atPath(principals, row.path, at),
						below: roles.holdsBelow(principals, row, at),
						openBelow: openBelow(row),
					})),
					...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
				};
			},
			importCompleted: (by, repoId, defaultBranch) =>
				repos.importCompleted(by, repoId, defaultBranch),
		});

		const internal: TreeInternal = {
			nodeSync: (id) => nodeById(c.sql, id),
			nodeByPathSync: (path) => nodeByPath(c.sql, path),
			ancestorPathsSync: (nodeId) => {
				const node = nodeById(c.sql, nodeId);
				return node === null ? [] : ancestorPaths(node.path);
			},
			effectiveRoleSync: (principals, nodeId, at) =>
				roles.at(principals, nodeId, at),
			isWithinSync: (rootNodeId, nodeId) => roles.isWithin(rootNodeId, nodeId),
			holdsRoleWithinSync: (principal, rootNodeId, at) =>
				roles.holdsWithin(principal, rootNodeId, at),
			createRootSync: (input) => createRootSync(c, input),
			grantSync: (by, nodeId, principal, role) =>
				grantSync(c, by, nodeId, principal, role),
		};

		const onTimer = async (key: string): Promise<void> => {
			if (key.startsWith(CREATE_TIMER_PREFIX)) {
				await repos.onCreateTimer(key);
				return;
			}
			log("unknown timer", { key });
		};

		return { facade, internal, onTimer };
	},
});

export const treeModule = createTreeModule();
