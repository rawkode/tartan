import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import type { ForgeInternals, ModuleDeps } from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import {
	createJobSlotsModule,
	SLOT_RETRY_MAX_MS,
	SLOT_RETRY_MIN_MS,
	SLOT_TIMER_PREFIX,
	SLOT_TTL_MIN_MS,
	SLOTS_MIGRATIONS,
	usageDay,
} from "./slots.ts";
import {
	fakeClock,
	fakeDoState,
	fakeIds,
	fakeTimers,
} from "./testing/fakes.ts";

const harness = (caps = { total: 3, ci: 2, git: 1, agent: 1 }) => {
	const state = fakeDoState();
	for (const m of SLOTS_MIGRATIONS) state.sql.exec(m.sql);
	const clock = fakeClock();
	const timers = fakeTimers();
	const stopped: string[] = [];
	const module = createJobSlotsModule({
		caps,
		budgetMs: 60_000,
		effects: () => ({
			stopSandbox: (runId) => {
				stopped.push(runId);
				return Promise.resolve();
			},
		}),
	});
	const instance = module.create({
		sql: state.sql,
		storage: state.storage,
		ctx: state.ctx,
		env: {} as Env,
		modules: {} as ForgeInternals,
		timers: timers.api,
		clock,
		ids: fakeIds(),
	} as ModuleDeps<Env, ForgeInternals>);
	return {
		...state,
		slots: instance.facade,
		onTimer: instance.onTimer!,
		clock,
		timers,
		stopped,
	};
};

Deno.test("slots respect the total and per-kind caps and answer a bounded retry", async () => {
	const h = harness();
	const a = await h.slots.acquire("ci", "r1", 600_000);
	const b = await h.slots.acquire("ci", "r2", 600_000);
	deepEqual(a, { slotKey: "ci:r1" });
	deepEqual(b, { slotKey: "ci:r2" });
	const c = await h.slots.acquire("ci", "r3", 600_000);
	ok("wait" in c);
	equal(c.retryAfterMs, SLOT_RETRY_MAX_MS);
	ok("slotKey" in await h.slots.acquire("git", "g1", 600_000));
	const full = await h.slots.acquire("agent", "x1", 600_000);
	ok("wait" in full, "total cap reached");
	await h.slots.release("ci:r1");
	equal(h.timers.pending.has(`${SLOT_TIMER_PREFIX}ci:r1`), false);
	deepEqual(await h.slots.acquire("ci", "r3", 600_000), { slotKey: "ci:r3" });
});

Deno.test("re-acquiring renews the lease; the retry hint follows the earliest expiry", async () => {
	const h = harness({ total: 1, ci: 1, git: 1, agent: 1 });
	await h.slots.acquire("ci", "r1", SLOT_TTL_MIN_MS);
	const waited = await h.slots.acquire("ci", "r2", SLOT_TTL_MIN_MS);
	ok("wait" in waited);
	equal(waited.retryAfterMs, SLOT_RETRY_MAX_MS);
	h.clock.advance(SLOT_TTL_MIN_MS - 1000);
	const soon = await h.slots.acquire("ci", "r2", SLOT_TTL_MIN_MS);
	ok("wait" in soon);
	equal(soon.retryAfterMs, SLOT_RETRY_MIN_MS);
	deepEqual(await h.slots.acquire("ci", "r1", SLOT_TTL_MIN_MS), {
		slotKey: "ci:r1",
	});
	equal(
		h.timers.pending.get(`${SLOT_TIMER_PREFIX}ci:r1`),
		h.clock.now() + SLOT_TTL_MIN_MS,
	);
	await rejects(h.slots.acquire("bogus" as "ci", "r", 1), /unknown slot kind/);
});

Deno.test("an expired slot destroys its run's sandbox before it frees the slot", async () => {
	const h = harness({ total: 1, ci: 1, git: 1, agent: 1 });
	await h.slots.acquire("ci", "r1", SLOT_TTL_MIN_MS);
	// Early fire (a renewed lease): reschedules, destroys nothing.
	await h.onTimer(`${SLOT_TIMER_PREFIX}ci:r1`);
	deepEqual(h.stopped, []);
	h.clock.advance(SLOT_TTL_MIN_MS + 1);
	// An expired slot no longer counts, even before the sweep ran.
	ok("slotKey" in await h.slots.acquire("ci", "r2", SLOT_TTL_MIN_MS));
	await h.onTimer(`${SLOT_TIMER_PREFIX}ci:r1`);
	deepEqual(h.stopped, ["r1"]);
	equal(
		h.sql.exec("SELECT COUNT(*) AS n FROM job_slots WHERE run_id = 'r1'").one()
			.n,
		0,
	);
	// A released slot's stale timer does nothing.
	await h.onTimer(`${SLOT_TIMER_PREFIX}ci:r1`);
	deepEqual(h.stopped, ["r1"]);
});

Deno.test("usage accumulates per UTC day and drives the budget flag", async () => {
	const h = harness();
	equal(await h.slots.budgetExceeded("ci"), false);
	await h.slots.recordUsage("ci", 40_000);
	await h.slots.recordUsage("git", 25_000);
	const day = usageDay(h.clock.now());
	deepEqual(
		(await h.slots.usage(day)).map((r) => [r.kind, r.container_ms, r.runs]),
		[["ci", 40_000, 1], ["git", 25_000, 1]],
	);
	equal(await h.slots.budgetExceeded("ci"), true);
	h.clock.advance(24 * 60 * 60 * 1000);
	equal(await h.slots.budgetExceeded("ci"), false);
	await rejects(h.slots.usage("yesterday"), /YYYY-MM-DD/);
});
