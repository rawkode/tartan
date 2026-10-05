// Test-user passwords of the e2e mock IdP. Neither the Worker nor the
// launcher stores them: both derive the same value from the seed secret,
//
//   password(user) = base64url(HMAC-SHA256(seed, CONTEXT + username)),
//
// 43 characters from a 256-bit key. Rotating the seed invalidates every
// password at once.

import { b64url, fromB64url, utf8 } from "./encoding.ts";

export const PASSWORD_CONTEXT = "tartan-e2e-idp/password/v1/";

/** 32 random bytes, base64url (43 characters, no padding). */
export const SEED_RE = /^[A-Za-z0-9_-]{43}$/;

export const isSeed = (value: unknown): value is string =>
	typeof value === "string" && SEED_RE.test(value);

const hmacKey = (seed: string): Promise<CryptoKey> => {
	if (!isSeed(seed)) throw new Error("the IdP seed is not 32 base64url bytes");
	return crypto.subtle.importKey(
		"raw",
		fromB64url(seed),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
};

export const derivePassword = async (
	seed: string,
	username: string,
): Promise<string> =>
	b64url(
		new Uint8Array(
			await crypto.subtle.sign(
				"HMAC",
				await hmacKey(seed),
				utf8(`${PASSWORD_CONTEXT}${username}`),
			),
		),
	);
