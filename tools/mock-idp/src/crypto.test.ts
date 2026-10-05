// PKCE, password derivation and RS256 signing of the e2e mock IdP.

import { equal, notEqual, ok, rejects } from "node:assert/strict";
import { b64url, constantTimeEqual, fromB64url, utf8 } from "./encoding.ts";
import { importSigningKey, kidOf, signJwt, thumbprint } from "./jwt.ts";
import { derivePassword, isSeed } from "./password.ts";
import { isChallenge, isVerifier, s256, verifyPkce } from "./pkce.ts";
import { newSeed, testJwk } from "./testing/harness.ts";

Deno.test("S256 matches the RFC 7636 appendix B vector", async () => {
	const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
	const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
	equal(await s256(verifier), challenge);
	ok(await verifyPkce(verifier, challenge));
	equal(await verifyPkce(`${verifier}x`, challenge), false);
});

Deno.test("PKCE formats are checked before hashing", async () => {
	const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
	equal(isChallenge(challenge), true);
	equal(isChallenge(challenge.slice(1)), false);
	equal(isChallenge(`${challenge}A`), false);
	equal(isChallenge(challenge.replace("-", "+")), false);
	equal(isVerifier("a".repeat(42)), false);
	equal(isVerifier("a".repeat(43)), true);
	equal(isVerifier("a".repeat(128)), true);
	equal(isVerifier("a".repeat(129)), false);
	equal(isVerifier(`${"a".repeat(42)} `), false);
	// A short verifier is refused even if its hash were to match.
	equal(await verifyPkce("short", await s256("short")), false);
});

Deno.test("passwords are derived, 43 characters, per user and per seed", async () => {
	const seed = newSeed();
	ok(isSeed(seed));
	const owner = await derivePassword(seed, "e2e-owner");
	equal(owner.length, 43);
	equal(owner, await derivePassword(seed, "e2e-owner"));
	notEqual(owner, await derivePassword(seed, "e2e-developer"));
	notEqual(owner, await derivePassword(newSeed(), "e2e-owner"));
	await rejects(derivePassword("not-a-seed", "e2e-owner"));
});

Deno.test("the JWK thumbprint matches the RFC 7638 example", async () => {
	const n =
		"0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw";
	equal(
		await thumbprint({ n, e: "AQAB" }),
		"NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs",
	);
	equal(await kidOf({ n, e: "AQAB" }), "e2e-NzbLsXh8uDCcd-6M");
});

Deno.test("an RS256 token verifies with the published public key", async () => {
	const jwk = await testJwk();
	const key = await importSigningKey(jwk);
	equal(key.kid, jwk.kid);
	equal(key.publicJwk.alg, "RS256");
	equal("d" in key.publicJwk, false);
	const token = await signJwt(key, { sub: "e2e-owner-0001" });
	const [header, payload, signature] = token.split(".");
	const parsedHeader = JSON.parse(new TextDecoder().decode(fromB64url(header)));
	equal(parsedHeader.alg, "RS256");
	equal(parsedHeader.kid, key.kid);
	const verifier = await crypto.subtle.importKey(
		"jwk",
		key.publicJwk,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["verify"],
	);
	ok(
		await crypto.subtle.verify(
			"RSASSA-PKCS1-v1_5",
			verifier,
			fromB64url(signature),
			utf8(`${header}.${payload}`),
		),
	);
});

Deno.test("base64url and constant-time helpers round-trip", () => {
	const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
	equal(b64url(fromB64url(b64url(bytes))), b64url(bytes));
	ok(constantTimeEqual(utf8("abc"), utf8("abc")));
	equal(constantTimeEqual(utf8("abc"), utf8("abd")), false);
	equal(constantTimeEqual(utf8("abc"), utf8("abcd")), false);
});
