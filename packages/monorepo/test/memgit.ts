// In-memory git objects for tests: trees and blobs with real git SHA-1 ids
// (so hashes match what `git hash-object`/`git write-tree` would produce),
// exposed through the `GitObjects` port with read counters.

import { createHash } from "node:crypto";
import type { GitObjects, RawTreeEntry } from "../src/index.ts";

type Stored =
	| { readonly kind: "blob"; readonly bytes: Uint8Array }
	| { readonly kind: "tree"; readonly entries: RawTreeEntry[] };

export type FileSpec = string | {
	readonly content: string;
	readonly mode: string;
};

const enc = new TextEncoder();

const hashObject = (type: string, body: Uint8Array): string => {
	const header = enc.encode(`${type} ${body.length}\0`);
	return createHash("sha1").update(header).update(body).digest("hex");
};

const hexBytes = (hex: string): Uint8Array =>
	Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));

const typeOf = (mode: string): RawTreeEntry["type"] =>
	mode === "40000"
		? "tree"
		: mode === "100755"
		? "exec"
		: mode === "120000"
		? "symlink"
		: mode === "160000"
		? "gitlink"
		: "blob";

export const createMemGit = () => {
	const store = new Map<string, Stored>();
	const reads = { tree: 0, blob: 0 };
	const blob = (content: string): string => {
		const bytes = enc.encode(content);
		const hash = hashObject("blob", bytes);
		store.set(hash, { kind: "blob", bytes });
		return hash;
	};
	const tree = (entries: RawTreeEntry[]): string => {
		// git orders tree entries by name, with directories compared as "name/".
		const key = (e: RawTreeEntry) => e.type === "tree" ? `${e.name}/` : e.name;
		const sorted = [...entries].sort((a, b) => key(a) < key(b) ? -1 : 1);
		const parts: Uint8Array[] = sorted.flatMap((e) => [
			enc.encode(`${e.mode} ${e.name}\0`),
			hexBytes(e.hash),
		]);
		const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
		let at = 0;
		for (const p of parts) {
			body.set(p, at);
			at += p.length;
		}
		const hash = hashObject("tree", body);
		store.set(hash, { kind: "tree", entries: sorted });
		return hash;
	};
	/** Writes a whole tree from `{ "dir/file": content }` and returns its hash. */
	const writeTree = (files: Readonly<Record<string, FileSpec>>): string => {
		type Dir = Map<string, Dir | FileSpec>;
		const root: Dir = new Map();
		for (const [path, spec] of Object.entries(files)) {
			const segs = path.split("/");
			let dir = root;
			for (const seg of segs.slice(0, -1)) {
				let next = dir.get(seg);
				if (!(next instanceof Map)) {
					next = new Map();
					dir.set(seg, next);
				}
				dir = next;
			}
			dir.set(segs.at(-1)!, spec);
		}
		const write = (dir: Dir): string =>
			tree([...dir.entries()].map(([name, value]) => {
				if (value instanceof Map) {
					return { name, mode: "40000", hash: write(value), type: "tree" };
				}
				const content = typeof value === "string" ? value : value.content;
				const mode = typeof value === "string" ? "100644" : value.mode;
				return { name, mode, hash: blob(content), type: typeOf(mode) };
			}));
		return write(root);
	};
	const objects: GitObjects = {
		readTree: (hash) => {
			reads.tree++;
			const o = store.get(hash);
			return Promise.resolve(o?.kind === "tree" ? o.entries : null);
		},
		readBlob: (hash) => {
			reads.blob++;
			const o = store.get(hash);
			return Promise.resolve(o?.kind === "blob" ? o.bytes : null);
		},
	};
	return { blob, tree, writeTree, objects, reads, store };
};
export type MemGit = ReturnType<typeof createMemGit>;
