// WP26 property test: the whole
// path — runs.start (k2) → the event log → the relay → FakeK2 → the BusDO
// consumer → runs.dispatch, with the outbox backstop racing it — under
// random faults: duplicate sends, 10212 stored or not, 10213, throws,
// redelivery after lease expiry, consume errors, consumer evictions and
// transient dispatch failures. For every seed: each queued run yields
// exactly one Workflow instance and exactly one `run.dispatched`, and the
// consumer's via counters equal the DO's `run.dispatched` count by via.

import { deepEqual, equal, ok } from "node:assert/strict";
import type { AppendInput, Envelope } from "@tartan/contract";
import { COMMON_DDL, type ModuleDeps } from "@tartan/contract/kernel.ts";
import { createFakeK2 } from "@tartan/testkit/k2/fake.ts";
import type { Env } from "../../env.ts";
import { createFakeStorage } from "../events/testing/sqlite.ts";
import { createRepoRunsModule, RUNS_MIGRATIONS } from "../runs/module.ts";
import { ciGraph, REPO } from "../runs/testing/runs.ts";
import { createK2Client } from "./client.ts";
import { K2_DISPATCH_GRACE_MS } from "./config.ts";
import { createBusConsumerModule } from "./consumer.ts";
import type {
	BusFacade,
	EventLogRow,
	EventsRelaySource,
	RunDispatchVia,
} from "./contract.ts";
import { createRelay, REPO_BUS_MIGRATIONS } from "./relay.ts";
import { createTestDo, testClock, testIds } from "./testing/do.ts";
import { createWorkloadsHandler } from "./workloads.ts";

const mulberry32 = (seed: number) => () => {
	seed |= 0;
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** The RepoDO log as the runs module and the relay see it (no validation). */
const bridgeLog = (clock: { now(): number }, ids: { ulid(): string }) => {
	const rows: EventLogRow[] = [];
	const byKey = new Map<string, EventLogRow>();
	const hooks: ((r: { seq: number }) => void)[] = [];
	const appendSync = (input: AppendInput) => {
		const existing = byKey.get(input.idemKey);
		if (existing) {
			return {
				id: existing.envelope.id,
				seq: existing.seq,
				hash: "0".repeat(64),
				created: false,
			};
		}
		const seq = rows.length + 1;
		const envelope: Envelope = {
			id: ids.ulid(),
			seq,
			stream: `repo:${REPO}`,
			type: input.type,
			v: 1,
			source: input.source,
			actor: input.actor,
			node: input.node,
			repo: input.repo ?? input.node,
			...(input.subject ? { subject: input.subject } : {}),
			depth: 0,
			shadow: false,
			at: clock.now(),
			hash: seq.toString(16).padStart(64, "0"),
			data: input.data,
		};
		const row: EventLogRow = {
			seq,
			idemKey: input.idemKey,
			prevHash: (seq - 1).toString(16).padStart(64, "0"),
			hash: envelope.hash!,
			repo: REPO,
			envelope,
		};
		rows.push(row);
		byKey.set(input.idemKey, row);
		for (const hook of hooks) hook({ seq });
		return { id: envelope.id, seq, hash: envelope.hash!, created: true };
	};
	const source: EventsRelaySource = {
		readSync: ({ since, limit }) =>
			rows.filter((r) => r.seq > since).slice(0, limit),
		epochSync: () => "01k6eeeeeeeeeeeeeeeeeeeeee",
		oldestSeqSync: () => rows[0]?.seq ?? null,
		headSync: () => ({ seq: rows.length }),
		onFlush: () => {},
		onAppendSync: (hook) => void hooks.push(hook),
	};
	return { appendSync, source, rows };
};

const scenario = async (seed: number, runCount: number) => {
	const rand = mulberry32(seed);
	const chance = (p: number) => rand() < p;
	const clock = testClock();
	const ids = testIds();
	const k2 = createFakeK2({ now: clock.now });
	const log = bridgeLog(clock, ids);

	// --- RepoDO: runs + relay over one SQLite ---------------------------------
	const storage = createFakeStorage();
	storage.sql.exec(COMMON_DDL.meta);
	for (const m of [...RUNS_MIGRATIONS, ...REPO_BUS_MIGRATIONS]) {
		storage.sql.exec(m.sql);
	}
	const repoTimers = new Map<string, number>();
	const timersFor = (module: string) => ({
		schedule: (k: string, at: number) =>
			void repoTimers.set(`${module}/${k}`, at),
		cancel: (k: string) => void repoTimers.delete(`${module}/${k}`),
		get: (k: string) => repoTimers.get(`${module}/${k}`) ?? null,
	});
	const created: string[] = [];
	let createFailures = 0;
	const relayRef: { state(): "ok" } = { state: () => "ok" };
	const runsModule = createRepoRunsModule({
		effects: () => ({
			createInstance: async (instanceId) => {
				await new Promise((r) => setTimeout(r, chance(0.3) ? 1 : 0));
				if (chance(0.1)) {
					createFailures += 1;
					throw new Error("workflows unavailable");
				}
				const exists = created.includes(instanceId);
				created.push(instanceId);
				return exists ? "exists" : "created";
			},
			stopSandbox: () => Promise.resolve(),
			wake: () => Promise.resolve(),
			readLog: () => Promise.resolve(null),
		}),
		background: () => {},
		transport: () => ({ choose: () => Promise.resolve("k2") }),
	});
	const ctx = {
		storage: { sql: storage.sql, transactionSync: storage.transactionSync },
		waitUntil: () => {},
		id: { name: `repo:${REPO}` },
	} as unknown as DurableObjectState;
	const runs = runsModule.create({
		sql: storage.sql as unknown as SqlStorage,
		storage: ctx.storage,
		ctx,
		env: {} as Env,
		modules: {
			events: { appendSync: log.appendSync },
			bus: { stateSync: relayRef.state, relayedSeqSync: () => 0 },
		},
		timers: timersFor("runs"),
		clock,
		ids,
	} as unknown as ModuleDeps<Env, never>);

	let nudged = 0;
	const relay = createRelay({
		sql: storage.sql,
		transact: storage.transactionSync,
		clock,
		timers: timersFor("bus"),
		source: () => log.source,
		name: `repo:${REPO}`,
		stage: "dev-wp26",
		producer: {
			send: (records) => {
				const roll = rand();
				if (roll < 0.08) k2.sendFault({ kind: "duplicate" });
				else if (roll < 0.14) {
					k2.sendFault({ kind: "error", code: 10212, stored: true });
				} else if (roll < 0.2) {
					k2.sendFault({ kind: "error", code: 10213, stored: false });
				} else if (roll < 0.24) k2.sendFault({ kind: "throw" });
				return k2.producer.send(records);
			},
		},
		streamId: k2.streamId,
		nudge: () => void (nudged += 1),
		log: () => {},
	});
	log.source.onAppendSync(() => relay.armSync());

	// --- BusDO -----------------------------------------------------------------
	const consumer = createTestDo({
		name: "bus:workloads:0",
		env: { TARTAN_STAGE: "dev-wp26" },
		clock,
		modules: {
			bus: createBusConsumerModule({
				ports: ({ countViaSync }) => ({
					client: createK2Client({
						endpoint: k2.endpoint,
						token: () => Promise.resolve(k2.token),
						fetch: (req) => {
							if (chance(0.05)) {
								k2.dataFault("consume", {
									kind: "error",
									status: 429,
									code: 10216,
								});
							}
							return k2.fetch(req);
						},
					}),
					handlers: {
						workloads: createWorkloadsHandler({
							dispatch: (_repo, runId, options) =>
								chance(0.1)
									? Promise.reject(new Error("RPC down"))
									: runs.facade.dispatch(runId, options),
							countViaSync,
						}),
					},
					log: () => {},
				}),
			}),
		},
	});
	const bus = () => consumer.facade<BusFacade>("bus");

	const fireRepoTimers = async () => {
		const now = clock.now();
		for (const [id, at] of [...repoTimers.entries()]) {
			if (at > now) continue;
			repoTimers.delete(id);
			if (id === "runs/outbox") await runs.onTimer?.("outbox");
			if (id === "bus/relay") await relay.pump();
		}
	};

	// --- the run -----------------------------------------------------------------
	const runIds: string[] = [];
	for (let i = 0; i < runCount; i++) {
		const { runId } = await runs.facade.start({
			graph: ciGraph({ subject: { kind: "change", id: `c${i}` } }),
			idemKey: `p:${seed}:${i}`,
			requestedBy: "i_01k6aaaaaaaaaaaaaaaaaaaaab",
		});
		runIds.push(runId);
		// Random interleavings of the relay, the consumer, time and faults.
		const steps = 1 + Math.floor(rand() * 4);
		for (let s = 0; s < steps; s++) {
			const r = rand();
			if (r < 0.3) await relay.pump();
			else if (r < 0.6) {
				await bus().nudge();
				await consumer.runDue();
			} else if (r < 0.7) k2.expireLeases();
			else if (r < 0.75) consumer.restart();
			else clock.advance(Math.floor(rand() * 8_000));
			await fireRepoTimers();
		}
	}

	// --- drain: every run reaches its instance ----------------------------------
	for (let i = 0; i < 400; i++) {
		clock.advance(i % 10 === 0 ? K2_DISPATCH_GRACE_MS : 1_500);
		await fireRepoTimers();
		await relay.pump();
		await bus().nudge();
		await consumer.runDue();
		if (i % 7 === 0) k2.expireLeases();
		const done = runIds.every((id) =>
			runs.internal.runSync(id)!.instance_created === 1
		);
		const relayed = relay.relayedSeqSync() === log.rows.length;
		const status = await bus().status();
		if (done && relayed && status.retry === 0 && i > 20) break;
	}

	// --- invariants ---------------------------------------------------------------
	const dispatchedEvents = log.rows.filter((r) =>
		r.envelope.type === "run.dispatched"
	);
	equal(
		dispatchedEvents.length,
		runCount,
		`seed ${seed}: run.dispatched count`,
	);
	equal(
		new Set(
			dispatchedEvents.map((r) => (r.envelope.data as { runId: string }).runId),
		).size,
		runCount,
	);
	const instances = new Set(created);
	equal(instances.size, runCount, `seed ${seed}: one instance per run`);
	// A create that was retried after "exists" never makes a second instance.
	for (const id of runIds) {
		const row = runs.internal.runSync(id)!;
		equal(row.instance_created, 1);
		ok(row.via !== null);
	}
	const byVia = (via: RunDispatchVia) =>
		runIds.filter((id) => runs.internal.runSync(id)!.via === via).length;
	const status = await bus().status();
	const counted = status.via.reduce(
		(acc, h) => ({
			k2: acc.k2 + h.k2,
			backstop: acc.backstop + h.backstop,
			local: acc.local + h.local,
		}),
		{ k2: 0, backstop: 0, local: 0 },
	);
	deepEqual(counted, {
		k2: byVia("k2"),
		backstop: byVia("backstop"),
		local: byVia("local"),
	}, `seed ${seed}: via counters`);
	equal(status.dead, 0, `seed ${seed}: nothing parked`);
	return { counted, createFailures, nudged, records: k2.records().length };
};

Deno.test("property: exactly one instance and one run.dispatched per queued run under K2 faults", async () => {
	const totals = { k2: 0, backstop: 0, local: 0 };
	for (const seed of [1, 2, 3, 5, 8, 13, 21, 34]) {
		const result = await scenario(seed, 12);
		totals.k2 += result.counted.k2;
		totals.backstop += result.counted.backstop;
		ok(result.nudged > 0);
	}
	// Both paths were exercised across the seeds.
	ok(totals.k2 > 0);
	ok(totals.backstop > 0);
	equal(totals.local, 0);
});
