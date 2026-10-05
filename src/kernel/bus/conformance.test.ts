// The K2 conformance suite on FakeK2 (WP26; the same scenarios run live
// through `/-/dev/k2/conformance`), and the dev route's key check.

import { equal, ok } from "node:assert/strict";
import { createFakeK2 } from "@tartan/testkit/k2/fake.ts";
import { createK2Client } from "./client.ts";
import { CONFORMANCE_SCENARIOS, runConformance } from "./conformance.ts";
import { devK2Allowed, devK2Key } from "./dev.ts";

Deno.test("conformance: every scenario passes on FakeK2 and cleans up its subscription", async () => {
	const k2 = createFakeK2();
	k2.produce([{ content: new TextEncoder().encode("other forge traffic") }]);
	const results = await runConformance({
		producer: k2.producer,
		client: createK2Client({
			endpoint: k2.endpoint,
			token: () => Promise.resolve(k2.token),
			fetch: k2.fetch,
		}),
		prefix: "conformance-test",
		sleep: () => Promise.resolve(),
	});
	equal(results.length, Object.keys(CONFORMANCE_SCENARIOS).length);
	for (const r of results) ok(r.ok, `${r.name}: ${r.detail}`);
	equal(k2.subscriptions().length, 0);
});

Deno.test("conformance: a failing target is reported per scenario, never thrown", async () => {
	const k2 = createFakeK2();
	k2.sendFault(
		...Array.from(
			{ length: 50 },
			() => ({ kind: "error" as const, code: 10400 }),
		),
	);
	const results = await runConformance({
		producer: k2.producer,
		client: createK2Client({
			endpoint: k2.endpoint,
			token: () => Promise.resolve(k2.token),
			fetch: k2.fetch,
		}),
		prefix: "conformance-test",
		sleep: () => Promise.resolve(),
		maxPolls: 2,
	}, ["produce-ack", "latest-sees-only-new", "nope"]);
	equal(results.filter((r) => r.ok).length, 0);
	ok(
		results[0].detail?.includes("10400") ||
			results[0].detail?.includes("success"),
	);
	equal(results[2].detail, "unknown scenario");
});

Deno.test("dev k2 routes: only a dev stage with dev tools and the right key", async () => {
	const secret = "s".repeat(43);
	const key = await devK2Key(secret);
	const req = (k?: string) =>
		new Request("https://x.test/-/dev/k2/status", {
			headers: k === undefined ? {} : { "x-tartan-dev-key": k },
		});
	const dev = {
		TARTAN_STAGE: "dev-wp26",
		TARTAN_DEV_TOOLS: "1",
		TARTAN_SECRET: secret,
	};
	equal(await devK2Allowed(req(key), dev), true);
	equal(await devK2Allowed(req("0".repeat(64)), dev), false);
	equal(await devK2Allowed(req(), dev), false);
	equal(await devK2Allowed(req(key), { ...dev, TARTAN_DEV_TOOLS: "0" }), false);
	equal(await devK2Allowed(req(key), { ...dev, TARTAN_STAGE: "prod" }), false);
	equal(
		await devK2Allowed(req(key), { ...dev, TARTAN_SECRET: undefined }),
		false,
	);
});
