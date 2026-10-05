// The IdP: DCR from a pasted issuer, manual entry, RFC 7592 deregistration,
// login transactions, and the OIDC code exchange. Deno tests with a mock IdP.

import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { fromRpcError } from "@tartan/contract";
import { sha256Hex } from "./crypto.ts";
import { createKeyring } from "./keyring.ts";
import {
	authorizationUrl,
	discover,
	exchangeCode,
	pkcePair,
	randomNonce,
	randomState,
} from "./oidc.ts";
import { createGuardedFetch } from "./ssrf.ts";
import { IP_A, ORIGIN, SETUP_TOKEN } from "./testing/flows.ts";
import { createIdentityHarness, TEST_SECRET } from "./testing/harness.ts";
import {
	createMockIdp,
	type MockIdpOptions,
	publicClientRegistration,
} from "./testing/mock-idp.ts";
import { createTestStorage } from "./testing/sqlite.ts";

const codeOf = async (p: Promise<unknown>) =>
	fromRpcError(await p.then(() => null, (e) => e));

const unlocked = async (
	options: MockIdpOptions = {},
	env: Parameters<typeof createIdentityHarness>[0]["env"] = {},
) => {
	const idp = await createMockIdp(options);
	const h = createIdentityHarness({
		storage: createTestStorage(),
		migrate: true,
		fetch: idp.fetch,
		env: { TARTAN_SETUP_TOKEN: SETUP_TOKEN, ...env },
	});
	const { sessionCookie } = await h.facade.unlock({
		token: SETUP_TOKEN,
		purpose: "bootstrap",
		ipHash: IP_A,
	});
	await h.facade.setName(
		{ forgeName: "Rawkode", canonicalOrigin: ORIGIN },
		sessionCookie,
	);
	return { idp, h, session: sessionCookie };
};

Deno.test("DCR stores client_auth 'none' and no secret; Tartan asked for a public PKCE client", async () => {
	const { idp, h, session } = await unlocked();
	const { clientId } = await h.facade.registerIdp(
		{ issuer: idp.issuer },
		session,
	);
	equal(clientId, "client-1");
	const row = await h.facade.idp();
	equal(row?.client_auth, "none");
	equal(row?.client_secret_sealed, null);
	equal(row?.id_token_alg, "RS256");
	equal(row?.source, "dcr");
	match(row?.registration_sealed ?? "", /^v1\./);
	equal((await h.facade.setupState()).state, "idp");
	deepStrictEqual(idp.registrations[0].body, {
		client_name: "Tartan (Rawkode)",
		redirect_uris: [`${ORIGIN}/-/auth/callback`],
		grant_types: ["authorization_code"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
		id_token_signed_response_alg: "RS256",
		scope: "openid profile email groups",
	});
	equal(idp.registrations[0].authorization, null);
});

Deno.test("DCR: an initial access token is sent once and never stored", async () => {
	const { idp, h, session } = await unlocked();
	await h.facade.registerIdp({
		issuer: idp.issuer,
		initialAccessToken: "iat-secret",
	}, session);
	equal(idp.registrations[0].authorization, "Bearer iat-secret");
	const dump = JSON.stringify(
		h.storage.sql.exec("SELECT * FROM idp").toArray(),
	);
	equal(dump.includes("iat-secret"), false);
});

Deno.test("client_secret_basic plus a secret is stored with that method and the secret sealed", async () => {
	const { idp, h, session } = await unlocked({
		registration: (body, clientId, issuer) => ({
			status: 201,
			body: {
				client_id: clientId,
				client_secret: "returned-secret",
				token_endpoint_auth_method: "client_secret_basic",
				redirect_uris: body.redirect_uris,
				registration_access_token: "rat",
				registration_client_uri: `${issuer}/register/${clientId}`,
			},
			client: {
				method: "client_secret_basic",
				secret: "returned-secret",
				registrationToken: "rat",
			},
		}),
	});
	await h.facade.registerIdp({ issuer: idp.issuer }, session);
	const row = await h.facade.idp();
	equal(row?.client_auth, "client_secret_basic");
	ok(row?.client_secret_sealed);
	equal(row?.client_secret_sealed?.includes("returned-secret"), false);
	const keyring = await createKeyring(TEST_SECRET);
	equal(
		await keyring.open("idp-secret", "default", row!.client_secret_sealed!),
		"returned-secret",
	);
});

Deno.test("private_key_jwt or an unknown method, a failing endpoint, or no endpoint: unavailable, then manual entry works", async () => {
	for (
		const options of [
			{
				registration: () => ({
					status: 201,
					body: {
						client_id: "c",
						token_endpoint_auth_method: "private_key_jwt",
					},
				}),
			},
			{
				registration: () => ({
					status: 201,
					body: {
						client_id: "c",
						token_endpoint_auth_method: "self_signed_tls_client_auth",
					},
				}),
			},
			{
				registration: () => ({ status: 500, body: { error: "server_error" } }),
			},
			{ registration: false as const },
		] satisfies MockIdpOptions[]
	) {
		const { idp, h, session } = await unlocked(options);
		const e = await codeOf(
			h.facade.registerIdp({ issuer: idp.issuer }, session),
		);
		equal(
			e.code,
			"unavailable",
			JSON.stringify(options.registration === false ? "none" : "x"),
		);
		equal(await h.facade.idp(), null);
		idp.addClient("manual", { method: "none" });
		await h.facade.configureIdp({
			issuer: idp.issuer,
			clientId: "manual",
			clientAuth: "none",
		}, session);
		equal((await h.facade.idp())?.source, "wizard");
	}
});

Deno.test("a registration_client_uri on another origin refuses the registration", async () => {
	const { idp, h, session } = await unlocked({
		registration: (_body, clientId) => ({
			status: 201,
			body: {
				client_id: clientId,
				token_endpoint_auth_method: "none",
				registration_access_token: "rat",
				registration_client_uri:
					`https://evil.example.net/register/${clientId}`,
			},
		}),
	});
	const e = await codeOf(h.facade.registerIdp({ issuer: idp.issuer }, session));
	equal(e.code, "unavailable");
	match(e.text, /origin/);
	equal(await h.facade.idp(), null);
});

Deno.test("a DCR request to a private address is refused by the SSRF validator (no request made)", async () => {
	const { idp, h, session } = await unlocked({
		extraMetadata: { registration_endpoint: "https://10.0.0.5/register" },
	});
	const e = await codeOf(h.facade.registerIdp({ issuer: idp.issuer }, session));
	equal(e.code, "invalid");
	match(e.text, /registration_endpoint/);
	equal(idp.registrations.length, 0);
	for (
		const issuer of [
			"https://127.0.0.1",
			"https://localhost",
			"https://169.254.169.254",
		]
	) {
		const before = idp.requests.length;
		equal(
			(await codeOf(h.facade.registerIdp({ issuer }, session))).code,
			"invalid",
			issuer,
		);
		equal(idp.requests.length, before, issuer);
	}
});

Deno.test("a pasted issuer with a trailing slash does not match", async () => {
	const { idp, h, session } = await unlocked({
		issuer: "https://id.rawkode.test",
	});
	const e = await codeOf(
		h.facade.registerIdp({ issuer: "https://id.rawkode.test/" }, session),
	);
	equal(e.code, "invalid");
	match(e.text, /issuer mismatch.*https:\/\/id\.rawkode\.test;/);
	await h.facade.registerIdp({ issuer: idp.issuer }, session);
	equal((await h.facade.idp())?.issuer, "https://id.rawkode.test");
});

Deno.test("discovery refuses an IdP without PKCE S256", async () => {
	const idp = await createMockIdp({ pkceMethods: ["plain"] });
	const e = fromRpcError(
		await discover(idp.issuer, createGuardedFetch(idp.fetch)).catch((x) => x),
	);
	match(e.text, /PKCE S256/);
});

Deno.test("deregister is 404 without TARTAN_DESTROY_TOKEN, sends the RFC 7592 DELETE with it, and accepts the token once", async () => {
	const none = await unlocked();
	equal(
		(await codeOf(none.h.facade.deregisterIdp("0".repeat(64)))).code,
		"not_found",
	);

	const { idp, h, session } = await unlocked({}, {
		TARTAN_DESTROY_TOKEN: "destroy-me-0123456789",
	});
	await h.facade.registerIdp({ issuer: idp.issuer }, session);
	equal(
		(await codeOf(h.facade.deregisterIdp(await sha256Hex("wrong")))).code,
		"denied",
	);
	const hash = await sha256Hex("destroy-me-0123456789");
	deepStrictEqual(await h.facade.deregisterIdp(hash), {
		clientId: "client-1",
		deregistered: true,
	});
	deepStrictEqual(idp.deleted, ["client-1"]);
	const del = idp.requests.find((r) => r.method === "DELETE");
	equal(del?.headers.authorization, "Bearer rat_client-1");
	const again = await codeOf(h.facade.deregisterIdp(hash));
	equal(again.code, "denied");
	match(again.text, /already used/);
	equal((await h.facade.idp())?.registration_sealed, null);
	ok(h.events.audits.some((a) => a.action === "idp.deregister"));
});

Deno.test("OIDC_ISSUER pins the IdP: registration is off and manual entry must match", async () => {
	const idp = await createMockIdp();
	const { h, session } = await unlocked({}, {
		OIDC_ISSUER: idp.issuer,
		OIDC_CLIENT_ID: "pinned",
	});
	equal(
		(await codeOf(h.facade.registerIdp({ issuer: idp.issuer }, session))).code,
		"conflict",
	);
	equal(
		(await codeOf(
			h.facade.configureIdp({
				issuer: idp.issuer,
				clientId: "other",
				clientAuth: "none",
			}, session),
		)).code,
		"conflict",
	);
});

Deno.test("manual private_key_jwt creates one ES256 client key; the JWKS has only public parts", async () => {
	const { idp, h, session } = await unlocked();
	await h.facade.configureIdp({
		issuer: idp.issuer,
		clientId: "conf",
		clientAuth: "private_key_jwt",
	}, session);
	await h.facade.configureIdp({
		issuer: idp.issuer,
		clientId: "conf",
		clientAuth: "private_key_jwt",
	}, session);
	const { keys } = await h.facade.jwks();
	equal(keys.length, 1);
	const key = keys[0] as Record<string, unknown>;
	deepStrictEqual(Object.keys(key).sort(), [
		"alg",
		"crv",
		"kid",
		"kty",
		"use",
		"x",
		"y",
	]);
	equal(key.alg, "ES256");
	ok((await h.facade.idp())?.client_key);
	equal(
		(await codeOf(
			h.facade.configureIdp({
				issuer: idp.issuer,
				clientId: "c",
				clientAuth: "client_secret_basic",
			}, session),
		)).code,
		"invalid",
	);
	equal(
		(await codeOf(
			h.facade.configureIdp({
				issuer: idp.issuer,
				clientId: "c",
				clientAuth: "none",
				clientSecret: "x",
			}, session),
		)).code,
		"invalid",
	);
});

Deno.test("login transactions are single use and bound to the browser", async () => {
	const { h } = await unlocked();
	const keyring = await createKeyring(TEST_SECRET);
	const stateHash = await sha256Hex("state-1");
	const row = {
		state_hash: stateHash,
		binding_hash: await sha256Hex("binding-1"),
		purpose: "login" as const,
		verifier_sealed: await keyring.seal(
			"login-verifier",
			stateHash,
			"verifier",
		),
		nonce: "nonce-0123456789abcdef",
		return_to: "/acme",
		expires_at: h.clock.now() + 600_000,
		invite_hash: null,
	};
	await h.facade.putLoginTxn(row);
	equal(
		await h.facade.consumeLoginTxn(stateHash, await sha256Hex("other-browser")),
		null,
	);
	deepStrictEqual(
		await h.facade.consumeLoginTxn(stateHash, row.binding_hash),
		row,
	);
	equal(await h.facade.consumeLoginTxn(stateHash, row.binding_hash), null);
	await h.facade.putLoginTxn({
		...row,
		state_hash: await sha256Hex("state-2"),
	});
	h.clock.advance(600_000);
	equal(
		await h.facade.consumeLoginTxn(
			await sha256Hex("state-2"),
			row.binding_hash,
		),
		null,
	);
	equal(
		(await codeOf(
			h.facade.putLoginTxn({ ...row, return_to: "//evil.example" }),
		)).code,
		"invalid",
	);
	equal(
		(await codeOf(
			h.facade.putLoginTxn({ ...row, expires_at: h.clock.now() + 3_600_000 }),
		)).code,
		"invalid",
	);
});

const exchange = async (
	options: MockIdpOptions,
	storedAlg: string,
	sign: "RS256" | "EdDSA",
) => {
	const idp = await createMockIdp({ ...options, idTokenAlg: sign });
	idp.addClient("pub", { method: "none" });
	const fetchFn = createGuardedFetch(idp.fetch);
	const as = await discover(idp.issuer, fetchFn);
	const pkce = await pkcePair();
	const state = randomState();
	const nonce = randomNonce();
	const redirectUri = `${ORIGIN}/-/auth/callback`;
	const url = authorizationUrl(as, {
		clientId: "pub",
		redirectUri,
		scope: "openid",
		state,
		nonce,
		codeChallenge: pkce.challenge,
	});
	const callback = idp.authorize(url, {
		sub: "u1",
		preferred_username: "u1",
		email_verified: true,
	});
	const claims = await exchangeCode({
		as,
		rp: { clientId: "pub", clientAuth: "none", idTokenAlg: storedAlg },
		callback,
		redirectUri,
		state,
		codeVerifier: pkce.verifier,
		nonce,
		verifySignature: true,
		fetch: fetchFn,
	});
	return { claims, idp };
};

Deno.test("an ID token signed with RS256 and one with EdDSA both verify", async () => {
	equal((await exchange({}, "RS256", "RS256")).claims.sub, "u1");
	equal(
		(await exchange({ issParameter: true }, "EdDSA", "EdDSA")).claims.sub,
		"u1",
	);
});

Deno.test("the token request carries the PKCE verifier and no client authentication", async () => {
	const { idp } = await exchange({}, "RS256", "RS256");
	const [token] = idp.tokenRequests();
	const form = new URLSearchParams(token.body);
	match(form.get("code_verifier") ?? "", /^[A-Za-z0-9_-]{43,}$/);
	equal(form.get("client_id"), "pub");
	equal(form.has("client_secret"), false);
	equal(token.headers.authorization, undefined);
});

Deno.test("the stored id_token_alg is enforced (EdDSA stored, RS256 token refused)", async () => {
	const e = fromRpcError(await exchange({}, "EdDSA", "RS256").catch((x) => x));
	match(e.text, /alg/);
});

Deno.test("a wrong state or a replayed code fails the exchange", async () => {
	const idp = await createMockIdp();
	idp.addClient("pub", { method: "none" });
	const fetchFn = createGuardedFetch(idp.fetch);
	const as = await discover(idp.issuer, fetchFn);
	const pkce = await pkcePair();
	const redirectUri = `${ORIGIN}/-/auth/callback`;
	const url = authorizationUrl(as, {
		clientId: "pub",
		redirectUri,
		scope: "openid",
		state: "s1",
		nonce: "n1-0123456789abcdef",
		codeChallenge: pkce.challenge,
	});
	const callback = idp.authorize(url, { sub: "u1" });
	const base = {
		as,
		rp: { clientId: "pub", clientAuth: "none" as const, idTokenAlg: "RS256" },
		callback,
		redirectUri,
		codeVerifier: pkce.verifier,
		nonce: "n1-0123456789abcdef",
		verifySignature: true,
		fetch: fetchFn,
	};
	ok(
		fromRpcError(
			await exchangeCode({ ...base, state: "other" }).catch((x) => x),
		).text.length > 0,
	);
	await exchangeCode({ ...base, state: "s1" });
	const replay = fromRpcError(
		await exchangeCode({ ...base, state: "s1" }).catch((x) => x),
	);
	match(replay.message, /invalid_grant/);
	ok(publicClientRegistration);
});

Deno.test("an origin change re-registers a DCR client with the new redirect URI and deletes the old one", async () => {
	const { idp, h, session } = await unlocked();
	await h.facade.registerIdp({ issuer: idp.issuer }, session);
	await h.facade.setName(
		{ forgeName: "Rawkode", canonicalOrigin: "https://git.example.org" },
		session,
	);
	equal((await h.facade.idp())?.client_id, "client-2");
	deepStrictEqual(idp.registrations[1].body.redirect_uris, [
		"https://git.example.org/-/auth/callback",
	]);
	deepStrictEqual(idp.deleted, ["client-1"]);
	ok(h.events.audits.some((a) => a.action === "idp.reregister"));
	// The same origin again changes nothing.
	await h.facade.setName(
		{ forgeName: "Rawkode", canonicalOrigin: "https://git.example.org" },
		session,
	);
	equal(idp.registrations.length, 2);
});

Deno.test("an origin change leaves a manually entered client alone", async () => {
	const { idp, h, session } = await unlocked();
	idp.addClient("manual", { method: "none" });
	await h.facade.configureIdp(
		{ issuer: idp.issuer, clientId: "manual", clientAuth: "none" },
		session,
	);
	await h.facade.setName(
		{ forgeName: "Rawkode", canonicalOrigin: "https://git.example.org" },
		session,
	);
	equal((await h.facade.idp())?.client_id, "manual");
	equal(idp.registrations.length, 0);
});

Deno.test("the cron refreshes the IdP metadata once it is a day old", async () => {
	const { idp, h, session } = await unlocked();
	await h.facade.registerIdp({ issuer: idp.issuer }, session);
	const discoveries = () =>
		idp.requests.filter((r) =>
			r.url.endsWith("/.well-known/openid-configuration")
		).length;
	const before = discoveries();
	deepStrictEqual(await h.facade.refreshIdp(), { refreshed: false });
	equal(discoveries(), before);
	h.clock.advance(86_400_000);
	deepStrictEqual(await h.facade.refreshIdp(), { refreshed: true });
	equal(discoveries(), before + 1);
	equal((await h.facade.idp())?.discovered_at, h.clock.now());
});
