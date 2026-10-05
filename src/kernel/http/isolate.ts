// Per-isolate state of the HTTP security layer (WP2):
//
// - the setup state and canonical origin, read from ForgeDO at most once per
//   10 s per isolate (one call in flight at a time, bounded at 3 s once the
//   isolate has an answer and at 15 s for its first read), so forged traffic
//   on any route, the capability route included, cannot drive ForgeDO, and a
//   stalled read never holds the isolate's requests for long; the routes
//   that need no setup state (`needsSetup` in middleware.ts: health, the
//   deploy-script endpoints) never wait for it;
// - token lookups, cached for at most 60 s (never past the token's expiry),
//   so a revocation takes effect within 60 s everywhere and at once on the
//   isolate that revoked it (`forgetToken`);
// - the keyring, built once per isolate from `TARTAN_SECRET`, or from the
//   root key ForgeDO generated at first boot when the secret is absent; a
//   failed root-key read is remembered for `SETUP_ERROR_CACHE_MS` (one
//   attempt shared per isolate), so forged capability URLs never drive
//   ForgeDO while that read is failing.
//
// Module-level state is per isolate by design; `resetIsolateState` exists for
// tests.

import {
	FORGE_DO_NAME,
	type SetupStateDto,
	unavailable,
} from "@tartan/contract";
import type { AuthContext } from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import { createKeyring, type Keyring } from "../identity/keyring.ts";

export const SETUP_CACHE_MS = 10_000;
/** A failed read is retried after this long (nothing works without ForgeDO anyway). */
export const SETUP_ERROR_CACHE_MS = 2_000;
/**
 * The ForgeDO read is bounded: every request of the isolate shares the one
 * in flight, so a stalled read would otherwise hold them all, `/-/health`
 * included.
 */
export const SETUP_READ_TIMEOUT_MS = 3_000;
/**
 * The bound of an isolate's first read, when there is no last answer to
 * serve: every page of a forge needs its setup state, so a busy ForgeDO
 * (right after a deploy, with imports and provisioning running) gets longer
 * before the request fails with 503 "forge not reachable".
 */
export const SETUP_FIRST_READ_TIMEOUT_MS = 15_000;
export const TOKEN_CACHE_MS = 60_000;
export const TOKEN_CACHE_MAX = 10_000;

export const forgeIdentity = (env: Env) =>
	env.FORGE.getByName(FORGE_DO_NAME).identity();

export type SetupInfo = {
	readonly state: SetupStateDto["state"];
	readonly canonicalOrigin: string | null;
};

type Cached<T> =
	| { readonly ok: true; readonly value: T; readonly until: number }
	| { readonly ok: false; readonly error: unknown; readonly until: number };

let setupCache: Cached<SetupInfo> | null = null;
let setupInflight: Promise<SetupInfo> | null = null;
/** The last answer ForgeDO gave this isolate (kept past the cache's expiry). */
let lastSetup: SetupInfo | null = null;

const bounded = <T>(work: Promise<T>, ms: number): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(unavailable(`ForgeDO did not answer within ${ms} ms`)),
			ms,
		);
	});
	return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
};

/**
 * The forge's setup state and canonical origin, isolate-cached for 10 s, read
 * within `timeoutMs` once this isolate has an answer, else within
 * `firstTimeoutMs`. A failed or timed-out read of a forge already seen
 * `done` serves that answer (setup never goes back) and retries after 2 s;
 * any other failure is remembered for 2 s.
 */
export const setupInfo = (
	env: Env,
	now: number = Date.now(),
	timeoutMs: number = SETUP_READ_TIMEOUT_MS,
	firstTimeoutMs: number = SETUP_FIRST_READ_TIMEOUT_MS,
): Promise<SetupInfo> => {
	if (setupCache !== null && setupCache.until > now) {
		return setupCache.ok
			? Promise.resolve(setupCache.value)
			: Promise.reject(setupCache.error);
	}
	setupInflight ??= (async () => {
		try {
			const dto = await bounded(
				forgeIdentity(env).setupState(),
				lastSetup === null ? Math.max(timeoutMs, firstTimeoutMs) : timeoutMs,
			);
			const value: SetupInfo = {
				state: dto.state,
				canonicalOrigin: dto.canonicalOrigin ?? null,
			};
			setupCache = { ok: true, value, until: Date.now() + SETUP_CACHE_MS };
			lastSetup = value;
			return value;
		} catch (error) {
			const until = Date.now() + SETUP_ERROR_CACHE_MS;
			if (lastSetup?.state === "done") {
				console.warn(
					"[tartan] setup state read failed; serving the last answer",
					error instanceof Error ? error.message : String(error),
				);
				setupCache = { ok: true, value: lastSetup, until };
				return lastSetup;
			}
			setupCache = { ok: false, error, until };
			throw error;
		} finally {
			setupInflight = null;
		}
	})();
	return setupInflight;
};

/** The last setup answer this isolate got from ForgeDO, however old (null: none yet). */
export const lastSetupInfo = (): SetupInfo | null => lastSetup;

/** After this isolate changed the setup state (claim, name step). */
export const invalidateSetupInfo = (): void => {
	setupCache = null;
};

const tokens = new Map<
	string,
	{ readonly auth: AuthContext | null; readonly until: number }
>();

/** `IdentityFacade.token` behind the ≤ 60 s isolate cache (unknown tokens included). */
export const cachedToken = async (
	env: Env,
	hash: string,
	now: number = Date.now(),
): Promise<AuthContext | null> => {
	const hit = tokens.get(hash);
	if (hit !== undefined && hit.until > now) return hit.auth;
	const auth = await forgeIdentity(env).token(hash);
	if (tokens.size >= TOKEN_CACHE_MAX) {
		const oldest = tokens.keys().next();
		if (!oldest.done) tokens.delete(oldest.value);
	}
	tokens.delete(hash);
	tokens.set(hash, {
		auth,
		until: Math.min(now + TOKEN_CACHE_MS, auth?.expiresAt ?? Infinity),
	});
	return auth;
};

/** Drops a revoked token from this isolate's cache at once. */
export const forgetToken = (tokenId: string): void => {
	for (const [hash, entry] of tokens) {
		if (entry.auth?.tokenId === tokenId) tokens.delete(hash);
	}
};

/** Drops every cached token of a principal (an agent was disabled). */
export const forgetPrincipalTokens = (principal: string): void => {
	for (const [hash, entry] of tokens) {
		if (entry.auth?.principal === principal) tokens.delete(hash);
	}
};

type KeyringEntry = {
	readonly secret: string | undefined;
	readonly previous: string | undefined;
	readonly keyring: Promise<Keyring>;
	/** Set when the load failed: the rejection is served until then. */
	failedUntil?: number;
};
let keyringCache: KeyringEntry | null = null;

/**
 * The forge keyring of this isolate. With `TARTAN_SECRET` absent (button
 * path) the root comes from ForgeDO once per isolate.
 */
export const isolateKeyring = (
	env: Env,
	now = Date.now(),
): Promise<Keyring> => {
	const secret = env.TARTAN_SECRET;
	const previous = env.TARTAN_SECRET_PREVIOUS;
	const cached = keyringCache;
	if (
		cached !== null && cached.secret === secret &&
		cached.previous === previous &&
		(cached.failedUntil === undefined || now < cached.failedUntil)
	) {
		return cached.keyring;
	}
	const keyring = (async () => {
		const root = secret ?? await forgeIdentity(env).rootKey();
		if (!root) throw unavailable("the forge has no root key yet");
		return await createKeyring(root, previous);
	})();
	const entry: KeyringEntry = { secret, previous, keyring };
	keyringCache = entry;
	// A failed load is served from the cache for a short while: every
	// caller in that window, the capability route's MAC check included, gets
	// the same rejection without another ForgeDO call.
	keyring.catch(() => {
		entry.failedUntil = Date.now() + SETUP_ERROR_CACHE_MS;
	});
	return keyring;
};

/** Tests only: forget every per-isolate cache. */
export const resetIsolateState = (): void => {
	setupCache = null;
	setupInflight = null;
	lastSetup = null;
	tokens.clear();
	keyringCache = null;
};
