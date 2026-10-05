// Packfile v2 writer (undeltified objects) and reader (including OFS_DELTA
// and REF_DELTA, so packs from stock git and thin packs both parse).

import { deflateSync, inflateSync } from "node:zlib";
import {
	type Bytes,
	concat,
	equalBytes,
	fromHex,
	sha1Hex,
	text,
	toHex,
} from "../bytes.ts";
import { type GitObject, hashObject, type ObjectType } from "./objects.ts";

const TYPE_CODE: Readonly<Record<ObjectType, number>> = {
	commit: 1,
	tree: 2,
	blob: 3,
	tag: 4,
};
const CODE_TYPE: Readonly<Record<number, ObjectType>> = {
	1: "commit",
	2: "tree",
	3: "blob",
	4: "tag",
};
const OFS_DELTA = 6;
const REF_DELTA = 7;

const PACK_SIGNATURE = [0x50, 0x41, 0x43, 0x4b]; // "PACK"

const objectHeader = (type: number, size: number): Uint8Array => {
	const bytes: number[] = [];
	let byte = (type << 4) | (size & 0x0f);
	let rest = Math.floor(size / 16);
	while (rest > 0) {
		bytes.push(byte | 0x80);
		byte = rest & 0x7f;
		rest = Math.floor(rest / 128);
	}
	bytes.push(byte);
	return Uint8Array.from(bytes);
};

const u32 = (n: number): Uint8Array =>
	Uint8Array.of(
		(n >>> 24) & 0xff,
		(n >>> 16) & 0xff,
		(n >>> 8) & 0xff,
		n & 0xff,
	);

/** A version-2 pack of `objects`, each stored whole (no deltas), with its SHA-1 trailer. */
export const writePack = (objects: readonly GitObject[]): Bytes => {
	const body = concat([
		Uint8Array.from(PACK_SIGNATURE),
		u32(2),
		u32(objects.length),
		...objects.flatMap((o) => [
			objectHeader(TYPE_CODE[o.type], o.data.length),
			new Uint8Array(deflateSync(o.data)),
		]),
	]);
	return concat([body, fromHex(sha1Hex(body))]);
};

/** True when `bytes` starts like a pack (`PACK`, version 2 or 3). */
export const isPack = (bytes: Uint8Array, offset = 0): boolean =>
	bytes.length >= offset + 12 &&
	PACK_SIGNATURE.every((b, i) => bytes[offset + i] === b);

type InflateInfo = { buffer: Uint8Array; engine: { bytesWritten: number } };

/** Inflates the zlib stream at `offset`; returns the data and the compressed length. */
const inflateAt = (
	bytes: Uint8Array,
	offset: number,
): { data: Uint8Array; consumed: number } => {
	const r = inflateSync(bytes.subarray(offset), {
		info: true,
	}) as unknown as InflateInfo;
	return { data: new Uint8Array(r.buffer), consumed: r.engine.bytesWritten };
};

const readVarint = (
	bytes: Uint8Array,
	offset: number,
): { value: number; offset: number } => {
	let value = 0;
	let shift = 1;
	let at = offset;
	for (;;) {
		const b = bytes[at++];
		value += (b & 0x7f) * shift;
		shift *= 128;
		if ((b & 0x80) === 0) return { value, offset: at };
	}
};

/** Applies a git delta to `base`. */
export const applyDelta = (base: Uint8Array, delta: Uint8Array): Uint8Array => {
	const src = readVarint(delta, 0);
	if (src.value !== base.length) throw new Error("delta base size mismatch");
	const dst = readVarint(delta, src.offset);
	const out = new Uint8Array(dst.value);
	let at = dst.offset;
	let written = 0;
	while (at < delta.length) {
		const op = delta[at++];
		if (op & 0x80) {
			let off = 0;
			let size = 0;
			for (let i = 0; i < 4; i++) {
				if (op & (1 << i)) off += delta[at++] * 2 ** (8 * i);
			}
			for (let i = 0; i < 3; i++) {
				if (op & (1 << (4 + i))) size += delta[at++] * 2 ** (8 * i);
			}
			if (size === 0) size = 0x10000;
			out.set(base.subarray(off, off + size), written);
			written += size;
		} else if (op > 0) {
			out.set(delta.subarray(at, at + op), written);
			at += op;
			written += op;
		} else {
			throw new Error("delta opcode 0 is reserved");
		}
	}
	if (written !== out.length) throw new Error("delta result size mismatch");
	return out;
};

export type PackParse = {
	/** Objects in pack order (deltas resolved), keyed by SHA. */
	readonly objects: Map<string, GitObject>;
	/** Offset just after the pack trailer. */
	readonly end: number;
	/** Delta entries in the pack (OFS_DELTA + REF_DELTA). */
	readonly deltas: number;
};

/**
 * Parses a pack at `offset`. `resolveBase` supplies REF_DELTA bases that are
 * not in the pack (thin packs). Throws on a bad signature, a checksum
 * mismatch or an unresolvable delta. Bytes after the trailer are left to the
 * caller (`end`).
 */
export const readPack = (
	bytes: Uint8Array,
	offset = 0,
	resolveBase: (oid: string) => GitObject | undefined = () => undefined,
): PackParse => {
	if (!isPack(bytes, offset)) throw new Error("not a pack");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const version = view.getUint32(offset + 4);
	if (version !== 2 && version !== 3) {
		throw new Error(`unsupported pack version ${version}`);
	}
	const count = view.getUint32(offset + 8);
	const byOffset = new Map<number, GitObject>();
	const objects = new Map<string, GitObject>();
	const pendingRef: { at: number; base: string; delta: Uint8Array }[] = [];
	let at = offset + 12;
	let deltas = 0;
	for (let i = 0; i < count; i++) {
		const start = at;
		let byte = bytes[at++];
		const type = (byte >> 4) & 0x07;
		let size = byte & 0x0f;
		let shift = 16;
		while (byte & 0x80) {
			byte = bytes[at++];
			size += (byte & 0x7f) * shift;
			shift *= 128;
		}
		if (type === OFS_DELTA) {
			let b = bytes[at++];
			let rel = b & 0x7f;
			while (b & 0x80) {
				b = bytes[at++];
				rel = (rel + 1) * 128 + (b & 0x7f);
			}
			const { data, consumed } = inflateAt(bytes, at);
			at += consumed;
			const base = byOffset.get(start - rel);
			if (!base) throw new Error("OFS_DELTA base not found");
			const object = { type: base.type, data: applyDelta(base.data, data) };
			byOffset.set(start, object);
			objects.set(hashObject(object), object);
			deltas++;
		} else if (type === REF_DELTA) {
			const base = toHex(bytes.subarray(at, at + 20));
			at += 20;
			const { data, consumed } = inflateAt(bytes, at);
			at += consumed;
			pendingRef.push({ at: start, base, delta: data });
			deltas++;
		} else {
			const objectType = CODE_TYPE[type];
			if (!objectType) throw new Error(`bad pack object type ${type}`);
			const { data, consumed } = inflateAt(bytes, at);
			at += consumed;
			if (data.length !== size) throw new Error("pack object size mismatch");
			const object = { type: objectType, data };
			byOffset.set(start, object);
			objects.set(hashObject(object), object);
		}
	}
	// REF_DELTA bases may come later in the pack or from the receiving repo.
	let remaining = pendingRef;
	while (remaining.length > 0) {
		const next = remaining.filter((p) => {
			const base = objects.get(p.base) ?? resolveBase(p.base);
			if (!base) return true;
			const object = { type: base.type, data: applyDelta(base.data, p.delta) };
			byOffset.set(p.at, object);
			objects.set(hashObject(object), object);
			return false;
		});
		if (next.length === remaining.length) {
			throw new Error(`REF_DELTA base missing: ${next[0].base}`);
		}
		remaining = next;
	}
	const trailer = bytes.subarray(at, at + 20);
	if (trailer.length !== 20) throw new Error("truncated pack trailer");
	if (!equalBytes(trailer, fromHex(sha1Hex(bytes.subarray(offset, at))))) {
		throw new Error("pack checksum mismatch");
	}
	return { objects, end: at + 20, deltas };
};

/** A short, printable summary of a pack (for evidence and assertion messages). */
export const describePack = (bytes: Uint8Array): string =>
	isPack(bytes)
		? `${text(bytes.subarray(0, 4))} v${bytes[7]} objects=${
			new DataView(bytes.buffer, bytes.byteOffset).getUint32(8)
		} bytes=${bytes.length}`
		: `not a pack (${bytes.length} bytes)`;
