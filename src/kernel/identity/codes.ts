// Setup claim codes, invite codes and handles (WP2).
//
// A logs claim code is ten 3-letter words, each consonant-vowel-consonant
// from 16 × 4 × 16 = 1,024 choices, so 10 bits per word and 100 bits in all
// (a 10-word code of about 100 bits). The words are built, not
// drawn from a word list, so no list is vendored. Codes are compared by their
// SHA-256 only.

import { randomBytes } from "./crypto.ts";

const CONSONANTS = "bdfghjklmnprstvz";
const VOWELS = "aeio";
export const CLAIM_CODE_WORDS = 10;

/** One word from 10 random bits. */
const word = (bits: number): string =>
	CONSONANTS[(bits >> 6) & 15] + VOWELS[(bits >> 4) & 3] +
	CONSONANTS[bits & 15];

/** A fresh claim code, e.g. `bal-kim-tod-…` (10 words, 100 bits). */
export const generateClaimCode = (): string => {
	const bytes = randomBytes(CLAIM_CODE_WORDS * 2);
	return Array.from({ length: CLAIM_CODE_WORDS }, (_, i) => {
		const bits = ((bytes[i * 2] << 8) | bytes[i * 2 + 1]) & 1023;
		return word(bits);
	}).join("-");
};

/**
 * How a typed setup token or claim code is compared: trimmed, and a code
 * typed with spaces or capitals still matches. A deploy-generated token is
 * base64url and case-sensitive, so only strings that look like a claim code
 * are folded.
 */
export const normalizeSetupInput = (input: string): string => {
	const trimmed = input.trim();
	const folded = trimmed.toLowerCase().split(/[\s-]+/).filter((w) => w !== "");
	const isCode = folded.length === CLAIM_CODE_WORDS &&
		folded.every((w) => /^[bdfghjklmnprstvz][aeio][bdfghjklmnprstvz]$/.test(w));
	return isCode ? folded.join("-") : trimmed;
};

/**
 * A principal handle or root slug from an IdP claim: lowercase
 * `[a-z0-9-]`, starting with `[a-z0-9]`, at most 40 chars; `fallback` when
 * nothing usable is left.
 */
export const handleFrom = (
	claim: string | undefined,
	fallback: string,
): string => {
	const base = (claim ?? "")
		.toLowerCase()
		.replace(/@.*$/, "")
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-")
		.slice(0, 40)
		.replace(/-+$/, "");
	return base === "" ? fallback : base;
};
