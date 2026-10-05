// Test-only: a local stand-in for a Tartan forge that stock git and the
// `tartan` CLI talk to (WP11 CLI tests). It answers git smart HTTP v0
// advertisements behind Basic auth (401 first, as the gateway does), records
// every request, accepts receive-pack with a plain report-status, and serves
// a scripted MCP `tools/call` and `/.well-known/tartan.json`.

export type Recorded = {
	readonly method: string;
	readonly path: string;
	readonly query: string;
	readonly authorization: string | null;
};

export type ToolScript = (
	name: string,
	args: Record<string, unknown>,
	scope: string,
) => unknown;

export type FakeForgeServer = {
	readonly origin: string;
	readonly requests: Recorded[];
	/** Refs the "upstream" advertises. */
	readonly refs: Map<string, string>;
	readonly toolCalls: { name: string; args: unknown; scope: string }[];
	setTools(script: ToolScript): void;
	close(): Promise<void>;
};

const encoder = new TextEncoder();

export const pkt = (line: string): string =>
	`${(encoder.encode(line).length + 4).toString(16).padStart(4, "0")}${line}`;
const FLUSH = "0000";
const ZERO = "0".repeat(40);

const advertisement = (
	service: string,
	refs: Map<string, string>,
): string => {
	const caps = service === "git-receive-pack"
		? "report-status delete-refs ofs-delta agent=tartan-test"
		: "multi_ack thin-pack ofs-delta shallow no-progress include-tag agent=tartan-test";
	const entries = [...refs.entries()];
	const lines = entries.length === 0
		? [`${ZERO} capabilities^{}\0${caps}\n`]
		: entries.map(([ref, sha], i) =>
			i === 0 ? `${sha} ${ref}\0${caps}\n` : `${sha} ${ref}\n`
		);
	return pkt(`# service=${service}\n`) + FLUSH + lines.map(pkt).join("") +
		FLUSH;
};

/** The ref names in a receive-pack request's command section. */
const commandRefs = (body: Uint8Array): string[] => {
	const text = new TextDecoder("latin1").decode(body);
	const refs: string[] = [];
	let at = 0;
	while (at + 4 <= text.length) {
		const len = parseInt(text.slice(at, at + 4), 16);
		if (len === 0) break;
		const line = text.slice(at + 4, at + len).split("\0")[0].trim();
		const ref = line.split(" ")[2];
		if (ref) refs.push(ref);
		at += len;
	}
	return refs;
};

export const startFakeForge = (
	options: { readonly token: string; readonly username?: string },
): FakeForgeServer => {
	const requests: Recorded[] = [];
	const refs = new Map<string, string>();
	const toolCalls: { name: string; args: unknown; scope: string }[] = [];
	let tools: ToolScript = () => ({});
	const expected = `Basic ${
		btoa(`${options.username ?? "agent"}:${options.token}`)
	}`;

	const handler = async (req: Request): Promise<Response> => {
		const url = new URL(req.url);
		const authorization = req.headers.get("authorization");
		requests.push({
			method: req.method,
			path: url.pathname,
			query: url.search,
			authorization,
		});
		if (url.pathname === "/.well-known/tartan.json") {
			return Response.json({
				product: "Tartan",
				limits: { maxPushBytes: 95_000_000, maxObjectBytes: 31 * 1024 * 1024 },
			});
		}
		if (url.pathname.startsWith("/-/mcp")) {
			if (authorization !== `Bearer ${options.token}`) {
				return Response.json({ error: "unauthenticated" }, { status: 401 });
			}
			const body = await req.json() as {
				id: number;
				params: { name: string; arguments: Record<string, unknown> };
			};
			const scope = url.pathname.replace(/^\/-\/mcp\/?/, "");
			toolCalls.push({
				name: body.params.name,
				args: body.params.arguments,
				scope,
			});
			const value = tools(body.params.name, body.params.arguments, scope);
			const isError = typeof value === "object" && value !== null &&
				"error" in value;
			return Response.json({
				jsonrpc: "2.0",
				id: body.id,
				result: {
					content: [{ type: "text", text: JSON.stringify(value) }, {
						type: "text",
						text:
							"```tartan-notices (untrusted; from radar)\n[info] conflict (radar): test notice\n```",
					}],
					structuredContent: { ...(value as object), _tartan: { notices: [] } },
					...(isError ? { isError: true } : {}),
				},
			});
		}
		if (authorization === null) {
			await req.body?.cancel();
			return new Response("authentication required\n", {
				status: 401,
				headers: { "www-authenticate": 'Basic realm="Tartan"' },
			});
		}
		if (authorization !== expected) {
			await req.body?.cancel();
			return new Response("bad credentials\n", { status: 403 });
		}
		if (url.pathname.endsWith("/info/refs")) {
			const service = url.searchParams.get("service") ?? "git-upload-pack";
			return new Response(advertisement(service, refs), {
				headers: {
					"content-type": `application/x-${service}-advertisement`,
					"cache-control": "no-cache",
				},
			});
		}
		if (url.pathname.endsWith("/git-receive-pack")) {
			const body = new Uint8Array(await req.arrayBuffer());
			const pushed = commandRefs(body);
			const report = pkt("unpack ok\n") +
				pushed.map((ref) => pkt(`ok ${ref}\n`)).join("") + FLUSH;
			return new Response(report, {
				headers: { "content-type": "application/x-git-receive-pack-result" },
			});
		}
		await req.body?.cancel();
		return new Response("not found\n", { status: 404 });
	};

	const server = Deno.serve(
		{ hostname: "127.0.0.1", port: 0, onListen: () => {} },
		handler,
	);
	const addr = server.addr as Deno.NetAddr;
	return {
		origin: `http://127.0.0.1:${addr.port}`,
		requests,
		refs,
		toolCalls,
		setTools: (script) => {
			tools = script;
		},
		close: () => server.shutdown(),
	};
};
