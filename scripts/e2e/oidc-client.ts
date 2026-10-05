// Headless sign-in to the dev-e2e forge through the mock IdP, for the
// launcher's provisioning (the browser suites sign in through the real UI in
// `e2e/tests/auth.setup.e2e.ts`; this is a second, fetch-only client of the
// same flow, so drift shows up as a provisioning failure naming its step).
//
//   1. GET  <forge>/-/auth/login?return_to=/[&invite=…]   302 → IdP /authorize
//   2. GET  <IdP>/authorize?…                              200 sign-in form
//   3. POST <IdP>/authorize (req, username, password)      303 → forge callback
//   4. GET  <forge>/-/auth/callback?code&state&iss          303 + session cookie
//
// Redirects are never followed automatically (`redirect: "manual"`): every
// Location must be on the forge origin or exactly the IdP's `/authorize`, or
// the client stops before it sends a password anywhere. Forge cookies are
// sent only to the forge. Errors name the step and the HTTP status, never a
// cookie, code or password.

import { COOKIE } from "@tartan/contract";
import { assertForgeOrigin, assertIdpOrigin } from "./guards.ts";

export type SignInFailure = "no-account" | "wrong-password" | "protocol";

export class SignInError extends Error {
	override name = "SignInError";
	constructor(
		readonly step: string,
		detail: string,
		readonly failure: SignInFailure = "protocol",
	) {
		super(`headless sign-in, ${step}: ${detail}`);
	}
}

export type SignInInput = {
	readonly forge: string;
	readonly issuer: string;
	readonly username: string;
	readonly password: string;
	/** The code of an invite link (`/-/invite/<code>`). */
	readonly invite?: string;
	/** Tests: the pauses before retrying a 500/503 login start, and the clock. */
	readonly loginBackoffMs?: readonly number[];
	readonly sleep?: (ms: number) => Promise<void>;
};

export type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

const NO_ACCOUNT = "has no account for you";

/** `name=value` pairs of the Set-Cookie headers (attributes dropped). */
const setCookies = (response: Response): Map<string, string> => {
	const out = new Map<string, string>();
	for (const line of response.headers.getSetCookie()) {
		const pair = line.split(";")[0];
		const eq = pair.indexOf("=");
		if (eq > 0) out.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
	}
	return out;
};

const cookieHeader = (jar: Map<string, string>): string =>
	[...jar].filter(([, v]) => v !== "").map(([k, v]) => `${k}=${v}`).join("; ");

/** Pauses before retrying a login start that got 500 or 503. */
export const LOGIN_BACKOFF_MS = [1_000, 3_000, 10_000] as const;

export const signInHeadless = async (
	fetchFn: FetchLike,
	input: SignInInput,
): Promise<string> => {
	const forge = assertForgeOrigin(input.forge);
	const issuer = assertIdpOrigin(input.issuer);
	const jar = new Map<string, string>();

	const location = (response: Response, step: string, base: string): URL => {
		const raw = response.headers.get("location");
		if (raw === null) {
			throw new SignInError(step, `HTTP ${response.status} without a redirect`);
		}
		return new URL(raw, base);
	};

	// 1. The forge starts a login transaction and sends us to the IdP.
	const start = new URL(`${forge}/-/auth/login`);
	start.searchParams.set("return_to", "/");
	if (input.invite !== undefined) {
		start.searchParams.set("invite", input.invite);
	}
	// A forge that just deployed answers its first requests with a Durable
	// Object reset ("its code was updated", 500) or 503: nothing secret has
	// been sent yet, so the start is retried with backoff.
	const sleep = input.sleep ??
		((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	let login = await fetchFn(start, { redirect: "manual" });
	for (const pause of input.loginBackoffMs ?? LOGIN_BACKOFF_MS) {
		if (login.status !== 500 && login.status !== 503) break;
		await login.body?.cancel();
		await sleep(pause);
		login = await fetchFn(start, { redirect: "manual" });
	}
	await login.body?.cancel();
	if (login.status !== 302) {
		throw new SignInError("login", `HTTP ${login.status}`);
	}
	for (const [k, v] of setCookies(login)) jar.set(k, v);
	const authorize = location(login, "login", forge);
	if (authorize.origin !== issuer || authorize.pathname !== "/authorize") {
		throw new SignInError(
			"login",
			"the forge redirected somewhere other than the mock IdP's /authorize",
		);
	}

	// 2. The IdP's sign-in form (no cookies are sent to the IdP).
	const page = await fetchFn(authorize, { redirect: "manual" });
	const html = await page.text();
	if (page.status !== 200) {
		throw new SignInError("authorize", `HTTP ${page.status}`);
	}
	const req = /name="req" value="([A-Za-z0-9_-]{43})"/.exec(html)?.[1];
	if (req === undefined) {
		throw new SignInError("authorize", "the sign-in form has no request id");
	}

	// 3. Sign in; the IdP answers with a redirect to the forge callback.
	const signIn = await fetchFn(`${issuer}/authorize`, {
		method: "POST",
		redirect: "manual",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			req,
			username: input.username,
			password: input.password,
		}).toString(),
	});
	await signIn.body?.cancel();
	if (signIn.status === 401) {
		throw new SignInError(
			"sign-in",
			"the IdP refused the password",
			"wrong-password",
		);
	}
	if (signIn.status !== 303) {
		throw new SignInError("sign-in", `HTTP ${signIn.status}`);
	}
	const callback = location(signIn, "sign-in", issuer);
	if (callback.origin !== forge || callback.pathname !== "/-/auth/callback") {
		throw new SignInError(
			"sign-in",
			"the IdP redirected somewhere other than the forge callback",
		);
	}

	// 4. The forge redeems the code and sets the session cookie.
	const done = await fetchFn(callback, {
		redirect: "manual",
		headers: { cookie: cookieHeader(jar) },
	});
	const body = await done.text();
	if (done.status === 403 && body.includes(NO_ACCOUNT)) {
		throw new SignInError(
			"callback",
			"the forge has no account for this user",
			"no-account",
		);
	}
	if (done.status !== 303) {
		throw new SignInError("callback", `HTTP ${done.status}`);
	}
	const target = location(done, "callback", forge);
	if (target.origin !== forge) {
		throw new SignInError("callback", "the forge redirected off its origin");
	}
	const session = setCookies(done).get(COOKIE.session);
	if (session === undefined || session === "") {
		throw new SignInError("callback", "no session cookie was set");
	}
	return session;
};

/** Ends a forge session (`POST /-/auth/logout`, same-origin). */
export const signOut = async (
	fetchFn: FetchLike,
	forge: string,
	session: string,
): Promise<boolean> => {
	const response = await fetchFn(`${assertForgeOrigin(forge)}/-/auth/logout`, {
		method: "POST",
		redirect: "manual",
		headers: {
			cookie: `${COOKIE.session}=${session}`,
			origin: forge,
		},
	});
	await response.body?.cancel();
	return response.status === 200;
};
