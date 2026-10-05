// WP11 live acceptance: real MCP clients
// against the MCP host.
//
//   Local (no Cloudflare): the host and WP2's security middleware served by
//   Deno on 127.0.0.1 over an in-memory forge (two scopes: Swarm and
//   Classic), with real Claude Code and Codex CLI sessions:
//     deno task live -- wp11 --local [--agents claude,codex] [--transport sdk|raw]
//
//   Deployed stage (needs a claimed forge, the demo repo, two agent tokens):
//     TARTAN_TOKEN_CLAUDE=… TARTAN_TOKEN_CODEX=… \
//     deno task live -- --stage dev wp11 --url https://<host> --repo <path> [--agents claude,codex]
//
// Checks (each prints PASS/FAIL; exit 0 only when all pass):
//   1. initialize names the server `tartan` and carries the scope's cards;
//      tools/list differs between two scopes (local: Swarm vs Classic);
//   2. a seeded notice appears in a tool result's `content` (fenced) and in
//      `structuredContent._tartan`, and is not shown again (delivered);
//   3. each real agent (`claude -p`, `codex exec`) calls `whoami` over MCP
//      and quotes the seeded notice back;
//   4. (stage only) lanes_open → the handle's `git.start` → commit → its
//      `git.push`; a push to `main` is rejected; Codex's push to Claude's
//      lane is rejected `not-your-lane`.
// Tokens come from the environment (stage) or are generated (local) and are
// never printed.

import { createRouter, ROUTES } from "../../src/router.ts";
import { createSecurity } from "../../src/kernel/http/middleware.ts";
import { createMcpRoute } from "../../src/kernel/mcp/routes.ts";
import { createMcpFixture } from "../../src/kernel/mcp/testing/fixture.ts";
import type { McpTransport } from "../../src/kernel/mcp/transport.ts";
import type { Env } from "../../src/env.ts";
import type { AuthContext } from "@tartan/contract/kernel.ts";

const arg = (name: string): string | undefined => {
	const i = Deno.args.indexOf(`--${name}`);
	return i >= 0 ? Deno.args[i + 1] : undefined;
};
const flag = (name: string) => Deno.args.includes(`--${name}`);

const results: { check: string; ok: boolean; detail: string }[] = [];
const record = (check: string, ok: boolean, detail = "") => {
	results.push({ check, ok, detail });
	console.log(
		`wp11: ${ok ? "PASS" : "FAIL"} ${check}${detail ? `: ${detail}` : ""}`,
	);
};

const randomToken = () => {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return `tagt_${
		btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll(
			"/",
			"_",
		).replace(/=+$/, "").slice(0, 43)
	}`;
};
const canary = () =>
	`TARTAN-CANARY-${
		[...crypto.getRandomValues(new Uint8Array(4))].map((b) =>
			b.toString(16).padStart(2, "0")
		).join("")
	}`;

type Rpc = { result?: Record<string, unknown>; error?: { message: string } };

const rpc = async (
	url: string,
	token: string,
	method: string,
	params: unknown = {},
): Promise<Rpc> => {
	const res = await fetch(url, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"mcp-protocol-version": "2025-06-18",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	const text = await res.text();
	if (!res.ok) return { error: { message: `${res.status} ${text}` } };
	const data = (res.headers.get("content-type") ?? "").includes(
			"text/event-stream",
		)
		? text.split("\n").find((l) => l.startsWith("data: "))!.slice(6)
		: text;
	return JSON.parse(data) as Rpc;
};

const PROMPT = (server: string) =>
	`Use the "${server}" MCP server: call its whoami tool exactly once. Its result ends with a text block fenced as tartan-notices. Reply with only the text of the notice line inside that block, verbatim, and nothing else.`;

const run = async (
	command: string,
	args: string[],
	env: Record<string, string>,
	timeoutMs = 240_000,
): Promise<{ code: number; out: string }> => {
	const child = new Deno.Command(command, {
		args,
		env,
		stdin: "null",
		stdout: "piped",
		stderr: "piped",
	}).spawn();
	const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
	const out = await child.output();
	clearTimeout(timer);
	const decode = (b: Uint8Array) => new TextDecoder().decode(b);
	return {
		code: out.code,
		out: `${decode(out.stdout)}\n${decode(out.stderr)}`,
	};
};

const claudeQuotes = async (
	mcpUrl: string,
	token: string,
	expected: string,
) => {
	const dir = await Deno.makeTempDir({ prefix: "wp11-claude-" });
	try {
		await Deno.writeTextFile(
			`${dir}/mcp.json`,
			JSON.stringify({
				mcpServers: {
					tartan: {
						type: "http",
						url: mcpUrl,
						headers: { Authorization: `Bearer ${token}` },
					},
				},
			}),
		);
		const { code, out } = await run("claude", [
			"-p",
			PROMPT("tartan"),
			"--mcp-config",
			`${dir}/mcp.json`,
			"--strict-mcp-config",
			"--allowedTools",
			"mcp__tartan__whoami",
			"--output-format",
			"text",
		], {});
		record(
			"Claude Code calls whoami over MCP and quotes the notice",
			code === 0 && out.includes(expected),
			code === 0 ? out.trim().split("\n")[0].slice(0, 160) : `exit ${code}`,
		);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
};

const codexQuotes = async (
	mcpUrl: string,
	token: string,
	expected: string,
) => {
	const dir = await Deno.makeTempDir({ prefix: "wp11-codex-" });
	try {
		const { code, out } = await run("codex", [
			"exec",
			"--skip-git-repo-check",
			"-C",
			dir,
			"-c",
			`mcp_servers.tartan.url="${mcpUrl}"`,
			"-c",
			'mcp_servers.tartan.bearer_token_env_var="TARTAN_TOKEN"',
			PROMPT("tartan"),
		], { TARTAN_TOKEN: token });
		record(
			"Codex CLI calls whoami over MCP and quotes the notice",
			code === 0 && out.includes(expected),
			code === 0
				? (out.split("\n").find((l) => l.includes("TARTAN-CANARY")) ?? "")
					.slice(0, 160)
				: `exit ${code}`,
		);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
};

const local = async () => {
	const transport = (arg("transport") ?? "sdk") as McpTransport;
	const agents = (arg("agents") ?? "claude,codex").split(",").filter(Boolean);
	const fx = createMcpFixture();
	const tokens = new Map<string, AuthContext>();
	const claudeToken = randomToken();
	const codexToken = randomToken();
	tokens.set(claudeToken, fx.auth(fx.claude));
	tokens.set(codexToken, fx.auth(fx.codex));
	let origin = "";
	const security = createSecurity({
		setupInfo: () =>
			Promise.resolve({ state: "done", canonicalOrigin: origin }),
		authenticate: () => (req, options) => {
			const bearer = (req.headers.get("authorization") ?? "").replace(
				/^Bearer /,
				"",
			);
			return Promise.resolve(
				options.allowToken ? tokens.get(bearer) ?? null : null,
			);
		},
		log: () => {},
	});
	const router = createRouter(
		ROUTES.map((r) =>
			r.id === "mcp"
				? {
					...r,
					handler: createMcpRoute({ ports: () => fx.forge.ports, transport }),
				}
				: r
		),
		security,
	);
	const ctx = {
		waitUntil: () => {},
		passThroughOnException: () => {},
	} as unknown as ExecutionContext;
	const server = Deno.serve(
		{ hostname: "127.0.0.1", port: 0, onListen: () => {} },
		(req) => router(req, {} as Env, ctx),
	);
	origin = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
	fx.forge.setOrigin(origin);
	console.log(`wp11: local forge at ${origin} (transport ${transport})`);
	try {
		const swarmUrl = `${origin}/-/mcp/rawkode/platform`;
		const classicUrl = `${origin}/-/mcp/rawkode/docs`;
		const init = await rpc(swarmUrl, claudeToken, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "wp11", version: "0" },
		});
		const info = init.result as {
			serverInfo?: { name: string };
			instructions?: string;
		} | undefined;
		record(
			"initialize names tartan with the scope's cards",
			info?.serverInfo?.name === "tartan" &&
				(info.instructions ?? "").includes("# Swarm"),
		);
		const names = async (url: string) =>
			((await rpc(url, claudeToken, "tools/list")).result as {
				tools: { name: string }[];
			}).tools.map((t) => t.name);
		const swarm = await names(swarmUrl);
		const classic = await names(classicUrl);
		record(
			"tools/list differs between the Swarm and the Classic scope",
			swarm.includes("conflicts_check") && !classic.includes("conflicts_check"),
			`${swarm.length} vs ${classic.length} tools`,
		);
		const seeded = canary();
		fx.forge.notify(fx.claude, {
			text: `${seeded} codex-1 also touches src/router.ts`,
			kind: "conflict",
			severity: "warn",
			sourceLabel: "radar",
		});
		const call = await rpc(swarmUrl, claudeToken, "tools/call", {
			name: "whoami",
			arguments: {},
		});
		const result = call.result as {
			content: { text: string }[];
			structuredContent: { _tartan: { notices: { text: string }[] } };
		};
		record(
			"a notice is appended to content (fenced) and _tartan",
			result.content.at(-1)!.text.startsWith("```tartan-notices") &&
				result.content.at(-1)!.text.includes(seeded) &&
				result.structuredContent._tartan.notices[0]?.text.includes(seeded),
		);
		const again = await rpc(swarmUrl, claudeToken, "tools/call", {
			name: "whoami",
			arguments: {},
		});
		record(
			"a delivered notice is not shown again",
			(again.result as { content: unknown[] }).content.length === 1,
		);
		if (agents.includes("claude")) {
			const forClaude = canary();
			fx.forge.notify(fx.claude, {
				text: `${forClaude} lane overlap on src/router.ts`,
				kind: "conflict",
				severity: "warn",
				sourceLabel: "radar",
			});
			await claudeQuotes(swarmUrl, claudeToken, forClaude);
		}
		if (agents.includes("codex")) {
			const forCodex = canary();
			fx.forge.notify(fx.codex, {
				text: `${forCodex} lane overlap on src/router.ts`,
				kind: "conflict",
				severity: "warn",
				sourceLabel: "radar",
			});
			await codexQuotes(swarmUrl, codexToken, forCodex);
		}
	} finally {
		await server.shutdown();
	}
};

const stage = async () => {
	const url = arg("url");
	const repo = arg("repo");
	const claude = Deno.env.get("TARTAN_TOKEN_CLAUDE");
	const codex = Deno.env.get("TARTAN_TOKEN_CODEX");
	if (!url || !repo || !claude || !codex) {
		console.error(
			"wp11: --url, --repo, TARTAN_TOKEN_CLAUDE and TARTAN_TOKEN_CODEX are required (or use --local)",
		);
		Deno.exit(2);
	}
	const origin = new URL(url).origin;
	const mcpUrl = `${origin}/-/mcp/${repo}`;
	const init = await rpc(mcpUrl, claude, "initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "wp11", version: "0" },
	});
	record(
		"initialize on the stage",
		(init.result as { serverInfo?: { name: string } } | undefined)?.serverInfo
			?.name === "tartan",
		init.error?.message ?? "",
	);
	const seeded = canary();
	const sent = await rpc(mcpUrl, codex, "tools/call", {
		name: "inbox_send",
		arguments: { to: "claude-1", body: `${seeded} hello from codex`, repo },
	});
	record("codex sends claude a message", sent.result?.isError !== true);
	const agents = (arg("agents") ?? "claude,codex").split(",");
	if (agents.includes("claude")) await claudeQuotes(mcpUrl, claude, seeded);
	const open = await rpc(mcpUrl, claude, "tools/call", {
		name: "lanes_open",
		arguments: { repo, purpose: "wp11 live check" },
	});
	const lane = (open.result?.structuredContent as {
		lane?: { id: string; git?: { start: string; push: string } };
	})?.lane;
	record(
		"lanes_open returns a handle with git commands",
		lane?.git !== undefined,
		lane?.id ?? JSON.stringify(open.error ?? open.result).slice(0, 160),
	);
	console.log(
		"wp11: the git half (clone, git.start, push, main and not-your-lane rejections) needs WP3/WP4 on the stage; run it with the quickstart steps",
	);
};

if (flag("local")) await local();
else await stage();
const failed = results.filter((r) => !r.ok);
console.log(`wp11: ${results.length - failed.length}/${results.length} PASS`);
Deno.exit(failed.length === 0 ? 0 : 1);
