// The BusDO consumer (WP26): the `bus` module of the thin
// `BusDO` class (`bus:<group>:<n>`, migrations 100–199). K2 has no consume
// binding and no push consumer, so a DO alarm loop polls the data plane over
// HTTPS with the K2 Consume token from a Secrets Store binding
// (`TARTAN_K2_TOKEN`, read only here; `./client.ts` keeps it out of every
// error and log line).
//
// One batch per alarm invocation (the `poll` timer):
//   1. resolve the subscription `<group>-<gen>` (gen: a ULID minted at this
//      DO's first start, so a storage reset never silently resumes an old
//      position; worker 0 deletes any other `<group>-*` subscription; the
//      `workloads` group starts at `latest`, since the runs backstop covers
//      anything older);
//   2. consume; an empty batch backs off 250 ms → 5 s (a nudge resets it);
//   3. for each record in order: parse (malformed → dead), skip it when it
//      is already seen, retried or parked, count the attempt durably before
//      the handler runs (a record whose handler crashed 3 times is parked),
//      run the group handler with a 10 s bound (a timeout is `retry`), and
//      apply the outcome: done/skip → seen, retry → the retry table
//      (1 s … 10 min, 8 attempts, then dead), poison → dead;
//   4. ack, then poll again at once.
// Tartan never nacks: the parked tables are its dead-letter queue, so one
// bad record never blocks the subscription. A lease near its end is
// extended (a lost lease, `10218`, is logged and the loop goes on); `10215`
// and `10200` re-resolve the subscription (`resubscribed`); a name conflict
// (`10201`) turns health red. Without a token the consumer is `off` and
// idle, and every RepoDO dispatches inline.

import { createUlid } from "@tartan/contract";
import {
	type DoModule,
	type Migration,
	type ModuleTimersApi,
} from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import type { SqlExec } from "../events/sql.ts";
import { createK2Client, type K2Client, K2Error } from "./client.ts";
import { HEADERS, type LogRecord, parseLogRecord } from "./codec.ts";
import {
	BUS_DO_NAME_RE,
	busDoName,
	busWorkerId,
	type ConsumerGroup,
	K2_CONSUME_RETRYABLE_CODES,
	K2_DEAD_CONTENT_MAX_BYTES,
	K2_GROUPS,
	K2_HANDLER_TIMEOUT_MS,
	K2_LEASE_EXTEND_MARGIN_MS,
	K2_LEASE_LOST_CODE,
	K2_MAX_CRASH_ATTEMPTS,
	K2_POLL_BACKOFF_MS,
	K2_RESUBSCRIBE_CODES,
	K2_RETRY_BACKOFF,
	K2_RETRY_BATCH,
	K2_RETRY_MAX_ATTEMPTS,
	K2_SEEN_RETENTION_MS,
	K2_STREAM_ID_RE,
	K2_SUBSCRIPTION_CONFLICT_CODE,
	K2_VIA_HOURS,
	k2Endpoint,
	subscriptionName,
} from "./config.ts";
import {
	BUS_MIGRATION_RANGES,
	type BusFacade,
	type BusStatus,
	type ConsumeState,
	type DeadRecordDto,
	type RelayLag,
	type RunDispatchVia,
	type ViaCounts,
} from "./contract.ts";
import { k2Env } from "./k2.ts";
import { armNoLaterThan } from "./timers.ts";
import {
	createWorkloadsHandler,
	type GroupHandler,
	type HandlerOutcome,
	hourOf,
	repoDispatch,
} from "./workloads.ts";
import { withRpc } from "../../do/dispose.ts";

export const POLL_TIMER = "poll";
export const RETRY_TIMER = "retry";
/** Relay lags kept for the status page. */
export const RELAY_LAGS_KEPT = 10;
/** A name conflict is retried this rarely (it needs a deploy or a reset). */
export const CONFLICT_RETRY_MS = 300_000;

export const BUS_MIGRATIONS: readonly Migration[] = [
	{
		n: 100,
		name: "bus_consumer",
		sql: [
			"CREATE TABLE sub (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
			"CREATE TABLE seen (event_id TEXT PRIMARY KEY, at INTEGER NOT NULL)",
			"CREATE INDEX seen_at ON seen(at)",
			"CREATE TABLE attempts (event_id TEXT PRIMARY KEY, n INTEGER NOT NULL)",
			`CREATE TABLE retry (event_id TEXT PRIMARY KEY, type TEXT,
  headers_json TEXT NOT NULL, content_b64 TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL, attempts INTEGER NOT NULL,
  next_at INTEGER NOT NULL, error TEXT)`,
			"CREATE INDEX retry_due ON retry(next_at)",
			`CREATE TABLE dead (event_id TEXT PRIMARY KEY, type TEXT,
  headers_json TEXT NOT NULL, content_b64 TEXT, error TEXT NOT NULL,
  at INTEGER NOT NULL)`,
			"CREATE INDEX dead_at ON dead(at, event_id)",
			"CREATE TABLE stats (k TEXT PRIMARY KEY, v INTEGER NOT NULL)",
			`CREATE TABLE via_counts (hour INTEGER NOT NULL, via TEXT NOT NULL,
  n INTEGER NOT NULL, PRIMARY KEY (hour, via))`,
		].join(";\n"),
	},
];

const toBase64 = (bytes: Uint8Array): string => {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
};
const fromBase64 = (text: string): Uint8Array => {
	const binary = atob(text);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
};

/** A K2 failure as status text: `K2 <op> <status>/<code>` (never a body). */
const errorText = (error: unknown): string =>
	error instanceof K2Error
		? `K2 ${error.op} ${error.status}${
			error.code === null ? "" : `/${error.code}`
		}`
		: error instanceof Error
		? error.name
		: "error";

export const retryBackoffMs = (attempts: number): number =>
	Math.min(
		K2_RETRY_BACKOFF.maxMs,
		K2_RETRY_BACKOFF.initialMs * 2 ** Math.max(0, attempts - 1),
	);

export type ConsumerPorts = {
	/** The data-plane client, or null when the token or stream is missing. */
	readonly client: K2Client | null;
	/** Group → handler. */
	readonly handlers: Readonly<Record<string, GroupHandler>>;
	/** Worker 0's subscription name (workers > 0 only). */
	readonly leaderSubscription: (group: string) => Promise<string | null>;
	readonly log: (message: string, data: Record<string, unknown>) => void;
};

export type BusConsumerOptions = {
	/** Ports from the module deps (default: Secrets Store token, HTTPS, RPC). */
	readonly ports?: (
		deps: {
			env: Env;
			sql: SqlExec;
			countViaSync: (hour: number, via: RunDispatchVia) => void;
		},
	) => Partial<ConsumerPorts>;
	readonly handlerTimeoutMs?: number;
};

const defaultLog = (message: string, data: Record<string, unknown>) =>
	console.error(`[tartan] ${message}`, JSON.stringify(data));

/** The production client: the stream's endpoint and the Secrets Store token. */
export const envClient = (env: Env): K2Client | null => {
	const k2 = k2Env(env);
	const stream = k2.TARTAN_K2_STREAM;
	const token = k2.TARTAN_K2_TOKEN;
	if (
		token === undefined || stream === undefined || !K2_STREAM_ID_RE.test(stream)
	) {
		return null;
	}
	return createK2Client({
		endpoint: k2Endpoint(stream),
		token: () => token.get(),
	});
};

type Row = { k: string; v: string };

export const createBusConsumerModule = (
	options: BusConsumerOptions = {},
): DoModule<BusFacade, Record<string, never>, Env, Record<string, never>> => ({
	name: "bus",
	range: BUS_MIGRATION_RANGES.bus,
	migrations: BUS_MIGRATIONS,
	create: (deps) => {
		const sql = deps.sql as unknown as SqlExec;
		const clock = deps.clock;
		const timers: ModuleTimersApi = deps.timers;
		const transact = <T>(fn: () => T): T =>
			deps.ctx.storage.transactionSync(fn);
		const stage = k2Env(deps.env).TARTAN_STAGE;
		const handlerTimeoutMs = options.handlerTimeoutMs ?? K2_HANDLER_TIMEOUT_MS;

		const match = BUS_DO_NAME_RE.exec(deps.ctx.id.name ?? "");
		const group = match?.[1] ?? "invalid";
		const worker = match ? Number(match[2]) : 0;
		const config: ConsumerGroup | undefined = K2_GROUPS[group];
		const workerId = busWorkerId(stage, group, worker);

		// --- small key/value state -------------------------------------------
		const kv = (k: string): string | null =>
			sql.exec<Row>("SELECT k, v FROM sub WHERE k = ?", k).toArray()[0]?.v ??
				null;
		const setKv = (k: string, v: string | number | null): void => {
			if (v === null) sql.exec("DELETE FROM sub WHERE k = ?", k);
			else {
				sql.exec(
					"INSERT INTO sub (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
					k,
					String(v),
				);
			}
		};
		const num = (k: string): number | null => {
			const v = kv(k);
			return v === null ? null : Number(v);
		};
		const bump = (k: string, by = 1): void => {
			sql.exec(
				"INSERT INTO stats (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = v + excluded.v",
				k,
				by,
			);
		};
		const stat = (k: string): number =>
			sql.exec<{ v: number }>("SELECT v FROM stats WHERE k = ?", k).toArray()[0]
				?.v ?? 0;

		const countViaSync = (hour: number, via: RunDispatchVia): void => {
			sql.exec(
				"INSERT INTO via_counts (hour, via, n) VALUES (?, ?, 1) ON CONFLICT (hour, via) DO UPDATE SET n = n + 1",
				hour,
				via,
			);
		};

		const injected = options.ports?.({ env: deps.env, sql, countViaSync }) ??
			{};
		const ports: ConsumerPorts = {
			client: injected.client === undefined
				? envClient(deps.env)
				: injected.client,
			handlers: injected.handlers ?? {
				workloads: createWorkloadsHandler({
					dispatch: repoDispatch(deps.env),
					countViaSync,
				}),
			},
			leaderSubscription: injected.leaderSubscription ??
				(async (g) => {
					const bus = k2Env(deps.env).BUS;
					if (bus === undefined) return null;
					return (await withRpc(
						() => bus.getByName(busDoName(g, 0)).bus(),
						(b) => b.status(),
					)).subscription;
				}),
			log: injected.log ?? defaultLog,
		};
		const handler = ports.handlers[group];

		// A storage reset mints a new gen: never resume an old position.
		if (kv("gen") === null) setKv("gen", createUlid({ now: clock.now })());
		const gen = kv("gen")!;

		const consumeState = (): ConsumeState => {
			if (ports.client === null) return "off";
			if (config === undefined || handler === undefined) return "error";
			return kv("conflict") === null ? "ok" : "error";
		};

		const armPoll = (at: number): void =>
			armNoLaterThan(timers, POLL_TIMER, at, clock.now());
		const armRetry = (): void => {
			const next = sql.exec<{ at: number | null }>(
				"SELECT MIN(next_at) AS at FROM retry",
			).one().at;
			if (next === null) timers.cancel(RETRY_TIMER);
			else armNoLaterThan(timers, RETRY_TIMER, next, clock.now());
		};

		const fail = (error: unknown): void => {
			setKv("last_error", errorText(error));
		};

		const backoffPoll = (): void => {
			const index = Math.min(
				(num("backoff") ?? -1) + 1,
				K2_POLL_BACKOFF_MS.length - 1,
			);
			setKv("backoff", index);
			armPoll(clock.now() + K2_POLL_BACKOFF_MS[index]);
		};

		// --- the subscription ------------------------------------------------
		const resolveSubscription = async (client: K2Client): Promise<string> => {
			const cached = kv("sub_id");
			if (cached !== null) return cached;
			const name = worker === 0
				? subscriptionName(group, gen)
				: await ports.leaderSubscription(group);
			if (name === null) throw new Error("no leader subscription");
			const found = (await client.listSubscriptions(name)).find((s) =>
				s.name === name
			);
			const id = found?.id ??
				await client.createSubscription(name, config!.startAt);
			if (worker === 0) {
				// One live subscription per group: older gens are deleted.
				for (const old of await client.listSubscriptions()) {
					if (old.name.startsWith(`${group}-`) && old.name !== name) {
						await client.deleteSubscription(old.id).then(
							() => bump("subscriptions_deleted"),
							(error) =>
								ports.log("k2 old subscription delete failed", {
									group,
									error: errorText(error),
								}),
						);
					}
				}
			}
			transact(() => {
				setKv("sub_id", id);
				setKv("sub_name", name);
			});
			return id;
		};

		// --- records ---------------------------------------------------------
		const known = (id: string): boolean =>
			sql.exec<{ n: number }>(
				`SELECT (SELECT COUNT(*) FROM seen WHERE event_id = ?)
				 + (SELECT COUNT(*) FROM retry WHERE event_id = ?)
				 + (SELECT COUNT(*) FROM dead WHERE event_id = ?) AS n`,
				id,
				id,
				id,
			).one().n > 0;

		const park = (
			id: string,
			type: string | null,
			headers: Readonly<Record<string, string>>,
			content: Uint8Array | null,
			error: string,
		): void => {
			sql.exec(
				`INSERT INTO dead (event_id, type, headers_json, content_b64, error, at)
				 VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (event_id) DO UPDATE SET
				 error = excluded.error, at = excluded.at`,
				id,
				type,
				JSON.stringify(headers),
				content === null || content.length > K2_DEAD_CONTENT_MAX_BYTES
					? null
					: toBase64(content),
				error,
				clock.now(),
			);
			sql.exec("DELETE FROM retry WHERE event_id = ?", id);
			bump("dead");
		};

		const runHandler = async (record: LogRecord): Promise<HandlerOutcome> => {
			const controller = new AbortController();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<HandlerOutcome>((resolve) => {
				timer = setTimeout(() => {
					controller.abort();
					resolve({ outcome: "retry", error: "timeout" });
				}, handlerTimeoutMs);
			});
			try {
				return await Promise.race([
					handler!(record, controller.signal),
					timeout,
				]);
			} finally {
				clearTimeout(timer);
			}
		};

		/** Records `outcome` for a record (and drops its crash counter). */
		const applySync = (record: LogRecord, outcome: HandlerOutcome): void => {
			const now = clock.now();
			switch (outcome.outcome) {
				case "done":
					outcome.applySync?.();
				// falls through
				case "skip":
					sql.exec(
						"INSERT OR IGNORE INTO seen (event_id, at) VALUES (?, ?)",
						record.id,
						now,
					);
					sql.exec("DELETE FROM retry WHERE event_id = ?", record.id);
					bump(outcome.outcome);
					break;
				case "retry": {
					const prior = sql.exec<{ attempts: number }>(
						"SELECT attempts FROM retry WHERE event_id = ?",
						record.id,
					).toArray()[0]?.attempts ?? 0;
					const attempts = prior + 1;
					if (attempts >= K2_RETRY_MAX_ATTEMPTS) {
						park(
							record.id,
							record.type,
							record.headers,
							record.content,
							`retry: ${outcome.error}`,
						);
						break;
					}
					sql.exec(
						`INSERT INTO retry (event_id, type, headers_json, content_b64,
						 timestamp_ms, attempts, next_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
						 ON CONFLICT (event_id) DO UPDATE SET attempts = excluded.attempts,
						 next_at = excluded.next_at, error = excluded.error`,
						record.id,
						record.type,
						JSON.stringify(record.headers),
						toBase64(record.content),
						record.timestampMs,
						attempts,
						now + retryBackoffMs(attempts),
						outcome.error,
					);
					bump("retried");
					break;
				}
				case "poison":
					park(
						record.id,
						record.type,
						record.headers,
						record.content,
						`poison: ${outcome.error}`,
					);
					break;
			}
			sql.exec("DELETE FROM attempts WHERE event_id = ?", record.id);
		};

		type Processed = "ok" | "crashed";

		/** One record of a batch (steps 3a–3e). */
		const processRecord = async (raw: {
			timestampMs: number;
			content: Uint8Array;
			headers: Readonly<Record<string, string>>;
		}): Promise<Processed> => {
			const parsed = parseLogRecord(raw);
			if (!parsed.ok) {
				if (!known(parsed.id)) {
					transact(() =>
						park(
							parsed.id,
							raw.headers[HEADERS.type] ?? null,
							raw.headers,
							raw.content,
							`malformed: ${parsed.error}`,
						)
					);
				}
				return "ok";
			}
			const record = parsed.record;
			if (known(record.id)) return "ok";
			const attempts = transact(() => {
				sql.exec(
					"INSERT INTO attempts (event_id, n) VALUES (?, 1) ON CONFLICT (event_id) DO UPDATE SET n = n + 1",
					record.id,
				);
				return sql.exec<{ n: number }>(
					"SELECT n FROM attempts WHERE event_id = ?",
					record.id,
				).one().n;
			});
			if (attempts > K2_MAX_CRASH_ATTEMPTS) {
				transact(() => {
					park(
						record.id,
						record.type,
						record.headers,
						record.content,
						`crashed ${K2_MAX_CRASH_ATTEMPTS} times`,
					);
					sql.exec("DELETE FROM attempts WHERE event_id = ?", record.id);
				});
				return "ok";
			}
			let outcome: HandlerOutcome;
			try {
				outcome = await runHandler(record);
			} catch (error) {
				// A crash: the attempt stays counted, the batch is not acked, and the
				// same batch comes back on the next poll.
				setKv("last_error", `handler ${errorText(error)}`);
				bump("crashes");
				return "crashed";
			}
			transact(() => applySync(record, outcome));
			return "ok";
		};

		// --- the poll loop ---------------------------------------------------
		let polling: Promise<void> | null = null;

		const pollOnce = async (): Promise<void> => {
			const client = ports.client;
			if (client === null || consumeState() !== "ok") return;
			let subscription: string;
			let batch;
			try {
				subscription = await resolveSubscription(client);
				batch = await client.consume(
					subscription,
					workerId,
					config!.maxRecords,
				);
			} catch (error) {
				fail(error);
				if (error instanceof K2Error && error.code !== null) {
					if (K2_RESUBSCRIBE_CODES.includes(error.code)) {
						transact(() => setKv("sub_id", null));
						bump("resubscribed");
						armPoll(clock.now());
						return;
					}
					if (error.code === K2_SUBSCRIPTION_CONFLICT_CODE) {
						setKv("conflict", errorText(error));
						armPoll(clock.now() + CONFLICT_RETRY_MS);
						return;
					}
					if (!K2_CONSUME_RETRYABLE_CODES.includes(error.code)) {
						ports.log("k2 consume failed", { group, error: errorText(error) });
					}
				}
				backoffPoll();
				return;
			}
			const polledAt = clock.now();
			transact(() => {
				setKv("last_poll_ok_at", polledAt);
				setKv("last_error", null);
			});
			if (batch.batchId === null || batch.records.length === 0) {
				backoffPoll();
				return;
			}
			const recovered = kv("batch_id") === batch.batchId;
			transact(() => {
				setKv("batch_id", batch.batchId);
				setKv("leased_until", batch.leasedUntilMs);
				if (recovered) bump("recovered_batches");
			});
			let leasedUntil = batch.leasedUntilMs ?? Infinity;
			for (const raw of batch.records) {
				if (clock.now() > leasedUntil - K2_LEASE_EXTEND_MARGIN_MS) {
					try {
						leasedUntil = await client.extend(
							subscription,
							batch.batchId,
							workerId,
						) ?? leasedUntil;
						bump("extended");
					} catch (error) {
						if (error instanceof K2Error && error.code === K2_LEASE_LOST_CODE) {
							ports.log("k2 lease lost", { group });
							bump("lease_lost");
							leasedUntil = Infinity;
						} else fail(error);
					}
				}
				if (await processRecord(raw) === "crashed") {
					armPoll(clock.now() + K2_POLL_BACKOFF_MS[0]);
					return;
				}
			}
			const last = batch.records[batch.records.length - 1];
			transact(() => {
				bump("records", batch.records.length);
				setKv("last_record_at", last.timestampMs);
				setKv("consumer_lag_ms", Math.max(0, polledAt - last.timestampMs));
			});
			try {
				await client.ack(subscription, batch.batchId, workerId);
			} catch (error) {
				// The same batch comes back; every record is already known.
				fail(error);
				armPoll(clock.now() + K2_POLL_BACKOFF_MS[0]);
				return;
			}
			transact(() => {
				setKv("batch_id", null);
				setKv("backoff", null);
				bump("batches");
			});
			armRetry();
			armPoll(clock.now());
		};

		const poll = (): Promise<void> => {
			polling ??= pollOnce().finally(() => {
				polling = null;
			});
			return polling;
		};

		const runRetries = async (): Promise<void> => {
			if (handler === undefined) return;
			const due = sql.exec<{
				event_id: string;
				headers_json: string;
				content_b64: string;
				timestamp_ms: number;
			}>(
				"SELECT event_id, headers_json, content_b64, timestamp_ms FROM retry WHERE next_at <= ? ORDER BY next_at LIMIT ?",
				clock.now(),
				K2_RETRY_BATCH,
			).toArray();
			for (const row of due) {
				const parsed = parseLogRecord({
					content: fromBase64(row.content_b64),
					headers: JSON.parse(row.headers_json),
					timestampMs: row.timestamp_ms,
				});
				if (!parsed.ok) {
					transact(() =>
						park(row.event_id, null, {}, null, `malformed: ${parsed.error}`)
					);
					continue;
				}
				let outcome: HandlerOutcome;
				try {
					outcome = await runHandler(parsed.record);
				} catch (error) {
					outcome = { outcome: "retry", error: `throw ${errorText(error)}` };
				}
				transact(() => applySync(parsed.record, outcome));
			}
			armRetry();
		};

		/** Housekeeping: old `seen` rows and via counts. */
		const prune = (): void => {
			const now = clock.now();
			const last = num("pruned_at") ?? 0;
			if (now - last < 3_600_000) return;
			transact(() => {
				sql.exec("DELETE FROM seen WHERE at < ?", now - K2_SEEN_RETENTION_MS);
				sql.exec(
					"DELETE FROM via_counts WHERE hour < ?",
					hourOf(now) - K2_VIA_HOURS * 3_600_000,
				);
				setKv("pruned_at", now);
			});
		};

		const viaCounts = (): ViaCounts[] => {
			const rows = sql.exec<{ hour: number; via: string; n: number }>(
				"SELECT hour, via, n FROM via_counts ORDER BY hour DESC LIMIT 300",
			).toArray();
			const byHour = new Map<
				number,
				{ k2: number; backstop: number; local: number }
			>();
			for (const r of rows) {
				const entry = byHour.get(r.hour) ?? { k2: 0, backstop: 0, local: 0 };
				if (r.via === "k2" || r.via === "backstop" || r.via === "local") {
					entry[r.via] += r.n;
				}
				byHour.set(r.hour, entry);
			}
			return [...byHour.entries()].map(([hour, c]) => ({ hour, ...c }));
		};

		const status = (): BusStatus => {
			const count = (table: "retry" | "dead") =>
				sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;
			const lags = kv("relay_lags");
			return {
				group,
				worker,
				consume: consumeState(),
				subscription: kv("sub_name"),
				lastPollOkAt: num("last_poll_ok_at"),
				lastRecordAt: num("last_record_at"),
				consumerLagMs: num("consumer_lag_ms"),
				records: stat("records"),
				retry: count("retry"),
				dead: count("dead"),
				resubscribed: stat("resubscribed"),
				lastError: kv("conflict") ?? kv("last_error"),
				via: viaCounts(),
				relayLags: lags === null ? [] : JSON.parse(lags) as RelayLag[],
				relayLagsAt: num("relay_lags_at"),
			};
		};

		/** Re-arms a missing poll timer (the cron, status, a lost nudge). */
		const ensurePolling = (): void => {
			if (consumeState() !== "ok") return;
			if (timers.get(POLL_TIMER) === null) armPoll(clock.now());
		};

		const facade: BusFacade = {
			nudge: () => {
				if (consumeState() === "ok") {
					setKv("backoff", null);
					armPoll(clock.now());
				}
				return Promise.resolve();
			},
			wake: () => {
				ensurePolling();
				armRetry();
				return Promise.resolve(status());
			},
			status: () => {
				ensurePolling();
				return Promise.resolve(status());
			},
			deadList: ({ limit, cursor } = {}) => {
				const take = Math.min(100, Math.max(1, limit ?? 50));
				const [at, id] = cursor === undefined
					? [Number.MAX_SAFE_INTEGER, ""]
					: [
						Number(cursor.split(".")[0]),
						cursor.split(".").slice(1).join("."),
					];
				const rows = sql.exec<{
					event_id: string;
					type: string | null;
					error: string;
					at: number;
				}>(
					`SELECT event_id, type, error, at FROM dead
					 WHERE at < ? OR (at = ? AND event_id < ?)
					 ORDER BY at DESC, event_id DESC LIMIT ?`,
					at,
					at,
					id,
					take + 1,
				).toArray();
				const page = rows.slice(0, take);
				const dead: DeadRecordDto[] = page.map((r) => ({
					id: r.event_id,
					type: r.type,
					error: r.error,
					at: r.at,
				}));
				const lastRow = page[page.length - 1];
				return Promise.resolve({
					dead,
					...(rows.length > take && lastRow
						? { cursor: `${lastRow.at}.${lastRow.event_id}` }
						: {}),
				});
			},
			deadRetry: (id) => {
				const moved = transact(() => {
					const row = sql.exec<{
						type: string | null;
						headers_json: string;
						content_b64: string | null;
					}>(
						"SELECT type, headers_json, content_b64 FROM dead WHERE event_id = ?",
						id,
					).toArray()[0];
					if (row === undefined || row.content_b64 === null) return false;
					sql.exec("DELETE FROM dead WHERE event_id = ?", id);
					sql.exec(
						`INSERT INTO retry (event_id, type, headers_json, content_b64,
						 timestamp_ms, attempts, next_at, error) VALUES (?, ?, ?, ?, ?, 0, ?, 'manual')`,
						id,
						row.type,
						row.headers_json,
						row.content_b64,
						clock.now(),
						clock.now(),
					);
					return true;
				});
				if (moved) armRetry();
				return Promise.resolve(moved);
			},
			deadDiscard: (id) =>
				Promise.resolve(transact(() => {
					const found = sql.exec<{ n: number }>(
						"SELECT COUNT(*) AS n FROM dead WHERE event_id = ?",
						id,
					).one().n > 0;
					if (!found) return false;
					sql.exec("DELETE FROM dead WHERE event_id = ?", id);
					// A redelivery of a discarded record stays skipped.
					sql.exec(
						"INSERT OR IGNORE INTO seen (event_id, at) VALUES (?, ?)",
						id,
						clock.now(),
					);
					return true;
				})),
			recordRelayLags: (lags) => {
				const worst = [...lags].sort((a, b) => b.lag - a.lag).slice(
					0,
					RELAY_LAGS_KEPT,
				);
				transact(() => {
					setKv("relay_lags", JSON.stringify(worst));
					setKv("relay_lags_at", clock.now());
				});
				return Promise.resolve();
			},
		};

		return {
			facade,
			internal: {},
			onTimer: async (key) => {
				if (key === POLL_TIMER) {
					prune();
					await poll();
				} else if (key === RETRY_TIMER) {
					await runRetries();
				}
			},
		};
	},
});

export const busConsumerModule = createBusConsumerModule();
