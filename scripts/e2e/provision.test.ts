// Provisioning idempotence, the janitor and the teardown, on a fake forge API.

import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import type { PersonaName } from "../../tools/mock-idp/src/users.ts";
import type { ForgeApi } from "./forge-api.ts";
import { SignInError } from "./oidc-client.ts";
import {
	makeRunId,
	provision,
	type ProvisionDeps,
	RUN_ID_RE,
	runIdTime,
	teardown,
} from "./provision.ts";

const NOW = Date.UTC(2026, 9, 3, 12, 0);
const DAY = 86_400_000;

type Node = {
	path: string;
	slug: string;
	kind: "group" | "repo";
	archived: boolean;
	createdAt: number;
};

const createFakeForge = () => {
	const nodes = new Map<string, Node>();
	const installs = new Map<string, string>();
	const accounts = new Set<PersonaName>(["owner"]);
	const tokens: {
		id: string;
		owner: string;
		name: string;
		createdAt: number;
		revokedAt: number | null;
	}[] = [];
	const agents: {
		id: string;
		owner: string;
		handle: string;
		createdAt: number;
		disabled: boolean;
	}[] = [];
	const calls: string[] = [];
	let n = 0;
	const who = (caller: { kind: string; cookie?: string }) =>
		caller.cookie ?? "?";

	const api = {
		resolve: (_c: unknown, path: string) =>
			Promise.resolve(nodes.has(path) ? nodes.get(path) : null),
		createGroup: (_c: unknown, input: { parent?: string; slug: string }) => {
			const path = input.parent ? `${input.parent}/${input.slug}` : input.slug;
			calls.push(`createGroup ${path}`);
			nodes.set(path, {
				path,
				slug: input.slug,
				kind: "group",
				archived: false,
				createdAt: NOW,
			});
			return Promise.resolve(nodes.get(path));
		},
		installations: (_c: unknown, node: string) =>
			Promise.resolve({
				installations: installs.has(node)
					? [{
						installation: {
							nodePath: node,
							pack: installs.get(node),
							extId: "tartan.work",
						},
					}]
					: [],
			}),
		install: (_c: unknown, input: { node: string; extId: string }) => {
			calls.push(`install ${input.extId} ${input.node}`);
			installs.set(input.node, input.extId);
			return Promise.resolve();
		},
		me: (c: { cookie: string }) =>
			Promise.resolve({
				principal: { handle: `e2e-${c.cookie}` },
				auth: { isAdmin: c.cookie === "owner" },
				forge: { devTools: true },
			}),
		createInvite: (_c: unknown, input: { role: number }) => {
			calls.push(`invite ${input.role}`);
			return Promise.resolve({
				url:
					`https://tartan-dev-e2e.acme.workers.dev/-/invite/code-${input.role}`,
			});
		},
		createPat: (c: { cookie: string }, input: { name: string }) => {
			const id = `tok_${++n}`;
			tokens.push({
				id,
				owner: c.cookie,
				name: input.name,
				createdAt: NOW,
				revokedAt: null,
			});
			return Promise.resolve({
				tokenId: id,
				token: `tpat_${String(n).padStart(43, "x")}`,
				expiresAt: NOW + DAY,
			});
		},
		createAgent: (c: { cookie: string }, input: { name: string }) => {
			const id = `p_agent_${++n}`;
			agents.push({
				id,
				owner: c.cookie,
				handle: input.name,
				createdAt: NOW,
				disabled: false,
			});
			return Promise.resolve({
				agent: { id },
				token: `tagt_${String(n).padStart(43, "y")}`,
			});
		},
		tokens: (c: { cookie: string }) =>
			Promise.resolve(tokens.filter((t) => t.owner === c.cookie)),
		revokeToken: (_c: unknown, id: string) => {
			calls.push(`revoke ${id}`);
			const t = tokens.find((t) => t.id === id);
			if (t) t.revokedAt = NOW;
			return Promise.resolve();
		},
		agents: (c: { cookie: string }) =>
			Promise.resolve(agents.filter((a) => a.owner === c.cookie)),
		disableAgent: (_c: unknown, id: string) => {
			calls.push(`disable ${id}`);
			const a = agents.find((a) => a.id === id);
			if (a) a.disabled = true;
			return Promise.resolve();
		},
		children: (_c: unknown, parent: string) =>
			Promise.resolve(
				[...nodes.values()].filter((x) =>
					x.path.startsWith(`${parent}/`) &&
					!x.path.slice(parent.length + 1).includes("/")
				),
			),
		archive: (_c: unknown, path: string) => {
			calls.push(`archive ${path}`);
			const node = nodes.get(path);
			if (node) node.archived = true;
			return Promise.resolve();
		},
	};

	const signedIn: string[] = [];
	const signedOut: string[] = [];
	const deps: ProvisionDeps = {
		api: api as unknown as ForgeApi,
		signIn: (persona, invite) => {
			if (invite !== undefined) accounts.add(persona);
			if (!accounts.has(persona)) {
				return Promise.reject(
					new SignInError("callback", "no account", "no-account"),
				);
			}
			signedIn.push(persona);
			return Promise.resolve(persona);
		},
		signOut: (s) => {
			signedOut.push(s);
			return Promise.resolve(true);
		},
		now: () => NOW,
		log: () => {},
		packVersions: {
			"tartan.pack.swarm": "0.1.0",
			"tartan.pack.classic": "0.1.0",
		},
	};
	return {
		api,
		deps,
		nodes,
		tokens,
		agents,
		calls,
		accounts,
		signedIn,
		signedOut,
		who,
	};
};

Deno.test("run ids sort by time and are recognised in names", () => {
	const id = makeRunId(NOW, new Uint8Array([0xab, 0xcd]));
	equal(id, "r202610031200abcd");
	ok(RUN_ID_RE.test(id));
	equal(runIdTime(`${id}-git`), NOW);
	equal(runIdTime(`e2e-${id}-owner`), NOW);
	equal(runIdTime("e2e-main"), null);
});

Deno.test("provisioning builds the baseline once and mints the run's credentials", async () => {
	const f = createFakeForge();
	const first = await provision(f.deps, "r202610031200abcd");
	deepStrictEqual(f.calls.filter((c) => c.startsWith("createGroup")), [
		"createGroup e2e",
		"createGroup e2e/swarm",
		"createGroup e2e/classic",
	]);
	deepStrictEqual(f.calls.filter((c) => c.startsWith("install")), [
		"install tartan.pack.swarm e2e/swarm",
		"install tartan.pack.classic e2e/classic",
	]);
	deepStrictEqual(f.calls.filter((c) => c.startsWith("invite")), [
		"invite 30",
		"invite 20",
	]);
	equal(first.revoke.tokenIds.length, 3);
	equal(first.revoke.agentIds.length, 2);
	equal(
		f.tokens.find((t) => t.owner === "reporter")?.name,
		"e2e-r202610031200abcd-reporter",
	);
	equal(
		f.tokens.find((t) => t.owner === "developer")?.name,
		"e2e-r202610031200abcd-dev-read",
		"the developer's own session mints its read-only PAT",
	);
	deepStrictEqual(
		f.agents.map((a) => [a.owner, a.handle]),
		[
			["developer", "e2e-r202610031200abcd-dev"],
			["developer", "e2e-r202610031200abcd-dev-b"],
		],
		"the developer's own session mints agents A and B",
	);
	ok(first.developerAgent !== first.developerAgentB);
	ok(first.readPat.startsWith("tpat_"));
	// The persona sessions are signed out at once; the owner's is kept for teardown.
	deepStrictEqual(f.signedOut.sort(), ["developer", "reporter"]);

	f.calls.length = 0;
	await provision(f.deps, "r202610031300abcd");
	equal(
		f.calls.filter((c) => /^(createGroup|install|invite)/.test(c)).length,
		0,
	);
});

Deno.test("the janitor removes only e2e items older than a day, and run nodes older than two hours", async () => {
	const f = createFakeForge();
	await provision(f.deps, "r202610031200abcd");
	f.tokens.push({
		id: "old",
		owner: "reporter",
		name: "e2e-r202610011200abcd-reporter",
		createdAt: NOW - 2 * DAY,
		revokedAt: null,
	});
	f.tokens.push({
		id: "mine",
		owner: "reporter",
		name: "laptop",
		createdAt: NOW - 9 * DAY,
		revokedAt: null,
	});
	f.agents.push({
		id: "p_old",
		owner: "developer",
		handle: "e2e-r202610011200abcd-dev",
		createdAt: NOW - 2 * DAY,
		disabled: false,
	});
	f.nodes.set("e2e/classic/r202610011200abcd-git", {
		path: "e2e/classic/r202610011200abcd-git",
		slug: "r202610011200abcd-git",
		kind: "repo",
		archived: false,
		createdAt: NOW - 2 * DAY,
	});
	f.nodes.set("e2e/classic/keep-me", {
		path: "e2e/classic/keep-me",
		slug: "keep-me",
		kind: "repo",
		archived: false,
		createdAt: NOW - 9 * DAY,
	});
	// A killed run's repo from three hours ago, and the run of one hour ago.
	f.nodes.set("e2e/swarm/r202610030900abcd-browse", {
		path: "e2e/swarm/r202610030900abcd-browse",
		slug: "r202610030900abcd-browse",
		kind: "repo",
		archived: false,
		createdAt: NOW - 3 * 3_600_000,
	});
	f.nodes.set("e2e/swarm/r202610031100abcd-browse", {
		path: "e2e/swarm/r202610031100abcd-browse",
		slug: "r202610031100abcd-browse",
		kind: "repo",
		archived: false,
		createdAt: NOW - 3_600_000,
	});
	f.calls.length = 0;
	await provision(f.deps, "r202610031300abcd");
	ok(f.calls.includes("archive e2e/swarm/r202610030900abcd-browse"));
	ok(!f.calls.includes("archive e2e/swarm/r202610031100abcd-browse"));
	ok(f.calls.includes("revoke old"));
	ok(!f.calls.includes("revoke mine"));
	ok(f.calls.includes("disable p_old"));
	ok(f.calls.includes("archive e2e/classic/r202610011200abcd-git"));
	ok(!f.calls.includes("archive e2e/classic/keep-me"));
});

Deno.test("teardown revokes, disables and archives the run's items and signs out", async () => {
	const f = createFakeForge();
	const creds = await provision(f.deps, "r202610031200abcd");
	f.agents.push({
		id: "p_ui",
		owner: "owner",
		handle: "e2e-r202610031200abcd-ui",
		createdAt: NOW,
		disabled: false,
	});
	f.nodes.set("e2e/swarm/r202610031200abcd-tabs", {
		path: "e2e/swarm/r202610031200abcd-tabs",
		slug: "r202610031200abcd-tabs",
		kind: "repo",
		archived: false,
		createdAt: NOW,
	});
	// A group a suite made, with a repo in it.
	f.nodes.set("e2e/classic/r202610031200abcd-groups", {
		path: "e2e/classic/r202610031200abcd-groups",
		slug: "r202610031200abcd-groups",
		kind: "group",
		archived: false,
		createdAt: NOW,
	});
	f.nodes.set("e2e/classic/r202610031200abcd-groups/repo", {
		path: "e2e/classic/r202610031200abcd-groups/repo",
		slug: "repo",
		kind: "repo",
		archived: false,
		createdAt: NOW,
	});
	f.calls.length = 0;
	const report = await teardown(f.deps, creds, { keepData: false });
	equal(report.revoked, 3);
	equal(report.disabled, 3);
	equal(report.archived, 3);
	const archives = f.calls.filter((c) => c.startsWith("archive "));
	ok(archives.includes("archive e2e/classic/r202610031200abcd-groups/repo"));
	ok(
		archives.indexOf("archive e2e/classic/r202610031200abcd-groups/repo") <
			archives.indexOf("archive e2e/classic/r202610031200abcd-groups"),
		"a group's children are archived before the group",
	);
	deepStrictEqual(report.failures, []);
	ok(f.signedOut.includes("owner"));
	const kept = await teardown(f.deps, creds, { keepData: true });
	equal(kept.archived, 0);
});

Deno.test("a provisioning that fails half-way revokes what it minted and signs everyone out", async () => {
	const f = createFakeForge();
	let agents = 0;
	const createAgent = f.api.createAgent;
	f.api.createAgent = (c, input) => {
		if (++agents === 2) return Promise.reject(new Error("HTTP 500"));
		return createAgent(c, input);
	};
	await rejects(provision(f.deps, "r202610031200abcd"), /HTTP 500/);
	// The three PATs and agent A were minted; every one is gone again.
	equal(f.tokens.length, 3);
	deepStrictEqual(f.tokens.filter((t) => t.revokedAt === null), []);
	equal(f.agents.length, 1);
	deepStrictEqual(f.agents.filter((a) => !a.disabled), []);
	deepStrictEqual(f.signedOut.sort(), ["developer", "owner", "reporter"]);
});

Deno.test("a forge without dev tools or with another admin is refused, and the owner is signed out", async () => {
	const f = createFakeForge();
	f.api.me = () =>
		Promise.resolve({
			principal: { handle: "e2e-owner" },
			auth: { isAdmin: true },
			forge: { devTools: false },
		});
	await rejects(provision(f.deps, "r202610031200abcd"), /dev tools/);
	ok(f.signedOut.includes("owner"));
});
