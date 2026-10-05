// MCP transports (WP11). Both serve the same
// `McpHost` and construct everything per request (stateless; all state is in
// DOs):
//
// - `sdk` (default): `createMcpHandler` from `agents/mcp/server` with an
//   `McpServer` from `@modelcontextprotocol/server@2`. It serves the
//   2026-07-28 revision and, through the SDK's stateless legacy path, the
//   2025-era `initialize` / `tools/list` / `tools/call` exchanges that
//   Claude Code and Codex CLI send. Host and Origin are validated by the
//   handler as well (`allowedHostnames`: the canonical host).
// - `raw` (the U24 fallback): a plain JSON-RPC 2.0 handler for
//   `initialize`, `ping`, `tools/list` and `tools/call` with JSON responses,
//   since no tool needs a session.

import {
	McpServer,
	ProtocolError,
	ProtocolErrorCode,
} from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { PRODUCT_NAME } from "@tartan/contract";
import { MCP_TRANSPORT, TARTAN_VERSION } from "../../constants.ts";
import { type McpHost, UnknownToolError } from "./host.ts";
import type { McpSession } from "./session.ts";

/** U24: chosen by the `MCP_TRANSPORT` switch in `src/constants.ts`. */
export type McpTransport = typeof MCP_TRANSPORT;

/** The server name every scope reports (`initialize.serverInfo.name`). */
export const SERVER_NAME = PRODUCT_NAME.toLowerCase();

const SERVER_INFO = { name: SERVER_NAME, version: TARTAN_VERSION } as const;

const toProtocolError = (error: unknown): unknown =>
	error instanceof UnknownToolError
		? new ProtocolError(ProtocolErrorCode.InvalidParams, error.message)
		: error;

/** One `McpServer` for one request, bound to the session. */
const buildServer = (host: McpHost, session: McpSession): McpServer => {
	const mcp = new McpServer(SERVER_INFO, {
		instructions: host.instructions(session),
	});
	mcp.server.registerCapabilities({ tools: { listChanged: false } });
	mcp.server.setRequestHandler("tools/list", async () => ({
		tools: (await host.listTools(session)).map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.inputSchema as { type: "object" },
		})),
	}));
	mcp.server.setRequestHandler("tools/call", async (request) => {
		try {
			const result = await host.callTool(
				session,
				request.params.name,
				request.params.arguments ?? {},
			);
			return { ...result };
		} catch (error) {
			throw toProtocolError(error);
		}
	});
	return mcp;
};

/** Serves one request through the SDK (`createMcpHandler`, per-request server). */
export const serveSdk = async (
	req: Request,
	host: McpHost,
	session: McpSession,
): Promise<Response> => {
	const canonicalHost = new URL(session.origin).hostname;
	const url = new URL(req.url);
	const handler = createMcpHandler(() => buildServer(host, session), {
		route: url.pathname,
		allowedHostnames: [canonicalHost],
		allowedOriginHostnames: [canonicalHost],
	});
	// The handler validates `Host`; a request built in-process (the swarm's
	// `app.fetch`, tests) may lack it, and the URL host is what the router
	// and WP2's canonical-host rule already checked.
	if (!req.headers.has("host")) {
		const headers = new Headers(req.headers);
		headers.set("host", url.host);
		req = new Request(req, { headers });
	}
	return await handler.fetch(req);
};

// ---------------------------------------------------------------------------
// Raw JSON-RPC 2.0 (U24 fallback)
// ---------------------------------------------------------------------------

/** 2025-era revisions the raw handler answers (newest first). */
export const RAW_PROTOCOL_VERSIONS = [
	"2025-11-25",
	"2025-06-18",
	"2025-03-26",
	"2024-11-05",
] as const;

type JsonRpcId = string | number | null;
type JsonRpcMessage = {
	readonly jsonrpc?: unknown;
	readonly id?: unknown;
	readonly method?: unknown;
	readonly params?: unknown;
};

const rpcError = (id: JsonRpcId, code: number, message: string) => ({
	jsonrpc: "2.0" as const,
	id,
	error: { code, message },
});

const rpcResult = (id: JsonRpcId, result: unknown) => ({
	jsonrpc: "2.0" as const,
	id,
	result,
});

const json = (body: unknown, status = 200): Response =>
	Response.json(body, {
		status,
		headers: { "cache-control": "no-store" },
	});

const isId = (value: unknown): value is string | number =>
	typeof value === "string" ||
	(typeof value === "number" && Number.isFinite(value));

const negotiate = (requested: unknown): string =>
	typeof requested === "string" &&
		(RAW_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
		? requested
		: RAW_PROTOCOL_VERSIONS[0];

const dispatchRaw = async (
	host: McpHost,
	session: McpSession,
	message: JsonRpcMessage,
): Promise<unknown | null> => {
	const id = isId(message.id) ? message.id : null;
	const isNotification = !("id" in message);
	if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
		return isNotification ? null : rpcError(id, -32600, "Invalid Request");
	}
	if (isNotification) return null;
	const params = (typeof message.params === "object" &&
			message.params !== null
		? message.params
		: {}) as Record<string, unknown>;
	switch (message.method) {
		case "initialize":
			return rpcResult(id, {
				protocolVersion: negotiate(params.protocolVersion),
				capabilities: { tools: { listChanged: false } },
				serverInfo: SERVER_INFO,
				instructions: host.instructions(session),
			});
		case "ping":
			return rpcResult(id, {});
		case "tools/list":
			return rpcResult(id, { tools: await host.listTools(session) });
		case "tools/call": {
			if (typeof params.name !== "string") {
				return rpcError(id, -32602, "tools/call needs a tool name");
			}
			try {
				return rpcResult(
					id,
					await host.callTool(session, params.name, params.arguments ?? {}),
				);
			} catch (error) {
				if (error instanceof UnknownToolError) {
					return rpcError(id, -32602, error.message);
				}
				throw error;
			}
		}
		default:
			return rpcError(id, -32601, `Method not found: ${message.method}`);
	}
};

/** Serves one request as plain JSON-RPC 2.0 (POST only, JSON in and out). */
export const serveRaw = async (
	req: Request,
	host: McpHost,
	session: McpSession,
): Promise<Response> => {
	if (req.method !== "POST") {
		return new Response(
			JSON.stringify(rpcError(null, -32000, "Method not allowed.")),
			{
				status: 405,
				headers: {
					allow: "POST",
					"content-type": "application/json",
					"cache-control": "no-store",
				},
			},
		);
	}
	if (
		!/^application\/json\s*(?:;|$)/i.test(req.headers.get("content-type") ?? "")
	) {
		return json(rpcError(null, -32000, "Content-Type must be JSON"), 415);
	}
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return json(rpcError(null, -32700, "Parse error"), 400);
	}
	const messages = Array.isArray(body) ? body : [body];
	if (messages.length === 0) {
		return json(rpcError(null, -32600, "Invalid Request"), 400);
	}
	const answers: unknown[] = [];
	for (const message of messages) {
		if (typeof message !== "object" || message === null) {
			answers.push(rpcError(null, -32600, "Invalid Request"));
			continue;
		}
		// One failing message answers -32603; the rest of a batch still runs.
		const answer = await dispatchRaw(
			host,
			session,
			message as JsonRpcMessage,
		).catch((error: unknown) => {
			console.error("[tartan] mcp raw: request failed", error);
			const id = (message as JsonRpcMessage).id;
			return "id" in message
				? rpcError(isId(id) ? id : null, -32603, "Internal error")
				: null;
		});
		if (answer !== null) answers.push(answer);
	}
	if (answers.length === 0) {
		return new Response(null, {
			status: 202,
			headers: { "cache-control": "no-store" },
		});
	}
	return json(Array.isArray(body) ? answers : answers[0]);
};
