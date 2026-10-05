// WP12 live acceptance: the Swarm pack installed on a
// stage, then the Kanban moving by itself during a real agent run.
//
//   deno task live -- --stage dev wp12 --origin https://<stage host> \
//     --node acme --repo acme/router [--install] [--watch-ms 900000]
//
// Credentials come from the environment and are never printed:
//   TARTAN_TOKEN        a Maintainer's (Owner's, for the pack's Weave member)
//                       PAT with the `api` and `admin` scopes
//   TARTAN_AGENT_TOKEN  an agent token (`tagt_`) with the `mcp` and `lanes`
//                       scopes at the repo
//
// Checks:
//   1. (--install) the Swarm pack installs at --node (or is already in force);
//   2. tartan.work, tartan.changes and tartan.board are in force at the repo;
//   3. the agent creates an intent over MCP (`work_create`) and the repo
//      board shows its card in Backlog;
//   4. the agent claims it with a footprint (`work_claim`): the result
//      carries the lane handle with its git commands, and the card moves to
//      In progress by itself;
//   5. watch: while a real agent (Claude Code or Codex, given the printed
//      lane commands) pushes and submits, and review and the Weave land the
//      change, every column the card enters is logged, until Done or
//      --watch-ms. The run passes only when the card reached Done through
//      In review.
// Exit code 0 only when every check passes.

const arg = (name: string): string | undefined => {
	const i = Deno.args.indexOf(`--${name}`);
	return i >= 0 ? Deno.args[i + 1] : undefined;
};
const flag = (name: string): boolean => Deno.args.includes(`--${name}`);

const fail = (message: string): never => {
	console.error(`wp12: FAIL ${message}`);
	Deno.exit(1);
};

const origin = (arg("origin") ?? fail("--origin is required")).replace(
	/\/+$/,
	"",
);
const node = arg("node") ?? fail("--node is required");
const repo = arg("repo") ?? fail("--repo is required");
const watchMs = Number(arg("watch-ms") ?? "900000");
const token = Deno.env.get("TARTAN_TOKEN") ?? fail("TARTAN_TOKEN unset");
const agentToken = Deno.env.get("TARTAN_AGENT_TOKEN") ??
	fail("TARTAN_AGENT_TOKEN unset");

const api = async (
	path: string,
	init: RequestInit = {},
): Promise<{ status: number; body: unknown }> => {
	const res = await fetch(`${origin}${path}`, {
		...init,
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			origin,
			...(init.headers ?? {}),
		},
	});
	const text = await res.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {
		// keep text
	}
	return { status: res.status, body };
};

// --- MCP (Streamable HTTP, JSON-RPC 2.0) as the agent ----------------------

let rpcId = 0;
let session: string | null = null;

const parseRpc = (text: string): Record<string, unknown> => {
	const trimmed = text.trim();
	if (trimmed.startsWith("{")) return JSON.parse(trimmed);
	// An SSE answer: the last `data:` line carries the response.
	const data = trimmed.split("\n").filter((l) => l.startsWith("data:")).at(-1);
	if (!data) throw new Error("empty MCP response");
	return JSON.parse(data.slice(5));
};

const mcp = async (
	method: string,
	params: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
	const res = await fetch(`${origin}/-/mcp/${repo}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${agentToken}`,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...(session ? { "mcp-session-id": session } : {}),
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
	});
	session = res.headers.get("mcp-session-id") ?? session;
	if (!res.ok) fail(`MCP ${method} → ${res.status}`);
	const msg = parseRpc(await res.text());
	if (msg.error) fail(`MCP ${method}: ${JSON.stringify(msg.error)}`);
	return msg.result as Record<string, unknown>;
};

const tool = async (name: string, args: Record<string, unknown>) => {
	const result = await mcp("tools/call", { name, arguments: args });
	if (result.isError) {
		fail(`${name}: ${JSON.stringify(result.content).slice(0, 500)}`);
	}
	const structured = result.structuredContent as
		| Record<string, unknown>
		| undefined;
	if (structured) return structured;
	const text = (result.content as { type: string; text?: string }[] | undefined)
		?.find((c) => c.type === "text")?.text;
	return text ? JSON.parse(text) as Record<string, unknown> : {};
};

// --- 1. install ---------------------------------------------------------------

type Installation = { id: string; extId: string; nodePath: string };

if (flag("install")) {
	const res = await api("/-/api/installations", {
		method: "POST",
		body: JSON.stringify({
			extId: "tartan.pack.swarm",
			version: "0.1.0",
			node,
			mode: "enforce",
		}),
	});
	if (res.status === 409) {
		console.log("wp12: ok Swarm pack already in force");
	} else if (res.status >= 200 && res.status < 300) {
		console.log(`wp12: ok Swarm pack installed at ${node}`);
	} else {
		fail(`install → ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
	}
}

// --- 2. in force ----------------------------------------------------------------

const inForce = await api(
	`/-/api/installations?node=${encodeURIComponent(repo)}`,
);
if (inForce.status !== 200) fail(`installations → ${inForce.status}`);
const installations = ((inForce.body as { installations?: unknown[] })
	.installations ?? []).map((i) =>
		((i as { installation?: Installation }).installation ?? i) as Installation
	);
const byExt = (ext: string) => installations.find((i) => i.extId === ext);
for (const ext of ["tartan.work", "tartan.changes", "tartan.board"]) {
	if (!byExt(ext)) fail(`${ext} is not in force at ${repo}`);
}
console.log("wp12: ok work, changes and board in force");
const boardInst = byExt("tartan.board")!;

const columnOf = async (ref: string): Promise<string> => {
	const ctx = btoa(JSON.stringify({ repo })).replace(/\+/g, "-").replace(
		/\//g,
		"_",
	).replace(/=+$/, "");
	const res = await api(`/-/api/slot/${boardInst.id}/repo-board?ctx=${ctx}`);
	if (res.status !== 200) fail(`board render → ${res.status}`);
	const find = (n: unknown): string | null => {
		if (typeof n !== "object" || n === null) return null;
		const node = n as Record<string, unknown>;
		if (node.t === "board") {
			const card = (node.cards as { id: string; col: string }[])
				.find((c) => c.id === ref);
			return card?.col ?? "none";
		}
		for (const child of (node.children as unknown[] | undefined) ?? []) {
			const found = find(child);
			if (found !== null) return found;
		}
		return null;
	};
	return find((res.body as { root?: unknown }).root) ?? "none";
};

const waitFor = async (ref: string, col: string, ms: number) => {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		if (await columnOf(ref) === col) return true;
		await new Promise((r) => setTimeout(r, 1000));
	}
	return false;
};

// --- 3. create ------------------------------------------------------------------

await mcp("initialize", {
	protocolVersion: "2025-06-18",
	capabilities: {},
	clientInfo: { name: "wp12-flow", version: "0.1.0" },
});
const stamp = new Date().toISOString().slice(0, 19);
const item = await tool("work_create", {
	repo,
	kind: "intent",
	title: `wp12 live ${stamp}: add a request id header`,
	why: "Live acceptance run for the board (WP12)",
	acceptance: ["every API response carries x-request-id"],
	footprint: { projects: [], prefixes: ["services/api/src/middleware"] },
});
const ref = String(item.ref ?? fail("work_create returned no ref"));
if (!(await waitFor(ref, "backlog", 15_000))) fail(`${ref} not in Backlog`);
console.log(`wp12: ok ${ref} created; card in Backlog`);

// --- 4. claim -------------------------------------------------------------------

const claim = await tool("work_claim", {
	ref,
	footprint: { projects: [], prefixes: ["services/api/src/middleware"] },
	plan: "middleware that sets x-request-id",
});
const lane = claim.lane as {
	id: string;
	state: string;
	git?: { start: string; push: string };
};
if (!lane?.id) fail("work_claim returned no lane");
if (lane.state === "open" && !lane.git) {
	fail("an open lane without git commands");
}
if (!(await waitFor(ref, "progress", 15_000))) fail(`${ref} not In progress`);
console.log(
	`wp12: ok claimed; lane ${lane.id} (${lane.state}); card In progress`,
);
console.log(
	`wp12: lane start: ${lane.git?.start ?? "(opening: poll lanes_get)"}`,
);
console.log(`wp12: lane push:  ${lane.git?.push ?? "(opening)"}`);

// --- 5. watch -------------------------------------------------------------------

console.log(
	`wp12: watching the card for up to ${Math.round(watchMs / 1000)} s`,
);
const seen = ["backlog", "progress"];
const until = Date.now() + watchMs;
while (Date.now() < until) {
	const col = await columnOf(ref);
	if (col !== seen.at(-1)) {
		seen.push(col);
		console.log(`wp12: ${new Date().toISOString()} card → ${col}`);
	}
	if (col === "done") break;
	await new Promise((r) => setTimeout(r, 2000));
}
if (seen.at(-1) !== "done") {
	fail(`the card stopped at ${seen.at(-1)} (${seen.join(" → ")})`);
}
if (!seen.includes("review")) {
	fail(`Done without In review (${seen.join(" → ")})`);
}
console.log(`wp12: ok the card moved by itself: ${seen.join(" → ")}`);
