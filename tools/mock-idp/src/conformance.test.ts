// Conformance: Tartan's own relying-party code (src/kernel/identity/oidc.ts
// and dcr.ts, read-only here) against the mock IdP, through Tartan's SSRF
// guard. This is the exact sequence the dev-e2e forge runs: discovery with
// the exact issuer match, RFC 7591 registration, the authorization URL, the
// code exchange with PKCE, RFC 9207 `iss`, the nonce, and the ID-token
// signature check against the JWKS (`verify_id_token_signature = 1`), then
// the RFC 7592 delete that `deno task destroy` sends.

import { equal, ok } from "node:assert/strict";
import {
	deregisterClient,
	registerClient as tartanRegister,
	registrationRequest,
} from "../../../src/kernel/identity/dcr.ts";
import {
	authorizationUrl,
	discover,
	exchangeCode,
	pkcePair,
	randomNonce,
	randomState,
} from "../../../src/kernel/identity/oidc.ts";
import { createGuardedFetch } from "../../../src/kernel/identity/ssrf.ts";
import {
	CALLBACK,
	createHarness,
	FORGE,
	ISSUER,
	postSignIn,
	reqOf,
} from "./testing/harness.ts";

Deno.test("Tartan's relying party signs in through the mock IdP", async () => {
	const h = await createHarness();
	const fetchFn = createGuardedFetch(h.fetch);

	const as = await discover(ISSUER, fetchFn);
	equal(as.issuer, ISSUER);
	const client = await tartanRegister(
		as.registration_endpoint as string,
		registrationRequest({
			forgeName: "Tartan e2e",
			redirectUri: `${FORGE}/-/auth/callback`,
			scope: "openid profile email groups",
		}),
		{ fetch: fetchFn, now: h.clock.now },
	);
	equal(client.clientAuth, "none");
	equal(client.idTokenAlg, "RS256");
	ok(client.management !== undefined);

	const state = randomState();
	const nonce = randomNonce();
	const pkce = await pkcePair();
	const url = authorizationUrl(as, {
		clientId: client.clientId,
		redirectUri: CALLBACK,
		scope: "openid profile email groups",
		state,
		nonce,
		codeChallenge: pkce.challenge,
	});
	const page = await h.fetch(url);
	equal(page.status, 200);
	const signIn = await postSignIn(
		h,
		reqOf(await page.text()),
		"e2e-owner",
		await h.password("e2e-owner"),
	);
	equal(signIn.status, 303);
	const callback = new URL(signIn.headers.get("location") ?? "");

	const claims = await exchangeCode({
		as,
		rp: {
			clientId: client.clientId,
			clientAuth: client.clientAuth,
			idTokenAlg: client.idTokenAlg,
		},
		callback,
		redirectUri: CALLBACK,
		state,
		codeVerifier: pkce.verifier,
		nonce,
		verifySignature: true,
		fetch: fetchFn,
	});
	equal(claims.iss, ISSUER);
	equal(claims.sub, "e2e-owner-0001");
	equal(claims.preferred_username, "e2e-owner");
	equal(claims.email_verified, false);

	const removed = await deregisterClient(
		client.management as { token: string; uri: string },
		fetchFn,
	);
	equal(removed.ok, true);
	equal(h.store.client(client.clientId), null);
});

Deno.test("Tartan refuses a callback whose state does not match", async () => {
	const h = await createHarness();
	const fetchFn = createGuardedFetch(h.fetch);
	const as = await discover(ISSUER, fetchFn);
	const client = await tartanRegister(
		as.registration_endpoint as string,
		registrationRequest({
			forgeName: "Tartan e2e",
			redirectUri: CALLBACK,
			scope: "openid",
		}),
		{ fetch: fetchFn, now: h.clock.now },
	);
	const pkce = await pkcePair();
	const nonce = randomNonce();
	const url = authorizationUrl(as, {
		clientId: client.clientId,
		redirectUri: CALLBACK,
		scope: "openid",
		state: randomState(),
		nonce,
		codeChallenge: pkce.challenge,
	});
	const signIn = await postSignIn(
		h,
		reqOf(await (await h.fetch(url)).text()),
		"e2e-owner",
		await h.password("e2e-owner"),
	);
	const callback = new URL(signIn.headers.get("location") ?? "");
	let refused = false;
	try {
		await exchangeCode({
			as,
			rp: {
				clientId: client.clientId,
				clientAuth: "none",
				idTokenAlg: "RS256",
			},
			callback,
			redirectUri: CALLBACK,
			state: randomState(),
			codeVerifier: pkce.verifier,
			nonce,
			verifySignature: true,
			fetch: fetchFn,
		});
	} catch {
		refused = true;
	}
	ok(refused);
});
