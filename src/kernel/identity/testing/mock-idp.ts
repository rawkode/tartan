// A mock OIDC provider for WP2's tests (Deno and workerd): discovery, JWKS,
// RFC 7591 registration, RFC 7592 deletion, the authorization step (as a
// function: the "browser at the IdP") and a token endpoint that checks PKCE
// S256 and the registered client authentication, signing ID tokens with jose
// (RS256 or EdDSA). It is reached only through its `fetch`, so no network
// and no `allowInsecureRequests` are needed (hosts are `https://*.test`).

import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { FetchLike } from "../ssrf.ts";

export type MockUser = {
	readonly sub: string;
	readonly [claim: string]: unknown;
};

export type RegisteredMockClient = {
	readonly method: string;
	readonly secret?: string;
	readonly registrationToken?: string;
};

export type RegistrationHandler = (
	body: Record<string, unknown>,
	clientId: string,
	issuer: string,
) => { status: number; body: unknown; client?: RegisteredMockClient };

export type MockIdpOptions = {
	readonly issuer?: string;
	/** The ID-token algorithm the IdP signs with. */
	readonly idTokenAlg?: "RS256" | "EdDSA";
	/** `false` drops `registration_endpoint`; a function answers registrations. */
	readonly registration?: false | RegistrationHandler;
	readonly issParameter?: boolean;
	readonly pkceMethods?: readonly string[];
	readonly extraMetadata?: Record<string, unknown>;
};

export type RecordedRequest = {
	readonly method: string;
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
};

const b64url = (bytes: Uint8Array): string =>
	btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_")
		.replace(/=+$/, "");

const s256 = async (verifier: string): Promise<string> =>
	b64url(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
		),
	);

/** The default registration answer: what `id.rawkode.academy`-like IdPs return for a public client. */
export const publicClientRegistration: RegistrationHandler = (
	body,
	clientId,
	issuer,
) => ({
	status: 201,
	body: {
		client_id: clientId,
		client_id_issued_at: 1_800_000_000,
		redirect_uris: body.redirect_uris,
		token_endpoint_auth_method: "none",
		id_token_signed_response_alg: body.id_token_signed_response_alg ?? "RS256",
		registration_access_token: `rat_${clientId}`,
		registration_client_uri: `${issuer}/register/${clientId}`,
	},
	client: { method: "none", registrationToken: `rat_${clientId}` },
});

export const createMockIdp = async (options: MockIdpOptions = {}) => {
	const issuer = options.issuer ?? "https://idp.test";
	const rs = await generateKeyPair("RS256", { extractable: true });
	const ed = await generateKeyPair("EdDSA", { extractable: true });
	const jwks = {
		keys: [
			{
				...(await exportJWK(rs.publicKey)),
				kid: "rs1",
				alg: "RS256",
				use: "sig",
			},
			{
				...(await exportJWK(ed.publicKey)),
				kid: "ed1",
				alg: "EdDSA",
				use: "sig",
			},
		],
	};
	let signAlg: "RS256" | "EdDSA" = options.idTokenAlg ?? "RS256";
	const clients = new Map<string, RegisteredMockClient>();
	const codes = new Map<
		string,
		{
			clientId: string;
			redirectUri: string;
			challenge: string;
			nonce: string;
			user: MockUser;
		}
	>();
	const requests: RecordedRequest[] = [];
	const registrations: {
		body: Record<string, unknown>;
		authorization: string | null;
	}[] = [];
	const deleted: string[] = [];
	let sequence = 0;

	const metadata = () => ({
		issuer,
		authorization_endpoint: `${issuer}/authorize`,
		token_endpoint: `${issuer}/token`,
		jwks_uri: `${issuer}/jwks`,
		end_session_endpoint: `${issuer}/logout`,
		...(options.registration !== false
			? { registration_endpoint: `${issuer}/register` }
			: {}),
		response_types_supported: ["code"],
		subject_types_supported: ["public"],
		id_token_signing_alg_values_supported: ["RS256", "EdDSA"],
		token_endpoint_auth_methods_supported: [
			"client_secret_basic",
			"client_secret_post",
			"none",
		],
		code_challenge_methods_supported: options.pkceMethods ?? ["S256"],
		scopes_supported: ["openid", "profile", "email", "groups", "roles"],
		...(options.issParameter
			? { authorization_response_iss_parameter_supported: true }
			: {}),
		...options.extraMetadata,
	});

	const oauthError = (status: number, error: string) =>
		Response.json({ error }, {
			status,
			headers: { "cache-control": "no-store" },
		});

	const clientAuthOk = (
		client: RegisteredMockClient,
		clientId: string,
		headers: Headers,
		form: URLSearchParams,
	): boolean => {
		const basic = headers.get("authorization");
		switch (client.method) {
			case "none":
				return basic === null && !form.has("client_secret") &&
					form.get("client_id") === clientId;
			case "client_secret_basic":
				return basic ===
						`Basic ${
							btoa(
								`${encodeURIComponent(clientId)}:${
									encodeURIComponent(client.secret ?? "")
								}`,
							)
						}` &&
					!form.has("client_secret");
			case "client_secret_post":
				return basic === null && form.get("client_id") === clientId &&
					form.get("client_secret") === client.secret;
			default:
				return false;
		}
	};

	const token = async (headers: Headers, body: string): Promise<Response> => {
		const form = new URLSearchParams(body);
		if (form.get("grant_type") !== "authorization_code") {
			return oauthError(400, "unsupported_grant_type");
		}
		const code = codes.get(form.get("code") ?? "");
		if (code === undefined) return oauthError(400, "invalid_grant");
		codes.delete(form.get("code") ?? "");
		const client = clients.get(code.clientId);
		if (
			client === undefined ||
			!clientAuthOk(client, code.clientId, headers, form)
		) {
			return oauthError(401, "invalid_client");
		}
		if (form.get("redirect_uri") !== code.redirectUri) {
			return oauthError(400, "invalid_grant");
		}
		if (await s256(form.get("code_verifier") ?? "") !== code.challenge) {
			return oauthError(400, "invalid_grant");
		}
		const { sub, ...claims } = code.user;
		const key = signAlg === "RS256" ? rs.privateKey : ed.privateKey;
		const idToken = await new SignJWT({ ...claims, nonce: code.nonce })
			.setProtectedHeader({
				alg: signAlg,
				kid: signAlg === "RS256" ? "rs1" : "ed1",
			})
			.setIssuer(issuer)
			.setAudience(code.clientId)
			.setSubject(sub)
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(key);
		return Response.json(
			{
				access_token: "at_mock",
				token_type: "Bearer",
				expires_in: 300,
				id_token: idToken,
			},
			{ headers: { "cache-control": "no-store" } },
		);
	};

	const fetch: FetchLike = async (input, init) => {
		const req = input instanceof Request
			? input
			: new Request(String(input), init);
		const url = new URL(req.url);
		const body = req.method === "GET" || req.method === "HEAD"
			? ""
			: await req.text();
		requests.push({
			method: req.method,
			url: req.url,
			headers: Object.fromEntries(req.headers),
			body,
		});
		if (url.origin !== new URL(issuer).origin) {
			return new Response("unknown host", { status: 502 });
		}
		const path = url.pathname.slice(
			new URL(issuer).pathname.replace(/\/$/, "").length,
		);
		if (req.method === "GET" && path === "/.well-known/openid-configuration") {
			return Response.json(metadata());
		}
		if (req.method === "GET" && path === "/jwks") return Response.json(jwks);
		if (req.method === "POST" && path === "/token") {
			return await token(req.headers, body);
		}
		if (
			req.method === "POST" && path === "/register" &&
			options.registration !== false
		) {
			const parsed = JSON.parse(body) as Record<string, unknown>;
			registrations.push({
				body: parsed,
				authorization: req.headers.get("authorization"),
			});
			const clientId = `client-${++sequence}`;
			const answer = (options.registration ?? publicClientRegistration)(
				parsed,
				clientId,
				issuer,
			);
			if (answer.client !== undefined) clients.set(clientId, answer.client);
			return Response.json(answer.body, { status: answer.status });
		}
		const unregister = /^\/register\/([^/]+)$/.exec(path);
		if (req.method === "DELETE" && unregister !== null) {
			const client = clients.get(unregister[1]);
			if (
				client === undefined ||
				req.headers.get("authorization") !==
					`Bearer ${client.registrationToken}`
			) {
				return new Response(null, { status: 401 });
			}
			clients.delete(unregister[1]);
			deleted.push(unregister[1]);
			return new Response(null, { status: 204 });
		}
		return new Response("not found", { status: 404 });
	};

	/**
	 * The user at the IdP approves `authorizationUrl`; returns the callback URL
	 * the browser is sent to.
	 */
	const authorize = (authorizationUrl: string | URL, user: MockUser): URL => {
		const auth = new URL(String(authorizationUrl));
		const p = auth.searchParams;
		if (p.get("response_type") !== "code") throw new Error("response_type");
		if (p.get("code_challenge_method") !== "S256") throw new Error("pkce");
		const clientId = p.get("client_id") ?? "";
		if (!clients.has(clientId)) throw new Error(`unknown client ${clientId}`);
		const code = `code-${++sequence}`;
		codes.set(code, {
			clientId,
			redirectUri: p.get("redirect_uri") ?? "",
			challenge: p.get("code_challenge") ?? "",
			nonce: p.get("nonce") ?? "",
			user,
		});
		const callback = new URL(p.get("redirect_uri") ?? "");
		callback.searchParams.set("code", code);
		callback.searchParams.set("state", p.get("state") ?? "");
		if (options.issParameter) callback.searchParams.set("iss", issuer);
		return callback;
	};

	return {
		issuer,
		fetch,
		authorize,
		requests,
		registrations,
		deleted,
		clients,
		/** Registers a client by hand (manual entry tests). */
		addClient: (clientId: string, client: RegisteredMockClient) => {
			clients.set(clientId, client);
		},
		setIdTokenAlg: (alg: "RS256" | "EdDSA") => {
			signAlg = alg;
		},
		tokenRequests: () => requests.filter((r) => r.url === `${issuer}/token`),
	};
};

export type MockIdp = Awaited<ReturnType<typeof createMockIdp>>;
