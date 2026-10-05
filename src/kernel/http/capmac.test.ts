// The capability URL MAC: every path segment is covered,
// verification never throws for bad input, and the key never leaves
// WebCrypto. Pure Deno tests.

import { equal, match, ok, rejects } from "node:assert/strict";
import { type CapFields, capPath, parseCapPath } from "@tartan/contract";
import { createKeyring, generateRootSecret } from "../identity/keyring.ts";
import { capMacOf } from "./capmac.ts";

const FIELDS: CapFields = {
	exp: 1_800_000_120,
	laneId: "ln_01k6aaaaaaaaaaaaaaaaaaaaaa",
	nonce: "0123456789abcdef0123456789abcdef",
	repoId: "01k6bbbbbbbbbbbbbbbbbbbbbb",
};

const macWith = async (root = generateRootSecret()) => {
	const keyring = await createKeyring(root);
	return capMacOf(() => Promise.resolve(keyring.laneCap));
};

Deno.test("sign gives 64 hex chars that verify and build a parseable capability path", async () => {
	const mac = await macWith();
	const sig = await mac.sign(FIELDS);
	match(sig, /^[0-9a-f]{64}$/);
	ok(await mac.verify(FIELDS, sig));
	const parsed = parseCapPath(
		`${capPath({ ...FIELDS, mac: sig })}/git-upload-pack`,
	);
	ok(parsed !== null && await mac.verify(parsed, parsed.mac));
});

Deno.test("changing any one segment breaks the MAC", async () => {
	const mac = await macWith();
	const sig = await mac.sign(FIELDS);
	for (
		const changed of [
			{ ...FIELDS, exp: FIELDS.exp + 1 },
			{ ...FIELDS, laneId: "ln_01k6aaaaaaaaaaaaaaaaaaaaab" },
			{ ...FIELDS, nonce: "1123456789abcdef0123456789abcdef" },
			{ ...FIELDS, repoId: "01k6bbbbbbbbbbbbbbbbbbbbbc" },
		]
	) {
		equal(await mac.verify(changed, sig), false, JSON.stringify(changed));
	}
});

Deno.test("verify is false (never a throw) for malformed, wrong-length or foreign MACs and fields", async () => {
	const mac = await macWith();
	const sig = await mac.sign(FIELDS);
	for (
		const bad of [
			"",
			sig.slice(1),
			`${sig}0`,
			sig.toUpperCase(),
			"z".repeat(64),
		]
	) {
		equal(await mac.verify(FIELDS, bad), false, bad);
	}
	equal(await mac.verify({ ...FIELDS, laneId: "LN_X" }, sig), false);
	equal(await mac.verify({ ...FIELDS, exp: 12 }, sig), false);
	equal(await mac.verify(FIELDS, 42 as unknown as string), false);
	equal(
		await (await macWith()).verify(FIELDS, sig),
		false,
		"another forge's key",
	);
	await rejects(mac.sign({ ...FIELDS, nonce: "short" }), /invalid/);
});

Deno.test("the same root gives the same MAC in every isolate", async () => {
	const root = generateRootSecret();
	equal(
		await (await macWith(root)).sign(FIELDS),
		await (await macWith(root)).sign(FIELDS),
	);
});
