// HTTP security middleware (WP2). `src/router.ts` runs every request through
// `withSecurity` with its route's `RoutePolicy` (routes, 404/405 answers and
// the SPA fall-through), in this order:
//
// 1. canonical host: 308 / 403 `denied("host")` / served anywhere
//    (`host.ts`);
// 2. setup gating while `setup_state ≠ done`, unless `setupExempt`: HTML
//    navigations get 302 `/-/setup`, everything else 503 `setup_required`;
//    the state comes from the isolate cache (≤ 1 ForgeDO call per isolate
//    per 10 s), so forged traffic, on the capability route too, never
//    drives ForgeDO; a setup-exempt route served on any host without CSRF
//    (health, the deploy-script endpoints, 404/405) skips the read
//    (`needsSetup`), so a slow ForgeDO never holds it;
// 3. authentication with `createAuthenticate(env)` per `policy.auth`: 401
//    when `anonymous` is false and there is no caller; a token needs
//    `policy.tokenScope` (`denied("scopes")`). A stale session cookie on a
//    route that serves anonymous callers is dropped (and cleared), not a 401;
// 4. CSRF when `policy.csrf`, for unsafe methods and WebSocket upgrades not
//    carrying `Authorization`: same-origin only, an exact `Origin` on an
//    upgrade, and `Content-Type: application/json` on a request body;
// 5. `next(auth)`, then the security headers on whatever comes back,
//    errors included (they are answered here, as JSON).

import {
	COOKIE,
	denied,
	httpStatus,
	setupRequired,
	toWire,
	unauthenticated,
	unavailable,
} from "@tartan/contract";
import type {
	AuthContext,
	Authenticate,
	RoutePolicy,
} from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import type { RequestContext, SecurityMiddleware } from "../../router.ts";
import {
	createAuthenticate,
	requireSameOrigin,
	STALE_SESSION,
} from "./auth.ts";
import { clearCookie } from "./cookies.ts";
import { withSecurityHeaders } from "./headers.ts";
import { decideHost } from "./host.ts";
import { type SetupInfo, setupInfo } from "./isolate.ts";

export type SecurityDeps = {
	readonly setupInfo: (env: Env) => Promise<SetupInfo>;
	readonly authenticate: (env: Env) => Authenticate;
	readonly log: (message: string, data: Record<string, unknown>) => void;
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const isWebSocketUpgrade = (req: Request): boolean =>
	(req.headers.get("upgrade") ?? "").toLowerCase() === "websocket";

/** A browser page load (not `fetch`/XHR): it gets a redirect, not a JSON error. */
export const isHtmlNavigation = (req: Request): boolean =>
	(req.method === "GET" || req.method === "HEAD") &&
	(req.headers.get("sec-fetch-mode") === "navigate" ||
		req.headers.get("sec-fetch-dest") === "document" ||
		(req.headers.get("accept") ?? "").includes("text/html"));

const hasBody = (req: Request): boolean =>
	req.body !== null && req.headers.get("content-length") !== "0";

const isJson = (req: Request): boolean =>
	/^application\/json\s*(?:;|$)/i.test(req.headers.get("content-type") ?? "");

/**
 * The browser rules for one request: same-origin (`requireSameOrigin`), an
 * exact Origin on a WebSocket upgrade, JSON for a request body.
 */
export const checkCsrf = (req: Request, canonicalOrigin: string): void => {
	requireSameOrigin(req, canonicalOrigin);
	if (
		isWebSocketUpgrade(req) && req.headers.get("origin") !== canonicalOrigin
	) {
		throw denied("csrf", "a WebSocket upgrade needs an exact Origin");
	}
	if (hasBody(req) && !isJson(req)) {
		throw denied("csrf", "a request body must be application/json");
	}
};

const errorResponse = (
	error: unknown,
	c: RequestContext,
	log: SecurityDeps["log"],
): Response => {
	const wire = toWire(error);
	if (wire.error === "internal") {
		log(`[tartan] route ${c.route.id} failed`, {
			error: error instanceof Error ? error.message : String(error),
		});
	}
	const headers = new Headers({ "cache-control": "no-store" });
	if (wire.error === "unauthenticated") {
		headers.set(
			"www-authenticate",
			c.route.id.startsWith("git.")
				? 'Basic realm="Tartan", charset="UTF-8"'
				: 'Bearer realm="Tartan"',
		);
	}
	const retry = wire.details?.retryAfterMs;
	if (wire.error === "rate_limited" && typeof retry === "number") {
		headers.set("retry-after", String(Math.max(1, Math.ceil(retry / 1000))));
	}
	return Response.json(wire, { status: httpStatus(wire.error), headers });
};

const DEFAULT_DEPS: SecurityDeps = {
	setupInfo,
	authenticate: createAuthenticate,
	log: (message, data) => console.error(message, JSON.stringify(data)),
};

/**
 * Whether the middleware reads the setup state for a route: for setup
 * gating, the canonical host and the CSRF origin. A route exempt from
 * gating, served on any host and without CSRF needs none of them.
 */
export const needsSetup = (
	policy: Pick<RoutePolicy, "setupExempt" | "host" | "csrf">,
): boolean => !(policy.setupExempt && policy.host === "any" && !policy.csrf);

export const createSecurity = (
	deps: SecurityDeps = DEFAULT_DEPS,
): SecurityMiddleware =>
async (c, next) => {
	const { req, url, route, env } = c;
	const policy = route.policy;
	const setCookies: string[] = [];
	const finish = (response: Response) =>
		withSecurityHeaders(response, {
			noStore: route.id !== "spa.asset",
			setCookies,
		});
	try {
		let info: SetupInfo;
		try {
			// A setup-exempt route served on any host without CSRF (health,
			// the deploy-script endpoints, 404/405) uses neither the state nor
			// the origin, so it never waits for ForgeDO: an isolate's first
			// read is bounded at 15 s for the routes setup gates.
			info = needsSetup(policy)
				? await deps.setupInfo(env)
				: { state: "fresh", canonicalOrigin: null };
		} catch (error) {
			if (!policy.setupExempt) {
				deps.log("[tartan] setup state unavailable", {
					error: error instanceof Error ? error.message : String(error),
				});
				throw unavailable("the forge is not reachable; try again");
			}
			info = { state: "fresh", canonicalOrigin: null };
		}
		const setupDone = info.state === "done";

		const host = decideHost(url, policy, info.canonicalOrigin, setupDone);
		if (host.kind === "forbid") {
			throw denied("host", `use ${info.canonicalOrigin}`);
		}
		if (host.kind === "redirect") {
			return finish(
				new Response(null, {
					status: 308,
					headers: { location: host.location },
				}),
			);
		}

		if (!setupDone && !policy.setupExempt) {
			if (isHtmlNavigation(req)) {
				return finish(
					new Response(null, {
						status: 302,
						headers: { location: "/-/setup" },
					}),
				);
			}
			throw setupRequired();
		}

		let auth: AuthContext | null = null;
		if (policy.auth !== "none") {
			try {
				auth = await deps.authenticate(env)(req, {
					allowCookie: policy.auth === "cookie" || policy.auth === "any",
					allowToken: policy.auth === "token" || policy.auth === "any",
				});
			} catch (error) {
				const stale = (error as { reason?: string }).reason === STALE_SESSION;
				if (!(stale && policy.anonymous)) throw error;
				setCookies.push(clearCookie(COOKIE.session));
			}
		}
		if (auth === null && !policy.anonymous) throw unauthenticated();
		if (
			auth !== null && auth.via !== "session" &&
			policy.tokenScope !== undefined &&
			!auth.scopes.includes(policy.tokenScope)
		) {
			throw denied("scopes", `this token lacks the ${policy.tokenScope} scope`);
		}

		const bearer = req.headers.has("authorization");
		if (
			policy.csrf && !bearer &&
			(!SAFE_METHODS.has(req.method) || isWebSocketUpgrade(req))
		) {
			checkCsrf(req, info.canonicalOrigin ?? url.origin);
		}

		return finish(await next(auth));
	} catch (error) {
		return finish(errorResponse(error, c, deps.log));
	}
};

/** The router's security seam (`src/router.ts`). */
export const withSecurity: SecurityMiddleware = createSecurity();
