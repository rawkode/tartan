// The handoff agent (`deno task e2e -- agent`), on a fake forge API.

import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import type { AgentCreatedResponse } from "@tartan/contract/api.ts";
import {
	HANDOFF_GROUP,
	HANDOFF_MAX_ROLE,
	HANDOFF_NODE,
	HANDOFF_SCOPES,
	handoffOutRefusal,
	handoffPath,
	handoffText,
	mintHandoff,
} from "./handoff.ts";
import { PACK_AT, runIdTime } from "./provision.ts";
import { INTERFACE_TOOLS } from "@tartan/contract/interfaces.ts";

const NOW = Date.UTC(2026, 9, 5, 12, 0);
const DAY = 86_400_000;
const ORIGIN = "https://tartan-dev-e2e.example.workers.dev";
const TOKEN = "tartan_agent_fake_handoff_value";

const fake = (fail = false) => {
	const created: Record<string, unknown>[] = [];
	const signedOut: string[] = [];
	const disabled: string[] = [];
	return {
		created,
		signedOut,
		disabled,
		deps: {
			api: {
				origin: ORIGIN,
				disableAgent: (_caller: unknown, id: string): Promise<undefined> => {
					disabled.push(id);
					return Promise.resolve(undefined);
				},
				createAgent: (
					_caller: unknown,
					input: Record<string, unknown>,
				): Promise<AgentCreatedResponse> => {
					if (fail) return Promise.reject(new Error("forge down"));
					created.push(input);
					return Promise.resolve({
						agent: {
							id: "01agent",
							handle: String(input.name),
							display: String(input.name),
							ownerUserId: "01developer",
							createdAt: NOW,
							disabled: false,
							tokens: [],
						},
						token: TOKEN,
						snippets: { claudeCode: "", codex: "", gitCredential: "" },
					});
				},
			},
			signIn: () => Promise.resolve("cookie-dev"),
			signOut: (s: string) => {
				signedOut.push(s);
				return Promise.resolve(true);
			},
			now: () => NOW,
			random: (n: number) => new Uint8Array(n).fill(0xab),
		},
	};
};

const keep = () => Promise.resolve();

Deno.test("the handoff agent is a developer agent on e2e with the MCP URL of the Swarm pack group", async () => {
	const f = fake();
	const h = await mintHandoff(f.deps, { ttlDays: 2, persist: keep });
	equal(f.created.length, 1);
	deepStrictEqual(f.created[0], {
		name: h.handle,
		tool: "other",
		node: HANDOFF_NODE,
		maxRole: HANDOFF_MAX_ROLE,
		ttlDays: 2,
		scopes: HANDOFF_SCOPES,
	});
	equal(h.mcpUrl, `${ORIGIN}/-/mcp/${HANDOFF_GROUP}`);
	equal(h.group, HANDOFF_GROUP);
	deepStrictEqual(f.disabled, []);
	equal(h.origin, ORIGIN);
	equal(h.agentId, "01agent");
	equal(h.ownerUserId, "01developer");
	equal(h.expiresAt, new Date(NOW + 2 * DAY).toISOString());
	ok(h.token === TOKEN, "the token is the one the forge showed");
	deepStrictEqual(f.signedOut, ["cookie-dev"]);
});

Deno.test("the handoff agent's name is one the janitor sweeps after a day", async () => {
	const h = await mintHandoff(fake().deps, { ttlDays: 1, persist: keep });
	ok(h.handle.startsWith("e2e-"));
	ok(h.handle.endsWith("-handoff"));
	equal(runIdTime(h.handle), NOW);
});

Deno.test("the persona's session is signed out when minting fails", async () => {
	const f = fake(true);
	await rejects(
		() => mintHandoff(f.deps, { ttlDays: 1, persist: keep }),
		/forge down/,
	);
	deepStrictEqual(f.signedOut, ["cookie-dev"]);
});

Deno.test("ttlDays must be a whole number of days", async () => {
	for (const ttlDays of [0, -1, 1.5, Number.NaN]) {
		await rejects(
			() => mintHandoff(fake().deps, { ttlDays, persist: keep }),
			/whole number of days/,
		);
	}
});

Deno.test("the handoff file is JSON under .private/e2e/agent/", async () => {
	const h = await mintHandoff(fake().deps, { ttlDays: 1, persist: keep });
	const parsed = JSON.parse(handoffText(h));
	equal(parsed.mcpUrl, h.mcpUrl);
	ok(parsed.token === TOKEN);
	equal(handoffPath("/repo"), "/repo/.private/e2e/agent/agent.json");
});

Deno.test("the MCP URL names a pack group, whose scope serves the work and lanes tools", async () => {
	// The e2e group carries no pack: a work_* call at /-/mcp/e2e answers
	// protocol_mismatch. Every pack group the provisioning installs serves
	// the tools the M1 loop's agents call.
	equal(PACK_AT[HANDOFF_NODE], undefined, "the e2e group carries no pack");
	equal(PACK_AT[HANDOFF_GROUP], "tartan.pack.swarm");
	const read = async (file: string) =>
		JSON.parse(
			await Deno.readTextFile(
				new URL(`../../extensions/${file}`, import.meta.url),
			),
		);
	const pack = await read("packs/swarm/tartan.json");
	const provided = new Set<string>();
	for (const member of pack.members as { id: string }[]) {
		const dir = member.id.replace(/^tartan\./, "");
		const manifest = await read(`${dir}/tartan.json`).catch(() => null);
		for (const id of manifest?.provides ?? []) provided.add(id);
	}
	for (const tool of ["work_get", "work_claim", "changes_submit"]) {
		const iface = INTERFACE_TOOLS[tool]?.iface;
		ok(
			iface !== undefined && provided.has(iface),
			`${tool} (${iface}) is served`,
		);
	}
	const classic = await mintHandoff(fake().deps, {
		ttlDays: 1,
		group: "e2e/classic",
		persist: keep,
	});
	equal(classic.mcpUrl, `${ORIGIN}/-/mcp/e2e/classic`);
	await rejects(
		() => mintHandoff(fake().deps, { ttlDays: 1, group: "e2e", persist: keep }),
		/pack group/,
	);
});

Deno.test("a handoff file that cannot be written disables the agent", async () => {
	const f = fake();
	await rejects(
		() =>
			mintHandoff(f.deps, {
				ttlDays: 1,
				persist: () => Promise.reject(new Error("EPERM")),
			}),
		/EPERM/,
	);
	deepStrictEqual(f.disabled, ["01agent"]);
	deepStrictEqual(f.signedOut, ["cookie-dev"]);
});

Deno.test("--out stays under .private/ inside the checkout and needs a private directory", () => {
	const root = "/repo";
	equal(
		handoffOutRefusal(root, "/repo/.private/e2e/agent/agent.json", null),
		null,
	);
	equal(handoffOutRefusal(root, "/repo/.private/x/agent.json", 0o700), null);
	equal(handoffOutRefusal(root, "/elsewhere/new/agent.json", null), null);
	ok(handoffOutRefusal(root, "/repo/agent.json", 0o755)?.includes(".private/"));
	ok(
		handoffOutRefusal(root, "/repo/e2e/agent.json", 0o700)?.includes(
			".private/",
		),
	);
	ok(handoffOutRefusal(root, "/tmp/agent.json", 0o777)?.includes("readable"));
	ok(
		handoffOutRefusal(root, "/Users/me/agent.json", 0o750)?.includes(
			"readable",
		),
	);
	ok(handoffOutRefusal(root, "/repo", 0o755) !== null);
});
