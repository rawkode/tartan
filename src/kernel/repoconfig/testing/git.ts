// Test-only (Deno): real git objects in a `@tartan/testkit` object store,
// served through the `ConfigReads` port, with read faults to inject (a
// null commit, an empty tree, a mismatched blob). Never imported by runtime
// code.

import {
	createObjectStore,
	type FileMap,
	MODE,
	type ObjectStore,
	parseTree,
	writeCommit,
	writeTree,
} from "@tartan/testkit";
import { isPolicyPath } from "@tartan/contract";
import { policyDigestOf } from "../key.ts";
import type { ConfigReads } from "../reader.ts";

export type ReadFaults = {
	/** Commits that read as null. */
	readonly nullCommits: Set<string>;
	/** Trees that read as null. */
	readonly nullTrees: Set<string>;
	/** Trees that read as empty. */
	readonly emptyTrees: Set<string>;
	/** Blobs that read as other bytes. */
	readonly corruptBlobs: Set<string>;
};

const typeOf = (mode: string): string =>
	mode === MODE.tree
		? "tree"
		: mode === MODE.symlink
		? "symlink"
		: mode === MODE.gitlink
		? "gitlink"
		: mode === MODE.exec
		? "exec"
		: "blob";

export type TestRepo = {
	readonly store: ObjectStore;
	readonly faults: ReadFaults;
	readonly reads: ConfigReads;
	/** Writes `files` as a commit (parent optional); returns its sha. */
	commit(files: FileMap, parents?: readonly string[]): string;
	/** The root `*.cue` digest of a commit (K13.3), or null when it has none. */
	policyDigest(sha: string): string | null;
	/** The number of reads served so far. */
	readonly count: { commit: number; tree: number; blob: number };
};

export const createTestRepo = (): TestRepo => {
	const store = createObjectStore();
	const faults: ReadFaults = {
		nullCommits: new Set(),
		nullTrees: new Set(),
		emptyTrees: new Set(),
		corruptBlobs: new Set(),
	};
	const count = { commit: 0, tree: 0, blob: 0 };
	const treeOf = (sha: string): string | null => {
		const obj = store.get(sha);
		if (obj === undefined || obj.type !== "commit") return null;
		const text = new TextDecoder().decode(obj.data);
		return /^tree ([0-9a-f]{40})/m.exec(text)?.[1] ?? null;
	};
	const reads: ConfigReads = {
		readCommit: (sha) => {
			count.commit += 1;
			if (faults.nullCommits.has(sha)) return Promise.resolve(null);
			const tree = treeOf(sha);
			return Promise.resolve(
				tree === null ? null : { hash: sha, treeHash: tree },
			);
		},
		readTree: (sha) => {
			count.tree += 1;
			if (faults.nullTrees.has(sha)) return Promise.resolve(null);
			if (faults.emptyTrees.has(sha)) return Promise.resolve([]);
			const obj = store.get(sha);
			if (obj === undefined || obj.type !== "tree") {
				return Promise.resolve(null);
			}
			return Promise.resolve(
				parseTree(obj.data).map((e) => ({
					name: e.name,
					mode: e.mode,
					hash: e.oid,
					type: typeOf(e.mode),
				})),
			);
		},
		readBlob: (sha) => {
			count.blob += 1;
			const obj = store.get(sha);
			if (obj === undefined || obj.type !== "blob") {
				return Promise.resolve(null);
			}
			if (faults.corruptBlobs.has(sha)) {
				return Promise.resolve(new TextEncoder().encode("tampered"));
			}
			return Promise.resolve(obj.data);
		},
	};
	return {
		store,
		faults,
		reads,
		count,
		commit: (files, parents = []) =>
			writeCommit(store, writeTree(store, files), {
				message: "test",
				parents: [...parents],
			}),
		policyDigest: (sha) => {
			const tree = treeOf(sha);
			if (tree === null) return null;
			const obj = store.get(tree)!;
			return policyDigestOf(
				parseTree(obj.data).filter((e) => isPolicyPath(e.name)).map((e) => ({
					name: e.name,
					mode: e.mode,
					oid: e.oid,
				})),
			);
		},
	};
};

/** A `package tartan` file body. */
export const cueFile = (body: string): string => `package tartan\n\n${body}\n`;
