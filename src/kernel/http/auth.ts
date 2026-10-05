// Authentication and same-origin checks (WP2). `createAuthenticate(env)`
// resolves `Authorization` (Bearer `tpat_`/`tagt_`, or a Basic password for
// git; OAuth access tokens are WP11's, M2) or the session cookie, as the route
// policy allows; cookies are never read when `Authorization` is present, so
// bearer requests are CSRF-immune. Tokens are never read from query strings or
// cookies. `requireSameOrigin` enforces the same-origin rule; WP11 also calls
// it on the OAuth consent POST. Route owners never call `authenticate`: the
// middleware does and hands handlers `RouteContext.auth`.

import {
	COOKIE,
	denied,
	tartanError,
	TOKEN_RE,
	unauthenticated,
} from "@tartan/contract";
import type {
	Authenticate,
	CreateAuthenticate,
	RequireSameOrigin,
} from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import { sha256Hex } from "../identity/crypto.ts";
import { cookieOf } from "./cookies.ts";
import { cachedToken, forgeIdentity } from "./isolate.ts";

/** Reason of the `unauthenticated` error for a stale session cookie (the middleware may treat it as anonymous). */
export const STALE_SESSION = "session";

/**
 * The credential in an `Authorization` header: `Bearer <token>`, or Basic
 * with the token as the password (git credential helpers; the username is
 * ignored). Null for any other scheme.
 */
export const credentialOf = (header: string): string | null => {
	const m = /^\s*(Bearer|Basic)\s+(\S+)\s*$/i.exec(header);
	if (m === null) return null;
	if (m[1].toLowerCase() === "bearer") return m[2];
	try {
		const decoded = atob(m[2]);
		const colon = decoded.indexOf(":");
		return colon === -1 ? null : decoded.slice(colon + 1);
	} catch {
		return null;
	}
};

export const createAuthenticate: CreateAuthenticate<Env> =
	(env): Authenticate => async (req, options) => {
		const header = req.headers.get("authorization");
		if (header !== null) {
			// Present: cookies are never consulted, whatever the route allows.
			if (!options.allowToken) return null;
			const credential = credentialOf(header);
			if (credential === null) {
				throw unauthenticated("unsupported Authorization header");
			}
			if (!TOKEN_RE.test(credential)) {
				throw unauthenticated("invalid token");
			}
			const auth = await cachedToken(env, await sha256Hex(credential));
			if (auth === null) {
				throw unauthenticated("invalid, expired or revoked token");
			}
			return auth;
		}
		if (!options.allowCookie) return null;
		const cookie = cookieOf(req, COOKIE.session);
		if (cookie === null || cookie === "") return null;
		const auth = await forgeIdentity(env).session(await sha256Hex(cookie));
		if (auth === null) {
			throw tartanError("unauthenticated", "the session has expired", {
				reason: STALE_SESSION,
			});
		}
		return auth;
	};

/**
 * The same-origin rule: `Sec-Fetch-Site: same-origin`, or, when that
 * header is absent, an `Origin` exactly equal to the canonical origin.
 * `same-site`, `cross-site` and `none` are refused.
 */
export const requireSameOrigin: RequireSameOrigin = (req, canonicalOrigin) => {
	const site = req.headers.get("sec-fetch-site");
	if (site !== null) {
		if (site === "same-origin") return;
		throw denied(
			"csrf",
			`cross-origin request refused (Sec-Fetch-Site: ${site})`,
		);
	}
	const origin = req.headers.get("origin");
	if (origin !== null && origin === canonicalOrigin) return;
	throw denied(
		"csrf",
		origin === null
			? "cross-origin request refused (no Origin)"
			: "cross-origin request refused (Origin)",
	);
};
