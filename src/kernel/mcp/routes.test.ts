// MCP routes and transports (WP11): the SDK transport
// (`createMcpHandler` + `McpServer`) and the raw JSON-RPC fallback answer the
// same host; auth errors, the Origin rule, `/-/agents.md` and
// `/.well-known/tartan.json`.

import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { TARTAN_TRAILER_KEY, type TartanTrailer } from "@tartan/contract";
import type { AuthContext } from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import { POLICY, type RouteContext } from "../../router.ts";
import {
	checkOrigin,
	createAgentsMdRoute,
	createMcpRoute,
	createWellKnownRoute,
} from "./routes.ts";
import { ORIGIN } from "./testing/fakes.ts";
import { CLASSIC_CARD, createMcpFixture } from "./testing/fixture.ts";
import { type McpTransport, RAW_PROTOCOL_VERSIONS } from "./transport.ts";

type Rpc = { jsonrpc: "2.0"; id?: number; method: string; params?: unknown };

const contextFor = (
	req: Request,
	auth: AuthContext | null,
	rest?: string,
): RouteContext => ({
	req,
	env: {} as Env,
	ctx: {} as ExecutionContext,
	url: new URL(req.url),
	params: rest === undefined ? {} : { rest },
	route: { id: "mcp", owner: "WP11", policy: POLICY.mcp },
	auth,
});

const post = (path: string, body: unknown, headers: HeadersInit = {}) =>
	new Request(`${ORIGIN}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...headers,
		},
		body: JSON.stringify(body),
	});

/** The JSON-RPC message of a JSON or single-event SSE response. */
const rpcBody = async (res: Response): Promise<Record<string, unknown>> => {
	const text = await res.text();
	if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
		const data = text.split("\n").find((l) => l.startsWith("data: "));
		return JSON.parse(data!.slice(6));
	}
	return JSON.parse(text);
};

const INIT: Rpc = {
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "test", version: "0" },
	},
};

const serve = (
	transport: McpTransport,
	fx = createMcpFixture(),
) => {
	const route = createMcpRoute({ ports: () => fx.forge.ports, transport });
	return {
		fx,
		call: (body: unknown, options: {
			auth?: AuthContext | null;
			rest?: string;
			headers?: HeadersInit;
		} = {}) => {
			const rest = options.rest ?? "rawkode/docs";
			const req = post(`/-/mcp/${rest}`, body, options.headers);
			return route(contextFor(
				req,
				options.auth === undefined ? fx.auth(fx.claude) : options.auth,
				rest,
			));
		},
	};
};

for (const transport of ["sdk", "raw"] as const) {
	Deno.test(`${transport}: initialize names the server tartan with the scope's instructions`, async () => {
		const { call } = serve(transport);
		const res = await call(INIT);
		equal(res.status, 200);
		const body = await rpcBody(res);
		const result = body.result as {
			serverInfo: { name: string };
			instructions: string;
			protocolVersion: string;
			capabilities: { tools: unknown };
		};
		equal(result.serverInfo.name, "tartan");
		ok(result.instructions.includes(CLASSIC_CARD));
		equal(result.protocolVersion, "2025-06-18");
		ok(result.capabilities.tools);
	});

	Deno.test(`${transport}: tools/list and tools/call work without a session (stateless)`, async () => {
		const { fx, call } = serve(transport);
		fx.forge.notify(fx.claude, {
			text: "hello from radar",
			sourceLabel: "radar",
		});
		const list = await rpcBody(
			await call({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
		);
		const tools = (list.result as { tools: { name: string }[] }).tools;
		ok(tools.some((t) => t.name === "work_claim"));
		const res = await call({
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: { name: "whoami", arguments: {} },
		});
		const result = (await rpcBody(res)).result as {
			content: { text: string }[];
			structuredContent: Record<string, unknown>;
		};
		ok(result.content.at(-1)!.text.includes("hello from radar"));
		const trailer = result
			.structuredContent[TARTAN_TRAILER_KEY] as TartanTrailer;
		equal(trailer.notices.length, 1);
	});

	Deno.test(`${transport}: an unknown tool is JSON-RPC -32602`, async () => {
		const { call } = serve(transport);
		const body = await rpcBody(
			await call({
				jsonrpc: "2.0",
				id: 4,
				method: "tools/call",
				params: { name: "no_such_tool", arguments: {} },
			}),
		);
		equal((body.error as { code: number }).code, -32602);
	});

	Deno.test(`${transport}: no caller is 401 with a Bearer challenge; a foreign Origin is 403`, async () => {
		const { call } = serve(transport);
		const anonymous = await call(INIT, { auth: null });
		equal(anonymous.status, 401);
		equal(anonymous.headers.get("www-authenticate"), 'Bearer realm="Tartan"');
		const foreign = await call(INIT, {
			headers: { origin: "https://evil.example" },
		});
		equal(foreign.status, 403);
		deepStrictEqual(await foreign.json(), {
			error: "denied",
			message: "Origin must be the forge's canonical origin",
			reason: "csrf",
		});
		const same = await call(INIT, { headers: { origin: ORIGIN } });
		equal(same.status, 200);
	});

	Deno.test(`${transport}: a scope outside the token's node is 404`, async () => {
		const fx = createMcpFixture();
		const { call } = serve(transport, fx);
		const res = await call(INIT, {
			auth: fx.auth(fx.claude, {
				nodeId: fx.forge.nodeAt("rawkode/platform").id,
			}),
		});
		equal(res.status, 404);
	});
}

Deno.test("sdk: GET (a 2025 SSE stream) is 405: the endpoint is stateless", async () => {
	const fx = createMcpFixture();
	const route = createMcpRoute({
		ports: () => fx.forge.ports,
		transport: "sdk",
	});
	const req = new Request(`${ORIGIN}/-/mcp/rawkode/docs`, {
		headers: { accept: "text/event-stream" },
	});
	const res = await route(contextFor(req, fx.auth(fx.claude), "rawkode/docs"));
	equal(res.status, 405);
});

Deno.test("raw: notifications get 202, batches answer in order, unknown methods -32601, bad bodies 400/415", async () => {
	const { call } = serve("raw");
	const note = await call({
		jsonrpc: "2.0",
		method: "notifications/initialized",
	});
	equal(note.status, 202);
	const batch = await call([
		{ jsonrpc: "2.0", id: 1, method: "ping" },
		{ jsonrpc: "2.0", method: "notifications/initialized" },
		{ jsonrpc: "2.0", id: 2, method: "resources/list" },
	]);
	const answers = await batch.json() as {
		id: number;
		error?: { code: number };
	}[];
	deepStrictEqual(answers.map((a) => a.id), [1, 2]);
	equal(answers[1].error?.code, -32601);
	const fx = createMcpFixture();
	const route = createMcpRoute({
		ports: () => fx.forge.ports,
		transport: "raw",
	});
	const text = new Request(`${ORIGIN}/-/mcp`, {
		method: "POST",
		headers: { "content-type": "text/plain" },
		body: "{}",
	});
	equal((await route(contextFor(text, fx.auth(fx.owner)))).status, 415);
	const broken = new Request(`${ORIGIN}/-/mcp`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{",
	});
	equal((await route(contextFor(broken, fx.auth(fx.owner)))).status, 400);
});

Deno.test("raw: initialize negotiates a supported 2025 revision, else the newest", async () => {
	const { call } = serve("raw");
	const old = await rpcBody(
		await call({
			...INIT,
			params: { protocolVersion: "2025-03-26" },
		}),
	);
	equal(
		(old.result as { protocolVersion: string }).protocolVersion,
		"2025-03-26",
	);
	const future = await rpcBody(
		await call({
			...INIT,
			params: { protocolVersion: "2099-01-01" },
		}),
	);
	equal(
		(future.result as { protocolVersion: string }).protocolVersion,
		RAW_PROTOCOL_VERSIONS[0],
	);
});

Deno.test("checkOrigin: absent passes, exact passes, anything else is denied csrf", () => {
	const req = (origin?: string) =>
		new Request(`${ORIGIN}/-/mcp`, {
			headers: origin ? { origin } : {},
		});
	checkOrigin(req(), ORIGIN);
	checkOrigin(req(ORIGIN), `${ORIGIN}/`);
	for (const bad of ["null", "http://code.example.test", `${ORIGIN}:8443`]) {
		let threw = false;
		try {
			checkOrigin(req(bad), ORIGIN);
		} catch (error) {
			threw = String(error).includes("denied(csrf)");
		}
		ok(threw, bad);
	}
});

// ---------------------------------------------------------------------------
// /-/agents.md and /.well-known/tartan.json
// ---------------------------------------------------------------------------

const getWith = (
	route: ReturnType<typeof createAgentsMdRoute>,
	url: string,
	auth: AuthContext | null,
) => {
	const req = new Request(url);
	return route({
		...contextFor(req, auth),
		route: { id: "agents-md", owner: "WP11", policy: POLICY.discovery },
	});
};

Deno.test("/-/agents.md serves the protocol in force at a scope as markdown, with connect snippets", async () => {
	const fx = createMcpFixture();
	const route = createAgentsMdRoute({ ports: () => fx.forge.ports });
	const res = await getWith(
		route,
		`${ORIGIN}/-/agents.md?path=rawkode/docs/site`,
		fx.auth(fx.claude),
	);
	equal(res.status, 200);
	equal(res.headers.get("content-type"), "text/markdown; charset=utf-8");
	const md = await res.text();
	ok(md.startsWith(`# Tartan (${ORIGIN})`));
	ok(md.includes(CLASSIC_CARD));
	ok(md.includes(
		`claude mcp add --transport http tartan ${ORIGIN}/-/mcp/rawkode/docs/site --header "Authorization: Bearer $TARTAN_TOKEN"`,
	));
	ok(md.includes('bearer_token_env_var = "TARTAN_TOKEN"'));
	const forge = await getWith(route, `${ORIGIN}/-/agents.md`, null);
	equal(forge.status, 200);
	ok((await forge.text()).includes(`${ORIGIN}/-/mcp`));
});

Deno.test("/-/agents.md: a node the caller cannot see is 404 like a missing one; public nodes serve anonymously", async () => {
	const fx = createMcpFixture();
	fx.forge.addNode("rawkode/open", "repo", { visibility: "public" });
	const route = createAgentsMdRoute({ ports: () => fx.forge.ports });
	const hidden = await getWith(
		route,
		`${ORIGIN}/-/agents.md?path=rawkode/docs`,
		null,
	);
	const missing = await getWith(
		route,
		`${ORIGIN}/-/agents.md?path=rawkode/nope`,
		null,
	);
	equal(hidden.status, 404);
	equal(missing.status, 404);
	equal(((await hidden.json()) as { error: string }).error, "not_found");
	await missing.body?.cancel();
	const open = await getWith(
		route,
		`${ORIGIN}/-/agents.md?path=rawkode/open`,
		null,
	);
	equal(open.status, 200);
	await open.body?.cancel();
});

Deno.test("/.well-known/tartan.json is forge discovery; OAuth metadata is 404 until M2", async () => {
	const fx = createMcpFixture();
	const route = createWellKnownRoute({ ports: () => fx.forge.ports });
	const at = (rest: string) => {
		const req = new Request(`${ORIGIN}/.well-known/${rest}`);
		return route({
			...contextFor(req, null, rest),
			route: { id: "well-known", owner: "WP11", policy: POLICY.discovery },
		});
	};
	const doc = await at("tartan.json");
	equal(doc.status, 200);
	const body = await doc.json() as { mcp: string; agentsMd: string };
	equal(body.mcp, `${ORIGIN}/-/mcp`);
	equal(body.agentsMd, `${ORIGIN}/-/agents.md`);
	const oauth = await at("oauth-protected-resource");
	equal(oauth.status, 404);
	match(((await oauth.json()) as { error: string }).error, /not_found/);
});

Deno.test("raw: a failing message answers -32603 and the rest of the batch still runs", async () => {
	const fx = createMcpFixture();
	fx.forge.override({
		dispatch: {
			...fx.forge.ports.dispatch,
			tools: () => Promise.reject(new Error("registry down")),
		},
	});
	const { call } = serve("raw", fx);
	const res = await call([
		{ jsonrpc: "2.0", id: 1, method: "ping" },
		{ jsonrpc: "2.0", id: 2, method: "tools/list" },
	]);
	equal(res.status, 200);
	const answers = await res.json() as {
		id: number;
		result?: unknown;
		error?: { code: number };
	}[];
	deepStrictEqual(answers[0], { jsonrpc: "2.0", id: 1, result: {} });
	equal(answers[1].error?.code, -32603);
});
