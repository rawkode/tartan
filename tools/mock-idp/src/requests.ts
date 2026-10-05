// Request validation of the e2e mock IdP (pure). Each parser returns the
// accepted values or an RFC error code with a reason; nothing here touches
// storage, so every rule has a unit test.
//
// Registration (RFC 7591) accepts exactly what Tartan's DCR sends
// (`src/kernel/identity/dcr.ts`): a public PKCE client with one redirect URI.
// `client_name`, `scope` and `id_token_signed_response_alg: "RS256"` are
// accepted and ignored. Fields that name a URL the server would fetch or show
// (`jwks_uri`, `sector_identifier_uri`, `request_uris`, `logo_uri`, …) are
// refused, and this IdP never fetches a URL a client provides.

import { type IdpConfig, redirectAllowed } from "./config.ts";
import { isChallenge } from "./pkce.ts";

export const MAX_STATE = 512;
export const MAX_NONCE = 512;
export const MAX_SCOPE = 512;
export const MAX_CLIENT_NAME = 200;

export type Refusal = { readonly error: string; readonly reason: string };
export type Parsed<T> =
	| { readonly ok: true; readonly value: T }
	| ({ readonly ok: false } & Refusal);

const refuse = (error: string, reason: string) =>
	({ ok: false, error, reason }) as const;

// ---------------------------------------------------------------------------
// POST /register
// ---------------------------------------------------------------------------

export type Registration = {
	readonly redirectUri: string;
	readonly clientName: string | null;
};

const ACCEPTED_FIELDS = new Set([
	"redirect_uris",
	"token_endpoint_auth_method",
	"grant_types",
	"response_types",
	"client_name",
	"scope",
	"id_token_signed_response_alg",
]);

/** A field this IdP would have to fetch, trust or display as a URL. */
const urlField = (key: string): boolean =>
	key === "jwks" || key.endsWith("_uri") || key.endsWith("_uris");

const sameList = (value: unknown, expected: readonly string[]): boolean =>
	Array.isArray(value) && value.length === expected.length &&
	value.every((v, i) => v === expected[i]);

export const parseRegistration = (
	body: unknown,
	config: IdpConfig,
): Parsed<Registration> => {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return refuse("invalid_client_metadata", "the body is not a JSON object");
	}
	const b = body as Record<string, unknown>;
	for (const key of Object.keys(b)) {
		if (!ACCEPTED_FIELDS.has(key) && urlField(key)) {
			return refuse("invalid_client_metadata", `${key} is not accepted`);
		}
	}
	if (b.token_endpoint_auth_method !== "none") {
		return refuse(
			"invalid_client_metadata",
			"token_endpoint_auth_method must be none (a public PKCE client)",
		);
	}
	if (
		b.grant_types !== undefined && !sameList(b.grant_types, [
			"authorization_code",
		])
	) {
		return refuse(
			"invalid_client_metadata",
			"grant_types must be [authorization_code]",
		);
	}
	if (
		b.response_types !== undefined && !sameList(b.response_types, ["code"])
	) {
		return refuse("invalid_client_metadata", "response_types must be [code]");
	}
	if (
		b.id_token_signed_response_alg !== undefined &&
		b.id_token_signed_response_alg !== "RS256"
	) {
		return refuse(
			"invalid_client_metadata",
			"id_token_signed_response_alg must be RS256",
		);
	}
	if (
		b.scope !== undefined &&
		(typeof b.scope !== "string" || b.scope.length > MAX_SCOPE)
	) {
		return refuse("invalid_client_metadata", "scope is not a short string");
	}
	if (
		b.client_name !== undefined &&
		(typeof b.client_name !== "string" ||
			b.client_name.length > MAX_CLIENT_NAME)
	) {
		return refuse(
			"invalid_client_metadata",
			"client_name is not a short string",
		);
	}
	const uris = b.redirect_uris;
	if (
		!Array.isArray(uris) || uris.length !== 1 || typeof uris[0] !== "string"
	) {
		return refuse(
			"invalid_redirect_uri",
			"redirect_uris must hold exactly one URI",
		);
	}
	if (!redirectAllowed(config, uris[0])) {
		return refuse(
			"invalid_redirect_uri",
			"the redirect URI is not on this IdP's allow-list",
		);
	}
	return {
		ok: true,
		value: {
			redirectUri: uris[0],
			clientName: typeof b.client_name === "string" ? b.client_name : null,
		},
	};
};

// ---------------------------------------------------------------------------
// GET /authorize
// ---------------------------------------------------------------------------

export type AuthorizationParams = {
	readonly clientId: string;
	readonly redirectUri: string;
	readonly state: string;
	readonly nonce: string;
	readonly challenge: string;
	readonly scope: string;
};

const SINGLE = [
	"client_id",
	"redirect_uri",
	"response_type",
	"scope",
	"state",
	"nonce",
	"code_challenge",
	"code_challenge_method",
] as const;

/**
 * Validates the authorization request's own shape. The client and its
 * registered redirect URI are checked by the caller against storage.
 */
export const parseAuthorization = (
	params: URLSearchParams,
): Parsed<AuthorizationParams> => {
	for (const name of SINGLE) {
		if (params.getAll(name).length > 1) {
			return refuse("invalid_request", `${name} is repeated`);
		}
	}
	if (params.has("request") || params.has("request_uri")) {
		return refuse(
			"request_not_supported",
			"request objects are not supported",
		);
	}
	const get = (name: string) => params.get(name) ?? "";
	if (get("response_type") !== "code") {
		return refuse("unsupported_response_type", "response_type must be code");
	}
	const scope = get("scope");
	if (scope.length > MAX_SCOPE || !scope.split(" ").includes("openid")) {
		return refuse("invalid_scope", "scope must include openid");
	}
	const state = get("state");
	if (state === "" || state.length > MAX_STATE) {
		return refuse("invalid_request", `state must be 1 to ${MAX_STATE} chars`);
	}
	const nonce = get("nonce");
	if (nonce === "" || nonce.length > MAX_NONCE) {
		return refuse("invalid_request", `nonce must be 1 to ${MAX_NONCE} chars`);
	}
	if (get("code_challenge_method") !== "S256") {
		return refuse("invalid_request", "code_challenge_method must be S256");
	}
	const challenge = get("code_challenge");
	if (!isChallenge(challenge)) {
		return refuse(
			"invalid_request",
			"code_challenge must be 43 base64url characters",
		);
	}
	const clientId = get("client_id");
	if (clientId === "" || clientId.length > 64) {
		return refuse("invalid_request", "client_id is missing");
	}
	const redirectUri = get("redirect_uri");
	if (redirectUri === "" || redirectUri.length > 2048) {
		return refuse("invalid_request", "redirect_uri is missing");
	}
	return {
		ok: true,
		value: { clientId, redirectUri, state, nonce, challenge, scope },
	};
};

// ---------------------------------------------------------------------------
// POST /token
// ---------------------------------------------------------------------------

export type TokenParams = {
	readonly code: string;
	readonly redirectUri: string;
	readonly clientId: string;
	readonly verifier: string;
};

export const parseTokenRequest = (
	form: URLSearchParams,
	authorization: string | null,
): Parsed<TokenParams> => {
	if (authorization !== null || form.has("client_secret")) {
		return refuse("invalid_client", "public clients do not authenticate");
	}
	for (
		const name of [
			"grant_type",
			"code",
			"redirect_uri",
			"client_id",
			"code_verifier",
		]
	) {
		if (form.getAll(name).length !== 1) {
			return refuse("invalid_request", `${name} must be given once`);
		}
	}
	if (form.get("grant_type") !== "authorization_code") {
		return refuse(
			"unsupported_grant_type",
			"grant_type must be authorization_code",
		);
	}
	const code = form.get("code") ?? "";
	if (!/^[A-Za-z0-9_-]{43}$/.test(code)) {
		return refuse("invalid_grant", "the code is malformed");
	}
	return {
		ok: true,
		value: {
			code,
			redirectUri: form.get("redirect_uri") ?? "",
			clientId: form.get("client_id") ?? "",
			verifier: form.get("code_verifier") ?? "",
		},
	};
};
