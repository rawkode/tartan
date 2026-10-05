import { deepEqual, equal, ok } from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Envelope } from "@tartan/contract";
import {
	cutBatch,
	ELIDED_TYPE,
	elisionRecord,
	ENVELOPE_CONTENT_TYPE,
	HEADERS,
	K2_HEADER_LIMITS,
	parseLogRecord,
	timeOf,
	toLogRecord,
} from "./codec.ts";
import type { EventLogRow } from "./contract.ts";

const REPO = "01k6aaaaaaaaaaaaaaaaaaaaaa";
const NODE = "01k6bbbbbbbbbbbbbbbbbbbbbb";
const SOURCE = {
	stage: "dev-wp26",
	stream: `repo:${REPO}`,
	epoch: "01k6eeeeeeeeeeeeeeeeeeeeee",
};

const envelope = (over: Partial<Envelope> = {}): Envelope => ({
	id: "01k6cccccccccccccccccccccc",
	seq: 7,
	stream: `repo:${REPO}`,
	type: "push.accepted",
	v: 1,
	source: { kind: "kernel" },
	actor: { kind: "user", id: "u_01k6aaaaaaaaaaaaaaaaaaaaac" },
	node: REPO,
	repo: REPO,
	depth: 0,
	shadow: false,
	at: Date.UTC(2026, 9, 5, 12, 0, 0),
	hash: "a".repeat(64),
	data: { ref: "refs/heads/main" },
	...over,
});

const row = (env: Envelope, over: Partial<EventLogRow> = {}): EventLogRow => ({
	seq: env.seq,
	idemKey: "kernel:x:push.accepted:0",
	prevHash: "b".repeat(64),
	hash: env.hash ?? null,
	repo: env.repo ?? null,
	envelope: env,
	...over,
});

const decode = (bytes: Uint8Array) =>
	JSON.parse(new TextDecoder().decode(bytes));

Deno.test("an envelope round-trips byte for byte, with the CloudEvents headers", () => {
	const env = envelope({ subject: { kind: "change", id: "c1" } });
	const record = toLogRecord(row(env), SOURCE);
	deepEqual(decode(record.content), env);
	deepEqual(record.headers, {
		[HEADERS.contentType]: ENVELOPE_CONTENT_TYPE,
		[HEADERS.specversion]: "1.0",
		[HEADERS.id]: env.id,
		[HEADERS.type]: "push.accepted",
		[HEADERS.source]: `tartan:dev-wp26/repo:${REPO}`,
		[HEADERS.time]: "2026-10-05T12:00:00.000Z",
		[HEADERS.subject]: "change:c1",
		[HEADERS.stream]: `repo:${REPO}`,
		[HEADERS.epoch]: SOURCE.epoch,
		[HEADERS.seq]: "7",
		[HEADERS.hash]: "a".repeat(64),
		[HEADERS.prev]: "b".repeat(64),
		[HEADERS.idem]: "kernel:x:push.accepted:0",
		[HEADERS.repo]: REPO,
		[HEADERS.node]: REPO,
	});
	equal(record.workload, false);
	const parsed = parseLogRecord({
		content: record.content,
		headers: record.headers,
		timestampMs: 5,
	});
	ok(parsed.ok);
	if (!parsed.ok) return;
	equal(parsed.record.id, env.id);
	equal(parsed.record.type, "push.accepted");
	deepEqual(parsed.record.envelope(), env);
	equal(timeOf(parsed.record), env.at);
});

Deno.test("at most 20 headers, each within K2's limits; empty ones omitted", () => {
	const all = Object.values(HEADERS);
	ok(all.length <= 20 && all.length < K2_HEADER_LIMITS.count);
	const record = toLogRecord(
		row(envelope({ subject: undefined }), { prevHash: null, hash: null }),
		SOURCE,
	);
	equal(record.headers[HEADERS.subject], undefined);
	equal(record.headers[HEADERS.hash], undefined);
	equal(record.headers[HEADERS.flags], undefined);
	for (const [name, value] of Object.entries(record.headers)) {
		ok(new TextEncoder().encode(name).length <= K2_HEADER_LIMITS.nameBytes);
		ok(value !== "");
		ok(new TextEncoder().encode(value).length <= K2_HEADER_LIMITS.valueBytes);
	}
});

Deno.test("ce_tartanrepo only for a non-null repo column; ce_tartanidem always", () => {
	const env = envelope({ type: "repo.created", stream: "forge", repo: REPO });
	const withRepo = toLogRecord(row(env), { ...SOURCE, stream: "forge" });
	equal(withRepo.headers[HEADERS.repo], REPO);
	const nodeLevel = toLogRecord(row(env, { repo: null }), SOURCE);
	equal(nodeLevel.headers[HEADERS.repo], undefined);
	equal(nodeLevel.headers[HEADERS.idem], "kernel:x:push.accepted:0");
	equal(nodeLevel.headers[HEADERS.node], REPO);
	const other = toLogRecord(
		row(envelope({ node: NODE })),
		SOURCE,
	);
	equal(other.headers[HEADERS.node], NODE);
});

Deno.test("ce_tartanworkload=k2 only on a queued run.started whose data asks for k2", () => {
	const started = (data: Record<string, unknown>) =>
		toLogRecord(
			row(envelope({ type: "run.started", data: { runId: "r", ...data } })),
			SOURCE,
		);
	const k2 = started({ state: "queued", transport: "k2" });
	equal(k2.headers[HEADERS.workload], "k2");
	equal(k2.workload, true);
	equal(started({ state: "queued", transport: "local" }).workload, false);
	equal(started({ state: "running", transport: "k2" }).workload, false);
	equal(started({ state: "queued" }).headers[HEADERS.workload], undefined);
	const completed = toLogRecord(
		row(
			envelope({
				type: "run.completed",
				data: { runId: "r", state: "queued", transport: "k2" },
			}),
		),
		SOURCE,
	);
	equal(completed.workload, false);
});

Deno.test("ce_tartanvia on run.dispatched", () => {
	const record = toLogRecord(
		row(
			envelope({
				type: "run.dispatched",
				data: { runId: "r", state: "queued", via: "backstop", lagMs: 20000 },
			}),
		),
		SOURCE,
	);
	equal(record.headers[HEADERS.via], "backstop");
	const bogus = toLogRecord(
		row(envelope({ type: "run.dispatched", data: { via: "carrier-pigeon" } })),
		SOURCE,
	);
	equal(bogus.headers[HEADERS.via], undefined);
});

Deno.test("x.<extId>.* data is redacted to {redacted, bytes, sha256}; sim and shadow are flagged", () => {
	const data = { secretPlan: "launch at dawn", n: 3 };
	const env = envelope({
		type: "x.acme.lint.private",
		source: {
			kind: "installation",
			id: "i_01k6aaaaaaaaaaaaaaaaaaaaab",
			ext: "acme.lint@1",
		},
		data,
		shadow: true,
		sim: true,
	});
	const record = toLogRecord(row(env), SOURCE);
	const body = decode(record.content);
	const json = JSON.stringify(data);
	deepEqual(body.data, {
		redacted: true,
		bytes: new TextEncoder().encode(json).length,
		sha256: createHash("sha256").update(json).digest("hex"),
	});
	ok(!new TextDecoder().decode(record.content).includes("dawn"));
	deepEqual({ ...body, data: env.data }, env);
	equal(record.headers[HEADERS.flags], "sim,shadow,redacted");
});

Deno.test("an elision record announces a skipped range (never a silent gap)", () => {
	const record = elisionRecord(
		{ from: 1, to: 4999, hashAtTo: "c".repeat(64), at: Date.UTC(2026, 9, 5) },
		SOURCE,
	);
	equal(record.headers[HEADERS.type], ELIDED_TYPE);
	equal(record.headers[HEADERS.flags], "elided");
	equal(record.headers[HEADERS.from], "1");
	equal(record.headers[HEADERS.to], "4999");
	equal(record.headers[HEADERS.seq], "4999");
	equal(record.headers[HEADERS.hash], "c".repeat(64));
	equal(record.headers[HEADERS.stream], `repo:${REPO}`);
	equal(record.headers[HEADERS.epoch], SOURCE.epoch);
	equal(record.headers[HEADERS.id], `elided-${SOURCE.epoch}-1-4999`);
	deepEqual(decode(record.content), { elided: { from: 1, to: 4999 } });
	equal(record.workload, false);
	const parsed = parseLogRecord({ ...record, timestampMs: 1 });
	ok(parsed.ok && parsed.record.envelope() === null);
	ok(parsed.ok && parsed.record.flags.includes("elided"));
});

Deno.test("batches cut at 500 records and 4,000,000 bytes, never empty", () => {
	const small = Array.from({ length: 600 }, () => ({ size: 10 }));
	equal(cutBatch(small).length, 500);
	const big = Array.from({ length: 5 }, () => ({ size: 1_500_000 }));
	equal(cutBatch(big).length, 2);
	equal(cutBatch([{ size: 9_000_000 }]).length, 1);
	equal(cutBatch([]).length, 0);
});

Deno.test("a malformed consumed record names why", () => {
	const bytes = new TextEncoder().encode("{}");
	const noId = parseLogRecord({ content: bytes, headers: {}, timestampMs: 1 });
	ok(!noId.ok);
	if (!noId.ok) {
		equal(noId.error, "no ce_id");
		ok(noId.id.startsWith("malformed-"));
	}
	const noType = parseLogRecord({
		content: bytes,
		headers: { [HEADERS.id]: "x" },
		timestampMs: 1,
	});
	ok(!noType.ok && noType.error === "no ce_type");
	const badJson = parseLogRecord({
		content: new TextEncoder().encode("not json"),
		headers: {
			[HEADERS.id]: "x",
			[HEADERS.type]: "run.started",
			[HEADERS.contentType]: ENVELOPE_CONTENT_TYPE,
		},
		timestampMs: 1,
	});
	ok(badJson.ok && badJson.record.envelope() === null);
	// Content whose id differs from ce_id is not trusted.
	const mismatch = parseLogRecord({
		content: new TextEncoder().encode(JSON.stringify(envelope())),
		headers: {
			[HEADERS.id]: "01k6dddddddddddddddddddddd",
			[HEADERS.type]: "push.accepted",
			[HEADERS.contentType]: ENVELOPE_CONTENT_TYPE,
		},
		timestampMs: 1,
	});
	ok(mismatch.ok && mismatch.record.envelope() === null);
});
