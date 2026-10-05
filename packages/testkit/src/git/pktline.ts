// pkt-line framing (git protocol v0/v1/v2) for the fakes and the captures.
// A deliberately independent implementation: the product's codecs live in
// `packages/gitproto` (WP22), and a fake that shared them could not catch
// their bugs.

import { type Bytes, concat, text, utf8 } from "../bytes.ts";

export const FLUSH = "0000";
export const DELIM = "0001";
export const RESPONSE_END = "0002";

export type Pkt =
	| { readonly kind: "data"; readonly data: Uint8Array }
	| { readonly kind: "flush" }
	| { readonly kind: "delim" }
	| { readonly kind: "response-end" };

export const MAX_PKT_DATA = 65516;

/** One data pkt-line: 4 hex length digits (including themselves) + payload. */
export const pkt = (payload: string | Uint8Array): Bytes => {
	const data = typeof payload === "string" ? utf8(payload) : payload;
	if (data.length > MAX_PKT_DATA) throw new Error("pkt-line too long");
	return concat([utf8((data.length + 4).toString(16).padStart(4, "0")), data]);
};

export const flushPkt = (): Bytes => utf8(FLUSH);
export const delimPkt = (): Bytes => utf8(DELIM);

/** Splits `data` into side-band packets on `band` (1 data, 2 progress, 3 error). */
export const sideband = (
	band: 1 | 2 | 3,
	data: Uint8Array,
	max = 65515,
): Bytes[] => {
	const out: Bytes[] = [];
	for (let i = 0; i < data.length; i += max) {
		out.push(pkt(concat([Uint8Array.of(band), data.subarray(i, i + max)])));
	}
	return out;
};

export type PktParse = {
	readonly pkts: Pkt[];
	/** Bytes consumed (the offset where parsing stopped). */
	readonly offset: number;
};

/**
 * Parses pkt-lines from `offset`; stops at the end of input, at a malformed
 * length, or after the `stopAfterFlush`-th flush.
 */
export const parsePkts = (
	bytes: Uint8Array,
	offset = 0,
	stopAfterFlush = Infinity,
): PktParse => {
	const pkts: Pkt[] = [];
	let at = offset;
	let flushes = 0;
	while (at + 4 <= bytes.length && flushes < stopAfterFlush) {
		const head = text(bytes.subarray(at, at + 4));
		if (!/^[0-9a-f]{4}$/.test(head)) break;
		const len = parseInt(head, 16);
		if (len === 0) {
			pkts.push({ kind: "flush" });
			flushes++;
			at += 4;
			continue;
		}
		if (len === 1) {
			pkts.push({ kind: "delim" });
			at += 4;
			continue;
		}
		if (len === 2) {
			pkts.push({ kind: "response-end" });
			at += 4;
			continue;
		}
		if (len < 4 || at + len > bytes.length) break;
		pkts.push({ kind: "data", data: bytes.subarray(at + 4, at + len) });
		at += len;
	}
	return { pkts, offset: at };
};

/** The text of a data pkt without one trailing LF. */
export const pktText = (p: Pkt): string | null =>
	p.kind === "data" ? text(p.data).replace(/\n$/, "") : null;

/** Reassembles band-1 data from side-band packets (band 2/3 collected separately). */
export const demuxSideband = (
	pkts: readonly Pkt[],
): { data: Uint8Array; progress: string[]; errors: string[] } => {
	const data: Uint8Array[] = [];
	const progress: string[] = [];
	const errors: string[] = [];
	for (const p of pkts) {
		if (p.kind !== "data" || p.data.length === 0) continue;
		const body = p.data.subarray(1);
		if (p.data[0] === 1) data.push(body);
		else if (p.data[0] === 2) progress.push(text(body));
		else if (p.data[0] === 3) errors.push(text(body));
	}
	return { data: concat(data), progress, errors };
};
