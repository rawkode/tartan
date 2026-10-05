// RS256 ID tokens for the e2e mock IdP (WebCrypto RSASSA-PKCS1-v1_5 with
// SHA-256). The key id is derived from the key (an RFC 7638 thumbprint), so a
// rotated key always has a new `kid` and a forge never keeps verifying with a
// stale JWKS entry of the same name.

import { b64url, sha256, utf8 } from "./encoding.ts";

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

export type PublicJwk = {
	readonly kty: "RSA";
	readonly n: string;
	readonly e: string;
	readonly kid: string;
	readonly alg: "RS256";
	readonly use: "sig";
};

export type SigningKey = {
	readonly kid: string;
	readonly privateKey: CryptoKey;
	readonly publicJwk: PublicJwk;
};

/** RFC 7638 thumbprint of an RSA key: SHA-256 of `{"e","kty","n"}`, base64url. */
export const thumbprint = async (
	jwk: { readonly e?: string; readonly n?: string },
): Promise<string> => {
	if (typeof jwk.e !== "string" || typeof jwk.n !== "string") {
		throw new Error("not an RSA key");
	}
	return b64url(
		await sha256(JSON.stringify({ e: jwk.e, kty: "RSA", n: jwk.n })),
	);
};

export const kidOf = async (
	jwk: { readonly e?: string; readonly n?: string },
): Promise<string> => `e2e-${(await thumbprint(jwk)).slice(0, 16)}`;

/** A private JWK as stored in the `E2E_IDP_SIGNING_JWK` secret. */
export type SigningJwk = JsonWebKey & { readonly kid?: string };

/** A new RSA-2048 private JWK with its derived `kid` (the launcher runs this). */
export const generateSigningJwk = async (): Promise<SigningJwk> => {
	const pair = await crypto.subtle.generateKey(
		{
			...RS256,
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
		},
		true,
		["sign", "verify"],
	) as CryptoKeyPair;
	const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
	return { ...jwk, kid: await kidOf(jwk), alg: "RS256", use: "sig" };
};

export const importSigningKey = async (
	jwk: JsonWebKey,
): Promise<SigningKey> => {
	const kid = await kidOf(jwk);
	const privateKey = await crypto.subtle.importKey(
		"jwk",
		{
			kty: "RSA",
			n: jwk.n,
			e: jwk.e,
			d: jwk.d,
			p: jwk.p,
			q: jwk.q,
			dp: jwk.dp,
			dq: jwk.dq,
			qi: jwk.qi,
			alg: "RS256",
			ext: false,
		},
		RS256,
		false,
		["sign"],
	);
	return {
		kid,
		privateKey,
		publicJwk: {
			kty: "RSA",
			n: jwk.n as string,
			e: jwk.e as string,
			kid,
			alg: "RS256",
			use: "sig",
		},
	};
};

export type IdTokenClaims = {
	readonly iss: string;
	readonly sub: string;
	readonly aud: string;
	readonly iat: number;
	readonly exp: number;
	readonly auth_time: number;
	readonly nonce: string;
	readonly preferred_username: string;
	readonly name: string;
	readonly email: string;
	readonly email_verified: false;
	readonly groups: readonly string[];
};

export const signJwt = async (
	key: SigningKey,
	claims: Readonly<Record<string, unknown>>,
): Promise<string> => {
	const header = b64url(
		utf8(JSON.stringify({ alg: "RS256", typ: "JWT", kid: key.kid })),
	);
	const payload = b64url(utf8(JSON.stringify(claims)));
	const input = `${header}.${payload}`;
	const signature = new Uint8Array(
		await crypto.subtle.sign(RS256, key.privateKey, utf8(input)),
	);
	return `${input}.${b64url(signature)}`;
};
