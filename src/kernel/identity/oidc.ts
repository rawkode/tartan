// OIDC relying party on oauth4webapi (WP2): discovery with the SSRF guard, an
// EXACT issuer match and a PKCE S256 check; the authorization URL; the code
// exchange with the PKCE verifier and the client authentication the stored IdP
// row names (`none` for a public client, the default); ID-token validation with
// the expected nonce, the stored `id_token_signed_response_alg` enforced, and
// an application-level signature check when `verify_id_token_signature = 1`.
//
// Every request goes through the caller's `fetch`, which in production is
// the guarded fetch (`ssrf.ts`); tests pass a mock IdP's fetch.

import * as oauth from "oauth4webapi";
import {
	type IdpClientAuth,
	invalid,
	tartanError,
	unavailable,
} from "@tartan/contract";
import {
	checkOutboundUrl,
	type FetchLike,
	outboundUrlProblem,
} from "./ssrf.ts";

export type AuthorizationServer = oauth.AuthorizationServer;
export type IdTokenClaims = oauth.IDToken;

/** ID-token algorithms Tartan accepts from an IdP (WebCrypto verifies each). */
export const ID_TOKEN_ALGS = [
	"RS256",
	"PS256",
	"ES256",
	"EdDSA",
	"Ed25519",
] as const;
export const isIdTokenAlg = (alg: unknown): alg is string =>
	typeof alg === "string" && (ID_TOKEN_ALGS as readonly string[]).includes(alg);

/** Maps an oauth4webapi failure to the Tartan taxonomy, keeping its message. */
export const oidcError = (what: string, error: unknown): Error => {
	if (error instanceof Error && error.name === "TartanError") return error;
	const message = error instanceof Error ? error.message : String(error);
	if (error instanceof oauth.ResponseBodyError) {
		return tartanError("denied", `${what}: ${error.error}`, {
			reason: "idp",
			details: { error: error.error },
		});
	}
	if (error instanceof oauth.OperationProcessingError) {
		return invalid(`${what}: ${message}`);
	}
	return unavailable(`${what}: ${message}`);
};

const endpointProblem = (
	as: AuthorizationServer,
	name: keyof AuthorizationServer,
): string | null => {
	const value = as[name];
	if (value === undefined) return null;
	if (typeof value !== "string") return `${String(name)} is not a URL`;
	const problem = outboundUrlProblem(value);
	return problem === null ? null : `${String(name)}: ${problem}`;
};

/**
 * Discovers `issuer` (`<issuer>/.well-known/openid-configuration`). The
 * metadata's `issuer` must equal the pasted string exactly (OpenID Connect
 * Discovery, section 4.3): `https://id.rawkode.academy/` does not match
 * `https://id.rawkode.academy`, although both parse to the same URL.
 */
export const discover = async (
	issuer: string,
	fetchFn: FetchLike,
): Promise<AuthorizationServer> => {
	const issuerUrl = checkOutboundUrl(issuer);
	let as: AuthorizationServer;
	try {
		const response = await oauth.discoveryRequest(issuerUrl, {
			algorithm: "oidc",
			[oauth.customFetch]: fetchFn,
		});
		as = await oauth.processDiscoveryResponse(issuerUrl, response);
	} catch (error) {
		throw oidcError("IdP discovery failed", error);
	}
	if (as.issuer !== issuer) {
		throw invalid(
			`issuer mismatch: the IdP calls itself ${as.issuer}; paste exactly that`,
			{ expected: as.issuer },
		);
	}
	if (typeof as.authorization_endpoint !== "string") {
		throw invalid("the IdP metadata has no authorization_endpoint");
	}
	if (typeof as.token_endpoint !== "string") {
		throw invalid("the IdP metadata has no token_endpoint");
	}
	const problems = (
		[
			"authorization_endpoint",
			"token_endpoint",
			"jwks_uri",
			"registration_endpoint",
			"end_session_endpoint",
		] as const
	).map((name) => endpointProblem(as, name)).filter((p) => p !== null);
	if (problems.length > 0) {
		throw invalid(`the IdP metadata is not usable: ${problems.join("; ")}`);
	}
	if (!(as.code_challenge_methods_supported ?? []).includes("S256")) {
		throw invalid("the IdP does not advertise PKCE S256");
	}
	return as;
};

export type AuthorizationRequest = {
	readonly clientId: string;
	readonly redirectUri: string;
	readonly scope: string;
	readonly state: string;
	readonly nonce: string;
	readonly codeChallenge: string;
};

/** The authorization-endpoint URL of a login. */
export const authorizationUrl = (
	as: AuthorizationServer,
	r: AuthorizationRequest,
): URL => {
	const url = new URL(as.authorization_endpoint as string);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", r.clientId);
	url.searchParams.set("redirect_uri", r.redirectUri);
	url.searchParams.set("scope", r.scope);
	url.searchParams.set("state", r.state);
	url.searchParams.set("nonce", r.nonce);
	url.searchParams.set("code_challenge", r.codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	return url;
};

/** The client as the token endpoint must see it (from the stored IdP row). */
export type RelyingParty = {
	readonly clientId: string;
	readonly clientAuth: IdpClientAuth;
	readonly idTokenAlg: string;
	/** `client_secret_*` only. */
	readonly clientSecret?: string;
	/** `private_key_jwt` only: the active client-auth key. */
	readonly privateKey?: { readonly key: CryptoKey; readonly kid: string };
};

const clientAuthentication = (rp: RelyingParty): oauth.ClientAuth => {
	switch (rp.clientAuth) {
		case "none":
			return oauth.None();
		case "client_secret_basic":
			if (!rp.clientSecret) throw invalid("the IdP client secret is missing");
			return oauth.ClientSecretBasic(rp.clientSecret);
		case "client_secret_post":
			if (!rp.clientSecret) throw invalid("the IdP client secret is missing");
			return oauth.ClientSecretPost(rp.clientSecret);
		case "private_key_jwt":
			if (!rp.privateKey) throw invalid("no client-auth key is configured");
			return oauth.PrivateKeyJwt(rp.privateKey);
	}
};

export type CodeExchange = {
	readonly as: AuthorizationServer;
	readonly rp: RelyingParty;
	/** The full callback URL (`code`, `state`, `iss`). */
	readonly callback: URL;
	readonly redirectUri: string;
	readonly state: string;
	readonly codeVerifier: string;
	readonly nonce: string;
	readonly verifySignature: boolean;
	readonly fetch: FetchLike;
};

/**
 * Sign-in callback: validates the authorization response (RFC 9207 `iss` when
 * advertised), redeems the code with the PKCE verifier and the stored client
 * authentication, and returns the validated ID-token claims.
 */
export const exchangeCode = async (x: CodeExchange): Promise<IdTokenClaims> => {
	const client: oauth.Client = {
		client_id: x.rp.clientId,
		id_token_signed_response_alg: x.rp.idTokenAlg,
	};
	try {
		const params = oauth.validateAuthResponse(
			x.as,
			client,
			x.callback,
			x.state,
		);
		const response = await oauth.authorizationCodeGrantRequest(
			x.as,
			client,
			clientAuthentication(x.rp),
			params,
			x.redirectUri,
			x.codeVerifier,
			{ [oauth.customFetch]: x.fetch },
		);
		const result = await oauth.processAuthorizationCodeResponse(
			x.as,
			client,
			response,
			{ expectedNonce: x.nonce, requireIdToken: true },
		);
		if (x.verifySignature) {
			await oauth.validateApplicationLevelSignature(x.as, response, {
				[oauth.customFetch]: x.fetch,
			});
		}
		const claims = oauth.getValidatedIdTokenClaims(result);
		if (claims === undefined) throw invalid("the IdP returned no ID token");
		return claims;
	} catch (error) {
		throw oidcError("sign-in failed", error);
	}
};

export const pkcePair = async (): Promise<
	{ verifier: string; challenge: string }
> => {
	const verifier = oauth.generateRandomCodeVerifier();
	return {
		verifier,
		challenge: await oauth.calculatePKCECodeChallenge(verifier),
	};
};

export const randomState = (): string => oauth.generateRandomState();
export const randomNonce = (): string => oauth.generateRandomNonce();
