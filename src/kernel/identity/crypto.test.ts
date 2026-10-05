// WP2 crypto helpers and the keyring: pure Deno tests.

import {
	deepStrictEqual,
	equal,
	notEqual,
	ok,
	rejects,
} from "node:assert/strict";
import { TOKEN_RE } from "@tartan/contract";
import {
	constantTimeEqual,
	fromBase64Url,
	fromHex,
	ipHash,
	randomSecret,
	secretsEqual,
	sha256Hex,
	toBase64Url,
	toHex,
	utf8,
} from "./crypto.ts";
import { createKeyring, generateRootSecret, KEY_LABELS } from "./keyring.ts";

Deno.test("base64url and hex round-trip; sha256Hex matches the NIST vector", async () => {
	const bytes = Uint8Array.from([0, 1, 250, 251, 252, 253, 254, 255]);
	deepStrictEqual(fromBase64Url(toBase64Url(bytes)), bytes);
	equal(toBase64Url(bytes).includes("="), false);
	deepStrictEqual(fromHex(toHex(bytes)), bytes);
	equal(
		await sha256Hex("abc"),
		"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
	);
});

Deno.test("secrets are 256-bit base64url: a token body matches TOKEN_RE", () => {
	const secret = randomSecret();
	equal(secret.length, 43);
	ok(TOKEN_RE.test(`tpat_${secret}`));
	notEqual(randomSecret(), secret);
});

Deno.test("constant-time comparison: equal, different, different length", async () => {
	ok(constantTimeEqual(utf8("same"), utf8("same")));
	equal(constantTimeEqual(utf8("same"), utf8("samf")), false);
	equal(constantTimeEqual(utf8("short"), utf8("longer")), false);
	ok(await secretsEqual("token-value", "token-value"));
	equal(await secretsEqual("token-value", "token-valuf"), false);
	equal(await secretsEqual("a", "a much longer value"), false);
});

Deno.test("the rate-limit key of an address is 16 hex chars and never the address", async () => {
	const hash = await ipHash("203.0.113.9");
	ok(/^[0-9a-f]{16}$/.test(hash));
	notEqual(hash, await ipHash("203.0.113.10"));
});

Deno.test("keyring: seal/open round-trip, bound to (kind, id) by the AAD", async () => {
	const keyring = await createKeyring(generateRootSecret());
	const sealed = await keyring.seal("idp-secret", "default", "s3cret");
	ok(sealed.startsWith(`v1.${keyring.kid}.`));
	equal(sealed.includes("s3cret"), false);
	equal(await keyring.open("idp-secret", "default", sealed), "s3cret");
	await rejects(keyring.open("idp-secret", "other", sealed), /does not open/);
	await rejects(keyring.open("key", "default", sealed), /does not open/);
	await rejects(keyring.open("idp-secret", "default", "v1.zz"), /malformed/);
});

Deno.test("keyring: derivation is deterministic per root; another root cannot open", async () => {
	const root = generateRootSecret();
	const a = await createKeyring(root);
	const b = await createKeyring(root);
	equal(a.kid, b.kid);
	const sealed = await a.seal("k", "1", "value");
	equal(await b.open("k", "1", sealed), "value");
	const other = await createKeyring(generateRootSecret());
	await rejects(other.open("k", "1", sealed), /unknown key/);
});

Deno.test("keyring: rotation opens values sealed under TARTAN_SECRET_PREVIOUS", async () => {
	const oldRoot = generateRootSecret();
	const sealed = await (await createKeyring(oldRoot)).seal("k", "1", "kept");
	const rotated = await createKeyring(generateRootSecret(), oldRoot);
	equal(await rotated.open("k", "1", sealed), "kept");
	ok((await rotated.seal("k", "1", "new")).startsWith(`v1.${rotated.kid}.`));
});

Deno.test("keyring: LANE_CAP_KEY and the web key are non-extractable HMAC keys", async () => {
	const keyring = await createKeyring(generateRootSecret());
	equal(keyring.laneCap.extractable, false);
	equal(keyring.web.extractable, false);
	deepStrictEqual(keyring.laneCap.algorithm.name, "HMAC");
	equal(KEY_LABELS.laneCap, "tartan:lane-cap:v1");
	await rejects(crypto.subtle.exportKey("raw", keyring.laneCap));
	await rejects(createKeyring("short"), /too short/);
});
