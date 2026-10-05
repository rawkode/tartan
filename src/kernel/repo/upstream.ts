// Artifacts access from RepoDO (K11):
// - the per-RepoDO control bucket every control-plane call goes through
//   (`ARTIFACTS_CONTROL_PER_S_REPO`; a 429 or rate-limit answer pauses it
//   1 s, 2 s, 4 s …; never a breaker strike);
// - the memory-only token cache keyed `(artifactsName, scope)`, minted with
//   `createToken(scope, 600)` and refreshed 60 s before expiry. Tokens are
//   never persisted, logged or returned to clients; each is scoped to the
//   one repo it names.

import {
	ARTIFACTS_TOKEN_REFRESH_MARGIN_S,
	ARTIFACTS_TOKEN_TTL_S,
	type ArtifactsControlBucket,
	type Clock,
	isRepoStoreError,
	type RepoStore,
	type RepoStoreRepo,
} from "@tartan/contract/kernel.ts";
import { rateLimited } from "@tartan/contract";
import { ARTIFACTS_CONTROL_PER_S_REPO } from "../../constants.ts";

const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 16_000;
/** A backoff more than this long after the previous one starts over at 1 s. */
const BACKOFF_RESET_MS = 60_000;

export type ControlBucket = ArtifactsControlBucket & {
	/** For tests and diagnostics: when the bucket accepts calls again. */
	pausedUntil(): number;
};

export const createControlBucket = (deps: {
	readonly clock: Clock;
	readonly sleep: (ms: number) => Promise<void>;
	readonly perSecond?: number;
}): ControlBucket => {
	const rate = deps.perSecond ?? ARTIFACTS_CONTROL_PER_S_REPO;
	let tokens = rate;
	let refilledAt = deps.clock.now();
	let pausedUntil = 0;
	let lastBackoffAt = -Infinity;
	let backoffMs = 0;

	const refill = (now: number): void => {
		const elapsed = Math.max(0, now - refilledAt);
		tokens = Math.min(rate, tokens + (elapsed * rate) / 1000);
		refilledAt = now;
	};

	const take = async (): Promise<void> => {
		for (;;) {
			const now = deps.clock.now();
			if (now < pausedUntil) {
				await deps.sleep(pausedUntil - now);
				continue;
			}
			refill(now);
			if (tokens >= 1) {
				tokens -= 1;
				return;
			}
			await deps.sleep(Math.ceil(((1 - tokens) * 1000) / rate));
		}
	};

	const backoff = (): void => {
		const now = deps.clock.now();
		backoffMs = now - lastBackoffAt > BACKOFF_RESET_MS
			? BACKOFF_START_MS
			: Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_START_MS, backoffMs * 2));
		lastBackoffAt = now;
		pausedUntil = Math.max(pausedUntil, now + backoffMs);
	};

	return { take, backoff, pausedUntil: () => pausedUntil };
};

/** A 429 or rate-limit answer from a control call (a backoff, never a strike). */
export const isRateLimitError = (error: unknown): boolean => {
	const message = error instanceof Error ? error.message : String(error);
	const code = (error as { code?: unknown } | null)?.code;
	return /\b429\b/.test(message) || /rate.?limit/i.test(message) ||
		code === 429 || code === "RATE_LIMITED";
};

const dispose = (repo: RepoStoreRepo): void => {
	try {
		repo[Symbol.dispose]?.();
	} catch {
		// Disposing an RPC stub is best effort.
	}
};

export type CachedToken = {
	readonly token: string;
	readonly expiresAt: number;
	readonly remote: string;
};

export type ArtifactsAccess = {
	/** A memory-cached token for exactly `name` (K11). */
	token(name: string, scope: "read" | "write"): Promise<CachedToken>;
	/** The repo's HTTPS git remote (cached; `info().remote`). */
	remote(name: string): Promise<string>;
	/** The cached remote, if known (synchronous `fetchSpec`). */
	knownRemote(name: string): string | null;
	/** Runs one control call through the bucket, backing off on a 429. */
	control<T>(call: () => Promise<T>): Promise<T>;
	/** Drops cached tokens of `name` (a deleted lane repo). */
	forget(name: string): void;
	readonly bucket: ControlBucket;
};

export const createArtifactsAccess = (deps: {
	readonly artifacts: RepoStore;
	readonly clock: Clock;
	readonly sleep: (ms: number) => Promise<void>;
	readonly bucket?: ControlBucket;
}): ArtifactsAccess => {
	const bucket = deps.bucket ?? createControlBucket(deps);
	const tokens = new Map<string, CachedToken>();
	const minting = new Map<string, Promise<CachedToken>>();
	const remotes = new Map<string, string>();

	const control = async <T>(call: () => Promise<T>): Promise<T> => {
		await bucket.take();
		try {
			return await call();
		} catch (error) {
			if (isRateLimitError(error)) {
				bucket.backoff();
				throw rateLimited("Artifacts control plane is rate limited");
			}
			throw error;
		}
	};

	const withRepo = async <T>(
		name: string,
		use: (repo: RepoStoreRepo) => Promise<T>,
	): Promise<T> => {
		const repo = await control(() => deps.artifacts.get(name));
		try {
			return await use(repo);
		} finally {
			dispose(repo);
		}
	};

	const mint = async (
		name: string,
		scope: "read" | "write",
	): Promise<CachedToken> =>
		await withRepo(name, async (repo) => {
			const remote = remotes.get(name) ??
				(await control(() => repo.info())).remote;
			remotes.set(name, remote);
			const created = await control(() =>
				repo.createToken(scope, ARTIFACTS_TOKEN_TTL_S)
			);
			const parsed = Date.parse(created.expiresAt);
			return {
				token: created.plaintext,
				expiresAt: Number.isFinite(parsed)
					? parsed
					: deps.clock.now() + ARTIFACTS_TOKEN_TTL_S * 1000,
				remote,
			};
		});

	const token = (name: string, scope: "read" | "write") => {
		const key = `${name}|${scope}`;
		const cached = tokens.get(key);
		const fresh = cached !== undefined &&
			cached.expiresAt - ARTIFACTS_TOKEN_REFRESH_MARGIN_S * 1000 >
				deps.clock.now();
		if (fresh) return Promise.resolve(cached);
		const pending = minting.get(key);
		if (pending !== undefined) return pending;
		const started = mint(name, scope)
			.then((minted) => {
				tokens.set(key, minted);
				return minted;
			})
			.finally(() => minting.delete(key));
		minting.set(key, started);
		return started;
	};

	const remote = async (name: string): Promise<string> => {
		const known = remotes.get(name);
		if (known !== undefined) return known;
		const info = await withRepo(name, (repo) => control(() => repo.info()));
		remotes.set(name, info.remote);
		return info.remote;
	};

	return {
		token,
		remote,
		knownRemote: (name) => remotes.get(name) ?? null,
		control,
		forget: (name) => {
			tokens.delete(`${name}|read`);
			tokens.delete(`${name}|write`);
		},
		bucket,
	};
};

/** True for the binding's `NOT_FOUND` (a deleted or never-created repo). */
export const isMissingRepo = (error: unknown): boolean =>
	isRepoStoreError(error, "NOT_FOUND");
