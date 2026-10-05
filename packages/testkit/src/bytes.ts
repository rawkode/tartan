// Byte helpers shared by the git codecs and the fakes. Portable: runs under
// Deno and in workerd (`nodejs_compat` provides `node:crypto` and
// `node:zlib`).

import { createHash } from "node:crypto";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const utf8 = (text: string): Bytes => encoder.encode(text);
export const text = (bytes: Uint8Array): string => decoder.decode(bytes);

/** Bytes backed by a plain ArrayBuffer (usable as a fetch body). */
export type Bytes = Uint8Array<ArrayBuffer>;

export const concat = (parts: readonly Uint8Array[]): Bytes => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	parts.reduce((offset, part) => {
		out.set(part, offset);
		return offset + part.length;
	}, 0);
	return out;
};

export const toHex = (bytes: Uint8Array): string =>
	Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export const fromHex = (hex: string): Uint8Array => {
	if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
		throw new Error(`not hex: ${hex}`);
	}
	return Uint8Array.from(
		{ length: hex.length / 2 },
		(_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16),
	);
};

export const sha1Hex = (bytes: Uint8Array): string =>
	createHash("sha1").update(bytes).digest("hex");

export const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
	a.length === b.length && a.every((v, i) => v === b[i]);

/** Reads a whole body (stream, buffer or null) into bytes. */
export const readAll = async (
	body: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | null,
): Promise<Uint8Array> => {
	if (body === null) return new Uint8Array(0);
	if (body instanceof Uint8Array) return body;
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	return new Uint8Array(await new Response(body).arrayBuffer());
};

/** Base64 (standard alphabet) for captures stored as text. */
export const fromBase64 = (b64: string): Uint8Array =>
	Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
export const toBase64 = (bytes: Uint8Array): string =>
	btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
