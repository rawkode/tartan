// SHA-only reads for the browse routes (WP3; K15): every binding call takes a
// 40-hex SHA the kernel resolved; trees are walked from a commit, never read by
// a caller-named hash; a per-request memo keeps repeated tree reads to one
// binding call and at most `REPO_READER_LIMITS.concurrentPerRequest` reads run
// at once.

import {
	type CommitMeta,
	invalid,
	notFound,
	REPO_PATH_RE,
	type Trailer,
	type TreeEntry,
} from "@tartan/contract";
import {
	isResolvedSha,
	REPO_READER_LIMITS,
	type RepoStore,
	type RepoStoreCommit,
	type RepoStoreRepo,
	type RepoStoreTreeEntry,
	type ResolvedSha,
} from "@tartan/contract/kernel.ts";

export type RepoReads = {
	commit(sha: ResolvedSha): Promise<RepoStoreCommit | null>;
	tree(sha: ResolvedSha): Promise<readonly RepoStoreTreeEntry[] | null>;
	blob(sha: ResolvedSha): Promise<Blob | null>;
	/** First-parent history from `sha`, newest first. */
	log(
		sha: ResolvedSha,
		options?: { readonly limit?: number; readonly offset?: number },
	): Promise<RepoStoreCommit[]>;
	/** A file at a commit-ish SHA (why notes: the notes tip and a commit path). */
	file(sha: ResolvedSha, path: string): Promise<Blob | null>;
	close(): void;
};

// deno-lint-ignore no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** True when `text` holds a control character (never in a ref or path segment). */
export const hasControlChars = (text: string): boolean =>
	CONTROL_CHARS.test(text);

const sha = (value: string): ResolvedSha => {
	if (!isResolvedSha(value)) throw invalid(`reads take a sha (K15): ${value}`);
	return value;
};

/** A small semaphore (≤ `limit` binding reads in flight per request). */
const limiter = (limit: number) => {
	let active = 0;
	const waiting: (() => void)[] = [];
	return async <T>(work: () => Promise<T>): Promise<T> => {
		if (active >= limit) await new Promise<void>((r) => waiting.push(r));
		active++;
		try {
			return await work();
		} finally {
			active--;
			waiting.shift()?.();
		}
	};
};

/** Reads of one Artifacts repo, by SHA only. */
export const openReads = async (
	artifacts: Pick<RepoStore, "get">,
	name: string,
): Promise<RepoReads> => {
	const repo: RepoStoreRepo = await artifacts.get(name);
	const run = limiter(REPO_READER_LIMITS.concurrentPerRequest);
	const trees = new Map<string, Promise<RepoStoreTreeEntry[] | null>>();
	const commits = new Map<string, Promise<RepoStoreCommit | null>>();
	return {
		commit: (hash) => {
			const key = sha(hash);
			let hit = commits.get(key);
			if (!hit) {
				hit = run(() => repo.readCommit(key));
				commits.set(key, hit);
			}
			return hit;
		},
		tree: (hash) => {
			const key = sha(hash);
			let hit = trees.get(key);
			if (!hit) {
				hit = run(() => repo.readTree(key));
				trees.set(key, hit);
			}
			return hit;
		},
		blob: (hash) => run(() => repo.readBlob(sha(hash))),
		log: (hash, options = {}) =>
			run(() =>
				repo.log({
					ref: sha(hash),
					limit: Math.min(
						Math.max(1, options.limit ?? 50),
						REPO_READER_LIMITS.logMax,
					),
					offset: Math.max(0, options.offset ?? 0),
				})
			),
		file: (hash, path) => run(() => repo.readFile({ ref: sha(hash), path })),
		close: () => {
			try {
				repo[Symbol.dispose]?.();
			} catch {
				// an RPC stub may already be released
			}
		},
	};
};

// ---------------------------------------------------------------------------
// Paths and tree walks
// ---------------------------------------------------------------------------

/** A repo-relative path as segments (`""` is the root); `invalid` for `..`, empty segments or control characters. */
export const pathSegments = (path: string): string[] => {
	const trimmed = path.replace(/^\/+|\/+$/g, "");
	if (trimmed === "") return [];
	if (trimmed.length > 4096 || !REPO_PATH_RE.test(trimmed)) {
		throw invalid(`invalid path: ${path}`);
	}
	const parts = trimmed.split("/");
	if (parts.some((p) => p === "" || p === "." || p === "..")) {
		throw invalid(`invalid path: ${path}`);
	}
	return parts;
};

export type Walked =
	| {
		readonly kind: "tree";
		readonly sha: ResolvedSha;
		readonly entries: readonly RepoStoreTreeEntry[];
	}
	| {
		readonly kind: "blob";
		readonly sha: ResolvedSha;
		readonly entry: RepoStoreTreeEntry;
	}
	| { readonly kind: "gitlink"; readonly entry: RepoStoreTreeEntry };

/**
 * Walks `segments` from a root tree (a blob is only ever reached from a
 * tree the caller may read); null when a segment is missing or crosses a
 * file.
 */
export const walk = async (
	reads: RepoReads,
	rootTree: ResolvedSha,
	segments: readonly string[],
): Promise<Walked | null> => {
	let treeSha = rootTree;
	let entries = await reads.tree(treeSha);
	if (entries === null) throw notFound(`tree ${treeSha} is not readable`);
	for (const [i, segment] of segments.entries()) {
		const entry = entries.find((e) => e.name === segment);
		if (!entry) return null;
		const last = i === segments.length - 1;
		if (entry.type === "tree") {
			treeSha = sha(entry.hash);
			const next = await reads.tree(treeSha);
			if (next === null) throw notFound(`tree ${treeSha} is not readable`);
			entries = next;
			continue;
		}
		if (!last) return null;
		if (entry.type === "gitlink") return { kind: "gitlink", entry };
		return { kind: "blob", sha: sha(entry.hash), entry };
	}
	return { kind: "tree", sha: treeSha, entries };
};

/** The object id at `segments` below a root tree (null when absent). */
export const hashAt = async (
	reads: RepoReads,
	rootTree: ResolvedSha,
	segments: readonly string[],
): Promise<string | null> => {
	if (segments.length === 0) return rootTree;
	const parent = await walk(reads, rootTree, segments.slice(0, -1));
	if (parent === null || parent.kind !== "tree") return null;
	return parent.entries.find((e) => e.name === segments.at(-1))?.hash ?? null;
};

export const treeEntries = (
	segments: readonly string[],
	entries: readonly RepoStoreTreeEntry[],
): TreeEntry[] =>
	entries.map((e) => ({
		name: e.name,
		path: [...segments, e.name].join("/"),
		mode: e.mode,
		hash: e.hash,
		type: e.type,
	}));

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

const TRAILER = /^([A-Za-z0-9][A-Za-z0-9-]*)\s*:\s?(.*)$/;

/** `Key: value` lines of a message's last paragraph (as `git interpret-trailers` reads them). */
export const trailersOf = (message: string): Trailer[] => {
	const paragraphs = message.trimEnd().split(/\n[ \t]*\n/);
	if (paragraphs.length < 2) return [];
	const out: { key: string; value: string }[] = [];
	for (const line of paragraphs[paragraphs.length - 1].split("\n")) {
		const m = TRAILER.exec(line);
		if (m) out.push({ key: m[1], value: m[2].trim() });
		else if (/^\s+\S/.test(line) && out.length > 0) {
			out[out.length - 1].value += ` ${line.trim()}`;
		} else return [];
	}
	return out;
};

export const commitMeta = (c: RepoStoreCommit): CommitMeta => ({
	sha: c.hash,
	treeSha: c.treeHash,
	subject: c.message.split("\n", 1)[0].trim(),
	message: c.message,
	author: { name: c.author.name, email: c.author.email },
	committer: { name: c.committer.name, email: c.committer.email },
	parents: [...c.parents],
	authoredAt: c.authoredAt,
	committedAt: c.committedAt,
	trailers: trailersOf(c.message),
});

/** Bytes look like text: no NUL in the first 8000 bytes and valid UTF-8. */
export const isText = (bytes: Uint8Array): boolean => {
	if (bytes.subarray(0, 8000).includes(0)) return false;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return true;
	} catch {
		return false;
	}
};
