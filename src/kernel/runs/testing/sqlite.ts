// Test helper (Deno only): the subset of DO SQLite storage the runs modules
// use (`sql.exec` cursors, `transactionSync`), backed by `node:sqlite`.
// A local fake until @tartan/testkit (WP1) ships one.

import { DatabaseSync } from "node:sqlite";

type Row = Record<string, SqlStorageValue>;

const cursorOf = <T extends Row>(
	rows: T[],
	rowsWritten: number,
): SqlStorageCursor<T> => {
	const cursor = {
		toArray: () => rows,
		one: () => {
			if (rows.length !== 1) {
				throw new Error(`expected exactly one row, got ${rows.length}`);
			}
			return rows[0];
		},
		raw: function* () {
			for (const row of rows) yield Object.values(row);
		},
		next: (() => {
			let i = 0;
			return () =>
				i < rows.length
					? { done: false as const, value: rows[i++] }
					: { done: true as const, value: undefined };
		})(),
		columnNames: rows.length > 0 ? Object.keys(rows[0]) : [],
		rowsRead: rows.length,
		rowsWritten,
		[Symbol.iterator]: () => rows[Symbol.iterator](),
	};
	return cursor as unknown as SqlStorageCursor<T>;
};

const isMultiStatement = (query: string): boolean =>
	query.trim().replace(/;\s*$/, "").includes(";");

const normalize = (value: unknown): SqlStorageValue => {
	if (typeof value === "bigint") return Number(value);
	if (value instanceof Uint8Array) return value.buffer as ArrayBuffer;
	return value as SqlStorageValue;
};

export type FakeStorage = {
	readonly sql: SqlStorage;
	readonly storage: DurableObjectStorage;
	readonly db: DatabaseSync;
};

/** An in-memory database with the DO `sql` and `transactionSync` shapes. */
export const createFakeStorage = (): FakeStorage => {
	const db = new DatabaseSync(":memory:");
	const sql = {
		exec: <T extends Row>(query: string, ...bindings: unknown[]) => {
			if (bindings.length === 0 && isMultiStatement(query)) {
				db.exec(query);
				return cursorOf<T>([], 0);
			}
			const statement = db.prepare(query);
			const params = bindings.map((b) =>
				typeof b === "boolean" ? (b ? 1 : 0) : b
			) as (string | number | null)[];
			if (/^\s*(SELECT|WITH)\b/i.test(query) || /\bRETURNING\b/i.test(query)) {
				const rows = statement.all(...params).map((row) =>
					Object.fromEntries(
						Object.entries(row as Record<string, unknown>).map((
							[k, v],
						) => [k, normalize(v)]),
					)
				) as T[];
				return cursorOf<T>(rows, 0);
			}
			const result = statement.run(...params);
			return cursorOf<T>([], Number(result.changes));
		},
		get databaseSize() {
			return 0;
		},
	} as unknown as SqlStorage;
	let depth = 0;
	const storage = {
		sql,
		transactionSync: <T>(fn: () => T): T => {
			const savepoint = `sp${depth}`;
			db.exec(depth === 0 ? "BEGIN" : `SAVEPOINT ${savepoint}`);
			depth += 1;
			try {
				const out = fn();
				depth -= 1;
				db.exec(depth === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
				return out;
			} catch (error) {
				depth -= 1;
				db.exec(
					depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${savepoint}`,
				);
				throw error;
			}
		},
	} as unknown as DurableObjectStorage;
	return { sql, storage, db };
};
