// The e2e mock IdP's request handler: OIDC discovery, JWKS, open dynamic
// client registration (RFC 7591/7592), the authorization code flow with PKCE
// S256 and RFC 9207 `iss`, and a signed-out page. It runs inside the IdP's
// one Durable Object, so every state change is one storage transaction.
//
// Rules that make it safe to run on a shared account (see docs/testing/e2e.md):
// - the configuration is checked on every request and an unusable one fails
//   closed (500, no redirect); every redirect URI must be a `tartan-dev-e2e`
//   workers.dev callback (`config.ts`);
// - `redirect_uri` is compared by exact string at `/register`, `/authorize`
//   (GET and POST) and `/token`, each time against the current allow-list;
// - the sign-in form carries only a stored request id (5 min, single use);
// - codes live 60 s, are bound to client, redirect URI, PKCE challenge and
//   nonce, and are deleted on every `/token` attempt;
// - there is no IdP session cookie: the sign-in form is always shown;
// - a client that redeemed a code is never evicted, and registrations and
//   failed sign-ins are rate limited per client address (hashed);
// - every response is `no-store`, and nothing is logged.

import {
	type IdpConfig,
	type IdpEnv,
	loadConfig,
	redirectAllowed,
} from "./config.ts";
import {
	constantTimeEqual,
	hex,
	type Random,
	randomToken,
	sha256Hex,
	utf8,
} from "./encoding.ts";
import {
	errorPage,
	signedOutPage,
	signInPage,
	WRONG_PASSWORD,
} from "./html.ts";
import { importSigningKey, type SigningKey, signJwt } from "./jwt.ts";
import { derivePassword } from "./password.ts";
import { verifyPkce } from "./pkce.ts";
import {
	parseAuthorization,
	parseRegistration,
	parseTokenRequest,
} from "./requests.ts";
import type { ClientRow, Store } from "./store.ts";
import { userByName, USERS } from "./users.ts";

const MINUTE = 60_000;

export const LIMITS = {
	requestTtlMs: 5 * MINUTE,
	codeTtlMs: MINUTE,
	idTokenTtlS: 600,
	maxClients: 8,
	/** A client unused for this long may be evicted even if it once redeemed a code. */
	idleClientMs: 24 * 60 * MINUTE,
	registerPerIp: { limit: 5, windowMs: 10 * MINUTE },
	signInFailuresPerIp: { limit: 10, windowMs: 10 * MINUTE },
	maxBodyBytes: 16_384,
} as const;

export const HEALTH_PRODUCT = "tartan-e2e-idp";

export type IdpAppDeps = {
	readonly env: IdpEnv;
	readonly store: Store;
	readonly now: () => number;
	readonly random: Random;
};

const BASE_HEADERS: Readonly<Record<string, string>> = {
	"cache-control": "no-store",
	pragma: "no-cache",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
};

const json = (
	body: unknown,
	status = 200,
	extra: Record<string, string> = {},
): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: {
			...BASE_HEADERS,
			"content-type": "application/json",
			...extra,
		},
	});

const oauthError = (
	status: number,
	error: string,
	description: string,
): Response => json({ error, error_description: description }, status);

const cspFor = (config: IdpConfig | null): string => {
	const targets = config === null
		? ""
		: ` ${
			[...new Set(config.redirectUris.map((u) => new URL(u).origin))].join(
				" ",
			)
		}`;
	return `default-src 'none'; form-action 'self'${targets}; frame-ancestors 'none'; base-uri 'none'`;
};

const html = (
	body: string,
	status: number,
	config: IdpConfig | null,
): Response =>
	new Response(body, {
		status,
		headers: {
			...BASE_HEADERS,
			"content-type": "text/html; charset=utf-8",
			"content-security-policy": cspFor(config),
			"x-frame-options": "DENY",
		},
	});

const redirect = (location: string): Response =>
	new Response(null, {
		status: 303,
		headers: { ...BASE_HEADERS, location },
	});

/** Reads a small body; null when it is larger than `maxBodyBytes`. */
const readBody = async (request: Request): Promise<string | null> => {
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (declared > LIMITS.maxBodyBytes) return null;
	const text = await request.text();
	return utf8(text).byteLength > LIMITS.maxBodyBytes ? null : text;
};

const isForm = (request: Request): boolean =>
	(request.headers.get("content-type") ?? "").toLowerCase().startsWith(
		"application/x-www-form-urlencoded",
	);

const isJson = (request: Request): boolean =>
	(request.headers.get("content-type") ?? "").toLowerCase().startsWith(
		"application/json",
	);

const metadata = (issuer: string) => ({
	issuer,
	authorization_endpoint: `${issuer}/authorize`,
	token_endpoint: `${issuer}/token`,
	jwks_uri: `${issuer}/jwks`,
	registration_endpoint: `${issuer}/register`,
	end_session_endpoint: `${issuer}/logout`,
	scopes_supported: ["openid", "profile", "email", "groups"],
	response_types_supported: ["code"],
	response_modes_supported: ["query"],
	grant_types_supported: ["authorization_code"],
	subject_types_supported: ["public"],
	id_token_signing_alg_values_supported: ["RS256"],
	token_endpoint_auth_methods_supported: ["none"],
	code_challenge_methods_supported: ["S256"],
	authorization_response_iss_parameter_supported: true,
	request_parameter_supported: false,
	request_uri_parameter_supported: false,
	claims_supported: [
		"iss",
		"sub",
		"aud",
		"iat",
		"exp",
		"auth_time",
		"nonce",
		"preferred_username",
		"name",
		"email",
		"email_verified",
		"groups",
	],
});

const clientMetadata = (config: IdpConfig, client: ClientRow) => ({
	client_id: client.id,
	client_id_issued_at: Math.floor(client.createdAt / 1000),
	...(client.name === null ? {} : { client_name: client.name }),
	redirect_uris: [client.redirectUri],
	token_endpoint_auth_method: "none",
	grant_types: ["authorization_code"],
	response_types: ["code"],
	id_token_signed_response_alg: "RS256",
	registration_client_uri: `${config.issuer}/register/${client.id}`,
});

/**
 * Which client, if any, makes room for a new one: never-used clients first
 * (oldest first), then clients idle for `idleClientMs`. A client that
 * redeemed a code recently is never chosen, so registering many clients
 * cannot push the forge's client out.
 */
export const evictionCandidate = (
	clients: readonly ClientRow[],
	now: number,
): ClientRow | null => {
	const neverUsed = clients.filter((c) => c.lastUsedAt === null);
	if (neverUsed.length > 0) return neverUsed[0];
	const idle = clients.filter((c) =>
		c.lastUsedAt !== null && c.lastUsedAt + LIMITS.idleClientMs <= now
	).sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0));
	return idle[0] ?? null;
};

export const createIdpApp = (deps: IdpAppDeps) => {
	const { store } = deps;
	let cachedKey: { readonly raw: string; readonly key: SigningKey } | null =
		null;

	const signingKey = async (config: IdpConfig): Promise<SigningKey> => {
		const raw = JSON.stringify(config.signingJwk);
		if (cachedKey?.raw !== raw) {
			cachedKey = { raw, key: await importSigningKey(config.signingJwk) };
		}
		return cachedKey.key;
	};

	const clientAddress = async (
		config: IdpConfig,
		request: Request,
	): Promise<string> =>
		(await sha256Hex(
			`${config.seed}|${request.headers.get("cf-connecting-ip") ?? "unknown"}`,
		)).slice(0, 32);

	const bearerOf = (request: Request): string | null => {
		const m = /^Bearer\s+([A-Za-z0-9_-]{16,128})$/.exec(
			request.headers.get("authorization") ?? "",
		);
		return m === null ? null : m[1];
	};

	// -------------------------------------------------------------------------

	const health = (): Response => {
		const checked = loadConfig(deps.env);
		const clients = store.tx(() => store.clients().length);
		return json({
			product: HEALTH_PRODUCT,
			ok: checked.ok,
			users: USERS.length,
			clients,
			...(checked.ok ? {} : { reason: checked.reason }),
		});
	};

	const jwks = async (config: IdpConfig): Promise<Response> =>
		json({ keys: [(await signingKey(config)).publicJwk] });

	const register = async (
		config: IdpConfig,
		request: Request,
	): Promise<Response> => {
		if (!isJson(request)) {
			return oauthError(
				400,
				"invalid_client_metadata",
				"send application/json",
			);
		}
		const address = await clientAddress(config, request);
		const now = deps.now();
		const count = store.tx(() =>
			store.hit(
				`register:${address}`,
				LIMITS.registerPerIp.windowMs,
				now,
			)
		);
		if (count > LIMITS.registerPerIp.limit) {
			return oauthError(
				429,
				"invalid_client_metadata",
				"too many registrations from this address; try again later",
			);
		}
		const text = await readBody(request);
		if (text === null) {
			return oauthError(400, "invalid_client_metadata", "the body is too big");
		}
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			return oauthError(400, "invalid_client_metadata", "the body is not JSON");
		}
		const parsed = parseRegistration(body, config);
		if (!parsed.ok) return oauthError(400, parsed.error, parsed.reason);
		const token = randomToken(deps.random);
		const tokenHash = await sha256Hex(token);
		const client: ClientRow = {
			id: `c_${hex(deps.random(13))}`,
			redirectUri: parsed.value.redirectUri,
			name: parsed.value.clientName,
			tokenHash,
			createdAt: now,
			lastUsedAt: null,
		};
		const stored = store.tx(() => {
			const existing = store.clients();
			if (existing.length >= LIMITS.maxClients) {
				const victim = evictionCandidate(existing, now);
				if (victim === null) return false;
				store.deleteClient(victim.id);
			}
			store.insertClient(client);
			return true;
		});
		if (!stored) {
			return oauthError(
				429,
				"invalid_client_metadata",
				"every client slot holds a client in use; try again later",
			);
		}
		return json(
			{ ...clientMetadata(config, client), registration_access_token: token },
			201,
		);
	};

	const manageClient = async (
		config: IdpConfig,
		request: Request,
		clientId: string,
	): Promise<Response> => {
		const bearer = bearerOf(request);
		const presented = bearer === null ? null : await sha256Hex(bearer);
		const client = store.tx(() => store.client(clientId));
		if (
			client === null || presented === null ||
			!constantTimeEqual(utf8(presented), utf8(client.tokenHash))
		) {
			return oauthError(401, "invalid_token", "unknown client or token");
		}
		if (request.method === "GET") return json(clientMetadata(config, client));
		store.tx(() => store.deleteClient(client.id));
		return new Response(null, { status: 204, headers: BASE_HEADERS });
	};

	const refusePage = (config: IdpConfig, status: number, message: string) =>
		html(errorPage("Sign-in refused", message), status, config);

	const authorize = async (
		config: IdpConfig,
		url: URL,
	): Promise<Response> => {
		const parsed = parseAuthorization(url.searchParams);
		if (!parsed.ok) return refusePage(config, 400, parsed.reason);
		const p = parsed.value;
		const client = store.tx(() => store.client(p.clientId));
		if (client === null) {
			return refusePage(config, 400, "This client is not registered here.");
		}
		if (
			p.redirectUri !== client.redirectUri ||
			!redirectAllowed(config, p.redirectUri)
		) {
			return refusePage(
				config,
				400,
				"The redirect URI is not the one registered for this client.",
			);
		}
		const req = randomToken(deps.random);
		const reqHash = await sha256Hex(req);
		const now = deps.now();
		store.tx(() =>
			store.putRequest(reqHash, {
				clientId: p.clientId,
				redirectUri: p.redirectUri,
				state: p.state,
				nonce: p.nonce,
				challenge: p.challenge,
				scope: p.scope,
				expiresAt: now + LIMITS.requestTtlMs,
			})
		);
		return html(signInPage({ req }), 200, config);
	};

	const signIn = async (
		config: IdpConfig,
		request: Request,
	): Promise<Response> => {
		if (!isForm(request)) return refusePage(config, 400, "Send the form.");
		const address = await clientAddress(config, request);
		const failKey = `signin-fail:${address}`;
		const now = deps.now();
		const failures = store.tx(() =>
			store.peek(failKey, LIMITS.signInFailuresPerIp.windowMs, now)
		);
		if (failures >= LIMITS.signInFailuresPerIp.limit) {
			return refusePage(
				config,
				429,
				"Too many failed sign-ins from this address. Try again later.",
			);
		}
		const text = await readBody(request);
		if (text === null) return refusePage(config, 400, "The form is too big.");
		const form = new URLSearchParams(text);
		const one = (name: string): string =>
			form.getAll(name).length === 1 ? form.get(name) ?? "" : "";
		const req = one("req");
		const username = one("username");
		const password = one("password");
		const user = userByName(username);
		const expected = await derivePassword(
			config.seed,
			user?.username ?? "e2e-nobody",
		);
		const passwordOk = user !== undefined &&
			constantTimeEqual(utf8(password), utf8(expected));
		const reqHash = await sha256Hex(req);
		const pending = store.tx(() => {
			const r = store.takeRequest(reqHash, now);
			if (r === null) return null;
			const client = store.client(r.clientId);
			return client !== null && client.redirectUri === r.redirectUri ? r : null;
		});
		if (pending === null || !redirectAllowed(config, pending.redirectUri)) {
			return refusePage(
				config,
				400,
				"This sign-in request expired or was already used. Start again from the forge.",
			);
		}
		if (!passwordOk || user === undefined) {
			const retry = randomToken(deps.random);
			const retryHash = await sha256Hex(retry);
			store.tx(() => {
				store.hit(failKey, LIMITS.signInFailuresPerIp.windowMs, now);
				store.putRequest(retryHash, pending);
			});
			return html(
				signInPage({ req: retry, username, error: WRONG_PASSWORD }),
				401,
				config,
			);
		}
		const code = randomToken(deps.random);
		const codeHash = await sha256Hex(code);
		store.tx(() =>
			store.putCode(codeHash, {
				clientId: pending.clientId,
				redirectUri: pending.redirectUri,
				challenge: pending.challenge,
				nonce: pending.nonce,
				sub: user.sub,
				authTime: Math.floor(now / 1000),
				scope: pending.scope,
				expiresAt: now + LIMITS.codeTtlMs,
			})
		);
		const target = new URL(pending.redirectUri);
		target.searchParams.set("code", code);
		target.searchParams.set("state", pending.state);
		target.searchParams.set("iss", config.issuer);
		return redirect(target.href);
	};

	const token = async (
		config: IdpConfig,
		request: Request,
	): Promise<Response> => {
		if (!isForm(request)) {
			return oauthError(400, "invalid_request", "send a form body");
		}
		const text = await readBody(request);
		if (text === null) {
			return oauthError(400, "invalid_request", "the body is too big");
		}
		const form = new URLSearchParams(text);
		// Any code presented is spent, whatever the rest of the request says.
		const presented = form.getAll("code").filter((c) => c.length <= 256);
		const hashes = await Promise.all(presented.map((c) => sha256Hex(c)));
		const now = deps.now();
		const rows = store.tx(() => hashes.map((h) => store.takeCode(h, now)));
		const parsed = parseTokenRequest(
			form,
			request.headers.get("authorization"),
		);
		if (!parsed.ok) return oauthError(400, parsed.error, parsed.reason);
		const p = parsed.value;
		const row = rows[0] ?? null;
		const client = store.tx(() => store.client(p.clientId));
		if (
			row === null || client === null || row.clientId !== p.clientId ||
			p.redirectUri !== row.redirectUri ||
			p.redirectUri !== client.redirectUri ||
			!redirectAllowed(config, p.redirectUri)
		) {
			return oauthError(
				400,
				"invalid_grant",
				"the code is unknown, used, expired or not for this client",
			);
		}
		if (!(await verifyPkce(p.verifier, row.challenge))) {
			return oauthError(
				400,
				"invalid_grant",
				"the PKCE verifier does not match",
			);
		}
		const user = USERS.find((u) => u.sub === row.sub);
		if (user === undefined) {
			return oauthError(400, "invalid_grant", "unknown subject");
		}
		store.tx(() => store.markClientUsed(client.id, now));
		const iat = Math.floor(now / 1000);
		const idToken = await signJwt(await signingKey(config), {
			iss: config.issuer,
			sub: user.sub,
			aud: client.id,
			iat,
			exp: iat + LIMITS.idTokenTtlS,
			auth_time: row.authTime,
			nonce: row.nonce,
			preferred_username: user.username,
			name: user.name,
			email: user.email,
			email_verified: false,
			groups: [],
		});
		return json({
			access_token: randomToken(deps.random),
			token_type: "Bearer",
			expires_in: LIMITS.idTokenTtlS,
			id_token: idToken,
			scope: row.scope,
		});
	};

	const logout = (config: IdpConfig, url: URL): Response => {
		const target = url.searchParams.get("post_logout_redirect_uri");
		if (target !== null) {
			try {
				const origin = new URL(target).origin;
				const allowed = config.redirectUris.some((u) =>
					new URL(u).origin === origin
				);
				if (allowed) return redirect(new URL(target).href);
			} catch {
				// Not a URL: show the page.
			}
		}
		return html(signedOutPage(), 200, config);
	};

	const methodNotAllowed = (allow: string): Response =>
		json(
			{ error: "invalid_request", error_description: "method not allowed" },
			405,
			{
				allow,
			},
		);

	return async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const method = request.method;
		if (url.pathname === "/-/health") {
			return method === "GET" ? health() : methodNotAllowed("GET");
		}
		const checked = loadConfig(deps.env);
		if (!checked.ok) {
			// Fail closed: no redirect, no code, no token, no page with a form.
			return url.pathname === "/authorize" || url.pathname === "/logout"
				? html(
					errorPage(
						"Not configured",
						"This identity provider is not configured.",
					),
					500,
					null,
				)
				: oauthError(500, "server_error", "not configured");
		}
		const config = checked.value;
		if (url.origin !== config.issuer) {
			return json({ error: "not_found" }, 404);
		}
		const now = deps.now();
		store.tx(() => store.purgeExpired(now));
		const path = url.pathname;
		if (path === "/.well-known/openid-configuration") {
			return method === "GET"
				? json(metadata(config.issuer))
				: methodNotAllowed("GET");
		}
		if (path === "/jwks") {
			return method === "GET" ? await jwks(config) : methodNotAllowed("GET");
		}
		if (path === "/register") {
			return method === "POST"
				? await register(config, request)
				: methodNotAllowed("POST");
		}
		const managed = /^\/register\/(c_[0-9a-f]{26})$/.exec(path);
		if (managed !== null) {
			return method === "GET" || method === "DELETE"
				? await manageClient(config, request, managed[1])
				: methodNotAllowed("GET, DELETE");
		}
		if (path === "/authorize") {
			if (method === "GET") return await authorize(config, url);
			if (method === "POST") return await signIn(config, request);
			return methodNotAllowed("GET, POST");
		}
		if (path === "/token") {
			return method === "POST"
				? await token(config, request)
				: methodNotAllowed("POST");
		}
		if (path === "/logout") {
			return method === "GET" ? logout(config, url) : methodNotAllowed("GET");
		}
		return json({ error: "not_found" }, 404);
	};
};

export type IdpApp = ReturnType<typeof createIdpApp>;
