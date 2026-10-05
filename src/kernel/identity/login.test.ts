// `/-/auth/login` against a ForgeDO that stops answering (agent smoke: the
// route hung for more than 30 s while `/-/health` answered): it fails with
// `unavailable` at its deadline instead of holding the request.

import { equal, ok } from "node:assert/strict";
import { fromRpcError } from "@tartan/contract";
import type { Env } from "../../env.ts";
import type { RouteContext } from "../../router.ts";
import { resetIsolateState } from "../http/isolate.ts";
import { createIdentityRoutes, LOGIN_DEADLINE_MS } from "./routes.ts";

const ORIGIN = "https://code.example.com";

const stalledForge = (calls: string[]): Env =>
	({
		FORGE: {
			getByName: () => ({
				identity: () => ({
					setupState: () =>
						Promise.resolve({
							state: "done",
							canonicalOrigin: ORIGIN,
							rootKeyFallback: false,
						}),
					rateLimit: () => {
						calls.push("rateLimit");
						return new Promise<never>(() => {});
					},
				}),
			}),
		},
	}) as unknown as Env;

Deno.test("sign-in gives up with unavailable when ForgeDO does not answer", async () => {
	resetIsolateState();
	const calls: string[] = [];
	const routes = createIdentityRoutes({ loginDeadlineMs: 20 });
	const req = new Request(`${ORIGIN}/-/auth/login`);
	const c = {
		req,
		env: stalledForge(calls),
		ctx: {} as ExecutionContext,
		url: new URL(req.url),
		params: {},
		route: { id: "auth.login", owner: "WP2", policy: {} },
	} as unknown as RouteContext;
	const started = Date.now();
	const error = await Promise.resolve(routes.handleLogin(c)).then(
		() => null,
		(e: unknown) => e,
	);
	ok(Date.now() - started < 1_000, "answered at its deadline");
	equal(fromRpcError(error).code, "unavailable");
	equal(calls.join(), "rateLimit", "it was waiting on ForgeDO");
	ok(LOGIN_DEADLINE_MS <= 15_000, "below the 30 s the smoke saw");
	resetIsolateState();
});
