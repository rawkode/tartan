// The K2 record codec (WP26). A record's content is the UTF-8 JSON of the
// contract `Envelope`, byte for byte what `events.read` and `/-/live`
// deliver, except that `x.<extId>.*` payloads are relayed redacted
// (`{redacted, bytes, sha256}`, flag `redacted`). Headers use the CloudEvents
// 1.0 Kafka-binding names (`ce_` prefix): at most 20 of K2's 32, each value at
// most 8 KiB, empty ones omitted. The dedupe key is `ce_id` (the event ULID);
// per-stream order is Tartan's own `(ce_tartanstream, ce_tartanepoch,
// ce_tartanseq)`, since K2 records carry no offsets.

import { createHash } from "node:crypto";
import type { Envelope } from "@tartan/contract";
import { K2_RELAY_BATCH } from "./config.ts";
import type { EventLogRow, RunDispatchVia } from "./contract.ts";
import type { K2Record } from "./k2.ts";

export const ENVELOPE_CONTENT_TYPE = "application/vnd.tartan.envelope+json;v=1";
export const ELIDED_CONTENT_TYPE = "application/vnd.tartan.elided+json;v=1";
/** `ce_type` of an elision record (never an event type). */
export const ELIDED_TYPE = "tartan.log.elided";

export const HEADERS = {
	contentType: "content-type",
	specversion: "ce_specversion",
	id: "ce_id",
	type: "ce_type",
	source: "ce_source",
	time: "ce_time",
	subject: "ce_subject",
	stream: "ce_tartanstream",
	epoch: "ce_tartanepoch",
	seq: "ce_tartanseq",
	hash: "ce_tartanhash",
	prev: "ce_tartanprev",
	idem: "ce_tartanidem",
	repo: "ce_tartanrepo",
	node: "ce_tartannode",
	workload: "ce_tartanworkload",
	via: "ce_tartanvia",
	flags: "ce_tartanflags",
	from: "ce_tartanfrom",
	to: "ce_tartanto",
} as const;

/** K2's per-record limits that the codec keeps well inside. */
export const K2_HEADER_LIMITS = {
	count: 32,
	nameBytes: 256,
	valueBytes: 8 * 1024,
	totalBytes: 64 * 1024,
} as const;

export type RecordFlag = "sim" | "shadow" | "redacted" | "elided";

/** Where a record comes from: the forge stage and the DO's stream and epoch. */
export type RecordSource = {
	readonly stage: string;
	/** `repo:<ulid>` or `forge`. */
	readonly stream: string;
	readonly epoch: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const byteLength = (text: string): number => encoder.encode(text).length;

const sha256Hex = (bytes: Uint8Array): string =>
	createHash("sha256").update(bytes).digest("hex");

/** `x.<extId>.*`: extension-private events, relayed redacted. */
export const isRedactedType = (type: string): boolean => type.startsWith("x.");

/** The redacted stand-in for an extension-private payload. */
export const redactData = (
	data: unknown,
): { redacted: true; bytes: number; sha256: string } => {
	const bytes = encoder.encode(JSON.stringify(data ?? null));
	return { redacted: true, bytes: bytes.length, sha256: sha256Hex(bytes) };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

/** `k2` on a queued `run.started` whose data asks for the log's dispatch. */
export const workloadOf = (envelope: Envelope): "k2" | null => {
	if (envelope.type !== "run.started" || !isRecord(envelope.data)) return null;
	return envelope.data.state === "queued" && envelope.data.transport === "k2"
		? "k2"
		: null;
};

const VIAS: ReadonlySet<string> = new Set(["k2", "backstop", "local"]);

/** `via` of a `run.dispatched`. */
export const viaOf = (envelope: Envelope): RunDispatchVia | null => {
	if (envelope.type !== "run.dispatched" || !isRecord(envelope.data)) {
		return null;
	}
	const via = envelope.data.via;
	return typeof via === "string" && VIAS.has(via)
		? via as RunDispatchVia
		: null;
};

const compact = (
	entries: readonly (readonly [string, string | null | undefined])[],
): Record<string, string> => {
	const out: Record<string, string> = {};
	for (const [name, value] of entries) {
		if (value === null || value === undefined || value === "") continue;
		if (byteLength(value) > K2_HEADER_LIMITS.valueBytes) continue;
		out[name] = value;
	}
	return out;
};

export type EncodedRecord = K2Record & {
	readonly headers: Readonly<Record<string, string>>;
	/** Content plus header bytes (the batch cut's measure). */
	readonly size: number;
	/** The record asks the `workloads` consumer to dispatch a run. */
	readonly workload: boolean;
};

const sizeOf = (
	content: Uint8Array,
	headers: Readonly<Record<string, string>>,
): number =>
	content.length +
	Object.entries(headers).reduce(
		(n, [k, v]) => n + byteLength(k) + byteLength(v),
		0,
	);

/** One committed event → one K2 record. */
export const toLogRecord = (
	row: EventLogRow,
	source: RecordSource,
): EncodedRecord => {
	const envelope = row.envelope;
	const redacted = isRedactedType(envelope.type);
	const body: Envelope = redacted
		? { ...envelope, data: redactData(envelope.data) }
		: envelope;
	const content = encoder.encode(JSON.stringify(body));
	const flags: RecordFlag[] = [
		...(envelope.sim ? ["sim" as const] : []),
		...(envelope.shadow ? ["shadow" as const] : []),
		...(redacted ? ["redacted" as const] : []),
	];
	const workload = workloadOf(envelope);
	const headers = compact([
		[HEADERS.contentType, ENVELOPE_CONTENT_TYPE],
		[HEADERS.specversion, "1.0"],
		[HEADERS.id, envelope.id],
		[HEADERS.type, envelope.type],
		[HEADERS.source, `tartan:${source.stage}/${source.stream}`],
		[HEADERS.time, new Date(envelope.at).toISOString()],
		[
			HEADERS.subject,
			envelope.subject
				? `${envelope.subject.kind}:${envelope.subject.id}`
				: null,
		],
		[HEADERS.stream, source.stream],
		[HEADERS.epoch, source.epoch],
		[HEADERS.seq, String(row.seq)],
		[HEADERS.hash, row.hash],
		[HEADERS.prev, row.prevHash],
		[HEADERS.idem, row.idemKey],
		[HEADERS.repo, row.repo],
		[HEADERS.node, envelope.node],
		[HEADERS.workload, workload],
		[HEADERS.via, viaOf(envelope)],
		[HEADERS.flags, flags.join(",")],
	]);
	return {
		content,
		headers,
		size: sizeOf(content, headers),
		workload: workload !== null,
	};
};

/**
 * The one record sent when the relay must skip `[from, to]` (a stream change
 * whose oldest retained seq is above the cursor): never a silent gap.
 */
export const elisionRecord = (
	range: {
		readonly from: number;
		readonly to: number;
		/** Chain position at `to` (the oldest retained row's `prev_hash`). */
		readonly hashAtTo?: string | null;
		readonly at: number;
	},
	source: RecordSource,
): EncodedRecord => {
	const content = encoder.encode(
		JSON.stringify({ elided: { from: range.from, to: range.to } }),
	);
	const headers = compact([
		[HEADERS.contentType, ELIDED_CONTENT_TYPE],
		[HEADERS.specversion, "1.0"],
		[
			HEADERS.id,
			`elided-${source.epoch}-${range.from}-${range.to}`.toLowerCase(),
		],
		[HEADERS.type, ELIDED_TYPE],
		[HEADERS.source, `tartan:${source.stage}/${source.stream}`],
		[HEADERS.time, new Date(range.at).toISOString()],
		[HEADERS.stream, source.stream],
		[HEADERS.epoch, source.epoch],
		[HEADERS.seq, String(range.to)],
		[HEADERS.hash, range.hashAtTo ?? null],
		[HEADERS.flags, "elided"],
		[HEADERS.from, String(range.from)],
		[HEADERS.to, String(range.to)],
	]);
	return { content, headers, size: sizeOf(content, headers), workload: false };
};

/** The longest prefix within K2_RELAY_BATCH (always at least one record). */
export const cutBatch = <T extends { readonly size: number }>(
	records: readonly T[],
	limits: { readonly records: number; readonly bytes: number } = K2_RELAY_BATCH,
): T[] => {
	const out: T[] = [];
	let bytes = 0;
	for (const record of records) {
		if (out.length >= limits.records) break;
		if (out.length > 0 && bytes + record.size > limits.bytes) break;
		out.push(record);
		bytes += record.size;
	}
	return out;
};

// ---------------------------------------------------------------------------
// Consuming
// ---------------------------------------------------------------------------

/** A record as the consumer sees it: headers parsed, content decoded lazily. */
export type LogRecord = {
	readonly id: string;
	readonly type: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly content: Uint8Array;
	readonly timestampMs: number;
	readonly flags: readonly string[];
	/** The envelope (null for an elision record or unparseable content). */
	envelope(): Envelope | null;
};

export type ParsedLogRecord =
	| { readonly ok: true; readonly record: LogRecord }
	| { readonly ok: false; readonly error: string; readonly id: string };

const fallbackId = (content: Uint8Array): string =>
	`malformed-${sha256Hex(content).slice(0, 32)}`;

/** A consumed record → a `LogRecord`; a malformed one names why. */
export const parseLogRecord = (
	input: {
		readonly content: Uint8Array;
		readonly headers?: Readonly<Record<string, string>>;
		readonly timestampMs: number;
	},
): ParsedLogRecord => {
	const headers = input.headers ?? {};
	const id = headers[HEADERS.id];
	const type = headers[HEADERS.type];
	if (typeof id !== "string" || id === "" || id.length > 128) {
		return { ok: false, error: "no ce_id", id: fallbackId(input.content) };
	}
	if (typeof type !== "string" || type === "") {
		return { ok: false, error: "no ce_type", id };
	}
	let parsed: Envelope | null | undefined;
	const record: LogRecord = {
		id,
		type,
		headers,
		content: input.content,
		timestampMs: input.timestampMs,
		flags: (headers[HEADERS.flags] ?? "").split(",").filter(Boolean),
		envelope: () => {
			if (parsed !== undefined) return parsed;
			if (headers[HEADERS.contentType] !== ENVELOPE_CONTENT_TYPE) {
				parsed = null;
				return parsed;
			}
			try {
				const value = JSON.parse(decoder.decode(input.content));
				parsed = isRecord(value) && value.id === id
					? value as unknown as Envelope
					: null;
			} catch {
				parsed = null;
			}
			return parsed;
		},
	};
	return { ok: true, record };
};

/** RFC 3339 `ce_time` → epoch ms, or null. */
export const timeOf = (record: LogRecord): number | null => {
	const text = record.headers[HEADERS.time];
	if (text === undefined) return null;
	const ms = Date.parse(text);
	return Number.isFinite(ms) ? ms : null;
};
