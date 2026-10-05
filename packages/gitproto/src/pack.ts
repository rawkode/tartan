// A minimal pack writer (gitformat-pack, version 2) for the kernel's in-Worker
// writes (genesis, the swarm, seedHistory): whole objects only (undeltified),
// each zlib-compressed with the platform `CompressionStream("deflate")`,
// followed by the SHA-1 trailer. Also the object encoders those writers need,
// producing objects that `git index-pack --strict` (fsck) accepts.

import { invalid } from "@tartan/contract";
import {
	asBytes,
	type Bytes,
	byteTransform,
	concat,
	fromHex,
	readCapped,
	streamOf,
	toHex,
	utf8,
} from "./bytes.ts";

export type PackObject = {
	readonly type: "commit" | "tree" | "blob" | "tag";
	readonly data: Uint8Array;
};

const TYPE_CODES = { commit: 1, tree: 2, blob: 3, tag: 4 } as const;

const sha1 = async (data: Uint8Array): Promise<Uint8Array> =>
	new Uint8Array(await crypto.subtle.digest("SHA-1", asBytes(data)));

/** The object id git gives `data` stored as `type` (`<type> <size>\0<data>`). */
export const hashObject = async (
	type: PackObject["type"],
	data: Uint8Array,
): Promise<string> =>
	toHex(await sha1(concat([utf8(`${type} ${data.length}\0`), data])));

const deflate = async (data: Uint8Array): Promise<Uint8Array> => {
	const read = await readCapped(
		streamOf(data).pipeThrough(byteTransform(new CompressionStream("deflate"))),
		Number.MAX_SAFE_INTEGER,
	);
	if (!read.ok) throw invalid("deflate failed");
	return read.bytes;
};

/** The pack entry header: type and size as git's little-endian varint. */
const entryHeader = (type: number, size: number): Uint8Array => {
	const bytes: number[] = [];
	let byte = (type << 4) | (size & 0x0f);
	let rest = Math.floor(size / 16);
	while (rest > 0) {
		bytes.push(byte | 0x80);
		byte = rest & 0x7f;
		rest = Math.floor(rest / 128);
	}
	bytes.push(byte);
	return new Uint8Array(bytes);
};

const be32 = (n: number): Uint8Array =>
	new Uint8Array([
		(n >>> 24) & 255,
		(n >>> 16) & 255,
		(n >>> 8) & 255,
		n & 255,
	]);

/**
 * A minimal pack of whole (never delta-encoded) objects, with each object's
 * SHA-1 (`ids[i]` belongs to `objects[i]`). An object given twice is
 * written once. `writePack([])` is the empty pack a ref-only push sends.
 */
export const writePack = async (
	objects: readonly PackObject[],
): Promise<{ readonly pack: Bytes; readonly ids: readonly string[] }> => {
	const ids = await Promise.all(
		objects.map((object) => hashObject(object.type, object.data)),
	);
	const seen = new Set<string>();
	const unique: PackObject[] = [];
	objects.forEach((object, index) => {
		if (seen.has(ids[index])) return;
		seen.add(ids[index]);
		unique.push(object);
	});
	const parts: Uint8Array[] = [utf8("PACK"), be32(2), be32(unique.length)];
	for (const object of unique) {
		parts.push(entryHeader(TYPE_CODES[object.type], object.data.length));
		parts.push(await deflate(object.data));
	}
	const body = concat(parts);
	return { pack: concat([body, await sha1(body)]), ids };
};

/** Tree entry modes git writes (`40000` for trees: no zero padding). */
export type TreeMode = "100644" | "100755" | "120000" | "40000" | "160000";

export type TreeEntryInput = {
	readonly mode: TreeMode;
	readonly name: string;
	/** 40-hex object id. */
	readonly id: string;
};

const MODES = new Set<string>([
	"100644",
	"100755",
	"120000",
	"40000",
	"160000",
]);

const validEntryName = (name: string): boolean =>
	name.length > 0 && name !== "." && name !== ".." &&
	!name.includes("/") && !name.includes("\0") &&
	name.toLowerCase() !== ".git";

/** git's tree order: byte order, with a tree's name compared as `name/`. */
const sortKey = (entry: TreeEntryInput): Uint8Array =>
	utf8(entry.mode === "40000" ? `${entry.name}/` : entry.name);

const compareBytes = (a: Uint8Array, b: Uint8Array): number => {
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
	return a.length - b.length;
};

/** Encodes a tree object (entries sorted the way fsck requires). */
export const encodeTree = (entries: readonly TreeEntryInput[]): Bytes => {
	const names = new Set<string>();
	for (const entry of entries) {
		if (!MODES.has(entry.mode)) throw invalid(`tree entry mode ${entry.mode}`);
		if (!validEntryName(entry.name)) {
			throw invalid(`tree entry name ${entry.name}`);
		}
		if (!/^[0-9a-f]{40}$/.test(entry.id)) throw invalid("tree entry id");
		if (names.has(entry.name)) {
			throw invalid(`duplicate tree entry ${entry.name}`);
		}
		names.add(entry.name);
	}
	const sorted = [...entries].sort((a, b) =>
		compareBytes(sortKey(a), sortKey(b))
	);
	return concat(
		sorted.flatMap((entry) => [
			utf8(`${entry.mode} ${entry.name}\0`),
			fromHex(entry.id),
		]),
	);
};

export type Signature = {
	readonly name: string;
	readonly email: string;
	/** Seconds since the epoch. */
	readonly at: number;
	/** `+hhmm` / `-hhmm` (default `+0000`). */
	readonly tz?: string;
};

const signature = (s: Signature): string => {
	if (/[<>\n]/.test(s.name) || /[<>\n]/.test(s.email)) {
		throw invalid("signature name or email contains <, > or a newline");
	}
	const tz = s.tz ?? "+0000";
	if (!/^[+-][0-9]{4}$/.test(tz)) throw invalid(`timezone ${tz}`);
	return `${s.name} <${s.email}> ${Math.floor(s.at)} ${tz}`;
};

/** Encodes a commit object. `message` should end with a newline. */
export const encodeCommit = (input: {
	readonly tree: string;
	readonly parents?: readonly string[];
	readonly author: Signature;
	readonly committer?: Signature;
	readonly message: string;
}): Bytes => {
	const ids = [input.tree, ...(input.parents ?? [])];
	if (!ids.every((id) => /^[0-9a-f]{40}$/.test(id))) throw invalid("commit id");
	const lines = [
		`tree ${input.tree}`,
		...(input.parents ?? []).map((parent) => `parent ${parent}`),
		`author ${signature(input.author)}`,
		`committer ${signature(input.committer ?? input.author)}`,
	];
	return utf8(`${lines.join("\n")}\n\n${input.message}`);
};
