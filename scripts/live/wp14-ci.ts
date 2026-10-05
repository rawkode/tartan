// WP14 live acceptance: after a change is submitted on a
// deployed stage, only the affected project's jobs ran (some from the result
// cache) and the review route is visible.
//
//   deno task live -- --stage dev wp14 --origin https://code.example.com \
//     --repo acme/platform/edge/router --change <changeId> --project api \
//     [--expect-cached]
//
// Credentials come from the environment and are never printed:
//   TARTAN_TOKEN   an agent token or PAT with MCP access to the repo
//
// Checks, through the MCP endpoint `/-/mcp/<repo>` (tools of the `checks@1`
// and `review@1` providers in force):
//   1. `checks_get` lists checks for the change, every project-scoped context
//      (`<job>:<project>`) names --project, and none is pending or running;
//   2. with --expect-cached, at least one context is `cached`;
//   3. `review_get` answers a route (`auto` or `human`) for the latest head.
// Exit code 0 only when every check passes.

const arg = (name: string): string | undefined => {
	const i = Deno.args.indexOf(`--${name}`);
	return i >= 0 ? Deno.args[i + 1] : undefined;
};

const fail = (message: string): never => {
	console.error(`wp14: FAIL ${message}`);
	Deno.exit(1);
};

const origin = (arg("origin") ?? fail("--origin is required")).replace(
	/\/+$/,
	"",
);
const repo = arg("repo") ?? fail("--repo is required");
const changeId = arg("change") ?? fail("--change is required");
const project = arg("project") ?? fail("--project is required");
const expectCached = Deno.args.includes("--expect-cached");
const token = Deno.env.get("TARTAN_TOKEN") ?? fail("TARTAN_TOKEN unset");

const endpoint = `${origin}/-/mcp/${repo}`;
let session: string | null = null;
let nextId = 1;

const rpc = async (method: string, params: unknown): Promise<unknown> => {
	const res = await fetch(endpoint, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...(session ? { "mcp-session-id": session } : {}),
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
	});
	if (!res.ok) fail(`${method} → HTTP ${res.status}`);
	session = res.headers.get("mcp-session-id") ?? session;
	const text = await res.text();
	// Streamable HTTP may answer as one SSE `data:` frame.
	const body = text.startsWith("{")
		? text
		: text.split("\n").find((l) => l.startsWith("data:"))?.slice(5) ?? "";
	const msg = JSON.parse(body) as {
		result?: unknown;
		error?: { message?: string };
	};
	if (msg.error) fail(`${method}: ${msg.error.message ?? "error"}`);
	return msg.result;
};

const tool = async (name: string, args: unknown): Promise<unknown> => {
	const result = await rpc("tools/call", { name, arguments: args }) as {
		structuredContent?: unknown;
		content?: { type: string; text?: string }[];
		isError?: boolean;
	};
	if (result.isError) {
		fail(`${name}: ${result.content?.[0]?.text ?? "tool error"}`);
	}
	if (result.structuredContent !== undefined) return result.structuredContent;
	const text = result.content?.find((c) => c.type === "text")?.text;
	return text ? JSON.parse(text) : fail(`${name}: no result`);
};

await rpc("initialize", {
	protocolVersion: "2025-06-18",
	capabilities: {},
	clientInfo: { name: "wp14-live", version: "1" },
});

const { checks } = await tool("checks_get", { repo, changeId }) as {
	checks: { context: string; state: string; cached: boolean }[];
};
if (checks.length === 0) fail(`no checks for ${changeId}`);
for (const c of checks) {
	console.log(
		`wp14: check ${c.context} ${c.state}${c.cached ? " (cached)" : ""}`,
	);
}
const scoped = checks.filter((c) => c.context.includes(":"));
const others = scoped.filter((c) =>
	c.context.split(":").slice(1).join(":") !== project
);
if (others.length > 0) {
	fail(
		`jobs ran for other projects: ${others.map((c) => c.context).join(", ")}`,
	);
}
if (checks.some((c) => c.state === "pending" || c.state === "running")) {
	fail("checks are still running; re-run when the run has finished");
}
console.log(`wp14: ok only ${project} jobs (${scoped.length})`);
if (expectCached) {
	if (!checks.some((c) => c.state === "cached")) fail("no cached check");
	console.log("wp14: ok at least one check came from the result cache");
}

const review = await tool("review_get", { repo, changeId }) as {
	route?: string;
	risk?: number;
	decision?: string;
	head?: string;
};
if (review.route !== "auto" && review.route !== "human") {
	fail(`no review route (${JSON.stringify(review.route)})`);
}
console.log(
	`wp14: ok review route ${review.route} (risk ${review.risk ?? "?"}${
		review.decision ? `, ${review.decision}` : ""
	}) at ${review.head?.slice(0, 7) ?? "?"}`,
);
