// Configuration of the e2e mock IdP, checked on every request (fail closed).
//
// The one property that makes this IdP safe on a shared account is enforced
// here, in code, and not only by what the launcher renders: every allowed
// redirect URI must be the OIDC callback of a `tartan-dev-e2e` forge on
// workers.dev, and the issuer must be this Worker's own workers.dev origin.
// A var that names anything else (a production forge, a custom domain, a
// localhost URL) makes every OIDC endpoint answer 500 without a redirect.

import { isSeed } from "./password.ts";

/** The Worker name. No `validateStage` stage renders it (single hyphens only). */
export const IDP_WORKER = "tartan-e2e--idp";

export const ISSUER_RE =
	/^https:\/\/tartan-e2e--idp\.[a-z0-9-]+\.workers\.dev$/;

/** The only redirect URI shape this IdP will ever send a code to. */
export const REDIRECT_URI_RE =
	/^https:\/\/tartan-dev-e2e\.[a-z0-9-]+\.workers\.dev\/-\/auth\/callback$/;

export const MAX_REDIRECT_URIS = 4;

export type IdpEnv = {
	readonly ISSUER?: string;
	/** A JSON array of redirect URIs, each matching `REDIRECT_URI_RE`. */
	readonly ALLOWED_REDIRECT_URIS?: string;
	readonly E2E_IDP_SEED?: string;
	/** The private RS256 signing key as a JWK (JSON). */
	readonly E2E_IDP_SIGNING_JWK?: string;
};

export type IdpConfig = {
	readonly issuer: string;
	readonly redirectUris: readonly string[];
	readonly seed: string;
	readonly signingJwk: JsonWebKey;
};

export type Checked<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly reason: string };

/** Parses the allow-list; every entry must match `REDIRECT_URI_RE` exactly. */
export const parseRedirectAllowList = (
	raw: string | undefined,
): Checked<readonly string[]> => {
	if (raw === undefined || raw.trim() === "") {
		return { ok: false, reason: "ALLOWED_REDIRECT_URIS is not set" };
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return { ok: false, reason: "ALLOWED_REDIRECT_URIS is not JSON" };
	}
	if (
		!Array.isArray(value) || value.length === 0 ||
		value.length > MAX_REDIRECT_URIS
	) {
		return {
			ok: false,
			reason:
				`ALLOWED_REDIRECT_URIS must be a JSON array of 1 to ${MAX_REDIRECT_URIS} URIs`,
		};
	}
	for (const entry of value) {
		if (typeof entry !== "string" || !REDIRECT_URI_RE.test(entry)) {
			return {
				ok: false,
				reason:
					"an ALLOWED_REDIRECT_URIS entry is not a tartan-dev-e2e workers.dev callback",
			};
		}
	}
	return { ok: true, value: [...new Set(value as string[])] };
};

export const parseIssuer = (raw: string | undefined): Checked<string> =>
	raw !== undefined && ISSUER_RE.test(raw) ? { ok: true, value: raw } : {
		ok: false,
		reason: "ISSUER is not the tartan-e2e--idp workers.dev origin",
	};

const parseJwk = (raw: string | undefined): Checked<JsonWebKey> => {
	if (raw === undefined || raw === "") {
		return { ok: false, reason: "E2E_IDP_SIGNING_JWK is not set" };
	}
	try {
		const jwk = JSON.parse(raw) as JsonWebKey;
		if (
			jwk.kty !== "RSA" || typeof jwk.n !== "string" ||
			typeof jwk.d !== "string" || typeof jwk.e !== "string"
		) {
			return {
				ok: false,
				reason: "E2E_IDP_SIGNING_JWK is not a private RSA JWK",
			};
		}
		return { ok: true, value: jwk };
	} catch {
		return { ok: false, reason: "E2E_IDP_SIGNING_JWK is not JSON" };
	}
};

/** The whole configuration, or the first reason it is unusable. */
export const loadConfig = (env: IdpEnv): Checked<IdpConfig> => {
	const issuer = parseIssuer(env.ISSUER);
	if (!issuer.ok) return issuer;
	const redirects = parseRedirectAllowList(env.ALLOWED_REDIRECT_URIS);
	if (!redirects.ok) return redirects;
	if (!isSeed(env.E2E_IDP_SEED)) {
		return { ok: false, reason: "E2E_IDP_SEED is missing or malformed" };
	}
	const jwk = parseJwk(env.E2E_IDP_SIGNING_JWK);
	if (!jwk.ok) return jwk;
	return {
		ok: true,
		value: {
			issuer: issuer.value,
			redirectUris: redirects.value,
			seed: env.E2E_IDP_SEED,
			signingJwk: jwk.value,
		},
	};
};

/** Exact string membership in the current allow-list (never a prefix or URL match). */
export const redirectAllowed = (config: IdpConfig, uri: string): boolean =>
	REDIRECT_URI_RE.test(uri) && config.redirectUris.includes(uri);
