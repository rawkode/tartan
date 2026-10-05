// The allow-list is the property that keeps every other forge away from the
// mock IdP: only a tartan-dev-e2e workers.dev callback may ever be rendered.

import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import {
	ISSUER_RE,
	loadConfig,
	parseIssuer,
	parseRedirectAllowList,
	REDIRECT_URI_RE,
} from "./config.ts";
import { CALLBACK, createHarness, ISSUER } from "./testing/harness.ts";

const list = (...uris: unknown[]) => JSON.stringify(uris);

Deno.test("the allow-list accepts the dev-e2e workers.dev callback", () => {
	const parsed = parseRedirectAllowList(list(CALLBACK));
	ok(parsed.ok);
	deepStrictEqual(parsed.value, [CALLBACK]);
});

Deno.test("the allow-list refuses the production forge's callback", () => {
	const parsed = parseRedirectAllowList(
		list("https://code.rawkode.academy/-/auth/callback"),
	);
	equal(parsed.ok, false);
	// One bad entry poisons the whole list (fail closed).
	equal(
		parseRedirectAllowList(
			list(CALLBACK, "https://code.rawkode.academy/-/auth/callback"),
		).ok,
		false,
	);
});

Deno.test("the allow-list refuses every other shape", () => {
	for (
		const uri of [
			"https://tartan-dev-demo.acme.workers.dev/-/auth/callback",
			"https://tartan-dev.acme.workers.dev/-/auth/callback",
			"https://tartan-dev-e2e-x.acme.workers.dev/-/auth/callback",
			"http://tartan-dev-e2e.acme.workers.dev/-/auth/callback",
			"https://tartan-dev-e2e.acme.workers.dev/-/auth/callback/",
			"https://tartan-dev-e2e.acme.workers.dev/-/auth/callback?x=1",
			"https://tartan-dev-e2e.acme.workers.dev:8443/-/auth/callback",
			"https://tartan-dev-e2e.acme.workers.dev.evil.test/-/auth/callback",
			"https://user@tartan-dev-e2e.acme.workers.dev/-/auth/callback",
			"https://localhost/-/auth/callback",
			"https://127.0.0.1/-/auth/callback",
			"https://TARTAN-DEV-E2E.acme.workers.dev/-/auth/callback",
		]
	) {
		equal(REDIRECT_URI_RE.test(uri), false, uri);
		equal(parseRedirectAllowList(list(uri)).ok, false, uri);
	}
});

Deno.test("the allow-list must be a short, non-empty JSON array of strings", () => {
	for (
		const raw of [
			undefined,
			"",
			"not json",
			"{}",
			"[]",
			JSON.stringify(CALLBACK),
			list(42),
			list(CALLBACK, CALLBACK, CALLBACK, CALLBACK, CALLBACK),
		]
	) {
		equal(parseRedirectAllowList(raw).ok, false, String(raw));
	}
});

Deno.test("the issuer must be the tartan-e2e--idp workers.dev origin", () => {
	ok(parseIssuer(ISSUER).ok);
	for (
		const issuer of [
			`${ISSUER}/`,
			"https://tartan-e2e-idp.acme.workers.dev",
			"https://id.rawkode.academy",
			"http://tartan-e2e--idp.acme.workers.dev",
			undefined,
		]
	) {
		equal(parseIssuer(issuer).ok, false, String(issuer));
	}
	ok(ISSUER_RE.test("https://tartan-e2e--idp.acme.workers.dev"));
});

Deno.test("loadConfig names the first missing piece without echoing values", async () => {
	const h = await createHarness();
	ok(loadConfig(h.env).ok);
	const noSeed = loadConfig({ ...h.env, E2E_IDP_SEED: "short" });
	equal(noSeed.ok, false);
	if (!noSeed.ok) match(noSeed.reason, /E2E_IDP_SEED/);
	const publicKey = loadConfig({
		...h.env,
		E2E_IDP_SIGNING_JWK: JSON.stringify({ kty: "RSA", n: "x", e: "AQAB" }),
	});
	equal(publicKey.ok, false);
	const badList = loadConfig({
		...h.env,
		ALLOWED_REDIRECT_URIS: list("https://code.rawkode.academy/-/auth/callback"),
	});
	equal(badList.ok, false);
	if (!badList.ok) equal(badList.reason.includes("rawkode.academy"), false);
});
