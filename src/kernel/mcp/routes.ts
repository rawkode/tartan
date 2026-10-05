// MCP host, OAuth and discovery handlers (WP11).
//
// `/-/mcp[/<path>]`: WP2's middleware has already enforced the route policy
// (`POLICY.mcp`): canonical host only (403 elsewhere), setup done, a token
// with the `mcp` scope (Bearer `tagt_`/`tpat_`; cookies are never read, so a
// cookie-only request is 401). This handler adds the Origin rule (a request
// that carries `Origin` must name the canonical origin exactly), opens the
// session at the scope and serves it through the configured transport.

import {
	denied,
	httpStatus,
	MAX_OBJECT_BYTES,
	type NodeDto,
	notFound,
	PRODUCT_NAME,
	type PushLimits,
	toWire,
	unauthenticated,
} from "@tartan/contract";
import type { RouteContext, RouteHandler } from "../../router.ts";
import {
	maxPushBytes,
	MCP_TRANSPORT,
	TARTAN_VERSION,
} from "../../constants.ts";
import { notImplementedRoute } from "../stub.ts";
import { agentsMarkdown } from "./agentsmd.ts";
import { createMcpHost } from "./host.ts";
import type { McpPorts } from "./ports.ts";
import { mcpUrlOf } from "./protocol.ts";
import { findNode, refused } from "./session.ts";
import { type McpTransport, serveRaw, serveSdk } from "./transport.ts";
import { createMcpPorts } from "./wiring.ts";

const NO_STORE = { "cache-control": "no-store" } as const;

const jsonError = (error: unknown): Response => {
	const wire = toWire(error);
	if (wire.error === "internal") {
		console.error("[tartan] mcp route failed", error);
	}
	return Response.json(wire, {
		status: httpStatus(wire.error),
		headers: {
			...NO_STORE,
			...(wire.error === "unauthenticated"
				? { "www-authenticate": 'Bearer realm="Tartan"' }
				: {}),
		},
	});
};

/**
 * The Origin rule: a request with an `Origin` header must come from the
 * canonical origin exactly (DNS rebinding and cross-site requests from
 * browsers). Non-browser MCP clients send none.
 */
export const checkOrigin = (req: Request, canonicalOrigin: string): void => {
	const origin = req.headers.get("origin");
	if (origin === null) return;
	if (origin !== canonicalOrigin.replace(/\/+$/, "")) {
		throw denied("csrf", "Origin must be the forge's canonical origin");
	}
};

export type McpRouteDeps = {
	readonly ports: (c: RouteContext) => McpPorts;
	readonly transport: McpTransport;
};

const contextHost = (c: RouteContext): { readonly exports: unknown } =>
	c.ctx as unknown as { readonly exports: unknown };

const DEFAULT_DEPS: McpRouteDeps = {
	ports: (c) => createMcpPorts(c.env, contextHost(c)),
	transport: MCP_TRANSPORT,
};

const canonicalOf = async (ports: McpPorts, url: URL): Promise<string> =>
	(await ports.canonicalOrigin()) ?? url.origin;

/** `/-/mcp[/<path>]`: Streamable HTTP MCP endpoint (Bearer only, no cookies). */
export const createMcpRoute = (
	deps: McpRouteDeps = DEFAULT_DEPS,
): RouteHandler =>
async (c) => {
	try {
		if (c.auth === null) throw unauthenticated();
		const ports = deps.ports(c);
		checkOrigin(c.req, await canonicalOf(ports, c.url));
		const host = createMcpHost(ports);
		const session = await host.open(c.auth, c.params.rest);
		return deps.transport === "raw"
			? await serveRaw(c.req, host, session)
			: await serveSdk(c.req, host, session);
	} catch (error) {
		return jsonError(error);
	}
};

export const handleMcp: RouteHandler = createMcpRoute();

/** `/-/oauth/*`: authorization server and delegation consent (M2). */
export const handleOAuth: RouteHandler = notImplementedRoute;

export type DiscoveryDeps = {
	readonly ports: (c: RouteContext) => McpPorts;
};

const DEFAULT_DISCOVERY: DiscoveryDeps = { ports: DEFAULT_DEPS.ports };

/**
 * `/.well-known/*`: forge discovery (`tartan.json`: product, version, MCP
 * and agents.md URLs). OAuth metadata is M2 (the OAuth AS behind the `oauth`
 * feature); until then a client learns from its 404 that the forge takes
 * bearer tokens only.
 */
export const createWellKnownRoute = (
	deps: DiscoveryDeps = DEFAULT_DISCOVERY,
): RouteHandler =>
async (c) => {
	try {
		if (c.req.method !== "GET" && c.req.method !== "HEAD") {
			throw notFound("no such discovery document");
		}
		if (c.params.rest !== "tartan.json") {
			throw notFound("no such discovery document");
		}
		const origin = await canonicalOf(deps.ports(c), c.url);
		const limits: PushLimits = {
			maxPushBytes: maxPushBytes(c.env.TARTAN_MAX_PUSH_MB),
			maxObjectBytes: MAX_OBJECT_BYTES,
		};
		return Response.json({
			product: PRODUCT_NAME,
			version: TARTAN_VERSION,
			origin,
			mcp: mcpUrlOf(origin, ""),
			agentsMd: `${origin}/-/agents.md`,
			limits,
		}, { headers: NO_STORE });
	} catch (error) {
		return jsonError(error);
	}
};

export const handleWellKnown: RouteHandler = createWellKnownRoute();

/**
 * `GET /-/agents.md[?path=<node>]`: the protocol in force at a scope, as
 * markdown. A node the caller cannot see is 404 (no existence oracle).
 */
export const createAgentsMdRoute = (
	deps: DiscoveryDeps = DEFAULT_DISCOVERY,
): RouteHandler =>
async (c) => {
	try {
		const ports = deps.ports(c);
		const origin = await canonicalOf(ports, c.url);
		const wanted = c.url.searchParams.get("path") ??
			c.url.searchParams.get("scope") ?? "";
		let node: NodeDto | null = null;
		if (wanted !== "") {
			node = await findNode(ports, wanted, origin);
			if (node === null) throw notFound(`no node at ${wanted}`);
			try {
				await ports.authorize(c.auth, { node }, "read-metadata");
			} catch (error) {
				if (!refused(error)) throw error;
				throw notFound(`no node at ${wanted}`);
			}
		}
		const cards = node === null ? [] : await ports.protocolCards(node.id);
		return new Response(agentsMarkdown(origin, node?.path ?? "", cards), {
			headers: {
				...NO_STORE,
				"content-type": "text/markdown; charset=utf-8",
			},
		});
	} catch (error) {
		return jsonError(error);
	}
};

export const handleAgentsMd: RouteHandler = createAgentsMdRoute();
