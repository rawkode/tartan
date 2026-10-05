// The extension host behind one ExtensionDO (`ext:<instId>:node` or
// `ext:<instId>:repo:<repoUlid>`). `createExtensionHost(deps)` is pure over its
// ports, so the thin `ExtensionDO` class wires it to the real DO storage and
// facades and the Deno tests wire it to in-memory fakes.
//
// Per call the host:
// - converts stale write-ahead markers into breaker strikes, then
//   loads the installation (cached, revalidated against `ext_version`) and
//   refuses a disabled one (kill switch);
// - activates the package once per version: the extension's forward-only
//   migrations, then `init()`, under the mutex;
// - builds a fresh `ExtCtx`: caps minted for this call only (a stashed stub
//   fails afterwards), the guarded `sql` (host tables unreachable; SELECT-only
//   and effect-free when read-only), `kv`, config, a logger into `_console`;
// - runs the hook under a host-side wall-clock budget, under the FIFO mutex
//   for everything that may write; `render`, `context` and non-mutating
//   tools are read-only and bypass it. A builtin that overruns keeps the
//   mutex until it settles (it cannot be interrupted; capped by
//   `budgets.hold`); an isolated runtime is aborted and the overrun is a
//   breaker strike;
// - bumps `data_version` after every call that may have written, which
//   invalidates the viewer-keyed render cache.
//
// Event delivery is an ordered pull per (installation scope, stream):
// pokes record `known_head`, a drain reads pages from the stream's log
// (subscribe patterns; shadow events only for shadow installations; the
// forge stream filtered to the installation subtree, K12), skips what is in
// `_seen`, applies manifest filters, and calls `onEvent` per event under the
// mutex. Failures retry with backoff (1 s, 5 s, 30 s, 2 min, 10 min) through
// `_retry` and the `host` timer; after the last retry the event becomes a dead
// letter (`_dead`, ⇒ `extension.error`) and the stream skips it or blocks,
// per the manifest's `onError`. While an isolated runtime's breaker is open,
// events wait for `breaker_until`.

import {
	type ActionResult,
	type Actor,
	type ActorBounds,
	type CapsProps,
	conflict,
	type ContextRequest,
	type ContextSection,
	ContextSectionSchema,
	denied,
	type Envelope,
	errorChipDoc,
	type ExtCtx,
	extPrincipalId,
	type ExtScope,
	extScopeKey,
	type GateDecision,
	GateDecisionSchema,
	type GateInput,
	type GatePoint,
	HOST_TIMEOUTS_MS,
	type HostUiDoc,
	type InstallInfo,
	INTERFACE_TOOLS,
	internal,
	invalid,
	isTartanError,
	isWithinPath,
	type KernelCaps,
	type Kv,
	type Logger,
	type Manifest,
	matchesEventPattern,
	notFound,
	type PrefetchedInputs,
	type Role,
	sanitizeEchoLines,
	type SlotContext,
	StreamRefSchema,
	stripControl,
	timeout,
	type ToolContext,
	truncateBytes,
	unavailable,
	validateActionResult,
	validateUi,
} from "@tartan/contract";
import {
	type Clock,
	CONSOLE_RING_ROWS,
	type ConsoleRow,
	type DeadRow,
	EVENT_RETRY_BACKOFF_MS,
	type ExtensionHostApi,
	type Ids,
	MIGRATION_RANGES,
	migrationIssues,
	SEEN_RETENTION_MS,
	type Viewer,
} from "@tartan/contract/kernel.ts";
import { createGuardedSql, type SqlTarget } from "@tartan/ext-api/sqlguard.ts";
import { type CapsLocal, createKernelCaps } from "../../caps/caps.ts";
import type { KernelPorts, PortNode } from "../../caps/ports.ts";
import {
	createTokenBucket,
	DEFAULT_EFFECTS_PER_SECOND,
	type RateLimiter,
} from "../../caps/rate.ts";
import { createActorRoles } from "../../caps/roles.ts";
import { createTimers, type TimersDeps } from "../../../do/timers.ts";
import { type BreakerView, createBreaker, strikeKindOf } from "./breaker.ts";
import {
	INSTALLATION_REVALIDATE_MS,
	type InstallationSnapshot,
	type InstallationSource,
} from "./installation.ts";
import { createMutex } from "./mutex.ts";
import {
	type Hook,
	type HookArgs,
	type HookResult,
	type LoadedPackage,
	type PackageLoader,
	runtimeOf,
} from "./runtime.ts";
import { migrateExtension, migrateHostTables } from "./schema.ts";

// ---------------------------------------------------------------------------
// Types and constants
// ---------------------------------------------------------------------------

/** Timer modules of an ExtensionDO: host retries/drains, extension timers. */
export const EXT_TIMER_MODULES = ["host", "ext"] as const;

/** One read page of an event drain. */
export const DRAIN_PAGE = 100;
/** Pages per drain before handing over to the alarm. */
export const DRAIN_PAGES_PER_ENTRY = 5;
/** The first call plus one retry per backoff step; then a dead letter. */
export const EVENT_MAX_ATTEMPTS = EVENT_RETRY_BACKOFF_MS.length + 1;
/** `_retry.next_at` of a stream blocked by an `onError: "block"` dead letter. */
export const BLOCKED_AT = Number.MAX_SAFE_INTEGER;
/** Extension timers give up (⇒ `extension.error`) after this many failed runs. */
export const EXT_TIMER_MAX_ATTEMPTS = 5;
/** Safety net on top of `data_version` invalidation. */
export const RENDER_CACHE_TTL_MS = 5 * 60 * 1000;
export const RENDER_CACHE_MAX_ROWS = 2000;
const MAINTENANCE_EVERY_MS = 60 * 60 * 1000;
const CONSOLE_MSG_MAX_BYTES = 2048;
const BACKFILL_30D_MS = 30 * 24 * 60 * 60 * 1000;

export type HostBudgets =
	& {
		readonly [K in keyof typeof HOST_TIMEOUTS_MS]: number;
	}
	& {
		/** How long a timed-out builtin may keep the mutex while it finishes. */
		readonly hold: number;
	};

export const DEFAULT_BUDGETS: HostBudgets = {
	...HOST_TIMEOUTS_MS,
	hold: 30_000,
};

/** The DO's synchronous kv (`storage.kv`). */
export type SyncKv = {
	get<T = unknown>(key: string): T | undefined;
	put<T>(key: string, value: T): void;
	delete(key: string): boolean;
	list<T = unknown>(
		options?: { readonly prefix?: string; readonly limit?: number },
	): Iterable<[string, T]>;
};

/** The DO storage the host uses (the real `DurableObjectStorage` fits). */
export type HostStorage = SqlTarget & {
	readonly kv: SyncKv;
	sync(): Promise<void>;
	deleteAll(): Promise<void>;
	getAlarm(): Promise<number | null>;
	setAlarm(at: number): Promise<void>;
	deleteAlarm(): Promise<void>;
};

export type CapsFactory = (props: CapsProps, local: CapsLocal) => KernelCaps;

export type HostDeps = {
	/** The DO name: `ext:<instId>:node` or `ext:<instId>:repo:<repoUlid>`. */
	readonly name: string;
	readonly storage: HostStorage;
	readonly clock: Clock;
	readonly ids: Ids;
	readonly kernel: KernelPorts;
	readonly installations: InstallationSource;
	readonly packages: PackageLoader;
	/** Default: `createKernelCaps(props, kernel, local)`. */
	readonly caps?: CapsFactory;
	readonly budgets?: Partial<HostBudgets>;
	/** Mirror of console lines (Workers Logs), tagged with the installation. */
	readonly log?: (level: string, line: string) => void;
};

export type ExtensionHost = Omit<ExtensionHostApi, "callTool"> & {
	/** Resolves once the timers' alarm cache is loaded. */
	ready(): Promise<void>;
	alarm(): Promise<void>;
	/** `callTool` with the call chain (installation ids, outermost first). */
	callTool(
		name: string,
		args: unknown,
		ctx: ToolContext,
		bounds: ActorBounds,
		chain?: readonly string[],
	): Promise<unknown>;
};

const ULID = "[0-7][0-9a-hjkmnp-tv-z]{25}";
const DO_NAME_RE = new RegExp(`^ext:(i_${ULID}):(?:node|repo:(${ULID}))$`);

/** Parses an ExtensionDO name into its installation and scope. */
export const parseExtDoName = (
	name: string,
): { readonly installationId: string; readonly scope: ExtScope } | null => {
	const match = DO_NAME_RE.exec(name);
	if (match === null) return null;
	return {
		installationId: match[1],
		scope: match[2] === undefined
			? { kind: "node" }
			: { kind: "repo", repoId: match[2] },
	};
};

type Active = {
	readonly snap: InstallationSnapshot;
	readonly pkg: LoadedPackage;
	readonly install: InstallInfo;
	/** The installation's own principal, the actor of background hooks. */
	readonly self: Actor;
};

type CallSpec = {
	/** Console and strike label. */
	readonly method: string;
	readonly budgetMs: number;
	readonly actor: Actor;
	readonly bounds: ActorBounds | null;
	readonly readOnly: boolean;
	/** Under the mutex. */
	readonly exclusive: boolean;
	readonly trigger?: Actor;
	readonly causedBy?: string;
	readonly depth?: number;
	readonly chain?: readonly string[];
};

type Outcome<T> =
	| { readonly kind: "ok"; readonly value: T }
	| { readonly kind: "error"; readonly error: unknown }
	| { readonly kind: "timeout" };

const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const settleWithin = <T>(work: Promise<T>, ms: number): Promise<Outcome<T>> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timed = new Promise<Outcome<T>>((resolve) => {
		timer = setTimeout(() => resolve({ kind: "timeout" }), ms);
	});
	return Promise.race([
		work.then(
			(value): Outcome<T> => ({ kind: "ok", value }),
			(error): Outcome<T> => ({ kind: "error", error }),
		),
		timed,
	]).finally(() => clearTimeout(timer));
};

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/** Stable JSON (sorted keys) for cache keys. */
const canonical = (value: unknown): string => {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value ?? null);
	}
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${
		entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")
	}}`;
};

const sha256Hex = async (text: string): Promise<string> => {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
		.join("");
};

/** A dotted path into an envelope (`data.decision`). */
const pathValue = (value: unknown, path: string): unknown =>
	path.split(".").reduce<unknown>(
		(current, key) =>
			current !== null && typeof current === "object"
				? (current as Record<string, unknown>)[key]
				: undefined,
		value,
	);

/** True when a manifest subscription wants this event (pattern and filter). */
export const subscriptionWants = (
	manifest: Manifest,
	ev: Pick<Envelope, "type"> & Record<string, unknown>,
): boolean =>
	(manifest.subscribe ?? []).some((sub) =>
		matchesEventPattern(sub.event, ev.type) &&
		Object.entries(sub.filter ?? {}).every(([path, expected]) =>
			pathValue(ev, path) === expected
		)
	);

const clampRole = (role: number): Role =>
	(role >= 50
		? 50
		: role >= 40
		? 40
		: role >= 30
		? 30
		: role >= 20
		? 20
		: 10) as Role;

const mergeConfig = (manifest: Manifest, config: unknown): unknown => {
	const defaults = manifest.config?.default;
	if (
		defaults !== undefined && config !== null && typeof config === "object" &&
		!Array.isArray(config)
	) {
		return { ...defaults, ...(config as Record<string, unknown>) };
	}
	return config ?? defaults ?? {};
};

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

/**
 * Creates the host. Synchronously migrates the host tables, so call it inside
 * `blockConcurrencyWhile` and await `ready()` there too.
 */
export const createExtensionHost = (deps: HostDeps): ExtensionHost => {
	const { storage, clock, ids, kernel } = deps;
	const sql = storage.sql;
	const budgets: HostBudgets = { ...DEFAULT_BUDGETS, ...deps.budgets };
	const parsed = parseExtDoName(deps.name);

	migrateHostTables(storage, clock);
	const timers = createTimers({
		storage: storage as unknown as TimersDeps["storage"],
		clock,
		modules: EXT_TIMER_MODULES,
		log: (message, data) =>
			deps.log?.("error", `${message} ${JSON.stringify(data)}`),
	});
	const mutex = createMutex();
	const live = new Set<string>();
	const draining = new Set<string>();
	const rerun = new Set<string>();
	const activations = new Map<string, Promise<LoadedPackage>>();
	let snapshotCache:
		| { readonly snapshot: InstallationSnapshot; readonly checkedAt: number }
		| null = null;
	/** `abort("disabled")`: snapshots at or below this `ext_version` are disabled. */
	let disabledAt: number | null = null;
	/** The registry no longer knows this installation (uninstalled; ids are never reused). */
	let gone = false;
	let limiter: { readonly key: string; readonly bucket: RateLimiter } | null =
		null;
	let lastMaintenance = 0;
	let consoleWrites = 0;
	let quotaReportedAt = 0;
	let pendingBreakerReport: { view: BreakerView; strikes: number } | null =
		null;
	let readyPromise = timers.init();

	// -- _host ---------------------------------------------------------------

	const hostGet = (k: string): string | null =>
		sql.exec<{ v: string }>("SELECT v FROM _host WHERE k = ?", k).toArray()[0]
			?.v ?? null;
	const hostSet = (k: string, v: string): void => {
		sql.exec(
			"INSERT INTO _host (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
			k,
			v,
		);
	};
	const dataVersion = (): number => Number(hostGet("data_version") ?? "0");
	const bumpDataVersion = (): void => {
		hostSet("data_version", String(dataVersion() + 1));
	};

	// -- console -------------------------------------------------------------

	const writeConsole = (level: string, msg: string): void => {
		const line = truncateBytes(msg, CONSOLE_MSG_MAX_BYTES);
		sql.exec(
			"INSERT INTO _console (at, level, msg) VALUES (?, ?, ?)",
			clock.now(),
			level,
			line,
		);
		consoleWrites += 1;
		if (consoleWrites % 100 === 0) trimConsole();
		deps.log?.(level, line);
	};
	const trimConsole = (): void => {
		sql.exec(
			"DELETE FROM _console WHERE seq <= (SELECT MAX(seq) FROM _console) - ?",
			CONSOLE_RING_ROWS,
		);
	};

	const tagOf = (snap: InstallationSnapshot): string =>
		`[ext ${snap.installation.id} ${snap.manifest.id}@${snap.installation.version}]`;

	const loggerFor = (snap: InstallationSnapshot, method: string): Logger => {
		const line = (level: string) => (msg: string, data?: unknown) => {
			let suffix = "";
			if (data !== undefined) {
				try {
					suffix = ` ${JSON.stringify(data)}`;
				} catch {
					suffix = " [unserializable]";
				}
			}
			writeConsole(
				level,
				`${tagOf(snap)} ${method}: ${stripControl(String(msg))}${
					stripControl(suffix)
				}`,
			);
		};
		return {
			debug: line("debug"),
			info: line("info"),
			warn: line("warn"),
			error: line("error"),
		};
	};

	// -- extension.error (best effort, forge stream) --------------------------

	const reportError = async (
		snap: InstallationSnapshot,
		data: {
			readonly eventId?: string;
			readonly error: string;
			readonly attempts: number;
			readonly breaker?: "open" | "half-open" | "closed";
		},
		key: string,
	): Promise<void> => {
		const inst = snap.installation.id;
		try {
			await kernel.forgeEvents.appendKernel({
				type: "extension.error",
				actor: { kind: "ext", id: extPrincipalId(inst) },
				node: snap.installation.nodeId,
				data: {
					inst,
					...(data.eventId ? { eventId: data.eventId } : {}),
					error: truncateBytes(data.error, 2000),
					attempts: data.attempts,
					...(data.breaker ? { breaker: data.breaker } : {}),
				},
				idemKey: `${inst}:${key}`,
			});
		} catch (error) {
			writeConsole(
				"warn",
				`${tagOf(snap)} extension.error not recorded: ${errorText(error)}`,
			);
		}
	};

	const breaker = createBreaker(storage, clock, (view, strikes) => {
		pendingBreakerReport = { view, strikes };
	});

	const flushBreakerReport = (snap: InstallationSnapshot): void => {
		const report = pendingBreakerReport;
		if (report === null) return;
		pendingBreakerReport = null;
		writeConsole(
			"error",
			`${tagOf(snap)} circuit breaker open until ${
				new Date(report.view.until ?? 0).toISOString()
			} (${report.strikes} strikes)`,
		);
		const text = `circuit breaker open until ${
			new Date(report.view.until ?? 0).toISOString()
		}`;
		void reportError(snap, {
			error: text,
			attempts: report.strikes,
			breaker: "open",
		}, `breaker:${report.view.until}`);
		// The notice goes to the installer (no facade lists the forge's Owners).
		kernel.deliverNotice(snap.installation.installedBy, {
			kind: "system",
			severity: "critical",
			text: `${snap.manifest.id} at ${snap.installation.nodePath}: ${text}`,
			dedupeKey: `${snap.installation.id}:breaker:${report.view.until}`,
			source: "kernel",
			sourceLabel: "exthost",
		}).catch((error) =>
			writeConsole(
				"warn",
				`${tagOf(snap)} breaker notice not sent: ${errorText(error)}`,
			)
		);
	};

	// -- the installation ------------------------------------------------------

	const scopeOf = (): { installationId: string; scope: ExtScope } => {
		if (parsed === null) {
			throw internal(`not an ExtensionDO name: ${deps.name}`);
		}
		return parsed;
	};

	/** The snapshot, or null when the registry no longer knows the installation (uninstalled). */
	const findSnapshot = async (): Promise<InstallationSnapshot | null> => {
		const { installationId, scope } = scopeOf();
		const now = clock.now();
		const cached = snapshotCache;
		if (cached !== null) {
			if (now - cached.checkedAt < INSTALLATION_REVALIDATE_MS) {
				return cached.snapshot;
			}
			if (await deps.installations.version() === cached.snapshot.extVersion) {
				snapshotCache = { snapshot: cached.snapshot, checkedAt: now };
				return cached.snapshot;
			}
		}
		const snap = await deps.installations.load(installationId, scope);
		if (snap === null) {
			snapshotCache = null;
			return null;
		}
		if (snap.installation.id !== installationId) {
			throw internal("the registry returned another installation");
		}
		if (snap.installation.storageScope !== scope.kind) {
			throw internal(
				`installation ${installationId} has ${snap.installation.storageScope} storage, this host is ${scope.kind}-scoped`,
			);
		}
		snapshotCache = { snapshot: snap, checkedAt: now };
		return snap;
	};

	const loadSnapshot = async (): Promise<InstallationSnapshot> => {
		const snap = await findSnapshot();
		if (snap === null) {
			throw notFound(`installation ${scopeOf().installationId} not found`);
		}
		return snap;
	};

	const isDisabled = (snap: InstallationSnapshot): boolean =>
		snap.installation.mode === "disabled" ||
		(disabledAt !== null && snap.extVersion <= disabledAt);

	const installInfo = (snap: InstallationSnapshot): InstallInfo => ({
		id: snap.installation.id,
		extId: snap.manifest.id,
		version: snap.installation.version,
		node: { id: snap.installation.nodeId, path: snap.installation.nodePath },
		scopeKey: extScopeKey(scopeOf().scope),
		mode: snap.installation.mode === "shadow" ? "shadow" : "enforce",
	});

	const activeOf = (
		snap: InstallationSnapshot,
		pkg: LoadedPackage,
	): Active => ({
		snap,
		pkg,
		install: installInfo(snap),
		self: { kind: "ext", id: extPrincipalId(snap.installation.id) },
	});

	const activationKey = (snap: InstallationSnapshot): string =>
		`${snap.manifest.id}@${snap.installation.version}#${
			snap.sha256.slice(0, 16)
		}:${runtimeOf(snap)}`;

	// -- ExtCtx ---------------------------------------------------------------

	const quotaOf = (snap: InstallationSnapshot): number =>
		snap.manifest.storage.quotaMB * 1024 * 1024;

	const onQuota = (snap: InstallationSnapshot, size: number): void => {
		const now = clock.now();
		if (now - quotaReportedAt < MAINTENANCE_EVERY_MS) return;
		quotaReportedAt = now;
		writeConsole(
			"error",
			`${tagOf(snap)} storage quota exceeded (${size} bytes)`,
		);
		void reportError(snap, {
			error: `storage quota exceeded (${size} > ${quotaOf(snap)} bytes)`,
			attempts: 0,
		}, `quota:${Math.floor(now / MAINTENANCE_EVERY_MS)}`);
	};

	const rateOf = (snap: InstallationSnapshot): RateLimiter => {
		const perSecond = snap.manifest.limits?.effects_per_second ??
			DEFAULT_EFFECTS_PER_SECOND;
		const key = `${activationKey(snap)}:${perSecond}`;
		if (limiter === null || limiter.key !== key) {
			limiter = { key, bucket: createTokenBucket(clock, perSecond) };
		}
		return limiter.bucket;
	};

	const kvFor = (snap: InstallationSnapshot, readOnly: boolean): Kv => {
		const checkKey = (key: string): void => {
			if (typeof key !== "string" || key.length === 0 || key.length > 1024) {
				throw invalid("kv key: 1–1024 characters");
			}
		};
		return {
			get: (key) => {
				checkKey(key);
				const value = storage.kv.get<unknown>(key);
				if (value instanceof Uint8Array) return value;
				if (value instanceof ArrayBuffer) return new Uint8Array(value);
				return null;
			},
			put: (key, value) => {
				checkKey(key);
				if (readOnly) throw denied("read-only", "read-only context: kv.put");
				if (!(value instanceof Uint8Array)) {
					throw invalid("kv values are Uint8Array");
				}
				const size = sql.databaseSize;
				if (size > quotaOf(snap)) {
					onQuota(snap, size);
					throw denied("quota", "storage quota exceeded");
				}
				storage.kv.put(key, value);
			},
			delete: (key) => {
				checkKey(key);
				if (readOnly) throw denied("read-only", "read-only context: kv.delete");
				return storage.kv.delete(key);
			},
			listKeys: (prefix, limit) =>
				[...storage.kv.list({
					prefix,
					limit: Math.min(1000, Math.max(1, Math.floor(limit))),
				})].map(([key]) => key),
		};
	};

	const extTimers = {
		set: (key: string, atMs: number) =>
			timers.schedule("ext", key, Math.max(atMs, clock.now())),
		clear: (key: string) => timers.cancel("ext", key),
	};

	const capsFactory: CapsFactory = deps.caps ??
		((props, local) => createKernelCaps(props, kernel, local));

	/**
	 * The installation node, resolved through the tree (a move changes its
	 * path) and cached for `INSTALLATION_REVALIDATE_MS`, so the K12 root costs
	 * at most one tree lookup per interval instead of one per call.
	 */
	let nodeCache:
		| {
			readonly id: string;
			readonly at: number;
			readonly node: Promise<PortNode | null>;
		}
		| null = null;
	const installationNodeOf = (nodeId: string): Promise<PortNode | null> => {
		const now = clock.now();
		if (
			nodeCache === null || nodeCache.id !== nodeId ||
			now - nodeCache.at >= INSTALLATION_REVALIDATE_MS
		) {
			const node = kernel.node({ id: nodeId });
			nodeCache = { id: nodeId, at: now, node };
			node.catch(() => {
				if (nodeCache?.node === node) nodeCache = null;
			});
		}
		return nodeCache.node;
	};

	const propsOf = (a: Active, spec: CallSpec): CapsProps => {
		const { scope } = scopeOf();
		const installation = a.snap.installation;
		return {
			inst: installation.id,
			extId: a.snap.manifest.id,
			version: installation.version,
			scopeKey: extScopeKey(scope),
			node: { id: installation.nodeId, path: installation.nodePath },
			...(scope.kind === "repo" ? { repo: scope.repoId } : {}),
			grants: installation.grants,
			backgroundRole: installation.backgroundRole,
			actor: spec.actor,
			...(spec.actor.onBehalfOf ? { onBehalfOf: spec.actor.onBehalfOf } : {}),
			bounds: spec.bounds,
			...(spec.trigger ? { trigger: spec.trigger } : {}),
			...(spec.causedBy ? { causedBy: spec.causedBy } : {}),
			depth: spec.depth ?? 0,
			mode: installation.mode === "shadow" ? "shadow" : "enforce",
			readOnly: spec.readOnly,
			...(spec.chain && spec.chain.length > 0
				? { callChain: [...spec.chain] }
				: {}),
		};
	};

	const makeCtx = (
		a: Active,
		spec: CallSpec,
		expired: () => boolean,
	): ExtCtx => ({
		caps: capsFactory(propsOf(a, spec), {
			clock,
			ids,
			provides: () => Promise.resolve(a.snap.manifest.provides ?? []),
			repoPolicyKeys: () =>
				Promise.resolve(a.snap.manifest.config?.repoPolicy ?? []),
			timers: extTimers,
			rate: rateOf(a.snap),
			expired,
			installationNode: () => installationNodeOf(a.snap.installation.nodeId),
		}),
		sql: createGuardedSql(storage, {
			readOnly: spec.readOnly,
			quotaBytes: quotaOf(a.snap),
			onQuota: (size) => onQuota(a.snap, size),
		}),
		kv: kvFor(a.snap, spec.readOnly),
		config: mergeConfig(a.snap.manifest, a.snap.installation.config),
		log: loggerFor(a.snap, spec.method),
		install: a.install,
		actor: spec.actor,
		readOnly: spec.readOnly,
	});

	// -- one hook call ----------------------------------------------------------

	const breakerUntilOf = (error: unknown): number | null => {
		if (!isTartanError(error)) return null;
		const until = error.details?.breakerUntil;
		return typeof until === "number" ? until : null;
	};

	/** A facet's storage-quota refusal carries the database size. */
	const quotaSizeOf = (error: unknown): number | null => {
		if (
			!isTartanError(error) || error.code !== "denied" ||
			error.reason !== "quota"
		) {
			return null;
		}
		const size = error.details?.size;
		return typeof size === "number" ? size : null;
	};

	const call = <K extends Hook>(
		a: Active,
		hook: K,
		args: (x: ExtCtx) => HookArgs<K>,
		spec: CallSpec,
	): Promise<HookResult<K>> => {
		const runtime = a.pkg.runtime;
		return new Promise<HookResult<K>>((resolve, reject) => {
			const task = async (): Promise<void> => {
				// Admission is decided when the call actually starts (after the
				// mutex), so calls queued before the breaker opened short-circuit too.
				let probe = false;
				if (runtime.isolated) {
					const admission = breaker.admit();
					if (!admission.ok) {
						reject(
							unavailable(
								`${a.snap.manifest.id}: circuit breaker open until ${
									new Date(admission.until).toISOString()
								}`,
								{ breakerUntil: admission.until },
							),
						);
						return;
					}
					probe = admission.probe;
				}
				let expired = false;
				const callId = ids.ulid();
				if (runtime.isolated) {
					// The marker is durable before the facet runs.
					breaker.markInflight(callId, spec.method, spec.budgetMs);
					live.add(callId);
					await storage.sync();
				}
				// The caller is answered after the bookkeeping below, except for a
				// builtin overrun, which answers at once and keeps the mutex.
				let answer: (() => void) | null = null;
				try {
					const x = makeCtx(a, spec, () => expired);
					const work = runtime.invoke(hook, args(x));
					const outcome = await settleWithin(work, spec.budgetMs);
					if (outcome.kind === "ok") {
						if (probe) breaker.succeeded();
						answer = () => resolve(outcome.value);
					} else if (outcome.kind === "error") {
						const quotaSize = quotaSizeOf(outcome.error);
						if (quotaSize !== null) onQuota(a.snap, quotaSize);
						const kind = runtime.isolated ? strikeKindOf(outcome.error) : null;
						if (kind !== null) breaker.strike(spec.method, kind);
						else if (probe) breaker.released();
						answer = () => reject(outcome.error);
					} else {
						const overrun = timeout(
							`${a.snap.manifest.id} ${spec.method}`,
							spec.budgetMs,
						);
						writeConsole(
							"warn",
							`${tagOf(a.snap)} ${spec.method} exceeded ${spec.budgetMs} ms`,
						);
						if (runtime.isolated) {
							breaker.strike(spec.method, "timeout");
							runtime.abort(`${spec.method} exceeded ${spec.budgetMs} ms`);
							await work.then(() => undefined, () => undefined);
							answer = () => reject(overrun);
						} else {
							reject(overrun);
							// A builtin cannot be interrupted: keep the mutex until it settles.
							await Promise.race([
								work.then(() => undefined, () => undefined),
								sleep(budgets.hold),
							]);
						}
					}
				} finally {
					expired = true;
					if (runtime.isolated) {
						breaker.clearInflight(callId);
						live.delete(callId);
					}
					if (!spec.readOnly) bumpDataVersion();
					flushBreakerReport(a.snap);
					answer?.();
				}
			};
			const run = spec.exclusive ? mutex.run(task) : task();
			run.catch(reject);
		});
	};

	// -- activation --------------------------------------------------------------

	const activate = (snap: InstallationSnapshot): Promise<LoadedPackage> => {
		const key = activationKey(snap);
		const existing = activations.get(key);
		if (existing !== undefined) return existing;
		const started = (async () => {
			const pkg = await deps.packages(snap);
			if (hostGet("activated") !== key) {
				await mutex.run(async () => {
					if (hostGet("activated") === key) return;
					const own = pkg.runtime.storage;
					if (own === undefined) {
						migrateExtension(storage, pkg.migrations, clock);
					} else {
						// A facet keeps its own database: checked here, applied there.
						const issues = migrationIssues(
							"extension",
							MIGRATION_RANGES.ext.extension,
							pkg.migrations,
						);
						if (issues.length > 0) {
							throw internal(
								`invalid extension migrations: ${issues.join("; ")}`,
							);
						}
						await own.migrate(pkg.migrations);
					}
					const a = activeOf(snap, pkg);
					if (pkg.runtime.has("init")) {
						await call(a, "init", (x) => [x], {
							method: "init",
							budgetMs: budgets.event,
							actor: a.self,
							bounds: null,
							readOnly: false,
							exclusive: false,
						});
					}
					storage.transactionSync(() => {
						hostSet("activated", key);
						hostSet("installation_id", snap.installation.id);
						hostSet(
							"ext",
							`${snap.manifest.id}@${snap.installation.version}#${
								snap.sha256.slice(0, 16)
							}`,
						);
						hostSet("runtime", runtimeOf(snap));
						hostSet("scope", extScopeKey(scopeOf().scope));
						hostSet("mode", snap.installation.mode);
					});
					writeConsole("info", `${tagOf(snap)} activated (${key})`);
				});
			}
			return pkg;
		})();
		activations.set(key, started);
		started.catch(() => {
			if (activations.get(key) === started) activations.delete(key);
		});
		return started;
	};

	// -- maintenance -------------------------------------------------------------

	const maintain = (): void => {
		const now = clock.now();
		if (now - lastMaintenance < MAINTENANCE_EVERY_MS) return;
		lastMaintenance = now;
		storage.transactionSync(() => {
			sql.exec("DELETE FROM _seen WHERE at < ?", now - SEEN_RETENTION_MS);
			sql.exec(
				"DELETE FROM _render_cache WHERE data_version < ? OR at < ?",
				dataVersion(),
				now - RENDER_CACHE_TTL_MS,
			);
			trimConsole();
		});
	};

	// -- entry -------------------------------------------------------------------

	type Entered = {
		readonly snap: InstallationSnapshot;
		readonly active: Active | null;
	};

	const enterWith = async (snap: InstallationSnapshot): Promise<Entered> => {
		flushBreakerReport(snap);
		maintain();
		if (isDisabled(snap)) return { snap, active: null };
		const pkg = await activate(snap);
		return { snap, active: activeOf(snap, pkg) };
	};

	const enter = async (): Promise<Entered> => {
		await readyPromise;
		// Stale markers become strikes before anything else runs.
		breaker.convertStale(live);
		return enterWith(await loadSnapshot());
	};

	/**
	 * `enter()` for a timer: an installation the registry no longer
	 * knows (uninstalled) is terminal, not a failure to retry with backoff.
	 * Every timer of this host is dropped (they all belong to that one
	 * installation, and its ids are never reused), so the alarm is cleared
	 * and the host stays idle; its data is the uninstall's to delete.
	 */
	const enterTimer = async (): Promise<Entered | null> => {
		await readyPromise;
		// The rest of the same alarm's due rows: already dropped.
		if (gone) return null;
		breaker.convertStale(live);
		const snap = await findSnapshot();
		if (snap === null) {
			gone = true;
			const dropped = sql.exec<{ n: number }>(
				"SELECT COUNT(*) AS n FROM _timers",
			).one().n;
			sql.exec("DELETE FROM _timers");
			timers.syncAlarm();
			deps.log?.(
				"warn",
				`[ext ${scopeOf().installationId}] installation is gone: dropped ${dropped} timers`,
			);
			return null;
		}
		return enterWith(snap);
	};

	/**
	 * `enter()` for the calls that must degrade instead of failing (render →
	 * error chip, context → no sections, echo → no lines): null on failure,
	 * which is logged.
	 */
	const softEnter = async (method: string) => {
		try {
			return await enter();
		} catch (error) {
			writeConsole(
				"error",
				`[ext ${parsed?.installationId ?? deps.name}] ${method}: ${
					errorText(error)
				}`,
			);
			return null;
		}
	};

	const requireActive = async (): Promise<Active> => {
		const { snap, active } = await enter();
		if (active === null) {
			throw denied("disabled", `${snap.manifest.id} is disabled`);
		}
		return active;
	};

	const background = (
		a: Active,
		method: string,
		budgetMs: number,
	): CallSpec => ({
		method,
		budgetMs,
		actor: a.self,
		bounds: null,
		readOnly: false,
		exclusive: true,
	});

	// -- event delivery -------------------------------------------------------

	type CursorRow = { stream: string; seq: number; known_head: number };
	type RetryRow = {
		stream: string;
		event_id: string;
		attempts: number;
		next_at: number;
		error: string | null;
	};

	const cursorOf = (stream: string): CursorRow | null =>
		sql.exec<CursorRow>(
			"SELECT stream, seq, known_head FROM _cursors WHERE stream = ?",
			stream,
		).toArray()[0] ?? null;

	const retryOf = (stream: string): RetryRow | null =>
		sql.exec<RetryRow>(
			"SELECT stream, event_id, attempts, next_at, error FROM _retry WHERE stream = ?",
			stream,
		).toArray()[0] ?? null;

	const advance = (stream: string, seq: number): void => {
		sql.exec(
			"UPDATE _cursors SET seq = MAX(seq, ?) WHERE stream = ?",
			seq,
			stream,
		);
	};

	const scheduleDrain = (stream: string, at: number): void => {
		const key = `drain:${stream}`;
		const when = Math.max(at, clock.now() + 1);
		const pending = timers.get("host", key);
		// Keep an earlier pending drain; a due one (the alarm running it now) is replaced.
		if (pending === null || when < pending || pending <= clock.now()) {
			timers.schedule("host", key, when);
		}
	};

	/**
	 * One page of a stream and the last seq the read considered: the forge
	 * stream's subtree filter scans a bounded number of rows, so a short page
	 * is caught up only to `scannedTo`; a repo stream's
	 * short page is complete.
	 */
	const readStream = async (
		snap: InstallationSnapshot,
		stream: string,
		since: number,
		limit: number,
		patterns: string[],
	): Promise<{ events: Envelope[]; scannedTo: number }> => {
		if (stream === "forge") {
			return await kernel.forgeEvents.readPage(since, patterns, {
				limit,
				subtreeNodeId: snap.installation.nodeId,
			});
		}
		const events = await kernel.repo(stream.slice("repo:".length)).events
			.read({
				since,
				limit,
				patterns,
				includeShadow: snap.installation.mode === "shadow",
			}) as Envelope[];
		return {
			events,
			scannedTo: events.length < limit
				? Number.MAX_SAFE_INTEGER
				: events[events.length - 1].seq,
		};
	};

	/** Events older than this are not delivered (install-time backfill). */
	const backfillFloor = (snap: InstallationSnapshot): number | null => {
		const backfill = snap.installation.backfill;
		if (backfill === "all") return null;
		const installedAt = snap.installation.installedAt;
		return backfill === "none" ? installedAt : installedAt - BACKFILL_30D_MS;
	};

	/**
	 * The starting cursor of a stream: 0 for `backfill: "all"`, else the last
	 * event before the floor, found by bisecting the log on `at` (seq and `at`
	 * grow together within one log).
	 */
	const startCursor = async (
		snap: InstallationSnapshot,
		stream: string,
		head: number,
	): Promise<number> => {
		const floor = backfillFloor(snap);
		if (floor === null) return 0;
		let lo = 0;
		let hi = head;
		while (lo < hi) {
			const mid = Math.floor((lo + hi + 1) / 2);
			const [ev] = (await readStream(snap, stream, mid - 1, 1, ["*"])).events;
			if (ev === undefined) {
				lo = hi;
				break;
			}
			if (ev.at < floor) lo = Math.min(ev.seq, hi);
			else hi = mid - 1;
		}
		return lo;
	};

	/** K12: which streams this host may drain. */
	const admitStream = async (
		snap: InstallationSnapshot,
		stream: string,
	): Promise<void> => {
		const { scope } = scopeOf();
		if (stream === "forge") return;
		const repoId = stream.slice("repo:".length);
		if (scope.kind === "repo") {
			if (repoId !== scope.repoId) {
				throw denied("scope", `stream ${stream} is not this host's repo`);
			}
			return;
		}
		if (cursorOf(stream) !== null) return;
		const node = await kernel.node({ id: repoId });
		if (
			node === null || !isWithinPath(snap.installation.nodePath, node.path)
		) {
			throw denied(
				"scope",
				`stream ${stream} is outside the installation subtree`,
			);
		}
	};

	const ensureCursor = async (
		snap: InstallationSnapshot,
		stream: string,
		head: number,
	): Promise<void> => {
		if (cursorOf(stream) === null) {
			const seq = await startCursor(snap, stream, head);
			sql.exec(
				`INSERT INTO _cursors (stream, seq, known_head) VALUES (?, ?, ?)
				 ON CONFLICT (stream) DO UPDATE SET known_head = MAX(known_head, excluded.known_head)`,
				stream,
				seq,
				head,
			);
			return;
		}
		sql.exec(
			"UPDATE _cursors SET known_head = MAX(known_head, ?) WHERE stream = ?",
			head,
			stream,
		);
	};

	/** One event through `onEvent`; returns false when the stream must stop here. */
	const deliver = async (
		a: Active,
		stream: string,
		ev: Envelope,
	): Promise<boolean> => {
		try {
			await call(a, "onEvent", (x) => [ev, x], {
				...background(a, "onEvent", budgets.event),
				trigger: ev.actor,
				causedBy: ev.id,
				depth: ev.depth,
			});
		} catch (error) {
			const now = clock.now();
			const until = breakerUntilOf(error);
			const prev = retryOf(stream);
			if (until !== null) {
				// Breaker open: the event waits for `breaker_until`, no attempt counted.
				sql.exec(
					`INSERT INTO _retry (stream, event_id, attempts, next_at, error) VALUES (?, ?, ?, ?, ?)
					 ON CONFLICT (stream) DO UPDATE SET event_id = excluded.event_id, attempts = excluded.attempts,
					 next_at = excluded.next_at, error = excluded.error`,
					stream,
					ev.id,
					prev?.event_id === ev.id ? prev.attempts : 0,
					until,
					errorText(error),
				);
				scheduleDrain(stream, until);
				return false;
			}
			const attempts = (prev?.event_id === ev.id ? prev.attempts : 0) + 1;
			const message = errorText(error);
			writeConsole(
				"error",
				`${
					tagOf(a.snap)
				} onEvent ${ev.type} ${ev.id} failed (attempt ${attempts}): ${message}`,
			);
			if (attempts < EVENT_MAX_ATTEMPTS) {
				const next = now + EVENT_RETRY_BACKOFF_MS[attempts - 1];
				sql.exec(
					`INSERT INTO _retry (stream, event_id, attempts, next_at, error) VALUES (?, ?, ?, ?, ?)
					 ON CONFLICT (stream) DO UPDATE SET event_id = excluded.event_id, attempts = excluded.attempts,
					 next_at = excluded.next_at, error = excluded.error`,
					stream,
					ev.id,
					attempts,
					next,
					message,
				);
				scheduleDrain(stream, next);
				return false;
			}
			const block = a.snap.manifest.onError === "block";
			storage.transactionSync(() => {
				sql.exec(
					"INSERT OR REPLACE INTO _dead (event_id, stream, attempts, error, at) VALUES (?, ?, ?, ?, ?)",
					ev.id,
					stream,
					attempts,
					message,
					now,
				);
				if (block) {
					sql.exec(
						`INSERT INTO _retry (stream, event_id, attempts, next_at, error) VALUES (?, ?, ?, ?, ?)
						 ON CONFLICT (stream) DO UPDATE SET event_id = excluded.event_id, attempts = excluded.attempts,
						 next_at = excluded.next_at, error = excluded.error`,
						stream,
						ev.id,
						attempts,
						BLOCKED_AT,
						`blocked: ${message}`,
					);
				} else {
					sql.exec("DELETE FROM _retry WHERE stream = ?", stream);
					advance(stream, ev.seq);
				}
			});
			void reportError(a.snap, {
				eventId: ev.id,
				error: message,
				attempts,
			}, `dead:${ev.id}`);
			return !block;
		}
		storage.transactionSync(() => {
			sql.exec(
				"INSERT OR IGNORE INTO _seen (event_id, at) VALUES (?, ?)",
				ev.id,
				clock.now(),
			);
			sql.exec("DELETE FROM _retry WHERE stream = ?", stream);
			advance(stream, ev.seq);
		});
		return true;
	};

	const drainOnce = async (a: Active, stream: string): Promise<void> => {
		const manifest = a.snap.manifest;
		const patterns = [
			...new Set((manifest.subscribe ?? []).map((s) => s.event)),
		];
		const floor = backfillFloor(a.snap);
		for (let page = 0; page < DRAIN_PAGES_PER_ENTRY; page++) {
			const cursor = cursorOf(stream);
			if (cursor === null || cursor.seq >= cursor.known_head) return;
			if (patterns.length === 0 || !a.pkg.runtime.has("onEvent")) {
				advance(stream, cursor.known_head);
				return;
			}
			const now = clock.now();
			const retry = retryOf(stream);
			if (retry !== null && retry.next_at > now) {
				if (retry.next_at !== BLOCKED_AT) scheduleDrain(stream, retry.next_at);
				return;
			}
			if (a.pkg.runtime.isolated) {
				const view = breaker.view();
				if (view.state === "open" && view.until !== null && view.until > now) {
					scheduleDrain(stream, view.until);
					return;
				}
			}
			const knownBefore = cursor.known_head;
			const { events, scannedTo } = await readStream(
				a.snap,
				stream,
				cursor.seq,
				DRAIN_PAGE,
				patterns,
			);
			for (const ev of events) {
				const current = cursorOf(stream);
				if (current !== null && ev.seq <= current.seq) continue;
				const seen = sql.exec(
					"SELECT 1 AS one FROM _seen WHERE event_id = ?",
					ev.id,
				).toArray().length > 0;
				const wanted = !seen && (floor === null || ev.at >= floor) &&
					subscriptionWants(manifest, ev as Envelope & Record<string, unknown>);
				if (!wanted) {
					advance(stream, ev.seq);
					continue;
				}
				if (!await deliver(a, stream, ev)) return;
			}
			if (events.length < DRAIN_PAGE) {
				// Everything matching up to where the read looked is done: the
				// head we knew of, or less when a bounded scan stopped short.
				advance(stream, Math.min(knownBefore, scannedTo));
			}
		}
		const cursor = cursorOf(stream);
		if (cursor !== null && cursor.seq < cursor.known_head) {
			scheduleDrain(stream, clock.now());
		}
	};

	const drain = async (a: Active, stream: string): Promise<void> => {
		if (draining.has(stream)) {
			rerun.add(stream);
			return;
		}
		draining.add(stream);
		try {
			do {
				rerun.delete(stream);
				await drainOnce(a, stream);
			} while (rerun.has(stream));
		} finally {
			draining.delete(stream);
		}
	};

	// -- timers -------------------------------------------------------------------

	const onHostTimer = async (key: string): Promise<void> => {
		if (!key.startsWith("drain:")) return;
		const stream = key.slice("drain:".length);
		const active = (await enterTimer())?.active ?? null;
		if (active === null) return;
		await drain(active, stream);
	};

	const onExtTimer = async (key: string): Promise<void> => {
		const active = (await enterTimer())?.active ?? null;
		if (active === null || !active.pkg.runtime.has("onTimer")) return;
		try {
			await call(
				active,
				"onTimer",
				(x) => [key, x],
				background(active, "onTimer", budgets.event),
			);
		} catch (error) {
			const attempts = sql.exec<{ attempts: number }>(
				"SELECT attempts FROM _timers WHERE module = 'ext' AND key = ?",
				key,
			).toArray()[0]?.attempts ?? 0;
			if (attempts + 1 < EXT_TIMER_MAX_ATTEMPTS) throw error;
			const message = errorText(error);
			writeConsole(
				"error",
				`${tagOf(active.snap)} timer ${key} dropped after ${
					attempts + 1
				} failures: ${message}`,
			);
			void reportError(active.snap, {
				error: `timer ${key}: ${message}`,
				attempts: attempts + 1,
			}, `timer:${key}:${clock.now()}`);
		}
	};

	// -- render ---------------------------------------------------------

	const renderKey = (
		snap: InstallationSnapshot,
		slot: string,
		ctx: SlotContext,
		viewerKey: string,
		props: unknown,
		version: number,
	): Promise<string> =>
		sha256Hex(
			canonical([
				activationKey(snap),
				slot,
				ctx,
				viewerKey,
				props ?? null,
				version,
			]),
		);

	/**
	 * The render's actor and bounds: the viewer (or, for an anonymous viewer,
	 * the installation), capped at the role the slot API authorized and
	 * confined to the viewed node's subtree. `Viewer` carries no credential
	 * bounds, so the viewed node stands in for a token's node scope: a render
	 * never reads outside what the viewer was authorized to look at.
	 */
	const viewerActor = (
		a: Active,
		viewer: Viewer,
		ctx: SlotContext,
	): { readonly actor: Actor; readonly bounds: ActorBounds } => ({
		actor: viewer.actor ?? a.self,
		bounds: {
			maxRole: clampRole(viewer.role),
			scopes: null,
			nodeId: ctx.repo ?? ctx.node,
			laneId: null,
		},
	});

	const render: ExtensionHostApi["render"] = async (
		slot,
		ctx,
		viewer,
		props,
	) => {
		const entered = await softEnter("render");
		if (entered === null) return errorChipDoc(parsed?.installationId ?? "ext");
		const { snap, active } = entered;
		const label = snap.manifest.id;
		if (active === null) return errorChipDoc(label);
		const contribution = snap.manifest.contributes?.slots?.find((s) =>
			s.id === slot
		);
		if (contribution === undefined || !active.pkg.runtime.has("render")) {
			writeConsole("warn", `${tagOf(snap)} render: no slot ${slot}`);
			return errorChipDoc(label);
		}
		const minRole = contribution.role ?? 20;
		if (viewer.role < minRole) {
			throw denied("role", `slot ${slot} needs role ${minRole}`);
		}
		const version = dataVersion();
		const viewerKey = contribution.cache === "role"
			? `role:${viewer.role}:${viewer.kind}`
			: `principal:${viewer.actor?.id ?? "anonymous"}:${viewer.role}`;
		const key = contribution.cache === "none"
			? null
			: await renderKey(snap, slot, ctx, viewerKey, props, version);
		if (key !== null) {
			const hit = sql.exec<{ ui_json: string }>(
				"SELECT ui_json FROM _render_cache WHERE key = ? AND data_version = ? AND at >= ?",
				key,
				version,
				clock.now() - RENDER_CACHE_TTL_MS,
			).toArray()[0];
			if (hit !== undefined) return JSON.parse(hit.ui_json) as HostUiDoc;
		}
		const { actor, bounds } = viewerActor(active, viewer, ctx);
		try {
			const out = await call(active, "render", (x) => [slot, ctx, props, x], {
				method: `render ${slot}`,
				budgetMs: budgets.render,
				actor,
				bounds,
				readOnly: true,
				exclusive: false,
			});
			const checked = validateUi(out);
			if (!checked.ok) {
				writeConsole(
					"warn",
					`${tagOf(snap)} render ${slot}: invalid tartan-ui@1: ${
						checked.errors.slice(0, 5).join("; ")
					}`,
				);
				return errorChipDoc(label);
			}
			if (key !== null) {
				sql.exec(
					"INSERT OR REPLACE INTO _render_cache (key, data_version, ui_json, at) VALUES (?, ?, ?, ?)",
					key,
					version,
					JSON.stringify(checked.doc),
					clock.now(),
				);
				sql.exec(
					"DELETE FROM _render_cache WHERE key IN (SELECT key FROM _render_cache ORDER BY at DESC LIMIT -1 OFFSET ?)",
					RENDER_CACHE_MAX_ROWS,
				);
			}
			return checked.doc;
		} catch (error) {
			writeConsole(
				"warn",
				`${tagOf(snap)} render ${slot} failed: ${errorText(error)}`,
			);
			return errorChipDoc(label);
		}
	};

	// -- the RPC surface ----------------------------------------------------------

	/**
	 * K12 for this installation (the call's target lies in its subtree) and the
	 * actor's role there (the acting-principal bounds: grants bounded by the
	 * credential; another installation acting through `interfaces.call` carries
	 * its role in `bounds`).
	 */
	const roleAtTarget = async (
		a: Active,
		actor: Actor,
		bounds: ActorBounds | null,
		nodeId: string,
		what: string,
		laneId?: string,
	) => {
		const target = await kernel.node({ id: nodeId });
		if (
			target === null ||
			!isWithinPath(a.snap.installation.nodePath, target.path)
		) {
			throw denied(
				"scope",
				`${what}: the target is outside ${a.snap.manifest.id}'s subtree`,
			);
		}
		const role = await createActorRoles(kernel, kernel.node, {
			self: a.self.id,
			backgroundRole: a.snap.installation.backgroundRole,
			actor,
			bounds,
		}).roleAt(target, laneId);
		return { target, role };
	};

	const callTool: ExtensionHost["callTool"] = async (
		name,
		args,
		ctx,
		bounds,
		chain = [],
	) => {
		const { installationId } = scopeOf();
		// A re-entry would deadlock on the mutex.
		if (chain.includes(installationId)) throw conflict("call cycle");
		const a = await requireActive();
		const manifest = a.snap.manifest;
		const iface = INTERFACE_TOOLS[name];
		const provided = iface !== undefined &&
			(manifest.provides ?? []).includes(iface.iface as never);
		const contribution = manifest.contributes?.tools?.find((t) =>
			t.name === name
		);
		if (!provided && contribution === undefined) {
			throw notFound(`${manifest.id} has no tool ${name}`);
		}
		if (!a.pkg.runtime.has("callTool")) {
			throw notFound(`${manifest.id} does not implement tools`);
		}
		const role = provided ? iface.def.role : contribution!.role;
		const mutating = provided ? iface.def.mutating : true;
		let input = args;
		if (provided) {
			const parsedInput = iface.def.input.safeParse(args);
			if (!parsedInput.success) {
				throw invalid(
					`${name}: ${
						parsedInput.error.issues.map((i) => i.message).join("; ")
					}`,
				);
			}
			input = parsedInput.data;
		}
		const { target, role: actorRole } = await roleAtTarget(
			a,
			ctx.actor,
			bounds,
			ctx.repo ?? ctx.node,
			name,
			ctx.laneId,
		);
		if (actorRole < role) {
			throw denied("role", `${name} needs role ${role} at ${target.path}`);
		}
		const out = await call(a, "callTool", (x) => [name, input, ctx, x], {
			method: `tool ${name}`,
			budgetMs: budgets.tool,
			actor: ctx.actor,
			bounds,
			readOnly: !mutating,
			exclusive: mutating,
			// Caps appends this installation when it calls further.
			chain,
		});
		if (provided) {
			const checked = iface.def.output.safeParse(out);
			if (!checked.success) {
				throw internal(
					`${manifest.id} ${name}: invalid result for ${iface.iface}`,
				);
			}
			return checked.data;
		}
		return out;
	};

	const host: ExtensionHost = {
		ready: () => readyPromise,

		poke: async (input) => {
			const stream = StreamRefSchema.safeParse(input?.stream);
			if (!stream.success) throw invalid("poke: stream is forge or repo:<id>");
			const head = Number(input.head);
			if (!Number.isInteger(head) || head < 0) {
				throw invalid("poke: head is a non-negative integer");
			}
			const { snap, active } = await enter();
			await admitStream(snap, stream.data);
			await ensureCursor(snap, stream.data, head);
			// A disabled installation only remembers the head.
			if (active === null) return;
			await drain(active, stream.data);
		},

		render,

		action: async (slot, action, payload, ctx, actor, bounds) => {
			const a = await requireActive();
			const contribution = a.snap.manifest.contributes?.slots?.find((s) =>
				s.id === slot
			);
			if (contribution === undefined) {
				throw notFound(`${a.snap.manifest.id} has no slot ${slot}`);
			}
			if (!a.pkg.runtime.has("onAction")) {
				throw notFound(`${a.snap.manifest.id} has no actions`);
			}
			if (typeof action !== "string" || !/^[a-z0-9._-]{1,64}$/.test(action)) {
				throw invalid("action: [a-z0-9._-]{1,64}");
			}
			// Defense in depth behind the slot API: the slot's role holds for actions too.
			const minRole = contribution.role ?? 20;
			const { target, role } = await roleAtTarget(
				a,
				actor,
				bounds,
				ctx.repo ?? ctx.node,
				`action ${slot}/${action}`,
			);
			if (role < minRole) {
				throw denied(
					"role",
					`slot ${slot} needs role ${minRole} at ${target.path}`,
				);
			}
			const out = await call(
				a,
				"onAction",
				(x) => [action, payload, ctx, x],
				{
					method: `action ${slot}/${action}`,
					budgetMs: budgets.action,
					actor,
					bounds,
					readOnly: false,
					exclusive: true,
				},
			);
			const checked = validateActionResult(out);
			if (!checked.ok) {
				writeConsole(
					"warn",
					`${tagOf(a.snap)} action ${slot}/${action}: invalid result: ${
						checked.errors.slice(0, 5).join("; ")
					}`,
				);
				throw internal(`${a.snap.manifest.id}: invalid action result`);
			}
			return checked.result as ActionResult;
		},

		callTool,

		context: async (req, bounds) => {
			const active = (await softEnter("context"))?.active ?? null;
			if (active === null) return [];
			const contributions = active.snap.manifest.contributes?.context ?? [];
			if (contributions.length === 0 || !active.pkg.runtime.has("context")) {
				return [];
			}
			let out: ContextSection[];
			try {
				out = await call(
					active,
					"context",
					(x) => [req as ContextRequest, x],
					{
						method: "context",
						budgetMs: budgets.context,
						actor: req.actor,
						bounds,
						readOnly: true,
						exclusive: false,
					},
				);
			} catch (error) {
				writeConsole(
					"warn",
					`${tagOf(active.snap)} context failed: ${errorText(error)}`,
				);
				return [];
			}
			if (!Array.isArray(out)) return [];
			const sections: ContextSection[] = [];
			for (const raw of out) {
				const parsedSection = ContextSectionSchema.safeParse(raw);
				if (!parsedSection.success) continue;
				const declared = contributions.find((c) =>
					c.id === parsedSection.data.id
				);
				if (declared === undefined) continue;
				sections.push({
					...parsedSection.data,
					md: truncateBytes(parsedSection.data.md, declared.maxBytes),
				});
			}
			return sections;
		},

		gate: async (point: GatePoint, input: GateInput): Promise<GateDecision> => {
			const a = await requireActive();
			const declared = a.snap.manifest.gates?.find((g) => g.point === point);
			if (declared === undefined || !a.pkg.runtime.has("gate")) {
				throw invalid(`${a.snap.manifest.id} declares no ${point} gate`);
			}
			const out = await call(
				a,
				"gate",
				(x) => [point, input, x],
				background(a, `gate ${point}`, declared.timeoutMs),
			);
			const checked = GateDecisionSchema.safeParse(out);
			if (!checked.success) {
				throw invalid(`${a.snap.manifest.id}: invalid gate decision`);
			}
			return checked.data;
		},

		echo: async (event: Envelope, input: PrefetchedInputs) => {
			const active = (await softEnter("echo"))?.active ?? null;
			const declared = active?.snap.manifest.echo?.[0];
			if (
				active === null || declared === undefined ||
				!active.pkg.runtime.has("echo")
			) {
				return { lines: [], timedOut: false };
			}
			try {
				const out = await call(
					active,
					"echo",
					(x) => [event, input, x],
					background(active, "echo", declared.timeoutMs),
				);
				const short = active.snap.manifest.id.split(".").pop() ??
					active.snap.manifest.id;
				return { lines: sanitizeEchoLines(short, out), timedOut: false };
			} catch (error) {
				const timedOut = isTartanError(error) && error.code === "timeout";
				if (!timedOut) {
					writeConsole(
						"warn",
						`${tagOf(active.snap)} echo failed: ${errorText(error)}`,
					);
				}
				return { lines: [], timedOut };
			}
		},

		abort: async (reason) => {
			await readyPromise;
			if (reason === "disabled") {
				let version = snapshotCache?.snapshot.extVersion ?? 0;
				try {
					version = Math.max(version, await deps.installations.version());
				} catch {
					// Keep the cached version: the kill switch still applies to it.
				}
				disabledAt = version;
				hostSet("mode", "disabled");
			}
			const pending = [...activations.values()];
			activations.clear();
			snapshotCache = null;
			for (const started of pending) {
				started.then((pkg) => pkg.runtime.abort(reason), () => undefined);
			}
			if (reason === "upgrade") hostSet("activated", "");
			writeConsole(
				"info",
				`[ext ${scopeOf().installationId}] abort: ${reason}`,
			);
		},

		console: async (sinceSeq, limit) => {
			await readyPromise;
			return sql.exec<ConsoleRow>(
				"SELECT seq, at, level, msg FROM _console WHERE seq > ? ORDER BY seq LIMIT ?",
				Math.max(0, Math.floor(Number(sinceSeq) || 0)),
				Math.min(500, Math.max(1, Math.floor(Number(limit) || 100))),
			).toArray();
		},

		deadLetters: async (limit) => {
			await readyPromise;
			return sql.exec<DeadRow>(
				"SELECT event_id, stream, attempts, error, at FROM _dead ORDER BY at DESC LIMIT ?",
				Math.min(500, Math.max(1, Math.floor(Number(limit) || 100))),
			).toArray();
		},

		breaker: async () => {
			await readyPromise;
			return breaker.status();
		},

		resetBreaker: async (by) => {
			await readyPromise;
			const before = breaker.view();
			breaker.reset();
			writeConsole(
				"info",
				`[ext ${scopeOf().installationId}] circuit breaker reset by ${by} (was ${before.state})`,
			);
			return breaker.status();
		},

		deleteData: async () => {
			await readyPromise;
			await mutex.run(async () => {
				const pending = [...activations.values()];
				activations.clear();
				snapshotCache = null;
				for (const started of pending) {
					started.then((pkg) => pkg.runtime.abort("deleted"), () => undefined);
				}
				// A facet's own database goes with the host's.
				await deps.packages.purge?.();
				await storage.deleteAll();
				migrateHostTables(storage, clock);
				readyPromise = timers.init();
				await readyPromise;
			});
		},

		alarm: async () => {
			await readyPromise;
			breaker.convertStale(live);
			await timers.runDue({ host: onHostTimer, ext: onExtTimer });
		},
	};
	return host;
};
