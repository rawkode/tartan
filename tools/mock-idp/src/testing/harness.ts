// Test harness of the e2e mock IdP (Deno only, never imported by the
// Worker): the app over a `node:sqlite` stand-in for Durable Object storage,
// a movable clock, a generated seed and signing key, and helpers that walk
// the browser half of the authorization code flow.

import { DatabaseSync } from "node:sqlite";
import { createIdpApp, type IdpApp } from "../app.ts";
import type { IdpEnv } from "../config.ts";
import { b64url, cryptoRandom, sha256 } from "../encoding.ts";
import { generateSigningJwk, type SigningJwk } from "../jwt.ts";
import { derivePassword } from "../password.ts";
import { createStore, type StorageLike, type Store } from "../store.ts";

export const ISSUER = "https://tartan-e2e--idp.e2e-test.workers.dev";
export const FORGE = "https://tartan-dev-e2e.e2e-test.workers.dev";
export const CALLBACK = `${FORGE}/-/auth/callback`;

/** A parsed JSON body in a test (shape asserted field by field). */
// deno-lint-ignore no-explicit-any
export type Json = any;
export const jsonOf = async (response: Response): Promise<Json> =>
	await response.json();

export const createSqliteStorage = (): StorageLike => {
	const db = new DatabaseSync(":memory:");
	let depth = 0;
	return {
		sql: {
			exec: (query, ...bindings) => {
				const statement = db.prepare(query);
				if (/^\s*(select)/i.test(query)) {
					const rows = statement.all(...bindings) as Record<string, unknown>[];
					return { toArray: () => rows.map((r) => ({ ...r })) };
				}
				statement.run(...bindings);
				return { toArray: () => [] };
			},
		},
		transactionSync: <T>(fn: () => T): T => {
			const savepoint = `sp_${depth}`;
			db.exec(depth === 0 ? "BEGIN" : `SAVEPOINT ${savepoint}`);
			depth++;
			try {
				const result = fn();
				depth--;
				db.exec(depth === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
				return result;
			} catch (error) {
				depth--;
				db.exec(
					depth === 0
						? "ROLLBACK"
						: `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`,
				);
				throw error;
			}
		},
	};
};

let sharedJwk: Promise<SigningJwk> | null = null;
/** One RSA key for the whole test process (generation takes a moment). */
export const testJwk = (): Promise<SigningJwk> =>
	sharedJwk ??= generateSigningJwk();

export const newSeed = (): string => b64url(cryptoRandom(32));

export type Harness = {
	readonly app: IdpApp;
	readonly env: { -readonly [K in keyof IdpEnv]: IdpEnv[K] };
	readonly store: Store;
	readonly clock: { now: number };
	readonly seed: string;
	readonly jwk: SigningJwk;
	/** `fetch` against the app (only the issuer origin answers). */
	readonly fetch: (
		input: string | URL | Request,
		init?: RequestInit,
	) => Promise<Response>;
	readonly password: (username: string) => Promise<string>;
};

export const createHarness = async (
	overrides: Partial<IdpEnv> = {},
): Promise<Harness> => {
	const seed = newSeed();
	const jwk = await testJwk();
	const env: Harness["env"] = {
		ISSUER,
		ALLOWED_REDIRECT_URIS: JSON.stringify([CALLBACK]),
		E2E_IDP_SEED: seed,
		E2E_IDP_SIGNING_JWK: JSON.stringify(jwk),
		...overrides,
	};
	const store = createStore(createSqliteStorage());
	// Real time: Tartan's relying party (conformance test) checks `iat`/`exp`
	// against the wall clock. Tests move it forward to expire things.
	const clock = { now: Date.now() };
	const app = createIdpApp({
		env,
		store,
		now: () => clock.now,
		random: cryptoRandom,
	});
	const fetchFn = (input: string | URL | Request, init?: RequestInit) =>
		app(input instanceof Request ? input : new Request(input, init));
	return {
		app,
		env,
		store,
		clock,
		seed,
		jwk,
		fetch: fetchFn,
		password: (username) => derivePassword(seed, username),
	};
};

/** Registers a public client the way Tartan's DCR does. */
export const registerClient = async (
	h: Harness,
	options: { readonly ip?: string; readonly redirect?: string } = {},
): Promise<{ clientId: string; token: string; uri: string }> => {
	const response = await h.fetch(`${ISSUER}/register`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"cf-connecting-ip": options.ip ?? "192.0.2.1",
		},
		body: JSON.stringify({
			client_name: "Tartan (e2e)",
			redirect_uris: [options.redirect ?? CALLBACK],
			grant_types: ["authorization_code"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
			id_token_signed_response_alg: "RS256",
			scope: "openid profile email groups",
		}),
	});
	if (response.status !== 201) {
		throw new Error(`registration failed: ${response.status}`);
	}
	const body = await jsonOf(response);
	return {
		clientId: body.client_id,
		token: body.registration_access_token,
		uri: body.registration_client_uri,
	};
};

export const pkce = async (): Promise<
	{ verifier: string; challenge: string }
> => {
	const verifier = b64url(cryptoRandom(32));
	return { verifier, challenge: b64url(await sha256(verifier)) };
};

export const authorizeUrl = (
	clientId: string,
	challenge: string,
	extra: Record<string, string> = {},
): string => {
	const url = new URL(`${ISSUER}/authorize`);
	const params: Record<string, string> = {
		response_type: "code",
		client_id: clientId,
		redirect_uri: CALLBACK,
		scope: "openid profile email groups",
		state: "state-0123456789",
		nonce: "nonce-0123456789",
		code_challenge: challenge,
		code_challenge_method: "S256",
		...extra,
	};
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	return url.href;
};

/** The hidden `req` of a sign-in page. */
export const reqOf = (html: string): string => {
	const m = /name="req" value="([A-Za-z0-9_-]{43})"/.exec(html);
	if (m === null) throw new Error("no req field on the page");
	return m[1];
};

export const postSignIn = (
	h: Harness,
	req: string,
	username: string,
	password: string,
	ip = "192.0.2.1",
): Promise<Response> =>
	h.fetch(`${ISSUER}/authorize`, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			"cf-connecting-ip": ip,
		},
		body: new URLSearchParams({ req, username, password }).toString(),
	});

/** Authorize, sign in as `username` and return the code from the redirect. */
export const codeFor = async (
	h: Harness,
	clientId: string,
	challenge: string,
	username = "e2e-owner",
): Promise<string> => {
	const page = await (await h.fetch(authorizeUrl(clientId, challenge))).text();
	const response = await postSignIn(
		h,
		reqOf(page),
		username,
		await h.password(username),
	);
	if (response.status !== 303) {
		throw new Error(`sign-in failed: ${response.status}`);
	}
	const location = new URL(response.headers.get("location") ?? "");
	return location.searchParams.get("code") ?? "";
};

export const redeem = (
	h: Harness,
	fields: Record<string, string>,
): Promise<Response> =>
	h.fetch(`${ISSUER}/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			redirect_uri: CALLBACK,
			...fields,
		}).toString(),
	});
