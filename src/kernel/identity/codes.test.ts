// Claim codes and handles: pure Deno tests.

import { equal, notEqual, ok } from "node:assert/strict";
import {
	CLAIM_CODE_WORDS,
	generateClaimCode,
	handleFrom,
	normalizeSetupInput,
} from "./codes.ts";

Deno.test("a claim code is ten CVC words (10 bits each, 100 bits)", () => {
	const code = generateClaimCode();
	const words = code.split("-");
	equal(words.length, CLAIM_CODE_WORDS);
	ok(
		words.every((w) => /^[bdfghjklmnprstvz][aeio][bdfghjklmnprstvz]$/.test(w)),
	);
	// 16 × 4 × 16 = 1,024 choices per word.
	equal(16 * 4 * 16, 1024);
	const seen = new Set(Array.from({ length: 200 }, generateClaimCode));
	equal(seen.size, 200);
});

Deno.test("a typed claim code matches with spaces and capitals; tokens stay exact", () => {
	const code = generateClaimCode();
	equal(
		normalizeSetupInput(` ${code.toUpperCase().replaceAll("-", " ")} `),
		code,
	);
	const token = "AbC_def-123456789012345678901234567890123";
	equal(normalizeSetupInput(` ${token}\n`), token);
	notEqual(normalizeSetupInput(token.toLowerCase()), token);
});

Deno.test("handles come from the username claim, lowercased and slug-safe", () => {
	equal(handleFrom("David.Flanagan", "user"), "david-flanagan");
	equal(handleFrom("rawkode@example.com", "user"), "rawkode");
	equal(handleFrom("  --Ünïcode--  ", "user"), "n-code");
	equal(handleFrom("", "owner"), "owner");
	equal(handleFrom(undefined, "owner"), "owner");
	equal(handleFrom("x".repeat(80), "u").length, 40);
});
