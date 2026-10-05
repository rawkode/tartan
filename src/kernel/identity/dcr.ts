// RFC 7591 Dynamic Client Registration and RFC 7592 deletion (WP2).
//
// Tartan asks for a public PKCE client (`token_endpoint_auth_method: none`,
// RS256 ID tokens) and then stores what the RESPONSE says, never what it
// asked for: a returned `client_secret_basic`/`client_secret_post` with a
// secret is used (the secret is sealed by the caller); `none` with a secret,
// `private_key_jwt` or any other method is refused, so the wizard falls back
// to manual entry. A `registration_client_uri` is kept only on the
// registration endpoint's origin; any other origin refuses the registration.

import {
	type IdpClientAuth,
	invalid,
	tartanError,
	unavailable,
} from "@tartan/contract";
import { isIdTokenAlg } from "./oidc.ts";
import { type FetchLike, outboundUrlProblem } from "./ssrf.ts";

export type RegistrationRequestInput = {
	readonly forgeName: string;
	readonly redirectUri: string;
	readonly scope: string;
};

/** The registration request body. */
export const registrationRequest = (r: RegistrationRequestInput) => ({
	client_name: `Tartan (${r.forgeName})`,
	redirect_uris: [r.redirectUri],
	grant_types: ["authorization_code"],
	response_types: ["code"],
	token_endpoint_auth_method: "none",
	id_token_signed_response_alg: "RS256",
	scope: r.scope,
});

/** RFC 7592 management credentials, kept sealed (`idp.registration_sealed`). */
export type RegistrationManagement = {
	readonly token: string;
	readonly uri: string;
};

export type RegisteredClient = {
	readonly clientId: string;
	readonly clientAuth: IdpClientAuth;
	readonly idTokenAlg: string;
	readonly clientSecret?: string;
	readonly management?: RegistrationManagement;
};

export type RegistrationOutcome =
	| ({ readonly ok: true } & RegisteredClient)
	| { readonly ok: false; readonly reason: string };

const str = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * Decides what to store from a registration RESPONSE body (pure).
 * When the response omits `token_endpoint_auth_method`, a client without a
 * secret can only be public (`none`) and a client with one is the RFC 7591
 * default `client_secret_basic`.
 */
export const parseRegistration = (
	body: unknown,
	registrationEndpoint: string,
	nowMs: number,
): RegistrationOutcome => {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return {
			ok: false,
			reason: "the registration response is not a JSON object",
		};
	}
	const b = body as Record<string, unknown>;
	const clientId = str(b.client_id);
	if (clientId === undefined || clientId.length > 512) {
		return { ok: false, reason: "the registration response has no client_id" };
	}
	const secret = str(b.client_secret);
	const method = str(b.token_endpoint_auth_method) ??
		(secret === undefined ? "none" : "client_secret_basic");
	if (method === "none" && secret !== undefined) {
		return {
			ok: false,
			reason: "the IdP returned a client secret for a public client",
		};
	}
	if (method === "client_secret_basic" || method === "client_secret_post") {
		if (secret === undefined) {
			return { ok: false, reason: `${method} was returned without a secret` };
		}
		const expires = b.client_secret_expires_at;
		if (typeof expires === "number" && expires > 0 && expires * 1000 <= nowMs) {
			return { ok: false, reason: "the returned client secret has expired" };
		}
	} else if (method !== "none") {
		return {
			ok: false,
			reason:
				`the IdP registered the client for ${method}, which Tartan does not register by DCR`,
		};
	}
	const alg = b.id_token_signed_response_alg ?? "RS256";
	if (!isIdTokenAlg(alg)) {
		return {
			ok: false,
			reason: `unsupported id_token_signed_response_alg ${String(alg)}`,
		};
	}
	const uri = str(b.registration_client_uri);
	const token = str(b.registration_access_token);
	let management: RegistrationManagement | undefined;
	if (uri !== undefined) {
		const problem = outboundUrlProblem(uri);
		if (problem !== null) {
			return { ok: false, reason: `registration_client_uri: ${problem}` };
		}
		if (new URL(uri).origin !== new URL(registrationEndpoint).origin) {
			return {
				ok: false,
				reason:
					"registration_client_uri is not on the registration endpoint's origin",
			};
		}
		if (token !== undefined) management = { token, uri };
	}
	return {
		ok: true,
		clientId,
		clientAuth: method as "none" | "client_secret_basic" | "client_secret_post",
		idTokenAlg: alg,
		...(secret !== undefined ? { clientSecret: secret } : {}),
		...(management !== undefined ? { management } : {}),
	};
};

/**
 * POSTs the registration. Any failure (network, non-2xx, unusable response)
 * is `unavailable`, which the wizard turns into manual entry.
 */
export const registerClient = async (
	registrationEndpoint: string,
	request: ReturnType<typeof registrationRequest>,
	options: {
		readonly fetch: FetchLike;
		readonly initialAccessToken?: string;
		readonly now: number;
	},
): Promise<RegisteredClient> => {
	const problem = outboundUrlProblem(registrationEndpoint);
	if (problem !== null) throw invalid(`registration_endpoint: ${problem}`);
	let response: Response;
	try {
		response = await options.fetch(registrationEndpoint, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json",
				...(options.initialAccessToken
					? { authorization: `Bearer ${options.initialAccessToken}` }
					: {}),
			},
			body: JSON.stringify(request),
		});
	} catch (error) {
		throw unavailable(
			`client registration failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	if (response.status !== 201 && response.status !== 200) {
		throw unavailable(
			`client registration was refused (HTTP ${response.status})`,
			{ status: response.status },
		);
	}
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw unavailable("the registration response is not JSON");
	}
	const outcome = parseRegistration(body, registrationEndpoint, options.now);
	if (!outcome.ok) {
		throw tartanError("unavailable", outcome.reason, { reason: "dcr" });
	}
	const { ok: _ok, ...client } = outcome;
	return client;
};

/** RFC 7592 §2.3: DELETE the registration with its access token. */
export const deregisterClient = async (
	management: RegistrationManagement,
	fetchFn: FetchLike,
): Promise<{ ok: boolean; reason?: string }> => {
	try {
		const response = await fetchFn(management.uri, {
			method: "DELETE",
			headers: { authorization: `Bearer ${management.token}` },
		});
		await response.body?.cancel();
		return response.status === 204 || response.status === 200
			? { ok: true }
			: { ok: false, reason: `the IdP answered HTTP ${response.status}` };
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
};
