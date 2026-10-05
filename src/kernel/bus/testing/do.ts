// Test-only (Deno): a small stand-in for the DO host (`src/do/host.ts`) over
// node:sqlite, so the global log modules run under `deno test` beside the
// real event log: migrations (common, then each module's), lazily resolved
// siblings, a `_timers` table driven by `runDue()` with the host's rule (a
// handled row is deleted unless the handler moved it), `ctx.waitUntil`
// collection and a manual coalescer schedule. Runtime code never imports it.

import {
	COMMON_DDL,
	type DoModule,
	type ModuleInstance,
	type ModuleTimersApi,
} from "@tartan/contract/kernel.ts";
import type { Env } from "../../../env.ts";
import {
	applyMigrations,
	createFakeStorage,
	type FakeStorage,
} from "../../events/testing/sqlite.ts";

// deno-lint-ignore no-explicit-any
type AnyModule = DoModule<any, any, Env, any>;

export const testClock = (start = Date.UTC(2026, 9, 5, 12)) => {
	let now = start;
	return {
		now: () => now,
		advance: (ms: number) => {
			now += ms;
		},
		set: (at: number) => {
			now = at;
		},
	};
};
export type TestClock = ReturnType<typeof testClock>;

let idCounter = 0;
/** ULIDs that sort in creation order (unique across harnesses). */
export const testIds = () => ({
	ulid: () => {
		idCounter += 1;
		const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";
		let suffix = "";
		let v = idCounter;
		for (let i = 0; i < 8; i++) {
			suffix = BASE32[v % 32] + suffix;
			v = Math.floor(v / 32);
		}
		return `01k7${"0".repeat(14)}${suffix}`;
	},
});

/** A manual `Schedule` for the event coalescers. */
export const manualSchedule = () => {
	const queue: (() => void)[] = [];
	return {
		schedule: (fn: () => void, _ms: number) => {
			queue.push(fn);
		},
		/** Runs every scheduled coalescer run (the flush). */
		flush: () => {
			for (const fn of queue.splice(0)) fn();
		},
		pending: () => queue.length,
	};
};

export type TestDo = {
	readonly storage: FakeStorage;
	readonly name: string;
	instance(name: string): ModuleInstance<unknown, unknown>;
	// deno-lint-ignore no-explicit-any
	facade<T = any>(name: string): T;
	// deno-lint-ignore no-explicit-any
	internal<T = any>(name: string): T;
	/** Pending timers: `<module>/<key>` → at. */
	timers(): Map<string, number>;
	/** The alarm: runs every due timer once, like `createTimers().runDue`. */
	runDue(): Promise<{ module: string; key: string; error?: string }[]>;
	/** Awaits everything handed to `ctx.waitUntil` so far (repeatedly). */
	settle(): Promise<void>;
	/**
	 * An eviction: every module is created again over the same storage and
	 * timers; in-memory state (and any work still in flight) is dropped.
	 */
	restart(): void;
};

export const createTestDo = (
	config: {
		readonly name: string;
		readonly env?: Record<string, unknown>;
		readonly modules: Record<string, AnyModule>;
		readonly clock: TestClock;
		readonly ids?: { ulid(): string };
	},
): TestDo => {
	const storage = createFakeStorage();
	storage.sql.exec(COMMON_DDL.meta);
	const migrations = Object.values(config.modules)
		.flatMap((m) => m.migrations)
		.sort((a, b) => a.n - b.n);
	applyMigrations(storage, migrations);

	const timers = new Map<string, { at: number; attempts: number }>();
	const timersFor = (module: string): ModuleTimersApi => ({
		schedule: (key, at) => {
			timers.set(`${module}/${key}`, { at: Math.floor(at), attempts: 0 });
		},
		cancel: (key) => {
			timers.delete(`${module}/${key}`);
		},
		get: (key) => timers.get(`${module}/${key}`)?.at ?? null,
	});

	const background: Promise<unknown>[] = [];
	const ctx = {
		id: { name: config.name },
		storage: {
			sql: storage.sql,
			transactionSync: storage.transactionSync,
		},
		waitUntil: (p: Promise<unknown>) => {
			background.push(p);
		},
		getWebSockets: () => [],
		acceptWebSocket: () => {},
	} as unknown as DurableObjectState;

	const ids = config.ids ?? testIds();
	const instances = new Map<string, ModuleInstance<unknown, unknown>>();
	let siblings: Record<string, unknown> = {};
	const instance = (name: string): ModuleInstance<unknown, unknown> => {
		const existing = instances.get(name);
		if (existing) return existing;
		const module = config.modules[name];
		if (module === undefined) throw new Error(`unknown module ${name}`);
		const created = module.create({
			sql: storage.sql as unknown as SqlStorage,
			storage: ctx.storage,
			ctx,
			env: (config.env ?? { TARTAN_STAGE: "test" }) as unknown as Env,
			modules: siblings,
			timers: timersFor(name),
			clock: config.clock,
			ids,
		});
		instances.set(name, created);
		return created;
	};
	const start = (): void => {
		instances.clear();
		siblings = {};
		for (const name of Object.keys(config.modules)) {
			Object.defineProperty(siblings, name, {
				get: () => instance(name).internal,
				enumerable: true,
			});
		}
		for (const name of Object.keys(config.modules)) instance(name);
	};
	start();

	return {
		storage,
		name: config.name,
		instance,
		facade: (name) => instance(name).facade as never,
		internal: (name) => instance(name).internal as never,
		timers: () =>
			new Map([...timers.entries()].map(([k, v]) => [k, v.at] as const)),
		runDue: async () => {
			const now = config.clock.now();
			const due = [...timers.entries()]
				.filter(([, v]) => v.at <= now)
				.sort((a, b) => a[1].at - b[1].at);
			const out: { module: string; key: string; error?: string }[] = [];
			for (const [id, row] of due) {
				const [module, key] = id.split("/");
				try {
					await instance(module).onTimer?.(key);
					const after = timers.get(id);
					if (after && after.at === row.at && after.attempts === row.attempts) {
						timers.delete(id);
					}
					out.push({ module, key });
				} catch (error) {
					timers.set(id, { at: now + 1000, attempts: row.attempts + 1 });
					out.push({ module, key, error: String(error) });
				}
			}
			return out;
		},
		settle: async () => {
			while (background.length > 0) {
				await Promise.allSettled(background.splice(0));
			}
		},
		restart: () => {
			background.splice(0);
			start();
		},
	};
};
