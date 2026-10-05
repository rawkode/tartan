// Test helpers shared by the Deno and workerd suites: the recorded goldens,
// chunked streams and small byte utilities. No Deno APIs here, so the
// workerd tests can import it too.

import captures from "./goldens/captures.json" with { type: "json" };
import { decodeBase64 } from "./harness/base64.ts";

export type Golden = {
	readonly name: string;
	readonly op: string;
	readonly gitProtocol: string | null;
	readonly contentEncoding: string | null;
	readonly contentLength: boolean;
	readonly body: Uint8Array<ArrayBuffer>;
	readonly response: Uint8Array<ArrayBuffer>;
};

export const goldenNames = (): string[] => captures.map((c) => c.name);

export const golden = (name: string): Golden => {
	const found = captures.find((c) => c.name === name);
	if (!found) throw new Error(`no golden ${name}`);
	return {
		name: found.name,
		op: found.op,
		gitProtocol: found.gitProtocol,
		contentEncoding: found.contentEncoding,
		contentLength: found.contentLength,
		body: decodeBase64(found.body),
		response: decodeBase64(found.response),
	};
};

export const enc = (text: string): Uint8Array<ArrayBuffer> =>
	new TextEncoder().encode(text);
export const dec = (bytes: Uint8Array): string =>
	new TextDecoder().decode(bytes);

/** A stream that delivers `bytes` in chunks of `size` (1 = byte by byte). */
export const chunked = (
	bytes: Uint8Array,
	size = 1 << 30,
): ReadableStream<Uint8Array> => {
	let offset = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset >= bytes.length) {
				controller.close();
				return;
			}
			const end = Math.min(offset + size, bytes.length);
			controller.enqueue(bytes.slice(offset, end));
			offset = end;
		},
	});
};

export const readAll = async (
	stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array<ArrayBuffer>> => {
	const parts: Uint8Array[] = [];
	const reader = stream.getReader();
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		parts.push(value);
	}
	let size = 0;
	for (const part of parts) size += part.length;
	const out = new Uint8Array(size);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
};

/** gzip-compresses `bytes` with the platform CompressionStream. */
export const gzip = async (
	bytes: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> =>
	await readAll(
		chunked(bytes).pipeThrough(
			new CompressionStream("gzip") as unknown as ReadableWritablePair<
				Uint8Array,
				Uint8Array
			>,
		),
	);

/** pkt-line framing for test bodies (strings get no implicit newline). */
export const pkt = (payload: string | Uint8Array): Uint8Array<ArrayBuffer> => {
	const data = typeof payload === "string" ? enc(payload) : payload;
	const header = enc((data.length + 4).toString(16).padStart(4, "0"));
	const out = new Uint8Array(header.length + data.length);
	out.set(header);
	out.set(data, header.length);
	return out;
};

export const join = (
	...parts: (string | Uint8Array)[]
): Uint8Array<ArrayBuffer> => {
	const bytes = parts.map((p) => typeof p === "string" ? enc(p) : p);
	let size = 0;
	for (const b of bytes) size += b.length;
	const out = new Uint8Array(size);
	let offset = 0;
	for (const b of bytes) {
		out.set(b, offset);
		offset += b.length;
	}
	return out;
};

export const FLUSH = "0000";
export const DELIM = "0001";

/** Deterministic PRNG (xorshift32) for the property tests. */
export const prng = (seed: number) => {
	let state = seed >>> 0 || 1;
	const next = (): number => {
		state ^= state << 13;
		state >>>= 0;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		return state;
	};
	return {
		next,
		int: (n: number): number => next() % n,
		pick: <T>(items: readonly T[]): T => items[next() % items.length],
		bool: (): boolean => (next() & 1) === 1,
	};
};

export const SHA_A = "1111111111111111111111111111111111111111";
export const SHA_B = "2222222222222222222222222222222222222222";
export const SHA_C = "3333333333333333333333333333333333333333";
export const ZERO = "0000000000000000000000000000000000000000";
