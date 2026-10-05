// Hash-pruned tree diff: two trees are compared
// entry by entry and a subtree is read only when its hash differs, so the
// cost follows the size of the change, not of the repo. Each side reads
// from its own object source (a lane repo against the canonical repo).
// Renames are detected for identical content (git's `-M100%`).

import type { PathChange } from "@tartan/contract";
import {
	createLimiter,
	type GitObjects,
	type RawTreeEntry,
	requireTree,
} from "./objects.ts";

export type TreeSide = {
	readonly objects: GitObjects;
	/** Root tree hash; null is the empty tree. */
	readonly tree: string | null;
};

export type TreeChange = {
	readonly path: string;
	readonly change: PathChange;
	readonly oldPath?: string;
	readonly oldHash?: string;
	readonly newHash?: string;
	readonly oldMode?: string;
	readonly newMode?: string;
};

export type TreeDiff = {
	/** Sorted by path. */
	readonly changes: readonly TreeChange[];
	/** More than `maxPaths` paths changed; `changes` holds the first ones found. */
	readonly truncated: boolean;
};

export type TreeDiffOptions = {
	/** Default 10,000. */
	readonly maxPaths?: number;
	/** Tree reads in flight (default 8). */
	readonly concurrency?: number;
	/** Detect identical-content renames (default true). */
	readonly renames?: boolean;
};

export const TREE_DIFF_MAX_PATHS = 10_000;
export const TREE_DIFF_CONCURRENCY = 8;

const isTree = (e: RawTreeEntry): boolean => e.type === "tree";
const isFileLike = (e: RawTreeEntry): boolean => !isTree(e);
const join = (dir: string, name: string): string =>
	dir === "" ? name : `${dir}/${name}`;

class Overflow extends Error {}

/** The changes from `oldSide` to `newSide`. */
export const diffTrees = async (
	oldSide: TreeSide,
	newSide: TreeSide,
	options: TreeDiffOptions = {},
): Promise<TreeDiff> => {
	const maxPaths = options.maxPaths ?? TREE_DIFF_MAX_PATHS;
	const limit = createLimiter(options.concurrency ?? TREE_DIFF_CONCURRENCY);
	const found: TreeChange[] = [];
	let truncated = false;
	const push = (change: TreeChange) => {
		if (found.length >= maxPaths) {
			truncated = true;
			throw new Overflow();
		}
		found.push(change);
	};
	const read = (objects: GitObjects, hash: string | null) =>
		hash === null
			? Promise.resolve([] as readonly RawTreeEntry[])
			: limit(() => requireTree(objects, hash));

	/** Every file under a whole subtree that exists on one side only. */
	const listAll = async (
		side: TreeSide,
		dir: string,
		hash: string,
		as: "added" | "deleted",
	): Promise<void> => {
		const entries = await read(side.objects, hash);
		await Promise.all(entries.map((e) => {
			const path = join(dir, e.name);
			if (isTree(e)) return listAll(side, path, e.hash, as);
			push(
				as === "added"
					? { path, change: "added", newHash: e.hash, newMode: e.mode }
					: { path, change: "deleted", oldHash: e.hash, oldMode: e.mode },
			);
			return undefined;
		}));
	};

	const compare = async (
		dir: string,
		oldHash: string | null,
		newHash: string | null,
	): Promise<void> => {
		if (oldHash === newHash || truncated) return;
		const [olds, news] = await Promise.all([
			read(oldSide.objects, oldHash),
			read(newSide.objects, newHash),
		]);
		const byName = new Map<string, [RawTreeEntry?, RawTreeEntry?]>();
		for (const e of olds) byName.set(e.name, [e, undefined]);
		for (const e of news) {
			byName.set(e.name, [byName.get(e.name)?.[0], e]);
		}
		const tasks: Promise<void>[] = [];
		for (const [name, [o, n]] of byName) {
			const path = join(dir, name);
			if (o && n && o.hash === n.hash && o.mode === n.mode) continue;
			if (o && n && isTree(o) && isTree(n)) {
				tasks.push(compare(path, o.hash, n.hash));
				continue;
			}
			if (o && n && isFileLike(o) && isFileLike(n)) {
				const linkish = (e: RawTreeEntry) =>
					e.type === "symlink"
						? "symlink"
						: e.type === "gitlink"
						? "gitlink"
						: "file";
				push({
					path,
					change: linkish(o) === linkish(n) ? "modified" : "type",
					oldHash: o.hash,
					newHash: n.hash,
					oldMode: o.mode,
					newMode: n.mode,
				});
				continue;
			}
			if (o) {
				if (isTree(o)) tasks.push(listAll(oldSide, path, o.hash, "deleted"));
				else {push({
						path,
						change: "deleted",
						oldHash: o.hash,
						oldMode: o.mode,
					});}
			}
			if (n) {
				if (isTree(n)) tasks.push(listAll(newSide, path, n.hash, "added"));
				else push({ path, change: "added", newHash: n.hash, newMode: n.mode });
			}
		}
		await Promise.all(tasks);
	};

	try {
		await compare("", oldSide.tree, newSide.tree);
	} catch (error) {
		if (!(error instanceof Overflow)) throw error;
	}
	const sorted = found.sort((a, b) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0
	);
	return {
		changes: options.renames === false ? sorted : pairRenames(sorted),
		truncated,
	};
};

const base = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** Pairs each deleted file with an added file of identical content (same basename first). */
export const pairRenames = (changes: readonly TreeChange[]): TreeChange[] => {
	const added = new Map<string, TreeChange[]>();
	for (const c of changes) {
		if (c.change === "added" && c.newHash) {
			added.set(c.newHash, [...(added.get(c.newHash) ?? []), c]);
		}
	}
	const renamedFrom = new Map<string, TreeChange>();
	const consumed = new Set<TreeChange>();
	for (const c of changes) {
		if (c.change !== "deleted" || !c.oldHash) continue;
		const candidates = (added.get(c.oldHash) ?? []).filter((a) =>
			!consumed.has(a) && a.newMode === c.oldMode
		);
		if (candidates.length === 0) continue;
		const pick = candidates.find((a) => base(a.path) === base(c.path)) ??
			candidates[0];
		consumed.add(pick);
		consumed.add(c);
		renamedFrom.set(pick.path, c);
	}
	return changes.flatMap((c): TreeChange[] => {
		const from = renamedFrom.get(c.path);
		if (from && c.change === "added") {
			return [{
				path: c.path,
				change: "renamed",
				oldPath: from.path,
				oldHash: from.oldHash,
				newHash: c.newHash,
				oldMode: from.oldMode,
				newMode: c.newMode,
			}];
		}
		return consumed.has(c) ? [] : [c];
	});
};

/** Every path a change touches (both ends of a rename). */
export const touchedPaths = (changes: readonly TreeChange[]): string[] =>
	changes.flatMap((c) => c.oldPath ? [c.oldPath, c.path] : [c.path]);
