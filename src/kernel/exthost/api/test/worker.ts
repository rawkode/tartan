/// <reference types="@cloudflare/vitest-pool-workers/types" />
// Workerd helpers for end-to-end slot tests (`*.workers.test.ts` only: this
// module imports `cloudflare:test`). Requests go through the real Worker entry
// (`src/index.ts` fetch: router, security middleware, ForgeDO, RepoDO,
// ExtensionDO, InboxDO); only the IdP (a mock) and Artifacts (FakeArtifacts
// behind the service binding) are fakes. A patched global `fetch` routes the
// IdP's origin to the mock and the Worker's outbound git traffic to the fake
// repos' smart-HTTP remotes (`*.artifacts.fake.test`, the pool's test-only
// `FAKES_HTTP` binding), as the deployed Worker reaches Artifacts over HTTPS.

import {
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { CRON_TASKS } from "../../../../cron.ts";
import worker from "../../../../index.ts";
import { testEnv as env } from "../../../../../test/env.ts";
import {
	createMockIdp,
	type MockIdp,
} from "../../../identity/testing/mock-idp.ts";

export const ORIGIN = "https://code.example.com";

export type CallInit = RequestInit & {
	readonly cookie?: string;
	readonly bearer?: string;
};

/** One request through the Worker entry; background work finishes before it returns. */
export const call = async (
	path: string,
	init: CallInit = {},
): Promise<Response> => {
	const headers = new Headers(init.headers);
	if (init.cookie) headers.set("cookie", init.cookie);
	if (init.bearer) headers.set("authorization", `Bearer ${init.bearer}`);
	const method = (init.method ?? "GET").toUpperCase();
	if (method !== "GET" && method !== "HEAD") {
		if (!headers.has("content-type")) {
			headers.set("content-type", "application/json");
		}
		// The SPA's same-origin JSON (WP2's CSRF rule); tokens need neither.
		if (!init.bearer && !headers.has("sec-fetch-site")) {
			headers.set("sec-fetch-site", "same-origin");
		}
		if (!headers.has("origin")) headers.set("origin", ORIGIN);
	}
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		new Request(path.startsWith("http") ? path : `${ORIGIN}${path}`, {
			method,
			headers,
			body: init.body,
			redirect: "manual",
		}),
		env,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return res;
};

/**
 * The 5-minute cron's event task: re-pokes every subscriber with its stream's
 * head, the product's recovery for a poke lost under load.
 */
export const repoke = async (): Promise<void> => {
	const ctx = createExecutionContext();
	await CRON_TASKS["events"]!(env, ctx, Date.now());
	await waitOnExecutionContext(ctx);
};

export const jsonOf = async <T = unknown>(res: Response): Promise<T> => {
	const text = await res.text();
	try {
		return JSON.parse(text) as T;
	} catch {
		return text as T;
	}
};

const cookieValue = (res: Response, name: string): string | null => {
	for (const line of res.headers.getSetCookie()) {
		const [pair = ""] = line.split(";");
		const eq = pair.indexOf("=");
		if (pair.slice(0, eq) === name) return pair.slice(eq + 1);
	}
	return null;
};

export type Patched = {
	readonly idp: MockIdp;
	readonly logs: string[];
	readonly restore: () => void;
};

/**
 * Routes the mock IdP's origin to the mock and records console lines (the claim
 * code is logged). `restore()` undoes both.
 */
export const patchGlobals = async (): Promise<Patched> => {
	const idp = await createMockIdp({ issParameter: true });
	const logs: string[] = [];
	const realFetch = globalThis.fetch;
	const fakes = (env as unknown as { FAKES_HTTP: Fetcher }).FAKES_HTTP;
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url.startsWith(idp.issuer)) return idp.fetch(input as string, init);
		if (new URL(url).host.endsWith(".artifacts.fake.test")) {
			return fakes.fetch(new Request(input, init));
		}
		return realFetch(input, init);
	}) as typeof fetch;
	const levels = ["log", "warn", "error", "info"] as const;
	const originals = levels.map((level) => console[level]);
	for (const level of levels) {
		const original = console[level].bind(console);
		console[level] = (...args: unknown[]) => {
			logs.push(
				args.map((a) => typeof a === "string" ? a : String(a)).join(" "),
			);
			original(...args);
		};
	}
	return {
		idp,
		logs,
		restore: () => {
			globalThis.fetch = realFetch;
			levels.forEach((level, i) => (console[level] = originals[i]!));
		},
	};
};

const expectStatus = async (
	what: string,
	res: Response,
	status: number,
): Promise<void> => {
	if (res.status !== status) {
		throw new Error(`${what}: ${res.status} ${await res.text()}`);
	}
};

export const OWNER = {
	sub: "owner-sub",
	preferred_username: "rawkode",
	name: "Owner",
	email: "owner@example.com",
	email_verified: true,
};

/**
 * A fresh forge claimed by the owner: the logged claim code, the forge name,
 * the IdP by dynamic registration, and the owner's sign-in. Returns the
 * session cookie.
 */
export const claimForge = async (patched: Patched): Promise<string> => {
	const { idp, logs } = patched;
	await expectStatus(
		"setup/code",
		await call("/-/setup/code", { method: "POST", body: "{}" }),
		200,
	);
	const marker = "[tartan] setup code: ";
	const line = [...logs].reverse().find((l) => l.includes(marker));
	if (!line) throw new Error("no setup code was logged");
	const token = line.slice(line.indexOf(marker) + marker.length).split(" ")[0];
	const unlock = await call("/-/setup/unlock", {
		method: "POST",
		body: JSON.stringify({ token }),
	});
	await expectStatus("setup/unlock", unlock.clone(), 200);
	const setup = `__Host-tartan-setup=${
		cookieValue(unlock, "__Host-tartan-setup")
	}`;
	await expectStatus(
		"setup/name",
		await call("/-/setup/name", {
			method: "POST",
			cookie: setup,
			body: JSON.stringify({
				forgeName: "Conformance",
				canonicalOrigin: ORIGIN,
			}),
		}),
		200,
	);
	await expectStatus(
		"setup/idp/register",
		await call("/-/setup/idp/register", {
			method: "POST",
			cookie: setup,
			body: JSON.stringify({ issuer: idp.issuer }),
		}),
		200,
	);
	const login = await call("/-/auth/login?return_to=/", { cookie: setup });
	await expectStatus("auth/login", login.clone(), 302);
	const loginCookie = login.headers.getSetCookie()[0]!.split(";")[0];
	const callback = idp.authorize(login.headers.get("location")!, OWNER);
	const done = await call(callback.href, {
		cookie: `${loginCookie}; ${setup}`,
	});
	await expectStatus("auth/callback", done.clone(), 303);
	return `__Host-tartan-session=${cookieValue(done, "__Host-tartan-session")}`;
};

// --- MCP (Streamable HTTP, JSON-RPC 2.0) ------------------------------------

const parseRpc = (text: string): Record<string, unknown> | null => {
	const trimmed = text.trim();
	if (trimmed === "") return null;
	if (trimmed.startsWith("{")) return JSON.parse(trimmed);
	const data = trimmed.split("\n").filter((l) => l.startsWith("data:")).at(-1);
	return data ? JSON.parse(data.slice(5)) : null;
};

export type McpTool = (
	name: string,
	args: Record<string, unknown>,
) => Promise<{ readonly isError: boolean; readonly value: unknown }>;

/** An MCP session at `/-/mcp/<scope>` as a bearer-token client; returns a tool caller. */
export const mcp = async (scope: string, bearer: string): Promise<McpTool> => {
	let session: string | null = null;
	let id = 0;
	const post = async (body: Record<string, unknown>) => {
		const res = await call(`/-/mcp/${scope}`, {
			method: "POST",
			bearer,
			headers: {
				accept: "application/json, text/event-stream",
				"mcp-protocol-version": "2025-06-18",
				...(session ? { "mcp-session-id": session } : {}),
			},
			body: JSON.stringify(body),
		});
		session = res.headers.get("mcp-session-id") ?? session;
		return parseRpc(await res.text());
	};
	await post({
		jsonrpc: "2.0",
		id: ++id,
		method: "initialize",
		params: {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "slot-conformance", version: "0" },
		},
	});
	await post({ jsonrpc: "2.0", method: "notifications/initialized" });
	return async (name, args) => {
		const msg = await post({
			jsonrpc: "2.0",
			id: ++id,
			method: "tools/call",
			params: { name, arguments: args },
		});
		const result = msg?.["result"] as
			| {
				isError?: boolean;
				structuredContent?: unknown;
				content?: { type: string; text?: string }[];
			}
			| undefined;
		const text = result?.content?.find((c) => c.type === "text")?.text;
		let value: unknown = result?.structuredContent;
		if (value === undefined && text !== undefined) {
			try {
				value = JSON.parse(text);
			} catch {
				value = text;
			}
		}
		return {
			isError: result === undefined || result.isError === true,
			value: value ?? msg?.["error"],
		};
	};
};

export { env };
