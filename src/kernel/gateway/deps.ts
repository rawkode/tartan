// The gateway's ports built from the Worker's bindings (WP4): WP3's tree on
// ForgeDO (cached per isolate, so a clone's two or three requests cost one
// lookup), WP5a's RepoDO `core()`, WP8's RepoProbe through the loopback
// exports, the global `fetch` to the Artifacts remotes, and the fallback
// switches of `src/constants.ts`.

import {
	type EffectiveRole,
	FORGE_DO_NAME,
	type NodeDto,
	redactSecrets,
	repoDoName,
	ulid,
} from "@tartan/contract";
import type {
	RepoProbeApi,
	RepoStore,
	ResolvedPath,
} from "@tartan/contract/kernel.ts";
import {
	ARTIFACTS_CONTROL_PER_S_ISOLATE,
	echoEnabledOf,
	LANE_CAP_CLIENT_CHECK,
	LANE_CAP_TTL_S,
	maxPushBytes,
	PHASE1_FLUSH_WAIT_MS,
	UPSTREAM_AUTH,
} from "../../constants.ts";
import type { Env } from "../../env.ts";
import { loopback } from "../../exports.ts";
import { createExtDispatch } from "../exthost/host/dispatch.ts";
import { createCapMac } from "../http/capmac.ts";
import type { ControlBucket } from "../repo/upstream.ts";
import {
	type CapDeps,
	capFailureBuckets,
	type CapRepo,
	createCapControlBucket,
	createCapTokenMinter,
} from "./cap.ts";
import { canonicalPushPolicy, laneRepoPolicy } from "./policy.ts";
import type {
	GatewayConfig,
	GatewayDeps,
	GatewayRepo,
	GatewayTree,
} from "./types.ts";

/** Isolate cache lifetimes: paths and roles as RepoDO's role cache, node paths longer. */
export const TREE_CACHE_MS = { path: 10_000, role: 10_000, node: 60_000 };
/** Entries per cache before the oldest are dropped. */
const CACHE_MAX = 2_000;

type Entry<T> = { readonly value: T; readonly at: number };

/**
 * A small TTL cache keyed by string (per isolate). Only non-null answers
 * are kept, so a repo created a moment ago is found at once.
 */
export const createTtlCache = <T>(
	ttlMs: number,
	now: () => number = Date.now,
) => {
	const entries = new Map<string, Entry<T>>();
	return async (key: string, load: () => Promise<T>): Promise<T> => {
		const hit = entries.get(key);
		if (hit !== undefined && now() - hit.at < ttlMs) return hit.value;
		const value = await load();
		if (value !== null && value !== undefined) {
			entries.delete(key);
			entries.set(key, { value, at: now() });
			if (entries.size > CACHE_MAX) {
				const oldest = entries.keys().next().value;
				if (oldest !== undefined) entries.delete(oldest);
			}
		}
		return value;
	};
};

const pathCache = createTtlCache<ResolvedPath | null>(TREE_CACHE_MS.path);
const roleCache = createTtlCache<EffectiveRole>(TREE_CACHE_MS.role);
const nodeCache = createTtlCache<NodeDto | null>(TREE_CACHE_MS.node);

/** WP3's tree on ForgeDO, cached per isolate. */
export const createTreePort = (env: Env): GatewayTree => {
	const tree = () => env.FORGE.getByName(FORGE_DO_NAME).tree();
	return {
		resolvePath: (path) =>
			pathCache(
				path,
				() => tree().resolvePath(path) as Promise<ResolvedPath | null>,
			),
		effectiveRole: (principals, nodeId) =>
			roleCache(
				`${nodeId}|${principals.join(",")}`,
				() => tree().effectiveRole(principals, nodeId),
			),
		node: (id) =>
			nodeCache(id, () => tree().node(id) as Promise<NodeDto | null>),
	};
};

export const gatewayConfig = (env: Env): GatewayConfig => ({
	maxPushBytes: maxPushBytes(env.TARTAN_MAX_PUSH_MB),
	echo: echoEnabledOf(env),
	upstreamAuth: UPSTREAM_AUTH,
	phase1WaitMs: PHASE1_FLUSH_WAIT_MS,
	policy: canonicalPushPolicy,
	lanePolicy: laneRepoPolicy,
});

/** The per-isolate Artifacts control bucket of the capability route (WP4-owned). */
let capControl: ControlBucket | null = null;
let capMinter: {
	readonly artifacts: Env["ARTIFACTS"];
	readonly mint: CapDeps["mintReadToken"];
} | null = null;

const log = (message: string, data: Record<string, unknown>): void =>
	console.error(redactSecrets(message), redactSecrets(JSON.stringify(data)));

/**
 * The capability route's ports. Building them makes no Durable
 * Object call: RepoDO is reached only through `repo(…)`, which the route
 * calls after the MAC verified; WP2's keyring derives `LANE_CAP_KEY` once
 * per isolate.
 */
export const createCapDeps = (env: Env): CapDeps => {
	capControl ??= createCapControlBucket(ARTIFACTS_CONTROL_PER_S_ISOLATE);
	if (capMinter === null || capMinter.artifacts !== env.ARTIFACTS) {
		capMinter = {
			artifacts: env.ARTIFACTS,
			mint: createCapTokenMinter({
				artifacts: env.ARTIFACTS as unknown as RepoStore,
				bucket: capControl,
				ttlS: LANE_CAP_TTL_S,
				log,
			}),
		};
	}
	const mac = createCapMac(env);
	return {
		verifyMac: (fields, value) => mac.verify(fields, value),
		repo: (repoId) =>
			env.REPO.getByName(repoDoName(repoId)).core() as unknown as CapRepo,
		mintReadToken: capMinter.mint,
		fetch: (request) => fetch(request),
		now: () => Date.now(),
		log,
		buckets: capFailureBuckets,
		config: {
			ttlS: LANE_CAP_TTL_S,
			clientCheck: LANE_CAP_CLIENT_CHECK,
			upstreamAuth: UPSTREAM_AUTH,
		},
	};
};

/** Every port from the bindings of one request. */
export const createGatewayDeps = (
	env: Env,
	ctx: ExecutionContext,
): GatewayDeps => ({
	tree: createTreePort(env),
	repo: (repoId) =>
		env.REPO.getByName(repoDoName(repoId)).core() as unknown as GatewayRepo,
	// Ref-policy row 1: asked only for a user's push to an importing repo.
	isForgeOwner: (principal) =>
		env.FORGE.getByName(FORGE_DO_NAME).identity().isOwner(principal),
	probe: () => ({
		// The request's `ctx.exports`, else the module-level `exports` (imported
		// on first use, so Deno tests can load this module).
		laneDiff: async (source, after) => {
			const exports = (ctx as { exports?: unknown }).exports ??
				(await import("cloudflare:workers")).exports;
			const probe = loopback({ exports }).RepoProbe as unknown as Pick<
				RepoProbeApi,
				"laneDiff"
			>;
			return await probe.laneDiff(source, after);
		},
	}),
	// The push echo: the fan-out every caller shares (dispatch.ts), RepoProbe
	// for the echo inputs through the request's own exports.
	echo: async (event, at, budgetMs) => {
		const exports = (ctx as { exports?: unknown }).exports ??
			(await import("cloudflare:workers")).exports;
		return await createExtDispatch(env, { exports }).echo(event, at, budgetMs);
	},
	fetch: (request) => fetch(request),
	requestId: ulid,
	log,
	config: gatewayConfig(env),
});
