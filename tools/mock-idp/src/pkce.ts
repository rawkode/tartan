// PKCE S256 (RFC 7636) for the e2e mock IdP. Formats are checked before any
// hashing: an S256 challenge is exactly 43 base64url characters, a verifier
// 43 to 128 unreserved characters. The comparison is constant time.

import { b64url, constantTimeEqual, sha256, utf8 } from "./encoding.ts";

export const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
export const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

export const isChallenge = (value: unknown): value is string =>
	typeof value === "string" && CHALLENGE_RE.test(value);

export const isVerifier = (value: unknown): value is string =>
	typeof value === "string" && VERIFIER_RE.test(value);

export const s256 = async (verifier: string): Promise<string> =>
	b64url(await sha256(utf8(verifier)));

/** True when `verifier` is well formed and its S256 equals `challenge`. */
export const verifyPkce = async (
	verifier: unknown,
	challenge: string,
): Promise<boolean> => {
	if (!isVerifier(verifier) || !isChallenge(challenge)) return false;
	return constantTimeEqual(utf8(await s256(verifier)), utf8(challenge));
};
