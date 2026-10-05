// The runtime core of `js` and `wasm` extensions: one call of one hook against
// the extension's own storage.
//
// `facetCore` is SELF-CONTAINED: it references nothing outside its own body
// (no imports at run time, no module-level names), because its source text
// (`facetCore.toString()`) is shipped into every Dynamic Worker facet by the
// shim (shim.ts). The host also calls it in-process for the `wasm-bundled`
// fallback. Types are erased, so `import type` is fine.
//
// Per call it builds what the extension sees:
// - `js`: an `ExtCtx` whose `caps` forward every method over the per-call
//   capability bridge (the host's own `KernelCaps` for this call; `clock`
//   and `ids` answer locally, synchronously), with `sql`/`kv` on the given
//   storage and a buffered log;
// - `wasm`: the WIT imports (`sql`, `kv`, `host`, `effects`) for a fresh
//   component instance (one per call: a trap never poisons the next call,
//   and no state survives between calls but SQLite and kv). Effects are
//   buffered and returned; the host applies them through the kernel's
//   capabilities after the export returned OK.
// Read-only calls (render, context) run `sql` SELECT-only and refuse every
// effect with `denied("read-only")`.
//
// Errors cross the facet boundary as data (`{code, reason, text}`): custom
// properties may not survive Workers RPC.

import type {
	Actor,
	Envelope,
	ExtMigration,
	GateDecision,
	InstallInfo,
} from "@tartan/contract";

/** What the host passes with every call. */
export type CallEnv = {
	readonly method: string;
	readonly readOnly: boolean;
	readonly install: InstallInfo;
	readonly actor: Actor;
	readonly config: unknown;
	/** The host clock at the start of the call (`now-ms`, `caps.clock.now`). */
	readonly now: number;
	/** `storage.quotaMB` in bytes. */
	readonly quotaBytes: number;
	/** Manifest grants the effects check at once. */
	readonly grants: { readonly notify: boolean; readonly notes: boolean };
	/** The repo of a repo-scoped installation (gates and tools default to it). */
	readonly repo?: string;
};

export type ErrorData = {
	readonly code: string;
	readonly text: string;
	readonly reason?: string;
	readonly details?: Record<string, unknown>;
};

export type LogLine = { readonly level: string; readonly msg: string };

/** A buffered `effects` import, applied by the host after an OK export. */
export type Effect =
	| {
		readonly kind: "emit";
		readonly type: string;
		readonly subject?: { readonly kind: string; readonly id: string };
		readonly data: unknown;
	}
	| {
		readonly kind: "notify";
		readonly principal: string;
		readonly notice: {
			readonly kind: string;
			readonly severity: string;
			readonly text: string;
			readonly data?: unknown;
			readonly dedupeKey?: string;
			readonly repo?: string;
			readonly lane?: string;
		};
	}
	| {
		readonly kind: "note";
		readonly changeId: string;
		readonly section: unknown;
	}
	| { readonly kind: "timer"; readonly key: string; readonly atMs: number };

export type CallOutcome =
	| {
		readonly ok: true;
		readonly value: unknown;
		readonly logs: readonly LogLine[];
		readonly effects: readonly Effect[];
		readonly dbSize?: number;
	}
	| {
		readonly ok: false;
		readonly error: ErrorData;
		readonly logs: readonly LogLine[];
		readonly dbSize?: number;
	};

/** The storage a call runs against (a facet's `ctx.storage`, or the host's guarded handles). */
export type CoreSql = {
	exec(query: string, ...bindings: unknown[]): {
		toArray(): Record<string, unknown>[];
		one?(): Record<string, unknown>;
		readonly rowsRead?: number;
		readonly rowsWritten: number;
		readonly columnNames?: readonly string[];
		raw?(): { toArray(): unknown[][] };
	};
	readonly databaseSize?: number;
};

export type CoreStorage = {
	readonly sql: CoreSql;
	readonly kv: {
		get(key: string): unknown;
		put(key: string, value: unknown): void;
		delete(key: string): boolean;
		list(options?: { prefix?: string; limit?: number }): Iterable<
			[string, unknown]
		>;
	};
	transactionSync<T>(fn: () => T): T;
};

/** The jco glue (`--instantiation sync`) and its core modules. */
export type WasmProgram = {
	readonly kind: "wasm";
	readonly instantiate: (
		getCoreModule: (path: string) => WebAssembly.Module,
		imports: Record<string, unknown>,
	) => Record<string, (...args: unknown[]) => unknown>;
	readonly getCoreModule: (path: string) => WebAssembly.Module;
};

export type JsProgram = {
	readonly kind: "js";
	/** The package's module (its default export, else its `extension` export). */
	readonly module: Record<string, unknown>;
};

export type Program = WasmProgram | JsProgram;

/** The capability bridge: `call("repo.readFile", args)` on the host's per-call caps. */
export type CapsBridge = {
	call(
		path: string,
		args: unknown[],
	): Promise<
		| { readonly ok: true; readonly value: unknown }
		| { readonly ok: false; readonly error: ErrorData }
	>;
};

export function facetCore() {
	// ---------------------------------------------------------------------------
	// Errors
	// ---------------------------------------------------------------------------

	const ERROR_CODES = [
		"invalid",
		"unauthenticated",
		"denied",
		"not_found",
		"conflict",
		"stale",
		"rate_limited",
		"unavailable",
		"timeout",
		"not_implemented",
		"setup_required",
		"protocol_mismatch",
		"internal",
	];

	/** A structural TartanError (`isTartanError` accepts it; RPC flattens it anyway). */
	const tartanError = (
		code: string,
		text: string,
		reason?: string,
		details?: Record<string, unknown>,
	): Error => {
		const error = new Error(`${code}${reason ? `(${reason})` : ""}: ${text}`);
		Object.defineProperty(error, "name", { value: "TartanError" });
		return Object.assign(error, { code, reason, details, text });
	};

	const MESSAGE_PREFIX = /^([a-z_]+)(?:\(([^)]*)\))?: ([\s\S]*)$/;

	const errorData = (error: unknown): ErrorData => {
		if (error !== null && typeof error === "object") {
			const e = error as Record<string, unknown>;
			if (
				typeof e.code === "string" && ERROR_CODES.includes(e.code) &&
				(typeof e.text === "string" || typeof e.message === "string")
			) {
				const text = typeof e.text === "string"
					? e.text
					: String(e.message).replace(MESSAGE_PREFIX, "$3");
				return {
					code: e.code,
					text,
					...(typeof e.reason === "string" ? { reason: e.reason } : {}),
					...(e.details !== null && typeof e.details === "object"
						? { details: e.details as Record<string, unknown> }
						: {}),
				};
			}
		}
		const message = error instanceof Error
			? error.message
			: typeof error === "string"
			? error
			: "unknown error";
		const match = MESSAGE_PREFIX.exec(message);
		if (match !== null && ERROR_CODES.includes(match[1])) {
			return {
				code: match[1],
				text: match[3],
				...(match[2] ? { reason: match[2] } : {}),
			};
		}
		return { code: "internal", text: message };
	};

	const denied = (reason: string, text = reason) =>
		tartanError("denied", text, reason);
	const invalid = (text: string) => tartanError("invalid", text);

	// ---------------------------------------------------------------------------
	// SQL (a facet's own database): the statement guard of `@tartan/ext-api`'s
	// sqlguard, reduced to what a database without host tables needs.
	// ---------------------------------------------------------------------------

	const ALLOWED_FIRST = [
		"SELECT",
		"WITH",
		"VALUES",
		"INSERT",
		"UPDATE",
		"DELETE",
		"REPLACE",
		"CREATE",
		"DROP",
		"ALTER",
	];
	const READ_FIRST = ["SELECT", "WITH", "VALUES"];
	const WRITE_WORDS = [
		"INSERT",
		"UPDATE",
		"DELETE",
		"CREATE",
		"DROP",
		"ALTER",
		"ATTACH",
		"DETACH",
		"PRAGMA",
		"VACUUM",
		"REINDEX",
		"ANALYZE",
		"BEGIN",
		"COMMIT",
		"ROLLBACK",
		"SAVEPOINT",
		"RELEASE",
	];
	const GROWING = ["INSERT", "UPDATE", "REPLACE", "CREATE", "ALTER"];
	const RESERVED_NAME = /^(?:_|sqlite_|pragma_)/i;

	type Scan = {
		/** Uppercased bare words, in order. */
		readonly words: string[];
		/** Every identifier or string literal (bare or quoted). */
		readonly names: string[];
		/** The first bare word of each statement. */
		readonly firsts: string[];
		readonly statements: number;
	};

	/** Words, names and statement count of a query (quotes and comments aware). */
	const scanSql = (query: string): Scan => {
		const words: string[] = [];
		const names: string[] = [];
		const firsts: string[] = [];
		let statements = 0;
		let first = false;
		let open = false;
		let i = 0;
		const n = query.length;
		const isWord = (c: string) => /[A-Za-z0-9_$]/.test(c);
		while (i < n) {
			const c = query[i];
			if (c === "-" && query[i + 1] === "-") {
				while (i < n && query[i] !== "\n") i++;
				continue;
			}
			if (c === "/" && query[i + 1] === "*") {
				const end = query.indexOf("*/", i + 2);
				i = end === -1 ? n : end + 2;
				continue;
			}
			if (c === "'" || c === '"' || c === "`" || c === "[") {
				const close = c === "[" ? "]" : c;
				let j = i + 1;
				let text = "";
				while (j < n) {
					if (query[j] === close) {
						if (close !== "]" && query[j + 1] === close) {
							text += close;
							j += 2;
							continue;
						}
						break;
					}
					text += query[j];
					j++;
				}
				names.push(text);
				if (!open) {
					open = true;
					statements += 1;
				}
				i = j + 1;
				continue;
			}
			if (c === ";") {
				open = false;
				first = false;
				i++;
				continue;
			}
			if (isWord(c)) {
				let j = i;
				while (j < n && isWord(query[j])) j++;
				const word = query.slice(i, j);
				words.push(word.toUpperCase());
				names.push(word);
				if (!open) {
					open = true;
					statements += 1;
				}
				if (!first) {
					first = true;
					firsts.push(word.toUpperCase());
				}
				i = j;
				continue;
			}
			if (!/\s/.test(c) && !open) {
				open = true;
				statements += 1;
			}
			i++;
		}
		return { words, names, firsts, statements };
	};

	const toBinding = (value: unknown): unknown => {
		if (typeof value === "bigint") {
			if (
				value > BigInt(Number.MAX_SAFE_INTEGER) ||
				value < BigInt(Number.MIN_SAFE_INTEGER)
			) {
				throw invalid("SQL: an integer binding beyond 2^53");
			}
			return Number(value);
		}
		if (value instanceof Uint8Array) {
			return value.buffer.slice(
				value.byteOffset,
				value.byteOffset + value.byteLength,
			);
		}
		if (typeof value === "boolean") return value ? 1 : 0;
		if (value === undefined) return null;
		return value;
	};

	type Cursor = ReturnType<CoreSql["exec"]>;

	const arrayCursor = (
		rows: Record<string, unknown>[],
		columns: readonly string[],
		raw: unknown[][],
		written: number,
	): Cursor => ({
		toArray: () => rows,
		one: () => {
			if (rows.length !== 1) {
				throw invalid(`SQL: expected exactly one row, got ${rows.length}`);
			}
			return rows[0];
		},
		rowsRead: rows.length,
		rowsWritten: written,
		columnNames: columns,
		raw: () => ({ toArray: () => raw }),
		[Symbol.iterator]: () => rows[Symbol.iterator](),
	} as Cursor);

	/** Materializes a storage cursor (rows, columns, raw values, rows written). */
	const materialize = (cursor: Cursor): Cursor => {
		if (typeof cursor.raw === "function" && cursor.columnNames !== undefined) {
			const columns = [...cursor.columnNames];
			const raw = cursor.raw().toArray().map((r) => [...r]);
			const rows = raw.map((r) =>
				Object.fromEntries(columns.map((c, k) => [c, r[k]]))
			);
			return arrayCursor(rows, columns, raw, cursor.rowsWritten);
		}
		const rows = cursor.toArray();
		const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
		const raw = rows.map((r) => columns.map((c) => r[c]));
		return arrayCursor(rows, columns, raw, cursor.rowsWritten);
	};

	/**
	 * The extension's `sql` over a facet's own storage: DML and DDL only, no
	 * `_`/`sqlite_`/`pragma_` names (`_ext_migrations` lives there), one
	 * read in a read-only call (rolled back if it wrote after all), and no
	 * growth above the quota.
	 */
	const facetSql = (
		storage: CoreStorage,
		options: { readonly readOnly: boolean; readonly quotaBytes: number },
	) => {
		const exec = (query: string, ...bindings: unknown[]): Cursor => {
			if (typeof query !== "string" || query.trim() === "") {
				throw invalid("SQL: empty statement");
			}
			const scan = scanSql(query);
			const first = scan.firsts[0] ?? "";
			const refused = scan.firsts.find((w) => !ALLOWED_FIRST.includes(w));
			if (scan.firsts.length === 0 || refused !== undefined) {
				throw invalid(`SQL: ${refused ?? "this statement"} is not allowed`);
			}
			const reserved = scan.names.find((name) => RESERVED_NAME.test(name));
			if (reserved !== undefined) {
				throw denied(
					"scope",
					`SQL: names starting with _, sqlite_ or pragma_ are reserved (${reserved})`,
				);
			}
			const values = bindings.map(toBinding);
			if (options.readOnly) {
				if (
					!READ_FIRST.includes(first) || scan.statements !== 1 ||
					scan.words.some((w) => WRITE_WORDS.includes(w))
				) {
					throw denied("read-only", "read-only context: SELECT only");
				}
				return storage.transactionSync(() => {
					const cursor = materialize(storage.sql.exec(query, ...values));
					if (cursor.rowsWritten > 0) {
						throw denied("read-only", "read-only context: the statement wrote");
					}
					return cursor;
				});
			}
			const growing = scan.words.some((w) => GROWING.includes(w));
			const size = storage.sql.databaseSize ?? 0;
			if (growing && size > options.quotaBytes) {
				throw tartanError("denied", "storage quota exceeded", "quota", {
					size,
					quotaBytes: options.quotaBytes,
				});
			}
			return materialize(storage.sql.exec(query, ...values));
		};
		return {
			exec,
			transaction: <T>(fn: () => T): T => storage.transactionSync(fn),
		};
	};

	/** The extension's `kv` over a facet's own storage (Uint8Array values). */
	const facetKv = (storage: CoreStorage, readOnly: boolean) => {
		const check = (key: unknown): string => {
			if (typeof key !== "string" || key.length === 0 || key.length > 1024) {
				throw invalid("kv key: 1–1024 characters");
			}
			return key;
		};
		const bytes = (value: unknown): Uint8Array | null =>
			value instanceof Uint8Array
				? value
				: value instanceof ArrayBuffer
				? new Uint8Array(value)
				: null;
		return {
			get: (key: string) => bytes(storage.kv.get(check(key))),
			put: (key: string, value: Uint8Array) => {
				check(key);
				if (readOnly) throw denied("read-only", "read-only context: kv.put");
				if (!(value instanceof Uint8Array)) {
					throw invalid("kv values are Uint8Array");
				}
				storage.kv.put(key, value);
			},
			delete: (key: string) => {
				check(key);
				if (readOnly) {
					throw denied("read-only", "read-only context: kv.delete");
				}
				return storage.kv.delete(key);
			},
			listKeys: (prefix: string, limit: number) =>
				[...storage.kv.list({
					prefix,
					limit: Math.min(1000, Math.max(1, Math.floor(Number(limit) || 1))),
				})].map(([key]) => key),
		};
	};

	// ---------------------------------------------------------------------------
	// Migrations (forward-only, recorded in `_ext_migrations`)
	// ---------------------------------------------------------------------------

	const migrate = (
		storage: CoreStorage,
		migrations: readonly ExtMigration[],
		now: number,
	): number[] => {
		storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS _ext_migrations (n INTEGER PRIMARY KEY, name TEXT NOT NULL, at INTEGER NOT NULL)",
		);
		const applied = new Set(
			storage.sql.exec("SELECT n FROM _ext_migrations").toArray().map((r) =>
				Number(r.n)
			),
		);
		const guarded = facetSql(storage, {
			readOnly: false,
			quotaBytes: Number.MAX_SAFE_INTEGER,
		});
		const done: number[] = [];
		for (const m of [...migrations].sort((a, b) => a.n - b.n)) {
			if (applied.has(m.n)) continue;
			storage.transactionSync(() => {
				for (const statement of splitStatements(m.sql)) {
					guarded.exec(statement);
				}
				storage.sql.exec(
					"INSERT INTO _ext_migrations (n, name, at) VALUES (?, ?, ?)",
					m.n,
					m.name,
					now,
				);
			});
			done.push(m.n);
		}
		return done;
	};

	/** Splits a migration file on `;` outside quotes and comments. */
	const splitStatements = (sql: string): string[] => {
		const out: string[] = [];
		let current = "";
		let i = 0;
		while (i < sql.length) {
			const c = sql[i];
			if (c === "-" && sql[i + 1] === "-") {
				while (i < sql.length && sql[i] !== "\n") i++;
				continue;
			}
			if (c === "/" && sql[i + 1] === "*") {
				const end = sql.indexOf("*/", i + 2);
				i = end === -1 ? sql.length : end + 2;
				continue;
			}
			if (c === "'" || c === '"' || c === "`" || c === "[") {
				const close = c === "[" ? "]" : c;
				let j = i + 1;
				while (j < sql.length && sql[j] !== close) j++;
				current += sql.slice(i, j + 1);
				i = j + 1;
				continue;
			}
			if (c === ";") {
				if (current.trim() !== "") out.push(current.trim());
				current = "";
				i++;
				continue;
			}
			current += c;
			i++;
		}
		if (current.trim() !== "") out.push(current.trim());
		return out;
	};

	// ---------------------------------------------------------------------------
	// ULIDs and entropy (a facet has crypto; wasm32-unknown-unknown has none)
	// ---------------------------------------------------------------------------

	const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
	const ulidFactory = (clock: () => number) => {
		let lastTime = -1;
		let last: number[] = [];
		return (): string => {
			const time = Math.max(0, Math.floor(clock()));
			let random: number[];
			if (time === lastTime) {
				random = [...last];
				let k = random.length - 1;
				while (k >= 0 && random[k] === 31) {
					random[k] = 0;
					k--;
				}
				if (k < 0) throw tartanError("internal", "ULID overflow");
				random[k] += 1;
			} else {
				const bytes = crypto.getRandomValues(new Uint8Array(16));
				random = [...bytes].map((b) => b & 31);
			}
			lastTime = time;
			last = random;
			let t = time;
			let head = "";
			for (let k = 0; k < 10; k++) {
				head = CROCKFORD[t % 32] + head;
				t = Math.floor(t / 32);
			}
			return head + random.map((r) => CROCKFORD[r]).join("");
		};
	};

	// ---------------------------------------------------------------------------
	// Logs
	// ---------------------------------------------------------------------------

	const LOG_LINES_MAX = 200;
	const LOG_LEVELS = ["debug", "info", "warn", "error"];

	const createLog = () => {
		const lines: LogLine[] = [];
		const push = (level: string, msg: unknown, data?: unknown) => {
			if (lines.length >= LOG_LINES_MAX) return;
			let suffix = "";
			if (data !== undefined) {
				try {
					suffix = ` ${JSON.stringify(data)}`;
				} catch {
					suffix = " [unserializable]";
				}
			}
			lines.push({
				level: LOG_LEVELS.includes(level) ? level : "info",
				msg: `${String(msg).slice(0, 2048)}${suffix.slice(0, 2048)}`,
			});
		};
		return {
			lines,
			logger: {
				debug: (msg: unknown, data?: unknown) => push("debug", msg, data),
				info: (msg: unknown, data?: unknown) => push("info", msg, data),
				warn: (msg: unknown, data?: unknown) => push("warn", msg, data),
				error: (msg: unknown, data?: unknown) => push("error", msg, data),
			},
			push,
		};
	};

	// ---------------------------------------------------------------------------
	// WIT conversions (jco: records camelCase, options undefined, u64 BigInt,
	// variants {tag, val}, a result error thrown as {payload})
	// ---------------------------------------------------------------------------

	const json = (value: unknown): string =>
		JSON.stringify(value === undefined ? null : value);

	const parseJson = (text: unknown, what: string): unknown => {
		if (typeof text !== "string") {
			throw tartanError("internal", `${what}: not a JSON string`);
		}
		try {
			return JSON.parse(text);
		} catch {
			throw tartanError("internal", `${what}: invalid JSON`);
		}
	};

	const witActor = (a: unknown) => {
		if (a === null || typeof a !== "object") return undefined;
		const actor = a as Record<string, unknown>;
		return {
			kind: String(actor.kind),
			id: String(actor.id),
			onBehalfOf: typeof actor.onBehalfOf === "string"
				? actor.onBehalfOf
				: undefined,
		};
	};

	const witEntity = (e: unknown) => {
		if (e === null || typeof e !== "object") return undefined;
		const entity = e as Record<string, unknown>;
		return { kind: String(entity.kind), id: String(entity.id) };
	};

	const witEvent = (ev: Envelope) => ({
		id: ev.id,
		seq: BigInt(ev.seq),
		kind: ev.type,
		source: ev.source?.kind === "installation"
			? `${ev.source.id}:${ev.source.ext}`
			: "kernel",
		node: ev.node,
		repo: ev.repo,
		subject: witEntity(ev.subject),
		actor: witActor(ev.actor),
		causedBy: ev.causedBy,
		correlation: ev.correlation,
		timeMs: BigInt(ev.at),
		depth: ev.depth,
		shadow: ev.shadow === true,
		data: json(ev.data),
	});

	const SLOT_CONTEXT_FIELDS = [
		"slot",
		"node",
		"repo",
		"ref",
		"path",
		"entity",
		"viewer",
		"actor",
		"mode",
		"extra",
	];

	/** A SlotContext or ToolContext as the WIT `slot-context`. */
	const witSlotContext = (raw: unknown, env: CallEnv) => {
		const ctx = (raw ?? {}) as Record<string, unknown>;
		const extra: Record<string, unknown> = {
			...(ctx.extra !== null && typeof ctx.extra === "object"
				? ctx.extra as Record<string, unknown>
				: {}),
		};
		for (const [k, v] of Object.entries(ctx)) {
			if (!SLOT_CONTEXT_FIELDS.includes(k) && v !== undefined) extra[k] = v;
		}
		const laneId = typeof ctx.laneId === "string" ? ctx.laneId : undefined;
		return {
			slot: typeof ctx.slot === "string" ? ctx.slot : undefined,
			node: typeof ctx.node === "string" ? ctx.node : env.install.node.id,
			repo: typeof ctx.repo === "string" ? ctx.repo : env.repo,
			gitRef: typeof ctx.ref === "string" ? ctx.ref : undefined,
			path: typeof ctx.path === "string" ? ctx.path : undefined,
			entity: witEntity(ctx.entity) ??
				(laneId === undefined ? undefined : { kind: "lane", id: laneId }),
			viewer: witActor(ctx.viewer ?? ctx.actor),
			mode: ctx.mode === "shadow" ? "shadow" : env.install.mode,
			extra: Object.keys(extra).length > 0 ? json(extra) : undefined,
		};
	};

	const fromWitValue = (v: { tag: string; val?: unknown }): unknown => {
		switch (v?.tag) {
			case "null":
				return null;
			case "integer":
				return toBinding(v.val);
			case "real":
				return Number(v.val);
			case "text":
				return String(v.val);
			case "blob":
				return toBinding(v.val);
			default:
				throw invalid(`SQL: unknown value ${String(v?.tag)}`);
		}
	};

	const toWitValue = (v: unknown) => {
		if (v === null || v === undefined) return { tag: "null" };
		if (typeof v === "bigint") return { tag: "integer", val: v };
		if (typeof v === "number") {
			return Number.isInteger(v)
				? { tag: "integer", val: BigInt(v) }
				: { tag: "real", val: v };
		}
		if (typeof v === "string") return { tag: "text", val: v };
		if (v instanceof ArrayBuffer) {
			return { tag: "blob", val: new Uint8Array(v) };
		}
		if (v instanceof Uint8Array) return { tag: "blob", val: v };
		return { tag: "text", val: String(v) };
	};

	const WIT_ERROR_TAGS: Record<string, string> = {
		denied: "denied",
		not_found: "not-found",
		invalid: "invalid",
		conflict: "conflict",
		unavailable: "unavailable",
	};

	/** A host-side error as the WIT `error` an import throws (`{payload}`). */
	const witError = (error: unknown) => {
		const e = errorData(error);
		const tag = WIT_ERROR_TAGS[e.code] ?? "internal";
		return {
			payload: { tag, val: tag === "denied" ? e.reason ?? e.text : e.text },
		};
	};

	/** A WIT `error` an export returned as the TartanError data the host rethrows. */
	const fromWitError = (error: unknown, what: string): ErrorData => {
		const payload = (error as { payload?: { tag?: string; val?: unknown } })
			?.payload;
		if (payload !== undefined && typeof payload?.tag === "string") {
			const val = String(payload.val ?? "");
			switch (payload.tag) {
				case "denied":
					return { code: "denied", reason: val, text: `${what}: ${val}` };
				case "not-found":
					return { code: "not_found", text: val };
				case "invalid":
				case "conflict":
				case "unavailable":
				case "internal":
					return { code: payload.tag, text: val };
			}
		}
		if (error instanceof Error && error.name === "RuntimeError") {
			return { code: "internal", text: `${what}: wasm trap: ${error.message}` };
		}
		return errorData(error);
	};

	// ---------------------------------------------------------------------------
	// One call
	// ---------------------------------------------------------------------------

	/** The extension's storage in one call (a facet's, or the host's guarded handles). */
	type CallSurfaces = {
		readonly sql: {
			exec(query: string, ...bindings: unknown[]): Cursor;
			transaction?<T>(fn: () => T): T;
		};
		readonly kv: {
			get(key: string): Uint8Array | null;
			put(key: string, value: Uint8Array): void;
			delete(key: string): boolean;
			listKeys(prefix: string, limit: number): string[];
		};
		readonly dbSize?: () => number;
	};

	const WASM_EXPORTS: Record<string, string> = {
		init: "init",
		onEvent: "onEvent",
		onTimer: "onTimer",
		gate: "gate",
		echo: "echo",
		render: "render",
		onAction: "onAction",
		callTool: "callTool",
		context: "provideContext",
	};

	/** The WIT imports of one wasm call; effects and log lines are buffered. */
	const witImports = (
		env: CallEnv,
		surfaces: CallSurfaces,
		effects: Effect[],
		log: ReturnType<typeof createLog>,
	) => {
		const ulid = ulidFactory(() => env.now);
		const guard = <T>(fn: () => T): T => {
			try {
				return fn();
			} catch (error) {
				throw witError(error);
			}
		};
		const effect = (e: Effect, grant?: "notify" | "notes") => {
			if (env.readOnly) {
				throw witError(denied("read-only", "read-only context"));
			}
			if (grant !== undefined && !env.grants[grant]) {
				throw witError(denied("grant", `the manifest does not grant ${grant}`));
			}
			if (e.kind === "notify" && env.install.mode === "shadow") {
				throw witError(
					denied("shadow", "a shadow installation sends no notices"),
				);
			}
			effects.push(e);
		};
		const sql = {
			exec: (query: string, params: { tag: string; val?: unknown }[]) =>
				guard(() => {
					const cursor = materialize(surfaces.sql.exec(
						query,
						...(params ?? []).map(fromWitValue),
					));
					const columns = [...(cursor.columnNames ?? [])];
					const raw = cursor.raw?.().toArray() ?? [];
					return {
						columns,
						values: raw.map((row) => row.map(toWitValue)),
						rowsWritten: BigInt(cursor.rowsWritten ?? 0),
					};
				}),
		};
		const kv = {
			get: (key: string) => surfaces.kv.get(key) ?? undefined,
			put: (key: string, value: Uint8Array) => surfaces.kv.put(key, value),
			delete: (key: string) => surfaces.kv.delete(key),
			listKeys: (prefix: string, limit: number) =>
				surfaces.kv.listKeys(prefix, limit),
		};
		const host = {
			log: (level: string, msg: string) => log.push(level, msg),
			config: () => json(env.config ?? {}),
			nowMs: () => BigInt(Math.floor(env.now)),
			random: (len: number) =>
				crypto.getRandomValues(new Uint8Array(Math.min(65536, len >>> 0))),
			ulid: () => ulid(),
		};
		const effectsImport = {
			emit: (
				kind: string,
				subject: { kind: string; id: string } | undefined,
				data: string,
			) =>
				guard(() =>
					effect({
						kind: "emit",
						type: kind,
						...(subject
							? { subject: { kind: subject.kind, id: subject.id } }
							: {}),
						data: parseJson(data, "emit data"),
					})
				),
			notify: (
				principal: string,
				options: {
					kind: string;
					severity: string;
					dedupeKey?: string;
					repo?: string;
					lane?: string;
				},
				text: string,
				data: string,
			) =>
				guard(() =>
					effect({
						kind: "notify",
						principal,
						notice: {
							kind: options.kind,
							severity: options.severity,
							text,
							data: parseJson(data, "notice data"),
							...(options.dedupeKey ? { dedupeKey: options.dedupeKey } : {}),
							...(options.repo ? { repo: options.repo } : {}),
							...(options.lane ? { lane: options.lane } : {}),
						},
					}, "notify")
				),
			contributeNote: (changeId: string, section: string) =>
				guard(() =>
					effect({
						kind: "note",
						changeId,
						section: parseJson(section, "note section"),
					}, "notes")
				),
			setTimer: (key: string, atMs: bigint) =>
				guard(() => effect({ kind: "timer", key, atMs: Number(atMs) })),
		};
		const both = (name: string, value: unknown) => ({
			[`tartan:ext/${name}@0.1.0`]: value,
			[`tartan:ext/${name}`]: value,
		});
		return {
			...both("types", {}),
			...both("sql", sql),
			...both("kv", kv),
			...both("host", host),
			...both("effects", effectsImport),
		};
	};

	/** The WIT arguments of a hook (`args` are the ExtensionModule arguments without `x`). */
	const witArgs = (hook: string, args: unknown[], env: CallEnv): unknown[] => {
		switch (hook) {
			case "init":
				return [];
			case "onEvent":
				return [witEvent(args[0] as Envelope)];
			case "onTimer":
				return [String(args[0])];
			case "gate": {
				const input = (args[1] ?? {}) as Record<string, unknown>;
				return [
					String(args[0]),
					json(input),
					witSlotContext({
						node: env.install.node.id,
						repo: typeof input.repo === "string" ? input.repo : env.repo,
						mode: env.install.mode,
					}, env),
				];
			}
			case "echo":
				return [witEvent(args[0] as Envelope), json(args[1])];
			case "render":
				return [String(args[0]), witSlotContext(args[1], env), json(args[2])];
			case "onAction":
				return [String(args[0]), json(args[1]), witSlotContext(args[2], env)];
			case "callTool":
				return [String(args[0]), json(args[1]), witSlotContext(args[2], env)];
			case "context":
				return [json(args[0])];
			default:
				throw tartanError("not_found", `no hook ${hook}`);
		}
	};

	/** The ExtensionModule result of a WIT export's return value. */
	const fromWitResult = (hook: string, out: unknown): unknown => {
		switch (hook) {
			case "init":
			case "onEvent":
			case "onTimer":
				return undefined;
			case "gate": {
				const d = out as {
					verdict: string;
					message: string;
					annotations: string;
					fullScan: boolean;
				};
				const annotations = parseJson(d.annotations || "[]", "annotations");
				const decision: Record<string, unknown> = {
					decision: d.verdict,
					message: d.message,
				};
				if (Array.isArray(annotations) && annotations.length > 0) {
					decision.annotations = annotations;
				}
				if (d.fullScan) decision.fullScan = true;
				return decision as GateDecision;
			}
			case "echo":
				return Array.isArray(out) ? out.map(String) : [];
			default:
				return parseJson(out, `${hook} result`);
		}
	};

	/** One wasm call on a fresh component instance. */
	const callWasm = (
		program: WasmProgram,
		hook: string,
		args: unknown[],
		env: CallEnv,
		surfaces: CallSurfaces,
	): CallOutcome => {
		const effects: Effect[] = [];
		const log = createLog();
		const size = () => surfaces.dbSize?.();
		try {
			const name = WASM_EXPORTS[hook];
			if (name === undefined) throw tartanError("not_found", `no hook ${hook}`);
			const instance = program.instantiate(
				program.getCoreModule,
				witImports(env, surfaces, effects, log),
			);
			const fn = instance[name];
			if (typeof fn !== "function") {
				throw tartanError("not_found", `the component exports no ${name}`);
			}
			let out: unknown;
			try {
				out = fn(...witArgs(hook, args, env));
			} catch (error) {
				return {
					ok: false,
					error: fromWitError(error, `${env.install.extId} ${env.method}`),
					logs: log.lines,
					dbSize: size(),
				};
			}
			return {
				ok: true,
				value: fromWitResult(hook, out),
				logs: log.lines,
				effects,
				dbSize: size(),
			};
		} catch (error) {
			return {
				ok: false,
				error: errorData(error),
				logs: log.lines,
				dbSize: size(),
			};
		}
	};

	/** The `KernelCaps` a js extension sees: every method over the bridge, `clock`/`ids` local. */
	const bridgedCaps = (
		bridge: CapsBridge | undefined,
		env: CallEnv,
		expired: () => boolean,
	) => {
		const ulid = ulidFactory(() => env.now);
		const live = () => {
			if (expired()) {
				throw tartanError(
					"unavailable",
					"this capability belonged to an earlier call",
				);
			}
		};
		const forward = (ns: string) =>
			new Proxy({}, {
				get: (_target, method) => {
					if (typeof method !== "string" || method === "then") return undefined;
					return async (...callArgs: unknown[]) => {
						live();
						if (bridge === undefined) {
							throw tartanError("unavailable", "no capabilities in this call");
						}
						const answer = await bridge.call(`${ns}.${method}`, callArgs);
						if (answer.ok) return answer.value;
						throw tartanError(
							answer.error.code,
							answer.error.text,
							answer.error.reason,
							answer.error.details,
						);
					};
				},
			});
		const namespaces = [
			"repo",
			"lanes",
			"land",
			"runs",
			"notes",
			"events",
			"notify",
			"authz",
			"principals",
			"interfaces",
			"timers",
			"agents",
			"ai",
		];
		return {
			...Object.fromEntries(namespaces.map((ns) => [ns, forward(ns)])),
			clock: {
				now: () => {
					live();
					return env.now;
				},
			},
			ids: {
				ulid: () => {
					live();
					return ulid();
				},
			},
		};
	};

	/** One js call: the module's hook with a fresh ExtCtx. */
	const callJs = async (
		program: JsProgram,
		hook: string,
		args: unknown[],
		env: CallEnv,
		surfaces: CallSurfaces,
		bridge: CapsBridge | undefined,
	): Promise<CallOutcome> => {
		const log = createLog();
		let expired = false;
		const size = () => surfaces.dbSize?.();
		try {
			const fn = program.module[hook];
			if (typeof fn !== "function") {
				throw tartanError("not_found", `the module has no ${hook} hook`);
			}
			const x = {
				caps: bridgedCaps(bridge, env, () => expired),
				sql: surfaces.sql,
				kv: surfaces.kv,
				config: env.config,
				log: log.logger,
				install: env.install,
				actor: env.actor,
				readOnly: env.readOnly,
			};
			const value = await (fn as (...a: unknown[]) => unknown).apply(
				program.module,
				[...args, x],
			);
			return { ok: true, value, logs: log.lines, effects: [], dbSize: size() };
		} catch (error) {
			return {
				ok: false,
				error: errorData(error),
				logs: log.lines,
				dbSize: size(),
			};
		} finally {
			expired = true;
		}
	};

	/** Which hooks a program implements (every WIT export exists for wasm). */
	const hooksOf = (program: Program): string[] =>
		program.kind === "wasm"
			? Object.keys(WASM_EXPORTS)
			: Object.keys(WASM_EXPORTS).filter((h) =>
				typeof program.module[h] === "function"
			);

	/** A program over a facet's own storage: what `ExtFacet` exposes. */
	const facetRuntime = (storage: CoreStorage, load: () => Program) => {
		let program: Program | null = null;
		const current = (): Program => (program ??= load());
		const surfaces = (env: CallEnv): CallSurfaces => ({
			sql: facetSql(storage, {
				readOnly: env.readOnly,
				quotaBytes: env.quotaBytes,
			}),
			kv: facetKv(storage, env.readOnly),
			dbSize: () => storage.sql.databaseSize ?? 0,
		});
		return {
			hooks: () => hooksOf(current()),
			migrate: (migrations: readonly ExtMigration[], now: number) =>
				migrate(storage, migrations, now),
			invoke: (
				hook: string,
				args: unknown[],
				env: CallEnv,
				bridge?: CapsBridge,
			): Promise<CallOutcome> => {
				const p = current();
				return p.kind === "wasm"
					? Promise.resolve(callWasm(p, hook, args, env, surfaces(env)))
					: callJs(p, hook, args, env, surfaces(env), bridge);
			},
			/** Test and console inspection: one read-only query. */
			query: (query: string, ...bindings: unknown[]) =>
				facetSql(storage, { readOnly: true, quotaBytes: 0 }).exec(
					query,
					...bindings,
				).toArray(),
		};
	};

	return {
		callJs,
		callWasm,
		errorData,
		facetKv,
		facetRuntime,
		facetSql,
		hooksOf,
		migrate,
		scanSql,
		splitStatements,
		tartanError,
		ulidFactory,
		witEvent,
		witSlotContext,
	};
}

export type FacetCore = ReturnType<typeof facetCore>;
export type FacetRuntime = ReturnType<FacetCore["facetRuntime"]>;
