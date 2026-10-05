// Canonical host rules: pure Deno tests.

import { deepStrictEqual } from "node:assert/strict";
import { decideHost } from "./host.ts";

const CANON = "https://code.example.com";
const other = new URL("https://tartan-dev.acct.workers.dev/acme?tab=1");
const same = new URL(`${CANON}/acme`);

Deno.test("before canonical_origin is set, every host is served", () => {
	for (const host of ["redirect", "forbid", "any"] as const) {
		deepStrictEqual(
			decideHost(other, { host, setupExempt: false }, null, false),
			{ kind: "serve" },
		);
	}
});

Deno.test("on the canonical host everything is served", () => {
	for (const host of ["redirect", "forbid", "any"] as const) {
		deepStrictEqual(
			decideHost(same, { host, setupExempt: false }, CANON, true),
			{ kind: "serve" },
		);
	}
});

Deno.test("another host: 308 for pages and API, 403 for git/MCP/capability, served for health", () => {
	deepStrictEqual(
		decideHost(other, { host: "redirect", setupExempt: false }, CANON, true),
		{
			kind: "redirect",
			location: `${CANON}/acme?tab=1`,
		},
	);
	deepStrictEqual(
		decideHost(other, { host: "forbid", setupExempt: false }, CANON, true),
		{
			kind: "forbid",
		},
	);
	deepStrictEqual(
		decideHost(other, { host: "any", setupExempt: true }, CANON, true),
		{
			kind: "serve",
		},
	);
});

Deno.test("setup-exempt routes stay on the old host until setup is done", () => {
	deepStrictEqual(
		decideHost(other, { host: "redirect", setupExempt: true }, CANON, false),
		{
			kind: "serve",
		},
	);
	deepStrictEqual(
		decideHost(other, { host: "redirect", setupExempt: true }, CANON, true)
			.kind,
		"redirect",
	);
	deepStrictEqual(
		decideHost(other, { host: "redirect", setupExempt: false }, CANON, false)
			.kind,
		"redirect",
	);
});
