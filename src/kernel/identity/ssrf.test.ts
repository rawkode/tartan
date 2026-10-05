// The outbound URL validator and guarded fetch (a DCR request to a private
// address is refused): pure Deno tests.

import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import {
	checkOutboundUrl,
	createGuardedFetch,
	outboundUrlProblem,
} from "./ssrf.ts";

Deno.test("only public https hosts on port 443 pass", () => {
	const refused: Record<string, string> = {
		"http://idp.example.com/": "only https URLs are allowed",
		"https://idp.example.com:8443/": "only port 443 is allowed",
		"https://user:pw@idp.example.com/": "URLs with credentials are not allowed",
		"https://127.0.0.1/register": "IP address literals are not allowed",
		"https://10.0.0.7/register": "IP address literals are not allowed",
		"https://169.254.169.254/latest": "IP address literals are not allowed",
		"https://2130706433/": "IP address literals are not allowed",
		"https://0x7f.1/": "IP address literals are not allowed",
		"https://[::1]/": "IP address literals are not allowed",
		"https://[fd00::1]/register": "IP address literals are not allowed",
		"https://localhost/": "local host names are not allowed",
		"https://api.localhost/": "local host names are not allowed",
		"https://printer.local/": "local host names are not allowed",
		"https://intranet/": "single-label host names are not allowed",
		"not a url": "not a URL",
	};
	for (const [url, problem] of Object.entries(refused)) {
		equal(outboundUrlProblem(url), problem, url);
	}
	equal(
		outboundUrlProblem("https://id.rawkode.academy/auth/oauth2/register"),
		null,
	);
	equal(outboundUrlProblem("https://idp.example.com:443/x"), null);
	equal(checkOutboundUrl("https://idp.test/").hostname, "idp.test");
});

Deno.test("the guarded fetch refuses before any request, never follows redirects, caps bodies", async () => {
	const calls: { url: string; redirect?: string }[] = [];
	const base = (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), redirect: init?.redirect });
		const url = String(input);
		if (url.endsWith("/redirect")) {
			return Promise.resolve(
				new Response(null, {
					status: 302,
					headers: { location: "https://10.0.0.1/" },
				}),
			);
		}
		if (url.endsWith("/big")) {
			return Promise.resolve(new Response("x".repeat(2048)));
		}
		return Promise.resolve(Response.json({ ok: true }));
	};
	const guarded = createGuardedFetch(base, {
		timeoutMs: 1_000,
		maxBytes: 1024,
	});
	await rejects(guarded("https://192.168.1.1/register"), /IP address literals/);
	equal(calls.length, 0);
	const redirected = await guarded("https://idp.test/redirect");
	equal(redirected.status, 302);
	deepStrictEqual(calls.at(-1), {
		url: "https://idp.test/redirect",
		redirect: "manual",
	});
	await rejects(guarded("https://idp.test/big"), /exceeds 1024 bytes/);
	deepStrictEqual(await (await guarded("https://idp.test/ok")).json(), {
		ok: true,
	});
});

Deno.test("the guarded fetch aborts a slow response", async () => {
	const slow = (_input: string | URL | Request, init?: RequestInit) =>
		new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener(
				"abort",
				() => reject(init.signal?.reason),
			);
		});
	const guarded = createGuardedFetch(slow, { timeoutMs: 20, maxBytes: 1024 });
	await rejects(guarded("https://idp.test/slow"));
});
