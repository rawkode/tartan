// A minimal MCP client for the `tartan` CLI (WP11): one stateless JSON-RPC
// `tools/call` POST per command to `/-/mcp[/<scope>]` with the token as a
// Bearer (agent tokens carry `mcp`, not `api`), answered as JSON or as a
// one-event SSE stream. The notices block of the result is printed to
// stderr, so whoever runs the command sees it too.

const TRAILER = "_tartan";
const NOTICES_FENCE = "```tartan-notices";

export type ToolAnswer = {
	/** `structuredContent` without the `_tartan` trailer. */
	readonly value: Record<string, unknown>;
	readonly isError: boolean;
	/** The fenced notices block, when the forge appended one. */
	readonly notices: string | null;
	/** The first text block (the value as JSON, or markdown). */
	readonly text: string;
};

export class McpCallError extends Error {
	override readonly name = "McpCallError";
	constructor(message: string, readonly status?: number) {
		super(message);
	}
}

export type McpClient = {
	call(scope: string, tool: string, args?: unknown): Promise<ToolAnswer>;
};

export type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

let nextId = 1;

/** The JSON-RPC message of a JSON or SSE body (the one with `id`). */
export const parseRpcBody = (
	contentType: string,
	text: string,
	id: number,
): Record<string, unknown> => {
	if (contentType.includes("text/event-stream")) {
		for (const event of text.split(/\r?\n\r?\n/)) {
			const data = event.split(/\r?\n/).filter((l) => l.startsWith("data:"))
				.map((l) => l.slice(5).trimStart()).join("\n");
			if (data === "") continue;
			const message = JSON.parse(data) as Record<string, unknown>;
			if (message.id === id) return message;
		}
		throw new McpCallError("no answer in the event stream");
	}
	return JSON.parse(text) as Record<string, unknown>;
};

export const createMcpClient = (
	origin: string,
	token: string,
	fetcher: FetchLike = fetch,
): McpClient => ({
	call: async (scope, tool, args = {}) => {
		const id = nextId++;
		const url = `${origin}/-/mcp${scope === "" ? "" : `/${scope}`}`;
		const res = await fetcher(url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"mcp-protocol-version": "2025-06-18",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id,
				method: "tools/call",
				params: { name: tool, arguments: args },
			}),
		});
		const text = await res.text();
		if (!res.ok) {
			let message = `${res.status} ${res.statusText}`;
			try {
				const body = JSON.parse(text) as { message?: string; error?: string };
				message = `${body.error ?? res.status}: ${body.message ?? text}`;
			} catch {
				// not JSON
			}
			throw new McpCallError(message, res.status);
		}
		const message = parseRpcBody(
			res.headers.get("content-type") ?? "",
			text,
			id,
		);
		if (message.error !== undefined) {
			const error = message.error as { message?: string };
			throw new McpCallError(error.message ?? "MCP error");
		}
		const result = message.result as {
			content?: { type: string; text?: string }[];
			structuredContent?: Record<string, unknown>;
			isError?: boolean;
		};
		const texts = (result.content ?? []).flatMap((c) =>
			c.type === "text" && typeof c.text === "string" ? [c.text] : []
		);
		const notices = texts.find((t) => t.startsWith(NOTICES_FENCE)) ?? null;
		const { [TRAILER]: _trailer, ...value } = result.structuredContent ?? {};
		return {
			value,
			isError: result.isError === true,
			notices,
			text: texts[0] ?? "",
		};
	},
});
