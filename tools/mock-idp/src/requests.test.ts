// Request validation rules of the e2e mock IdP (pure).

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { loadConfig } from "./config.ts";
import {
	parseAuthorization,
	parseRegistration,
	parseTokenRequest,
} from "./requests.ts";
import { CALLBACK, createHarness } from "./testing/harness.ts";

const config = async () => {
	const checked = loadConfig((await createHarness()).env);
	if (!checked.ok) throw new Error(checked.reason);
	return checked.value;
};

/** Exactly what `registrationRequest` in src/kernel/identity/dcr.ts sends. */
const tartanBody = (redirect = CALLBACK) => ({
	client_name: "Tartan (Tartan e2e)",
	redirect_uris: [redirect],
	grant_types: ["authorization_code"],
	response_types: ["code"],
	token_endpoint_auth_method: "none",
	id_token_signed_response_alg: "RS256",
	scope: "openid profile email groups",
});

Deno.test("registration accepts Tartan's DCR body as it is", async () => {
	const parsed = parseRegistration(tartanBody(), await config());
	ok(parsed.ok);
	deepStrictEqual(parsed.value, {
		redirectUri: CALLBACK,
		clientName: "Tartan (Tartan e2e)",
	});
});

Deno.test("registration refuses URL-bearing metadata it would fetch or show", async () => {
	const c = await config();
	for (
		const field of [
			"jwks_uri",
			"jwks",
			"sector_identifier_uri",
			"request_uris",
			"logo_uri",
			"client_uri",
			"policy_uri",
			"tos_uri",
			"initiate_login_uri",
			"backchannel_logout_uri",
		]
	) {
		const parsed = parseRegistration(
			{ ...tartanBody(), [field]: "https://evil.test/x" },
			c,
		);
		equal(parsed.ok, false, field);
		if (!parsed.ok) equal(parsed.error, "invalid_client_metadata");
	}
	// Unknown non-URL metadata is ignored (RFC 7591 §2).
	ok(parseRegistration({ ...tartanBody(), software_id: "x" }, c).ok);
});

Deno.test("registration accepts only a public PKCE client on the allow-list", async () => {
	const c = await config();
	const refused = (body: Record<string, unknown>, error: string) => {
		const parsed = parseRegistration(body, c);
		equal(parsed.ok, false, JSON.stringify(body));
		if (!parsed.ok) equal(parsed.error, error);
	};
	refused(
		{ ...tartanBody(), token_endpoint_auth_method: "client_secret_basic" },
		"invalid_client_metadata",
	);
	const { token_endpoint_auth_method: _, ...noMethod } = tartanBody();
	refused(noMethod, "invalid_client_metadata");
	refused(
		{ ...tartanBody(), grant_types: ["authorization_code", "refresh_token"] },
		"invalid_client_metadata",
	);
	refused(
		{ ...tartanBody(), response_types: ["code", "id_token"] },
		"invalid_client_metadata",
	);
	refused(
		{ ...tartanBody(), id_token_signed_response_alg: "none" },
		"invalid_client_metadata",
	);
	refused(
		tartanBody("https://code.rawkode.academy/-/auth/callback"),
		"invalid_redirect_uri",
	);
	refused(
		{ ...tartanBody(), redirect_uris: [CALLBACK, CALLBACK] },
		"invalid_redirect_uri",
	);
	refused({ ...tartanBody(), redirect_uris: [] }, "invalid_redirect_uri");
	refused(
		{ ...tartanBody(), client_name: "x".repeat(201) },
		"invalid_client_metadata",
	);
	equal(parseRegistration([], c).ok, false);
	equal(parseRegistration(null, c).ok, false);
});

const authorization = (extra: Record<string, string | null> = {}) => {
	const params = new URLSearchParams({
		response_type: "code",
		client_id: "c_0123456789abcdef0123456789",
		redirect_uri: CALLBACK,
		scope: "openid profile email groups",
		state: "s".repeat(43),
		nonce: "n".repeat(43),
		code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
		code_challenge_method: "S256",
	});
	for (const [k, v] of Object.entries(extra)) {
		if (v === null) params.delete(k);
		else params.set(k, v);
	}
	return params;
};

Deno.test("an authorization request needs code, openid, state, nonce and S256", () => {
	ok(parseAuthorization(authorization()).ok);
	const cases: Record<string, string | null>[] = [
		{ response_type: "token" },
		{ scope: "profile email" },
		{ state: null },
		{ state: "" },
		{ state: "s".repeat(513) },
		{ nonce: null },
		{ nonce: "n".repeat(513) },
		{ code_challenge_method: "plain" },
		{ code_challenge_method: null },
		{ code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-c" },
		{ code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cMx" },
		{ client_id: null },
		{ redirect_uri: null },
		{ request: "eyJ" },
		{ request_uri: "https://evil.test/r" },
	];
	for (const extra of cases) {
		equal(
			parseAuthorization(authorization(extra)).ok,
			false,
			JSON.stringify(extra),
		);
	}
	equal(parseAuthorization(authorization({ state: "s".repeat(512) })).ok, true);
});

Deno.test("an authorization request may not repeat a parameter", () => {
	const params = authorization();
	params.append("redirect_uri", "https://evil.test/cb");
	equal(parseAuthorization(params).ok, false);
});

Deno.test("the token request is a public client's authorization_code grant", () => {
	const form = (extra: Record<string, string> = {}) =>
		new URLSearchParams({
			grant_type: "authorization_code",
			code: "c".repeat(43),
			redirect_uri: CALLBACK,
			client_id: "c_0123456789abcdef0123456789",
			code_verifier: "v".repeat(43),
			...extra,
		});
	ok(parseTokenRequest(form(), null).ok);
	equal(parseTokenRequest(form(), "Basic eDp5").ok, false);
	equal(parseTokenRequest(form({ client_secret: "x" }), null).ok, false);
	equal(
		parseTokenRequest(form({ grant_type: "refresh_token" }), null).ok,
		false,
	);
	equal(parseTokenRequest(form({ code: "short" }), null).ok, false);
	const twice = form();
	twice.append("code", "d".repeat(43));
	equal(parseTokenRequest(twice, null).ok, false);
	const missing = form();
	missing.delete("code_verifier");
	equal(parseTokenRequest(missing, null).ok, false);
});
