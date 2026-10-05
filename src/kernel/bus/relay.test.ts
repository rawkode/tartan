// The global log relay (WP26; PLAN acceptance "Relay"): the core against an
// in-memory source and FakeK2, then the RepoDO and ForgeDO `bus` modules
// beside the real event logs over node:sqlite.

import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import { createFakeK2 } from "@tartan/testkit/k2/fake.ts";
import { type FakeStorage } from "../events/testing/sqlite.ts";
import { HEADERS } from "./codec.ts";
import {
	K2_CONFIG_ERROR_CODES,
	K2_RELAY_ARM_MS,
	K2_RELAY_BACKOFF_MS,
	K2_RELAY_BLOCKED_RETRY_MS,
} from "./config.ts";
import { BUS_MIGRATION_RANGES, type RelayStatus } from "./contract.ts";
import { MIGRATION_RANGES } from "@tartan/contract/kernel.ts";
import type { K2Producer } from "./k2.ts";
import {
	classifySend,
	createRelay,
	RELAY_TIMER,
	type RelayDeps,
	REPO_BUS_MIGRATIONS,
} from "./relay.ts";
import { createTestDo, testClock } from "./testing/do.ts";
import {
	EXT,
	forgeBusModules,
	memorySource,
	presence,
	REPO,
	repoBusModules,
	STAGE,
} from "./testing/fixtures.ts";
import { createFakeStorage } from "../events/testing/sqlite.ts";

// ---------------------------------------------------------------------------
// The relay core
// ---------------------------------------------------------------------------

const decoder = new TextDecoder();

const core = (
	options: {
		producer?: K2Producer | null;
		streamId?: string;
	} = {},
) => {
	const storage: FakeStorage = createFakeStorage();
	for (const m of REPO_BUS_MIGRATIONS) storage.sql.exec(m.sql);
	const k2 = createFakeK2();
	const clock = testClock();
	const timers = new Map<string, number>();
	const src = memorySource();
	const nudges: number[] = [];
	const logs: string[] = [];
	const deps: RelayDeps = {
		sql: storage.sql,
		transact: storage.transactionSync,
		clock,
		timers: {
			schedule: (k, at) => void timers.set(k, at),
			cancel: (k) => void timers.delete(k),
			get: (k) => timers.get(k) ?? null,
		},
		source: () => src.source,
		name: `repo:${REPO}`,
		stage: STAGE,
		producer: options.producer === null
			? undefined
			: options.producer ?? k2.producer,
		streamId: options.streamId ?? k2.streamId,
		nudge: () => void nudges.push(clock.now()),
		log: (message, data) =>
			void logs.push(`${message} ${JSON.stringify(data)}`),
	};
	const relay = createRelay(deps);
	src.source.onAppendSync(() => relay.armSync());
	return { relay, k2, clock, timers, src, nudges, logs, storage };
};

const seqsOf = (k2: ReturnType<typeof createFakeK2>) =>
	k2.records().map((r) => Number(r.headers[HEADERS.seq]));

Deno.test("relay: batches go in seq order with one send in flight (single flight)", async () => {
	const c = core();
	c.src.add(1200);
	let inFlight = 0;
	let maxInFlight = 0;
	const sizes: number[] = [];
	const producer: K2Producer = {
		send: async (records) => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			sizes.push(records.length);
			await new Promise((r) => setTimeout(r, 2));
			const result = await c.k2.producer.send(records);
			inFlight -= 1;
			return result;
		},
	};
	const d = core({ producer });
	d.src.add(1200);
	await Promise.all([d.relay.pump(), d.relay.pump(), d.relay.pump()]);
	equal(maxInFlight, 1);
	deepEqual(sizes, [500, 500, 200]);
	deepEqual(seqsOf(c.k2), Array.from({ length: 1200 }, (_, i) => i + 1));
	const status = d.relay.status();
	equal(status.relayedSeq, 1200);
	equal(status.lag, 0);
	equal(status.state, "ok");
	equal(status.sentRecords, 1200);
	ok(status.sentBytes > 0);
	equal(status.oldestUnrelayedAt, null);
	// Drained: the timer is cleared.
	equal(d.timers.get(RELAY_TIMER), undefined);
});

Deno.test("relay: 10212/10213 and retryable codes resend the same range with backoff and count unknown outcomes", async () => {
	const c = core();
	c.src.add(3);
	c.k2.sendFault(
		{ kind: "error", code: 10212, stored: true },
		{ kind: "error", code: 10213, stored: false },
		{ kind: "error", code: 10211, retryable: true },
	);
	const at0 = c.clock.now();
	await c.relay.pump();
	let s = c.relay.status();
	equal(s.state, "backoff");
	equal(s.relayedSeq, 0);
	equal(s.unknownOutcomes, 1);
	equal(s.lastError, "K2 10212");
	equal(s.nextAt, at0 + K2_RELAY_BACKOFF_MS[0]);
	equal(c.timers.get(RELAY_TIMER), at0 + K2_RELAY_BACKOFF_MS[0]);
	// Not yet due: nothing is sent.
	await c.relay.pump();
	equal(c.k2.calls.send, 1);
	c.clock.advance(K2_RELAY_BACKOFF_MS[0]);
	await c.relay.pump();
	s = c.relay.status();
	equal(s.unknownOutcomes, 2);
	equal(s.nextAt, c.clock.now() + K2_RELAY_BACKOFF_MS[1]);
	c.clock.advance(K2_RELAY_BACKOFF_MS[1]);
	await c.relay.pump();
	s = c.relay.status();
	equal(s.unknownOutcomes, 2);
	equal(s.attempts, 3);
	equal(s.nextAt, c.clock.now() + K2_RELAY_BACKOFF_MS[2]);
	c.clock.advance(K2_RELAY_BACKOFF_MS[2]);
	await c.relay.pump();
	s = c.relay.status();
	equal(s.state, "ok");
	equal(s.relayedSeq, 3);
	equal(s.attempts, 0);
	// The stored 10212 batch plus the final success: a duplicate range, deduped downstream by ce_id.
	deepEqual(seqsOf(c.k2), [1, 2, 3, 1, 2, 3]);
	equal(new Set(c.k2.records().map((r) => r.headers[HEADERS.id])).size, 3);
});

Deno.test("relay: backoff caps at 60 s", async () => {
	const c = core();
	c.src.add(1);
	for (let i = 0; i < 7; i++) {
		c.k2.sendFault({ kind: "error", code: 10211, retryable: true });
	}
	const delays: number[] = [];
	for (let i = 0; i < 7; i++) {
		await c.relay.pump();
		const s = c.relay.status();
		delays.push(s.nextAt! - c.clock.now());
		c.clock.set(s.nextAt!);
	}
	deepEqual(delays, [1000, 2000, 5000, 15000, 60000, 60000, 60000]);
});

Deno.test("relay: configuration-class codes block (retried every 5 min); other codes and throws back off", async () => {
	for (const code of K2_CONFIG_ERROR_CODES) {
		equal(
			classifySend({
				success: false,
				error: { code, message: "x", retryable: false },
			}).kind,
			"blocked",
			`code ${code}`,
		);
	}
	equal(
		classifySend({
			success: false,
			error: { code: 10200, message: "x", retryable: true },
		}).kind,
		"backoff",
	);
	equal(
		classifySend({
			success: false,
			error: { code: 10299, message: "x", retryable: false },
		}).kind,
		"backoff",
	);
	equal(classifySend("threw").kind, "backoff");
	const c = core();
	c.src.add(2);
	c.k2.sendFault({ kind: "error", code: 10400 });
	await c.relay.pump();
	let s = c.relay.status();
	equal(s.state, "blocked");
	equal(s.nextAt, c.clock.now() + K2_RELAY_BLOCKED_RETRY_MS);
	equal(s.lastError, "K2 10400");
	c.clock.advance(K2_RELAY_BLOCKED_RETRY_MS);
	c.k2.sendFault({ kind: "throw", message: "Bearer secret-token oops" });
	await c.relay.pump();
	s = c.relay.status();
	equal(s.state, "backoff");
	equal(s.lastError, "throw");
	ok(!c.logs.join("\n").includes("secret-token"));
	c.clock.set(s.nextAt!);
	await c.relay.pump();
	equal(c.relay.status().relayedSeq, 2);
});

Deno.test("relay: no binding or no stream var is off: nothing relayed, no timer, no guard", async () => {
	for (const options of [{ producer: null }, { streamId: "" }]) {
		const c = core(options);
		c.src.add(5);
		await c.relay.pump();
		equal(c.relay.stateSync(), "off");
		equal(c.k2.records().length, 0);
		equal(c.timers.size, 0);
	}
});

Deno.test("relay: an append arms the timer no later than now + 1 s, never earlier than a backoff", async () => {
	const c = core();
	c.src.add(1);
	equal(c.timers.get(RELAY_TIMER), c.clock.now() + K2_RELAY_ARM_MS);
	c.clock.advance(300);
	c.src.add(1);
	// An earlier timer stays.
	equal(c.timers.get(RELAY_TIMER), c.clock.now() - 300 + K2_RELAY_ARM_MS);
	c.k2.sendFault({ kind: "error", code: 10211, retryable: true });
	await c.relay.pump();
	const nextAt = c.relay.status().nextAt!;
	c.timers.clear();
	c.src.add(1);
	equal(c.timers.get(RELAY_TIMER), Math.max(nextAt, c.clock.now() + 1000));
});

Deno.test("relay: a stream change restarts from the oldest retained seq, with one elision record for the gap", async () => {
	const c = core();
	c.src.add(10);
	await c.relay.pump();
	equal(c.relay.relayedSeqSync(), 10);
	c.src.prune(4);
	// Same stores, a new stream id: the deploy re-rendered TARTAN_K2_STREAM.
	const k2b = createFakeK2({ streamId: "fedcba9876543210fedcba9876543210" });
	const moved = createRelay({
		sql: c.storage.sql,
		transact: c.storage.transactionSync,
		clock: c.clock,
		timers: {
			schedule: (k, at) => void c.timers.set(k, at),
			cancel: (k) => void c.timers.delete(k),
			get: (k) => c.timers.get(k) ?? null,
		},
		source: () => c.src.source,
		name: `repo:${REPO}`,
		stage: STAGE,
		producer: k2b.producer,
		streamId: k2b.streamId,
		nudge: () => {},
		log: () => {},
	});
	await moved.pump();
	const records = k2b.records();
	equal(records[0].headers[HEADERS.flags], "elided");
	equal(records[0].headers[HEADERS.from], "1");
	equal(records[0].headers[HEADERS.to], "4");
	equal(records[0].headers[HEADERS.hash], (4).toString(16).padStart(64, "0"));
	deepEqual(records.slice(1).map((r) => Number(r.headers[HEADERS.seq])), [
		5,
		6,
		7,
		8,
		9,
		10,
	]);
	equal(moved.relayedSeqSync(), 10);
	// No gap, no elision: a new stream with the full history gets it all.
	const d = core();
	d.src.add(3);
	await d.relay.pump();
	equal(
		d.k2.records().filter((r) => r.headers[HEADERS.flags] === "elided").length,
		0,
	);
});

Deno.test("relay: shadow and sim rows are relayed; x.* data is redacted", async () => {
	const c = core();
	c.src.add(1, () => ({ shadow: true }));
	c.src.add(1, () => ({ sim: true }));
	c.src.add(1, () => ({
		type: "x.acme.lint.private",
		source: { kind: "installation", id: EXT, ext: "acme.lint@1" },
		data: { plan: "launch at dawn" },
	}));
	await c.relay.pump();
	const records = c.k2.records();
	equal(records.length, 3);
	equal(records[0].headers[HEADERS.flags], "shadow");
	equal(records[1].headers[HEADERS.flags], "sim");
	equal(records[2].headers[HEADERS.flags], "redacted");
	ok(!decoder.decode(records[2].content).includes("dawn"));
});

Deno.test("relay: the nudge fires only when a batch held a workload record", async () => {
	const c = core();
	c.src.add(3);
	await c.relay.pump();
	equal(c.nudges.length, 0);
	c.src.add(1, (seq) => ({
		type: "run.started",
		data: { runId: `r${seq}`, state: "queued", transport: "local" },
	}));
	await c.relay.pump();
	equal(c.nudges.length, 0);
	c.src.add(1, (seq) => ({
		type: "run.started",
		data: { runId: `r${seq}`, state: "queued", transport: "k2" },
	}));
	await c.relay.pump();
	equal(c.nudges.length, 1);
	equal(c.k2.records().at(-1)!.headers[HEADERS.workload], "k2");
});

Deno.test("relay: a batch is cut at 4,000,000 bytes", async () => {
	const c = core();
	const big = "x".repeat(15_000);
	c.src.add(400, () => ({ data: { blob: big } }));
	const sizes: number[] = [];
	const producer: K2Producer = {
		send: (records) => {
			sizes.push(records.length);
			return c.k2.producer.send(records);
		},
	};
	const d = core({ producer });
	d.src.add(400, () => ({ data: { blob: big } }));
	await d.relay.pump();
	ok(sizes.length >= 2);
	ok(sizes[0] < 400);
	equal(sizes.reduce((a, b) => a + b, 0), 400);
	equal(d.relay.relayedSeqSync(), 400);
});

// ---------------------------------------------------------------------------
// RepoDO / ForgeDO modules beside the real event logs
// ---------------------------------------------------------------------------

const repoDo = (
	k2 = createFakeK2() as ReturnType<typeof createFakeK2> | null,
) => {
	const clock = testClock();
	const nudges: string[] = [];
	const set = repoBusModules(k2, { nudges, clock });
	const d = createTestDo({
		name: `repo:${REPO}`,
		env: set.env,
		modules: set.modules,
		clock,
	});
	return { d, clock, k2, schedule: set.schedule, nudges };
};

const append = (d: ReturnType<typeof repoDo>["d"], input = presence(1)) =>
	d.facade("events").append(input);

Deno.test("bus module: an append arms bus/relay inside its transaction; the flush relays at once", async () => {
	const { d, clock, k2, schedule } = repoDo();
	await append(d, presence(1));
	equal(d.timers().get("bus/relay"), clock.now() + K2_RELAY_ARM_MS);
	equal(k2!.records().length, 0);
	schedule.flush();
	await d.settle();
	equal(k2!.records().length, 1);
	equal(k2!.records()[0].headers[HEADERS.type], "presence.changed");
	equal(k2!.records()[0].headers[HEADERS.stream], `repo:${REPO}`);
	equal(d.internal("bus").relayedSeqSync(), 1);
	// Drained: the timer is cleared.
	equal(d.timers().get("bus/relay"), undefined);
});

Deno.test("bus module: an eviction between commit and flush still relays within about 1 s (the timer)", async () => {
	const { d, clock, k2 } = repoDo();
	await append(d, presence(1));
	await append(d, presence(2));
	// The coalescer's run is lost (eviction): only the durable timer is left.
	clock.advance(K2_RELAY_ARM_MS);
	const ran = await d.runDue();
	deepEqual(ran.map((r) => `${r.module}/${r.key}`), ["bus/relay"]);
	equal(k2!.records().length, 2);
	equal(d.timers().get("bus/relay"), undefined);
});

Deno.test("bus module: a throwing append hook rolls the append back (the hook is in the transaction)", async () => {
	const { d } = repoDo();
	d.internal("events").onAppendSync(() => {
		throw new Error("hook failed");
	});
	await rejects(append(d, presence(1)), /hook failed/);
	equal(await d.facade("events").head(), 0);
});

Deno.test("bus module: shadow, sim and extension rows go through the real log, redacted where private", async () => {
	const { d, k2, schedule } = repoDo();
	await append(d, presence(1, { shadow: true }));
	await append(d, presence(2, { sim: true }));
	await append(d, {
		type: "x.acme.lint.private",
		source: { kind: "installation", id: EXT, ext: "acme.lint@1" },
		actor: { kind: "ext", id: `x_${EXT}` },
		node: REPO,
		depth: 0,
		shadow: false,
		data: { plan: "launch at dawn" },
		idemKey: "x:1",
	});
	schedule.flush();
	await d.settle();
	const flags = k2!.records().map((r) => r.headers[HEADERS.flags]);
	deepEqual(flags, ["shadow", "sim", "redacted"]);
	ok(!decoder.decode(k2!.records()[2].content).includes("dawn"));
	// The chain position travels with each record.
	const head =
		(await d.facade("events").read({ since: 0, includeShadow: true }))
			.at(-1)!;
	equal(k2!.records()[2].headers[HEADERS.hash], head.hash);
});

Deno.test("bus module: the prune guard keeps unrelayed rows and releases them once relayed", async () => {
	const { d, clock, k2, schedule } = repoDo();
	k2!.sendFault({ kind: "error", code: 10211, retryable: true });
	for (let i = 1; i <= 5; i++) await append(d, presence(i));
	schedule.flush();
	await d.settle();
	equal(d.internal("bus").stateSync(), "backoff");
	clock.advance(31 * 24 * 60 * 60 * 1000);
	await append(d, presence(6));
	equal((await d.facade("events").prune(clock.now())).deleted, 0);
	// Relayed: retention applies again (never the head).
	clock.advance(60_000);
	await d.facade("bus").kick();
	equal(d.internal("bus").relayedSeqSync(), 6);
	equal(
		(await d.facade("events").prune(clock.now() + 31 * 86_400_000)).deleted,
		5,
	);
});

Deno.test("bus module: with no binding the relay is off and the prune guard is off", async () => {
	const { d, clock, schedule } = repoDo(null);
	for (let i = 1; i <= 3; i++) await append(d, presence(i));
	schedule.flush();
	await d.settle();
	equal(d.internal("bus").stateSync(), "off");
	equal(d.timers().get("bus/relay"), undefined);
	clock.advance(31 * 24 * 60 * 60 * 1000);
	await append(d, presence(4));
	equal((await d.facade("events").prune(clock.now())).deleted, 3);
	const status: RelayStatus = await d.facade("bus").status();
	equal(status.state, "off");
	equal(status.head, 4);
});

Deno.test("bus module: the epoch is stable within a DO and new after a storage reset", async () => {
	const a = repoDo();
	const b = repoDo();
	await append(a.d, presence(1));
	await append(b.d, presence(1));
	a.schedule.flush();
	b.schedule.flush();
	await a.d.settle();
	await b.d.settle();
	const epochA = a.d.internal("events").epochSync();
	equal(a.d.internal("events").epochSync(), epochA);
	ok(epochA !== b.d.internal("events").epochSync());
	equal(a.k2!.records()[0].headers[HEADERS.epoch], epochA);
	equal((await a.d.facade("bus").status()).epoch, epochA);
});

Deno.test("bus module: status reports lag and the oldest unrelayed event", async () => {
	const { d, clock, k2 } = repoDo();
	k2!.sendFault({ kind: "error", code: 10213 });
	await append(d, presence(1));
	clock.advance(5);
	await append(d, presence(2));
	await d.facade("bus").kick();
	const s: RelayStatus = await d.facade("bus").status();
	equal(s.state, "backoff");
	equal(s.lag, 2);
	equal(s.head, 2);
	equal(s.unknownOutcomes, 1);
	ok(s.oldestUnrelayedAt !== null && s.oldestUnrelayedAt <= clock.now());
	equal(s.stream, `repo:${REPO}`);
});

Deno.test("forge bus module: forge events are relayed with no chain headers", async () => {
	const k2 = createFakeK2();
	const clock = testClock();
	const set = forgeBusModules(k2);
	const d = createTestDo({
		name: "forge",
		env: set.env,
		modules: set.modules,
		clock,
	});
	const events = d.internal("events");
	d.storage.transactionSync(() =>
		events.appendSync({
			type: "repo.created",
			actor: { kind: "user", id: "u_01k6aaaaaaaaaaaaaaaaaaaaac" },
			node: REPO,
			data: { repoId: REPO, path: "acme/shop", artifactsName: `r-${REPO}` },
			idemKey: "repo.created:1",
		})
	);
	equal(d.timers().get("bus/relay"), clock.now() + K2_RELAY_ARM_MS);
	set.schedule.flush();
	await d.settle();
	const r = k2.records()[0];
	equal(r.headers[HEADERS.stream], "forge");
	equal(r.headers[HEADERS.type], "repo.created");
	equal(r.headers[HEADERS.repo], REPO);
	equal(r.headers[HEADERS.hash], undefined);
	equal(r.headers[HEADERS.source], `tartan:${STAGE}/forge`);
	equal((await d.facade("bus").status()).stream, "forge");
});

Deno.test("the bus modules register the contract's migration ranges", () => {
	deepEqual(BUS_MIGRATION_RANGES, {
		repo: MIGRATION_RANGES.repo.bus,
		forge: MIGRATION_RANGES.forge.bus,
		bus: MIGRATION_RANGES.bus.bus,
	});
	ok(Object.is(BUS_MIGRATION_RANGES.repo, MIGRATION_RANGES.repo.bus));
});
