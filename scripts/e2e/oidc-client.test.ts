// The launcher's headless sign-in against the real mock IdP handler and a
// fake forge that runs Tartan's own relying-party code (read-only imports
// from src/kernel/identity) the way /-/auth/login and /-/auth/callback do.

import { deepStrictEqual, equal, match, ok, rejects } from "node:assert/strict";
import {
	registerClient,
	registrationRequest,
} from "../../src/kernel/identity/dcr.ts";
import {
	type AuthorizationServer,
	authorizationUrl,
	discover,
	exchangeCode,
	pkcePair,
	randomNonce,
	randomState,
} from "../../src/kernel/identity/oidc.ts";
import { createGuardedFetch } from "../../src/kernel/identity/ssrf.ts";
import {
	CALLBACK,
	createHarness,
	FORGE,
	ISSUER,
} from "../../tools/mock-idp/src/testing/harness.ts";
import {
	type FetchLike,
	SignInError,
	signInHeadless,
	signOut,
} from "./oidc-client.ts";

type Txn = {
	verifier: string;
	nonce: string;
	binding: string;
	invite: string | null;
};

const createFakeForge = async (idpFetch: FetchLike) => {
	const guarded = createGuardedFetch(idpFetch);
	const as: AuthorizationServer = await discover(ISSUER, guarded);
	const client = await registerClient(
		as.registration_endpoint as string,
		registrationRequest({
			forgeName: "Tartan e2e",
			redirectUri: CALLBACK,
			scope: "openid profile email groups",
		}),
		{ fetch: guarded, now: Date.now() },
	);
	const txns = new Map<string, Txn>();
	const accounts = new Set(["e2e-owner"]);
	const sessions = new Set<string>();
	const invites = new Set(["invite-code-0123456789"]);
	let redirectTo: string | null = null;

	const handle = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		if (url.pathname === "/-/auth/login") {
			const state = randomState();
			const pkce = await pkcePair();
			const nonce = randomNonce();
			const binding = crypto.randomUUID();
			txns.set(state, {
				verifier: pkce.verifier,
				nonce,
				binding,
				invite: url.searchParams.get("invite"),
			});
			const location = redirectTo ?? authorizationUrl(as, {
				clientId: client.clientId,
				redirectUri: CALLBACK,
				scope: "openid profile email groups",
				state,
				nonce,
				codeChallenge: pkce.challenge,
			}).href;
			return new Response(null, {
				status: 302,
				headers: {
					location,
					"set-cookie":
						`__Host-tartan-login-abc123=${binding}; Path=/; Secure; HttpOnly`,
				},
			});
		}
		if (url.pathname === "/-/auth/callback") {
			const state = url.searchParams.get("state") ?? "";
			const txn = txns.get(state);
			txns.delete(state);
			const cookie = request.headers.get("cookie") ?? "";
			if (txn === undefined || !cookie.includes(`=${txn.binding}`)) {
				return new Response("Sign-in expired", { status: 400 });
			}
			const claims = await exchangeCode({
				as,
				rp: {
					clientId: client.clientId,
					clientAuth: "none",
					idTokenAlg: "RS256",
				},
				callback: url,
				redirectUri: CALLBACK,
				state,
				codeVerifier: txn.verifier,
				nonce: txn.nonce,
				verifySignature: true,
				fetch: guarded,
			});
			const handle = String(claims.preferred_username);
			if (txn.invite !== null && invites.delete(txn.invite)) {
				accounts.add(handle);
			}
			if (!accounts.has(handle)) {
				return new Response(
					"You signed in, but this forge has no account for you.",
					{ status: 403 },
				);
			}
			const session = crypto.randomUUID().replaceAll("-", "");
			sessions.add(session);
			return new Response(null, {
				status: 303,
				headers: {
					location: "/",
					"set-cookie":
						`__Host-tartan-session=${session}; Path=/; Secure; HttpOnly`,
				},
			});
		}
		if (url.pathname === "/-/auth/logout" && request.method === "POST") {
			if (request.headers.get("origin") !== FORGE) {
				return new Response("csrf", { status: 403 });
			}
			const m = /__Host-tartan-session=([^;]+)/.exec(
				request.headers.get("cookie") ?? "",
			);
			if (m !== null) sessions.delete(m[1]);
			return Response.json({ ok: true });
		}
		return new Response("not found", { status: 404 });
	};

	return {
		handle,
		sessions,
		accounts,
		redirectElsewhere: (to: string) => {
			redirectTo = to;
		},
	};
};

const setup = async () => {
	const h = await createHarness();
	const requested: string[] = [];
	let forge: Awaited<ReturnType<typeof createFakeForge>> | null = null;
	const fetchFn: FetchLike = (input, init) => {
		const request = input instanceof Request ? input : new Request(input, init);
		requested.push(`${request.method} ${new URL(request.url).origin}`);
		const origin = new URL(request.url).origin;
		if (origin === ISSUER) return h.app(request);
		if (origin === FORGE && forge !== null) return forge.handle(request);
		return Promise.resolve(new Response("unreachable", { status: 599 }));
	};
	forge = await createFakeForge(h.fetch);
	return { h, forge, fetchFn, requested };
};

Deno.test("headless sign-in returns the forge session and signs out again", async () => {
	const { h, forge, fetchFn } = await setup();
	const session = await signInHeadless(fetchFn, {
		forge: FORGE,
		issuer: ISSUER,
		username: "e2e-owner",
		password: await h.password("e2e-owner"),
	});
	ok(forge.sessions.has(session));
	ok(await signOut(fetchFn, FORGE, session));
	equal(forge.sessions.has(session), false);
});

Deno.test("an invite turns 'no account' into a session", async () => {
	const { h, forge, fetchFn } = await setup();
	const password = await h.password("e2e-developer");
	const input = {
		forge: FORGE,
		issuer: ISSUER,
		username: "e2e-developer",
		password,
	};
	const refused = await signInHeadless(fetchFn, input).catch((e) => e);
	ok(refused instanceof SignInError);
	equal(refused.failure, "no-account");
	const session = await signInHeadless(fetchFn, {
		...input,
		invite: "invite-code-0123456789",
	});
	ok(forge.sessions.has(session));
	ok(forge.accounts.has("e2e-developer"));
});

Deno.test("a wrong password is reported as such, without the password", async () => {
	const { fetchFn } = await setup();
	const error = await signInHeadless(fetchFn, {
		forge: FORGE,
		issuer: ISSUER,
		username: "e2e-owner",
		password: "wrong-password-0123456789",
	}).catch((e) => e);
	ok(error instanceof SignInError);
	equal(error.failure, "wrong-password");
	equal(String(error.message).includes("wrong-password-0123456789"), false);
});

Deno.test("a redirect to anything but the mock IdP stops before a password is sent", async () => {
	const { h, forge, fetchFn, requested } = await setup();
	forge.redirectElsewhere("https://evil.test/authorize?x=1");
	await rejects(
		signInHeadless(fetchFn, {
			forge: FORGE,
			issuer: ISSUER,
			username: "e2e-owner",
			password: await h.password("e2e-owner"),
		}),
		SignInError,
	);
	equal(requested.some((r) => r.includes("evil.test")), false);
	forge.redirectElsewhere(`${ISSUER}/register`);
	await rejects(
		signInHeadless(fetchFn, {
			forge: FORGE,
			issuer: ISSUER,
			username: "e2e-owner",
			password: await h.password("e2e-owner"),
		}),
		SignInError,
	);
	equal(requested.filter((r) => r.startsWith("POST")).length, 0);
});

Deno.test("only dev-e2e and mock IdP origins are accepted as inputs", async () => {
	const { fetchFn } = await setup();
	await rejects(
		signInHeadless(fetchFn, {
			forge: "https://code.rawkode.academy",
			issuer: ISSUER,
			username: "e2e-owner",
			password: "x".repeat(43),
		}),
	);
	await rejects(
		signInHeadless(fetchFn, {
			forge: FORGE,
			issuer: "https://id.rawkode.academy",
			username: "e2e-owner",
			password: "x".repeat(43),
		}),
	);
});

Deno.test("a login start that meets a just-deployed forge (500, 503) is retried before any password is sent", async () => {
	const { h, forge, fetchFn } = await setup();
	let resets = 2;
	const flaky: FetchLike = (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.pathname === "/-/auth/login" && resets > 0) {
			resets -= 1;
			return Promise.resolve(
				Response.json({ error: "internal" }, { status: resets ? 500 : 503 }),
			);
		}
		return fetchFn(input, init);
	};
	const slept: number[] = [];
	const session = await signInHeadless(flaky, {
		forge: FORGE,
		issuer: ISSUER,
		username: "e2e-owner",
		password: await h.password("e2e-owner"),
		loginBackoffMs: [5, 7, 9],
		sleep: (ms) => {
			slept.push(ms);
			return Promise.resolve();
		},
	});
	ok(forge.sessions.has(session));
	deepStrictEqual(slept, [5, 7]);
	resets = 10;
	const error = await signInHeadless(flaky, {
		forge: FORGE,
		issuer: ISSUER,
		username: "e2e-owner",
		password: await h.password("e2e-owner"),
		loginBackoffMs: [1],
		sleep: () => Promise.resolve(),
	}).catch((e: Error) => e);
	match(String(error), /login: HTTP 50[03]/);
});
