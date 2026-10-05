// Per-subtree protocols over MCP: the Swarm pack at a forge root and the
// Classic pack on a subtree below it, resolved with the registry's own rules.
// The same agent sees different instructions and tools at `/-/mcp/<path>`, a
// call into the other protocol answers `protocol_mismatch`, `/-/agents.md`
// follows the scope, and an Owner's queue@1 swap changes where `queue_*` calls
// go.

import { equal, notEqual, ok } from "node:assert/strict";
import { ProtocolMismatchSchema, ROLE } from "@tartan/contract";
import { protocol as CLASSIC_CARD } from "../../../extensions/packs/classic/src/index.ts";
import { builtins } from "../../builtins.ts";
import { agentsMarkdown } from "./agentsmd.ts";
import { createMcpHost } from "./host.ts";
import type { McpSession } from "./session.ts";
import { authOf, createFakeForge, ORIGIN } from "./testing/fakes.ts";
import { valueOf } from "./testing/fixture.ts";

const card = (extId: string): string => {
	const md = builtins.get(extId)?.protocol;
	if (md === undefined) throw new Error(`${extId} has no card`);
	return md.trim();
};

/** Swarm on the root `rawkode`, Classic on `rawkode/docs`. */
const nested = () => {
	const forge = createFakeForge();
	forge.addNode("rawkode", "user");
	forge.addNode("rawkode/platform", "group");
	const router = forge.addNode("rawkode/platform/router", "repo");
	forge.addNode("rawkode/docs", "group");
	const site = forge.addNode("rawkode/docs/site", "repo");
	const swarm = forge.install("tartan.pack.swarm", "rawkode", {
		bundledCards: true,
	});
	forge.install("tartan.pack.classic", "rawkode/docs", {
		card: CLASSIC_CARD,
		bundledCards: true,
	});
	const owner = forge.addPrincipal({ kind: "user", handle: "rawkode" }).id;
	forge.grant(owner, "rawkode", ROLE.owner);
	const claude = forge.addPrincipal({
		kind: "agent",
		handle: "claude-1",
		owner,
		tool: "claude-code",
	}).id;
	const host = createMcpHost(forge.ports);
	const open = (rest: string) =>
		host.open(authOf(claude, { maxRole: ROLE.developer }), rest);
	const call = (session: McpSession, name: string, args: unknown = {}) =>
		host.callTool(session, name, args);
	return { forge, host, open, call, router, site, swarm, claude };
};

const names = (tools: { name: string }[]) => tools.map((t) => t.name).sort();

Deno.test("one agent, two MCP URLs: Classic under Swarm gets its own instructions", async () => {
	const fx = nested();
	const docs = fx.host.instructions(await fx.open("rawkode/docs/site"));
	const platform = fx.host.instructions(
		await fx.open("rawkode/platform/router"),
	);
	// Classic: its own card first (issues and pull requests), then FIFO's;
	// neither the Weave's nor the radar's, though the Swarm pack is above it.
	ok(docs.includes(CLASSIC_CARD.trim()));
	ok(docs.includes(card("tartan.fifo")));
	ok(!docs.includes(card("tartan.weave")), "no Weave card in Classic");
	ok(!docs.includes(card("tartan.radar")), "no radar card in Classic");
	ok(
		docs.indexOf(CLASSIC_CARD.trim()) < docs.indexOf(card("tartan.fifo")),
		"the pack's card leads",
	);
	// Swarm: the Weave and the radar, no Classic card.
	ok(platform.includes(card("tartan.weave")));
	ok(platform.includes(card("tartan.radar")));
	ok(!platform.includes(CLASSIC_CARD.trim()));
	notEqual(
		(await fx.open("rawkode/docs/site")).protocol,
		(await fx.open("rawkode/platform/router")).protocol,
	);
});

Deno.test("tools/list: no radar tools in the Classic subtree, though Swarm's radar is above it", async () => {
	const fx = nested();
	const docs = names(await fx.host.listTools(await fx.open("rawkode/docs")));
	const platform = names(
		await fx.host.listTools(await fx.open("rawkode/platform")),
	);
	ok(platform.includes("conflicts_check"));
	ok(!docs.includes("conflicts_check"), docs.join(","));
	ok(!docs.includes("conflicts_list") && !docs.includes("conflicts_ack"));
	for (const tools of [docs, platform]) {
		for (const t of ["work_claim", "changes_submit", "queue_status"]) {
			ok(tools.includes(t), t);
		}
	}
});

Deno.test("calls route to the subtree's providers; the other protocol answers protocol_mismatch", async () => {
	const fx = nested();
	const at = new Map<string, string>();
	for (const ext of ["tartan.fifo", "tartan.weave"]) {
		fx.forge.onTool(ext, "queue_status", (_args, ctx) => {
			at.set(ext, ctx.scope);
			return { partitions: [] };
		});
	}
	const docs = await fx.open("rawkode/docs/site");
	const routed = await fx.call(docs, "queue_status", {});
	equal(routed.isError, undefined, routed.content[0].text);
	equal(fx.forge.calls.at(-1)?.ext, "tartan.fifo");
	const platform = await fx.open("rawkode/platform/router");
	await fx.call(platform, "queue_status", {});
	equal(fx.forge.calls.at(-1)?.ext, "tartan.weave");
	// From the Classic scope into a Swarm repo, and back.
	const mismatch = await fx.call(docs, "work_list", {
		repo: "rawkode/platform/router",
	});
	equal(mismatch.isError, true);
	const body = valueOf(mismatch);
	ok(ProtocolMismatchSchema.safeParse(body).success, JSON.stringify(body));
	equal(body.mcpUrl, `${ORIGIN}/-/mcp/rawkode/platform/router`);
	const back = valueOf(
		await fx.call(platform, "work_list", { repo: "rawkode/docs/site" }),
	);
	equal(back.mcpUrl, `${ORIGIN}/-/mcp/rawkode/docs/site`);
});

Deno.test("an Owner's queue@1 swap on a repo changes its card, its route and its protocol", async () => {
	const fx = nested();
	fx.forge.onTool("tartan.fifo", "queue_status", () => ({ partitions: [] }));
	fx.forge.onTool("tartan.weave", "queue_status", () => ({ partitions: [] }));
	const before = await fx.open("rawkode/platform/router");
	// What `replaceProvider` does for a repo under the Swarm pack: FIFO
	// installed on the repo itself, outside any pack.
	const [fifo] = fx.forge.install("tartan.fifo", "rawkode/platform/router", {
		bundledCards: true,
	});
	const after = await fx.open("rawkode/platform/router");
	notEqual(before.protocol, after.protocol);
	const text = fx.host.instructions(after);
	ok(text.includes(card("tartan.fifo")));
	ok(!text.includes(card("tartan.weave")), "the replaced Weave's card is gone");
	// The radar of the Swarm pack still acts there: only queue@1 changed.
	ok(text.includes(card("tartan.radar")));
	await fx.call(after, "queue_status", {});
	equal(fx.forge.calls.at(-1)?.target.installationId, fifo.installation.id);
	// The sibling repo keeps the Weave.
	const sibling = fx.forge.addNode("rawkode/platform/web", "repo");
	ok(sibling.id);
	const web = await fx.open("rawkode/platform/web");
	await fx.call(web, "queue_status", {});
	equal(fx.forge.calls.at(-1)?.ext, "tartan.weave");
	// And back (the repo's FIFO disabled): the Weave again.
	fx.forge.setMode(fifo.installation.id, "disabled");
	const swappedBack = await fx.open("rawkode/platform/router");
	equal(swappedBack.protocol, before.protocol);
	await fx.call(swappedBack, "queue_status", {});
	equal(fx.forge.calls.at(-1)?.ext, "tartan.weave");
});

Deno.test("/-/agents.md follows the scope: Classic cards under Classic, Swarm's elsewhere", async () => {
	const fx = nested();
	const docs = agentsMarkdown(
		ORIGIN,
		"rawkode/docs",
		await fx.forge.ports.protocolCards(fx.forge.nodeAt("rawkode/docs").id),
	);
	ok(docs.includes(CLASSIC_CARD.trim()));
	ok(docs.includes(`${ORIGIN}/-/mcp/rawkode/docs`));
	ok(!docs.includes("tartan.radar") && !docs.includes("tartan.weave"));
	const root = agentsMarkdown(
		ORIGIN,
		"rawkode",
		await fx.forge.ports.protocolCards(fx.forge.nodeAt("rawkode").id),
	);
	ok(root.includes("tartan.weave") && !root.includes("tartan.pack.classic"));
});

Deno.test("/-/agents.md at the forge scope says where protocol tools answer; git needs no CLI (agent smoke)", async () => {
	const fx = nested();
	const forge = agentsMarkdown(ORIGIN, "", []);
	ok(forge.includes(`${ORIGIN}/-/agents.md?path=<group-or-repo>`));
	ok(forge.includes("kernel's tools only"));
	const scoped = agentsMarkdown(
		ORIGIN,
		"rawkode",
		await fx.forge.ports.protocolCards(fx.forge.nodeAt("rawkode").id),
	);
	ok(!scoped.includes("kernel's tools only"), "a node scope needs no note");
	for (const md of [forge, scoped]) {
		ok(md.includes('http.extraHeader="Authorization: Bearer $TARTAN_TOKEN"'));
		ok(md.includes(`${ORIGIN}/<repo path>.git`));
		ok(md.includes("neither is needed"));
	}
});
