// Commits for simulated agents (WP20): blobs, the trees
// on the paths of the edited files and a commit on top of a parent, as git
// objects for `@tartan/gitproto`'s pack writer (whole objects, no deltas).
// Unchanged subtrees are referenced by id, so the pack carries only what
// changed; the receiving repo already has the rest.
//
// A `TreeState` caches directory listings (by path) of the agent's current
// head: it is filled from the repo (`repo_tree` by commit) the first time a
// directory is needed and updated with every commit the agent builds, so a
// lane's later pushes read nothing.

import {
	encodeCommit,
	encodeTree,
	hashObject,
	type PackObject,
	type Signature,
	type TreeEntryInput,
	type TreeMode,
} from "@tartan/gitproto";

export type DirEntry = {
	readonly name: string;
	readonly mode: TreeMode;
	readonly id: string;
};

/** Lists a directory of `commit` (`""` is the root); null when it does not exist. */
export type TreeReader = (
	commit: string,
	path: string,
) => Promise<readonly DirEntry[] | null>;

export type TreeState = {
	/** The commit whose tree this state describes. */
	readonly commit: string;
	/** Directory path → its entries (only the directories read or written). */
	readonly dirs: ReadonlyMap<string, readonly DirEntry[]>;
};

export type FileEdit = { readonly path: string; readonly content: string };

export type BuiltCommit = {
	readonly commit: string;
	readonly tree: string;
	readonly objects: readonly PackObject[];
	/** The state after this commit (its dirs include every touched path). */
	readonly state: TreeState;
};

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** `040000` (as some listings print it) → `40000`, as trees encode it. */
export const normalizeMode = (mode: string): TreeMode => {
	const m = mode.replace(/^0+(?=\d{5}$)/, "");
	if (
		m === "100644" || m === "100755" || m === "120000" || m === "40000" ||
		m === "160000"
	) return m;
	throw new Error(`unknown tree entry mode ${mode}`);
};

const parentOf = (path: string): string => {
	const cut = path.lastIndexOf("/");
	return cut === -1 ? "" : path.slice(0, cut);
};

const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const depth = (path: string): number =>
	path === "" ? 0 : path.split("/").length;

const ancestors = (dir: string): string[] => {
	const out: string[] = [];
	let cur = dir;
	for (;;) {
		out.push(cur);
		if (cur === "") return out;
		cur = parentOf(cur);
	}
};

const setEntry = (
	entries: readonly DirEntry[],
	entry: DirEntry,
): DirEntry[] => [...entries.filter((e) => e.name !== entry.name), entry];

/** An empty state for a commit (directories are read on demand). */
export const treeStateOf = (commit: string): TreeState => ({
	commit,
	dirs: new Map(),
});

/**
 * Builds a commit with `edits` applied to `state.commit`'s tree. Each edit
 * replaces or adds a regular file; missing directories are created.
 */
export const buildCommit = async (input: {
	readonly state: TreeState;
	readonly read: TreeReader;
	readonly edits: readonly FileEdit[];
	readonly message: string;
	readonly author: Signature;
}): Promise<BuiltCommit> => {
	if (input.edits.length === 0) throw new Error("a commit needs an edit");
	const dirs = new Map(input.state.dirs);
	const known = async (dir: string): Promise<readonly DirEntry[]> => {
		const cached = dirs.get(dir);
		if (cached) return cached;
		const read = await input.read(input.state.commit, dir);
		const entries = read ?? [];
		dirs.set(dir, entries);
		return entries;
	};
	const objects: PackObject[] = [];
	const touched = new Set<string>();
	for (const edit of input.edits) {
		const data = utf8(edit.content);
		const id = await hashObject("blob", data);
		objects.push({ type: "blob", data });
		const dir = parentOf(edit.path);
		// Every directory on the way must be known before it is rewritten.
		for (const d of ancestors(dir).reverse()) await known(d);
		dirs.set(
			dir,
			setEntry(dirs.get(dir) ?? [], {
				name: nameOf(edit.path),
				mode: "100644",
				id,
			}),
		);
		for (const d of ancestors(dir)) touched.add(d);
	}
	// Rewrite touched directories deepest first; each new tree id goes into
	// its parent's listing.
	const order = [...touched].sort((a, b) => depth(b) - depth(a));
	let root = "";
	for (const dir of order) {
		const entries = dirs.get(dir) ?? [];
		const data = encodeTree(entries as readonly TreeEntryInput[]);
		const id = await hashObject("tree", data);
		objects.push({ type: "tree", data });
		if (dir === "") {
			root = id;
		} else {
			const parent = parentOf(dir);
			dirs.set(
				parent,
				setEntry(dirs.get(parent) ?? [], {
					name: nameOf(dir),
					mode: "40000",
					id,
				}),
			);
		}
	}
	const message = input.message.endsWith("\n")
		? input.message
		: `${input.message}\n`;
	const data = encodeCommit({
		tree: root,
		parents: [input.state.commit],
		author: input.author,
		message,
	});
	const commit = await hashObject("commit", data);
	objects.push({ type: "commit", data });
	return {
		commit,
		tree: root,
		objects,
		state: { commit, dirs },
	};
};
