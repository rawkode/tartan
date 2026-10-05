// The SQL statement guard for builtin extensions. A builtin's tables share its
// ExtensionDO's SQLite database with the host tables (`_host`, `_cursors`,
// `_timers`, …), so the `Sql` handle the host gives a builtin:
//
// - rejects any statement that names a `_`-prefixed or `sqlite_` object (or a
//   `pragma_*` table-valued function, which would list the host tables), in
//   any spelling: a bare word, a quoted identifier (`"x"`, `` `x` ``, `[x]`)
//   or a single-quoted string (SQLite accepts `FROM '_host'` as a table name),
//   with `denied("scope")`; pass values that start with `_` as bindings;
// - accepts only DML and DDL (`SELECT`, `WITH`, `VALUES`, `INSERT`, `UPDATE`,
//   `DELETE`, `REPLACE`, `CREATE`, `DROP`, `ALTER`); `PRAGMA`, `ATTACH`,
//   transaction control and the rest are `invalid`;
// - in a read-only ExtCtx (render, context) accepts exactly one
//   `SELECT`/`WITH … SELECT`/`VALUES` statement with no write keyword, runs it
//   inside `transactionSync` and rolls back with `denied("read-only")` if it
//   wrote anything after all (`WITH … REPLACE INTO` passes the static check);
// - above the installation's quota refuses statements that grow the database
//   with `denied("quota")` (`DELETE` and `DROP` still run, to free space).
//
// The kernel host (`src/kernel/exthost/host`) and the Deno test harness
// (`testing.ts`) both use this module, so an extension's unit tests see the
// same rules as production. Pure: no platform globals.

import {
	denied,
	invalid,
	type Sql,
	type SqlCursor,
	type SqlRow,
	type SqlValue,
} from "@tartan/contract";

/** Names reserved for the host (`_host`, `_timers`, …) and SQLite (`sqlite_master`, `pragma_table_list`, …). */
export const RESERVED_SQL_NAME_RE = /^(?:_|sqlite_|pragma_)/i;

/** First keywords an extension statement may start with. */
export const ALLOWED_FIRST_KEYWORDS: ReadonlySet<string> = new Set([
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
]);

const READ_FIRST_KEYWORDS: ReadonlySet<string> = new Set([
	"SELECT",
	"WITH",
	"VALUES",
]);

/** Bare words that never appear in a read: any of them fails the read-only check. */
const WRITE_KEYWORDS: ReadonlySet<string> = new Set([
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
]);

/** Statements that can grow the database (checked against the quota). */
const GROWING_KEYWORDS: ReadonlySet<string> = new Set([
	"INSERT",
	"UPDATE",
	"REPLACE",
	"CREATE",
	"ALTER",
]);

export type SqlStatementScan = {
	/** Upper-cased first bare word, or null for a statement of only punctuation. */
	readonly first: string | null;
	/** Every bare word, upper-cased, in order. */
	readonly words: readonly string[];
	/** Identifiers as written (bare words, unquoted contents of quoted ones). */
	readonly names: readonly string[];
	/** Contents of single-quoted strings. */
	readonly literals: readonly string[];
	/** `[start, end)` offsets of the statement in the query (without its `;`). */
	readonly span: readonly [number, number];
};

export type SqlScan =
	| { readonly ok: true; readonly statements: readonly SqlStatementScan[] }
	| { readonly ok: false; readonly error: string };

const isWordChar = (c: string): boolean =>
	/[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) > 0x7f;

type Builder = {
	start: number;
	words: string[];
	names: string[];
	literals: string[];
	/** Inside the BEGIN … END body of a CREATE TRIGGER. */
	triggerBody: boolean;
	/** Open CASE expressions inside a trigger body (their END is not the body's). */
	caseDepth: number;
};

const fresh = (start: number): Builder => ({
	start,
	words: [],
	names: [],
	literals: [],
	triggerBody: false,
	caseDepth: 0,
});

/**
 * Splits a query into statements and collects its words, identifiers and
 * string literals, skipping comments. Blob literals (`x'00ff'`) scan as the
 * word `X` plus a literal. A `;` inside a `CREATE TRIGGER … BEGIN … END` body
 * does not end the statement (CASE … END pairs inside the body are counted).
 */
export const scanSql = (query: string): SqlScan => {
	const statements: SqlStatementScan[] = [];
	let b = fresh(0);
	let i = 0;
	const n = query.length;

	const finish = (end: number): void => {
		if (b.words.length > 0 || b.literals.length > 0 || b.names.length > 0) {
			statements.push({
				first: b.words[0] ?? null,
				words: b.words,
				names: b.names,
				literals: b.literals,
				span: [b.start, end],
			});
		}
	};

	const quoted = (close: string): string | null => {
		// `i` points at the opening quote.
		let out = "";
		let j = i + 1;
		while (j < n) {
			const c = query[j];
			if (c === close) {
				if (close !== "]" && query[j + 1] === close) {
					out += close;
					j += 2;
					continue;
				}
				i = j + 1;
				return out;
			}
			out += c;
			j += 1;
		}
		return null;
	};

	while (i < n) {
		const c = query[i];
		if (/\s/.test(c)) {
			i += 1;
		} else if (c === "-" && query[i + 1] === "-") {
			while (i < n && query[i] !== "\n") i += 1;
		} else if (c === "/" && query[i + 1] === "*") {
			const close = query.indexOf("*/", i + 2);
			if (close < 0) return { ok: false, error: "unterminated comment" };
			i = close + 2;
		} else if (c === "'") {
			const text = quoted("'");
			if (text === null) return { ok: false, error: "unterminated string" };
			b.literals.push(text);
		} else if (c === '"' || c === "`") {
			const text = quoted(c);
			if (text === null) {
				return { ok: false, error: "unterminated quoted identifier" };
			}
			b.names.push(text);
		} else if (c === "[") {
			const text = quoted("]");
			if (text === null) {
				return { ok: false, error: "unterminated quoted identifier" };
			}
			b.names.push(text);
		} else if (c === "?" || c === ":" || c === "@" || c === "$") {
			// Parameters (`?`, `?1`, `:name`, `@name`, `$name`) name no object.
			i += 1;
			while (i < n && isWordChar(query[i])) i += 1;
		} else if (c === ";") {
			if (b.triggerBody) {
				i += 1;
				continue;
			}
			finish(i);
			i += 1;
			b = fresh(i);
		} else if (isWordChar(c)) {
			let j = i;
			while (j < n && isWordChar(query[j])) j += 1;
			const word = query.slice(i, j);
			const upper = word.toUpperCase();
			i = j;
			// A number is not a name.
			if (/^[0-9]/.test(word)) continue;
			b.words.push(upper);
			b.names.push(word);
			if (
				upper === "BEGIN" && b.words[0] === "CREATE" &&
				b.words.includes("TRIGGER")
			) {
				b.triggerBody = true;
			} else if (upper === "CASE" && b.triggerBody) {
				b.caseDepth += 1;
			} else if (upper === "END" && b.triggerBody) {
				if (b.caseDepth > 0) b.caseDepth -= 1;
				else b.triggerBody = false;
			}
		} else {
			i += 1;
		}
	}
	finish(n);
	return { ok: true, statements };
};

export type SqlCheck =
	| {
		readonly ok: true;
		readonly statements: readonly SqlStatementScan[];
		/** True when any statement can grow the database. */
		readonly grows: boolean;
	}
	| {
		readonly ok: false;
		readonly reason: "scope" | "read-only" | "statement";
		readonly message: string;
	};

/** Static checks of one `exec` call (see the header). */
export const checkSql = (
	query: string,
	options: { readonly readOnly: boolean },
): SqlCheck => {
	const scan = scanSql(query);
	if (!scan.ok) return { ok: false, reason: "statement", message: scan.error };
	if (scan.statements.length === 0) {
		return { ok: false, reason: "statement", message: "empty statement" };
	}
	for (const st of scan.statements) {
		const reserved = [...st.names, ...st.literals].find((name) =>
			RESERVED_SQL_NAME_RE.test(name)
		);
		if (reserved !== undefined) {
			return {
				ok: false,
				reason: "scope",
				message:
					`names beginning with "_", "sqlite_" or "pragma_" are reserved for the host (${
						reserved.slice(0, 64)
					}); pass such values as bindings`,
			};
		}
		if (st.first === null || !ALLOWED_FIRST_KEYWORDS.has(st.first)) {
			return {
				ok: false,
				reason: "statement",
				message: `statement not allowed: ${st.first ?? "(none)"}`,
			};
		}
	}
	if (options.readOnly) {
		if (scan.statements.length !== 1) {
			return {
				ok: false,
				reason: "read-only",
				message: "a read-only context runs exactly one statement",
			};
		}
		const st = scan.statements[0];
		const write = st.words.find((w) => WRITE_KEYWORDS.has(w));
		if (!READ_FIRST_KEYWORDS.has(st.first ?? "") || write !== undefined) {
			return {
				ok: false,
				reason: "read-only",
				message: `read-only context: only SELECT is allowed (${
					write ?? st.first
				})`,
			};
		}
	}
	const grows = scan.statements.some((st) =>
		GROWING_KEYWORDS.has(st.first ?? "") ||
		(st.first === "WITH" && st.words.some((w) => GROWING_KEYWORDS.has(w)))
	);
	return { ok: true, statements: scan.statements, grows };
};

// ---------------------------------------------------------------------------
// The guarded `Sql` handle
// ---------------------------------------------------------------------------

/** The cursor shape of DO `SqlStorageCursor` that the guard relies on. */
export type SqlCursorLike<T> = {
	toArray(): T[];
	one(): T;
	readonly rowsRead: number;
	readonly rowsWritten: number;
	[Symbol.iterator](): IterableIterator<T>;
};

/** The subset of DO `SqlStorage` the guard needs. */
export type SqlStorageLike = {
	exec<T extends Record<string, SqlValue>>(
		query: string,
		...bindings: SqlValue[]
	): SqlCursorLike<T>;
	readonly databaseSize: number;
};

/** The subset of DO storage the guard needs. */
export type SqlTarget = {
	readonly sql: SqlStorageLike;
	transactionSync<T>(fn: () => T): T;
};

export type GuardOptions = {
	readonly readOnly: boolean;
	/** Database size above which growing statements fail with `denied("quota")`. */
	readonly quotaBytes?: number;
	/** Called each time a statement is refused for the quota. */
	readonly onQuota?: (size: number) => void;
};

/** A cursor over materialized rows (read-only results). */
export const arrayCursor = <T extends SqlRow>(
	rows: readonly T[],
	rowsRead: number,
	rowsWritten: number,
): SqlCursor<T> => ({
	toArray: () => [...rows],
	one: () => {
		if (rows.length !== 1) {
			throw invalid(`expected exactly one row, got ${rows.length}`);
		}
		return rows[0];
	},
	rowsRead,
	rowsWritten,
	[Symbol.iterator]: () => rows[Symbol.iterator](),
});

const refuse = (check: Extract<SqlCheck, { ok: false }>): never => {
	if (check.reason === "statement") throw invalid(check.message);
	throw denied(check.reason, check.message);
};

/**
 * The `Sql` handle a builtin receives in its `ExtCtx` (see the header). In
 * read-only mode every result is materialized inside `transactionSync`.
 */
export const createGuardedSql = (
	target: SqlTarget,
	options: GuardOptions,
): Sql => {
	const exec = <T extends SqlRow = SqlRow>(
		query: string,
		...bindings: SqlValue[]
	): SqlCursor<T> => {
		const check = checkSql(query, { readOnly: options.readOnly });
		if (!check.ok) return refuse(check);
		if (options.readOnly) {
			const result = target.transactionSync(() => {
				const cursor = target.sql.exec<T>(query, ...bindings);
				const rows = cursor.toArray();
				if (cursor.rowsWritten > 0) {
					throw denied("read-only", "read-only context: the statement wrote");
				}
				return { rows, rowsRead: cursor.rowsRead };
			});
			return arrayCursor(result.rows, result.rowsRead, 0);
		}
		const quota = options.quotaBytes;
		if (quota !== undefined && check.grows) {
			const size = target.sql.databaseSize;
			if (size > quota) {
				options.onQuota?.(size);
				throw denied(
					"quota",
					`storage quota exceeded (${size} > ${quota} bytes)`,
				);
			}
		}
		return target.sql.exec<T>(query, ...bindings);
	};
	return {
		exec,
		transaction: <T>(fn: () => T): T => target.transactionSync(fn),
	};
};
