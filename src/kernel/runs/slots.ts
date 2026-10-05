// ForgeDO `slots` module (WP9, migrations 450–499): the forge-wide job-slot
// semaphore and daily container usage.
//
// RunWorkflow acquires one slot per run (one sandbox per run) before its
// sandbox starts, so concurrent job sandboxes stay below the container
// `max_instances`. A full semaphore answers `{wait, retryAfterMs}` and the
// workflow sleeps (`slot-wait-<i>`), which uses no Workflow concurrency.
// Each slot is a lease: the `slots` timer fires at its expiry and, if the
// lease was not renewed or released, destroys the run's sandbox before it
// frees the slot (a leaked `keepAlive` container would otherwise hold a
// container slot forever).
//
// The daily budget (`usage_daily`, `budgetExceeded`) is recorded here; the
// decision to pause lane CI on it is `tartan.ci`'s (M2 cost controls).

import {
	DAILY_CONTAINER_BUDGET_VCPU_MIN,
	invalid,
	JOB_SLOT_DEFAULTS,
	jobSandboxName,
} from "@tartan/contract";
import {
	type DoModule,
	type ForgeInternals,
	type JobSlotRow,
	type JobSlotsFacade,
	type JobSlotsInternal,
	type Migration,
	MIGRATION_RANGES,
	type UsageDailyRow,
} from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";

export const SLOTS_MIGRATIONS: readonly Migration[] = [
	{
		n: 450,
		name: "job_slots",
		sql: `CREATE TABLE job_slots (slot_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('ci','git','agent')),
  run_id TEXT NOT NULL, acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX job_slots_expiry ON job_slots(expires_at)`,
	},
	{
		n: 451,
		name: "usage_daily",
		sql: `CREATE TABLE usage_daily (day TEXT NOT NULL, kind TEXT NOT NULL,
  container_ms INTEGER NOT NULL DEFAULT 0, runs INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind))`,
	},
];

export type SlotKind = JobSlotRow["kind"];
const SLOT_KINDS: readonly SlotKind[] = ["ci", "git", "agent"];

/** `_timers` key prefix of the slot expiry timer (`FORGE_TIMERS.slots`). */
export const SLOT_TIMER_PREFIX = "slots:";
export const slotKeyOf = (kind: SlotKind, runId: string): string =>
	`${kind}:${runId}`;

export const SLOT_TTL_MIN_MS = 60_000;
export const SLOT_TTL_MAX_MS = 3 * 60 * 60 * 1000;
/** A full semaphore asks the caller to retry within these bounds. */
export const SLOT_RETRY_MIN_MS = 5_000;
export const SLOT_RETRY_MAX_MS = 30_000;

export type SlotCaps = Readonly<Record<"total" | SlotKind, number>>;

/** Side effects outside ForgeDO, injectable for tests. */
export type SlotsEffects = {
	/** Destroys the sandbox of an expired run (`job:<runId>`). */
	stopSandbox(runId: string): Promise<void>;
};

export const envSlotsEffects = (env: Env): SlotsEffects => ({
	stopSandbox: async (runId) => {
		await env.SANDBOX.getByName(jobSandboxName(runId)).stopRun();
	},
});

export type JobSlotsModuleOptions = {
	readonly caps?: SlotCaps;
	readonly effects?: (env: Env) => SlotsEffects;
	readonly budgetMs?: number;
};

/** UTC day of an epoch-ms time (`usage_daily.day`). */
export const usageDay = (at: number): string =>
	new Date(at).toISOString().slice(0, 10);

/** Wraps each method so a synchronous throw becomes a rejected promise. */
export const rejectingThrows = <F extends object>(facade: F): F =>
	Object.fromEntries(
		Object.entries(facade).map(([name, fn]) => [
			name,
			(...args: unknown[]) => {
				try {
					return (fn as (...a: unknown[]) => unknown)(...args);
				} catch (error) {
					return Promise.reject(error);
				}
			},
		]),
	) as F;

const clamp = (value: number, min: number, max: number): number =>
	Math.min(max, Math.max(min, value));

export const createJobSlotsModule = (
	options: JobSlotsModuleOptions = {},
): DoModule<JobSlotsFacade, JobSlotsInternal, Env, ForgeInternals> => ({
	name: "slots",
	range: MIGRATION_RANGES.forge.slots,
	migrations: SLOTS_MIGRATIONS,
	create: ({ sql, ctx, env, clock, timers }) => {
		const caps = options.caps ?? JOB_SLOT_DEFAULTS;
		const effects = (options.effects ?? envSlotsEffects)(env);
		const budgetMs = options.budgetMs ??
			DAILY_CONTAINER_BUDGET_VCPU_MIN * 60_000;

		const requireKind = (kind: string): SlotKind => {
			if (!(SLOT_KINDS as readonly string[]).includes(kind)) {
				throw invalid(`unknown slot kind ${kind}`);
			}
			return kind as SlotKind;
		};
		const slotSync = (slotKey: string): JobSlotRow | null =>
			sql.exec<JobSlotRow>(
				"SELECT * FROM job_slots WHERE slot_key = ?",
				slotKey,
			).toArray()[0] ?? null;

		// Synchronous throws become rejections, as over RPC.
		const facade: JobSlotsFacade = rejectingThrows({
			acquire: (rawKind, runId, ttlMs) => {
				const kind = requireKind(rawKind);
				if (typeof runId !== "string" || runId === "" || runId.length > 64) {
					throw invalid("runId required");
				}
				const now = clock.now();
				const ttl = clamp(
					Number.isFinite(ttlMs) ? ttlMs : SLOT_TTL_MIN_MS,
					SLOT_TTL_MIN_MS,
					SLOT_TTL_MAX_MS,
				);
				const slotKey = slotKeyOf(kind, runId);
				const result = ctx.storage.transactionSync(() => {
					if (slotSync(slotKey) !== null) {
						// Idempotent re-acquire renews the lease.
						sql.exec(
							"UPDATE job_slots SET expires_at = ? WHERE slot_key = ?",
							now + ttl,
							slotKey,
						);
						timers.schedule(`${SLOT_TIMER_PREFIX}${slotKey}`, now + ttl);
						return { slotKey };
					}
					const active = sql.exec<{ kind: SlotKind; n: number }>(
						"SELECT kind, COUNT(*) AS n FROM job_slots WHERE expires_at > ? GROUP BY kind",
						now,
					).toArray();
					const total = active.reduce((sum, row) => sum + row.n, 0);
					const ofKind = active.find((row) => row.kind === kind)?.n ?? 0;
					if (total >= caps.total || ofKind >= caps[kind]) {
						const next = sql.exec<{ at: number | null }>(
							"SELECT MIN(expires_at) AS at FROM job_slots WHERE expires_at > ?",
							now,
						).one().at;
						return {
							wait: true as const,
							retryAfterMs: clamp(
								(next ?? now + SLOT_RETRY_MAX_MS) - now,
								SLOT_RETRY_MIN_MS,
								SLOT_RETRY_MAX_MS,
							),
						};
					}
					sql.exec(
						"INSERT INTO job_slots (slot_key, kind, run_id, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?)",
						slotKey,
						kind,
						runId,
						now,
						now + ttl,
					);
					timers.schedule(`${SLOT_TIMER_PREFIX}${slotKey}`, now + ttl);
					return { slotKey };
				});
				return Promise.resolve(result);
			},

			release: (slotKey) => {
				ctx.storage.transactionSync(() => {
					sql.exec("DELETE FROM job_slots WHERE slot_key = ?", slotKey);
					timers.cancel(`${SLOT_TIMER_PREFIX}${slotKey}`);
				});
				return Promise.resolve();
			},

			recordUsage: (kind, containerMs) => {
				if (!Number.isFinite(containerMs) || containerMs < 0) {
					throw invalid("containerMs must be a non-negative number");
				}
				sql.exec(
					`INSERT INTO usage_daily (day, kind, container_ms, runs) VALUES (?, ?, ?, 1)
					 ON CONFLICT (day, kind) DO UPDATE SET
					 container_ms = container_ms + excluded.container_ms, runs = runs + 1`,
					usageDay(clock.now()),
					requireKind(kind),
					Math.round(containerMs),
				);
				return Promise.resolve();
			},

			usage: (day) => {
				if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
					throw invalid("day is YYYY-MM-DD");
				}
				return Promise.resolve(
					sql.exec<UsageDailyRow>(
						"SELECT * FROM usage_daily WHERE day = ? ORDER BY kind",
						day,
					).toArray(),
				);
			},

			budgetExceeded: (kind) => {
				requireKind(kind);
				const used = sql.exec<{ ms: number | null }>(
					"SELECT SUM(container_ms) AS ms FROM usage_daily WHERE day = ?",
					usageDay(clock.now()),
				).one().ms ?? 0;
				return Promise.resolve(used >= budgetMs);
			},
		});

		/** Slot expiry: destroy the run's sandbox first, then free the slot. */
		const onTimer = async (key: string): Promise<void> => {
			if (!key.startsWith(SLOT_TIMER_PREFIX)) return;
			const slotKey = key.slice(SLOT_TIMER_PREFIX.length);
			const slot = slotSync(slotKey);
			if (slot === null) return;
			const now = clock.now();
			if (slot.expires_at > now) {
				timers.schedule(key, slot.expires_at);
				return;
			}
			await effects.stopSandbox(slot.run_id);
			ctx.storage.transactionSync(() => {
				const current = slotSync(slotKey);
				if (current !== null && current.expires_at <= now) {
					sql.exec("DELETE FROM job_slots WHERE slot_key = ?", slotKey);
				}
			});
		};

		return { facade, internal: {}, onTimer };
	},
});

export const jobSlotsModule = createJobSlotsModule();
