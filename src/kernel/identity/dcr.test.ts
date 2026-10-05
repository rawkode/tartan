// RFC 7591/7592 response handling: Tartan stores
// what the registration RESPONSE says. Pure Deno tests.

import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import {
	deregisterClient,
	parseRegistration,
	registerClient,
	registrationRequest,
} from "./dcr.ts";

const ENDPOINT = "https://id.example.com/auth/oauth2/register";
const NOW = 1_800_000_000_000;

Deno.test("a public client (none, no secret) is stored as none", () => {
	deepStrictEqual(
		parseRegistration(
			{ client_id: "abc", token_endpoint_auth_method: "none" },
			ENDPOINT,
			NOW,
		),
		{ ok: true, clientId: "abc", clientAuth: "none", idTokenAlg: "RS256" },
	);
});

Deno.test("client_secret_basic with a secret is stored with that method and the secret", () => {
	const r = parseRegistration(
		{
			client_id: "abc",
			client_secret: "shh",
			token_endpoint_auth_method: "client_secret_basic",
		},
		ENDPOINT,
		NOW,
	);
	deepStrictEqual(r, {
		ok: true,
		clientId: "abc",
		clientAuth: "client_secret_basic",
		idTokenAlg: "RS256",
		clientSecret: "shh",
	});
});

Deno.test("private_key_jwt, an unknown method, a secret with none, or no secret fall back to manual entry", () => {
	for (
		const body of [
			{ client_id: "a", token_endpoint_auth_method: "private_key_jwt" },
			{ client_id: "a", token_endpoint_auth_method: "tls_client_auth" },
			{
				client_id: "a",
				token_endpoint_auth_method: "none",
				client_secret: "x",
			},
			{ client_id: "a", token_endpoint_auth_method: "client_secret_post" },
			{ token_endpoint_auth_method: "none" },
			["not", "an", "object"],
		]
	) {
		equal(
			parseRegistration(body, ENDPOINT, NOW).ok,
			false,
			JSON.stringify(body),
		);
	}
});

Deno.test("the returned id_token_signed_response_alg is stored (EdDSA); an unknown one is refused", () => {
	const r = parseRegistration(
		{
			client_id: "a",
			token_endpoint_auth_method: "none",
			id_token_signed_response_alg: "EdDSA",
		},
		ENDPOINT,
		NOW,
	);
	ok(r.ok && r.idTokenAlg === "EdDSA");
	equal(
		parseRegistration(
			{
				client_id: "a",
				token_endpoint_auth_method: "none",
				id_token_signed_response_alg: "HS256",
			},
			ENDPOINT,
			NOW,
		).ok,
		false,
	);
});

Deno.test("registration_client_uri on another origin refuses the registration; same origin is kept", () => {
	const other = parseRegistration(
		{
			client_id: "a",
			token_endpoint_auth_method: "none",
			registration_access_token: "rat",
			registration_client_uri: "https://evil.example.net/register/a",
		},
		ENDPOINT,
		NOW,
	);
	equal(other.ok, false);
	ok(!other.ok && /origin/.test(other.reason));
	const same = parseRegistration(
		{
			client_id: "a",
			token_endpoint_auth_method: "none",
			registration_access_token: "rat",
			registration_client_uri: "https://id.example.com/auth/oauth2/register/a",
		},
		ENDPOINT,
		NOW,
	);
	ok(same.ok);
	deepStrictEqual(same.ok && same.management, {
		token: "rat",
		uri: "https://id.example.com/auth/oauth2/register/a",
	});
	equal(
		parseRegistration(
			{
				client_id: "a",
				token_endpoint_auth_method: "none",
				registration_client_uri: "https://10.1.1.1/register/a",
			},
			"https://10.1.1.1/register",
			NOW,
		).ok,
		false,
	);
});

Deno.test("an omitted method means none without a secret, client_secret_basic with one; expired secrets are refused", () => {
	const none = parseRegistration({ client_id: "a" }, ENDPOINT, NOW);
	ok(none.ok && none.clientAuth === "none");
	const basic = parseRegistration(
		{ client_id: "a", client_secret: "s" },
		ENDPOINT,
		NOW,
	);
	ok(basic.ok && basic.clientAuth === "client_secret_basic");
	equal(
		parseRegistration(
			{
				client_id: "a",
				client_secret: "s",
				token_endpoint_auth_method: "client_secret_post",
				client_secret_expires_at: NOW / 1000 - 1,
			},
			ENDPOINT,
			NOW,
		).ok,
		false,
	);
});

Deno.test("the registration request asks for a public PKCE client with RS256 ID tokens", async () => {
	const request = registrationRequest({
		forgeName: "Rawkode",
		redirectUri: "https://code.example.com/-/auth/callback",
		scope: "openid profile email groups",
	});
	deepStrictEqual(request, {
		client_name: "Tartan (Rawkode)",
		redirect_uris: ["https://code.example.com/-/auth/callback"],
		grant_types: ["authorization_code"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
		id_token_signed_response_alg: "RS256",
		scope: "openid profile email groups",
	});
	const seen: { init?: RequestInit }[] = [];
	const fetchFn = (_input: string | URL | Request, init?: RequestInit) => {
		seen.push({ init });
		return Promise.resolve(
			Response.json({ client_id: "c1", token_endpoint_auth_method: "none" }, {
				status: 201,
			}),
		);
	};
	const client = await registerClient(ENDPOINT, request, {
		fetch: fetchFn,
		now: NOW,
		initialAccessToken: "iat-123",
	});
	equal(client.clientId, "c1");
	const headers = new Headers(seen[0].init?.headers);
	equal(headers.get("authorization"), "Bearer iat-123");
	equal(
		JSON.parse(String(seen[0].init?.body)).token_endpoint_auth_method,
		"none",
	);
});

Deno.test("a refusing or failing registration endpoint is `unavailable` (the wizard falls back)", async () => {
	const request = registrationRequest({
		forgeName: "x",
		redirectUri: "https://f.example/-/auth/callback",
		scope: "openid",
	});
	await rejects(
		registerClient(ENDPOINT, request, {
			fetch: () =>
				Promise.resolve(
					Response.json({ error: "invalid_client_metadata" }, { status: 400 }),
				),
			now: NOW,
		}),
		/unavailable\(?.*refused \(HTTP 400\)/,
	);
	await rejects(
		registerClient(ENDPOINT, request, {
			fetch: () => Promise.reject(new TypeError("network down")),
			now: NOW,
		}),
		/unavailable.*network down/,
	);
	await rejects(
		registerClient(ENDPOINT, request, {
			fetch: () =>
				Promise.resolve(
					Response.json({
						client_id: "c",
						token_endpoint_auth_method: "private_key_jwt",
					}, { status: 201 }),
				),
			now: NOW,
		}),
		/unavailable\(dcr\)/,
	);
});

Deno.test("RFC 7592 delete sends the registration access token as Bearer", async () => {
	const seen: { url: string; init?: RequestInit }[] = [];
	const outcome = await deregisterClient(
		{ token: "rat", uri: "https://id.example.com/register/a" },
		(input, init) => {
			seen.push({ url: String(input), init });
			return Promise.resolve(new Response(null, { status: 204 }));
		},
	);
	deepStrictEqual(outcome, { ok: true });
	equal(seen[0].init?.method, "DELETE");
	equal(new Headers(seen[0].init?.headers).get("authorization"), "Bearer rat");
	const refused = await deregisterClient(
		{ token: "rat", uri: "https://id.example.com/register/a" },
		() => Promise.resolve(new Response(null, { status: 401 })),
	);
	deepStrictEqual(refused, { ok: false, reason: "the IdP answered HTTP 401" });
});
