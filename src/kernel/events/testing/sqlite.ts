// Test-only: a DO `SqlStorage` look-alike over `node:sqlite`, so the event
// log, forge stream and inbox modules run under `deno test` (WP6). It covers
// what those modules use: `exec(query, ...bindings)` with `toArray`, `one`,
// iteration and `rowsWritten`, plus a `transactionSync` with rollback. Only
// `*.test.ts` files import it; runtime code never does.

import { DatabaseSync } from "node:sqlite";

type Value = string | number | null | ArrayBuffer;
type Row = Record<string, Value>;

export type FakeCursor<T> = {
	toArray(): T[];
	one(): T;
	next(): IteratorResult<T>;
	[Symbol.iterator](): IterableIterator<T>;
	readonly rowsRead: number;
	readonly rowsWritten: number;
	readonly columnNames: string[];
};

export type FakeSql = {
	exec<T = Row>(query: string, ...bindings: unknown[]): FakeCursor<T>;
	readonly databaseSize: number;
};

export type FakeStorage = {
	readonly sql: FakeSql;
	transactionSync<T>(fn: () => T): T;
	close(): void;
};

const cursor = <T>(
	rows: T[],
	rowsWritten: number,
	columnNames: string[],
): FakeCursor<T> => {
	let index = 0;
	const iterator = (): IterableIterator<T> => rows[Symbol.iterator]();
	return {
		toArray: () => rows.slice(index),
		one: () => {
			if (rows.length !== 1) {
				throw new Error(`Expected exactly one result, got ${rows.length}`);
			}
			return rows[0];
		},
		next: () =>
			index < rows.length
				? { done: false, value: rows[index++] }
				: { done: true, value: undefined },
		[Symbol.iterator]: iterator,
		rowsRead: rows.length,
		rowsWritten,
		columnNames,
	};
};

/** A fresh in-memory database. */
export const createFakeStorage = (): FakeStorage => {
	const db = new DatabaseSync(":memory:");
	let depth = 0;
	const exec = <T>(query: string, ...bindings: unknown[]): FakeCursor<T> => {
		const statements = query.split(";").map((s) => s.trim()).filter(Boolean);
		if (statements.length > 1 && bindings.length === 0) {
			db.exec(query);
			return cursor<T>([], 0, []);
		}
		const statement = db.prepare(query);
		const args = bindings as (string | number | null)[];
		const columns = statement.columns().map((c) => c.name);
		if (columns.length > 0) {
			const rows = statement.all(...args).map((r) => ({ ...r }) as T);
			return cursor(rows, 0, columns);
		}
		const result = statement.run(...args);
		return cursor<T>([], Number(result.changes), []);
	};
	return {
		sql: {
			exec,
			get databaseSize() {
				return 0;
			},
		},
		transactionSync: <T>(fn: () => T): T => {
			const savepoint = `sp${depth++}`;
			db.exec(`SAVEPOINT ${savepoint}`);
			try {
				const result = fn();
				db.exec(`RELEASE ${savepoint}`);
				return result;
			} catch (error) {
				db.exec(`ROLLBACK TO ${savepoint}`);
				db.exec(`RELEASE ${savepoint}`);
				throw error;
			} finally {
				depth--;
			}
		},
		close: () => db.close(),
	};
};

/** Applies migration SQL in order (the DO host's job in production). */
export const applyMigrations = (
	storage: FakeStorage,
	migrations: readonly { readonly sql: string }[],
): void => {
	for (const migration of migrations) {
		for (
			const statement of migration.sql.split(";").map((s) => s.trim()).filter(
				Boolean,
			)
		) {
			storage.sql.exec(statement);
		}
	}
};
