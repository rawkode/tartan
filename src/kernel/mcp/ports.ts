// The seams the MCP host calls (WP11). Every port is a
// contract facade or seam of its owning module: ForgeDO tree (WP3), identity
// (WP2) and registry (WP7a), WP3's `authorize`, WP7b's `ExtDispatch` and the
// ExtensionDOs, RepoDO core/events/runs/land (WP5a, WP6, WP9, WP10), InboxDO
// (WP6), RepoProbe (WP8) and SHA reads through the Artifacts binding (K15).
// `createMcpPorts(env, host)` (wiring.ts) binds them to the Worker; tests
// pass fakes of the same shape.

import type {
	ActorBounds,
	EffectiveRole,
	ExtScope,
	InstallationInForce,
	Notice,
	NoticeInput,
	Permission,
	ToolContext,
} from "@tartan/contract";
import type {
	AuthContext,
	AuthorizeTarget,
	DeliveryChannel,
	ExtDispatch,
	PrincipalRow,
	RegistryFacade,
	RepoConfigFacade,
	RepoCoreFacade,
	RepoEventsFacade,
	RepoLandFacade,
	RepoProbeApi,
	RepoRunsFacade,
	ResolvedPath,
} from "@tartan/contract/kernel.ts";
import type { NodeDto } from "@tartan/contract";
import type { SourceReader } from "../caps/ports.ts";
import type { GitSource } from "@tartan/contract";

/** The RepoDO facades the MCP host calls for one repo. */
export type McpRepoPorts = {
	readonly core: Pick<
		RepoCoreFacade,
		| "info"
		| "resolveRef"
		| "readContext"
		| "getLane"
		| "listLanes"
		| "openLane"
		| "closeLane"
		| "delegateLane"
		| "syncLane"
		| "restackLane"
		| "awaitLane"
	>;
	readonly events: Pick<RepoEventsFacade, "read" | "head">;
	readonly runs: Pick<RepoRunsFacade, "get" | "logs">;
	readonly land: Pick<RepoLandFacade, "why">;
	/** Repository config (WP23): reads and previews only. */
	readonly repoconfig: Pick<
		RepoConfigFacade,
		"state" | "preview" | "previewByKey"
	>;
};

/** The caller's InboxDO (`inbox:<principal>`). */
export type McpInbox = {
	peek(
		limit: number,
		via: DeliveryChannel,
		repoId?: string,
	): Promise<Notice[]>;
	read(
		query: { since?: number; repoId?: string; limit?: number },
	): Promise<Notice[]>;
	ack(ids: string[]): Promise<{ acked: number }>;
	wait(
		timeoutMs: number,
		repoId?: string,
		via?: DeliveryChannel,
	): Promise<Notice[]>;
	deliver(
		notice: NoticeInput & { source: string; sourceLabel?: string },
	): Promise<{ id: string; created: boolean }>;
};

/** An ExtensionDO a tool call goes to (the provider's, or an extension's own). */
export type McpToolTarget = {
	readonly installationId: string;
	readonly scope: ExtScope;
};

export type ProtocolCard = {
	readonly installation: string;
	readonly ext: string;
	readonly md: string;
};

/** `authorize`'s answer and the member role (WP3's `NodeAccess`). */
export type McpAccess = {
	readonly role: EffectiveRole;
	readonly member: EffectiveRole;
};

export interface McpPorts {
	/** The forge's `canonical_origin` (ForgeDO setup state, isolate-cached); null before setup records one. */
	canonicalOrigin(): Promise<string | null>;
	resolvePath(path: string): Promise<ResolvedPath | null>;
	node(id: string): Promise<NodeDto | null>;
	/** Every repo, by path (ForgeDO tree), one page. */
	listRepos(
		options: { cursor?: string; limit?: number },
	): Promise<{ repos: { id: string; path: string }[]; cursor?: string }>;
	/** WP3: the caller's bounded role at the target when it reaches `perm`; throws otherwise. */
	authorize(
		auth: AuthContext | null,
		target: AuthorizeTarget,
		perm: Permission,
	): Promise<EffectiveRole>;
	/**
	 * WP3's `createNodeAccess`: `authorize`'s role plus the member role (0
	 * when the scopes deny `read`). Below Reporter as a member, a `read` of a
	 * public repo is the public view: no lanes, no hidden refs.
	 */
	access(
		auth: AuthContext | null,
		target: AuthorizeTarget,
		perm: Permission,
	): Promise<McpAccess>;
	/** The role the principals hold at a node from grants (no credential bounds). */
	effectiveRole(
		principals: readonly string[],
		nodeId: string,
	): Promise<EffectiveRole>;
	principal(id: string): Promise<PrincipalRow | null>;
	principalByHandle(handle: string): Promise<PrincipalRow | null>;
	/** Protocol cards in force at a node, nearest installation first (WP7a). */
	protocolCards(nodeId: string): Promise<ProtocolCard[]>;
	/** The nearest enforce provider of an interface at a node (WP7a). */
	provider(iface: string, nodeId: string): Promise<InstallationInForce | null>;
	/** WP7b's tool listing, routing and the `context_get` assembler. */
	readonly dispatch: Pick<ExtDispatch, "tools" | "resolveTool" | "context">;
	/** `callTool` on one ExtensionDO (`ext:<inst>:<scope>`). */
	callTool(
		target: McpToolTarget,
		name: string,
		args: unknown,
		ctx: ToolContext,
		bounds: ActorBounds,
	): Promise<unknown>;
	repo(repoId: string): McpRepoPorts;
	/** SHA-only reads from the repo that holds `source` (canonical or the lane's repo; K15). */
	reader(source: GitSource): Promise<SourceReader>;
	readonly probe: Pick<RepoProbeApi, "projectGraph" | "affected">;
	/** WP23: the forge's schema files for a repo's package `tartan` (ForgeDO registry). */
	repoConfigSchema: RegistryFacade["repoConfigSchema"];
	/** WP23: where each installation in force at a repo comes from (ForgeDO registry). */
	repoConfigEffective: RegistryFacade["repoConfigEffective"];
	/** `TARTAN_REPO_CONFIG` is on: repo scopes get the repo-config card line. */
	repoConfigEnabled(): boolean;
	inbox(principal: string): McpInbox;
	now(): number;
	/** Diagnostics only (never secrets). */
	log(message: string, data?: Record<string, unknown>): void;
}
