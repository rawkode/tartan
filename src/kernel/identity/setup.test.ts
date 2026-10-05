// The setup state machine on the identity module:
// unlock, claim codes, the claim and recovery. Deno tests over
// node:sqlite with a mock IdP.

import {
	deepStrictEqual,
	equal,
	match,
	notEqual,
	ok,
	rejects,
} from "node:assert/strict";
import { fromRpcError } from "@tartan/contract";
import { RATE_LIMITS } from "./policy.ts";
import { setupSecretHash } from "./setup.ts";
import {
	claimForge,
	IP_A,
	IP_B,
	ORIGIN,
	OWNER,
	SETUP_TOKEN,
	unlockAndConfigure,
} from "./testing/flows.ts";
import { createIdentityHarness, loggedCode } from "./testing/harness.ts";
import { createMockIdp } from "./testing/mock-idp.ts";
import { createTestStorage } from "./testing/sqlite.ts";

const harness = (
	env: Parameters<typeof createIdentityHarness>[0]["env"] = {},
) =>
	createMockIdp().then((idp) => ({
		idp,
		h: createIdentityHarness({
			storage: createTestStorage(),
			migrate: true,
			fetch: idp.fetch,
			env: { TARTAN_SETUP_TOKEN: SETUP_TOKEN, ...env },
		}),
	}));

const codeOf = async (p: Promise<unknown>) =>
	fromRpcError(await p.then(() => null, (e) => e));

Deno.test("a fresh forge reports `fresh`; the root key is TARTAN_SECRET", async () => {
	const { h } = await harness();
	deepStrictEqual(await h.facade.setupState(), {
		state: "fresh",
		rootKeyFallback: false,
	});
	equal(await h.facade.rootKey(), null);
});

Deno.test("the claim code is printed only when TARTAN_SETUP_TOKEN is absent, and once while valid", async () => {
	const withToken = (await harness()).h;
	deepStrictEqual(await withToken.facade.ensureBootstrapCode(), {
		created: false,
	});
	deepStrictEqual(withToken.logs, []);

	const { h } = await harness({ TARTAN_SETUP_TOKEN: undefined });
	deepStrictEqual(await h.facade.ensureBootstrapCode(), { created: true });
	deepStrictEqual(await h.facade.ensureBootstrapCode(), { created: false });
	equal(h.logs.length, 1);
	const code = loggedCode(h.logs);
	match(
		code,
		/^([bdfghjklmnprstvz][aeio][bdfghjklmnprstvz]-){9}[bdfghjklmnprstvz][aeio][bdfghjklmnprstvz]$/,
	);
	// Stored as a hash only.
	const stored = h.storage.sql.exec<{ code_hash: string }>(
		"SELECT code_hash FROM setup_codes",
	).toArray();
	deepStrictEqual(stored.map((r) => r.code_hash), [
		await setupSecretHash(code),
	]);
});

Deno.test("a used logs code is rejected; a new one is issued once it is used", async () => {
	const { h } = await harness({ TARTAN_SETUP_TOKEN: undefined });
	await h.facade.ensureBootstrapCode();
	const code = loggedCode(h.logs);
	const unlocked = await h.facade.unlock({
		token: code,
		purpose: "bootstrap",
		ipHash: IP_A,
	});
	ok(unlocked.sessionCookie.length >= 43);
	equal((await h.facade.setupState()).state, "unlocked");
	const again = await codeOf(
		h.facade.unlock({ token: code, purpose: "bootstrap", ipHash: IP_A }),
	);
	equal(again.code, "denied");
	match(again.text, /invalid setup token or code/);
	deepStrictEqual(await h.facade.ensureBootstrapCode(), { created: true });
	notEqual(loggedCode(h.logs), code);
});

Deno.test("an expired logs code is rejected", async () => {
	const { h } = await harness({ TARTAN_SETUP_TOKEN: undefined });
	await h.facade.ensureBootstrapCode();
	h.clock.advance(24 * 3_600_000 + 1);
	equal(
		(await codeOf(
			h.facade.unlock({
				token: loggedCode(h.logs),
				purpose: "bootstrap",
				ipHash: IP_A,
			}),
		)).code,
		"denied",
	);
});

Deno.test("one IP exhausting its budget does not block another IP; a global ceiling applies", async () => {
	const { h } = await harness();
	for (let i = 0; i < RATE_LIMITS.setupPerIp.limit; i++) {
		equal(
			(await codeOf(
				h.facade.unlock({
					token: "wrong-token-xxxxxxxx",
					purpose: "bootstrap",
					ipHash: IP_A,
				}),
			)).code,
			"denied",
		);
	}
	const limited = await codeOf(
		h.facade.unlock({ token: SETUP_TOKEN, purpose: "bootstrap", ipHash: IP_A }),
	);
	equal(limited.code, "rate_limited");
	// The owner on another address still gets in with the right token.
	const ok1 = await h.facade.unlock({
		token: SETUP_TOKEN,
		purpose: "bootstrap",
		ipHash: IP_B,
	});
	ok(ok1.sessionCookie);
	// After the window the first address may try again.
	h.clock.advance(RATE_LIMITS.setupPerIp.windowMs);
	ok(
		(await h.facade.unlock({
			token: SETUP_TOKEN,
			purpose: "bootstrap",
			ipHash: IP_A,
		})).sessionCookie,
	);

	const { h: g } = await harness();
	let n = 0;
	for (; n < RATE_LIMITS.setupGlobal.limit; n++) {
		const ip = n.toString(16).padStart(16, "0");
		await g.facade.unlock({
			token: "wrong-token-xxxxxxxx",
			purpose: "bootstrap",
			ipHash: ip,
		}).catch(() => {});
	}
	equal(
		(await codeOf(
			g.facade.unlock({
				token: SETUP_TOKEN,
				purpose: "bootstrap",
				ipHash: "ffffffffffffffff",
			}),
		)).code,
		"rate_limited",
	);
});

Deno.test("the setup token is compared by digest in constant time; near misses are rejected", async () => {
	const { h } = await harness();
	for (
		const near of [
			SETUP_TOKEN.slice(0, -1),
			`${SETUP_TOKEN}x`,
			SETUP_TOKEN.toUpperCase(),
		]
	) {
		equal(
			(await codeOf(
				h.facade.unlock({
					token: near,
					purpose: "bootstrap",
					ipHash: near === SETUP_TOKEN.toUpperCase() ? IP_B : IP_A,
				}),
			)).code,
			"denied",
		);
	}
});

Deno.test("the claim consumes the deployed token; afterwards unlock AND recover answer 403", async () => {
	const { h, idp } = await harness();
	const claim = await claimForge(h, idp);
	match(claim.principal, /^u_/);
	ok(claim.rootNodeId);
	const state = await h.facade.setupState();
	deepStrictEqual(state, {
		state: "done",
		forgeName: "Rawkode",
		canonicalOrigin: ORIGIN,
		rootKeyFallback: false,
	});
	const owner = await h.facade.principal(claim.principal);
	equal(owner?.is_admin, 1);
	equal(owner?.handle, "rawkode");
	ok(h.internal.isOwner(claim.principal));
	deepStrictEqual(h.tree.roots, [{
		kind: "user",
		slug: "rawkode",
		owner: claim.principal,
	}]);
	deepStrictEqual(
		h.storage.sql.exec("SELECT hash, purpose FROM consumed_setup_secrets")
			.toArray(),
		[{ hash: await setupSecretHash(SETUP_TOKEN), purpose: "bootstrap" }],
	);
	// Setup sessions are gone.
	equal(
		h.storage.sql.exec(
			"SELECT COUNT(*) AS n FROM sessions WHERE kind = 'setup'",
		).one().n,
		0,
	);
	for (const purpose of ["bootstrap", "recover"] as const) {
		const e = await codeOf(
			h.facade.unlock({ token: SETUP_TOKEN, purpose, ipHash: IP_B }),
		);
		equal(e.code, "denied", purpose);
	}
	ok(
		h.events.audits.some((a) =>
			a.action === "setup.claim" && a.principal === claim.principal
		),
	);
	deepStrictEqual(h.events.appends.map((e) => [e.type, e.node]), [[
		"principal.created",
		claim.rootNodeId,
	]]);
	// A second claim is refused.
	equal(
		(await codeOf(h.facade.claimOwner({ ...OWNER, sub: "other" }, null))).code,
		"conflict",
	);
});

Deno.test("a rotated token is accepted once for recovery, then consumed; recovery sets the 7-day banner and an audit row", async () => {
	const { h, idp } = await harness();
	await claimForge(h, idp);
	const rotated = "rotated-token-0123456789abcdefghijklmnop";
	(h.env as { TARTAN_SETUP_TOKEN?: string }).TARTAN_SETUP_TOKEN = rotated;
	const before = h.clock.now();
	const recovered = await h.facade.unlock({
		token: rotated,
		purpose: "recover",
		ipHash: IP_A,
	});
	ok(recovered.sessionCookie);
	deepStrictEqual(await h.facade.setupSession(recovered.sessionCookie), {
		purpose: "recover",
		expiresAt: before + 30 * 60_000,
	});
	equal(
		(await h.facade.setupState()).recoveryBannerUntil,
		before + 7 * 86_400_000,
	);
	ok(h.events.audits.some((a) => a.action === "setup.recover"));
	const again = await codeOf(
		h.facade.unlock({ token: rotated, purpose: "recover", ipHash: IP_B }),
	);
	equal(again.code, "denied");
	match(again.text, /already used/);
	// The banner disappears after 7 days.
	h.clock.advance(7 * 86_400_000 + 1);
	equal((await h.facade.setupState()).recoveryBannerUntil, undefined);
});

Deno.test("recovery is refused before the claim; bootstrap is refused after it", async () => {
	const { h } = await harness();
	equal(
		(await codeOf(
			h.facade.unlock({ token: SETUP_TOKEN, purpose: "recover", ipHash: IP_A }),
		)).code,
		"denied",
	);
});

Deno.test("the claim stands when WP3 cannot create the owner's root node (unavailable, owner-root)", async () => {
	const { h, idp } = await harness();
	await unlockAndConfigure(h, idp);
	h.tree.failRootWith(new Error("tree.createRoot is not implemented"));
	const e = await codeOf(
		h.facade.claimOwner(OWNER, await setupSecretHash(SETUP_TOKEN)),
	);
	equal(e.code, "unavailable");
	equal(e.reason, "owner-root");
	equal((await h.facade.setupState()).state, "done");
	ok(await h.facade.loginIdentity({ ...OWNER, emailVerified: false }, null));
});

Deno.test("setup steps need a valid setup session; it expires after 30 minutes", async () => {
	const { h, idp } = await harness();
	equal(
		(await codeOf(
			h.facade.setName(
				{ forgeName: "x", canonicalOrigin: ORIGIN },
				"nope-nope-nope-nope",
			),
		)).code,
		"unauthenticated",
	);
	const { sessionCookie } = await h.facade.unlock({
		token: SETUP_TOKEN,
		purpose: "bootstrap",
		ipHash: IP_A,
	});
	equal((await h.facade.setupSession(sessionCookie))?.purpose, "bootstrap");
	h.clock.advance(30 * 60_000);
	equal(await h.facade.setupSession(sessionCookie), null);
	equal(
		(await codeOf(
			h.facade.configureIdp({
				issuer: idp.issuer,
				clientId: "c",
				clientAuth: "none",
			}, sessionCookie),
		)).code,
		"unauthenticated",
	);
	equal(
		(await codeOf(
			h.facade.setName({
				forgeName: "x",
				canonicalOrigin: "http://insecure.example",
			}, sessionCookie),
		)).code,
		"unauthenticated",
	);
});

Deno.test("the canonical origin must be https; it is stored as an origin", async () => {
	const { h } = await harness();
	const { sessionCookie } = await h.facade.unlock({
		token: SETUP_TOKEN,
		purpose: "bootstrap",
		ipHash: IP_A,
	});
	equal(
		(await codeOf(
			h.facade.setName({
				forgeName: "x",
				canonicalOrigin: "http://code.example.com",
			}, sessionCookie),
		)).code,
		"invalid",
	);
	const state = await h.facade.setName({
		forgeName: "Forge",
		canonicalOrigin: "https://code.example.com/some/path",
	}, sessionCookie);
	equal(state.canonicalOrigin, "https://code.example.com");
});

Deno.test("button path: without TARTAN_SECRET a root key is generated once, stored sealed", async () => {
	const storage = createTestStorage();
	const idp = await createMockIdp();
	const first = createIdentityHarness({
		storage,
		migrate: true,
		fetch: idp.fetch,
		env: { TARTAN_SECRET: undefined },
	});
	const root = await first.facade.rootKey();
	ok(root && root.length >= 43);
	equal((await first.facade.setupState()).rootKeyFallback, true);
	const sealed = first.storage.sql.exec<{ v: string }>(
		"SELECT v FROM meta WHERE k = 'root_key_fallback_sealed'",
	).one().v;
	match(sealed, /^v1\./);
	equal(sealed.includes(root), false);
	// A new instance on the same storage (an evicted DO) reads the same key.
	const second = createIdentityHarness({
		storage,
		fetch: idp.fetch,
		env: { TARTAN_SECRET: undefined },
	});
	equal(await second.facade.rootKey(), root);
	equal(await first.facade.rootKey(), root);
	// With TARTAN_SECRET set, the fallback is never used or exposed.
	const withSecret = createIdentityHarness({ storage, fetch: idp.fetch });
	equal(await withSecret.facade.rootKey(), null);
});

Deno.test("rejects malformed unlock input", async () => {
	const { h } = await harness();
	await rejects(
		h.facade.unlock({
			token: SETUP_TOKEN,
			purpose: "bootstrap",
			ipHash: "1.2.3.4",
		}),
		/bad ipHash/,
	);
});
