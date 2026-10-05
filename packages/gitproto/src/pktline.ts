// pkt-line codec (gitprotocol-common): `<4-hex length><payload>`, where the
// length counts its own 4 bytes, plus the special packets flush `0000`, delim
// `0001` and response-end `0002`. Decoding is strict: a non-hex length,
// `0003`, a length above 65,520 or a packet cut short is an error, never a
// best effort.

import { invalid } from "@tartan/contract";
import { type Bytes, utf8 } from "./bytes.ts";

/** Special packets: flush `0000`, delim `0001` (v2), response-end `0002` (v2). */
export const PKT_FLUSH = "0000" as const;
export const PKT_DELIM = "0001" as const;
export const PKT_RESPONSE_END = "0002" as const;
/** The largest pkt-line, length header included (65,520 bytes). */
export const PKT_MAX_LENGTH = 65_520;
/** The largest side-band payload: `side-band-64k` 65,515, `side-band` 995. */
export const SIDE_BAND_MAX_DATA = {
	"side-band-64k": 65_515,
	"side-band": 995,
} as const;

export type PktLine =
	| { readonly kind: "data"; readonly data: Uint8Array }
	| { readonly kind: "flush" }
	| { readonly kind: "delim" }
	| { readonly kind: "response-end" };

/** Why a pkt-line stream is malformed. */
export type PktErrorCode = "bad-length" | "oversized" | "truncated";

const HEX = /^[0-9a-fA-F]{4}$/;
const SPECIAL = {
	flush: utf8(PKT_FLUSH),
	delim: utf8(PKT_DELIM),
	"response-end": utf8(PKT_RESPONSE_END),
} as const;

const hex4 = (n: number): string => n.toString(16).padStart(4, "0");

/** Encodes one data pkt-line (`<4-hex length><payload>`); throws above `PKT_MAX_LENGTH`. */
export const encodePktLine = (payload: string | Uint8Array): Bytes => {
	const data = typeof payload === "string" ? utf8(payload) : payload;
	const length = data.length + 4;
	if (length > PKT_MAX_LENGTH) {
		throw invalid(`pkt-line payload of ${data.length} bytes is too long`, {
			code: "oversized",
		});
	}
	const out = new Uint8Array(length);
	out.set(utf8(hex4(length)), 0);
	out.set(data, 4);
	return out;
};

/** Encodes a special packet. */
export const encodeSpecialPkt = (
	kind: "flush" | "delim" | "response-end",
): Bytes => SPECIAL[kind].slice();

/** One step of the incremental decoder. */
export type PktStep =
	| { readonly ok: true; readonly line: PktLine; readonly next: number }
	| { readonly ok: false; readonly incomplete: true }
	| {
		readonly ok: false;
		readonly incomplete: false;
		readonly code: PktErrorCode;
	};

/**
 * Decodes the packet at `offset`. `incomplete` means more bytes are needed;
 * a malformed header is reported as soon as its 4 bytes are present.
 */
export const readPkt = (bytes: Uint8Array, offset: number): PktStep => {
	if (bytes.length - offset < 4) return { ok: false, incomplete: true };
	const header = String.fromCharCode(
		bytes[offset],
		bytes[offset + 1],
		bytes[offset + 2],
		bytes[offset + 3],
	);
	if (!HEX.test(header)) {
		return { ok: false, incomplete: false, code: "bad-length" };
	}
	const length = parseInt(header, 16);
	if (length === 0) {
		return { ok: true, line: { kind: "flush" }, next: offset + 4 };
	}
	if (length === 1) {
		return { ok: true, line: { kind: "delim" }, next: offset + 4 };
	}
	if (length === 2) {
		return { ok: true, line: { kind: "response-end" }, next: offset + 4 };
	}
	if (length < 4) return { ok: false, incomplete: false, code: "bad-length" };
	if (length > PKT_MAX_LENGTH) {
		return { ok: false, incomplete: false, code: "oversized" };
	}
	if (bytes.length - offset < length) return { ok: false, incomplete: true };
	return {
		ok: true,
		line: { kind: "data", data: bytes.subarray(offset + 4, offset + length) },
		next: offset + length,
	};
};

/**
 * Strict decode of a whole buffer: a malformed, truncated or oversized length
 * (or `0003`) rejects, never a best effort. `rest` holds bytes after the last
 * complete packet when `allowRest`.
 */
export const decodePktLines = (
	bytes: Uint8Array,
	options: { readonly maxLines?: number; readonly allowRest?: boolean } = {},
): { readonly lines: readonly PktLine[]; readonly rest: Uint8Array } => {
	const lines: PktLine[] = [];
	const maxLines = options.maxLines ?? Number.POSITIVE_INFINITY;
	let offset = 0;
	while (offset < bytes.length) {
		if (lines.length >= maxLines) {
			if (options.allowRest) break;
			throw invalid(`more than ${maxLines} pkt-lines`, { code: "oversized" });
		}
		const step = readPkt(bytes, offset);
		if (!step.ok) {
			if (step.incomplete && options.allowRest) break;
			const code: PktErrorCode = step.incomplete ? "truncated" : step.code;
			throw invalid(`malformed pkt-line at byte ${offset} (${code})`, {
				code,
				offset,
			});
		}
		lines.push(step.line);
		offset = step.next;
	}
	return { lines, rest: bytes.subarray(offset) };
};

/** The payload without one trailing LF (git's `PACKET_READ_CHOMP_NEWLINE`). */
export const chomp = (data: Uint8Array): Uint8Array =>
	data.length > 0 && data[data.length - 1] === 0x0a
		? data.subarray(0, data.length - 1)
		: data;
