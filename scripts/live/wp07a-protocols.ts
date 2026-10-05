// WP7a/WP11/WP12 live acceptance for per-subtree protocols: the Classic pack on
// a subtree under the Swarm pack, scoped MCP endpoints with different
// instructions and tools, and an Owner's live queue@1 swap Weave → FIFO on one
// repo, and back.
//
//   deno task live -- --stage dev wp07a --origin https://<stage host> \
//     --swarm rawkode --swarm-repo rawkode/platform/router \
//     --classic rawkode/docs --classic-repo rawkode/docs/site \
//     [--swap-repo rawkode/platform/router] [--install] [--keep-swap]
//
// Credentials come from the environment and are never printed:
//   TARTAN_TOKEN        an Owner's PAT with the `api` and `admin` scopes (the
//                       packs and the swap need an Owner)
//   TARTAN_AGENT_TOKEN  an agent token (`tagt_`) with the `mcp` scope whose
//                       node covers both repos
//
// Checks:
//   1. (--install) the Swarm pack at --swarm and the Classic pack at
//      --classic (409: already in force);
//   2. the same agent at /-/mcp/<swarm repo> and /-/mcp/<classic repo> gets
//      different instructions: the Weave's card under Swarm, FIFO's (and the
//      Classic card, once registered) under Classic, never the Weave's;
//   3. tools/list: conflicts_* under Swarm only;
//   4. from the Classic scope, work_list on the Swarm repo answers
//      protocol_mismatch with the Swarm repo's MCP URL;
//   5. /-/api/view of the Classic repo names its tabs Issues and Pull
//      requests;
//   6. the swap: the sheet (dry run) says an Owner must approve; the swap
//      makes FIFO the repo's queue@1 provider, its MCP instructions carry
//      FIFO's card and queue_status answers; then (unless --keep-swap) the
//      swap back restores the Weave.
// Exit code 0 only when every check passes.

const arg = (name: string): string | undefined => {
	const i = Deno.args.indexOf(`--${name}`);
	return i >= 0 ? Deno.args[i + 1] : undefined;
};
const flag = (name: string): boolean => Deno.args.includes(`--${name}`);

const fail = (message: string): never => {
	console.error(`wp07a: FAIL ${message}`);
	Deno.exit(1);
};
const pass = (message: string): void => console.log(`wp07a: ok ${message}`);

const origin = (arg("origin") ?? fail("--origin is required")).replace(
	/\/+$/,
	"",
);
const swarm = arg("swarm") ?? fail("--swarm is required");
const swarmRepo = arg("swarm-repo") ?? fail("--swarm-repo is required");
const classic = arg("classic") ?? fail("--classic is required");
const classicRepo = arg("classic-repo") ?? fail("--classic-repo is required");
const swapRepo = arg("swap-repo") ?? swarmRepo;
const token = Deno.env.get("TARTAN_TOKEN") ?? fail("TARTAN_TOKEN unset");
const agentToken = Deno.env.get("TARTAN_AGENT_TOKEN") ??
	fail("TARTAN_AGENT_TOKEN unset");

const api = async (
	path: string,
	init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> => {
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
	try {
		return { status: res.status, body: JSON.parse(text) };
	} catch {
		return { status: res.status, body: { text } };
	}
};

// --- MCP (Streamable HTTP, JSON-RPC 2.0) as the agent, one session per scope --

const parseRpc = (text: string): Record<string, unknown> => {
	const trimmed = text.trim();
	if (trimmed.startsWith("{")) return JSON.parse(trimmed);
	const data = trimmed.split("\n").filter((l) => l.startsWith("data:")).at(-1);
	if (!data) throw new Error("empty MCP response");
	return JSON.parse(data.slice(5));
};

const mcpClient = (scope: string) => {
	let id = 0;
	let session: string | null = null;
	const rpc = async (
		method: string,
		params: Record<string, unknown>,
	): Promise<Record<string, unknown>> => {
		const res = await fetch(`${origin}/-/mcp/${scope}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${agentToken}`,
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				...(session ? { "mcp-session-id": session } : {}),
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
		});
		session = res.headers.get("mcp-session-id") ?? session;
		if (!res.ok) fail(`MCP ${scope} ${method} → ${res.status}`);
		const msg = parseRpc(await res.text());
		if (msg.error) fail(`MCP ${scope} ${method}: ${JSON.stringify(msg.error)}`);
		return msg.result as Record<string, unknown>;
	};
	return {
		initialize: async (): Promise<string> => {
			const r = await rpc("initialize", {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "wp07a-protocols", version: "0.1.0" },
			});
			return String(r.instructions ?? "");
		},
		tools: async (): Promise<string[]> =>
			((await rpc("tools/list", {})).tools as { name: string }[])
				.map((t) => t.name),
		call: (name: string, args: Record<string, unknown>) =>
			rpc("tools/call", { name, arguments: args }),
	};
};

/** Distinctive phrases of the bundled cards (`extensions/*\/protocol.md`). */
const WEAVE = "comes back to you with both intents";
const FIFO = "one change at a time";
const CLASSIC_CARD = "Classic protocol: issues and pull requests";

// --- 1. install -------------------------------------------------------------------

if (flag("install")) {
	for (
		const [extId, node] of [
			["tartan.pack.swarm", swarm],
			["tartan.pack.classic", classic],
		]
	) {
		const res = await api("/-/api/installations", {
			method: "POST",
			body: JSON.stringify({ extId, version: "0.1.0", node, mode: "enforce" }),
		});
		if (res.status === 409) pass(`${extId} already in force at ${node}`);
		else if (res.status === 201) pass(`${extId} installed at ${node}`);
		else fail(`install ${extId} → ${res.status} ${JSON.stringify(res.body)}`);
	}
}

// --- 2–4. scoped MCP ----------------------------------------------------------------

const atSwarm = mcpClient(swarmRepo);
const atClassic = mcpClient(classicRepo);
const swarmText = await atSwarm.initialize();
const classicText = await atClassic.initialize();
if (!swarmText.includes(WEAVE)) fail("no Weave card under Swarm");
if (classicText.includes(WEAVE)) fail("the Weave's card leaks into Classic");
if (!classicText.includes(FIFO)) fail("no FIFO card under Classic");
pass(
	`instructions differ (${swarmText.length} vs ${classicText.length} chars); Classic card ${
		classicText.includes(CLASSIC_CARD)
			? "present"
			: "absent (the Classic card is not registered)"
	}`,
);
const swarmTools = await atSwarm.tools();
const classicTools = await atClassic.tools();
if (!swarmTools.includes("conflicts_check")) fail("no radar tools under Swarm");
if (classicTools.some((t) => t.startsWith("conflicts_"))) {
	fail("radar tools leak into Classic");
}
pass(`tools differ (${swarmTools.length} vs ${classicTools.length})`);
const mismatch = await atClassic.call("work_list", { repo: swarmRepo });
const mismatchBody = (mismatch.structuredContent ?? {}) as Record<
	string,
	unknown
>;
if (
	mismatch.isError !== true ||
	mismatchBody.mcpUrl !== `${origin}/-/mcp/${swarmRepo}`
) {
	fail(`no protocol_mismatch: ${JSON.stringify(mismatchBody).slice(0, 300)}`);
}
pass(`protocol_mismatch names ${mismatchBody.mcpUrl}`);

// --- 5. Classic wording -------------------------------------------------------------

const view = await api(`/-/api/view?path=${encodeURIComponent(classicRepo)}`);
if (view.status !== 200) fail(`view → ${view.status}`);
const labels = (((view.body.static as { tabs?: { label?: string }[] })?.tabs) ??
	[]).map((t) => t.label);
for (const label of ["Issues", "Pull requests"]) {
	if (!labels.includes(label)) fail(`no ${label} tab (${labels.join(", ")})`);
}
pass(`Classic tabs: ${labels.join(", ")}`);

// --- 6. the swap ----------------------------------------------------------------------

const swapTo = async (extId: string, dryRun = false) =>
	await api("/-/api/installations/replace", {
		method: "POST",
		body: JSON.stringify({
			node: swapRepo,
			iface: "queue@1",
			extId,
			version: "0.1.0",
			dryRun,
		}),
	});
const sheet = await swapTo("tartan.fifo", true);
if (sheet.status !== 200 || sheet.body.needsOwner !== true) {
	fail(`swap sheet → ${sheet.status} ${JSON.stringify(sheet.body)}`);
}
pass(`swap sheet: ${JSON.stringify(sheet.body.steps)}`);
const swapped = await swapTo("tartan.fifo");
const provider = swapped.body.provider as { extId?: string } | undefined;
if (swapped.status !== 200 || provider?.extId !== "tartan.fifo") {
	fail(`swap → ${swapped.status} ${JSON.stringify(swapped.body)}`);
}
pass(`queue@1 at ${swapRepo} is now tartan.fifo`);
// MCP cards are cached per isolate for a few seconds (CARDS_CACHE_MS).
await new Promise((r) => setTimeout(r, 6_000));
const atSwap = mcpClient(swapRepo);
const swapText = await atSwap.initialize();
if (!swapText.includes(FIFO) || swapText.includes(WEAVE)) {
	fail("the swapped repo's instructions still carry the Weave");
}
const status = await atSwap.call("queue_status", { repo: swapRepo });
if (status.isError) fail(`queue_status → ${JSON.stringify(status.content)}`);
pass("the swapped repo serves FIFO's card and queue_status");
if (!flag("keep-swap")) {
	const back = await swapTo("tartan.weave");
	const now = back.body.provider as { extId?: string } | undefined;
	if (back.status !== 200 || now?.extId !== "tartan.weave") {
		fail(`swap back → ${back.status} ${JSON.stringify(back.body)}`);
	}
	pass(`queue@1 at ${swapRepo} is the Weave again`);
}
console.log("wp07a: PASS");
