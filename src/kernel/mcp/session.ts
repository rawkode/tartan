// MCP sessions and scopes (WP11). A session is
// one request's view: the authenticated caller, the canonical origin, the
// scope (`/-/mcp` = the token's node, `/-/mcp/<path>` = that subtree, which
// must lie inside the token's node) and the protocol in force there. All
// state lives in DOs, so a session is rebuilt per request.
//
// Repo routing: a tool's repo comes from its `repo` argument (a path or
// a repo id), else from a work ref `<repo>#<n>`, else from the session's
// repo scope (an MCP URL at a repo, or a lane-pinned token), else the tool
// answers `invalid("repo required")`.

import {
	fromRpcError,
	invalid,
	isUlid,
	isWithinPath,
	type NodeDto,
	NodePathSchema,
	notFound,
	type Permission,
	ROLE,
	WORK_REF_RE,
} from "@tartan/contract";
import type { AuthContext } from "@tartan/contract/kernel.ts";
import type { McpPorts, ProtocolCard } from "./ports.ts";
import { protocolFingerprint } from "./protocol.ts";

/** `node: null` is the forge scope (a token without a node: kernel tools only). */
export type McpScope = {
	readonly node: NodeDto | null;
	/** The node path (`""` for the forge scope). */
	readonly path: string;
};

export type McpSession = {
	readonly auth: AuthContext;
	/** The canonical origin (lane remotes and MCP URLs are rewritten to it). */
	readonly origin: string;
	readonly scope: McpScope;
	readonly cards: readonly ProtocolCard[];
	/** sha8 of `cards` (`structuredContent._tartan.protocol`). */
	readonly protocol: string;
};

/** True when `node` is `root` or lies below it (by path). */
export const isWithin = (root: NodeDto, node: NodeDto): boolean =>
	isWithinPath(root.path, node.path);

/**
 * Normalizes a repo or node argument: a path (`acme/shop`, `/acme/shop.git`,
 * or a full URL on the canonical origin) or a bare id.
 */
export const normalizeNodeArg = (value: string, origin: string): string => {
	let v = value.trim();
	const base = origin.replace(/\/+$/, "");
	if (v.startsWith(`${base}/`)) v = v.slice(base.length);
	v = v.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
	return v;
};

export type SessionDeps = Pick<
	McpPorts,
	"resolvePath" | "node" | "authorize" | "protocolCards"
>;

/** A node by path or id; null when unknown (moved nodes resolve to their new path). */
export const findNode = async (
	ports: Pick<McpPorts, "resolvePath" | "node">,
	ref: string,
	origin: string,
): Promise<NodeDto | null> => {
	const value = normalizeNodeArg(ref, origin);
	if (isUlid(value)) return await ports.node(value);
	if (!NodePathSchema.safeParse(value).success) return null;
	const resolved = await ports.resolvePath(value);
	if (resolved === null || resolved.rest !== "") return null;
	return resolved.node;
};

/**
 * The session scope of `/-/mcp[/<rest>]` for `auth`. A path scope must exist,
 * lie inside the token's node and be visible to the caller; anything else is
 * `not_found` (no existence oracle).
 */
export const resolveScope = async (
	deps: SessionDeps,
	auth: AuthContext,
	rest: string | undefined,
	origin: string,
): Promise<McpScope> => {
	const tokenNode = auth.nodeId === null ? null : await deps.node(auth.nodeId);
	if (auth.nodeId !== null && tokenNode === null) {
		throw notFound("the token's node no longer exists");
	}
	if (rest === undefined || rest === "") {
		return tokenNode === null
			? { node: null, path: "" }
			: { node: tokenNode, path: tokenNode.path };
	}
	const node = await findNode(deps, rest, origin);
	if (node === null) throw notFound(`no MCP scope at ${rest}`);
	if (tokenNode !== null && !isWithin(tokenNode, node)) {
		throw notFound(`no MCP scope at ${rest}`);
	}
	try {
		await deps.authorize(auth, { node }, "read-metadata");
	} catch (error) {
		if (refused(error)) throw notFound(`no MCP scope at ${rest}`);
		throw error;
	}
	return { node, path: node.path };
};

export const openSession = async (
	deps: SessionDeps,
	auth: AuthContext,
	rest: string | undefined,
	origin: string,
): Promise<McpSession> => {
	const scope = await resolveScope(deps, auth, rest, origin);
	const cards = scope.node === null
		? []
		: await deps.protocolCards(scope.node.id);
	return {
		auth,
		origin,
		scope,
		cards,
		protocol: await protocolFingerprint(cards),
	};
};

/** The session's own repo, if any: a repo scope, or a lane-pinned token's repo. */
export const sessionRepo = async (
	deps: Pick<McpPorts, "node">,
	session: McpSession,
): Promise<NodeDto | null> => {
	if (session.scope.node?.kind === "repo") return session.scope.node;
	const { auth } = session;
	if (auth.laneId !== null && auth.nodeId !== null) {
		const node = await deps.node(auth.nodeId);
		if (node?.kind === "repo") return node;
	}
	return null;
};

/** The repo path inside a work ref `<repo>#<n>`, or null. */
export const repoOfWorkRef = (value: unknown): string | null =>
	typeof value === "string" && WORK_REF_RE.test(value)
		? value.slice(0, value.indexOf("#"))
		: null;

/** A repo a tool may read, and whether the caller reads it in the public view. */
export type RepoReadView = {
	readonly node: NodeDto;
	/**
	 * Below Reporter as a member: only visible refs and commits reachable
	 * from them; no lanes (lanes are never in the public view).
	 */
	readonly publicView: boolean;
};

export type RepoResolver = {
	/**
	 * The repo a tool names, authorized for `perm` (lane pins apply at
	 * `laneId`); `invalid("repo required")` when there is none.
	 */
	repo(
		session: McpSession,
		arg: unknown,
		perm: Permission,
		options?: { readonly laneId?: string },
	): Promise<NodeDto>;
	/** `repo`, with the member role's verdict on the public view. */
	view(
		session: McpSession,
		arg: unknown,
		perm: Permission,
		options?: { readonly laneId?: string },
	): Promise<RepoReadView>;
	/**
	 * A repo by its argument (one the caller can at least see), or the
	 * session's repo; null when neither names one.
	 */
	locate(session: McpSession, arg: unknown): Promise<NodeDto | null>;
};

/** An authorization refusal (as opposed to an outage). */
export const refused = (error: unknown): boolean => {
	const code = fromRpcError(error).code;
	return code === "denied" || code === "unauthenticated";
};

export const createRepoResolver = (
	ports: Pick<McpPorts, "resolvePath" | "node" | "authorize" | "access">,
): RepoResolver => {
	/**
	 * A node the caller cannot see answers exactly like a missing one, so a
	 * repo argument is never an existence oracle (as WP7a's slot contexts).
	 */
	const locate = async (
		session: McpSession,
		arg: unknown,
	): Promise<NodeDto | null> => {
		if (arg === undefined || arg === null || arg === "") {
			return await sessionRepo(ports, session);
		}
		if (typeof arg !== "string") throw invalid("repo: a repo path or id");
		const node = await findNode(ports, arg, session.origin);
		if (node === null) throw notFound(`no repo at ${arg}`);
		try {
			await ports.authorize(session.auth, { node }, "read-metadata");
		} catch (error) {
			if (refused(error)) throw notFound(`no repo at ${arg}`);
			throw error;
		}
		if (node.kind !== "repo") throw invalid(`${node.path} is not a repo`);
		return node;
	};
	const view = async (
		session: McpSession,
		arg: unknown,
		perm: Permission,
		options: { readonly laneId?: string } = {},
	): Promise<RepoReadView> => {
		const node = await locate(session, arg);
		if (node === null) {
			throw invalid(
				"repo required: pass `repo`, or use the MCP URL of a repo",
			);
		}
		const { member } = await ports.access(
			session.auth,
			{ node, ...(options.laneId ? { laneId: options.laneId } : {}) },
			perm,
		);
		return { node, publicView: member < ROLE.reporter };
	};
	return {
		locate,
		view,
		repo: async (session, arg, perm, options = {}) =>
			(await view(session, arg, perm, options)).node,
	};
};
