// End-to-end behaviour of the e2e mock IdP's handler over the node:sqlite
// storage stand-in: discovery, JWKS, DCR with RFC 7592 management, the
// authorization code flow, single use and expiry, the allow-list re-checks,
// eviction, rate limits and fail-closed configuration.

import {
	deepStrictEqual,
	equal,
	match,
	notEqual,
	ok,
} from "node:assert/strict";
import { HEALTH_PRODUCT, LIMITS } from "./app.ts";
import { fromB64url, utf8 } from "./encoding.ts";
import { WRONG_PASSWORD } from "./html.ts";
import {
	authorizeUrl,
	CALLBACK,
	codeFor,
	createHarness,
	FORGE,
	ISSUER,
	jsonOf,
	pkce,
	postSignIn,
	redeem,
	registerClient,
	reqOf,
} from "./testing/harness.ts";

const decodeJwt = (token: string) => {
	const [header, payload, signature] = token.split(".");
	const text = (s: string) => new TextDecoder().decode(fromB64url(s));
	return {
		header: JSON.parse(text(header)),
		claims: JSON.parse(text(payload)),
		input: `${header}.${payload}`,
		signature: fromB64url(signature),
	};
};

Deno.test("discovery names this issuer exactly and only same-origin https endpoints", async () => {
	const h = await createHarness();
	const response = await h.fetch(`${ISSUER}/.well-known/openid-configuration`);
	equal(response.status, 200);
	equal(response.headers.get("cache-control"), "no-store");
	const meta = await jsonOf(response);
	equal(meta.issuer, ISSUER);
	for (
		const key of [
			"authorization_endpoint",
			"token_endpoint",
			"jwks_uri",
			"registration_endpoint",
			"end_session_endpoint",
		]
	) {
		equal(new URL(meta[key]).origin, ISSUER, key);
	}
	deepStrictEqual(meta.code_challenge_methods_supported, ["S256"]);
	deepStrictEqual(meta.token_endpoint_auth_methods_supported, ["none"]);
	equal(meta.authorization_response_iss_parameter_supported, true);
});

Deno.test("health never claims to be Tartan", async () => {
	const h = await createHarness();
	const body = await jsonOf(await h.fetch(`${ISSUER}/-/health`));
	equal(body.product, HEALTH_PRODUCT);
	notEqual(body.product, "Tartan");
	equal(body.ok, true);
	equal(body.users, 4);
	equal(body.clients, 0);
});

Deno.test("a full sign-in yields an RS256 ID token that verifies against /jwks", async () => {
	const h = await createHarness();
	const client = await registerClient(h);
	const { verifier, challenge } = await pkce();
	const page = await h.fetch(authorizeUrl(client.clientId, challenge));
	equal(page.status, 200);
	const html = await page.text();
	match(html, /<h1>Tartan e2e IdP<\/h1>/);
	match(html, /<label for="u">Username<\/label>/);
	match(html, /<label for="p">Password<\/label>/);
	match(html, /type="password"/);
	// The form carries the request id only: no client, redirect, state or nonce.
	equal(html.includes(client.clientId), false);
	equal(html.includes(CALLBACK), false);
	equal(html.includes("state-0123456789"), false);
	equal(html.includes("nonce-0123456789"), false);
	match(
		page.headers.get("content-security-policy") ?? "",
		/form-action 'self' https:\/\/tartan-dev-e2e/,
	);
	const signIn = await postSignIn(
		h,
		reqOf(html),
		"e2e-developer",
		await h.password("e2e-developer"),
	);
	equal(signIn.status, 303);
	equal(signIn.headers.get("set-cookie"), null, "no IdP session cookie");
	const location = new URL(signIn.headers.get("location") ?? "");
	equal(`${location.origin}${location.pathname}`, CALLBACK);
	equal(location.searchParams.get("state"), "state-0123456789");
	equal(location.searchParams.get("iss"), ISSUER);
	const code = location.searchParams.get("code") ?? "";
	const token = await redeem(h, {
		code,
		client_id: client.clientId,
		code_verifier: verifier,
	});
	equal(token.status, 200);
	equal(token.headers.get("content-type"), "application/json");
	equal(token.headers.get("cache-control"), "no-store");
	const body = await jsonOf(token);
	equal(body.token_type, "Bearer");
	const jwt = decodeJwt(body.id_token);
	equal(jwt.header.alg, "RS256");
	equal(jwt.claims.iss, ISSUER);
	equal(jwt.claims.aud, client.clientId);
	equal(jwt.claims.sub, "e2e-developer-0001");
	equal(jwt.claims.nonce, "nonce-0123456789");
	equal(jwt.claims.preferred_username, "e2e-developer");
	equal(jwt.claims.email, "e2e-developer@tartan.invalid");
	equal(jwt.claims.email_verified, false);
	equal(jwt.claims.exp - jwt.claims.iat, LIMITS.idTokenTtlS);
	const jwks = await jsonOf(await h.fetch(`${ISSUER}/jwks`));
	equal(jwks.keys.length, 1);
	equal(jwks.keys[0].kid, jwt.header.kid);
	equal("d" in jwks.keys[0], false);
	const key = await crypto.subtle.importKey(
		"jwk",
		jwks.keys[0],
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["verify"],
	);
	ok(
		await crypto.subtle.verify(
			"RSASSA-PKCS1-v1_5",
			key,
			jwt.signature,
			utf8(jwt.input),
		),
	);
});

Deno.test("a code works once, and a failed attempt spends it too", async () => {
	const h = await createHarness();
	const client = await registerClient(h);
	const { verifier, challenge } = await pkce();
	const code = await codeFor(h, client.clientId, challenge);
	equal(
		(await redeem(h, {
			code,
			client_id: client.clientId,
			code_verifier: verifier,
		}))
			.status,
		200,
	);
	const again = await redeem(h, {
		code,
		client_id: client.clientId,
		code_verifier: verifier,
	});
	equal(again.status, 400);
	equal((await jsonOf(again)).error, "invalid_grant");

	const second = await codeFor(h, client.clientId, challenge);
	const wrong = await redeem(h, {
		code: second,
		client_id: client.clientId,
		code_verifier: "w".repeat(43),
	});
	equal(wrong.status, 400);
	const retry = await redeem(h, {
		code: second,
		client_id: client.clientId,
		code_verifier: verifier,
	});
	equal(retry.status, 400, "a wrong verifier spends the code");
});

Deno.test("a code is bound to its client and redirect URI and lives 60 s", async () => {
	const h = await createHarness();
	const a = await registerClient(h);
	const b = await registerClient(h);
	const { verifier, challenge } = await pkce();
	const code = await codeFor(h, a.clientId, challenge);
	equal(
		(await redeem(h, { code, client_id: b.clientId, code_verifier: verifier }))
			.status,
		400,
	);
	const late = await codeFor(h, a.clientId, challenge);
	h.clock.now += LIMITS.codeTtlMs;
	equal(
		(await redeem(h, {
			code: late,
			client_id: a.clientId,
			code_verifier: verifier,
		}))
			.status,
		400,
	);
	const other = await codeFor(h, a.clientId, challenge);
	equal(
		(await redeem(h, {
			code: other,
			client_id: a.clientId,
			code_verifier: verifier,
			redirect_uri: `${CALLBACK}?x=1`,
		})).status,
		400,
	);
});

Deno.test("the sign-in request id is single use and expires after 5 minutes", async () => {
	const h = await createHarness();
	const client = await registerClient(h);
	const { challenge } = await pkce();
	const html = await (await h.fetch(authorizeUrl(client.clientId, challenge)))
		.text();
	const req = reqOf(html);
	const password = await h.password("e2e-owner");
	equal((await postSignIn(h, req, "e2e-owner", password)).status, 303);
	const replay = await postSignIn(h, req, "e2e-owner", password);
	equal(replay.status, 400);
	equal(replay.headers.get("location"), null);

	const stale = reqOf(
		await (await h.fetch(authorizeUrl(client.clientId, challenge))).text(),
	);
	h.clock.now += LIMITS.requestTtlMs;
	equal((await postSignIn(h, stale, "e2e-owner", password)).status, 400);
});

Deno.test("a wrong password re-renders the form with an alert and a fresh request id", async () => {
	const h = await createHarness();
	const client = await registerClient(h);
	const { challenge } = await pkce();
	const req = reqOf(
		await (await h.fetch(authorizeUrl(client.clientId, challenge))).text(),
	);
	const wrong = await postSignIn(h, req, "e2e-owner", "wrong-password-123");
	equal(wrong.status, 401);
	const html = await wrong.text();
	match(html, new RegExp(`<p role="alert">${WRONG_PASSWORD}</p>`));
	const retry = reqOf(html);
	notEqual(retry, req);
	equal(html.includes("wrong-password-123"), false);
	// The old id is gone; the new one still signs in.
	equal(
		(await postSignIn(h, req, "e2e-owner", await h.password("e2e-owner")))
			.status,
		400,
	);
	equal(
		(await postSignIn(h, retry, "e2e-owner", await h.password("e2e-owner")))
			.status,
		303,
	);
	// An unknown user gets the same answer as a wrong password.
	const req2 = reqOf(
		await (await h.fetch(authorizeUrl(client.clientId, challenge))).text(),
	);
	equal((await postSignIn(h, req2, "nobody", "x".repeat(43))).status, 401);
});

Deno.test("failed sign-ins are rate limited per client address", async () => {
	const h = await createHarness();
	const client = await registerClient(h);
	const { challenge } = await pkce();
	let req = reqOf(
		await (await h.fetch(authorizeUrl(client.clientId, challenge))).text(),
	);
	for (let i = 0; i < LIMITS.signInFailuresPerIp.limit; i++) {
		const response = await postSignIn(
			h,
			req,
			"e2e-owner",
			"nope-nope-nope",
			"198.51.100.7",
		);
		equal(response.status, 401);
		req = reqOf(await response.text());
	}
	const blocked = await postSignIn(
		h,
		req,
		"e2e-owner",
		await h.password("e2e-owner"),
		"198.51.100.7",
	);
	equal(blocked.status, 429);
	// Another address is unaffected.
	equal(
		(await postSignIn(
			h,
			req,
			"e2e-owner",
			await h.password("e2e-owner"),
			"198.51.100.8",
		))
			.status,
		303,
	);
});

Deno.test("redirect URIs are re-checked against the current allow-list at every step", async () => {
	const h = await createHarness();
	const client = await registerClient(h);
	const { verifier, challenge } = await pkce();
	const code = await codeFor(h, client.clientId, challenge);
	const req = reqOf(
		await (await h.fetch(authorizeUrl(client.clientId, challenge))).text(),
	);
	h.env.ALLOWED_REDIRECT_URIS = JSON.stringify([
		"https://tartan-dev-e2e.other.workers.dev/-/auth/callback",
	]);
	equal(
		(await h.fetch(authorizeUrl(client.clientId, challenge))).status,
		400,
	);
	const signIn = await postSignIn(
		h,
		req,
		"e2e-owner",
		await h.password("e2e-owner"),
	);
	equal(signIn.status, 400);
	equal(signIn.headers.get("location"), null);
	equal(
		(await redeem(h, {
			code,
			client_id: client.clientId,
			code_verifier: verifier,
		}))
			.status,
		400,
	);
});

Deno.test("an authorization request for another redirect URI never redirects", async () => {
	const h = await createHarness();
	const client = await registerClient(h);
	const { challenge } = await pkce();
	for (
		const redirect of [
			"https://code.rawkode.academy/-/auth/callback",
			`${CALLBACK}/`,
			`${FORGE}/-/auth/callback?next=/`,
		]
	) {
		const response = await h.fetch(
			authorizeUrl(client.clientId, challenge, { redirect_uri: redirect }),
		);
		equal(response.status, 400, redirect);
		equal(response.headers.get("location"), null);
		match(await response.text(), /role="alert"/);
	}
	const unknown = await h.fetch(
		authorizeUrl("c_00000000000000000000000000", challenge),
	);
	equal(unknown.status, 400);
});

Deno.test("an unusable configuration fails closed everywhere", async () => {
	const h = await createHarness({
		ALLOWED_REDIRECT_URIS: JSON.stringify([
			CALLBACK,
			"https://code.rawkode.academy/-/auth/callback",
		]),
	});
	for (
		const path of [
			"/.well-known/openid-configuration",
			"/jwks",
			"/authorize?client_id=x",
		]
	) {
		const response = await h.fetch(`${ISSUER}${path}`);
		equal(response.status, 500, path);
		equal(response.headers.get("location"), null);
	}
	const register = await h.fetch(`${ISSUER}/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	});
	equal(register.status, 500);
	const health = await jsonOf(await h.fetch(`${ISSUER}/-/health`));
	equal(health.ok, false);
	equal(JSON.stringify(health).includes("rawkode.academy"), false);
});

Deno.test("RFC 7592: the registration token reads and deletes its client only", async () => {
	const h = await createHarness();
	const client = await registerClient(h);
	equal(new URL(client.uri).origin, ISSUER);
	const read = await h.fetch(client.uri, {
		headers: { authorization: `Bearer ${client.token}` },
	});
	equal(read.status, 200);
	const body = await jsonOf(read);
	equal(body.client_id, client.clientId);
	equal("registration_access_token" in body, false);
	equal(
		(await h.fetch(client.uri, {
			method: "DELETE",
			headers: { authorization: `Bearer ${"x".repeat(43)}` },
		})).status,
		401,
	);
	equal(
		(await h.fetch(client.uri, {
			method: "DELETE",
			headers: { authorization: `Bearer ${client.token}` },
		})).status,
		204,
	);
	equal(
		(await h.fetch(client.uri, {
			headers: { authorization: `Bearer ${client.token}` },
		})).status,
		401,
	);
});

Deno.test("registering many clients never evicts one that redeemed a code", async () => {
	const h = await createHarness();
	const used = await registerClient(h, { ip: "203.0.113.1" });
	const { verifier, challenge } = await pkce();
	const code = await codeFor(h, used.clientId, challenge);
	equal(
		(await redeem(h, {
			code,
			client_id: used.clientId,
			code_verifier: verifier,
		}))
			.status,
		200,
	);
	// Twenty registrations from twenty addresses (under each one's rate limit).
	for (let i = 0; i < 20; i++) {
		await registerClient(h, { ip: `203.0.113.${10 + i}` });
	}
	equal(h.store.clients().length, LIMITS.maxClients);
	ok(h.store.client(used.clientId) !== null, "the used client survives");
	equal(
		(await h.fetch(authorizeUrl(used.clientId, challenge))).status,
		200,
	);
});

Deno.test("when every slot holds a client in use, registration is refused", async () => {
	const h = await createHarness();
	for (let i = 0; i < LIMITS.maxClients; i++) {
		const c = await registerClient(h, { ip: `203.0.113.${i + 1}` });
		const { verifier, challenge } = await pkce();
		const code = await codeFor(h, c.clientId, challenge);
		await redeem(h, { code, client_id: c.clientId, code_verifier: verifier });
	}
	const refused = await h.fetch(`${ISSUER}/register`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"cf-connecting-ip": "203.0.113.99",
		},
		body: JSON.stringify({
			redirect_uris: [CALLBACK],
			token_endpoint_auth_method: "none",
		}),
	});
	equal(refused.status, 429);
	// A day later the idle ones can make room again.
	h.clock.now += LIMITS.idleClientMs;
	await registerClient(h, { ip: "203.0.113.100" });
});

Deno.test("registrations are rate limited per client address", async () => {
	const h = await createHarness();
	for (let i = 0; i < LIMITS.registerPerIp.limit; i++) {
		await registerClient(h, { ip: "192.0.2.50" });
	}
	let error: unknown = null;
	try {
		await registerClient(h, { ip: "192.0.2.50" });
	} catch (e) {
		error = e;
	}
	ok(error instanceof Error);
	match(error.message, /429/);
	h.clock.now += LIMITS.registerPerIp.windowMs;
	await registerClient(h, { ip: "192.0.2.50" });
});

Deno.test("logout follows only a redirect to an allowed forge origin", async () => {
	const h = await createHarness();
	const ok303 = await h.fetch(
		`${ISSUER}/logout?post_logout_redirect_uri=${
			encodeURIComponent(`${FORGE}/`)
		}`,
	);
	equal(ok303.status, 303);
	equal(ok303.headers.get("location"), `${FORGE}/`);
	const refused = await h.fetch(
		`${ISSUER}/logout?post_logout_redirect_uri=${
			encodeURIComponent("https://evil.test/")
		}`,
	);
	equal(refused.status, 200);
	match(await refused.text(), /Signed out/);
});

Deno.test("another host name, method or path is refused", async () => {
	const h = await createHarness();
	equal(
		(await h.fetch("https://tartan-e2e--idp.other.workers.dev/jwks")).status,
		404,
	);
	equal((await h.fetch(`${ISSUER}/token`)).status, 405);
	equal((await h.fetch(`${ISSUER}/nope`)).status, 404);
	const notJson = await h.fetch(`${ISSUER}/register`, {
		method: "POST",
		headers: { "content-type": "text/plain" },
		body: "{}",
	});
	equal(notJson.status, 400);
	const big = await h.fetch(`${ISSUER}/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ x: "y".repeat(LIMITS.maxBodyBytes) }),
	});
	equal(big.status, 400);
});
