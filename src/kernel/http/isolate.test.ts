// Per-isolate caches: the setup state is
// read at most once per 10 s with one call in flight; a token lookup is
// cached ≤ 60 s, so revocation is effective within 60 s everywhere and at
// once on the revoking isolate. Pure Deno tests with a fake ForgeDO.

import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import type { AuthContext } from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import {
	cachedToken,
	forgetToken,
	isolateKeyring,
	lastSetupInfo,
	resetIsolateState,
	SETUP_ERROR_CACHE_MS,
	setupInfo,
	TOKEN_CACHE_MS,
} from "./isolate.ts";

const fakeEnv = (identity: Record<string, unknown>): Env =>
	({
		FORGE: { getByName: () => ({ identity: () => identity }) },
	}) as unknown as Env;

const AUTH: AuthContext = {
	principal: "a_01k6aaaaaaaaaaaaaaaaaaaaaa",
	kind: "agent",
	via: "agent-token",
	tokenId: "tok_01k6aaaaaaaaaaaaaaaaaaaaaa",
	scopes: ["mcp"],
	nodeId: null,
	laneId: null,
	maxRole: 30,
	isAdmin: false,
	expiresAt: Date.now() + 7 * 86_400_000,
};

Deno.test("setup state: one ForgeDO call for a burst, none again within 10 s", async () => {
	resetIsolateState();
	let calls = 0;
	const env = fakeEnv({
		setupState: () => {
			calls++;
			return Promise.resolve({ state: "fresh", rootKeyFallback: false });
		},
	});
	const results = await Promise.all(
		Array.from({ length: 100 }, () => setupInfo(env)),
	);
	equal(calls, 1);
	deepStrictEqual(results[99], { state: "fresh", canonicalOrigin: null });
	await setupInfo(env, Date.now() + 9_000);
	equal(calls, 1);
	await setupInfo(env, Date.now() + 10_500);
	equal(calls, 2);
});

Deno.test("setup state: a failure is remembered briefly, not retried per request", async () => {
	resetIsolateState();
	let calls = 0;
	const env = fakeEnv({
		setupState: () => {
			calls++;
			return Promise.reject(new Error("forge down"));
		},
	});
	await rejects(setupInfo(env), /forge down/);
	await rejects(setupInfo(env), /forge down/);
	equal(calls, 1);
	await rejects(setupInfo(env, Date.now() + 3_000), /forge down/);
	equal(calls, 2);
});

Deno.test("setup state: a stalled ForgeDO read is bounded, so it never holds the isolate's requests (e2e /-/health hang)", async () => {
	resetIsolateState();
	let calls = 0;
	let stall = true;
	const env = fakeEnv({
		setupState: () => {
			calls++;
			return stall
				? new Promise(() => {})
				: Promise.resolve({ state: "done", canonicalOrigin: "https://f.test" });
		},
	});
	// Never seen set up: the bound fails the read (and every request sharing it).
	const started = Date.now();
	const waiting = Array.from(
		{ length: 5 },
		() => setupInfo(env, Date.now(), 20, 20),
	);
	for (const w of waiting) await rejects(w, /did not answer within 20 ms/);
	ok(Date.now() - started < 1000);
	equal(calls, 1);
	equal(lastSetupInfo(), null);
	// Answered once, then stalled again: the last answer (`done` never goes back).
	stall = false;
	deepStrictEqual(await setupInfo(env, Date.now() + 3_000, 20), {
		state: "done",
		canonicalOrigin: "https://f.test",
	});
	stall = true;
	deepStrictEqual(await setupInfo(env, Date.now() + 20_000, 20), {
		state: "done",
		canonicalOrigin: "https://f.test",
	});
	equal(calls, 3);
	resetIsolateState();
});

Deno.test("setup state: an isolate with no answer yet waits past the short bound for a busy ForgeDO (e2e 503 on /-/settings)", async () => {
	resetIsolateState();
	let calls = 0;
	const env = fakeEnv({
		setupState: () => {
			calls++;
			return new Promise((resolve) =>
				setTimeout(
					() => resolve({ state: "done", canonicalOrigin: "https://f.test" }),
					60,
				)
			);
		},
	});
	// No answer yet: the first read gets the longer bound and succeeds.
	deepStrictEqual(await setupInfo(env, Date.now(), 20, 1_000), {
		state: "done",
		canonicalOrigin: "https://f.test",
	});
	// Answered once: the short bound applies, and the last answer is served.
	deepStrictEqual(await setupInfo(env, Date.now() + 20_000, 20, 1_000), {
		state: "done",
		canonicalOrigin: "https://f.test",
	});
	equal(calls, 2);
	resetIsolateState();
});

Deno.test("token cache: ≤ 60 s, forgotten at once by the revoking isolate", async () => {
	resetIsolateState();
	let calls = 0;
	let revoked = false;
	const env = fakeEnv({
		token: () => {
			calls++;
			return Promise.resolve(revoked ? null : AUTH);
		},
	});
	const t0 = Date.now();
	deepStrictEqual(await cachedToken(env, "h1", t0), AUTH);
	deepStrictEqual(await cachedToken(env, "h1", t0 + 1_000), AUTH);
	equal(calls, 1);
	// Revoked elsewhere: this isolate keeps the entry for at most 60 s.
	revoked = true;
	deepStrictEqual(await cachedToken(env, "h1", t0 + TOKEN_CACHE_MS - 1), AUTH);
	equal(await cachedToken(env, "h1", t0 + TOKEN_CACHE_MS), null);
	equal(calls, 2);
	// Revoked here: gone immediately.
	revoked = false;
	resetIsolateState();
	await cachedToken(env, "h2", t0);
	revoked = true;
	forgetToken(AUTH.tokenId as string);
	equal(await cachedToken(env, "h2", t0 + 1), null);
});

Deno.test("token cache: an entry never outlives the token's expiry", async () => {
	resetIsolateState();
	let calls = 0;
	const t0 = Date.now();
	const env = fakeEnv({
		token: () => {
			calls++;
			return Promise.resolve({ ...AUTH, expiresAt: t0 + 5_000 });
		},
	});
	await cachedToken(env, "h3", t0);
	await cachedToken(env, "h3", t0 + 4_999);
	equal(calls, 1);
	await cachedToken(env, "h3", t0 + 5_000);
	equal(calls, 2);
});

Deno.test("keyring: a failing root-key read is shared and remembered briefly, so forged requests never drive ForgeDO", async () => {
	resetIsolateState();
	let calls = 0;
	let fail = true;
	const env = fakeEnv({
		rootKey: () => {
			calls++;
			return fail
				? Promise.reject(new Error("forge overloaded"))
				: Promise.resolve("r".repeat(64));
		},
	});
	// A burst of capability requests while ForgeDO is failing: one read.
	const burst = await Promise.allSettled(
		Array.from({ length: 50 }, () => isolateKeyring(env)),
	);
	ok(burst.every((r) => r.status === "rejected"));
	equal(calls, 1);
	// Within the window: still no second read.
	await rejects(isolateKeyring(env, Date.now() + 1_000), /overloaded/);
	equal(calls, 1);
	// After it, one retry; it succeeds and is kept.
	fail = false;
	await isolateKeyring(env, Date.now() + SETUP_ERROR_CACHE_MS + 100);
	equal(calls, 2);
	await isolateKeyring(env, Date.now() + 60_000);
	equal(calls, 2);
	resetIsolateState();
});
