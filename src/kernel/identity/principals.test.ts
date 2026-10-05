// Principals, sessions, tokens, agents and invites. Deno tests over
// node:sqlite.

import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { fromRpcError, TOKEN_RE } from "@tartan/contract";
import { sha256Hex } from "./crypto.ts";
import { claimForge, OWNER } from "./testing/flows.ts";
import {
	createIdentityHarness,
	type IdentityHarness,
} from "./testing/harness.ts";
import { createMockIdp } from "./testing/mock-idp.ts";
import { createTestStorage } from "./testing/sqlite.ts";

const DAY = 86_400_000;
const codeOf = async (p: Promise<unknown>) =>
	fromRpcError(await p.then(() => null, (e) => e));

const claimed = async (
	env: Parameters<typeof createIdentityHarness>[0]["env"] = {},
) => {
	const idp = await createMockIdp();
	const h = createIdentityHarness({
		storage: createTestStorage(),
		migrate: true,
		fetch: idp.fetch,
		env: {
			TARTAN_SETUP_TOKEN: "setup-token-0123456789abcdefghijklmnopqrstuv",
			...env,
		},
	});
	const { principal, rootNodeId } = await claimForge(h, idp);
	return { h, idp, owner: principal, root: rootNodeId };
};

const login = (
	h: IdentityHarness,
	sub: string,
	invite: string | null = null,
	extra = {},
) =>
	h.facade.loginIdentity(
		{
			issuer: "https://idp.test",
			sub,
			handle: sub,
			display: sub,
			emailVerified: false,
			...extra,
		},
		invite,
	);

Deno.test("an existing identity logs in; an unknown one without an invite gets nothing", async () => {
	const { h, owner } = await claimed();
	deepStrictEqual(await login(h, OWNER.sub), { principal: owner });
	equal(await login(h, "stranger"), null);
	// Same subject at another issuer is another identity (never linked by email).
	equal(
		await h.facade.loginIdentity({
			...OWNER,
			issuer: "https://other.test",
			emailVerified: true,
		}, null),
		null,
	);
});

Deno.test("an invite binds exactly one (iss, sub), grants its role, and cannot be reused", async () => {
	const { h, owner } = await claimed();
	const team = h.tree.addNode("rawkode/platform");
	const invite = await h.facade.createInvite(owner, {
		node: "rawkode/platform",
		role: 30,
	});
	match(invite.inviteId, /^inv_/);
	ok(invite.code.length === 43);
	const hash = await sha256Hex(invite.code);
	const first = await login(h, "alice", hash);
	ok(first);
	deepStrictEqual(h.tree.grants, [{
		by: owner,
		nodeId: team.id,
		principal: first.principal,
		role: 30,
	}]);
	equal(await login(h, "bob", hash), null);
	// The bound identity keeps working without the invite.
	deepStrictEqual(await login(h, "alice"), first);
	const row = h.storage.sql.exec(
		"SELECT used_by_issuer, used_by_sub FROM invites",
	).one();
	deepStrictEqual(row, {
		used_by_issuer: "https://idp.test",
		used_by_sub: "alice",
	});
	ok(
		h.events.appends.some((e) =>
			e.type === "principal.created" && e.node === team.id
		),
	);
});

Deno.test("invites: Maintainer+ at the node, expire after 7 days, revocable", async () => {
	const { h, owner } = await claimed();
	h.tree.addNode("rawkode/docs");
	const alice = (await login(
		h,
		"alice",
		await sha256Hex(
			(await h.facade.createInvite(owner, { node: "rawkode/docs", role: 20 }))
				.code,
		),
	))!;
	equal(
		(await codeOf(
			h.facade.createInvite(alice.principal, {
				node: "rawkode/docs",
				role: 20,
			}),
		)).code,
		"denied",
	);
	const late = await h.facade.createInvite(owner, {
		node: "rawkode/docs",
		role: 20,
	});
	h.clock.advance(7 * DAY + 1);
	equal(await login(h, "carol", await sha256Hex(late.code)), null);
	const revoked = await h.facade.createInvite(owner, {
		node: "rawkode/docs",
		role: 20,
	});
	await h.facade.revokeInvite(revoked.inviteId, owner);
	equal(await login(h, "dave", await sha256Hex(revoked.code)), null);
	equal((await h.facade.listInvites(owner)).length, 3);
	equal(
		(await codeOf(h.facade.createInvite(owner, { node: "no/such", role: 20 })))
			.code,
		"not_found",
	);
});

Deno.test("a relink invite binds a new (iss, sub) to an existing principal (issuer migration)", async () => {
	const { h, owner } = await claimed();
	h.tree.addNode("rawkode/team");
	const invite = await h.facade.createInvite(owner, {
		node: "rawkode/team",
		role: 20,
		relinkPrincipal: owner,
	});
	const relinked = await h.facade.loginIdentity(
		{
			issuer: "https://new-idp.test",
			sub: "new-sub",
			handle: "x",
			display: "x",
			emailVerified: true,
		},
		await sha256Hex(invite.code),
	);
	deepStrictEqual(relinked, { principal: owner });
	equal(h.tree.grants.length, 0);
});

Deno.test("JIT provisioning only with jit on, a verified email and an allowed domain", async () => {
	const { h } = await claimed();
	h.storage.sql.exec(
		"UPDATE idp SET jit_provisioning = 1, allowed_email_domains_json = '[\"example.com\"]'",
	);
	equal(
		await login(h, "j1", null, {
			email: "j1@example.com",
			emailVerified: false,
		}),
		null,
	);
	equal(
		await login(h, "j2", null, {
			email: "j2@elsewhere.com",
			emailVerified: true,
		}),
		null,
	);
	ok(
		await login(h, "j3", null, {
			email: "j3@example.com",
			emailVerified: true,
		}),
	);
});

Deno.test("sessions: idle 12 h (sliding), absolute 7 d, deleted on logout", async () => {
	const { h, owner } = await claimed();
	const { cookie, expiresAt } = await h.facade.createSession(owner, null);
	const id = await sha256Hex(cookie);
	equal(expiresAt, h.clock.now() + 7 * DAY);
	const auth = await h.facade.session(id);
	deepStrictEqual(auth, {
		principal: owner,
		kind: "user",
		via: "session",
		scopes: [],
		nodeId: null,
		laneId: null,
		maxRole: 50,
		isAdmin: true,
		expiresAt,
	});
	for (let i = 0; i < 20; i++) {
		h.clock.advance(11 * 3_600_000);
		if (h.clock.now() >= expiresAt) break;
		ok(await h.facade.session(id), `active at step ${i}`);
	}
	equal(await h.facade.session(id), null, "absolute expiry");
	const idle = await h.facade.createSession(owner, null);
	h.clock.advance(12 * 3_600_000 + 1);
	equal(
		await h.facade.session(await sha256Hex(idle.cookie)),
		null,
		"idle expiry",
	);
	const out = await h.facade.createSession(owner, "sid-1");
	await h.facade.deleteSession(await sha256Hex(out.cookie));
	equal(await h.facade.session(await sha256Hex(out.cookie)), null);
	equal(await h.facade.session("not-a-hash"), null);
});

Deno.test("PATs: tpat_ tokens bound by scopes and role ceiling; expiry mandatory and ≤ 1 year; revocation", async () => {
	const { h, owner } = await claimed();
	const now = h.clock.now();
	const pat = await h.facade.createPat(owner, {
		name: "laptop",
		scopes: ["repo:read", "api"],
		maxRole: 30,
		expiresAt: now + 30 * DAY,
	});
	ok(TOKEN_RE.test(pat.token) && pat.token.startsWith("tpat_"));
	const auth = await h.facade.token(await sha256Hex(pat.token));
	deepStrictEqual(auth, {
		principal: owner,
		kind: "user",
		via: "pat",
		tokenId: pat.tokenId,
		scopes: ["repo:read", "api"],
		nodeId: null,
		laneId: null,
		maxRole: 30,
		isAdmin: false,
		expiresAt: now + 30 * DAY,
	});
	// The plaintext is never stored.
	equal(
		h.storage.sql.exec(
			"SELECT COUNT(*) AS n FROM tokens WHERE hash = ?",
			pat.token,
		).one().n,
		0,
	);
	await h.facade.revokeToken(pat.tokenId, owner);
	equal(await h.facade.token(await sha256Hex(pat.token)), null);
	equal(
		(await codeOf(
			h.facade.createPat(owner, {
				name: "x",
				scopes: ["api"],
				maxRole: 30,
				expiresAt: now + 366 * DAY,
			}),
		)).code,
		"invalid",
	);
	equal(
		(await codeOf(
			h.facade.createPat(owner, {
				name: "x",
				scopes: [],
				maxRole: 30,
				expiresAt: now + DAY,
			}),
		)).code,
		"invalid",
	);
	const short = await h.facade.createPat(owner, {
		name: "short",
		scopes: ["api"],
		maxRole: 30,
		expiresAt: now + 1000,
	});
	h.clock.advance(1000);
	equal(await h.facade.token(await sha256Hex(short.token)), null);
	const admin = await h.facade.createPat(owner, {
		name: "admin",
		scopes: ["admin", "api"],
		maxRole: 50,
		expiresAt: h.clock.now() + DAY,
	});
	equal((await h.facade.token(await sha256Hex(admin.token)))?.isAdmin, true);
});

Deno.test("token creation is rate-limited per user (10/min)", async () => {
	const { h, owner } = await claimed();
	const at = h.clock.now();
	for (let i = 0; i < 10; i++) {
		await h.facade.createPat(owner, {
			name: `t${i}`,
			scopes: ["api"],
			maxRole: 30,
			expiresAt: at + DAY,
		});
	}
	equal(
		(await codeOf(
			h.facade.createPat(owner, {
				name: "t11",
				scopes: ["api"],
				maxRole: 30,
				expiresAt: at + DAY,
			}),
		)).code,
		"rate_limited",
	);
});

Deno.test("agents: a_ principal owned by its creator, tagt_ token scoped to a node; disabling revokes", async () => {
	const { h, owner } = await claimed();
	const node = h.tree.addNode("rawkode/platform");
	const created = await h.facade.createAgent(owner, {
		name: "claude-1",
		tool: "claude-code",
		model: "opus",
		node: "rawkode/platform",
	});
	match(created.principal, /^a_/);
	ok(created.token.startsWith("tagt_") && TOKEN_RE.test(created.token));
	const auth = await h.facade.token(await sha256Hex(created.token));
	deepStrictEqual(auth && { ...auth, expiresAt: 0 }, {
		principal: created.principal,
		kind: "agent",
		via: "agent-token",
		tokenId: created.tokenId,
		scopes: ["repo:read", "repo:write", "lanes", "mcp"],
		nodeId: node.id,
		laneId: null,
		maxRole: 30,
		isAdmin: false,
		expiresAt: 0,
	});
	equal(auth?.expiresAt, h.clock.now() + 7 * DAY);
	const listed = await h.facade.listAgents(owner);
	equal(listed[0].handle, "claude-1");
	equal(listed[0].tool, "claude-code");
	equal(
		(await codeOf(
			h.facade.createAgent(owner, {
				name: "claude-1",
				tool: "codex",
				node: "rawkode/platform",
			}),
		)).code,
		"conflict",
	);
	equal(
		(await codeOf(
			h.facade.createAgent(owner, {
				name: "x",
				tool: "codex",
				node: "rawkode/platform",
				ttlDays: 31,
			}),
		)).code,
		"invalid",
	);
	await h.facade.disableAgent(created.principal, owner);
	equal(await h.facade.token(await sha256Hex(created.token)), null);
});

Deno.test("an agent token dies with its owner; another user cannot revoke it", async () => {
	const { h, owner } = await claimed();
	h.tree.addNode("rawkode/platform");
	const created = await h.facade.createAgent(owner, {
		name: "codex-1",
		tool: "codex",
		node: "rawkode/platform",
	});
	const alice = (await login(
		h,
		"alice",
		await sha256Hex(
			(await h.facade.createInvite(owner, {
				node: "rawkode/platform",
				role: 30,
			})).code,
		),
	))!;
	equal(
		(await codeOf(h.facade.revokeToken(created.tokenId, alice.principal))).code,
		"denied",
	);
	h.storage.sql.exec(
		"UPDATE principals SET disabled_at = 1 WHERE id = ?",
		owner,
	);
	equal(await h.facade.token(await sha256Hex(created.token)), null);
});

Deno.test("bulk agent tokens need TARTAN_STAGE ^dev AND TARTAN_DEV_TOOLS=1", async () => {
	for (
		const env of [{}, { TARTAN_STAGE: "dev-wp02" }, { TARTAN_DEV_TOOLS: "1" }, {
			TARTAN_STAGE: "prod",
			TARTAN_DEV_TOOLS: "1",
		}]
	) {
		const { h, owner, root } = await claimed(env);
		equal(
			(await codeOf(
				h.facade.bulkMintAgents(owner, {
					count: 2,
					prefix: "sim",
					nodeId: root,
					maxRole: 30,
					ttlMs: DAY,
				}),
			)).code,
			"not_found",
			JSON.stringify(env),
		);
	}
	const { h, owner, root } = await claimed({
		TARTAN_STAGE: "dev-wp02",
		TARTAN_DEV_TOOLS: "1",
	});
	const minted = await h.facade.bulkMintAgents(owner, {
		count: 3,
		prefix: "sim",
		nodeId: root,
		maxRole: 30,
		ttlMs: DAY,
	});
	equal(minted.length, 3);
	equal((await h.facade.principalByHandle("sim-2"))?.kind, "agent");
	const again = await h.facade.bulkMintAgents(owner, {
		count: 3,
		prefix: "sim",
		nodeId: root,
		maxRole: 30,
		ttlMs: DAY,
	});
	deepStrictEqual(
		again.map((a) => a.principal),
		minted.map((a) => a.principal),
	);
});

Deno.test("rateLimit: a fixed window per key", async () => {
	const { h } = await claimed();
	for (let i = 0; i < 3; i++) {
		equal((await h.facade.rateLimit("login:ip:x", 3, 60_000)).ok, true);
	}
	const limited = await h.facade.rateLimit("login:ip:x", 3, 60_000);
	equal(limited.ok, false);
	equal(limited.retryAfterMs, 60_000);
	equal((await h.facade.rateLimit("login:ip:y", 3, 60_000)).ok, true);
	h.clock.advance(60_000);
	equal((await h.facade.rateLimit("login:ip:x", 3, 60_000)).ok, true);
});

Deno.test("admin power over others' tokens, agents and invites needs the request's admin context, not only the admin row", async () => {
	const { h, owner } = await claimed();
	h.tree.addNode("rawkode/platform");
	const alice = (await login(
		h,
		"alice",
		await sha256Hex(
			(await h.facade.createInvite(owner, {
				node: "rawkode/platform",
				role: 40,
			})).code,
		),
	))!;
	const agent = await h.facade.createAgent(alice.principal, {
		name: "codex-a",
		tool: "codex",
		node: "rawkode/platform",
	});
	const invite = await h.facade.createInvite(alice.principal, {
		node: "rawkode/platform",
		role: 20,
	});
	// The owner's row is an admin row, but this request is not admin (a
	// token without the admin scope).
	equal(
		(await codeOf(h.facade.revokeToken(agent.tokenId, owner))).code,
		"denied",
	);
	equal(
		(await codeOf(h.facade.disableAgent(agent.principal, owner))).code,
		"denied",
	);
	equal(
		(await codeOf(h.facade.revokeInvite(invite.inviteId, owner))).code,
		"denied",
	);
	ok(
		!(await h.facade.listInvites(owner)).some((i) => i.id === invite.inviteId),
	);
	// A non-admin row never becomes admin by claiming it.
	const other = await h.facade.createInvite(owner, {
		node: "rawkode/platform",
		role: 20,
	});
	equal(
		(await codeOf(h.facade.revokeInvite(other.inviteId, alice.principal, true)))
			.code,
		"denied",
	);
	// With the admin context the owner may act on others' rows.
	ok(
		(await h.facade.listInvites(owner, true)).some((i) =>
			i.id === invite.inviteId
		),
	);
	await h.facade.revokeInvite(invite.inviteId, owner, true);
	await h.facade.disableAgent(agent.principal, owner, true);
	equal(await h.facade.token(await sha256Hex(agent.token)), null);
});

Deno.test("isOwner: true only for the claimed forge Owner (the gateway's ref-policy row 1)", async () => {
	const { h, owner } = await claimed();
	equal(await h.facade.isOwner(owner), true);
	h.tree.addNode("rawkode/platform");
	const created = await h.facade.createAgent(owner, {
		name: "claude-1",
		tool: "claude-code",
		model: "opus",
		node: "rawkode/platform",
	});
	equal(await h.facade.isOwner(created.principal), false);
	equal(await h.facade.isOwner("u_nobody"), false);
});
