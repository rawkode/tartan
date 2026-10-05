// Git loose-object model: encoding, hashing and parsing of blobs, trees,
// commits and tags (SHA-1 object format). The fakes keep real git objects,
// so SHAs computed here equal the SHAs stock git computes for the same
// content.

import { concat, fromHex, sha1Hex, text, toHex, utf8 } from "../bytes.ts";

export type ObjectType = "blob" | "tree" | "commit" | "tag";

export type GitObject = {
	readonly type: ObjectType;
	readonly data: Uint8Array;
};

export const SHA_RE = /^[0-9a-f]{40}$/;
export const ZERO_OID = "0".repeat(40);

/** The SHA-1 of `<type> <size>\0<data>`. */
export const hashObject = (object: GitObject): string =>
	sha1Hex(
		concat([utf8(`${object.type} ${object.data.length}\0`), object.data]),
	);

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

/** Canonical git modes as they appear in tree objects (a tree is `40000`). */
export const MODE = {
	tree: "40000",
	file: "100644",
	exec: "100755",
	symlink: "120000",
	gitlink: "160000",
} as const;

export type TreeEntry = {
	readonly mode: string;
	readonly name: string;
	readonly oid: string;
};

/** Git's tree order: names compare bytewise, a tree as if it ended in `/`. */
const sortKey = (e: TreeEntry): string =>
	e.mode === MODE.tree ? `${e.name}/` : e.name;

export const encodeTree = (entries: readonly TreeEntry[]): GitObject => {
	const sorted = [...entries].sort((a, b) => {
		const ka = sortKey(a);
		const kb = sortKey(b);
		return ka < kb ? -1 : ka > kb ? 1 : 0;
	});
	return {
		type: "tree",
		data: concat(
			sorted.flatMap((e) => [utf8(`${e.mode} ${e.name}\0`), fromHex(e.oid)]),
		),
	};
};

export const parseTree = (data: Uint8Array): TreeEntry[] => {
	const entries: TreeEntry[] = [];
	let offset = 0;
	while (offset < data.length) {
		const space = data.indexOf(0x20, offset);
		const nul = data.indexOf(0, space);
		if (space < 0 || nul < 0 || nul + 21 > data.length) {
			throw new Error("malformed tree object");
		}
		entries.push({
			mode: text(data.subarray(offset, space)),
			name: text(data.subarray(space + 1, nul)),
			oid: toHex(data.subarray(nul + 1, nul + 21)),
		});
		offset = nul + 21;
	}
	return entries;
};

// ---------------------------------------------------------------------------
// Commits and tags
// ---------------------------------------------------------------------------

export type Signature = {
	readonly name: string;
	readonly email: string;
	/** Unix seconds. */
	readonly at: number;
	/** `+0000` style offset. */
	readonly tz?: string;
};

export type CommitFields = {
	readonly tree: string;
	readonly parents: readonly string[];
	readonly author: Signature;
	readonly committer: Signature;
	/** Extra headers after `committer` (e.g. `change-id`), in order. */
	readonly extraHeaders?: readonly (readonly [string, string])[];
	readonly message: string;
};

const formatSignature = (s: Signature): string =>
	`${s.name} <${s.email}> ${s.at} ${s.tz ?? "+0000"}`;

const SIGNATURE_RE = /^(.*) <([^>]*)> (-?\d+) ([+-]\d{4})$/;

export const parseSignature = (line: string): Signature => {
	const m = SIGNATURE_RE.exec(line);
	if (!m) throw new Error(`malformed signature: ${line}`);
	return { name: m[1], email: m[2], at: Number(m[3]), tz: m[4] };
};

export const encodeCommit = (c: CommitFields): GitObject => {
	const headers = [
		`tree ${c.tree}`,
		...c.parents.map((p) => `parent ${p}`),
		`author ${formatSignature(c.author)}`,
		`committer ${formatSignature(c.committer)}`,
		...(c.extraHeaders ?? []).map(([k, v]) => `${k} ${v}`),
	];
	return {
		type: "commit",
		data: utf8(`${headers.join("\n")}\n\n${c.message}`),
	};
};

const splitHeaders = (
	data: Uint8Array,
): { headers: [string, string][]; message: string } => {
	const raw = text(data);
	const blank = raw.indexOf("\n\n");
	const head = blank < 0 ? raw : raw.slice(0, blank);
	const message = blank < 0 ? "" : raw.slice(blank + 2);
	const headers: [string, string][] = [];
	for (const line of head.split("\n")) {
		if (line.startsWith(" ") && headers.length > 0) {
			// Continuation line (e.g. gpgsig): folded into the previous header.
			const last = headers[headers.length - 1];
			last[1] = `${last[1]}\n${line.slice(1)}`;
			continue;
		}
		const space = line.indexOf(" ");
		headers.push(
			space < 0 ? [line, ""] : [line.slice(0, space), line.slice(space + 1)],
		);
	}
	return { headers, message };
};

export const parseCommit = (data: Uint8Array): CommitFields => {
	const { headers, message } = splitHeaders(data);
	const one = (key: string): string => {
		const found = headers.find(([k]) => k === key);
		if (!found) throw new Error(`commit without ${key}`);
		return found[1];
	};
	const known = new Set(["tree", "parent", "author", "committer"]);
	return {
		tree: one("tree"),
		parents: headers.filter(([k]) => k === "parent").map(([, v]) => v),
		author: parseSignature(one("author")),
		committer: parseSignature(one("committer")),
		extraHeaders: headers.filter(([k]) => !known.has(k)),
		message,
	};
};

export type TagFields = {
	readonly object: string;
	readonly type: ObjectType;
	readonly tag: string;
	readonly tagger: Signature;
	readonly message: string;
};

export const encodeTag = (t: TagFields): GitObject => ({
	type: "tag",
	data: utf8(
		`object ${t.object}\ntype ${t.type}\ntag ${t.tag}\ntagger ${
			formatSignature(t.tagger)
		}\n\n${t.message}`,
	),
});

export const parseTag = (data: Uint8Array): TagFields => {
	const { headers, message } = splitHeaders(data);
	const get = (key: string): string =>
		headers.find(([k]) => k === key)?.[1] ?? "";
	return {
		object: get("object"),
		type: get("type") as ObjectType,
		tag: get("tag"),
		tagger: parseSignature(get("tagger")),
		message,
	};
};
