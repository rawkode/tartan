// Extension fan-out, production wiring (WP7b): `createExtDispatch(env)` is the
// `ExtDispatch` the gateway (push gates, echo), RepoDO core (`lane.open`
// gates), LandWorkflow (`ref.advance` gates) and the MCP host (`context_get`,
// tools) share. The logic is `createExtDispatchWith` (fanout.ts, pure and
// Deno-tested); this file binds it to ForgeDO's registry and tree, RepoDO, the
// RepoProbe entrypoint and the ExtensionDOs.

import { extDoName, FORGE_DO_NAME, repoDoName } from "@tartan/contract";
import {
	type CreateExtDispatch,
	type ForgeDoApi,
	type RepoDoApi,
	type RepoProbeApi,
	systemClock,
} from "@tartan/contract/kernel.ts";
import { withRpc } from "../../../do/dispose.ts";
import type { Env } from "../../../env.ts";
import { loopback } from "../../../exports.ts";
import { createExtDispatchWith, type DispatchHost } from "./fanout.ts";

export {
	assembleContextPack,
	createExtDispatchWith,
	DISPATCH_SLACK_MS,
	type DispatchDeps,
	type DispatchHost,
	scopeFor,
} from "./fanout.ts";

/**
 * The module-level `exports` of `cloudflare:workers`, imported on first use
 * so that importing this file (RepoDO core does) never loads a `cloudflare:`
 * module: Deno unit tests import those modules (AGENTS.md).
 */
const moduleExports = async (): Promise<unknown> =>
	(await import("cloudflare:workers")).exports;

/**
 * The production dispatcher. RepoProbe (echo inputs) is reached through the
 * Worker's own exports: the caller's `ctx.exports` when it passes `host`,
 * else the module-level `exports` of `cloudflare:workers`, so callers using
 * the contract signature `(env)` get the same inputs.
 */
export const createExtDispatch: CreateExtDispatch<Env> = (
	env: Env,
	host?: { readonly exports: unknown },
) => {
	// Typed through the contract facades: the RPC stub types are too deep here.
	const forge = () =>
		env.FORGE.getByName(FORGE_DO_NAME) as unknown as ForgeDoApi;
	const repo = (repoId: string) =>
		env.REPO.getByName(repoDoName(repoId)) as unknown as RepoDoApi;
	// The RPC stub is used inside the callback, never resolved through a
	// promise (a stub is not a value to await).
	const withProbe = async <T>(
		use: (probe: RepoProbeApi) => Promise<T>,
	): Promise<T> => {
		const exports = host === undefined ? await moduleExports() : host.exports;
		return await use(
			loopback({ exports }).RepoProbe as unknown as RepoProbeApi,
		);
	};
	return createExtDispatchWith({
		clock: systemClock,
		// Each facade stub is disposed once its call settles.
		inForce: (nodeId) =>
			withRpc(() => forge().registry(), (r) => r.inForce(nodeId)),
		provider: (iface, nodeId) =>
			withRpc(() => forge().registry(), (r) => r.provider(iface, nodeId)),
		protocolCards: (nodeId) =>
			withRpc(() => forge().registry(), (r) => r.protocolCards(nodeId)),
		host: (installationId, scope) =>
			env.EXT.getByName(
				extDoName(installationId, scope),
			) as unknown as DispatchHost,
		lane: (repoId, laneId) =>
			withRpc(() => repo(repoId).core(), (core) => core.getLane(laneId)),
		laneRange: (repoId, laneId) =>
			withRpc(() => repo(repoId).core(), (core) => core.laneRange(laneId)),
		addedLines: (source, base, head) =>
			withProbe((probe) => probe.addedLines(source, base, head)),
		diffPaths: (source, base, head) =>
			withProbe((probe) => probe.diffPaths(source, base, head)),
		node: async (id) => {
			const node = await withRpc(() => forge().tree(), (t) => t.node(id));
			return node === null
				? null
				: { id: node.id, path: node.path, kind: node.kind };
		},
		effectiveRole: (principals, nodeId) =>
			withRpc(
				() => forge().tree(),
				(t) => t.effectiveRole([...principals], nodeId),
			),
	});
};
