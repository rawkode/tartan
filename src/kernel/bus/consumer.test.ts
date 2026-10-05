// The BusDO consumer (WP26; PLAN acceptance "Consumer" and "Workloads
// handler"), over node:sqlite against FakeK2's data plane.

import { deepEqual, equal, ok } from "node:assert/strict";
import type { Envelope } from "@tartan/contract";
import { createFakeK2, type FakeK2 } from "@tartan/testkit/k2/fake.ts";
import { createK2Client, K2Error } from "./client.ts";
import { HEADERS, type LogRecord, toLogRecord } from "./codec.ts";
import { K2_MAX_CRASH_ATTEMPTS, K2_POLL_BACKOFF_MS } from "./config.ts";
import { conformanceHeaders } from "./conformance.ts";
import type { BusFacade, BusStatus, DispatchOutcome } from "./contract.ts";
import {
	type ConsumerPorts,
	createBusConsumerModule,
	POLL_TIMER,
} from "./consumer.ts";
import { createTestDo, type TestClock, testClock } from "./testing/do.ts";
import { eventId, REPO, STAGE, testEnvelope } from "./testing/fixtures.ts";
import {
	createWorkloadsHandler,
	type GroupHandler,
	hourOf,
} from "./workloads.ts";

const RUN = (n: number) => eventId(10_000 + n);
const EPOCH = "01k6eeeeeeeeeeeeeeeeeeeeee";

/** Produces envelopes to FakeK2 as the relay would. */
const produce = async (k2: FakeK2, envelopes: Envelope[]) => {
	const records = envelopes.map((envelope) =>
		toLogRecord({
			seq: envelope.seq,
			idemKey: `k${envelope.seq}`,
			prevHash: null,
			hash: envelope.hash ?? null,
			repo: REPO,
			envelope,
		}, { stage: STAGE, stream: `repo:${REPO}`, epoch: EPOCH })
	);
	const result = await k2.producer.send(
		records.map(({ content, headers }) => ({ content, headers })),
	);
	ok(result.success);
};

let seq = 0;
const workload = (n: number, transport = "k2"): Envelope =>
	testEnvelope(++seq, {
		type: "run.started",
		data: { runId: RUN(n), state: "queued", transport, kind: "ci" },
	});
const dispatchedEvent = (n: number, via: string, at = 0): Envelope =>
	testEnvelope(++seq, {
		type: "run.dispatched",
		at,
		data: { runId: RUN(n), state: "queued", via, lagMs: 5 },
	});
const noise = (): Envelope => testEnvelope(++seq);

type Harness = {
	k2: FakeK2;
	clock: TestClock;
	d: ReturnType<typeof createTestDo>;
	bus: BusFacade;
	dispatched: string[];
	logs: string[];
	/** One alarm: runs every due timer (poll, retry). */
	tick: () => Promise<void>;
	/** Moves the clock to the earliest pending timer, then runs the alarm. */
	next: () => Promise<void>;
	status: () => Promise<BusStatus>;
};

const harness = (
	options: {
		k2?: FakeK2;
		clock?: TestClock;
		dispatch?: (runId: string) => Promise<DispatchOutcome>;
		handler?: GroupHandler;
		client?: ConsumerPorts["client"];
		token?: string;
		handlerTimeoutMs?: number;
		name?: string;
	} = {},
): Harness => {
	const clock = options.clock ?? testClock();
	const k2 = options.k2 ?? createFakeK2({ now: clock.now });
	const dispatched: string[] = [];
	const logs: string[] = [];
	const d = createTestDo({
		name: options.name ?? "bus:workloads:0",
		env: { TARTAN_STAGE: STAGE },
		clock,
		modules: {
			bus: createBusConsumerModule({
				handlerTimeoutMs: options.handlerTimeoutMs,
				ports: ({ countViaSync }) => ({
					client: options.client === undefined
						? createK2Client({
							endpoint: k2.endpoint,
							token: () => Promise.resolve(options.token ?? k2.token),
							fetch: k2.fetch,
						})
						: options.client,
					handlers: {
						workloads: options.handler ?? createWorkloadsHandler({
							dispatch: (repo, runId, opts) => {
								equal(repo, REPO);
								equal(opts.via, "k2");
								dispatched.push(runId);
								return options.dispatch?.(runId) ??
									Promise.resolve("dispatched");
							},
							countViaSync,
						}),
					},
					log: (message, data) =>
						void logs.push(`${message} ${JSON.stringify(data)}`),
				}),
			}),
		},
	});
	const bus = d.facade<BusFacade>("bus");
	return {
		k2,
		clock,
		d,
		bus,
		dispatched,
		logs,
		tick: async () => {
			await d.runDue();
		},
		next: async () => {
			const at = Math.min(...d.timers().values());
			if (Number.isFinite(at) && at > clock.now()) clock.set(at);
			await d.runDue();
		},
		status: () => bus.status(),
	};
};

/** Subscribes the consumer (an empty first poll at `latest`). */
const subscribe = async (h: Harness) => {
	await h.bus.nudge();
	await h.tick();
	equal(h.k2.subscriptions().length, 1);
};

Deno.test("consumer: subscribes at latest; apply, then ack; the subscription advances", async () => {
	const h = harness();
	await produce(h.k2, [workload(1)]); // before the subscription: never seen
	await subscribe(h);
	const sub = h.k2.subscriptions()[0];
	ok(sub.name.startsWith("workloads-"));
	equal(sub.startAt, "latest");
	await produce(h.k2, [workload(2), noise(), workload(3, "local")]);
	await h.bus.nudge();
	await h.tick();
	deepEqual(h.dispatched, [RUN(2)]);
	equal(h.k2.calls.ack, 1);
	equal(h.k2.subscriptions()[0].committed, h.k2.records().length);
	const s = await h.status();
	equal(s.consume, "ok");
	equal(s.records, 3);
	equal(s.dead, 0);
	equal(s.retry, 0);
	equal(s.subscription, sub.name);
	ok(s.lastPollOkAt !== null);
	equal(s.lastError, null);
	// Polls again at once after a batch.
	ok(h.d.timers().get(`bus/${POLL_TIMER}`)! <= h.clock.now() + 1);
});

Deno.test("consumer: one batch per alarm invocation; an empty poll backs off", async () => {
	const h = harness();
	await subscribe(h);
	const before = h.k2.calls.consume;
	await produce(h.k2, Array.from({ length: 250 }, () => noise()));
	await h.bus.nudge();
	await h.tick();
	equal(h.k2.calls.consume - before, 1);
	equal((await h.status()).records, 100);
	await h.next();
	equal((await h.status()).records, 200);
	await h.next();
	equal((await h.status()).records, 250);
	equal(h.k2.calls.consume - before, 3);
	await h.next();
	const at = h.d.timers().get(`bus/${POLL_TIMER}`)!;
	equal(at, h.clock.now() + K2_POLL_BACKOFF_MS[0]);
	h.clock.set(at);
	await h.tick();
	equal(
		h.d.timers().get(`bus/${POLL_TIMER}`),
		h.clock.now() + K2_POLL_BACKOFF_MS[1],
	);
	// A nudge resets the backoff.
	await h.bus.nudge();
	equal(h.d.timers().get(`bus/${POLL_TIMER}`), h.clock.now());
});

Deno.test("consumer: seen dedupes redelivered and duplicated records", async () => {
	const h = harness();
	await subscribe(h);
	h.k2.sendFault({ kind: "duplicate" });
	await produce(h.k2, [workload(1), workload(2)]);
	await h.bus.nudge();
	await h.tick();
	deepEqual(h.dispatched, [RUN(1), RUN(2)]);
	equal((await h.status()).records, 4);
});

Deno.test("consumer: record k throws on every attempt, is parked after 3, and the subscription advances", async () => {
	let calls = 0;
	const h = harness({
		handler: (record: LogRecord) => {
			const data = record.envelope()?.data as { status?: string };
			if (data?.status === "s-bad") {
				calls += 1;
				throw new Error("handler bug");
			}
			return Promise.resolve({ outcome: "done" });
		},
	});
	await subscribe(h);
	await produce(h.k2, [
		noise(),
		testEnvelope(++seq, {
			data: { principal: "u_01k6aaaaaaaaaaaaaaaaaaaaac", status: "s-bad" },
		}),
		noise(),
	]);
	for (let i = 0; i < 6; i++) {
		await h.bus.nudge();
		await h.tick();
	}
	equal(calls, K2_MAX_CRASH_ATTEMPTS);
	const s = await h.status();
	equal(s.dead, 1);
	equal(s.records, 3);
	equal(h.k2.subscriptions()[0].committed, h.k2.records().length);
	const dead = await h.bus.deadList({});
	equal(dead.dead.length, 1);
	ok(dead.dead[0].error.startsWith("crashed"));
	equal(dead.dead[0].type, "presence.changed");
});

Deno.test("consumer: same-batch recovery after an eviction mid-batch", async () => {
	let hang = true;
	const h = harness({
		handler: (record: LogRecord) => {
			const data = record.envelope()?.data as { status?: string };
			if (data?.status === "s-hang" && hang) return new Promise(() => {});
			return Promise.resolve({ outcome: "done" });
		},
		handlerTimeoutMs: 60_000,
	});
	await subscribe(h);
	await produce(h.k2, [
		noise(),
		testEnvelope(++seq, {
			data: { principal: "u_01k6aaaaaaaaaaaaaaaaaaaaac", status: "s-hang" },
		}),
	]);
	await h.bus.nudge();
	// The alarm never finishes: the DO is evicted while the handler hangs.
	void h.d.runDue();
	await new Promise((r) => setTimeout(r, 10));
	h.d.restart();
	hang = false;
	const bus = h.d.facade<BusFacade>("bus");
	await bus.wake();
	await h.d.runDue();
	equal(h.k2.calls.ack, 1);
	equal(h.k2.subscriptions()[0].committed, h.k2.records().length);
	const s = await bus.status();
	equal(s.dead, 0);
	equal(s.records, 2);
});

Deno.test("consumer: a hanging handler times out to retry, and the retry timer completes it", async () => {
	let hang = true;
	const h = harness({
		handler: () =>
			hang ? new Promise(() => {}) : Promise.resolve({ outcome: "done" }),
		handlerTimeoutMs: 20,
	});
	await subscribe(h);
	await produce(h.k2, [noise()]);
	await h.bus.nudge();
	await h.tick();
	let s = await h.status();
	equal(s.retry, 1);
	equal(h.k2.calls.ack, 1);
	hang = false;
	h.clock.advance(1_000);
	await h.tick();
	s = await h.status();
	equal(s.retry, 0);
	equal(s.dead, 0);
});

Deno.test("consumer: retry rows give up after 8 attempts (dead)", async () => {
	const h = harness({
		handler: () => Promise.resolve({ outcome: "retry", error: "transient" }),
	});
	await subscribe(h);
	await produce(h.k2, [noise()]);
	await h.bus.nudge();
	await h.tick();
	for (let i = 0; i < 12; i++) {
		h.clock.advance(600_000);
		await h.tick();
	}
	const s = await h.status();
	equal(s.retry, 0);
	equal(s.dead, 1);
	ok((await h.bus.deadList({})).dead[0].error.startsWith("retry"));
});

Deno.test("consumer: extends a lease near its end; a lost lease (10218) is logged and the batch goes on", async () => {
	const clock = testClock();
	const k2 = createFakeK2({ now: clock.now, leaseMs: 61_000 });
	const h = harness({
		k2,
		clock,
		handler: () => {
			clock.advance(2_000);
			return Promise.resolve({ outcome: "done" });
		},
	});
	await subscribe(h);
	await produce(k2, [noise(), noise(), noise()]);
	await h.bus.nudge();
	await h.tick();
	ok(k2.calls.extend >= 1);
	await produce(k2, [noise(), noise(), noise()]);
	k2.dataFault("extend", { kind: "error", status: 409, code: 10218 }, 5);
	await h.bus.nudge();
	await h.next();
	ok(h.logs.some((l) => l.includes("k2 lease lost")));
	equal((await h.status()).records, 6);
});

Deno.test("consumer: 10215 and 10200 re-resolve the subscription and count resubscribed", async () => {
	const h = harness();
	await subscribe(h);
	const name = h.k2.subscriptions()[0].name;
	h.k2.dataFault("consume", { kind: "error", status: 404, code: 10215 });
	await produce(h.k2, [workload(1)]);
	await h.bus.nudge();
	await h.tick();
	equal((await h.status()).resubscribed, 1);
	await h.next();
	deepEqual(h.dispatched, [RUN(1)]);
	h.k2.dataFault("consume", { kind: "error", status: 404, code: 10200 });
	await h.bus.nudge();
	await h.tick();
	equal((await h.status()).resubscribed, 2);
	equal(h.k2.subscriptions().length, 1);
	equal(h.k2.subscriptions()[0].name, name);
});

Deno.test("consumer: a name conflict (10201) turns the consumer to error", async () => {
	const h = harness();
	h.k2.dataFault("subscriptions.create", {
		kind: "error",
		status: 422,
		code: 10201,
	});
	await h.bus.nudge();
	await h.tick();
	const s = await h.status();
	equal(s.consume, "error");
	ok(s.lastError!.includes("10201"));
});

Deno.test("consumer: a storage reset mints a new gen and deletes the old subscription", async () => {
	const clock = testClock();
	const k2 = createFakeK2({ now: clock.now });
	const a = harness({ k2, clock });
	await subscribe(a);
	const first = k2.subscriptions()[0].name;
	const b = harness({ k2, clock });
	await b.bus.nudge();
	await b.tick();
	const names = k2.subscriptions().map((s) => s.name);
	equal(names.length, 1);
	ok(names[0] !== first);
	ok(names[0].startsWith("workloads-"));
	equal((await b.status()).subscription, names[0]);
});

Deno.test("consumer: no token means consume off and idle", async () => {
	const h = harness({ client: null });
	await h.bus.nudge();
	const s = await h.status();
	equal(s.consume, "off");
	equal(h.d.timers().size, 0);
	await h.tick();
	equal(h.k2.calls.consume, 0);
});

Deno.test("consumer: the token never appears in an error, log line, status field or parked record", async () => {
	const SENTINEL = "tok-SENTINEL-4f1d9c";
	const h = harness({ token: SENTINEL });
	await h.bus.nudge();
	await h.tick();
	// The fake rejected the sentinel (it expects its own token).
	ok(h.k2.requests.some((r) => r.authorization === `Bearer ${SENTINEL}`));
	const s = await h.status();
	ok(s.lastError !== null);
	const everything = [
		JSON.stringify(s),
		h.logs.join("\n"),
		JSON.stringify(await h.bus.deadList({})),
		...h.d.storage.sql.exec<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'table'",
		).toArray().map(({ name }) =>
			JSON.stringify(h.d.storage.sql.exec(`SELECT * FROM "${name}"`).toArray())
		),
	].join("\n");
	ok(!everything.includes(SENTINEL));
	ok(!everything.toLowerCase().includes("bearer"));
	// And the client's own error shape carries no token.
	const client = createK2Client({
		endpoint: h.k2.endpoint,
		token: () => Promise.resolve(SENTINEL),
		fetch: h.k2.fetch,
	});
	try {
		await client.listSubscriptions();
		ok(false);
	} catch (error) {
		ok(error instanceof K2Error);
		equal(error.code, 10209);
		equal(error.status, 401);
		ok(!String(error).includes(SENTINEL));
		ok(!JSON.stringify(error).includes(SENTINEL));
	}
});

Deno.test("workloads: dispatched, already, terminal and superseded are done; unknown-run is poison; errors retry", async () => {
	const outcomes: Record<string, DispatchOutcome | "throw"> = {
		[RUN(1)]: "dispatched",
		[RUN(2)]: "already",
		[RUN(3)]: "terminal",
		[RUN(4)]: "superseded",
		[RUN(5)]: "unknown-run",
		[RUN(6)]: "throw",
	};
	const h = harness({
		dispatch: (runId) =>
			outcomes[runId] === "throw"
				? Promise.reject(new Error("RPC down"))
				: Promise.resolve(outcomes[runId] as DispatchOutcome),
	});
	await subscribe(h);
	await produce(h.k2, [1, 2, 3, 4, 5, 6].map((n) => workload(n)));
	await h.bus.nudge();
	await h.tick();
	const s = await h.status();
	equal(s.dead, 1);
	equal(s.retry, 1);
	const dead = await h.bus.deadList({});
	equal(dead.dead[0].error, "poison: unknown-run");
	equal(h.k2.calls.ack, 1);
});

Deno.test("workloads: via counters equal the distinct run.dispatched records (redeliveries never count twice)", async () => {
	const h = harness();
	await subscribe(h);
	const at = Date.UTC(2026, 9, 5, 12, 30);
	h.k2.sendFault({ kind: "duplicate" });
	await produce(h.k2, [
		dispatchedEvent(1, "k2", at),
		dispatchedEvent(2, "k2", at),
		dispatchedEvent(3, "backstop", at),
		dispatchedEvent(4, "local", at + 3_600_000),
	]);
	await h.bus.nudge();
	await h.tick();
	h.k2.expireLeases();
	await h.tick();
	const via = (await h.status()).via;
	deepEqual(
		[...via].sort((a, b) => a.hour - b.hour),
		[
			{ hour: hourOf(at), k2: 2, backstop: 1, local: 0 },
			{ hour: hourOf(at) + 3_600_000, k2: 0, backstop: 0, local: 1 },
		],
	);
});

Deno.test("consumer: dead records can be retried or discarded; a discarded one stays skipped", async () => {
	let fail = true;
	const h = harness({
		handler: () =>
			Promise.resolve(
				fail ? { outcome: "poison", error: "bad" } : { outcome: "done" },
			),
	});
	await subscribe(h);
	await produce(h.k2, [noise(), noise()]);
	await h.bus.nudge();
	await h.tick();
	const dead = await h.bus.deadList({ limit: 1 });
	equal(dead.dead.length, 1);
	ok(dead.cursor !== undefined);
	const next = await h.bus.deadList({ limit: 1, cursor: dead.cursor });
	equal(next.dead.length, 1);
	ok(next.dead[0].id !== dead.dead[0].id);
	fail = false;
	equal(await h.bus.deadRetry(dead.dead[0].id), true);
	await h.tick();
	equal(await h.bus.deadDiscard(next.dead[0].id), true);
	equal(await h.bus.deadDiscard(next.dead[0].id), false);
	equal(await h.bus.deadRetry("nope"), false);
	const s = await h.status();
	equal(s.dead, 0);
	equal(s.retry, 0);
	// Redelivery of the discarded record is skipped.
	const discarded = h.k2.records().find((r) =>
		r.headers[HEADERS.id] === next.dead[0].id
	)!;
	h.k2.produce([{ content: discarded.content, headers: discarded.headers }]);
	fail = true;
	await h.bus.nudge();
	await h.tick();
	equal((await h.status()).dead, 0);
});

Deno.test("consumer: status re-arms a missing poll timer; recordRelayLags keeps the worst 10", async () => {
	const h = harness();
	await subscribe(h);
	h.d.timers().clear();
	// timers() is a copy: clear the harness's own timer by running it out.
	await h.tick();
	await h.status();
	ok(h.d.timers().get(`bus/${POLL_TIMER}`) !== undefined);
	await h.bus.recordRelayLags(
		Array.from({ length: 15 }, (_, i) => ({
			stream: `repo:${i}`,
			state: "ok" as const,
			lag: i,
			oldestUnrelayedAt: null,
		})),
	);
	const s = await h.status();
	equal(s.relayLags.length, 10);
	equal(s.relayLags[0].lag, 14);
	ok(s.relayLagsAt !== null);
});

Deno.test("consumer: the live conformance suite's records are skipped, never parked", async () => {
	const h = harness();
	await subscribe(h);
	h.k2.produce([
		{
			content: new TextEncoder().encode("c1"),
			headers: conformanceHeaders("t"),
		},
		{
			content: new TextEncoder().encode("c2"),
			headers: conformanceHeaders("t"),
		},
	]);
	await h.bus.nudge();
	await h.tick();
	const s = await h.status();
	equal(s.records, 2);
	equal(s.dead, 0);
	equal(s.retry, 0);
	deepEqual(h.dispatched, []);
});
