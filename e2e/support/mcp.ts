// A minimal MCP (Streamable HTTP, JSON-RPC 2.0) client for the developer
// agent token: `initialize`, then `tools/call`, each as its own stateless
// request with the Bearer token from Node. Replies may come as JSON or as an
// event stream (`data:` lines); both are read. Errors name the tool and the
// JSON-RPC or Tartan error code, never the token or a request header.

import { boundedFetch } from "./http.ts";

const PROTOCOL_VERSION = "2025-06-18";

export class McpError extends Error {
	override name = "McpError";
	constructor(
		readonly tool: string,
		readonly code: string,
		detail: string,
	) {
		super(`MCP ${tool}: ${code}${detail ? ` (${detail})` : ""}`);
	}
}

type RpcMessage = {
	readonly id?: unknown;
	readonly result?: unknown;
	readonly error?: { readonly code?: unknown; readonly message?: unknown };
};

/** The JSON-RPC message answering `id` in a JSON or event-stream body, or null. */
export const parseRpcReply = (
	text: string,
	contentType: string,
	id: number,
): RpcMessage | null => {
	const messages: unknown[] = [];
	if (contentType.includes("text/event-stream")) {
		for (const line of text.split(/\r?\n/)) {
			if (!line.startsWith("data:")) continue;
			try {
				messages.push(JSON.parse(line.slice(5).trim()));
			} catch {
				// Not a JSON data line.
			}
		}
	} else {
		try {
			const parsed = JSON.parse(text);
			messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
		} catch {
			return null;
		}
	}
	return (messages.find((m) =>
		typeof m === "object" && m !== null && (m as RpcMessage).id === id
	) as RpcMessage | undefined) ?? null;
};

const short = (value: unknown): string =>
	typeof value === "string" ? value.replace(/\s+/g, " ").slice(0, 160) : "";

/** A notice from a result's `_tartan` trailer, as the suites read it. */
export type NoticeView = {
	readonly kind: string;
	readonly severity: string;
	readonly text: string;
	readonly laneId?: string;
	readonly data?: Readonly<Record<string, unknown>>;
};

/** The notices of a tool result's `structuredContent._tartan` (none when absent). */
export const noticesOf = (structured: unknown): NoticeView[] => {
	const trailer = (structured as { _tartan?: { notices?: unknown } } | null)
		?._tartan;
	const list = trailer?.notices;
	if (!Array.isArray(list)) return [];
	return list.flatMap((n): NoticeView[] => {
		const v = n as Record<string, unknown>;
		if (typeof v.kind !== "string" || typeof v.text !== "string") return [];
		return [{
			kind: v.kind,
			severity: typeof v.severity === "string" ? v.severity : "",
			text: v.text,
			...(typeof v.laneId === "string" ? { laneId: v.laneId } : {}),
			...(v.data !== null && typeof v.data === "object"
				? { data: v.data as Record<string, unknown> }
				: {}),
		}];
	});
};

export type ToolResult<T> = {
	/** `structuredContent` (the `_tartan` trailer included). */
	readonly value: T;
	/** Every text part of `content` joined (the notices block included). */
	readonly text: string;
	readonly notices: readonly NoticeView[];
};

export type McpClient = {
	/** `structuredContent` of a successful call; `McpError` otherwise. */
	readonly call: <T = Record<string, unknown>>(
		tool: string,
		args: Readonly<Record<string, unknown>>,
	) => Promise<T>;
	/** The whole result of a successful call: value, text and notices. */
	readonly callFull: <T = Record<string, unknown>>(
		tool: string,
		args: Readonly<Record<string, unknown>>,
	) => Promise<ToolResult<T>>;
};

/** A client for `/-/mcp/<scope>` on the forge. */
export const mcpClient = (
	origin: string,
	scope: string,
	token: string,
): McpClient => {
	const url = `${origin}/-/mcp${scope === "" ? "" : `/${scope}`}`;
	let nextId = 1;
	let initialized = false;

	const rpc = async (
		label: string,
		method: string,
		params: unknown,
	): Promise<unknown> => {
		const id = nextId++;
		const { status, type, text } = await boundedFetch(
			url,
			{
				method: "POST",
				redirect: "manual",
				headers: {
					authorization: `Bearer ${token}`,
					accept: "application/json, text/event-stream",
					"content-type": "application/json",
					"mcp-protocol-version": PROTOCOL_VERSION,
				},
				body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
			},
			`MCP ${label}`,
			async (response) => ({
				status: response.status,
				type: response.headers.get("content-type") ?? "",
				text: await response.text(),
			}),
		);
		const reply = parseRpcReply(text, type, id);
		if (reply === null) {
			throw new McpError(label, `HTTP ${status}`, "no JSON-RPC reply");
		}
		if (reply.error !== undefined) {
			throw new McpError(
				label,
				`rpc ${String(reply.error.code ?? "?")}`,
				short(reply.error.message),
			);
		}
		return reply.result;
	};

	const callFull = async <T>(
		tool: string,
		args: Readonly<Record<string, unknown>>,
	): Promise<ToolResult<T>> => {
		if (!initialized) {
			await rpc("initialize", "initialize", {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "tartan-e2e", version: "1" },
			});
			initialized = true;
		}
		const result = await rpc(tool, "tools/call", {
			name: tool,
			arguments: args,
		}) as {
			readonly isError?: boolean;
			readonly structuredContent?: Record<string, unknown>;
			readonly content?: readonly { readonly text?: string }[];
		};
		if (result.isError === true) {
			const e = result.structuredContent as
				| { error?: unknown; reason?: unknown; message?: unknown }
				| undefined;
			throw new McpError(
				tool,
				String(e?.error ?? "tool error"),
				[short(e?.reason), short(e?.message)].filter((s) => s !== "")
					.join(": ") || short(result.content?.[0]?.text),
			);
		}
		const value = (result.structuredContent ?? {}) as T;
		return {
			value,
			text: (result.content ?? []).map((c) => c.text ?? "").join("\n"),
			notices: noticesOf(value),
		};
	};

	return {
		call: async <T>(tool: string, args: Readonly<Record<string, unknown>>) =>
			(await callFull<T>(tool, args)).value,
		callFull,
	};
};
