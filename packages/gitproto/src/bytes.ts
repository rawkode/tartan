// Byte helpers shared by the codecs. Git's wire format is bytes; text is
// decoded only where the protocol defines it (ASCII headers, UTF-8 refnames).

const encoder = new TextEncoder();
/** Fatal UTF-8: a malformed sequence throws instead of becoming U+FFFD. */
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const lenientUtf8 = new TextDecoder("utf-8", { ignoreBOM: true });

export const utf8 = (text: string): Bytes => encoder.encode(text);

/** Decodes UTF-8 strictly; null when the bytes are not valid UTF-8. */
export const decodeStrict = (bytes: Uint8Array): string | null => {
	try {
		return strictUtf8.decode(bytes);
	} catch {
		return null;
	}
};

/** Decodes UTF-8 with replacement (diagnostics and upstream messages only). */
export const decodeLenient = (bytes: Uint8Array): string =>
	lenientUtf8.decode(bytes);

/** An ArrayBuffer-backed byte array (what WebCrypto, fetch and the stream codecs take). */
export type Bytes = Uint8Array<ArrayBuffer>;

/** Views any byte array as `Bytes`, copying only when it is not ArrayBuffer-backed. */
export const asBytes = (bytes: Uint8Array): Bytes =>
	bytes.buffer instanceof ArrayBuffer
		? (bytes as Bytes)
		: new Uint8Array(bytes) as Bytes;

/** A `CompressionStream`/`DecompressionStream` typed as a byte transform. */
export const byteTransform = (
	stream: CompressionStream | DecompressionStream,
): ReadableWritablePair<Uint8Array, Uint8Array> =>
	stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;

export const concat = (parts: readonly Uint8Array[]): Bytes => {
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

export const toHex = (bytes: Uint8Array): string => {
	let out = "";
	for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
	return out;
};

export const fromHex = (hex: string): Bytes => {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
};

export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
};

/**
 * An append-only byte buffer with amortized growth, so parsing a stream
 * delivered in tiny chunks stays linear (re-concatenating every chunk is
 * quadratic: 15 s for a 60 KB section sent one byte at a time).
 * `consume(n)` drops a parsed prefix. `view()` is invalidated by the next
 * `append`; copy anything that outlives it.
 */
export type ByteBuffer = {
	append(chunk: Uint8Array): void;
	view(): Uint8Array;
	consume(n: number): void;
	readonly length: number;
};

export const createByteBuffer = (initial = 4096): ByteBuffer => {
	let buf = new Uint8Array(initial);
	let start = 0;
	let end = 0;
	return {
		append(chunk) {
			if (end + chunk.length > buf.length) {
				const live = end - start;
				const needed = live + chunk.length;
				if (needed <= buf.length / 2) {
					buf.copyWithin(0, start, end); // compact in place
				} else {
					const next = new Uint8Array(Math.max(buf.length * 2, needed));
					next.set(buf.subarray(start, end), 0);
					buf = next;
				}
				start = 0;
				end = live;
			}
			buf.set(chunk, end);
			end += chunk.length;
		},
		view: () => buf.subarray(start, end),
		consume(n) {
			start = Math.min(end, start + n);
			if (start === end) start = end = 0;
		},
		get length() {
			return end - start;
		},
	};
};

/** A stream that emits `bytes` once (an empty array emits nothing). */
export const streamOf = (
	...parts: readonly Uint8Array[]
): ReadableStream<Uint8Array> =>
	new ReadableStream<Uint8Array>({
		start(controller) {
			for (const part of parts) {
				if (part.length > 0) controller.enqueue(part);
			}
			controller.close();
		},
	});

/**
 * Reads a whole stream, failing once more than `maxBytes` arrived (the reader
 * is cancelled at that point, so an oversized body is never fully buffered).
 */
export const readCapped = async (
	stream: ReadableStream<Uint8Array>,
	maxBytes: number,
): Promise<
	{ readonly ok: true; readonly bytes: Uint8Array } | {
		readonly ok: false;
	}
> => {
	const reader = stream.getReader();
	const parts: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > maxBytes) {
				await reader.cancel("over the byte cap").catch(() => {});
				return { ok: false };
			}
			parts.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return { ok: true, bytes: concat(parts) };
};
