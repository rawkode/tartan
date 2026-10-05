// Stream helpers of the gateway (WP4): bodies are streamed, never buffered
// whole (`arrayBuffer()` on a push body would hold up to `MAX_PUSH_BYTES` in
// isolate memory; the edge already buffers it [E A3]). Only small things are
// read into memory: ref advertisements, upload-pack requests of the public
// view, and the first packet of a receive-pack command section.

import { ARTIFACTS_UPSTREAM_SIZE_ERRORS, tartanError } from "@tartan/contract";
import type { ReportStatus } from "@tartan/gitproto";

/** The counting stream's error when a push body passes `MAX_PUSH_BYTES` without a `Content-Length`. */
export const PUSH_TOO_LARGE = "push-too-large";

export type ByteCounter = {
	readonly stream: TransformStream<Uint8Array, Uint8Array>;
	/** Bytes that went through so far. */
	bytes(): number;
	/** True once the limit was passed (the stream errored). */
	exceeded(): boolean;
};

/**
 * Counts the bytes of a body; past `limit` (when given) it errors the stream,
 * which aborts the upstream request.
 */
export const createByteCounter = (limit?: number): ByteCounter => {
	let total = 0;
	let over = false;
	return {
		stream: new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				total += chunk.byteLength;
				if (limit !== undefined && total > limit) {
					over = true;
					controller.error(
						tartanError("invalid", PUSH_TOO_LARGE, { reason: PUSH_TOO_LARGE }),
					);
					return;
				}
				controller.enqueue(chunk);
			},
		}),
		bytes: () => total,
		exceeded: () => over,
	};
};

/**
 * Reads and discards a request body (the edge has already received it), so
 * the client's upload completes before the answer; past `maxBytes` the rest
 * is cancelled instead. Never throws.
 */
export const drain = async (
	body: ReadableStream<Uint8Array> | null,
	maxBytes: number,
): Promise<number> => {
	if (body === null) return 0;
	let total = 0;
	try {
		const reader = body.getReader();
		for (;;) {
			const { value, done } = await reader.read();
			if (done) return total;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel("drain limit").catch(() => {});
				return total;
			}
		}
	} catch {
		return total;
	}
};

/**
 * Reads a whole stream up to `maxBytes`; null past the cap (the reader is
 * cancelled). For advertisements and upload-pack requests only.
 */
export const readCapped = async (
	body: ReadableStream<Uint8Array> | null,
	maxBytes: number,
): Promise<Uint8Array | null> => {
	if (body === null) return new Uint8Array(0);
	const reader = body.getReader();
	const parts: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel("too large").catch(() => {});
			return null;
		}
		parts.push(value);
	}
	const out = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.byteLength;
	}
	return out;
};

/**
 * Splits off the first non-empty chunk of a stream: `first` is null when the
 * stream ended without data (an upstream hang-up), and `rest` replays the
 * chunk followed by the remainder.
 */
export const peekFirstChunk = async (
	body: ReadableStream<Uint8Array>,
): Promise<{
	readonly first: Uint8Array | null;
	readonly rest: ReadableStream<Uint8Array>;
}> => {
	const reader = body.getReader();
	let first: Uint8Array | null = null;
	let ended = false;
	while (first === null) {
		const { value, done } = await reader.read();
		if (done) {
			ended = true;
			break;
		}
		if (value.byteLength > 0) first = value;
	}
	let sent = first === null;
	const rest = new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (!sent) {
				sent = true;
				controller.enqueue(first as Uint8Array);
				return;
			}
			if (ended) {
				controller.close();
				return;
			}
			const { value, done } = await reader.read();
			if (done) controller.close();
			else controller.enqueue(value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
	return { first, rest };
};

export type HeadCapture = {
	readonly stream: TransformStream<Uint8Array, Uint8Array>;
	/** The first bytes seen (at most the capture size). */
	head(): Uint8Array;
};

/** Passes bytes through and keeps a copy of the first `maxBytes`. */
export const captureHead = (maxBytes: number): HeadCapture => {
	const buffer = new Uint8Array(maxBytes);
	let length = 0;
	return {
		stream: new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				if (length < maxBytes) {
					const take = Math.min(chunk.byteLength, maxBytes - length);
					buffer.set(chunk.subarray(0, take), length);
					length += take;
				}
				controller.enqueue(chunk);
			},
		}),
		head: () => buffer.slice(0, length),
	};
};

/** Reads a stream to its end, discarding it (the report sniffer's branch). Never throws. */
export const consume = async (
	body: ReadableStream<Uint8Array>,
): Promise<void> => {
	try {
		const reader = body.getReader();
		for (;;) {
			const { done } = await reader.read();
			if (done) return;
		}
	} catch {
		// The upstream body failed; whatever was parsed stays the answer.
	}
};

// ---------------------------------------------------------------------------
// Upstream size errors ([E A3])
// ---------------------------------------------------------------------------

/** Whether an upstream message is one of Artifacts' "object too large" forms. */
export const isUpstreamSizeError = (text: string): boolean => {
	const lower = text.toLowerCase();
	return ARTIFACTS_UPSTREAM_SIZE_ERRORS.some((needle) =>
		lower.includes(needle)
	);
};

/**
 * The relay's `rewriteReport`: an upstream report naming an object-size
 * error becomes `ng <ref> object-too-large` for every ref (unpack failed);
 * any other report is relayed unchanged (null).
 */
export const translateSizeErrors = (
	report: ReportStatus,
): ReportStatus | null => {
	const sized = isUpstreamSizeError(report.unpack) ||
		report.refs.some((ref) => !ref.ok && isUpstreamSizeError(ref.reason));
	if (!sized) return null;
	return {
		unpack: "object-too-large",
		refs: report.refs.map((ref) => ({
			ref: ref.ref,
			ok: false,
			reason: "object-too-large",
		})),
	};
};
