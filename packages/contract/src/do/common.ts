// Shared Durable Object module contract.
//
// Each DO class is a thin, integrator-owned adapter that composes per-module
// factories. Every module exports
//   { name, range, migrations, create(deps) → { facade, internal, onTimer?, sockets?, fetch? } }.
// Migrations are numbered SQL strings applied in order inside
// `blockConcurrencyWhile` and recorded in `_migrations`; each module owns a
// number range. Modules never call `setAlarm` and never implement `alarm()`
// or `webSocket*`: they use the timers API and register socket handlers by
// hibernation-tag prefix.
//
// Kernel-only (references workers-types globals).

import type { Clock, Ids } from "../ports.ts";

// ---------------------------------------------------------------------------
// Migrations and number ranges
// ---------------------------------------------------------------------------

export type Migration = {
	/** Unique within the DO; inside the owning module's range. */
	readonly n: number;
	readonly name: string;
	/** One or more statements; no BEGIN/SAVEPOINT, no TEMP tables. */
	readonly sql: string;
};

export type MigrationRange = readonly [min: number, max: number];

/** Migration number ranges per module. A migration outside its module's range fails review. */
export const MIGRATION_RANGES = {
	common: [1, 99],
	forge: {
		identity: [100, 199],
		tree: [200, 299],
		registry: [300, 399],
		events: [400, 449],
		slots: [450, 499],
		federation: [500, 549],
		/** The global log relay (WP26). */
		bus: [550, 569],
	},
	repo: {
		core: [100, 199],
		events: [200, 249],
		probe: [250, 299],
		runs: [300, 349],
		land: [350, 399],
		/** Repository config in CUE (WP23; ADR repo config). */
		repoconfig: [400, 429],
		/** The global log relay (WP26); 430–459 are free (WP25 has no RepoDO tables). */
		bus: [460, 479],
	},
	inbox: { inbox: [100, 199] },
	/** BusDO, the global log consumer (WP26). */
	bus: { bus: [100, 199] },
	/**
	 * ExtensionDO: host tables are migrated by WP7b and
	 * recorded in `_migrations` (1–99); the extension's own migrations
	 * (`manifest.storage.migrations`) are recorded in `_ext_migrations`
	 * (1–999). Two ledgers, so the ranges never collide. An ExtensionDO has
	 * no `meta` table (a builtin's own tables share its database).
	 */
	ext: { host: [1, 99], extension: [1, 999] },
} as const;

export const inRange = (n: number, [min, max]: MigrationRange): boolean =>
	Number.isInteger(n) && n >= min && n <= max;

/** Checks a module's migrations: inside its range, strictly increasing, unique. */
export const migrationIssues = (
	module: string,
	range: MigrationRange,
	migrations: readonly Migration[],
): string[] => {
	const issues: string[] = [];
	let last = -Infinity;
	for (const m of migrations) {
		if (!inRange(m.n, range)) {
			issues.push(
				`${module}: migration ${m.n} outside ${range[0]}–${range[1]}`,
			);
		}
		if (m.n <= last) issues.push(`${module}: migration ${m.n} out of order`);
		last = m.n;
	}
	return issues;
};

/** Common DDL owned by WP0 (migration 1); `rate_limits` is ForgeDO only. */
export const COMMON_DDL = {
	migrations:
		"CREATE TABLE IF NOT EXISTS _migrations (n INTEGER PRIMARY KEY, name TEXT NOT NULL, at INTEGER NOT NULL)",
	meta: "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
	timers:
		"CREATE TABLE IF NOT EXISTS _timers (module TEXT NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (module, key));\nCREATE INDEX IF NOT EXISTS _timers_at ON _timers(at)",
	rateLimits:
		"CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL)",
} as const;

// Common rows (every DO).
export type MigrationRow = { n: number; name: string; at: number };
export type MetaRow = { k: string; v: string };
export type TimerRow = {
	module: string;
	key: string;
	at: number;
	attempts: number;
};
export type RateLimitRow = { key: string; window_start: number; count: number };

// ---------------------------------------------------------------------------
// Timers (one alarm, many modules)
// ---------------------------------------------------------------------------

/**
 * Backed by `_timers(module, key, at)`; keeps the DO alarm at `MIN(at)`.
 * Synchronous so modules can schedule inside `transactionSync`.
 */
export interface TimersApi {
	/** Upsert: one pending timer per (module, key). */
	schedule(module: string, key: string, atMs: number): void;
	cancel(module: string, key: string): void;
	/** The pending time, if any. */
	get(module: string, key: string): number | null;
}

/**
 * What a module receives as `deps.timers`: the `TimersApi` bound to the
 * module's own name, so no module can schedule or cancel another module's
 * timers.
 */
export interface ModuleTimersApi {
	schedule(key: string, atMs: number): void;
	cancel(key: string): void;
	get(key: string): number | null;
}

/**
 * Called by `alarm()` for each due row, in `at` order, inside a per-module
 * try/catch. Success deletes the row (unless the handler rescheduled it);
 * a throw reschedules with backoff and never affects other modules.
 */
export type TimerHandler = (key: string) => void | Promise<void>;

/** Failed timers retry with exponential backoff from 1 s up to 10 min. */
export const TIMER_BACKOFF = {
	initialMs: 1000,
	maxMs: 10 * 60 * 1000,
	factor: 2,
} as const;
export const timerBackoffMs = (attempts: number): number =>
	Math.min(
		TIMER_BACKOFF.maxMs,
		TIMER_BACKOFF.initialMs * TIMER_BACKOFF.factor ** Math.max(0, attempts - 1),
	);

// ---------------------------------------------------------------------------
// WebSocket dispatch (hibernation)
// ---------------------------------------------------------------------------

/**
 * A module's WebSocket handlers. The thin class routes `webSocketMessage`,
 * `webSocketClose` and `webSocketError` to the module whose `tagPrefix`
 * matches the socket's first hibernation tag (e.g. `feed`).
 */
export type SocketHandlers = {
	readonly tagPrefix: string;
	message(ws: WebSocket, message: string | ArrayBuffer): void | Promise<void>;
	close(
		ws: WebSocket,
		code: number,
		reason: string,
		wasClean: boolean,
	): void | Promise<void>;
	error(ws: WebSocket, error: unknown): void | Promise<void>;
};

// ---------------------------------------------------------------------------
// Module factory
// ---------------------------------------------------------------------------

/**
 * What `create` receives. `modules` gives access to sibling modules'
 * synchronous internal APIs (resolved lazily, so creation order does not
 * matter); `env` is the hand-written `Env` (src/env.ts).
 */
export type ModuleDeps<Env = unknown, Siblings = Record<string, unknown>> = {
	readonly sql: SqlStorage;
	readonly storage: DurableObjectStorage;
	readonly ctx: DurableObjectState;
	readonly env: Env;
	readonly modules: Siblings;
	/** Bound to this module's name. */
	readonly timers: ModuleTimersApi;
	readonly clock: Clock;
	readonly ids: Ids;
};

export type ModuleInstance<Facade, Internal> = {
	/** Returned by the DO getter (`repo.core()`); an `RpcTarget` at runtime. */
	readonly facade: Facade;
	/** Synchronous in-DO API for sibling modules (joins one `transactionSync`). */
	readonly internal: Internal;
	readonly onTimer?: TimerHandler;
	readonly sockets?: readonly SocketHandlers[];
	/**
	 * HTTP into the DO, for what Workers RPC cannot carry: the
	 * `/-/live` WebSocket upgrade, which the module accepts with
	 * `ctx.acceptWebSocket(server, [tag, …])` so the dispatch table routes its
	 * hibernation events back to it. The thin DO class's `fetch` routes by the
	 * `DO_MODULE_HEADER` the Worker sets with `moduleRequest`; other requests
	 * get 404.
	 */
	readonly fetch?: (req: Request) => Response | Promise<Response>;
};

/** Names the module a `DurableObjectStub.fetch` request is for. */
export const DO_MODULE_HEADER = "x-tartan-module";

/**
 * A copy of `req` addressed to `module` of a DO, e.g.
 * `env.REPO.getByName(repoDoName(id)).fetch(moduleRequest("events", req))`.
 * Always sets the header itself, so a client-supplied value never routes.
 */
export const moduleRequest = (module: string, req: Request): Request => {
	const out = new Request(req);
	out.headers.set(DO_MODULE_HEADER, module);
	return out;
};

export type DoModule<
	Facade,
	Internal,
	Env = unknown,
	Siblings = Record<string, unknown>,
> = {
	readonly name: string;
	readonly range: MigrationRange;
	readonly migrations: readonly Migration[];
	create(deps: ModuleDeps<Env, Siblings>): ModuleInstance<Facade, Internal>;
};

/** Converts a facade's methods to the Promise-returning shape callers see over RPC. */
export type Remote<T> = {
	[K in keyof T]: T[K] extends (...args: infer A) => infer R
		? (...args: A) => Promise<Awaited<R>>
		: never;
};
