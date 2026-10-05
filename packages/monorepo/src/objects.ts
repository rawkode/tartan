// The read port the planner is written against, a concurrency limiter and a
// path view over one root tree. Every read takes an object hash (K15); the
// caller binds the port to the repo that holds the objects (RepoProbe's
// `RepoReader`, or an in-memory fake in tests).

import type { TreeEntryType } from "@tartan/contract";

/** One immediate child of a git tree (the Artifacts `readTree` shape). */
export type RawTreeEntry = {
	readonly name: string;
	readonly mode: string;
	readonly hash: string;
	readonly type: TreeEntryType;
};

/** SHA-only object reads, bound to one repo family. */
export interface GitObjects {
	/** Entries of a tree by its hash; null when the object is missing. */
	readTree(hash: string): Promise<readonly RawTreeEntry[] | null>;
	/** Bytes of a blob by its hash; null when the object is missing. */
	readBlob(hash: string): Promise<Uint8Array | null>;
}

/** A tree or blob the planner needed is missing from the repo it read (never "absent"). */
export class MissingObjectError extends Error {
	constructor(readonly kind: "tree" | "blob", readonly hash: string) {
		super(`missing ${kind} ${hash}`);
		this.name = "MissingObjectError";
	}
}

export const requireTree = async (
	objects: GitObjects,
	hash: string,
): Promise<readonly RawTreeEntry[]> => {
	const entries = await objects.readTree(hash);
	if (entries === null) throw new MissingObjectError("tree", hash);
	return entries;
};

export const requireBlob = async (
	objects: GitObjects,
	hash: string,
): Promise<Uint8Array> => {
	const bytes = await objects.readBlob(hash);
	if (bytes === null) throw new MissingObjectError("blob", hash);
	return bytes;
};

/** Runs at most `n` tasks at once, in submission order. */
export const createLimiter = (n: number) => {
	let active = 0;
	const queue: (() => void)[] = [];
	const release = () => {
		active--;
		queue.shift()?.();
	};
	return async <T>(task: () => Promise<T>): Promise<T> => {
		if (active >= n) await new Promise<void>((go) => queue.push(go));
		active++;
		try {
			return await task();
		} finally {
			release();
		}
	};
};
export type Limiter = ReturnType<typeof createLimiter>;

/** Manifests larger than this are not parsed (they cannot be real manifests). */
export const MANIFEST_MAX_BYTES = 1024 * 1024;

const decoder = new TextDecoder();

/**
 * Path lookups under one root tree, memoised per view. `dir("")` is the
 * root. Absent paths read as null; missing objects throw.
 */
export const createTreeView = (objects: GitObjects, rootTree: string) => {
	const dirs = new Map<string, Promise<readonly RawTreeEntry[] | null>>();
	const dir = (path: string): Promise<readonly RawTreeEntry[] | null> => {
		const cached = dirs.get(path);
		if (cached) return cached;
		const result = (async () => {
			if (path === "") return await requireTree(objects, rootTree);
			const i = path.lastIndexOf("/");
			const parent = await dir(i === -1 ? "" : path.slice(0, i));
			const entry = parent?.find((e) => e.name === path.slice(i + 1));
			return entry?.type === "tree"
				? await requireTree(objects, entry.hash)
				: null;
		})();
		dirs.set(path, result);
		return result;
	};
	const entry = async (path: string): Promise<RawTreeEntry | null> => {
		if (path === "") {
			return { name: "", mode: "40000", hash: rootTree, type: "tree" };
		}
		const i = path.lastIndexOf("/");
		const parent = await dir(i === -1 ? "" : path.slice(0, i));
		return parent?.find((e) => e.name === path.slice(i + 1)) ?? null;
	};
	const text = async (path: string): Promise<string | null> => {
		const e = await entry(path);
		if (!e || (e.type !== "blob" && e.type !== "exec")) return null;
		const bytes = await requireBlob(objects, e.hash);
		return bytes.length > MANIFEST_MAX_BYTES ? null : decoder.decode(bytes);
	};
	/** Directories under `base` (inclusive), breadth-first, to `maxDepth` levels below it. */
	const subdirs = async (base: string, maxDepth: number): Promise<string[]> => {
		const found: string[] = [];
		let level = [base];
		for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
			found.push(...level);
			const next: string[] = [];
			// One level at a time, its listings in parallel (the caller's
			// `GitObjects` bounds the reads in flight); same order as before.
			const listings = await Promise.all(level.map((path) => dir(path)));
			for (const [i, path] of level.entries()) {
				for (const e of listings[i] ?? []) {
					if (
						e.type === "tree" && e.name !== "node_modules" && e.name !== ".git"
					) {
						next.push(path === "" ? e.name : `${path}/${e.name}`);
					}
				}
			}
			level = next;
		}
		return found;
	};
	return { rootTree, dir, entry, text, subdirs };
};
export type TreeView = ReturnType<typeof createTreeView>;
