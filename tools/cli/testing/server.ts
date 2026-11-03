// Test-only: a local stand-in for a Tartan forge that stock git and `tt` talk
// to (the CLI tests). It serves one bare repository at every git path over
// smart HTTP (stock `git upload-pack --stateless-rpc`) behind Basic auth (401
// first, as the gateway does), records every request, and answers a scripted
// MCP `tools/call`.

export type Recorded = {
	readonly method: string;
	readonly path: string;
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
	readonly toolCalls: { name: string; args: unknown; scope: string }[];
	setTools(script: ToolScript): void;
	close(): Promise<void>;
};

const encoder = new TextEncoder();

const pkt = (line: string): string =>
	`${(encoder.encode(line).length + 4).toString(16).padStart(4, "0")}${line}`;

const uploadPack = async (
	bare: string,
	input?: ReadableStream<Uint8Array>,
): Promise<Uint8Array<ArrayBuffer>> => {
	const child = new Deno.Command("git", {
		args: [
			"upload-pack",
			"--stateless-rpc",
			...(input === undefined ? ["--advertise-refs"] : []),
			bare,
		],
		stdin: input === undefined ? "null" : "piped",
		stdout: "piped",
		stderr: "null",
	}).spawn();
	if (input !== undefined) await input.pipeTo(child.stdin);
	return new Uint8Array((await child.output()).stdout);
};

export const startFakeForge = (
	options: {
		readonly token: string;
		/** The bare repository served at every git path (none: git gets 404). */
		readonly bare?: string;
		readonly username?: string;
	},
): FakeForgeServer => {
	const requests: Recorded[] = [];
	const toolCalls: { name: string; args: unknown; scope: string }[] = [];
	let tools: ToolScript = () => ({});
	const expected = `Basic ${
		btoa(`${options.username ?? "agent"}:${options.token}`)
	}`;

	const handler = async (req: Request): Promise<Response> => {
		const url = new URL(req.url);
		const authorization = req.headers.get("authorization");
		requests.push({ method: req.method, path: url.pathname, authorization });
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
		const bare = options.bare;
		if (
			bare !== undefined && url.pathname.endsWith("/info/refs") &&
			url.searchParams.get("service") === "git-upload-pack"
		) {
			const refs = await uploadPack(bare);
			const head = encoder.encode(`${pkt("# service=git-upload-pack\n")}0000`);
			const body = new Uint8Array(head.length + refs.length);
			body.set(head);
			body.set(refs, head.length);
			return new Response(body, {
				headers: {
					"content-type": "application/x-git-upload-pack-advertisement",
					"cache-control": "no-cache",
				},
			});
		}
		if (
			bare !== undefined && url.pathname.endsWith("/git-upload-pack") &&
			req.body !== null
		) {
			const input = req.headers.get("content-encoding") === "gzip"
				? req.body.pipeThrough(new DecompressionStream("gzip"))
				: req.body;
			return new Response(await uploadPack(bare, input), {
				headers: { "content-type": "application/x-git-upload-pack-result" },
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
		toolCalls,
		setTools: (script) => {
			tools = script;
		},
		close: () => server.shutdown(),
	};
};
