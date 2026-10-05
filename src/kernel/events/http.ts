// HTTP plumbing shared by the WP6 routes (`/-/live`, `/-/api/events`,
// `/-/api/audit`, `/-/api/inbox`): JSON and error responses, query parsing,
// and the kernel ports the handlers use, each a contract facade or seam
// (ForgeDO tree/identity/events, RepoDO events, InboxDO, WP3's `authorize`).
// Handlers take the ports as a parameter so tests can inject fakes.

import {
	type EffectiveRole,
	FORGE_DO_NAME,
	httpStatus,
	inboxDoName,
	invalid,
	type NodeDto,
	notFound,
	type Permission,
	repoDoName,
	toWire,
	ULID_RE,
} from "@tartan/contract";
import type {
	AuthContext,
	ForgeEventsFacade,
	RepoEventsFacade,
} from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import type { RouteContext, RouteHandler } from "../../router.ts";
import { createAuthorize } from "../tree/authz.ts";
import type { InboxApi } from "../inbox/module.ts";

const NO_STORE = { "cache-control": "no-store" } as const;

export const json = (body: unknown, status = 200): Response =>
	Response.json(body, { status, headers: NO_STORE });

export const errorResponse = (error: unknown): Response => {
	const wire = toWire(error);
	return Response.json(wire, {
		status: httpStatus(wire.error),
		headers: NO_STORE,
	});
};

/** An integer query parameter in `[min, max]`, or `def` when absent. */
export const intParam = (
	url: URL,
	name: string,
	def: number,
	min = 0,
	max = Number.MAX_SAFE_INTEGER,
): number => {
	const text = url.searchParams.get(name);
	if (text === null || text === "") return def;
	const value = Number(text);
	if (!Number.isInteger(value) || value < min || value > max) {
		throw invalid(`${name} must be an integer in [${min}, ${max}]`);
	}
	return value;
};

export const repoParam = (url: URL, name = "repo"): string => {
	const repo = url.searchParams.get(name);
	if (repo === null || !ULID_RE.test(repo)) {
		throw invalid(`${name} is a repo id`);
	}
	return repo;
};

export type KernelPorts = {
	/** WP3: the caller's bounded role at `node` when it reaches `perm`; throws otherwise. */
	authorize(
		auth: AuthContext | null,
		node: NodeDto,
		perm: Permission,
	): Promise<EffectiveRole>;
	/** ForgeDO tree: a node by id (repos are nodes). */
	node(id: string): Promise<NodeDto | null>;
	/** The canonical origin (ForgeDO setup state), `url.origin` before setup records one. */
	canonicalOrigin(url: URL): Promise<string>;
	/** A principal's effective role on a repo (ForgeDO tree). */
	roleOn(principal: string, repoId: string): Promise<EffectiveRole>;
	/** A principal id by handle (ForgeDO identity), or null. */
	principalByHandle(handle: string): Promise<string | null>;
	repoEvents(repoId: string): RepoEventsFacade;
	/** HTTP into a RepoDO (the `/-/live` upgrade). */
	repoFetch(repoId: string, req: Request): Promise<Response>;
	forgeEvents(): ForgeEventsFacade;
	inbox(principal: string): InboxApi;
};

const ORIGIN_TTL_MS = 60_000;
/** Per isolate: the canonical origin changes only at setup. */
let originCache: { value: string | undefined; until: number } | null = null;

export const kernelPorts = (env: Env): KernelPorts => {
	const forge = () => env.FORGE.getByName(FORGE_DO_NAME);
	const authorize = createAuthorize(env);
	return {
		authorize: (auth, node, perm) => authorize(auth, { node }, perm),
		node: (id) => forge().tree().node(id),
		canonicalOrigin: async (url) => {
			const now = Date.now();
			if (originCache === null || originCache.until < now) {
				const state = await forge().identity().setupState();
				originCache = {
					value: state.canonicalOrigin,
					until: now + ORIGIN_TTL_MS,
				};
			}
			return originCache.value ?? url.origin;
		},
		roleOn: (principal, repoId) =>
			forge().tree().effectiveRole([principal], repoId),
		principalByHandle: async (handle) =>
			(await forge().identity().principalByHandle(handle))?.id ?? null,
		repoEvents: (repoId) =>
			env.REPO.getByName(repoDoName(repoId))
				.events() as unknown as RepoEventsFacade,
		repoFetch: (repoId, req) =>
			env.REPO.getByName(repoDoName(repoId)).fetch(req),
		forgeEvents: () => forge().events() as unknown as ForgeEventsFacade,
		inbox: (principal) =>
			env.INBOX.getByName(inboxDoName(principal)) as unknown as InboxApi,
	};
};

/** A route handler over injected ports; every throw becomes a JSON error. */
export const withPorts = (
	handler: (c: RouteContext, ports: KernelPorts) => Promise<Response>,
	ports: (env: Env) => KernelPorts = kernelPorts,
): RouteHandler =>
async (c) => {
	try {
		return await handler(c, ports(c.env));
	} catch (error) {
		return errorResponse(error);
	}
};

/** The repo node behind a repo id, or a `not_found`. */
export const repoNode = async (
	ports: KernelPorts,
	repoId: string,
): Promise<NodeDto> => {
	const node = await ports.node(repoId);
	if (node === null || node.kind !== "repo") {
		throw notFound(`no repo ${repoId}`);
	}
	return node;
};
