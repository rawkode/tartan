// CSRF (same-origin only) and credential parsing: pure Deno
// tests. Cross-site, same-site and none are rejected;
// same-origin and an exact Origin are accepted.

import { doesNotThrow, equal, throws } from "node:assert/strict";
import { credentialOf, requireSameOrigin } from "./auth.ts";
import { checkCsrf } from "./middleware.ts";

const ORIGIN = "https://code.example.com";

const post = (headers: Record<string, string>) =>
	new Request(`${ORIGIN}/-/api/tokens`, { method: "POST", headers });

Deno.test("CSRF matrix: Sec-Fetch-Site same-origin passes; same-site, cross-site and none fail", () => {
	doesNotThrow(() =>
		requireSameOrigin(post({ "sec-fetch-site": "same-origin" }), ORIGIN)
	);
	for (const site of ["same-site", "cross-site", "none"]) {
		throws(
			() =>
				requireSameOrigin(
					post({ "sec-fetch-site": site, origin: ORIGIN }),
					ORIGIN,
				),
			(e: Error) => /denied\(csrf\)/.test(e.message),
			site,
		);
	}
});

Deno.test("CSRF matrix without Sec-Fetch-Site: only the exact canonical Origin passes", () => {
	doesNotThrow(() => requireSameOrigin(post({ origin: ORIGIN }), ORIGIN));
	for (
		const origin of [
			"https://evil.example.net",
			"https://sub.code.example.com",
			"http://code.example.com",
			"https://code.example.com:8443",
			`${ORIGIN}/`,
			"null",
		]
	) {
		throws(
			() => requireSameOrigin(post({ origin }), ORIGIN),
			/denied\(csrf\)/,
			origin,
		);
	}
	throws(() => requireSameOrigin(post({}), ORIGIN), /no Origin/);
});

Deno.test("CSRF: a body must be JSON; a WebSocket upgrade needs the exact Origin", () => {
	const json = (type: string) =>
		new Request(`${ORIGIN}/-/api/tokens`, {
			method: "POST",
			headers: { "sec-fetch-site": "same-origin", "content-type": type },
			body: "{}",
		});
	doesNotThrow(() => checkCsrf(json("application/json"), ORIGIN));
	doesNotThrow(() =>
		checkCsrf(json("application/json; charset=utf-8"), ORIGIN)
	);
	for (
		const type of [
			"text/plain",
			"application/x-www-form-urlencoded",
			"multipart/form-data",
		]
	) {
		throws(() => checkCsrf(json(type), ORIGIN), /application\/json/, type);
	}
	const upgrade = (headers: Record<string, string>) =>
		new Request(`${ORIGIN}/-/live`, {
			headers: { upgrade: "websocket", ...headers },
		});
	doesNotThrow(() => checkCsrf(upgrade({ origin: ORIGIN }), ORIGIN));
	throws(
		() => checkCsrf(upgrade({ "sec-fetch-site": "same-origin" }), ORIGIN),
		/exact Origin/,
	);
	throws(
		() => checkCsrf(upgrade({ origin: "https://evil.example.net" }), ORIGIN),
		/csrf/,
	);
});

Deno.test("Authorization: Bearer, or Basic with the token as the password; other schemes are not credentials", () => {
	const token = `tagt_${"a".repeat(43)}`;
	equal(credentialOf(`Bearer ${token}`), token);
	equal(credentialOf(`bearer ${token}`), token);
	equal(credentialOf(`Basic ${btoa(`agent:${token}`)}`), token);
	equal(credentialOf(`Basic ${btoa(`:${token}`)}`), token);
	equal(credentialOf("Basic !!!notbase64"), null);
	equal(credentialOf(`Basic ${btoa("no-colon")}`), null);
	equal(credentialOf("Digest abc"), null);
	equal(credentialOf("Bearer"), null);
});
