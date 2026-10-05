// Test-only: the MCP test forge (WP11). A three-level hierarchy with the
// Swarm pack installed on one subtree and the Classic pack on another, an
// owner user and two agents (Claude Code and Codex CLI) bounded at
// Developer, and helpers to open sessions and call tools.

import {
	type LaneHandle,
	ROLE,
	TARTAN_TRAILER_KEY,
	type TartanTrailer,
} from "@tartan/contract";
import type { AuthContext } from "@tartan/contract/kernel.ts";
import { createMcpHost, type McpHost } from "../host.ts";
import type { ToolCallResult } from "../result.ts";
import type { McpSession } from "../session.ts";
import { authOf, createFakeForge, type FakeForge } from "./fakes.ts";

export const SWARM_CARD =
	"# Swarm\n\nClaim work with a footprint; push early and often; submit when green.";
export const CLASSIC_CARD =
	"# Classic\n\nOpen a change; a human approves every change; FIFO lands one at a time.";

export type McpFixture = {
	readonly forge: FakeForge;
	readonly host: McpHost;
	readonly owner: string;
	readonly claude: string;
	readonly codex: string;
	/** `rawkode/platform/router` (Swarm). */
	readonly router: string;
	/** `rawkode/docs/site` (Classic). */
	readonly site: string;
	auth(principal: string, extra?: Partial<AuthContext>): AuthContext;
	open(principal: string, rest?: string, extra?: Partial<AuthContext>): Promise<
		McpSession
	>;
	call(
		session: McpSession,
		name: string,
		args?: unknown,
	): Promise<ToolCallResult>;
};

export const createMcpFixture = (
	options: { readonly repoIds?: { router?: string; site?: string } } = {},
): McpFixture => {
	const forge = createFakeForge();
	forge.addNode("rawkode", "user");
	forge.addNode("rawkode/platform", "group");
	const router = forge.addNode("rawkode/platform/router", "repo", {
		...(options.repoIds?.router ? { id: options.repoIds.router } : {}),
	});
	forge.addNode("rawkode/docs", "group");
	const site = forge.addNode("rawkode/docs/site", "repo", {
		...(options.repoIds?.site ? { id: options.repoIds.site } : {}),
	});
	forge.install("tartan.pack.swarm", "rawkode/platform", { card: SWARM_CARD });
	forge.install("tartan.pack.classic", "rawkode/docs", { card: CLASSIC_CARD });
	const owner = forge.addPrincipal({ kind: "user", handle: "rawkode" }).id;
	forge.grant(owner, "rawkode", ROLE.owner);
	const claude = forge.addPrincipal({
		kind: "agent",
		handle: "claude-1",
		owner,
		tool: "claude-code",
	}).id;
	const codex = forge.addPrincipal({
		kind: "agent",
		handle: "codex-1",
		owner,
		tool: "codex",
	}).id;
	const host = createMcpHost(forge.ports);
	const auth = (principal: string, extra: Partial<AuthContext> = {}) =>
		authOf(principal, {
			maxRole: principal.startsWith("a_") ? ROLE.developer : ROLE.owner,
			...extra,
		});
	return {
		forge,
		host,
		owner,
		claude,
		codex,
		router: router.id,
		site: site.id,
		auth,
		open: (principal, rest, extra) => host.open(auth(principal, extra), rest),
		call: (session, name, args = {}) => host.callTool(session, name, args),
	};
};

/** `structuredContent._tartan` of a result. */
export const trailerOf = (result: ToolCallResult): TartanTrailer =>
	result.structuredContent[TARTAN_TRAILER_KEY] as TartanTrailer;

/** The structured content without the trailer. */
export const valueOf = <T = Record<string, unknown>>(
	result: ToolCallResult,
): T => {
	const { [TARTAN_TRAILER_KEY]: _, ...rest } = result.structuredContent;
	return rest as T;
};

/** The lane handle of a `lanes_open` / `work_claim` result. */
export const handleOf = (result: ToolCallResult): LaneHandle =>
	valueOf<{ lane: LaneHandle }>(result).lane;
