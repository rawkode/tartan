// Deno test helpers for extension authors and for the kernel's own unit tests
// (WP7b). TEST-ONLY: this module imports `node:sqlite`, which workerd does not
// provide, so Worker code must never import it (only `*.test.ts` files do).
//
// - `createMemoryStorage()`: the subset of a SQLite-backed Durable Object's
//   storage the extension host uses (`sql.exec` cursors, `databaseSize`,
//   nested `transactionSync`, synchronous `kv`, the alarm, `sync`,
//   `deleteAll`), on an in-memory `node:sqlite` database.
// - `createTestCaps()`: a recording `KernelCaps` that enforces the contract's
//   per-method policy (`capsDenial`: grants, shadow, read-only) and answers
//   from caller-supplied handlers. It does not model K12 confinement or actor
//   roles; the kernel's `createKernelCaps` does (WP1's FakeKernelCaps is the
//   full fake).
// - `createTestHarness()`: runs one extension module the way the builtin host
//   does: migrations once, `init` once, a fresh `ExtCtx` per call with the
//   guarded `sql` (read-only for render and context), `validateUi` on renders
//   (error chip on failure), `validateActionResult` on actions,
//   `GateDecisionSchema` on gates and `sanitizeEchoLines` on echo.

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
	type ActionResult,
	type Actor,
	CAPS_METHOD_POLICY,
	capsDenial,
	type CapsMethod,
	type ContextRequest,
	type ContextSection,
	ContextSectionSchema,
	createUlid,
	denied,
	type Envelope,
	type ExtCtx,
	type ExtensionModule,
	type ExtMigration,
	type FieldNode,
	type FieldValue,
	type FormNode,
	type GateDecision,
	GateDecisionSchema,
	type GateInput,
	type GatePoint,
	type HostUiDoc,
	type InstallInfo,
	type InstallMode,
	INTERFACE_TOOLS,
	internal,
	type KernelCaps,
	type Kv,
	type Logger,
	type ManifestPermissions,
	notImplemented,
	type PrefetchedInputs,
	sanitizeEchoLines,
	type SlotContext,
	type SqlRow,
	type SqlValue,
	type ToolContext,
	uiOrErrorChip,
	validateActionResult,
} from "@tartan/contract";
import {
	createGuardedSql,
	scanSql,
	type SqlCursorLike,
	type SqlStorageLike,
} from "./sqlguard.ts";

// ---------------------------------------------------------------------------
// In-memory Durable Object storage
// ---------------------------------------------------------------------------

type KvEntry = { readonly key: string; readonly value: unknown };

/** `SyncKvStorage` subset (the DO's synchronous kv). */
export type MemoryKv = {
	get<T = unknown>(key: string): T | undefined;
	put<T>(key: string, value: T): void;
	delete(key: string): boolean;
	list<T = unknown>(
		options?: {
			readonly prefix?: string;
			readonly start?: string;
			readonly limit?: number;
		},
	): Iterable<[string, T]>;
};

export type MemoryStorage = {
	readonly sql: SqlStorageLike;
	readonly kv: MemoryKv;
	transactionSync<T>(fn: () => T): T;
	getAlarm(): Promise<number | null>;
	setAlarm(at: number | Date): Promise<void>;
	deleteAlarm(): Promise<void>;
	sync(): Promise<void>;
	deleteAll(): Promise<void>;
	/** The underlying database (assertions only). */
	readonly db: DatabaseSync;
	/** Number of `sync()` calls (write-ahead marker tests). */
	readonly syncs: number;
	close(): void;
};

const toSqlValue = (value: unknown): SqlValue => {
	if (value instanceof Uint8Array) {
		return value.buffer.slice(
			value.byteOffset,
			value.byteOffset + value.byteLength,
		) as ArrayBuffer;
	}
	if (typeof value === "bigint") return Number(value);
	if (value === undefined) return null;
	return value as SqlValue;
};

const toBinding = (value: SqlValue): SQLInputValue =>
	value instanceof ArrayBuffer ? new Uint8Array(value) : value;

const plainRow = <T>(row: Record<string, unknown>): T =>
	Object.fromEntries(
		Object.entries(row).map(([k, v]) => [k, toSqlValue(v)]),
	) as T;

const memoryCursor = <T>(
	rows: T[],
	rowsWritten: number,
): SqlCursorLike<T> => ({
	toArray: () => [...rows],
	one: () => {
		if (rows.length !== 1) {
			throw new Error(
				`Expected exactly one result from SQL query, got ${rows.length}`,
			);
		}
		return rows[0];
	},
	rowsRead: rows.length,
	rowsWritten,
	[Symbol.iterator]: () => rows[Symbol.iterator](),
});

/**
 * In-memory stand-in for `DurableObjectStorage` (see the header). `kv` lives
 * in a Map and is not rolled back by `transactionSync` (the real DO kv is).
 */
export const createMemoryStorage = (): MemoryStorage => {
	const db = new DatabaseSync(":memory:");
	const kv = new Map<string, unknown>();
	let alarm: number | null = null;
	let depth = 0;
	let syncs = 0;

	const totalChanges = (): number =>
		Number(
			(db.prepare("SELECT total_changes() AS n").get() as { n: number }).n,
		);

	const execOne = <T>(text: string, bindings: readonly SqlValue[]) => {
		const statement = db.prepare(text);
		const before = totalChanges();
		const rows = statement.columns().length > 0
			? statement.all(...bindings.map(toBinding)).map((r) =>
				plainRow<T>(r as Record<string, unknown>)
			)
			: (statement.run(...bindings.map(toBinding)), []);
		return memoryCursor<T>(rows, totalChanges() - before);
	};

	const sql: SqlStorageLike = {
		exec: <T extends Record<string, SqlValue>>(
			query: string,
			...bindings: SqlValue[]
		): SqlCursorLike<T> => {
			const scan = scanSql(query);
			if (!scan.ok) throw new Error(`SQL: ${scan.error}`);
			const parts = scan.statements.map((s) =>
				query.slice(s.span[0], s.span[1])
			);
			if (parts.length === 0) throw new Error("SQL: empty statement");
			if (parts.length > 1 && bindings.length > 0) {
				throw new Error(
					"memory storage: bindings with several statements are not supported",
				);
			}
			let last = memoryCursor<T>([], 0);
			let written = 0;
			for (const part of parts) {
				last = execOne<T>(part, bindings);
				written += last.rowsWritten;
			}
			return memoryCursor<T>(last.toArray(), written);
		},
		get databaseSize(): number {
			const pages = db.prepare("PRAGMA page_count").get() as {
				page_count: number;
			};
			const size = db.prepare("PRAGMA page_size").get() as {
				page_size: number;
			};
			return Number(pages.page_count) * Number(size.page_size);
		},
	};

	const memoryKv: MemoryKv = {
		get: <T>(key: string) =>
			kv.has(key) ? structuredClone(kv.get(key)) as T : undefined,
		put: (key, value) => {
			kv.set(key, structuredClone(value));
		},
		delete: (key) => kv.delete(key),
		list: <T>(
			options: { prefix?: string; start?: string; limit?: number } = {},
		) => {
			const entries: KvEntry[] = [...kv.entries()]
				.map(([key, value]) => ({ key, value }))
				.filter((e) =>
					options.prefix === undefined || e.key.startsWith(options.prefix)
				)
				.filter((e) => options.start === undefined || e.key >= options.start)
				.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
				.slice(0, options.limit ?? Number.MAX_SAFE_INTEGER);
			return entries.map((e) => [e.key, structuredClone(e.value) as T]);
		},
	};

	const transactionSync = <T>(fn: () => T): T => {
		depth += 1;
		const name = `tx${depth}`;
		db.exec(`SAVEPOINT ${name}`);
		try {
			const out = fn();
			if (out instanceof Promise) {
				throw new Error("transactionSync callback must be synchronous");
			}
			db.exec(`RELEASE ${name}`);
			return out;
		} catch (error) {
			db.exec(`ROLLBACK TO ${name}`);
			db.exec(`RELEASE ${name}`);
			throw error;
		} finally {
			depth -= 1;
		}
	};

	return {
		sql,
		kv: memoryKv,
		transactionSync,
		getAlarm: () => Promise.resolve(alarm),
		setAlarm: (at) => {
			alarm = at instanceof Date ? at.getTime() : at;
			return Promise.resolve();
		},
		deleteAlarm: () => {
			alarm = null;
			return Promise.resolve();
		},
		sync: () => {
			syncs += 1;
			return Promise.resolve();
		},
		deleteAll: () => {
			const tables = db.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
			).all() as { name: string }[];
			for (const { name } of tables) db.exec(`DROP TABLE IF EXISTS "${name}"`);
			kv.clear();
			alarm = null;
			return Promise.resolve();
		},
		db,
		get syncs() {
			return syncs;
		},
		close: () => db.close(),
	};
};

/** The ExtCtx `kv` over a synchronous kv store (read-only blocks writes). */
export const kvOver = (store: MemoryKv, readOnly: boolean): Kv => ({
	get: (key) => {
		const value = store.get<unknown>(key);
		if (value === undefined || value === null) return null;
		if (value instanceof Uint8Array) return value;
		if (value instanceof ArrayBuffer) return new Uint8Array(value);
		return null;
	},
	put: (key, value) => {
		if (readOnly) throw denied("read-only", "read-only context: kv.put");
		store.put(key, value);
	},
	delete: (key) => {
		if (readOnly) throw denied("read-only", "read-only context: kv.delete");
		return store.delete(key);
	},
	listKeys: (prefix, limit) =>
		[...store.list({ prefix, limit })].map(([key]) => key),
});

// ---------------------------------------------------------------------------
// Recording KernelCaps
// ---------------------------------------------------------------------------

export type CapsCall = {
	readonly method: CapsMethod;
	readonly args: readonly unknown[];
};

export type CapsHandler = (...args: never[]) => unknown;

export type TestCapsOptions = {
	readonly grants?: ManifestPermissions;
	readonly mode?: InstallMode;
	readonly readOnly?: boolean;
	/** Answers per method; methods without one use the defaults below or throw `not_implemented`. */
	readonly handlers?: Partial<Record<CapsMethod, CapsHandler>>;
	readonly now?: () => number;
	/** Shared recorder (the harness passes one across calls). */
	readonly recorder?: CapsRecorder;
};

export type CapsRecorder = {
	readonly calls: CapsCall[];
	readonly emitted: {
		readonly type: string;
		readonly data: unknown;
		readonly options?: unknown;
	}[];
	readonly timers: Map<string, number>;
	readonly notices: { readonly principal: string; readonly notice: unknown }[];
};

export const createRecorder = (): CapsRecorder => ({
	calls: [],
	emitted: [],
	timers: new Map(),
	notices: [],
});

const NO_GRANTS: ManifestPermissions = { repo: "none" };

/**
 * A `KernelCaps` that checks `CAPS_METHOD_POLICY` per call, records it, and
 * answers from `handlers`. Defaults: `events.emit` records and returns a
 * ULID, `timers.*` and `notify.send` record, `clock.now`/`ids.ulid` work.
 */
export const createTestCaps = (
	options: TestCapsOptions = {},
): { readonly caps: KernelCaps; readonly recorder: CapsRecorder } => {
	const recorder = options.recorder ?? createRecorder();
	const now = options.now ?? (() => Date.now());
	const ulid = createUlid({ now });
	const grants = options.grants ?? NO_GRANTS;
	const defaults: Partial<Record<CapsMethod, (...args: never[]) => unknown>> = {
		"events.emit": (type: string, data: unknown, o?: unknown) => {
			recorder.emitted.push({ type, data, options: o });
			return ulid();
		},
		"timers.set": (key: string, at: number) => {
			recorder.timers.set(key, at);
		},
		"timers.clear": (key: string) => {
			recorder.timers.delete(key);
		},
		"notify.send": (principal: string, notice: unknown) => {
			recorder.notices.push({ principal, notice });
		},
		"clock.now": () => now(),
		"ids.ulid": () => ulid(),
	};
	const call = (
		method: CapsMethod,
		args: unknown[],
	): Promise<unknown> | unknown => {
		const mutatingTool = method === "interfaces.call"
			? INTERFACE_TOOLS[String(args[1])]?.def.mutating ?? true
			: undefined;
		const reason = capsDenial(method, {
			grants,
			mode: options.mode ?? "enforce",
			readOnly: options.readOnly ?? false,
			mutatingTool,
		});
		if (reason !== null) throw denied(reason, `${method}: ${reason}`);
		recorder.calls.push({ method, args });
		const handler = options.handlers?.[method] ?? defaults[method];
		if (handler === undefined) {
			throw notImplemented(`test caps: no handler for ${method}`);
		}
		return (handler as (...a: unknown[]) => unknown)(...args);
	};
	const caps: Record<string, Record<string, unknown>> = {};
	for (const method of Object.keys(CAPS_METHOD_POLICY) as CapsMethod[]) {
		const [ns, name] = method.split(".");
		caps[ns] ??= {};
		const sync = method === "clock.now" || method === "ids.ulid";
		caps[ns][name] = sync
			? (...args: unknown[]) => call(method, args)
			: async (...args: unknown[]) => await call(method, args);
	}
	return { caps: caps as unknown as KernelCaps, recorder };
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export type LogLine = {
	readonly level: "debug" | "info" | "warn" | "error";
	readonly msg: string;
	readonly data?: unknown;
};

export type HarnessOptions = {
	readonly module: ExtensionModule;
	readonly migrations?: readonly ExtMigration[];
	readonly grants?: ManifestPermissions;
	readonly config?: unknown;
	readonly install?: Partial<InstallInfo>;
	/** The installation actor (background hooks); default `x_i_<ulid>`. */
	readonly installationActor?: Actor;
	readonly handlers?: Partial<Record<CapsMethod, CapsHandler>>;
	readonly now?: () => number;
	/** Storage quota for the guarded `sql`. */
	readonly quotaBytes?: number;
};

export type CallOptions = {
	readonly actor?: Actor;
	readonly mode?: InstallMode;
};

export type Harness = {
	readonly storage: MemoryStorage;
	readonly recorder: CapsRecorder;
	readonly logs: LogLine[];
	/** A fresh ExtCtx, as the host builds per call. */
	ctx(options?: CallOptions & { readonly readOnly?: boolean }): ExtCtx;
	/** Runs the extension's migrations (idempotent) and `init`. */
	init(): Promise<void>;
	event(ev: Envelope): Promise<void>;
	timer(key: string): Promise<void>;
	render(
		slot: string,
		ctx: SlotContext,
		props?: unknown,
		options?: CallOptions,
	): Promise<HostUiDoc>;
	action(
		action: string,
		payload: unknown,
		ctx: SlotContext,
		options?: CallOptions,
	): Promise<ActionResult>;
	tool(name: string, args: unknown, ctx: ToolContext): Promise<unknown>;
	context(req: ContextRequest): Promise<ContextSection[]>;
	gate(point: GatePoint, input: GateInput): Promise<GateDecision>;
	echo(ev: Envelope, input: PrefetchedInputs): Promise<string[]>;
	close(): void;
};

const DEFAULT_INSTALL: InstallInfo = {
	id: "i_01k6aaaaaaaaaaaaaaaaaaaaaa",
	extId: "acme.test",
	version: "0.0.0",
	node: { id: "01k6aaaaaaaaaaaaaaaaaaaaab", path: "acme" },
	scopeKey: "node",
	mode: "enforce",
};

/** Runs an extension module in memory, the way the builtin host does (see the header). */
export const createTestHarness = (options: HarnessOptions): Harness => {
	const storage = createMemoryStorage();
	const recorder = createRecorder();
	const logs: LogLine[] = [];
	const install: InstallInfo = { ...DEFAULT_INSTALL, ...options.install };
	const installationActor: Actor = options.installationActor ??
		{ kind: "ext", id: `x_${install.id}` };
	const module = options.module;
	let initialized = false;

	const logger: Logger = {
		debug: (msg, data) => logs.push({ level: "debug", msg, data }),
		info: (msg, data) => logs.push({ level: "info", msg, data }),
		warn: (msg, data) => logs.push({ level: "warn", msg, data }),
		error: (msg, data) => logs.push({ level: "error", msg, data }),
	};

	const ctx = (
		call: CallOptions & { readonly readOnly?: boolean } = {},
	): ExtCtx => {
		const readOnly = call.readOnly ?? false;
		const mode = call.mode ?? install.mode;
		const { caps } = createTestCaps({
			grants: options.grants,
			mode,
			readOnly,
			handlers: options.handlers,
			now: options.now,
			recorder,
		});
		return {
			caps,
			sql: createGuardedSql(storage, {
				readOnly,
				quotaBytes: options.quotaBytes,
			}),
			kv: kvOver(storage.kv, readOnly),
			config: options.config ?? {},
			log: logger,
			install: { ...install, mode },
			actor: call.actor ?? installationActor,
			readOnly,
		};
	};

	const init = async (): Promise<void> => {
		if (initialized) return;
		storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS _ext_migrations (n INTEGER PRIMARY KEY, name TEXT NOT NULL, at INTEGER NOT NULL)",
		);
		const applied = new Set(
			storage.sql.exec<{ n: number }>("SELECT n FROM _ext_migrations")
				.toArray().map((r) => r.n),
		);
		const guarded = createGuardedSql(storage, { readOnly: false });
		for (const m of options.migrations ?? []) {
			if (applied.has(m.n)) continue;
			storage.transactionSync(() => {
				guarded.exec(m.sql);
				storage.sql.exec(
					"INSERT INTO _ext_migrations (n, name, at) VALUES (?, ?, ?)",
					m.n,
					m.name,
					(options.now ?? Date.now)(),
				);
			});
		}
		await module.init?.(ctx());
		initialized = true;
	};

	const requireHook = <K extends keyof ExtensionModule>(
		hook: K,
	): NonNullable<ExtensionModule[K]> => {
		const fn = module[hook];
		if (fn === undefined) throw internal(`extension has no ${hook} hook`);
		return fn as NonNullable<ExtensionModule[K]>;
	};

	return {
		storage,
		recorder,
		logs,
		ctx,
		init,
		event: async (ev) => {
			await init();
			await requireHook("onEvent")(ev, ctx());
		},
		timer: async (key) => {
			await init();
			await requireHook("onTimer")(key, ctx());
		},
		render: async (slot, slotCtx, props, call) => {
			await init();
			try {
				const out = await requireHook("render")(
					slot,
					slotCtx,
					props,
					ctx({ ...call, readOnly: true }),
				);
				return uiOrErrorChip(out, install.extId);
			} catch (error) {
				logs.push({
					level: "error",
					msg: "render failed",
					data: String(error),
				});
				return uiOrErrorChip(undefined, install.extId);
			}
		},
		action: async (name, payload, slotCtx, call) => {
			await init();
			const out = await requireHook("onAction")(
				name,
				payload,
				slotCtx,
				ctx(call),
			);
			const checked = validateActionResult(out);
			if (!checked.ok) {
				throw internal(`invalid action result: ${checked.errors.join("; ")}`);
			}
			return checked.result;
		},
		tool: async (name, args, toolCtx) => {
			await init();
			return await requireHook("callTool")(
				name,
				args,
				toolCtx,
				ctx({ actor: toolCtx.actor, mode: toolCtx.mode }),
			);
		},
		context: async (req) => {
			await init();
			const out = await requireHook("context")(
				req,
				ctx({ actor: req.actor, readOnly: true }),
			);
			return out.filter((s) => ContextSectionSchema.safeParse(s).success);
		},
		gate: async (point, input) => {
			await init();
			const out = await requireHook("gate")(point, input, ctx());
			const parsed = GateDecisionSchema.safeParse(out);
			if (!parsed.success) throw internal("invalid gate decision");
			return parsed.data;
		},
		echo: async (ev, input) => {
			await init();
			const out = await requireHook("echo")(ev, input, ctx());
			return sanitizeEchoLines(
				install.extId.split(".").pop() ?? install.extId,
				out,
			);
		},
		close: () => storage.close(),
	};
};

/** Rows of a raw query on the harness database (assertions only). */
export const rows = <T extends SqlRow = SqlRow>(
	storage: MemoryStorage,
	query: string,
	...bindings: SqlValue[]
): T[] => storage.sql.exec<T>(query, ...bindings).toArray();

// ---------------------------------------------------------------------------
// Forms (the tartan-ui@1 submit convention, `ui.form`)
// ---------------------------------------------------------------------------

const isNode = (value: unknown): value is { t: string } =>
	typeof value === "object" && value !== null && !Array.isArray(value) &&
	typeof (value as { t?: unknown }).t === "string";

const walk = (value: unknown, visit: (node: { t: string }) => void): void => {
	if (Array.isArray(value)) {
		for (const item of value) walk(item, visit);
	} else if (typeof value === "object" && value !== null) {
		if (isNode(value)) visit(value);
		for (const child of Object.values(value)) walk(child, visit);
	}
};

/** Every `form` node of a rendered document, in document order. */
export const formsIn = (doc: unknown): FormNode[] => {
	const forms: FormNode[] = [];
	walk(doc, (node) => {
		if (node.t === "form") forms.push(node as FormNode);
	});
	return forms;
};

const FIELD_TYPES: ReadonlySet<string> = new Set([
	"input",
	"textarea",
	"select",
	"checkbox",
]);

/** A field's value before the viewer edits it (as the SPA's form shows it). */
const initialValue = (field: FieldNode): FieldValue => {
	const v = field.value;
	if (field.t === "checkbox") return v === true;
	if (field.t === "select") {
		if (v !== undefined && v !== null && !Array.isArray(v)) return v;
		const first = field.options?.[0];
		return first === undefined
			? null
			: typeof first === "object"
			? first.value
			: first;
	}
	return typeof v === "string" || typeof v === "number" ? v : "";
};

/**
 * What the host posts when `form` is submitted with `values` typed in: the
 * action id, and the field values by name at the TOP LEVEL (each field's
 * initial value unless `values` names it) with the action's own payload
 * merged over them; a non-object action payload travels as `payload`.
 */
export const formSubmission = (
	form: FormNode,
	values: Readonly<Record<string, FieldValue>> = {},
): { readonly action: string; readonly payload: Record<string, unknown> } => {
	const fields: Record<string, unknown> = {};
	walk(form.fields, (node) => {
		if (FIELD_TYPES.has(node.t)) {
			const field = node as FieldNode;
			fields[field.name] = Object.hasOwn(values, field.name)
				? values[field.name]
				: initialValue(field);
		}
	});
	const own = form.submit.action.payload;
	const base = typeof own === "object" && own !== null && !Array.isArray(own)
		? own as Record<string, unknown>
		: own === undefined
		? {}
		: { payload: own };
	return { action: form.submit.action.id, payload: { ...fields, ...base } };
};
