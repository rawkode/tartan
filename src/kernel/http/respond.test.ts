// `return_to` open-redirect checks (WP2) and the HTML
// error page: pure Deno tests.

import { equal, ok } from "node:assert/strict";
import { errorPage, safeReturnTo } from "./respond.ts";

Deno.test("return_to keeps same-origin paths", () => {
	equal(safeReturnTo("/acme"), "/acme");
	equal(
		safeReturnTo("/acme/platform/-/changes/zkqv?tab=files#L3"),
		"/acme/platform/-/changes/zkqv?tab=files#L3",
	);
	equal(safeReturnTo("/a/../b"), "/b");
	equal(safeReturnTo(null), "/");
	equal(safeReturnTo(""), "/");
});

Deno.test("return_to refuses every way off the forge", () => {
	for (
		const evil of [
			"https://evil.example.net/",
			"//evil.example.net/",
			"///evil.example.net/",
			"/\\evil.example.net/",
			"\\\\evil.example.net",
			"/%5Cevil.example.net",
			"javascript:alert(1)",
			"evil.example.net",
			"/\tevil",
			"/\nhttps://evil",
			`/${"a".repeat(3000)}`,
		]
	) {
		const out = safeReturnTo(evil);
		ok(out === "/" || (out.startsWith("/") && !out.startsWith("//")), evil);
		equal(
			new URL(out, "https://forge.example").origin,
			"https://forge.example",
			evil,
		);
	}
	equal(safeReturnTo("//evil.example.net/"), "/");
	equal(safeReturnTo("/\\evil.example.net/"), "/");
});

Deno.test("the error page escapes its text", async () => {
	const page = errorPage(400, "Sign-in <failed>", `bad "state" & <script>`);
	equal(page.status, 400);
	equal(page.headers.get("content-type"), "text/html; charset=utf-8");
	const html = await page.text();
	ok(html.includes("Sign-in &lt;failed&gt;"));
	ok(html.includes("bad &quot;state&quot; &amp; &lt;script&gt;"));
	equal(html.includes("<script>"), false);
});

Deno.test("return_to refuses paths that normalize to a scheme-relative URL", () => {
	for (
		const evil of [
			"/..//evil.com",
			"/.//evil.com",
			"/%2e%2e//evil.com",
			"/%2E%2E//evil.com",
			"/x/../..//evil.com/p?q",
			"/./%2e//evil.com",
		]
	) {
		equal(safeReturnTo(evil), "/", evil);
	}
	equal(safeReturnTo("/x/../y//z"), "/y//z", "an inner // stays a path");
});
