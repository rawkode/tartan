// In-process transport for simulated agents (WP20): every call is a `Request`
// handed to the Worker's own router (`createRouter()(req, env, ctx)`), with the
// agent's own bearer token, so the security middleware, the MCP host, the
// gateway's ref policy and the kernel see exactly what a real agent's request
// looks like. Nothing goes over the network; the requests carry the forge's
// canonical origin so host rules apply as for any client.
//
// - MCP: Streamable HTTP JSON-RPC at `/-/mcp/<repo>` (initialize once per
//   agent, then `tools/call`); an `isError` result rejects with
//   `SimToolError`.
// - git: `@tartan/gitproto`'s receive-pack client against the lane handle's
//   remote, through the same router.

import { pushRefs } from "@tartan/gitproto";
import { type SimPort, SimToolError } from "./agent.ts";

export type Handle = (req: Request) => Promise<Response>;

export const MCP_PROTOCOL_VERSION = "2025-06-18";

const parseRpc = (text: string): Record<string, unknown> | null => {
	const trimmed = text.trim();
	if (trimmed === "") return null;
	if (trimmed.startsWith("{")) return JSON.parse(trimmed);
	// An SSE answer: the last `data:` line carries the response.
	const data = trimmed.split("\n").filter((l) => l.startsWith("data:")).at(-1);
	return data ? JSON.parse(data.slice(5)) : null;
};

const record = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null
		? value as Record<string, unknown>
		: {};

/** The text of an MCP tool error (first text content, else the JSON-RPC error). */
const errorText = (msg: Record<string, unknown> | null): string => {
	const result = record(msg?.["result"]);
	const content = Array.isArray(result["content"]) ? result["content"] : [];
	const text = content.map(record).find((c) => c["type"] === "text")?.["text"];
	if (typeof text === "string") return text.slice(0, 500);
	const error = record(msg?.["error"]);
	return typeof error["message"] === "string"
		? error["message"].slice(0, 500)
		: "no result";
};

export type InProcessPortDeps = {
	readonly handle: Handle;
	/** The forge's canonical origin (`https://code.example.com`). */
	readonly origin: string;
	/** The agent's bearer token (memory only, never logged or persisted). */
	readonly token: string;
	/** The MCP scope (the shard repo's path). */
	readonly repo: string;
};

export const createInProcessPort = (deps: InProcessPortDeps): SimPort => {
	let session: string | null = null;
	let ready: Promise<void> | null = null;
	let id = 0;
	const mcpUrl = `${deps.origin}/-/mcp/${deps.repo}`;

	const post = async (
		body: Record<string, unknown>,
	): Promise<Record<string, unknown> | null> => {
		const headers: Record<string, string> = {
			authorization: `Bearer ${deps.token}`,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"mcp-protocol-version": MCP_PROTOCOL_VERSION,
		};
		if (session) headers["mcp-session-id"] = session;
		const res = await deps.handle(
			new Request(mcpUrl, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			}),
		);
		session = res.headers.get("mcp-session-id") ?? session;
		const text = await res.text();
		if (res.status >= 400) {
			throw new SimToolError(
				String(record(body["params"])["name"] ?? body["method"]),
				`HTTP ${res.status} ${text.slice(0, 200)}`,
			);
		}
		return parseRpc(text);
	};

	const initialize = (): Promise<void> => {
		ready ??= (async () => {
			await post({
				jsonrpc: "2.0",
				id: ++id,
				method: "initialize",
				params: {
					protocolVersion: MCP_PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: "tartan-swarm-sim", version: "1" },
				},
			});
			await post({ jsonrpc: "2.0", method: "notifications/initialized" });
		})().catch((error) => {
			ready = null;
			throw error;
		});
		return ready;
	};

	return {
		tool: async (name, args) => {
			await initialize();
			const msg = await post({
				jsonrpc: "2.0",
				id: ++id,
				method: "tools/call",
				params: { name, arguments: args },
			});
			const result = record(msg?.["result"]);
			if (msg === null || msg["error"] !== undefined || result["isError"]) {
				throw new SimToolError(name, errorText(msg));
			}
			if (
				typeof result["structuredContent"] === "object" &&
				result["structuredContent"] !== null
			) {
				return result["structuredContent"] as Record<string, unknown>;
			}
			const content = Array.isArray(result["content"]) ? result["content"] : [];
			const text = content.map(record).find((c) => c["type"] === "text")
				?.["text"];
			if (typeof text !== "string") return {};
			try {
				return record(JSON.parse(text));
			} catch {
				return { text };
			}
		},
		push: (remote, commands, pack) =>
			pushRefs(
				{
					url: remote,
					authorization: `Bearer ${deps.token}`,
					fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
						deps.handle(new Request(input, init))) as typeof fetch,
				},
				commands,
				{ pack },
			),
	};
};

/**
 * An `ExecutionContext` whose `waitUntil` promises a caller awaits (a
 * cohort step lets phase 2 of push recording finish before it returns; the
 * RepoDO `diff` timer is the backstop).
 */
export const createCollectingContext = (): {
	readonly ctx: ExecutionContext;
	readonly settle: () => Promise<number>;
} => {
	const pending: Promise<unknown>[] = [];
	const ctx = {
		waitUntil: (promise: Promise<unknown>) => {
			pending.push(promise);
		},
		passThroughOnException: () => {},
		props: {},
	} as unknown as ExecutionContext;
	return {
		ctx,
		settle: async () => {
			let settled = 0;
			while (pending.length > 0) {
				const batch = pending.splice(0, pending.length);
				await Promise.allSettled(batch);
				settled += batch.length;
			}
			return settled;
		},
	};
};
