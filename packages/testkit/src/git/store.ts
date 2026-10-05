// In-memory git object store plus builders: write a file snapshot as trees,
// commit it, walk history and reachability. Each fake Artifacts repo owns one
// store (repos share nothing, as on the platform).

import { text, utf8 } from "../bytes.ts";
import {
	type CommitFields,
	encodeCommit,
	encodeTree,
	type GitObject,
	hashObject,
	MODE,
	parseCommit,
	parseTag,
	parseTree,
	type Signature,
	type TreeEntry,
} from "./objects.ts";

export type ObjectStore = {
	put(object: GitObject): string;
	get(oid: string): GitObject | undefined;
	has(oid: string): boolean;
	readonly size: number;
	oids(): string[];
};

export const createObjectStore = (
	seed: Iterable<[string, GitObject]> = [],
): ObjectStore => {
	const objects = new Map<string, GitObject>(seed);
	return {
		put: (object) => {
			const oid = hashObject(object);
			if (!objects.has(oid)) objects.set(oid, object);
			return oid;
		},
		get: (oid) => objects.get(oid),
		has: (oid) => objects.has(oid),
		get size() {
			return objects.size;
		},
		oids: () => [...objects.keys()],
	};
};

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/** A file's content, or content with an explicit mode (exec, symlink). */
export type FileSpec =
	| string
	| Uint8Array
	| { readonly content: string | Uint8Array; readonly mode?: string };

/** `path → content`; a `null` value deletes the path when applied as a change set. */
export type FileMap = Readonly<Record<string, FileSpec>>;
export type FileChanges = Readonly<Record<string, FileSpec | null>>;

const specBytes = (spec: FileSpec): Uint8Array =>
	typeof spec === "string"
		? utf8(spec)
		: spec instanceof Uint8Array
		? spec
		: typeof spec.content === "string"
		? utf8(spec.content)
		: spec.content;

const specMode = (spec: FileSpec): string =>
	typeof spec === "object" && !(spec instanceof Uint8Array)
		? spec.mode ?? MODE.file
		: MODE.file;

const checkPath = (path: string): string[] => {
	const parts = path.split("/");
	if (
		path === "" || parts.some((p) => p === "" || p === "." || p === "..")
	) {
		throw new Error(`invalid repo path: ${path}`);
	}
	return parts;
};

/** Writes `files` as blobs and trees; returns the root tree SHA. */
export const writeTree = (store: ObjectStore, files: FileMap): string => {
	type Dir = Map<string, Dir | { mode: string; oid: string }>;
	const root: Dir = new Map();
	for (const [path, spec] of Object.entries(files)) {
		const parts = checkPath(path);
		const dir = parts.slice(0, -1).reduce<Dir>((d, part) => {
			const next = d.get(part);
			if (next instanceof Map) return next;
			if (next) throw new Error(`path conflicts with a file: ${path}`);
			const created: Dir = new Map();
			d.set(part, created);
			return created;
		}, root);
		const blob = store.put({ type: "blob", data: specBytes(spec) });
		dir.set(parts[parts.length - 1], { mode: specMode(spec), oid: blob });
	}
	const writeDir = (dir: Dir): string =>
		store.put(
			encodeTree(
				[...dir.entries()].map(([name, v]): TreeEntry =>
					v instanceof Map
						? { mode: MODE.tree, name, oid: writeDir(v) }
						: { mode: v.mode, name, oid: v.oid }
				),
			),
		);
	return writeDir(root);
};

/** Every file under `tree` with its mode (gitlinks skipped). */
export const readFileSpecs = (
	store: ObjectStore,
	tree: string,
	prefix = "",
): Record<string, { content: Uint8Array; mode: string }> => {
	const object = store.get(tree);
	if (!object || object.type !== "tree") throw new Error(`not a tree: ${tree}`);
	return Object.fromEntries(
		parseTree(object.data).flatMap((e) => {
			const path = prefix ? `${prefix}/${e.name}` : e.name;
			if (e.mode === MODE.tree) {
				return Object.entries(readFileSpecs(store, e.oid, path));
			}
			if (e.mode === MODE.gitlink) return [];
			const blob = store.get(e.oid);
			return blob ? [[path, { content: blob.data, mode: e.mode }]] : [];
		}),
	);
};

/** Every file under `tree` as `path → bytes`. */
export const readFiles = (
	store: ObjectStore,
	tree: string,
): Record<string, Uint8Array> =>
	Object.fromEntries(
		Object.entries(readFileSpecs(store, tree)).map(([p, s]) => [p, s.content]),
	);

export const readTextFiles = (
	store: ObjectStore,
	tree: string,
): Record<string, string> =>
	Object.fromEntries(
		Object.entries(readFiles(store, tree)).map(([p, b]) => [p, text(b)]),
	);

/** Resolves `path` inside `tree` to a tree entry, or null. */
export const lookupPath = (
	store: ObjectStore,
	tree: string,
	path: string,
): TreeEntry | null => {
	const parts = path.split("/").filter((p) => p !== "");
	if (parts.length === 0) return null;
	let current = tree;
	for (let i = 0; i < parts.length; i++) {
		const object = store.get(current);
		if (!object || object.type !== "tree") return null;
		const entry = parseTree(object.data).find((e) => e.name === parts[i]);
		if (!entry) return null;
		if (i === parts.length - 1) return entry;
		if (entry.mode !== MODE.tree) return null;
		current = entry.oid;
	}
	return null;
};

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

export const FIXTURE_AUTHOR = {
	name: "Tartan Fixture",
	email: "fixture@example.invalid",
} as const;

/** Fixture commits use a fixed clock so their SHAs are stable across runs. */
export const FIXTURE_EPOCH = 1_790_000_000;

export type CommitSpec = {
	readonly parents?: readonly string[];
	readonly message: string;
	readonly author?: { readonly name: string; readonly email: string };
	/** Unix seconds; defaults to `FIXTURE_EPOCH`. */
	readonly at?: number;
	readonly extraHeaders?: readonly (readonly [string, string])[];
};

export const writeCommit = (
	store: ObjectStore,
	tree: string,
	spec: CommitSpec,
): string => {
	const who = spec.author ?? FIXTURE_AUTHOR;
	const sig: Signature = { ...who, at: spec.at ?? FIXTURE_EPOCH };
	const message = spec.message.endsWith("\n")
		? spec.message
		: `${spec.message}\n`;
	const fields: CommitFields = {
		tree,
		parents: spec.parents ?? [],
		author: sig,
		committer: sig,
		extraHeaders: spec.extraHeaders,
		message,
	};
	return store.put(encodeCommit(fields));
};

export const readCommitFields = (
	store: ObjectStore,
	oid: string,
): CommitFields | null => {
	const object = store.get(oid);
	return object?.type === "commit" ? parseCommit(object.data) : null;
};

/** The files of `commit` with `changes` applied (`null` deletes). */
export const applyChanges = (
	store: ObjectStore,
	commit: string | null,
	changes: FileChanges,
): FileMap => {
	const base: Record<string, FileSpec> = commit === null
		? {}
		: readFileSpecs(store, readCommitFields(store, commit)?.tree ?? "");
	const next = { ...base };
	for (const [path, spec] of Object.entries(changes)) {
		if (spec === null) delete next[path];
		else next[path] = spec;
	}
	return next;
};

/** Commits `changes` on top of `parent` (or a root commit). */
export const commitChanges = (
	store: ObjectStore,
	parent: string | null,
	changes: FileChanges,
	spec: Omit<CommitSpec, "parents"> & { readonly parents?: readonly string[] },
): string => {
	const tree = writeTree(store, applyChanges(store, parent, changes));
	return writeCommit(store, tree, {
		...spec,
		parents: spec.parents ?? (parent === null ? [] : [parent]),
	});
};

/** First-parent history from `from`, newest first. */
export const firstParentChain = (
	store: ObjectStore,
	from: string,
	limit = Infinity,
): string[] => {
	const out: string[] = [];
	let current: string | undefined = from;
	while (current && out.length < limit) {
		const fields = readCommitFields(store, current);
		if (!fields) break;
		out.push(current);
		current = fields.parents[0];
	}
	return out;
};

/**
 * Every object reachable from `roots`, excluding everything reachable from
 * `exclude` (the client's haves). Missing objects are reported, not thrown.
 */
export const reachableObjects = (
	store: ObjectStore,
	roots: readonly string[],
	exclude: readonly string[] = [],
): { oids: string[]; missing: string[] } => {
	const walk = (start: readonly string[], skip: Set<string>) => {
		const seen = new Set<string>();
		const missing: string[] = [];
		const stack = [...start];
		while (stack.length > 0) {
			const oid = stack.pop()!;
			if (seen.has(oid) || skip.has(oid)) continue;
			const object = store.get(oid);
			if (!object) {
				missing.push(oid);
				continue;
			}
			seen.add(oid);
			if (object.type === "commit") {
				const c = parseCommit(object.data);
				stack.push(c.tree, ...c.parents);
			} else if (object.type === "tree") {
				for (const e of parseTree(object.data)) {
					if (e.mode !== MODE.gitlink) stack.push(e.oid);
				}
			} else if (object.type === "tag") {
				stack.push(parseTag(object.data).object);
			}
		}
		return { seen, missing };
	};
	const excluded = walk(exclude.filter((oid) => store.has(oid)), new Set())
		.seen;
	const { seen, missing } = walk(roots, excluded);
	return { oids: [...seen], missing };
};

/** True when `ancestor` is reachable from `descendant` through parents. */
export const isAncestor = (
	store: ObjectStore,
	ancestor: string,
	descendant: string,
): boolean => {
	const stack = [descendant];
	const seen = new Set<string>();
	while (stack.length > 0) {
		const oid = stack.pop()!;
		if (oid === ancestor) return true;
		if (seen.has(oid)) continue;
		seen.add(oid);
		stack.push(...(readCommitFields(store, oid)?.parents ?? []));
	}
	return false;
};
