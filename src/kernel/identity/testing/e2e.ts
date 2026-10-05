// End-to-end harness for WP2's workerd tests: the real router
// (`createRouter`, every route and policy of `src/router.ts`) and the real
// security middleware, with WP2's handlers built on a mock IdP's fetch, and
// `env.FORGE` answering with the identity module running on a real Durable
// Object's SQLite storage (inside `runInDurableObject`). WP3 and WP6 are the
// harness fakes (`harness.ts`) until they merge. Every `setupState` call is
// counted, so tests can show the isolate cache in front of ForgeDO.

import type { Env } from "../../../env.ts";
import {
	createRouter,
	type Route,
	type RouteHandler,
	ROUTES,
} from "../../../router.ts";
import { resetIsolateState } from "../../http/isolate.ts";
import { createIdentityRoutes } from "../routes.ts";
import { createIdentityHarness, TEST_SECRET } from "./harness.ts";
import type { MockIdp } from "./mock-idp.ts";

/** WP2 route id → the handler name in `createIdentityRoutes`. */
const WP2_HANDLERS: Readonly<
	Record<string, keyof ReturnType<typeof createIdentityRoutes>>
> = {
	"setup.api": "handleSetupApi",
	"auth.login": "handleLogin",
	"auth.callback": "handleCallback",
	"auth.logout": "handleLogout",
	"auth.jwks": "handleJwks",
	"admin.idp.deregister": "handleIdpDeregister",
	"avatar": "handleAvatar",
	"api.me": "handleMe",
	"api.tokens": "handleTokens",
	"api.agents": "handleAgents",
	"api.agents.bulk": "handleAgentsBulk",
	"api.invites": "handleInvites",
};

export type E2eOptions = {
	readonly state: DurableObjectState;
	readonly baseEnv: Env;
	readonly idp: MockIdp;
	readonly env?: Partial<Env>;
	/** Replace handlers of other WPs' routes (e.g. echo `auth` on a git route). */
	readonly handlers?: Readonly<Record<string, RouteHandler>>;
};

export const createE2e = (o: E2eOptions) => {
	resetIsolateState();
	const harness = createIdentityHarness({
		storage: o.state.storage,
		ctx: o.state,
		fetch: o.idp.fetch,
		// The Worker side reads the real clock; ForgeDO must agree with it.
		start: Date.now(),
		env: { ...o.baseEnv, TARTAN_SECRET: TEST_SECRET, ...o.env },
	});
	const calls = { setupState: 0 };
	const identity = new Proxy(harness.facade, {
		get: (target, name, receiver) => {
			if (name === "setupState") calls.setupState++;
			return Reflect.get(target, name, receiver);
		},
	});
	const forgeStub = { identity: () => identity, tree: () => ({}) };
	const env = {
		...harness.env,
		FORGE: { getByName: () => forgeStub, get: () => forgeStub },
	} as unknown as Env;
	const wp2 = createIdentityRoutes({ fetch: o.idp.fetch });
	const routes: Route[] = ROUTES.map((route) => {
		const own = WP2_HANDLERS[route.id];
		const handler = o.handlers?.[route.id] ?? (own ? wp2[own] : route.handler);
		return { ...route, handler };
	});
	const router = createRouter(routes);
	const ctx = {
		waitUntil: () => {},
		passThroughOnException: () => {},
	} as unknown as ExecutionContext;
	return {
		harness,
		env,
		calls,
		fetch: (url: string, init?: RequestInit) =>
			router(new Request(url, init), env, ctx),
	};
};

export type E2e = ReturnType<typeof createE2e>;

/** `name=value` of a `Set-Cookie` list (the value only). */
export const cookieValue = (
	response: Response,
	name: string,
): string | null => {
	for (const line of response.headers.getSetCookie()) {
		const [pair] = line.split(";");
		const eq = pair.indexOf("=");
		if (pair.slice(0, eq) === name) return pair.slice(eq + 1);
	}
	return null;
};

/** The `Set-Cookie` line for `name`, if any. */
export const setCookieLine = (
	response: Response,
	prefix: string,
): string | null =>
	response.headers.getSetCookie().find((l) => l.startsWith(prefix)) ?? null;
