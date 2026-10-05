// Object caches for RepoProbe: trees, commits and blobs are immutable by hash,
// so they are cached keyed by `(familyId, kind, hash)`. `familyId` is the
// canonical repo id: its lane repos are seeded from it, so one hash is one
// object across the family, and a lane repo's object may serve a read of the
// same hash through another lane repo of that family. Never by hash alone: a
// lookup from another family misses. Layers: an isolate LRU, then the Cache
// API, then the caller reads the binding (and fills both layers from that read
// only).

import type {
	RepoStoreCommit,
	RepoStoreTreeEntry,
} from "@tartan/contract/kernel.ts";

export type CachedKind = "tree" | "commit" | "blob";

type Value<K extends CachedKind> = K extends "tree"
	? readonly RepoStoreTreeEntry[]
	: K extends "commit" ? RepoStoreCommit
	: Uint8Array;

/** The Cache API subset used (`caches.default`). */
export type CacheLike = {
	match(request: Request): Promise<Response | undefined>;
	put(request: Request, response: Response): Promise<void>;
};

export type ObjectCache = {
	get<K extends CachedKind>(
		familyId: string,
		kind: K,
		hash: string,
	): Promise<Value<K> | null>;
	put<K extends CachedKind>(
		familyId: string,
		kind: K,
		hash: string,
		value: Value<K>,
	): Promise<void>;
	stats(): {
		readonly hits: number;
		readonly edgeHits: number;
		readonly misses: number;
	};
};

export type ObjectCacheOptions = {
	/** Isolate LRU budget (approximate bytes; default 32 MiB). */
	readonly maxBytes?: number;
	/** Isolate LRU entries (default 20,000). */
	readonly maxEntries?: number;
	/** Blobs above this are never cached (default 1 MiB). */
	readonly maxBlobBytes?: number;
	/** The Cache API, when the runtime offers it (`caches.default`). */
	readonly edge?: CacheLike | null;
	/** Cache API lifetime (default 7 days; objects never change). */
	readonly edgeTtlSeconds?: number;
};

/** Synthetic URL the Cache API stores an object under. */
export const cacheUrl = (
	familyId: string,
	kind: CachedKind,
	hash: string,
): string =>
	`https://probe-cache.tartan.invalid/${
		encodeURIComponent(familyId)
	}/${kind}/${hash}`;

const sizeOf = (kind: CachedKind, value: unknown): number =>
	kind === "blob"
		? (value as Uint8Array).length + 64
		: JSON.stringify(value).length * 2;

export const createObjectCache = (
	options: ObjectCacheOptions = {},
): ObjectCache => {
	const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
	const maxEntries = options.maxEntries ?? 20_000;
	const maxBlob = options.maxBlobBytes ?? 1024 * 1024;
	const ttl = options.edgeTtlSeconds ?? 7 * 24 * 3600;
	const lru = new Map<string, { value: unknown; size: number }>();
	let bytes = 0;
	const counters = { hits: 0, edgeHits: 0, misses: 0 };

	const remember = (key: string, value: unknown, size: number) => {
		const old = lru.get(key);
		if (old) {
			bytes -= old.size;
			lru.delete(key);
		}
		lru.set(key, { value, size });
		bytes += size;
		for (const [k, v] of lru) {
			if (bytes <= maxBytes && lru.size <= maxEntries) break;
			lru.delete(k);
			bytes -= v.size;
		}
	};

	const edgeGet = async (
		url: string,
		kind: CachedKind,
	): Promise<unknown | null> => {
		if (!options.edge) return null;
		try {
			const res = await options.edge.match(new Request(url));
			if (!res) return null;
			return kind === "blob"
				? new Uint8Array(await res.arrayBuffer())
				: await res.json();
		} catch {
			return null; // the Cache API is an optimisation; any failure is a miss
		}
	};

	const edgePut = async (url: string, kind: CachedKind, value: unknown) => {
		if (!options.edge) return;
		const body = kind === "blob"
			? (value as Uint8Array).slice()
			: JSON.stringify(value);
		try {
			await options.edge.put(
				new Request(url),
				new Response(body, {
					headers: {
						"cache-control": `public, max-age=${ttl}, immutable`,
						"content-type": kind === "blob"
							? "application/octet-stream"
							: "application/json",
					},
				}),
			);
		} catch {
			// best effort
		}
	};

	return {
		async get(familyId, kind, hash) {
			const key = `${familyId}\u0000${kind}\u0000${hash}`;
			const hit = lru.get(key);
			if (hit) {
				lru.delete(key);
				lru.set(key, hit);
				counters.hits++;
				return hit.value as never;
			}
			const edge = await edgeGet(cacheUrl(familyId, kind, hash), kind);
			if (edge !== null) {
				counters.edgeHits++;
				remember(key, edge, sizeOf(kind, edge));
				return edge as never;
			}
			counters.misses++;
			return null;
		},
		async put(familyId, kind, hash, value) {
			const size = sizeOf(kind, value);
			if (kind === "blob" && (value as Uint8Array).length > maxBlob) return;
			remember(`${familyId}\u0000${kind}\u0000${hash}`, value, size);
			await edgePut(cacheUrl(familyId, kind, hash), kind, value);
		},
		stats: () => ({ ...counters }),
	};
};
