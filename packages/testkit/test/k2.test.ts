// FakeK2 (WP26): the producer binding and the data plane, as the K2 docs
// describe them.

import { deepEqual, equal, ok } from "node:assert/strict";
import { createFakeK2 } from "../src/k2/fake.ts";

const json = (body: unknown) => ({
	method: "POST",
	headers: {
		"content-type": "application/json",
		authorization: `Bearer ${"fake-k2-consume-token"}`,
	},
	body: JSON.stringify(body),
});

const call = async (
	k2: ReturnType<typeof createFakeK2>,
	path: string,
	init: RequestInit = {
		headers: { authorization: "Bearer fake-k2-consume-token" },
	},
) => {
	const res = await k2.fetch(`${k2.endpoint}${path}`, init);
	// deno-lint-ignore no-explicit-any
	return { status: res.status, body: await res.json() as any };
};

const bytes = (text: string) => new TextEncoder().encode(text);

Deno.test("FakeK2: send stores records; failures answer, never throw; 10212 may store", async () => {
	const k2 = createFakeK2();
	deepEqual(
		await k2.producer.send([{ content: bytes("a"), headers: { ce_id: "1" } }]),
		{ success: true },
	);
	k2.sendFault({ kind: "error", code: 10212, stored: true });
	const r = await k2.producer.send([{ content: bytes("b") }]);
	equal(r.success, false);
	if (!r.success) equal(r.error.code, 10212);
	k2.sendFault({ kind: "error", code: 10211, retryable: true });
	await k2.producer.send([{ content: bytes("c") }]);
	equal(k2.records().length, 2);
	k2.sendFault({ kind: "duplicate" });
	await k2.producer.send([{ content: bytes("d") }]);
	equal(k2.records().length, 4);
	k2.sendFault({ kind: "throw" });
	let threw = false;
	try {
		await k2.producer.send([{ content: bytes("e") }]);
	} catch {
		threw = true;
	}
	ok(threw);
	const invalid = await k2.producer.send([{
		content: bytes("x"),
		headers: Object.fromEntries(
			Array.from({ length: 33 }, (_, i) => [`h${i}`, "v"]),
		),
	}]);
	equal(invalid.success, false);
});

Deno.test("FakeK2: auth and content type are checked on the data plane", async () => {
	const k2 = createFakeK2();
	equal((await call(k2, "/subscriptions", {})).body.errors[0].code, 10208);
	equal(
		(await call(k2, "/subscriptions", {
			headers: { authorization: "Bearer nope" },
		})).body.errors[0].code,
		10209,
	);
	const noType = await call(k2, "/subscriptions", {
		method: "POST",
		headers: { authorization: "Bearer fake-k2-consume-token" },
		body: "{}",
	});
	equal(noType.status, 415);
	equal(noType.body.errors[0].code, 10205);
});

Deno.test("FakeK2: latest vs earliest, same-worker re-consume, ack idempotent, nack and expiry redeliver", async () => {
	const k2 = createFakeK2();
	await k2.producer.send([{ content: bytes("old") }]);
	const latest = (await call(
		k2,
		"/subscriptions",
		json({
			name: "w-latest",
			start_at: { type: "latest" },
		}),
	)).body.result.id;
	const earliest = (await call(
		k2,
		"/subscriptions",
		json({
			name: "w-earliest",
			start_at: { type: "earliest" },
		}),
	)).body.result.id;
	// Same name, same settings: idempotent; other settings: 10201.
	equal(
		(await call(
			k2,
			"/subscriptions",
			json({
				name: "w-latest",
				start_at: { type: "latest" },
			}),
		)).body.result.id,
		latest,
	);
	equal(
		(await call(
			k2,
			"/subscriptions",
			json({
				name: "w-latest",
				start_at: { type: "earliest" },
			}),
		)).body.errors[0].code,
		10201,
	);
	await k2.producer.send([{ content: bytes("n1") }, { content: bytes("n2") }]);
	const consume = (sub: string, worker: string, max = 10) =>
		call(
			k2,
			`/subscriptions/${sub}/consume`,
			json({
				worker_id: worker,
				max_records: max,
			}),
		);
	const e = (await consume(earliest, "a")).body.result;
	equal(e.records.length, 3);
	const l1 = (await consume(latest, "a", 1)).body.result;
	equal(l1.records.length, 1);
	equal(atob(l1.records[0].content), "n1");
	// Same worker while holding the lease: the same batch.
	const again = (await consume(latest, "a", 5)).body.result;
	equal(again.batch_id, l1.batch_id);
	// Another worker gets the rest; a nack redelivers to the next consumer.
	const l2 = (await consume(latest, "b")).body.result;
	equal(atob(l2.records[0].content), "n2");
	await call(
		k2,
		`/subscriptions/${latest}/batches/${l2.batch_id}/nack`,
		json({ worker_id: "b" }),
	);
	const l3 = (await consume(latest, "c")).body.result;
	equal(atob(l3.records[0].content), "n2");
	ok(l3.batch_id !== l2.batch_id);
	// Ack twice: both succeed.
	for (let i = 0; i < 2; i++) {
		equal(
			(await call(
				k2,
				`/subscriptions/${latest}/batches/${l1.batch_id}/ack`,
				json({ worker_id: "a" }),
			)).status,
			200,
		);
	}
	// Extend by a non-holder: 10218.
	equal(
		(await call(
			k2,
			`/subscriptions/${latest}/batches/${l3.batch_id}/extend`,
			json({ worker_id: "a" }),
		)).body.errors[0].code,
		10218,
	);
	// Expiry: the records come back.
	k2.expireLeases();
	const l4 = (await consume(latest, "d")).body.result;
	equal(atob(l4.records[0].content), "n2");
	const empty = (await consume(latest, "e")).body.result;
	deepEqual(empty, { batch_id: null, leased_until_ms: null, records: [] });
	// Unknown subscription: 10215.
	equal((await consume("nope", "a")).body.errors[0].code, 10215);
});

Deno.test("FakeK2: one producer's sequential sends keep their order", async () => {
	const k2 = createFakeK2();
	for (let i = 0; i < 10; i++) {
		await k2.producer.send(
			Array.from({ length: 10 }, (_, j) => ({
				content: bytes(String(i * 10 + j)),
			})),
		);
	}
	const id = (await call(
		k2,
		"/subscriptions",
		json({
			name: "order",
			start_at: { type: "earliest" },
		}),
	)).body.result.id;
	const got = (await call(
		k2,
		`/subscriptions/${id}/consume`,
		json({
			worker_id: "w",
			max_records: 1000,
		}),
	)).body.result.records.map((r: { content: string }) =>
		Number(atob(r.content))
	);
	deepEqual(got, Array.from({ length: 100 }, (_, i) => i));
	k2.reorderBatches(1);
	await k2.producer.send([{ content: bytes("x") }, { content: bytes("y") }]);
	await call(
		k2,
		`/subscriptions/${id}/batches/x/ack`,
		json({ worker_id: "w" }),
	);
	k2.expireLeases();
});
