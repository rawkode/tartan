// The MCP host's ports on the real facades (WP11). Reads by SHA and
// RepoProbe go through WP7b's `createKernelPorts` (the same readers caps
// uses, K15); tool routing and `context_get` through WP7b's
// `createExtDispatch`; authorization through WP3's `createNodeAccess`
// (`authorize`'s role and the member role of the public view).

import {
	extDoName,
	FORGE_DO_NAME,
	inboxDoName,
	repoDoName,
} from "@tartan/contract";
import type { Env } from "../../env.ts";
import { createKernelPorts } from "../caps/ports.ts";
import { createExtDispatch } from "../exthost/host/dispatch.ts";
import { setupInfo } from "../http/isolate.ts";
import { createNodeAccess } from "../tree/authz.ts";
import type {
	McpInbox,
	McpPorts,
	McpRepoPorts,
	ProtocolCard,
} from "./ports.ts";

/** Protocol cards change only on install, upgrade or mode changes. */
export const CARDS_CACHE_MS = 5_000;
const CARDS_CACHE_MAX = 1_000;

type CardsEntry = { readonly cards: ProtocolCard[]; readonly until: number };
/** Per isolate (module state by design): `protocolCards` by node id. */
const cardsCache = new Map<string, CardsEntry>();

const cachedCards = (
	load: (nodeId: string) => Promise<ProtocolCard[]>,
	now: () => number,
) =>
async (nodeId: string): Promise<ProtocolCard[]> => {
	const hit = cardsCache.get(nodeId);
	const at = now();
	if (hit !== undefined && hit.until > at) return hit.cards;
	const cards = await load(nodeId);
	if (cardsCache.size >= CARDS_CACHE_MAX) cardsCache.clear();
	cardsCache.set(nodeId, { cards, until: at + CARDS_CACHE_MS });
	return cards;
};

/** Test hook: forget cached cards. */
export const resetMcpIsolateState = (): void => cardsCache.clear();

/**
 * The ports for one request. `host` is the request's `ExecutionContext`
 * (its `exports` reach the loopback RepoProbe entrypoint).
 */
export const createMcpPorts = (
	env: Env,
	host?: { readonly exports: unknown },
): McpPorts => {
	const forge = () => env.FORGE.getByName(FORGE_DO_NAME);
	const kernel = createKernelPorts(env, host);
	const access = createNodeAccess(env);
	const dispatch = createExtDispatch(env, host);
	const now = () => Date.now();
	return {
		canonicalOrigin: async () => (await setupInfo(env)).canonicalOrigin,
		resolvePath: (path) => forge().tree().resolvePath(path),
		node: (id) => forge().tree().node(id),
		listRepos: (options) => forge().tree().listRepos(options),
		authorize: async (auth, target, perm) =>
			(await access(auth, target, perm)).role,
		access,
		effectiveRole: (principals, nodeId) =>
			forge().tree().effectiveRole([...principals], nodeId),
		principal: (id) => forge().identity().principal(id),
		principalByHandle: (handle) => forge().identity().principalByHandle(handle),
		protocolCards: cachedCards(
			(nodeId) => forge().registry().protocolCards(nodeId),
			now,
		),
		provider: (iface, nodeId) => forge().registry().provider(iface, nodeId),
		dispatch,
		callTool: (target, name, args, ctx, bounds) =>
			env.EXT.getByName(extDoName(target.installationId, target.scope))
				.callTool(name, args, ctx, bounds),
		repo: (repoId) => {
			const stub = env.REPO.getByName(repoDoName(repoId));
			return {
				core: stub.core(),
				events: stub.events(),
				runs: stub.runs(),
				land: stub.land(),
				repoconfig: stub.repoconfig(),
			} as unknown as McpRepoPorts;
		},
		reader: (source) => kernel.reader(source),
		probe: {
			projectGraph: (repoId, sha) => kernel.probe.projectGraph(repoId, sha),
			affected: (repoId, base, head, options) =>
				kernel.probe.affected(repoId, base, head, options),
		},
		repoConfigSchema: (repoId) => forge().registry().repoConfigSchema(repoId),
		repoConfigEffective: (repoId) =>
			forge().registry().repoConfigEffective(repoId),
		repoConfigEnabled: () => env.TARTAN_REPO_CONFIG === "on",
		inbox: (principal) =>
			env.INBOX.getByName(inboxDoName(principal)) as unknown as McpInbox,
		now,
		log: (message, data) => console.log(message, JSON.stringify(data ?? {})),
	};
};
