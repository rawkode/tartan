// The global log relay (WP26): the `bus` module of RepoDO (migrations
// 460–479) and ForgeDO (550–569). The DO's own event log stays the system of
// record and the outbox (K3); the relay copies every committed event, in
// `seq` order, into the forge's K2 stream through the `EVENT_LOG` binding.
//
// - Never on a commit path: an append only arms the `relay` timer (no later
//   than 1 s ahead, inside the append's transaction, so an eviction between
//   commit and flush costs at most 1 s); the coalescer's flush runs the relay
//   at once (the fast path). A K2 outage delays nothing synchronous.
// - One `send()` in flight per DO, at most 500 records / 4 MB, and the cursor
//   (`relayed_seq`) moves only after a success; a failed batch is resent
//   unchanged. `10212`/`10213` (may or may not be stored) and retryable codes
//   back off 1, 2, 5, 15, then 60 s and count as unknown outcomes; consumers
//   dedupe on `ce_id`. Configuration-class codes are `blocked` (retried every
//   5 min, health red). No binding or no stream var: `off`, nothing relayed
//   and no prune guard.
// - Nothing is filtered: shadow and sim rows are relayed; `x.<extId>.*`
//   payloads are relayed redacted (`./codec.ts`).
// - A stream change (`TARTAN_K2_STREAM` differs from the cursor's) starts the
//   new stream from the oldest retained seq; a range the DO no longer holds
//   is announced by one elision record, never skipped silently.
// - A batch holding a workload record (a queued `run.started` marked `k2`)
//   nudges the `workloads` consumer.

import {
	type Clock,
	type DoModule,
	type Migration,
	type ModuleTimersApi,
} from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import type { SqlExec } from "../events/sql.ts";
import {
	cutBatch,
	elisionRecord,
	type EncodedRecord,
	type RecordSource,
	toLogRecord,
} from "./codec.ts";
import {
	busDoName,
	K2_CONFIG_ERROR_CODES,
	K2_RELAY_ARM_MS,
	K2_RELAY_BACKOFF_MS,
	K2_RELAY_BATCH,
	K2_RELAY_BLOCKED_RETRY_MS,
	K2_UNKNOWN_OUTCOME_CODES,
} from "./config.ts";
import {
	BUS_MIGRATION_RANGES,
	type BusRelayFacade,
	type BusRelayInternal,
	type EventsRelaySource,
	type RelayState,
	type RelayStatus,
} from "./contract.ts";
import { k2Env, type K2Producer, type K2SendResult } from "./k2.ts";
import { armNoLaterThan } from "./timers.ts";
import { withRpc } from "../../do/dispose.ts";

export const RELAY_TIMER = "relay";
/** Sends per relay run; a longer backlog continues from the timer. */
export const RELAY_MAX_ROUNDS = 20;

const RELAY_DDL = `CREATE TABLE k2_relay (id INTEGER PRIMARY KEY CHECK (id = 1),
  stream_id TEXT,
  relayed_seq INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('ok','backoff','blocked','off')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER, last_error TEXT, last_ok_at INTEGER,
  sent_records INTEGER NOT NULL DEFAULT 0,
  sent_bytes INTEGER NOT NULL DEFAULT 0,
  unknown_outcomes INTEGER NOT NULL DEFAULT 0);
INSERT INTO k2_relay (id, state) VALUES (1, 'off')`;

export const REPO_BUS_MIGRATIONS: readonly Migration[] = [
	{ n: 460, name: "k2_relay", sql: RELAY_DDL },
];
export const FORGE_BUS_MIGRATIONS: readonly Migration[] = [
	{ n: 550, name: "k2_relay", sql: RELAY_DDL },
];

export type RelayRow = {
	stream_id: string | null;
	relayed_seq: number;
	state: RelayState;
	attempts: number;
	next_at: number | null;
	last_error: string | null;
	last_ok_at: number | null;
	sent_records: number;
	sent_bytes: number;
	unknown_outcomes: number;
};

/** What a `send()` outcome means for the relay. */
export type SendVerdict =
	| { readonly kind: "ok" }
	| {
		readonly kind: "backoff";
		readonly unknown: boolean;
		readonly error: string;
	}
	| { readonly kind: "blocked"; readonly error: string };

/** Unknown outcomes and retryable codes back off; config codes block. */
export const classifySend = (result: K2SendResult | "threw"): SendVerdict => {
	if (result === "threw") {
		return { kind: "backoff", unknown: false, error: "throw" };
	}
	if (result.success) return { kind: "ok" };
	const { code, retryable } = result.error;
	const error = `K2 ${code}`;
	if (K2_UNKNOWN_OUTCOME_CODES.includes(code)) {
		return { kind: "backoff", unknown: true, error };
	}
	if (retryable) return { kind: "backoff", unknown: false, error };
	if (K2_CONFIG_ERROR_CODES.includes(code)) return { kind: "blocked", error };
	return { kind: "backoff", unknown: false, error };
};

/** The delay before resending after `attempts` consecutive failures (≥ 1). */
export const relayBackoffMs = (attempts: number): number =>
	K2_RELAY_BACKOFF_MS[
		Math.min(Math.max(attempts, 1), K2_RELAY_BACKOFF_MS.length) - 1
	];

export type Logger = (message: string, data: Record<string, unknown>) => void;

export type RelayDeps = {
	readonly sql: SqlExec;
	readonly transact: <T>(fn: () => T) => T;
	readonly clock: Clock;
	readonly timers: ModuleTimersApi;
	/** The DO's event log (resolved lazily: a sibling module). */
	readonly source: () => EventsRelaySource;
	/** `repo:<ulid>` or `forge`: the status name. */
	readonly name: string;
	readonly stage: string;
	readonly producer: K2Producer | undefined;
	readonly streamId: string | undefined;
	/** Wakes the `workloads` consumer (fire and forget). */
	readonly nudge: () => void;
	readonly log: Logger;
};

export type Relay = {
	/** Runs the relay; single flight (concurrent callers share one run). Never rejects. */
	pump(): Promise<void>;
	/** The append hook: arms the timer no later than 1 s ahead (sync, in the transaction). */
	armSync(): void;
	status(): RelayStatus;
	stateSync(): RelayState;
	relayedSeqSync(): number;
};

export const createRelay = (deps: RelayDeps): Relay => {
	const { sql, transact, clock, timers } = deps;
	const enabled = deps.producer !== undefined &&
		typeof deps.streamId === "string" && deps.streamId !== "";

	const readRow = (): RelayRow =>
		sql.exec<RelayRow>("SELECT * FROM k2_relay WHERE id = 1").one();

	let row = readRow();
	const write = (patch: Partial<RelayRow>): void => {
		const keys = Object.keys(patch) as (keyof RelayRow)[];
		if (keys.length === 0) return;
		sql.exec(
			`UPDATE k2_relay SET ${
				keys.map((k) => `${k} = ?`).join(", ")
			} WHERE id = 1`,
			...keys.map((k) => patch[k] ?? null),
		);
		row = readRow();
	};

	// The binding decides `off`; an enabled relay that was off starts `ok`.
	if (!enabled && row.state !== "off") {
		transact(() => write({ state: "off", next_at: null, attempts: 0 }));
	} else if (enabled && row.state === "off") {
		transact(() => write({ state: "ok" }));
	}

	const armAt = (at: number): void =>
		armNoLaterThan(timers, RELAY_TIMER, at, clock.now());

	const armSync = (): void => {
		if (!enabled) return;
		const soon = clock.now() + K2_RELAY_ARM_MS;
		const waiting = row.state === "backoff" || row.state === "blocked";
		armAt(waiting && row.next_at !== null ? Math.max(soon, row.next_at) : soon);
	};

	const sourceOf = (epoch: string): RecordSource => ({
		stage: deps.stage,
		stream: deps.name,
		epoch,
	});

	/** The next batch: an elision record for a gap the log no longer holds, then rows. */
	const nextBatch = (
		events: EventsRelaySource,
		now: number,
	): { records: EncodedRecord[]; lastSeq: number } => {
		const epoch = events.epochSync();
		const head: EncodedRecord[] = [];
		let since = row.relayed_seq;
		const oldest = events.oldestSeqSync();
		if (oldest !== null && oldest - 1 > since) {
			const first = events.readSync({ since: oldest - 1, limit: 1 })[0];
			head.push(elisionRecord({
				from: since + 1,
				to: oldest - 1,
				hashAtTo: first?.prevHash ?? null,
				at: now,
			}, sourceOf(epoch)));
			since = oldest - 1;
		}
		const rows = events.readSync({
			since,
			limit: K2_RELAY_BATCH.records - head.length,
		});
		const encoded = rows.map((r) => ({
			seq: r.seq,
			record: toLogRecord(r, {
				stage: deps.stage,
				stream: r.envelope.stream,
				epoch,
			}),
		}));
		const all = [
			...head.map((record) => ({ seq: since, record, size: record.size })),
			...encoded.map((e) => ({ ...e, size: e.record.size })),
		];
		const cut = cutBatch(all);
		return {
			records: cut.map((c) => c.record),
			lastSeq: cut.length === 0 ? row.relayed_seq : cut[cut.length - 1].seq,
		};
	};

	const round = async (): Promise<"more" | "done"> => {
		row = readRow();
		const now = clock.now();
		if (
			(row.state === "backoff" || row.state === "blocked") &&
			row.next_at !== null && row.next_at > now
		) {
			armAt(row.next_at);
			return "done";
		}
		if (row.stream_id !== deps.streamId) {
			// A new stream starts from the oldest retained seq.
			transact(() => write({ stream_id: deps.streamId!, relayed_seq: 0 }));
		}
		const events = deps.source();
		const { records, lastSeq } = nextBatch(events, now);
		if (records.length === 0) {
			if (row.state !== "ok") {
				transact(() =>
					write({ state: "ok", attempts: 0, next_at: null, last_error: null })
				);
			}
			timers.cancel(RELAY_TIMER);
			return "done";
		}
		let result: K2SendResult | "threw";
		try {
			result = await deps.producer!.send(
				records.map(({ content, headers }) => ({ content, headers })),
			);
		} catch {
			result = "threw";
		}
		const verdict = classifySend(result);
		const at = clock.now();
		if (verdict.kind === "ok") {
			const bytes = records.reduce((n, r) => n + r.size, 0);
			transact(() =>
				write({
					relayed_seq: Math.max(row.relayed_seq, lastSeq),
					state: "ok",
					attempts: 0,
					next_at: null,
					last_error: null,
					last_ok_at: at,
					sent_records: row.sent_records + records.length,
					sent_bytes: row.sent_bytes + bytes,
				})
			);
			if (records.some((r) => r.workload)) deps.nudge();
			return "more";
		}
		const attempts = row.attempts + 1;
		const nextAt = at +
			(verdict.kind === "blocked"
				? K2_RELAY_BLOCKED_RETRY_MS
				: relayBackoffMs(attempts));
		transact(() =>
			write({
				state: verdict.kind,
				attempts,
				next_at: nextAt,
				last_error: verdict.error,
				unknown_outcomes: row.unknown_outcomes +
					(verdict.kind === "backoff" && verdict.unknown ? 1 : 0),
			})
		);
		deps.log("k2 relay send failed", {
			stream: deps.name,
			state: verdict.kind,
			error: verdict.error,
			attempts,
		});
		armAt(nextAt);
		return "done";
	};

	const run = async (): Promise<void> => {
		if (!enabled) return;
		try {
			for (let i = 0; i < RELAY_MAX_ROUNDS; i++) {
				if (await round() === "done") return;
			}
			// A long backlog yields to other work and continues from the timer.
			armAt(clock.now());
		} catch (error) {
			deps.log("k2 relay failed", {
				stream: deps.name,
				error: error instanceof Error ? error.name : "error",
			});
			armAt(clock.now() + relayBackoffMs(1));
		}
	};

	let inflight: Promise<void> | null = null;
	const pump = (): Promise<void> => {
		inflight ??= run().finally(() => {
			inflight = null;
		});
		return inflight;
	};

	const status = (): RelayStatus => {
		row = readRow();
		const events = deps.source();
		const head = events.headSync().seq;
		const next = events.readSync({ since: row.relayed_seq, limit: 1 })[0];
		return {
			stream: deps.name,
			state: row.state,
			epoch: events.epochSync(),
			head,
			relayedSeq: row.relayed_seq,
			lag: Math.max(0, head - row.relayed_seq),
			oldestUnrelayedAt: next?.envelope.at ?? null,
			attempts: row.attempts,
			nextAt: row.next_at,
			lastError: row.last_error,
			lastOkAt: row.last_ok_at,
			sentRecords: row.sent_records,
			sentBytes: row.sent_bytes,
			unknownOutcomes: row.unknown_outcomes,
		};
	};

	return {
		pump,
		armSync,
		status,
		stateSync: () => row.state,
		relayedSeqSync: () => row.relayed_seq,
	};
};

// ---------------------------------------------------------------------------
// The `bus` module of RepoDO and ForgeDO
// ---------------------------------------------------------------------------

export type BusModuleOptions = {
	/** The producer (default `env.EVENT_LOG`). */
	readonly producer?: (env: Env) => K2Producer | undefined;
	/** Wakes the `workloads` consumer (default: `BUS` `bus:workloads:0`). */
	readonly nudge?: (env: Env) => () => Promise<void>;
	readonly log?: Logger;
};

type Siblings = { readonly events: EventsRelaySource };

const defaultLog: Logger = (message, data) =>
	console.error(`[tartan] ${message}`, JSON.stringify(data));

const defaultNudge = (env: Env) => async (): Promise<void> => {
	const bus = k2Env(env).BUS;
	if (bus === undefined) return;
	await withRpc(
		() => bus.getByName(busDoName("workloads", 0)).bus(),
		(b) => b.nudge(),
	);
};

const busModule = (
	kind: "repo" | "forge",
	options: BusModuleOptions,
): DoModule<BusRelayFacade, BusRelayInternal, Env, Siblings> => ({
	name: "bus",
	range: BUS_MIGRATION_RANGES[kind],
	migrations: kind === "repo" ? REPO_BUS_MIGRATIONS : FORGE_BUS_MIGRATIONS,
	create: (deps) => {
		const env = k2Env(deps.env);
		const log = options.log ?? defaultLog;
		const nudge = (options.nudge ?? defaultNudge)(deps.env);
		const relay = createRelay({
			sql: deps.sql as unknown as SqlExec,
			transact: (fn) => deps.ctx.storage.transactionSync(fn),
			clock: deps.clock,
			timers: deps.timers,
			source: () => deps.modules.events,
			name: kind === "repo" ? (deps.ctx.id.name ?? "repo") : "forge",
			stage: env.TARTAN_STAGE,
			producer: (options.producer ?? ((e: Env) => k2Env(e).EVENT_LOG))(
				deps.env,
			),
			streamId: env.TARTAN_K2_STREAM,
			nudge: () =>
				deps.ctx.waitUntil(
					nudge().catch((error) =>
						log("k2 nudge failed", {
							error: error instanceof Error ? error.name : "error",
						})
					),
				),
			log,
		});
		deps.modules.events.onAppendSync(() => relay.armSync());
		deps.modules.events.onFlush(() => deps.ctx.waitUntil(relay.pump()));
		const facade: BusRelayFacade = {
			status: () => Promise.resolve().then(relay.status),
			kick: async () => {
				await relay.pump();
				return relay.status();
			},
		};
		return {
			facade,
			internal: {
				relayedSeqSync: relay.relayedSeqSync,
				stateSync: relay.stateSync,
			},
			onTimer: (key) => key === RELAY_TIMER ? relay.pump() : undefined,
		};
	},
});

export const createRepoBusModule = (options: BusModuleOptions = {}) =>
	busModule("repo", options);
export const createForgeBusModule = (options: BusModuleOptions = {}) =>
	busModule("forge", options);

export const repoBusModule = createRepoBusModule();
export const forgeBusModule = createForgeBusModule();
