// The SwarmWorkflow's real dependencies (WP20): ForgeDO's tree, registry and
// identity facades, RepoDO's core, the Artifacts binding, R2 for status, the
// SWARM binding for child instances, and the Worker's own router for the
// agents' in-process requests. Each facade call opens its stub and disposes
// it when the call settles (`withRpc`).

import { FORGE_DO_NAME, isTartanError, repoDoName } from "@tartan/contract";
import type {
	IdentityFacade,
	RegistryFacade,
	RepoCoreFacade,
	TreeFacade,
} from "@tartan/contract/kernel.ts";
import { withRpc } from "../../do/dispose.ts";
import type { Env } from "../../env.ts";
import { createRouter } from "../../router.ts";
import type { DriverDeps } from "./driver.ts";
import { swarmEnabled } from "./routes.ts";
import type { SetupDeps } from "./setup.ts";
import { createSwarmStore } from "./store.ts";
import { createCollectingContext } from "./transport.ts";

/** Agents are Developers (role 30): they claim, push their lanes and submit. */
const AGENT_ROLE = 30;

const forge = (env: Env) => env.FORGE.getByName(FORGE_DO_NAME);
const tree = (env: Env) => () => forge(env).tree() as unknown as TreeFacade;
const registry = (env: Env) => () =>
	forge(env).registry() as unknown as RegistryFacade;
const identity = (env: Env) => () =>
	forge(env).identity() as unknown as IdentityFacade;
const core = (env: Env, repoId: string) => () =>
	env.REPO.getByName(repoDoName(repoId)).core() as unknown as RepoCoreFacade;

export const createSetupDeps = (env: Env, by: string): SetupDeps => ({
	by,
	resolve: async (path) => {
		const found = await withRpc(tree(env), (t) => t.resolvePath(path));
		return found && found.rest === "" && found.redirectTo === undefined
			? found.node
			: null;
	},
	createGroup: (parentId, slug, description) =>
		withRpc(
			tree(env),
			(t) => t.createNode(by, { parentId, kind: "group", slug, description }),
		),
	createRepo: (parentId, slug, description) =>
		withRpc(
			tree(env),
			(t) => t.createRepo(by, { parentId, slug, description }),
		),
	inForce: async (nodeId) =>
		(await withRpc(registry(env), (r) => r.inForce(nodeId))).map((i) =>
			i.installation.extId
		),
	install: async (extId, node) => {
		await withRpc(
			registry(env),
			(r) => r.install(by, { extId, version: "0.1.0", node, mode: "enforce" }),
		);
	},
	repo: (repoId) => ({
		info: () => withRpc(core(env, repoId), (c) => c.info()),
		setLaneSettings: (input) =>
			withRpc(
				core(env, repoId),
				(c) => c.setLaneSettings(input, { kind: "user", id: by }),
			),
		// Sim agents exist only with dev tools (bulk minting refuses without
		// them), and RepoDO marks a shard only then; without them a
		// swarm (a test pool) runs regular agents and marks nothing.
		markSimulated: () =>
			swarmEnabled(env)
				? withRpc(core(env, repoId), (c) => c.markSimulated())
				: Promise.resolve(),
		upstream: () => withRpc(core(env, repoId), (c) => c.upstream({}, "write")),
		registerKernelWrite: (intent) =>
			withRpc(core(env, repoId), (c) => c.registerKernelWrite(intent)),
		markKernelWrite: (id, state) =>
			withRpc(core(env, repoId), (c) => c.markKernelWrite(id, state)),
	}),
	objects: async (name) => {
		const repo = await env.ARTIFACTS.get(name);
		return {
			readCommit: async (sha) => {
				const meta = await repo.readCommit(sha);
				return meta ? { treeHash: meta.treeHash } : null;
			},
			readTree: async (sha) => await repo.readTree(sha),
		};
	},
	now: () => Date.now(),
});

const alreadyExists = (error: unknown): boolean =>
	/already exists|duplicate|instance\.already_exists/i.test(
		error instanceof Error ? error.message : String(error),
	);

export const createDriverDeps = (env: Env, by: string): DriverDeps => {
	const router = createRouter();
	return {
		store: createSwarmStore(env.BLOBS),
		setup: () => createSetupDeps(env, by),
		createInstance: async (id, params) => {
			try {
				await env.SWARM.create({ id, params });
			} catch (error) {
				// A retried step creates the same deterministic id again.
				if (!alreadyExists(error)) throw error;
			}
		},
		mintAgents: async ({ prefix, count, nodeId, ttlMs }) => {
			try {
				return await withRpc(identity(env), (i) =>
					i.bulkMintAgents(by, {
						count,
						prefix,
						nodeId,
						maxRole: AGENT_ROLE,
						ttlMs,
					}));
			} catch (error) {
				throw isTartanError(error)
					? error
					: new Error("bulk agent tokens are unavailable");
			}
		},
		router: () => {
			const { ctx, settle } = createCollectingContext();
			return {
				handle: (req) => router(req, env, ctx),
				settle,
			};
		},
		now: () => Date.now(),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	};
};
