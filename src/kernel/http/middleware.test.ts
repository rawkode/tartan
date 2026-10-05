// The security middleware against the real route policies, with a fake ForgeDO:
// ordering, setup gating, host rules, authentication per policy (cookies never
// on git or MCP, never read when `Authorization` is present), token scopes,
// CSRF and headers. Pure Deno tests; the workerd e2e is
// `security.workers.test.ts`.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import type { AuthContext, RoutePolicy } from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import { POLICY, type RequestContext, type RouteInfo } from "../../router.ts";
import { createAuthenticate } from "./auth.ts";
import { SPA_CSP } from "./headers.ts";
import { resetIsolateState } from "./isolate.ts";
import { createSecurity, needsSetup, type SecurityDeps } from "./middleware.ts";
import { sha256Hex } from "../identity/crypto.ts";

const CANON = "https://code.example.com";
const TOKEN = `tpat_${"A".repeat(43)}`;
const SESSION = "s".repeat(43);

const SESSION_AUTH: AuthContext = {
	principal: "u_01k6aaaaaaaaaaaaaaaaaaaaaa",
	kind: "user",
	via: "session",
	scopes: [],
	nodeId: null,
	laneId: null,
	maxRole: 50,
	isAdmin: true,
};
const TOKEN_AUTH: AuthContext = {
	...SESSION_AUTH,
	via: "pat",
	tokenId: "tok_01k6aaaaaaaaaaaaaaaaaaaaaa",
	scopes: ["repo:read", "mcp"],
	maxRole: 30,
	isAdmin: false,
};

type Calls = { session: number; token: number };

const forgeWith = (
	state: {
		state: "fresh" | "unlocked" | "idp" | "done";
		canonicalOrigin?: string;
	},
	calls: Calls,
	options: { staleSession?: boolean } = {},
) => {
	const identity = {
		setupState: () => Promise.resolve({ ...state, rootKeyFallback: false }),
		session: async (hash: string) => {
			calls.session++;
			return !options.staleSession && hash === await sha256Hex(SESSION)
				? SESSION_AUTH
				: null;
		},
		token: async (hash: string) => {
			calls.token++;
			return hash === await sha256Hex(TOKEN) ? TOKEN_AUTH : null;
		},
	};
	return {
		FORGE: { getByName: () => ({ identity: () => identity }) },
	} as unknown as Env;
};

const route = (id: string, policy: RoutePolicy): RouteInfo => ({
	id,
	owner: "WP2",
	policy,
});

const run = async (
	env: Env,
	info: RouteInfo,
	req: Request,
	deps: Partial<SecurityDeps> = {},
) => {
	resetIsolateState();
	const seen: { auth: AuthContext | null }[] = [];
	const logs: string[] = [];
	const security = createSecurity({
		setupInfo: async (e) => {
			const dto = await (e.FORGE.getByName("forge").identity() as unknown as {
				setupState(): Promise<{ state: "fresh"; canonicalOrigin?: string }>;
			}).setupState();
			return { state: dto.state, canonicalOrigin: dto.canonicalOrigin ?? null };
		},
		authenticate: createAuthenticate,
		log: (m) => logs.push(m),
		...deps,
	});
	const c: RequestContext = {
		req,
		env,
		ctx: {} as ExecutionContext,
		url: new URL(req.url),
		params: {},
		route: info,
	};
	const response = await security(c, (auth) => {
		seen.push({ auth });
		return Promise.resolve(
			new Response("<!doctype html><p>ok</p>", {
				headers: { "content-type": "text/html" },
			}),
		);
	});
	return { response, seen, logs };
};

const done = (calls: Calls, options?: { staleSession?: boolean }) =>
	forgeWith({ state: "done", canonicalOrigin: CANON }, calls, options);

Deno.test("setup gating: HTML navigations go to /-/setup, everything else gets 503 setup_required", async () => {
	const calls = { session: 0, token: 0 };
	const env = forgeWith({ state: "unlocked" }, calls);
	const page = await run(
		env,
		route("spa.page", POLICY.browser),
		new Request(`${CANON}/acme`, {
			headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
		}),
	);
	equal(page.response.status, 302);
	equal(page.response.headers.get("location"), "/-/setup");
	const api = await run(
		env,
		route("api.me", POLICY.apiPublic),
		new Request(`${CANON}/-/api/me`),
	);
	equal(api.response.status, 503);
	equal(
		(await api.response.json() as { error: string }).error,
		"setup_required",
	);
	const cap = await run(
		env,
		route("cap.info-refs", POLICY.capability),
		new Request(`${CANON}/-/cap/v1/x`),
	);
	equal(cap.response.status, 503);
	for (
		const [id, policy] of [
			["health", POLICY.health],
			["setup.api", POLICY.setupApi],
			["auth.login", POLICY.authFlow],
			["spa.asset", POLICY.setupPage],
		] as const
	) {
		const r = await run(env, route(id, policy), new Request(`${CANON}/x`));
		equal(r.seen.length, 1, id);
	}
	equal(calls.session + calls.token, 0);
});

Deno.test("canonical host runs before setup gating: 308, 403 for git/MCP/capability, health anywhere", async () => {
	const calls = { session: 0, token: 0 };
	const env = forgeWith({ state: "unlocked", canonicalOrigin: CANON }, calls);
	const away = "https://tartan-dev.acct.workers.dev";
	const page = await run(
		env,
		route("spa.page", POLICY.browser),
		new Request(`${away}/acme?x=1`),
	);
	equal(page.response.status, 308);
	equal(page.response.headers.get("location"), `${CANON}/acme?x=1`);
	const git = await run(
		env,
		route("git.canonical.info-refs", POLICY.git),
		new Request(`${away}/a/b.git/info/refs`),
	);
	equal(git.response.status, 403);
	deepStrictEqual(await git.response.json(), {
		error: "denied",
		reason: "host",
		message: `use ${CANON}`,
	});
	equal(
		(await run(env, route("mcp", POLICY.mcp), new Request(`${away}/-/mcp`)))
			.response.status,
		403,
	);
	equal(
		(await run(
			env,
			route("cap.upload-pack", POLICY.capability),
			new Request(`${away}/-/cap/v1/x`),
		)).response.status,
		403,
	);
	equal(
		(await run(
			env,
			route("health", POLICY.health),
			new Request(`${away}/-/health`),
		)).seen.length,
		1,
	);
	// The wizard keeps working on the old host until the claim.
	equal(
		(await run(
			env,
			route("setup.api", POLICY.setupApi),
			new Request(`${away}/-/setup/status`, {
				method: "POST",
				headers: { "sec-fetch-site": "same-origin" },
			}),
		)).seen.length,
		1,
	);
});

Deno.test("cookies are never read on git or MCP, nor when Authorization is present", async () => {
	const calls = { session: 0, token: 0 };
	const env = done(calls);
	const cookie = `__Host-tartan-session=${SESSION}`;
	const git = await run(
		env,
		route("git.canonical.upload-pack", POLICY.git),
		new Request(`${CANON}/a/b.git/git-upload-pack`, {
			method: "POST",
			headers: { cookie },
		}),
	);
	deepStrictEqual(git.seen, [{ auth: null }]);
	const mcp = await run(
		env,
		route("mcp", POLICY.mcp),
		new Request(`${CANON}/-/mcp`, { method: "POST", headers: { cookie } }),
	);
	equal(mcp.response.status, 401);
	equal(mcp.response.headers.get("www-authenticate"), 'Bearer realm="Tartan"');
	const both = await run(
		env,
		route("api.tokens", POLICY.api),
		new Request(`${CANON}/-/api/tokens`, {
			headers: { cookie, authorization: `Bearer ${TOKEN.replace("A", "B")}` },
		}),
	);
	equal(both.response.status, 401);
	equal(calls.session, 0);
	const browser = await run(
		env,
		route("auth.logout", POLICY.browser),
		new Request(`${CANON}/-/auth/logout`, {
			method: "POST",
			headers: {
				cookie,
				authorization: `Bearer ${TOKEN}`,
				origin: "https://evil.example.net",
			},
		}),
	);
	// A cookie-only route with Authorization present: the cookie is ignored and the caller is anonymous.
	deepStrictEqual(browser.seen, [{ auth: null }]);
	equal(calls.session, 0);
});

Deno.test("git: a Basic password token authenticates; a bad one is 401 with a Basic challenge", async () => {
	const calls = { session: 0, token: 0 };
	const env = done(calls);
	const ok1 = await run(
		env,
		route("git.canonical.info-refs", POLICY.git),
		new Request(`${CANON}/a/b.git/info/refs`, {
			headers: { authorization: `Basic ${btoa(`agent:${TOKEN}`)}` },
		}),
	);
	deepStrictEqual(ok1.seen, [{ auth: TOKEN_AUTH }]);
	const bad = await run(
		env,
		route("git.canonical.info-refs", POLICY.git),
		new Request(`${CANON}/a/b.git/info/refs`, {
			headers: {
				authorization: `Basic ${btoa(`agent:tpat_${"z".repeat(43)}`)}`,
			},
		}),
	);
	equal(bad.response.status, 401);
	equal(
		bad.response.headers.get("www-authenticate"),
		'Basic realm="Tartan", charset="UTF-8"',
	);
});

Deno.test("API: 401 without a caller, a session passes, a token needs the api scope", async () => {
	const calls = { session: 0, token: 0 };
	const env = done(calls);
	equal(
		(await run(
			env,
			route("api.tokens", POLICY.api),
			new Request(`${CANON}/-/api/tokens`),
		)).response.status,
		401,
	);
	const session = await run(
		env,
		route("api.tokens", POLICY.api),
		new Request(`${CANON}/-/api/tokens`, {
			headers: { cookie: `__Host-tartan-session=${SESSION}` },
		}),
	);
	deepStrictEqual(session.seen, [{ auth: SESSION_AUTH }]);
	const token = await run(
		env,
		route("api.tokens", POLICY.api),
		new Request(`${CANON}/-/api/tokens`, {
			headers: { authorization: `Bearer ${TOKEN}` },
		}),
	);
	equal(token.response.status, 403);
	deepStrictEqual(await token.response.json(), {
		error: "denied",
		reason: "scopes",
		message: "this token lacks the api scope",
	});
	const mcp = await run(
		env,
		route("mcp", POLICY.mcp),
		new Request(`${CANON}/-/mcp`, {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}` },
		}),
	);
	deepStrictEqual(mcp.seen, [{ auth: TOKEN_AUTH }]);
});

Deno.test("a stale session cookie: anonymous (and cleared) where anonymous is allowed, 401 elsewhere", async () => {
	const calls = { session: 0, token: 0 };
	const env = done(calls, { staleSession: true });
	const cookie = `__Host-tartan-session=${SESSION}`;
	const page = await run(
		env,
		route("spa.page", POLICY.browser),
		new Request(`${CANON}/acme`, { headers: { cookie } }),
	);
	deepStrictEqual(page.seen, [{ auth: null }]);
	ok(
		(page.response.headers.get("set-cookie") ?? "").startsWith(
			"__Host-tartan-session=; Max-Age=0",
		),
	);
	const api = await run(
		env,
		route("api.tokens", POLICY.api),
		new Request(`${CANON}/-/api/tokens`, { headers: { cookie } }),
	);
	equal(api.response.status, 401);
});

Deno.test("CSRF through the middleware: cookie writes need same-origin; bearer writes are immune", async () => {
	const calls = { session: 0, token: 0 };
	const env = done(calls);
	const cookie = `__Host-tartan-session=${SESSION}`;
	const write = (headers: Record<string, string>) =>
		new Request(`${CANON}/-/api/invites`, {
			method: "POST",
			headers: { cookie, "content-type": "application/json", ...headers },
			body: "{}",
		});
	for (const site of ["cross-site", "same-site", "none"]) {
		const r = await run(
			env,
			route("api.invites", POLICY.api),
			write({ "sec-fetch-site": site }),
		);
		equal(r.response.status, 403, site);
		equal(r.seen.length, 0, site);
	}
	equal(
		(await run(
			env,
			route("api.invites", POLICY.api),
			write({ origin: "https://evil.example.net" }),
		)).response.status,
		403,
	);
	equal(
		(await run(
			env,
			route("api.invites", POLICY.api),
			write({ "sec-fetch-site": "same-origin" }),
		)).seen.length,
		1,
	);
	equal(
		(await run(env, route("api.invites", POLICY.api), write({ origin: CANON })))
			.seen.length,
		1,
	);
	const bearer = new Request(`${CANON}/-/mcp`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${TOKEN}`,
			"sec-fetch-site": "cross-site",
			"content-type": "text/plain",
		},
		body: "x",
	});
	equal((await run(env, route("mcp", POLICY.mcp), bearer)).seen.length, 1);
	// Safe methods are not checked.
	equal(
		(await run(
			env,
			route("api.tokens", POLICY.api),
			new Request(`${CANON}/-/api/tokens`, {
				headers: { cookie, "sec-fetch-site": "cross-site" },
			}),
		)).seen.length,
		1,
	);
});

Deno.test("security headers on every answer; handler headers win; errors are JSON with headers", async () => {
	const calls = { session: 0, token: 0 };
	const env = done(calls);
	const page = await run(
		env,
		route("spa.page", POLICY.browser),
		new Request(`${CANON}/acme`),
	);
	const h = page.response.headers;
	equal(h.get("content-security-policy"), SPA_CSP);
	equal(h.get("x-content-type-options"), "nosniff");
	equal(h.get("referrer-policy"), "same-origin");
	equal(h.get("x-frame-options"), "DENY");
	equal(h.get("cache-control"), "no-store");
	ok((h.get("strict-transport-security") ?? "").startsWith("max-age="));
	const asset = await run(
		env,
		route("spa.asset", POLICY.setupPage),
		new Request(`${CANON}/assets/app.js`),
	);
	equal(asset.response.headers.get("cache-control"), null);
	const failing = createSecurity({
		setupInfo: () => Promise.resolve({ state: "done", canonicalOrigin: CANON }),
		authenticate: createAuthenticate,
		log: () => {},
	});
	const r = await failing(
		{
			req: new Request(`${CANON}/-/health`),
			env,
			ctx: {} as ExecutionContext,
			url: new URL(`${CANON}/-/health`),
			params: {},
			route: route("health", POLICY.health),
		},
		() => Promise.reject(new Error("secret detail")),
	);
	equal(r.status, 500);
	deepStrictEqual(await r.json(), {
		error: "internal",
		message: "internal error",
	});
	equal(r.headers.get("x-content-type-options"), "nosniff");
});

Deno.test("ForgeDO unreachable: exempt routes still answer, others 503", async () => {
	const deps = { setupInfo: () => Promise.reject(new Error("down")) };
	const calls = { session: 0, token: 0 };
	const env = done(calls);
	equal(
		(await run(
			env,
			route("health", POLICY.health),
			new Request(`${CANON}/-/health`),
			deps,
		)).seen.length,
		1,
	);
	const api = await run(
		env,
		route("api.me", POLICY.apiPublic),
		new Request(`${CANON}/-/api/me`),
		deps,
	);
	equal(api.response.status, 503);
	equal((await api.response.json() as { error: string }).error, "unavailable");
});

Deno.test("a stalled setup read never holds health or the deploy-script endpoints; gated routes still wait for it", async () => {
	let reads = 0;
	const stalled = {
		setupInfo: () => {
			reads++;
			return new Promise<never>(() => {});
		},
	};
	const within = async (work: Promise<unknown>): Promise<string> => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const waiting = new Promise<string>((r) => {
			timer = setTimeout(() => r("waiting"), 50);
		});
		try {
			return await Promise.race([work.then(() => "answered"), waiting]);
		} finally {
			clearTimeout(timer);
		}
	};
	const env = done({ session: 0, token: 0 });
	for (
		const [id, policy, path] of [
			["health", POLICY.health, "/-/health"],
			["health.warm", POLICY.deployScript, "/-/health/warm"],
			["unrouted", POLICY.unrouted, "/-/nothing"],
		] as const
	) {
		equal(
			await within(
				run(env, route(id, policy), new Request(`${CANON}${path}`), stalled),
			),
			"answered",
			`${id} is served without waiting for the setup read`,
		);
	}
	equal(reads, 0, "no setup read for routes that need no setup state");
	for (
		const policy of [
			POLICY.authFlow,
			POLICY.setupApi,
			POLICY.setupPage,
			POLICY.browser,
			POLICY.apiPublic,
		]
	) {
		ok(needsSetup(policy), "gated, host-redirect and CSRF routes read it");
	}
	equal(
		await within(
			run(
				env,
				route("api.me", POLICY.apiPublic),
				new Request(`${CANON}/-/api/me`),
				stalled,
			),
		),
		"waiting",
		"a gated route waits for the setup read",
	);
	equal(reads, 1);
});
