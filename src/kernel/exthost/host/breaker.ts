// The per-installation circuit breaker and write-ahead call markers. It applies
// to isolated runtimes (js/wasm), whose code is untrusted and whose CPU limits
// are not reliable; the host asks the runtime (`Runtime.isolated`), so builtins
// never strike.
//
// - A strike is a host wall-clock timeout, an RPC rejection that says the
//   facet exceeded its CPU, hung or was reset, or a stale `_inflight` marker:
//   a call that started more than `budget_ms` + 5 s ago and never settled,
//   because the host's own invocation died with the facet (the only trace a
//   synchronous runaway leaves). Markers are inserted and `storage.sync()`ed
//   before the facet call and deleted when it settles; every host entry and
//   alarm converts stale ones before anything else runs.
// - `BREAKER.strikes` strikes within `windowMs` open the breaker for
//   `cooldownMs`. After it, the breaker is half-open: one call is let
//   through; success closes it, a strike reopens it with a doubled cooldown
//   (at most `maxCooldownMs`). Strikes are kept 24 h.
//
// State lives in `_host` (`breaker`, `breaker_until`, `breaker_trips`) and
// `_strikes`, so it survives the host dying.

import type {
	BreakerStatus,
	BreakerView,
	StrikeRow,
} from "@tartan/contract/kernel.ts";
import { BREAKER, type Clock } from "@tartan/contract/kernel.ts";
import type { SqlTarget } from "@tartan/ext-api/sqlguard.ts";

export type { BreakerView };
export type BreakerState = BreakerView["state"];
export type StrikeKind = StrikeRow["kind"];

/** How many strikes `status()` lists. */
export const STATUS_STRIKES = 20;

export type Admission =
	| { readonly ok: true; readonly probe: boolean }
	| { readonly ok: false; readonly until: number };

/** Grace beyond a call's budget before its marker counts as a reset. */
export const INFLIGHT_GRACE_MS = 5000;
export const STRIKE_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Error texts that classify a facet RPC rejection as a strike. A
 * workerd "internal error; reference = …" from a facet call is a platform
 * failure of the facet, counted as a reset.
 */
export const strikeKindOf = (error: unknown): StrikeKind | null => {
	const text = error instanceof Error ? error.message : String(error);
	if (/exceeded cpu time limit/i.test(text)) return "cpu";
	if (/code had hung/i.test(text)) return "hung";
	if (
		/durable object (?:was )?reset|has been reset|object reset/i.test(text) ||
		/internal error; reference = /i.test(text)
	) {
		return "reset";
	}
	return null;
};

export type Breaker = {
	view(): BreakerView;
	/** The view, the strikes in the current window and the latest strikes. */
	status(): BreakerStatus;
	/** May a call run now? A half-open breaker admits one probe at a time. */
	admit(): Admission;
	/** Records a strike; returns the view after it and whether it just opened. */
	strike(
		method: string,
		kind: StrikeKind,
	): { readonly view: BreakerView; readonly opened: boolean };
	/** A probe (or any call while half-open) succeeded: close. */
	succeeded(): void;
	/** The probe ended without a strike or a success: let the next call probe. */
	released(): void;
	/** Write-ahead marker of an isolated call (insert; the caller awaits `sync`). */
	markInflight(callId: string, method: string, budgetMs: number): void;
	clearInflight(callId: string): void;
	/** Converts stale markers (not in `live`) into `reset` strikes; returns how many. */
	convertStale(live: ReadonlySet<string>): number;
	/** Owner reset: closed, strikes cleared. */
	reset(): void;
};

export const createBreaker = (
	storage: SqlTarget,
	clock: Clock,
	onOpen: (view: BreakerView, strikes: number) => void,
): Breaker => {
	const sql = storage.sql;
	let probing = false;

	const get = (k: string): string | null =>
		sql.exec<{ v: string }>("SELECT v FROM _host WHERE k = ?", k).toArray()[0]
			?.v ?? null;
	const set = (k: string, v: string): void => {
		sql.exec(
			"INSERT INTO _host (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
			k,
			v,
		);
	};

	const view = (): BreakerView => {
		const state = (get("breaker") ?? "closed") as BreakerState;
		const until = get("breaker_until");
		return {
			state,
			// A closed breaker stores "" (`write`), which is no deadline.
			until: until === null || until === "" ? null : Number(until),
			trips: Number(get("breaker_trips") ?? "0"),
		};
	};

	const write = (v: BreakerView): void => {
		set("breaker", v.state);
		set("breaker_until", v.until === null ? "" : String(v.until));
		set("breaker_trips", String(v.trips));
	};

	const close = (): void => {
		storage.transactionSync(() => {
			write({ state: "closed", until: null, trips: 0 });
			sql.exec("DELETE FROM _strikes");
		});
		probing = false;
	};

	const open = (trips: number, now: number): BreakerView => {
		const cooldown = Math.min(
			BREAKER.maxCooldownMs,
			BREAKER.cooldownMs * 2 ** Math.max(0, trips - 1),
		);
		const next: BreakerView = { state: "open", until: now + cooldown, trips };
		write(next);
		probing = false;
		return next;
	};

	const strike = (method: string, kind: StrikeKind) => {
		const now = clock.now();
		return storage.transactionSync(() => {
			sql.exec(
				"INSERT INTO _strikes (at, method, kind) VALUES (?, ?, ?)",
				now,
				method,
				kind,
			);
			sql.exec("DELETE FROM _strikes WHERE at < ?", now - STRIKE_RETENTION_MS);
			const current = view();
			if (current.state === "half-open") {
				return { view: open(current.trips + 1, now), opened: true };
			}
			if (current.state === "open") return { view: current, opened: false };
			const recent = sql.exec<{ n: number }>(
				"SELECT COUNT(*) AS n FROM _strikes WHERE at >= ?",
				now - BREAKER.windowMs,
			).one().n;
			if (recent >= BREAKER.strikes) {
				return { view: open(1, now), opened: true };
			}
			return { view: current, opened: false };
		});
	};

	const report = (outcome: { view: BreakerView; opened: boolean }) => {
		if (outcome.opened) {
			const n = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM _strikes")
				.one().n;
			onOpen(outcome.view, n);
		}
		return outcome;
	};

	const status = (): BreakerStatus => ({
		...view(),
		recentStrikes: sql.exec<{ n: number }>(
			"SELECT COUNT(*) AS n FROM _strikes WHERE at >= ?",
			clock.now() - BREAKER.windowMs,
		).one().n,
		strikes: sql.exec<StrikeRow>(
			"SELECT seq, at, method, kind FROM _strikes ORDER BY seq DESC LIMIT ?",
			STATUS_STRIKES,
		).toArray(),
	});

	return {
		view,
		status,
		admit: () => {
			const current = view();
			if (current.state === "closed") return { ok: true, probe: false };
			const now = clock.now();
			if (
				current.state === "open" && current.until !== null &&
				now < current.until
			) {
				return { ok: false, until: current.until };
			}
			if (current.state === "open") {
				write({ ...current, state: "half-open" });
			}
			if (probing) return { ok: false, until: now + 1000 };
			probing = true;
			return { ok: true, probe: true };
		},
		strike: (method, kind) => report(strike(method, kind)),
		succeeded: () => {
			if (view().state !== "closed") close();
			probing = false;
		},
		released: () => {
			probing = false;
		},
		markInflight: (callId, method, budgetMs) => {
			sql.exec(
				"INSERT INTO _inflight (call_id, method, started_at, budget_ms) VALUES (?, ?, ?, ?)",
				callId,
				method,
				clock.now(),
				budgetMs,
			);
		},
		clearInflight: (callId) => {
			sql.exec("DELETE FROM _inflight WHERE call_id = ?", callId);
		},
		convertStale: (live) => {
			const now = clock.now();
			const stale = sql.exec<
				{ call_id: string; method: string }
			>(
				"SELECT call_id, method FROM _inflight WHERE started_at + budget_ms + ? < ? ORDER BY started_at",
				INFLIGHT_GRACE_MS,
				now,
			).toArray().filter((row) => !live.has(row.call_id));
			for (const row of stale) {
				storage.transactionSync(() => {
					sql.exec("DELETE FROM _inflight WHERE call_id = ?", row.call_id);
				});
				report(strike(row.method, "reset"));
			}
			return stale.length;
		},
		reset: close,
	};
};
