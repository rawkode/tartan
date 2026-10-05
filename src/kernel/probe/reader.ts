// The `RepoReader` (contract ports.ts, K15) RepoProbe reads through: bound
// to one Artifacts repo (the canonical repo, or the current lane repo of a
// `repo`-backend lane) chosen by `GitSource` through RepoDO; every read
// takes a SHA, never a refname; object reads go through the family cache;
// every binding call takes a token from the isolate bucket and a slot of
// the request's concurrency limit.

import { type GitSource, invalid } from "@tartan/contract";
import {
	isResolvedSha,
	REPO_READER_LIMITS,
	type RepoReader,
	type RepoStoreCommit,
	type RepoStoreRepo,
	type RepoStoreTreeEntry,
	type ResolvedSha,
} from "@tartan/contract/kernel.ts";
import {
	createTreeView,
	type GitObjects,
	type Limiter,
} from "@tartan/monorepo";
import type { TokenBucket } from "./bucket.ts";
import type { ObjectCache } from "./cache.ts";

/** The repo-handle methods RepoProbe uses (reads only). */
export type RepoHandle = Pick<
	RepoStoreRepo,
	"readTree" | "readCommit" | "readBlob" | "log"
>;

/** One binding call, for read accounting (tests and logs). */
export type ReadEvent = {
	readonly repo: string;
	readonly op: "readTree" | "readCommit" | "readBlob" | "log";
	readonly hash: string;
};

export type ProbeReaderDeps = {
	readonly source: GitSource;
	/** The Artifacts repo name `upstream()` resolved for `source`. */
	readonly artifactsName: string;
	readonly repo: RepoHandle;
	readonly cache: ObjectCache;
	readonly bucket: TokenBucket;
	readonly limit: Limiter;
	readonly onRead?: (event: ReadEvent) => void;
};

export type ProbeReader = RepoReader & {
	readonly artifactsName: string;
	/** The same reads through the planner's port (blobs as bytes). */
	readonly objects: GitObjects;
	readBlobBytes(sha: ResolvedSha): Promise<Uint8Array | null>;
	/** Blob bytes only if the family cache already holds them (no binding read). */
	cachedBlob(sha: string): Promise<Uint8Array | null>;
};

const sha = (value: string): ResolvedSha => {
	if (!isResolvedSha(value)) throw invalid(`reads take a sha (K15): ${value}`);
	return value;
};

export const createProbeReader = (deps: ProbeReaderDeps): ProbeReader => {
	const family = deps.source.repoId;
	const { cache } = deps;
	const binding = async <T>(
		op: ReadEvent["op"],
		hash: string,
		call: () => Promise<T>,
	): Promise<T> => {
		await deps.bucket.take();
		return await deps.limit(() => {
			deps.onRead?.({ repo: deps.artifactsName, op, hash });
			return call();
		});
	};

	const readTree = async (
		hash: ResolvedSha,
	): Promise<RepoStoreTreeEntry[] | null> => {
		const cached = await cache.get(family, "tree", hash);
		if (cached) return [...cached];
		const entries = await binding(
			"readTree",
			hash,
			() => deps.repo.readTree(hash),
		);
		if (entries) await cache.put(family, "tree", hash, entries);
		return entries;
	};

	const readCommit = async (
		hash: ResolvedSha,
	): Promise<RepoStoreCommit | null> => {
		const cached = await cache.get(family, "commit", hash);
		if (cached) return cached;
		const commit = await binding(
			"readCommit",
			hash,
			() => deps.repo.readCommit(hash),
		);
		if (commit) await cache.put(family, "commit", hash, commit);
		return commit;
	};

	const readBlobBytes = async (
		hash: ResolvedSha,
	): Promise<Uint8Array | null> => {
		const cached = await cache.get(family, "blob", hash);
		if (cached) return cached;
		const blob = await binding(
			"readBlob",
			hash,
			() => deps.repo.readBlob(hash),
		);
		if (!blob) return null;
		const bytes = new Uint8Array(await blob.arrayBuffer());
		await cache.put(family, "blob", hash, bytes);
		return bytes;
	};

	const log = async (
		from: ResolvedSha,
		options: { readonly limit?: number; readonly offset?: number } = {},
	): Promise<RepoStoreCommit[]> => {
		const limit = Math.min(options.limit ?? 50, REPO_READER_LIMITS.logMax);
		const page = await binding(
			"log",
			from,
			() => deps.repo.log({ ref: from, limit, offset: options.offset ?? 0 }),
		);
		await Promise.all(page.map((c) => cache.put(family, "commit", c.hash, c)));
		return page;
	};

	const objects: GitObjects = {
		readTree: (hash) => readTree(sha(hash)),
		readBlob: (hash) => readBlobBytes(sha(hash)),
	};

	return {
		source: deps.source,
		artifactsName: deps.artifactsName,
		readCommit: (hash) => readCommit(sha(hash)),
		readTree: (hash) => readTree(sha(hash)),
		readBlob: async (hash) => {
			const bytes = await readBlobBytes(sha(hash));
			return bytes ? new Blob([bytes as Uint8Array<ArrayBuffer>]) : null;
		},
		readFile: async (commit, path) => {
			const c = await readCommit(sha(commit));
			if (!c) return null;
			const entry = await createTreeView(objects, c.treeHash).entry(path);
			if (!entry || entry.type === "tree") return null;
			const bytes = await readBlobBytes(sha(entry.hash));
			return bytes ? new Blob([bytes as Uint8Array<ArrayBuffer>]) : null;
		},
		log: (from, options) => log(sha(from), options),
		readBlobBytes: (hash) => readBlobBytes(sha(hash)),
		cachedBlob: (hash) => cache.get(family, "blob", hash),
		objects,
	};
};
