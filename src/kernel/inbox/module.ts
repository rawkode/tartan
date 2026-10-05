// InboxDO `inbox` module (WP6, migrations 100–199): one principal's notices,
// presence and long-poll waiters.
//
// - `deliver` dedupes on `dedupeKey`, strips control characters from the
//   text (≤ 1 KB) on write and wakes `wait`ers. `peek` returns unread
//   notices highest severity first and marks them delivered; `read` pages by
//   seq; `ack` acknowledges. `wait` resolves at once when something is unread,
//   else on the next delivery or after ≤ 25 s, with what `peek` would return.
// - `touch` records presence per repo; the `flush` timer sends the changed
//   rows to each repo's RepoDO (`core().flushPresence`, lease renewal and
//   `presence.changed`) at most once a minute.
//
// DDL: the InboxDO tables plus `notices.source_label` (the `Notice.sourceLabel`
// shown in the fenced block).

import {
	byteLength,
	invalid,
	isPrincipalId,
	LaneIdSchema,
	type Notice,
	type NoticeInput,
	NoticeInputSchema,
	type Presence,
	repoDoName,
	sanitizeNoticeText,
	selectNotices,
	stripControl,
	tartanError,
	UlidSchema,
} from "@tartan/contract";
import {
	type DeliveryChannel,
	type DoModule,
	type InboxFacade,
	type InboxInternal,
	type Migration,
	MIGRATION_RANGES,
	type NoticeRow,
	type PresenceRow,
} from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import { createReportOnce, type Logger, settle } from "../events/pokes.ts";
import { first, jsonList, type SqlExec } from "../events/sql.ts";

export const INBOX_MIGRATIONS: readonly Migration[] = [
	{
		n: 100,
		name: "notices",
		sql: [
			`CREATE TABLE notices (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  repo_id TEXT, lane_id TEXT, source TEXT NOT NULL, source_label TEXT,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','warn','critical')),
  text TEXT NOT NULL,
  data_json TEXT, dedupe_key TEXT UNIQUE,
  created_at INTEGER NOT NULL, delivered_at INTEGER, delivered_via TEXT, acked_at INTEGER)`,
			"CREATE INDEX notices_unread ON notices(delivered_at, seq)",
		].join(";\n"),
	},
	{
		n: 101,
		name: "presence",
		sql:
			"CREATE TABLE presence (repo_id TEXT PRIMARY KEY, lane_id TEXT, status TEXT, last_seen_at INTEGER NOT NULL, flushed_at INTEGER)",
	},
];

/** `inbox_wait` ceiling. */
export const INBOX_WAIT_MAX_MS = 25_000;
/** Presence/lease flush to RepoDO at most once per minute. */
export const PRESENCE_FLUSH_MS = 60_000;
export const PEEK_MAX = 50;
export const READ_DEFAULT = 50;
export const READ_MAX = 200;
export const ACK_MAX = 200;
export const NOTICE_DATA_MAX_BYTES = 8 * 1024;
export const FLUSH_TIMER_KEY = "flush";

const CHANNELS: readonly DeliveryChannel[] = [
	"mcp",
	"echo",
	"api",
	"hook",
	"ws",
];
const SEVERITY_ORDER =
	"CASE severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END";

export type PresenceEntry = {
	principal: string;
	laneId?: string;
	status: string;
	at: number;
};

/** Sends one repo's changed presence rows (`RepoCoreFacade.flushPresence`). */
export type PresenceFlush = (
	repoId: string,
	entries: PresenceEntry[],
) => Promise<void>;

export const repoPresenceFlush = (env: Env): PresenceFlush =>
(
	repoId,
	entries,
) => env.REPO.getByName(repoDoName(repoId)).core().flushPresence(entries);

export type InboxOptions = {
	readonly flush?: (env: Env) => PresenceFlush;
	readonly log?: Logger;
};

/** What the InboxDO class exposes: the contract plus `wait`'s delivery channel. */
export type InboxApi = Omit<InboxFacade, "wait"> & {
	wait(
		timeoutMs: number,
		repoId?: string,
		via?: DeliveryChannel,
	): Promise<Notice[]>;
};

const toNotice = (
	row: NoticeRow & { source_label: string | null },
): Notice => ({
	id: row.id,
	seq: row.seq,
	...(row.repo_id !== null ? { repoId: row.repo_id } : {}),
	...(row.lane_id !== null ? { laneId: row.lane_id } : {}),
	source: row.source,
	...(row.source_label !== null ? { sourceLabel: row.source_label } : {}),
	kind: row.kind as Notice["kind"],
	severity: row.severity,
	text: row.text,
	...(row.data_json !== null ? { data: JSON.parse(row.data_json) } : {}),
	createdAt: row.created_at,
	...(row.delivered_at !== null ? { deliveredAt: row.delivered_at } : {}),
	...(row.delivered_via !== null
		? { deliveredVia: row.delivered_via as DeliveryChannel }
		: {}),
	...(row.acked_at !== null ? { ackedAt: row.acked_at } : {}),
});

const optionalRepo = (repoId: string | undefined): string | undefined => {
	if (repoId === undefined) return undefined;
	if (!UlidSchema.safeParse(repoId).success) throw invalid("repoId");
	return repoId;
};

const clampInt = (value: unknown, min: number, max: number, def: number) => {
	if (value === undefined) return def;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw invalid("expected a number");
	}
	return Math.min(max, Math.max(min, Math.trunc(value)));
};

/** `inbox:<principal>` → principal, else null. */
export const principalFromName = (name: string | undefined): string | null => {
	if (name === undefined || !name.startsWith("inbox:")) return null;
	const principal = name.slice("inbox:".length);
	return isPrincipalId(principal) ? principal : null;
};

type Waiter = {
	readonly repoId?: string;
	readonly wake: () => void;
};

export const createInboxModule = (
	options: InboxOptions = {},
): DoModule<InboxApi, InboxInternal, Env, Record<string, never>> => ({
	name: "inbox",
	range: MIGRATION_RANGES.inbox.inbox,
	migrations: INBOX_MIGRATIONS,
	create: (deps) => {
		const sql = deps.sql as unknown as SqlExec;
		const transact = <T>(fn: () => T): T =>
			deps.ctx.storage.transactionSync(fn);
		const principal = principalFromName(deps.ctx.id.name);
		const flushPort = (options.flush ?? repoPresenceFlush)(deps.env);
		const reportOnce = createReportOnce(
			options.log ??
				((message, data) =>
					console.error(`[tartan] inbox: ${message}`, JSON.stringify(data))),
		);
		const waiters = new Set<Waiter>();

		const repoClause = (repoId: string | undefined) =>
			repoId === undefined
				? { sql: "", args: [] as string[] }
				: { sql: " AND (repo_id = ? OR repo_id IS NULL)", args: [repoId] };

		const deliver: InboxApi["deliver"] = (notice) =>
			settle(() => {
				const { source, sourceLabel, ...rest } = notice ?? {};
				const parsed = NoticeInputSchema.safeParse(rest);
				if (!parsed.success) throw invalid("invalid notice");
				if (typeof source !== "string" || source.length === 0) {
					throw invalid("notice source");
				}
				const n: NoticeInput = parsed.data;
				const dataJson = n.data === undefined ? null : JSON.stringify(n.data);
				if (dataJson !== null && byteLength(dataJson) > NOTICE_DATA_MAX_BYTES) {
					throw tartanError(
						"payload_too_large",
						`notice data exceeds ${NOTICE_DATA_MAX_BYTES} bytes`,
					);
				}
				const result = transact(() => {
					if (n.dedupeKey !== undefined) {
						const existing = first(
							sql.exec<{ id: string }>(
								"SELECT id FROM notices WHERE dedupe_key = ?",
								n.dedupeKey,
							),
						);
						if (existing) return { id: existing.id, created: false };
					}
					const id = deps.ids.ulid();
					sql.exec(
						`INSERT INTO notices (id, repo_id, lane_id, source, source_label, kind, severity, text, data_json, dedupe_key, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						id,
						n.repoId ?? null,
						n.laneId ?? null,
						stripControl(source).slice(0, 128),
						sourceLabel === undefined
							? null
							: stripControl(String(sourceLabel)).slice(0, 64),
						n.kind,
						n.severity,
						sanitizeNoticeText(n.text),
						dataJson,
						n.dedupeKey ?? null,
						deps.clock.now(),
					);
					return { id, created: true };
				});
				if (result.created) {
					for (const waiter of [...waiters]) {
						if (
							waiter.repoId === undefined || n.repoId === undefined ||
							waiter.repoId === n.repoId
						) {
							waiter.wake();
						}
					}
				}
				return result;
			});

		const peekSync = (
			limit: number,
			via: DeliveryChannel,
			repoId?: string,
		): Notice[] => {
			if (!CHANNELS.includes(via)) throw invalid("delivery channel");
			const max = clampInt(limit, 1, PEEK_MAX, 10);
			const repo = repoClause(optionalRepo(repoId));
			return transact(() => {
				const rows = sql.exec<NoticeRow & { source_label: string | null }>(
					`SELECT * FROM notices WHERE delivered_at IS NULL AND acked_at IS NULL${repo.sql}
ORDER BY ${SEVERITY_ORDER}, seq LIMIT ?`,
					...repo.args,
					max,
				).toArray();
				if (rows.length === 0) return [];
				const now = deps.clock.now();
				sql.exec(
					"UPDATE notices SET delivered_at = ?, delivered_via = ? WHERE id IN (SELECT value FROM json_each(?))",
					now,
					via,
					jsonList(rows.map((r) => r.id)),
				);
				return selectNotices(
					rows.map((r) =>
						toNotice({ ...r, delivered_at: now, delivered_via: via })
					),
					max,
				);
			});
		};

		const wait: InboxApi["wait"] = async (timeoutMs, repoId, via = "mcp") => {
			const ms = clampInt(timeoutMs, 0, INBOX_WAIT_MAX_MS, INBOX_WAIT_MAX_MS);
			const repo = optionalRepo(repoId);
			const now = peekSync(10, via, repo);
			if (now.length > 0 || ms === 0) return now;
			await new Promise<void>((resolve) => {
				const waiter: Waiter = {
					...(repo !== undefined ? { repoId: repo } : {}),
					wake: () => {
						waiters.delete(waiter);
						clearTimeout(timer);
						resolve();
					},
				};
				const timer = setTimeout(waiter.wake, ms);
				waiters.add(waiter);
			});
			return peekSync(10, via, repo);
		};

		const lastFlushAt = (): number =>
			Number(
				first(
					sql.exec<{ v: string }>(
						"SELECT v FROM meta WHERE k = 'presence_flushed_at'",
					),
				)?.v ?? 0,
			);

		const touch: InboxApi["touch"] = (input) =>
			settle(() => {
				const repoId = optionalRepo(input?.repoId);
				if (repoId === undefined) throw invalid("repoId");
				if (
					input.laneId !== undefined &&
					!LaneIdSchema.safeParse(input.laneId).success
				) throw invalid("laneId");
				if (!Number.isInteger(input.at) || input.at < 0) throw invalid("at");
				const status = input.status === undefined
					? null
					: stripControl(String(input.status)).slice(0, 64);
				transact(() => {
					sql.exec(
						`INSERT INTO presence (repo_id, lane_id, status, last_seen_at) VALUES (?, ?, ?, ?)
ON CONFLICT (repo_id) DO UPDATE SET lane_id = excluded.lane_id,
  status = COALESCE(excluded.status, presence.status),
  last_seen_at = MAX(presence.last_seen_at, excluded.last_seen_at)`,
						repoId,
						input.laneId ?? null,
						status,
						input.at,
					);
					if (deps.timers.get(FLUSH_TIMER_KEY) === null) {
						deps.timers.schedule(
							FLUSH_TIMER_KEY,
							Math.max(
								deps.clock.now(),
								lastFlushAt() + PRESENCE_FLUSH_MS,
							),
						);
					}
				});
			});

		/** The `flush` timer: changed presence rows → each repo's RepoDO. */
		const flush = async (): Promise<void> => {
			if (principal === null) return;
			const rows = sql.exec<PresenceRow>(
				"SELECT * FROM presence WHERE flushed_at IS NULL OR last_seen_at > flushed_at",
			).toArray();
			if (rows.length === 0) return;
			const failures: unknown[] = [];
			for (const row of rows) {
				const entry: PresenceEntry = {
					principal,
					...(row.lane_id !== null ? { laneId: row.lane_id } : {}),
					status: row.status ?? "active",
					at: row.last_seen_at,
				};
				try {
					await flushPort(row.repo_id, [entry]);
					sql.exec(
						"UPDATE presence SET flushed_at = MAX(COALESCE(flushed_at, 0), ?) WHERE repo_id = ?",
						row.last_seen_at,
						row.repo_id,
					);
				} catch (error) {
					reportOnce("presence flush failed", error);
					failures.push(error);
				}
			}
			sql.exec(
				"INSERT INTO meta (k, v) VALUES ('presence_flushed_at', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
				String(deps.clock.now()),
			);
			// A failure keeps its rows dirty; the multiplexer retries with backoff.
			if (failures.length > 0) throw failures[0];
			// A touch that landed during the flush is sent a minute later.
			const dirty = first(
				sql.exec<{ n: number }>(
					"SELECT COUNT(*) AS n FROM presence WHERE flushed_at IS NULL OR last_seen_at > flushed_at",
				),
			)?.n ?? 0;
			if (dirty > 0) {
				deps.timers.schedule(
					FLUSH_TIMER_KEY,
					deps.clock.now() + PRESENCE_FLUSH_MS,
				);
			}
		};

		const facade: InboxApi = {
			deliver,
			peek: (limit, via, repoId) => settle(() => peekSync(limit, via, repoId)),
			read: (query) =>
				settle(() => {
					const since = clampInt(query?.since, 0, Number.MAX_SAFE_INTEGER, 0);
					const limit = clampInt(query?.limit, 1, READ_MAX, READ_DEFAULT);
					const repo = repoClause(optionalRepo(query?.repoId));
					return sql.exec<NoticeRow & { source_label: string | null }>(
						`SELECT * FROM notices WHERE seq > ?${repo.sql} ORDER BY seq LIMIT ?`,
						since,
						...repo.args,
						limit,
					).toArray().map(toNotice);
				}),
			ack: (ids) =>
				settle(() => {
					if (
						!Array.isArray(ids) || ids.length > ACK_MAX ||
						ids.some((id) => typeof id !== "string")
					) throw invalid(`ack takes at most ${ACK_MAX} ids`);
					if (ids.length === 0) return { acked: 0 };
					const now = deps.clock.now();
					return transact(() => {
						const targets = sql.exec<{ id: string }>(
							"SELECT id FROM notices WHERE acked_at IS NULL AND id IN (SELECT value FROM json_each(?))",
							jsonList(ids),
						).toArray().map((r) => r.id);
						if (targets.length > 0) {
							sql.exec(
								`UPDATE notices SET acked_at = ?, delivered_at = COALESCE(delivered_at, ?),
  delivered_via = COALESCE(delivered_via, 'api')
WHERE id IN (SELECT value FROM json_each(?))`,
								now,
								now,
								jsonList(targets),
							);
						}
						return { acked: targets.length };
					});
				}),
			wait,
			unreadCount: () =>
				settle(() =>
					first(
						sql.exec<{ n: number }>(
							"SELECT COUNT(*) AS n FROM notices WHERE delivered_at IS NULL AND acked_at IS NULL",
						),
					)?.n ?? 0
				),
			touch,
			presence: (repoId) =>
				settle((): Presence | null => {
					const repo = optionalRepo(repoId);
					if (repo === undefined || principal === null) return null;
					const row = first(
						sql.exec<PresenceRow>(
							"SELECT * FROM presence WHERE repo_id = ?",
							repo,
						),
					);
					return row === null ? null : {
						principal,
						...(row.lane_id !== null ? { laneId: row.lane_id } : {}),
						status: row.status ?? "active",
						lastSeenAt: row.last_seen_at,
					};
				}),
		};

		return {
			facade,
			internal: {},
			onTimer: async (key) => {
				if (key === FLUSH_TIMER_KEY) await flush();
			},
		};
	},
});

export const inboxModule = createInboxModule();
