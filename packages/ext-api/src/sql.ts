// Small helpers over an extension's synchronous `Sql` handle: typed reads,
// writes with their row count, JSON columns and the "≤ 100 bound parameters"
// rule (variable-length sets go in as one JSON array expanded with
// `json_each`). No ORM: raw SQL with typed mappers.

import {
	invalid,
	type Sql,
	type SqlRow,
	type SqlValue,
} from "@tartan/contract";

export type Db = {
	/** Every row. */
	all<T extends SqlRow = SqlRow>(query: string, ...bindings: SqlValue[]): T[];
	/** The first row, or null. */
	first<T extends SqlRow = SqlRow>(
		query: string,
		...bindings: SqlValue[]
	): T | null;
	/** Exactly one row, else `invalid`. */
	one<T extends SqlRow = SqlRow>(query: string, ...bindings: SqlValue[]): T;
	/** The first column of the first row, or null. */
	value<V extends SqlValue = SqlValue>(
		query: string,
		...bindings: SqlValue[]
	): V | null;
	/** Runs a write and returns how many rows it wrote. */
	run(query: string, ...bindings: SqlValue[]): { readonly rowsWritten: number };
	/** Atomic (DO `transactionSync`); `fn` must be synchronous. */
	tx<T>(fn: () => T): T;
	readonly sql: Sql;
};

export const db = (sql: Sql): Db => ({
	all: <T extends SqlRow = SqlRow>(query: string, ...bindings: SqlValue[]) =>
		sql.exec<T>(query, ...bindings).toArray(),
	first: <T extends SqlRow = SqlRow>(query: string, ...bindings: SqlValue[]) =>
		sql.exec<T>(query, ...bindings).toArray()[0] ?? null,
	one: <T extends SqlRow = SqlRow>(query: string, ...bindings: SqlValue[]) => {
		const rows = sql.exec<T>(query, ...bindings).toArray();
		if (rows.length !== 1) {
			throw invalid(`expected exactly one row, got ${rows.length}`);
		}
		return rows[0];
	},
	value: <V extends SqlValue = SqlValue>(
		query: string,
		...bindings: SqlValue[]
	) => {
		const row = sql.exec(query, ...bindings).toArray()[0];
		if (row === undefined) return null;
		const first = Object.values(row)[0];
		return (first ?? null) as V | null;
	},
	run: (query, ...bindings) => {
		const cursor = sql.exec(query, ...bindings);
		// Drain the cursor so `rowsWritten` is final.
		cursor.toArray();
		return { rowsWritten: cursor.rowsWritten };
	},
	tx: (fn) => sql.transaction(fn),
	sql,
});

/** JSON columns: `TEXT` in SQLite. */
export const json = {
	encode: (value: unknown): string => JSON.stringify(value ?? null),
	/** Parses a `TEXT` column; `fallback` for null, non-text or invalid JSON. */
	decode: <T>(value: SqlValue | undefined, fallback: T): T => {
		if (typeof value !== "string") return fallback;
		try {
			return JSON.parse(value) as T;
		} catch {
			return fallback;
		}
	},
} as const;

/** Booleans as `INTEGER` 0/1. */
export const bool = {
	encode: (value: boolean): number => (value ? 1 : 0),
	decode: (value: SqlValue | undefined): boolean =>
		value === 1 || value === "1",
} as const;

/**
 * A variable-length `IN` set as one binding:
 * `WHERE id IN ${inList.sql}` with `inList.binding(values)`.
 */
export const inList = {
	sql: "(SELECT value FROM json_each(?))",
	binding: (values: readonly (string | number)[]): string =>
		JSON.stringify(values),
} as const;
