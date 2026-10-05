// Ports: the narrow seams pure modules and fakes are written against.
//
// Kernel-only: this file references `@cloudflare/workers-types` globals
// (`Artifacts`, `ArtifactsRepo`), so browser code must not import it. It is
// exported from `@tartan/contract/kernel`, not from the portable index.

import type { GitSource } from "./common.ts";
import { invalid } from "./errors.ts";
import { SHA1_RE } from "./ids.ts";

/**
 * The `ArtifactsRepo` methods Tartan uses. `revokeToken` ends each
 * capability-route request's trunk read token (on finish and on cancel), and
 * `listTokens` checks that none is left live. No other repo method is
 * called.
 */
export type RepoStoreRepoMethod =
	| "info"
	| "createToken"
	| "revokeToken"
	| "listTokens"
	| "readBlob"
	| "readTree"
	| "readCommit"
	| "readFile"
	| "log";

/**
 * One repository handle: exactly the subset of `ArtifactsRepo` used. The real
 * binding returns an RPC stub that should be disposed (`using repo = …`).
 */
export type RepoStoreRepo =
	& Pick<ArtifactsRepo, RepoStoreRepoMethod>
	& Disposable;

/**
 * The Artifacts namespace subset Tartan uses. The real `env.ARTIFACTS` binding
 * is assignable to this type; `FakeArtifacts` (packages/testkit) implements
 * it.
 * - `create`: canonical repos;
 * - `import`: public repo imports, and lane repos seeded from the capability
 *   URL with `branch: "main"` (its returned token is discarded unread);
 * - `list`, `delete`: lane GC, the orphan sweep of `l-*` repos and purge;
 * - a 429 or rate-limit error from any call is a backoff (`rate-limited`),
 *   never a lane-seed breaker strike.
 */
export type RepoStore = {
	create: Artifacts["create"];
	get(name: string): Promise<RepoStoreRepo>;
	import: Artifacts["import"];
	list: Artifacts["list"];
	delete: Artifacts["delete"];
};

export type RepoStoreErrorCode = ArtifactsErrorCode;
export type RepoStoreInfo = ArtifactsRepoInfo;
export type RepoStoreTreeEntry = ArtifactsTreeEntry;
export type RepoStoreCommit = ArtifactsCommitMetadata;
export type RepoStoreToken = ArtifactsCreateTokenResult;

/** True for an `ArtifactsError` (optionally with one of `codes`), including after RPC. */
export const isRepoStoreError = (
	error: unknown,
	...codes: RepoStoreErrorCode[]
): error is ArtifactsError => {
	if (!(error instanceof Error) || error.name !== "ArtifactsError") {
		return false;
	}
	const code = (error as { code?: unknown }).code;
	return codes.length === 0 ||
		(typeof code === "string" && (codes as string[]).includes(code));
};

/** Token TTLs: Worker/RepoDO cache 600 s, refreshed 60 s early; sandbox read 10 min / write 5 min. */
export const ARTIFACTS_TOKEN_TTL_S = 600;
/** The shortest TTL `createToken` accepts. */
export const ARTIFACTS_TOKEN_MIN_TTL_S = 60;
export const ARTIFACTS_TOKEN_REFRESH_MARGIN_S = 60;
export const SANDBOX_READ_TOKEN_TTL_S = 600;
export const SANDBOX_WRITE_TOKEN_TTL_S = 300;

// ---------------------------------------------------------------------------
// Git execution (kernel git jobs in TartanSandbox; WP9 implements, WP10 uses)
// ---------------------------------------------------------------------------

export type GitExecOptions = {
	readonly cwd?: string;
	/**
	 * Per-exec environment. Short-TTL Artifacts tokens go here via
	 * `GIT_CONFIG_COUNT/KEY/VALUE`, never in argv or files (K11):
	 * one token per repo the exec touches (the canonical repo or one lane
	 * repo), each in this exec's environment only.
	 */
	readonly env?: Readonly<Record<string, string>>;
	readonly stdin?: string;
	readonly timeoutMs?: number;
	/**
	 * The unprivileged user to run as: `tartan-git` for execs that
	 * parse repository content, `tartan-push` for execs holding a write token
	 * (after `pkill -u tartan-git`).
	 */
	readonly uid?: "tartan-git" | "tartan-push";
};

export type GitExecResult = {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly durationMs: number;
};

/** Runs one argv in the warm `git:<repoId>` sandbox (or a fake git in tests). Never a shell string. */
export interface GitExec {
	exec(
		argv: readonly string[],
		options?: GitExecOptions,
	): Promise<GitExecResult>;
}

// ---------------------------------------------------------------------------
// SHA-only reads (K15)
// ---------------------------------------------------------------------------

declare const resolvedSha: unique symbol;
/**
 * A 40-char lowercase SHA the kernel resolved from its own ref index or lane
 * rows (K15): the binding resolves no full refname, so reads never take one.
 */
export type ResolvedSha = string & { readonly [resolvedSha]: true };

export const isResolvedSha = (value: unknown): value is ResolvedSha =>
	typeof value === "string" && SHA1_RE.test(value);

/** Brands a SHA (throws `invalid` for anything that is not 40 lowercase hex chars). */
export const toResolvedSha = (value: string): ResolvedSha => {
	if (!isResolvedSha(value)) throw invalid(`not a sha: ${value}`);
	return value;
};

/**
 * Binding read limits every `RepoReader` (and its fakes) honours: `log` pages
 * are capped by the binding; reads are paced at `readsPerSecond`, with at
 * most `concurrentPerRequest` in flight per request.
 */
export const REPO_READER_LIMITS = {
	logMax: 1000,
	readsPerSecond: 250,
	concurrentPerRequest: 16,
} as const;

/**
 * SHA-only reads bound to one Artifacts repo: the canonical repo, or the
 * current lane repo of an open `repo`-backend lane, chosen by `source`
 * through RepoDO.
 */
export interface RepoReader {
	readonly source: GitSource;
	readCommit(sha: ResolvedSha): Promise<RepoStoreCommit | null>;
	readTree(sha: ResolvedSha): Promise<RepoStoreTreeEntry[] | null>;
	/** A blob by its own SHA (a commit SHA reads as null). */
	readBlob(sha: ResolvedSha): Promise<Blob | null>;
	/** A file at a commit (why notes: the notes tip SHA and the commit SHA as the path). */
	readFile(commit: ResolvedSha, path: string): Promise<Blob | null>;
	/** First-parent history from `from`, newest first; `limit` ≤ `REPO_READER_LIMITS.logMax`. */
	log(
		from: ResolvedSha,
		options?: { readonly limit?: number; readonly offset?: number },
	): Promise<RepoStoreCommit[]>;
}

// ---------------------------------------------------------------------------
// Clock, ids, hashing
// ---------------------------------------------------------------------------

export interface Clock {
	/** Epoch milliseconds. */
	now(): number;
}

export interface Ids {
	/** Lowercase, monotonic ULID (`createUlid`). */
	ulid(): string;
}

/**
 * Synchronous SHA-256 for the event hash chain inside `transactionSync`:
 * `node:crypto` `createHash` if the M0 test proves it synchronous
 * under `nodejs_compat`, else the vendored `packages/sha256`.
 */
export type Sha256Sync = (data: string | Uint8Array) => string;

export const systemClock: Clock = { now: () => Date.now() };
