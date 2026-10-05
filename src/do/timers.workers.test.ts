/// <reference types="@cloudflare/vitest-pool-workers/types" />
// The `_timers` alarm multiplexer: two modules schedule, one throws, the other
// still runs, and the DO alarm always equals the minimum pending `at`. Also the
// wiring of the real RepoDO.alarm() through the host.

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
	type DoModule,
	type ModuleTimersApi,
	timerBackoffMs,
} from "@tartan/contract/kernel.ts";
import { describe, expect, it } from "vitest";
import { testEnv as env, uniqueName } from "../../test/env.ts";
import type { Env } from "../env.ts";
import { createDoHost } from "./host.ts";
import { COMMON_MIGRATIONS } from "./migrations.ts";

type Row = { module: string; key: string; at: number; attempts: number };

const rows = (sql: SqlStorage): Row[] =>
	sql.exec<Row>(
		"SELECT module, key, at, attempts FROM _timers ORDER BY module, key",
	)
		.toArray();

/** A module that records timer keys, optionally throwing, optionally rescheduling. */
const timerModule = (
	name: string,
	range: readonly [number, number],
	behaviour: {
		readonly seen: string[];
		readonly fail?: boolean;
		readonly reschedule?: (timers: ModuleTimersApi, key: string) => void;
	},
): DoModule<{ readonly timers: ModuleTimersApi }, object, Env> => ({
	name,
	range,
	migrations: [],
	create: ({ timers }) => ({
		facade: { timers },
		internal: {},
		onTimer: (key) => {
			behaviour.seen.push(key);
			behaviour.reschedule?.(timers, key);
			if (behaviour.fail) throw new Error(`${name} handler failed on ${key}`);
		},
	}),
});

describe("timer multiplexer", () => {
	it("two modules schedule; one throws, the other still runs; alarm = min(at)", async () => {
		const stub = env.REPO.getByName(uniqueName("test-timers"));
		await runInDurableObject(stub, async (_instance, state) => {
			// A fake clock well in the future of real time, so the real alarm
			// (set from these times) never fires during the test.
			const base = Date.now() + 60 * 60 * 1000;
			let now = base;
			const clock = { now: () => now };
			const okSeen: string[] = [];
			const failSeen: string[] = [];
			const host = createDoHost({
				kind: "test",
				ctx: state,
				env,
				clock,
				modules: {
					ok: timerModule("ok", [100, 199], { seen: okSeen }),
					failing: timerModule("failing", [200, 249], {
						seen: failSeen,
						fail: true,
					}),
				},
				common: [COMMON_MIGRATIONS.base],
				log: () => {},
			});
			await host.ready;
			const { timers } = host;

			// Schedule: failing is due first, so a non-isolated loop would never reach ok.
			timers.schedule("ok", "refill", base + 30_000);
			timers.schedule("failing", "sweep", base + 10_000);
			expect(await state.storage.getAlarm()).toBe(base + 10_000);
			expect(timers.next()).toBe(base + 10_000);

			// Upsert moves a timer; cancel removes it; the alarm follows MIN(at).
			timers.schedule("ok", "extra", base + 5_000);
			expect(await state.storage.getAlarm()).toBe(base + 5_000);
			timers.schedule("ok", "extra", base + 1_000);
			expect(timers.get("ok", "extra")).toBe(base + 1_000);
			expect(await state.storage.getAlarm()).toBe(base + 1_000);
			timers.cancel("ok", "extra");
			expect(timers.get("ok", "extra")).toBeNull();
			expect(await state.storage.getAlarm()).toBe(base + 10_000);

			// Unknown module names are rejected.
			expect(() => timers.schedule("nope", "k", base)).toThrow(
				/unknown module/,
			);

			// Fire: both due.
			now = base + 60_000;
			const outcomes = await host.alarm();
			expect(okSeen).toEqual(["refill"]);
			expect(failSeen).toEqual(["sweep"]);
			// In `at` order: the throwing module ran first and ok still ran after it.
			expect(outcomes.map(({ module, ok }) => ({ module, ok }))).toEqual([
				{ module: "failing", ok: false },
				{ module: "ok", ok: true },
			]);
			// ok's row is gone; failing's row backs off 1 s with attempts 1.
			expect(rows(state.storage.sql)).toEqual([
				{ module: "failing", key: "sweep", at: now + 1_000, attempts: 1 },
			]);
			expect(await state.storage.getAlarm()).toBe(now + 1_000);

			// Not yet due: nothing runs.
			expect(await host.alarm()).toEqual([]);
			expect(failSeen).toEqual(["sweep"]);

			// Due again: the backoff doubles and the alarm follows it.
			now += 1_000;
			await host.alarm();
			expect(failSeen).toEqual(["sweep", "sweep"]);
			expect(rows(state.storage.sql)).toEqual([
				{ module: "failing", key: "sweep", at: now + 2_000, attempts: 2 },
			]);
			expect(await state.storage.getAlarm()).toBe(now + 2_000);

			// A fresh schedule of the failing key resets its attempts.
			timers.schedule("failing", "sweep", now + 500);
			expect(rows(state.storage.sql)[0]).toMatchObject({ attempts: 0 });

			// No timers left: the alarm is deleted.
			timers.cancel("failing", "sweep");
			expect(await state.storage.getAlarm()).toBeNull();
		});
	});

	it("keeps a row the handler rescheduled instead of deleting it", async () => {
		const stub = env.REPO.getByName(uniqueName("test-timers"));
		await runInDurableObject(stub, async (_instance, state) => {
			const base = Date.now() + 60 * 60 * 1000;
			let now = base;
			const seen: string[] = [];
			const host = createDoHost({
				kind: "test",
				ctx: state,
				env,
				clock: { now: () => now },
				modules: {
					sweeper: timerModule("sweeper", [100, 199], {
						seen,
						// Bound to its own module: no module name to pass.
						reschedule: (timers, key) => timers.schedule(key, now + 60_000),
					}),
				},
				common: [COMMON_MIGRATIONS.base],
				log: () => {},
			});
			await host.ready;
			host.timers.schedule("sweeper", "tick", base + 1_000);
			now = base + 2_000;
			await host.alarm();
			expect(seen).toEqual(["tick"]);
			expect(rows(state.storage.sql)).toEqual([
				{ module: "sweeper", key: "tick", at: now + 60_000, attempts: 0 },
			]);
			expect(await state.storage.getAlarm()).toBe(now + 60_000);
			host.timers.cancel("sweeper", "tick");
		});
	});

	it("schedules inside transactionSync; a rolled-back schedule leaves no row and a harmless alarm", async () => {
		const stub = env.REPO.getByName(uniqueName("test-timers"));
		await runInDurableObject(stub, async (_instance, state) => {
			const base = Date.now() + 60 * 60 * 1000;
			let now = base;
			const seen: string[] = [];
			const host = createDoHost({
				kind: "test",
				ctx: state,
				env,
				clock: { now: () => now },
				modules: { lease: timerModule("lease", [100, 199], { seen }) },
				common: [COMMON_MIGRATIONS.base],
				log: () => {},
			});
			await host.ready;
			state.storage.transactionSync(() => {
				host.timers.schedule("lease", "ln_a", base + 20_000);
			});
			expect(await state.storage.getAlarm()).toBe(base + 20_000);

			expect(() =>
				state.storage.transactionSync(() => {
					host.timers.schedule("lease", "ln_b", base + 5_000);
					throw new Error("abort");
				})
			).toThrow("abort");
			expect(rows(state.storage.sql).map((r) => r.key)).toEqual(["ln_a"]);
			// The alarm may point at the rolled-back time; firing early runs
			// nothing and re-points it at the real minimum.
			now = base + 6_000;
			expect(await host.alarm()).toEqual([]);
			expect(await state.storage.getAlarm()).toBe(base + 20_000);
			expect(seen).toEqual([]);
			host.timers.cancel("lease", "ln_a");
		});
	});

	it("backs off from 1 s, doubling, capped at 10 min", () => {
		expect([1, 2, 3, 4].map(timerBackoffMs)).toEqual([
			1_000,
			2_000,
			4_000,
			8_000,
		]);
		expect(timerBackoffMs(10)).toBe(512_000);
		expect(timerBackoffMs(11)).toBe(600_000);
		expect(timerBackoffMs(50)).toBe(600_000);
	});

	it("RepoDO.alarm() dispatches through the host with per-module isolation", async () => {
		const stub = env.REPO.getByName(uniqueName("test-timers"));
		const due = Date.now() - 1;
		await runInDurableObject(stub, async (_instance, state) => {
			// `land`'s handler throws for a key it does not own (WP10's `k5`,
			// `outbox` and `candidates` are real); `probe` has no handler at
			// all. Neither may stop the other.
			state.storage.sql.exec(
				"INSERT INTO _timers (module, key, at, attempts) VALUES ('land', 'unknown', ?, 0), ('probe', 'refresh', ?, 3)",
				due,
				due,
			);
			await state.storage.setAlarm(Date.now() + 60 * 60 * 1000);
		});
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		await runInDurableObject(stub, async (_instance, state) => {
			const after = rows(state.storage.sql);
			expect(
				after.map(({ module, key, attempts }) => ({ module, key, attempts })),
			)
				.toEqual([
					{ module: "land", key: "unknown", attempts: 1 },
					{ module: "probe", key: "refresh", attempts: 4 },
				]);
			const [land, probe] = after;
			expect(land.at).toBeGreaterThan(due + timerBackoffMs(1) - 1);
			expect(probe.at).toBeGreaterThan(due + timerBackoffMs(4) - 1);
			// The alarm was re-pointed at the earliest retry.
			expect(await state.storage.getAlarm()).toBe(Math.min(land.at, probe.at));
			// Clean up so the retry alarm does not fire after the test.
			state.storage.sql.exec("DELETE FROM _timers");
			await state.storage.deleteAlarm();
		});
	});
});
