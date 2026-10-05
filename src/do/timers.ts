// One alarm, many modules. A DO has exactly one
// alarm and one `alarm()` method, so no module calls `setAlarm`: modules use
// `TimersApi` (`schedule`/`cancel`/`get`, synchronous so they can run inside
// `transactionSync`) and register one `onTimer(key)` handler each.
//
// Rows live in `_timers(module, key, at, attempts)`; the DO alarm is kept at
// `MIN(at)`. `runDue` drains due rows in `at` order and dispatches each to its
// module inside a per-module try/catch: success deletes the row (unless the
// handler rescheduled it), a throw reschedules that row alone with backoff
// (1 s doubling to 10 min) and never stops or retries another module's work.
// `runDue` never throws for a handler failure, so the platform never retries
// the whole alarm.
//
// ForgeDO and RepoDO use this through `createDoHost`; ExtensionDO (host and
// extension timers) uses it directly with its own handler table. ExtensionDO is
// the only other user: TartanSandbox must never import it, because the
// container library owns that class's alarm and its watchdog runs on
// `Container.schedule()` (checked by `src/do/sandbox.test.ts`).

import {
	type Clock,
	COMMON_DDL,
	type ModuleTimersApi,
	timerBackoffMs,
	type TimerHandler,
	type TimerRow,
	type TimersApi,
} from "@tartan/contract/kernel.ts";

export type TimersDeps = {
	readonly storage: Pick<
		DurableObjectStorage,
		"sql" | "getAlarm" | "setAlarm" | "deleteAlarm"
	>;
	readonly clock: Clock;
	/** Known module names; `schedule` rejects any other name. Omit to allow any. */
	readonly modules?: readonly string[];
	readonly log?: (message: string, data: Record<string, unknown>) => void;
};

export type TimerOutcome = {
	readonly module: string;
	readonly key: string;
	readonly at: number;
	readonly ok: boolean;
	/** Set when the handler threw (or no handler exists): the backoff time. */
	readonly retryAt?: number;
	readonly error?: string;
};

export type Timers = TimersApi & {
	/** Reads the current alarm into the in-memory cache; call once from `blockConcurrencyWhile`. */
	init(): Promise<void>;
	/** Earliest pending `at`, or null when no timer is pending. */
	next(): number | null;
	/** Drains due timers (the body of `alarm()`). */
	runDue(
		handlers: Readonly<Record<string, TimerHandler | undefined>>,
	): Promise<TimerOutcome[]>;
	/** Re-points the DO alarm at `MIN(at)` (or deletes it). */
	syncAlarm(): void;
};

/** The timers API bound to one module's name (`deps.timers`). */
export const bindTimers = (
	timers: TimersApi,
	module: string,
): ModuleTimersApi => ({
	schedule: (key, atMs) => timers.schedule(module, key, atMs),
	cancel: (key) => timers.cancel(module, key),
	get: (key) => timers.get(module, key),
});

/** Creates `_timers` if missing (for DOs that do not run the common migrations). */
export const ensureTimersTable = (sql: SqlStorage): void => {
	sql.exec(COMMON_DDL.timers);
};

const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const defaultLog = (message: string, data: Record<string, unknown>): void =>
	console.error(`[tartan] ${message}`, JSON.stringify(data));

export const createTimers = (deps: TimersDeps): Timers => {
	const { storage, clock } = deps;
	const sql = storage.sql;
	const log = deps.log ?? defaultLog;
	const known = deps.modules ? new Set(deps.modules) : null;
	// undefined = unknown (always write); null = no alarm set.
	let alarmAt: number | null | undefined = undefined;

	const checkModule = (module: string): void => {
		if (known !== null && !known.has(module)) {
			throw new Error(`timers: unknown module "${module}"`);
		}
	};

	const next = (): number | null =>
		sql.exec<{ at: number | null }>("SELECT MIN(at) AS at FROM _timers")
			.one().at;

	const syncAlarm = (): void => {
		const at = next();
		if (at === alarmAt) return;
		alarmAt = at;
		const write = at === null ? storage.deleteAlarm() : storage.setAlarm(at);
		write.catch((error: unknown) => {
			alarmAt = undefined;
			log("timers: alarm update failed", { at, error: errorText(error) });
		});
	};

	const schedule = (module: string, key: string, atMs: number): void => {
		checkModule(module);
		if (!Number.isFinite(atMs)) {
			throw new Error(`timers: invalid time for ${module}/${key}`);
		}
		sql.exec(
			`INSERT INTO _timers (module, key, at, attempts) VALUES (?, ?, ?, 0)
			 ON CONFLICT (module, key) DO UPDATE SET at = excluded.at, attempts = 0`,
			module,
			key,
			Math.floor(atMs),
		);
		syncAlarm();
	};

	const cancel = (module: string, key: string): void => {
		checkModule(module);
		sql.exec("DELETE FROM _timers WHERE module = ? AND key = ?", module, key);
		syncAlarm();
	};

	const get = (module: string, key: string): number | null =>
		sql.exec<{ at: number }>(
			"SELECT at FROM _timers WHERE module = ? AND key = ?",
			module,
			key,
		).toArray()[0]?.at ?? null;

	const init = async (): Promise<void> => {
		alarmAt = await storage.getAlarm();
		syncAlarm();
	};

	const runDue = async (
		handlers: Readonly<Record<string, TimerHandler | undefined>>,
	): Promise<TimerOutcome[]> => {
		// The platform consumed the alarm that invoked us.
		alarmAt = null;
		const now = clock.now();
		const due = sql.exec<TimerRow>(
			"SELECT module, key, at, attempts FROM _timers WHERE at <= ? ORDER BY at, module, key",
			now,
		).toArray();
		const outcomes: TimerOutcome[] = [];
		for (const row of due) {
			const unchanged = [row.module, row.key, row.at, row.attempts] as const;
			try {
				const handler = handlers[row.module];
				if (handler === undefined) {
					throw new Error(`no timer handler for module "${row.module}"`);
				}
				await handler(row.key);
				// Keep the row if the handler rescheduled it.
				sql.exec(
					"DELETE FROM _timers WHERE module = ? AND key = ? AND at = ? AND attempts = ?",
					...unchanged,
				);
				outcomes.push({
					module: row.module,
					key: row.key,
					at: row.at,
					ok: true,
				});
			} catch (error) {
				const retryAt = clock.now() + timerBackoffMs(row.attempts + 1);
				sql.exec(
					`UPDATE _timers SET at = ?, attempts = attempts + 1
					 WHERE module = ? AND key = ? AND at = ? AND attempts = ?`,
					retryAt,
					...unchanged,
				);
				const message = errorText(error);
				log("timer handler failed", {
					module: row.module,
					key: row.key,
					attempts: row.attempts + 1,
					retryAt,
					error: message,
				});
				outcomes.push({
					module: row.module,
					key: row.key,
					at: row.at,
					ok: false,
					retryAt,
					error: message,
				});
			}
		}
		syncAlarm();
		return outcomes;
	};

	return { schedule, cancel, get, init, next, runDue, syncAlarm };
};
