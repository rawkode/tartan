// Test-only: a Durable Object storage stand-in on `node:sqlite` for Deno unit
// tests of the RepoDO `core` module (`sql.exec`, `transactionSync` with
// nesting, the alarm). WP1's `@tartan/testkit` does not exist yet; this is a
// minimal local fake, never imported by runtime code.
//
// Differences from DO SQLite that matter here: none of the SQL the module
// uses depends on them (no BLOBs, no `rowsWritten`; CAS updates use
// `RETURNING`).

import { DatabaseSync } from "node:sqlite";

type Row = Record<string, SqlStorageValue>;

const READS = /^\s*(SELECT|WITH|PRAGMA|VALUES)\b/i;
const RETURNS = /\bRETURNING\b/i;

/** True when `query` holds more than one statement (migrations). */
const isMulti = (query: string): boolean => {
	const trimmed = query.trim().replace(/;\s*$/, "");
	return trimmed.includes(";");
};

const cursorOf = <T extends Row>(rows: T[], written: number) => {
	let index = 0;
	const columnNames = rows.length > 0 ? Object.keys(rows[0]) : [];
	const cursor = {
		columnNames,
		rowsRead: rows.length,
		rowsWritten: written,
		next: (): IteratorResult<T> =>
			index < rows.length
				? { done: false, value: rows[index++] }
				: { done: true, value: undefined },
		toArray: (): T[] => rows.slice(index),
		one: (): T => {
			if (rows.length !== 1) {
				throw new Error(`Expected exactly one result, got ${rows.length}`);
			}
			return rows[0];
		},
		raw: () => rows.map((row) => Object.values(row))[Symbol.iterator](),
		[Symbol.iterator]: () => rows.slice(index)[Symbol.iterator](),
	};
	return cursor as unknown as SqlStorageCursor<T>;
};

export type FakeStorage =
	& Pick<
		DurableObjectStorage,
		"sql" | "transactionSync" | "getAlarm" | "setAlarm" | "deleteAlarm"
	>
	& {
		readonly db: DatabaseSync;
		/** The alarm the module host last set (null = none). */
		alarm(): number | null;
		/** How many `transactionSync` calls are open right now. */
		depth(): number;
	};

export const createFakeStorage = (): FakeStorage => {
	const db = new DatabaseSync(":memory:");
	db.exec("PRAGMA foreign_keys = ON");
	let alarm: number | null = null;
	let depth = 0;
	let savepoint = 0;

	const exec = <T extends Row>(
		query: string,
		...bindings: SqlStorageValue[]
	): SqlStorageCursor<T> => {
		if (bindings.length === 0 && isMulti(query)) {
			db.exec(query);
			return cursorOf<T>([], 0);
		}
		const statement = db.prepare(query);
		const params = bindings.map((value) =>
			value instanceof ArrayBuffer ? new Uint8Array(value) : value
		) as (string | number | null | Uint8Array)[];
		if (READS.test(query) || RETURNS.test(query)) {
			const rows = statement.all(...params).map((row) => ({ ...row })) as T[];
			return cursorOf(rows, RETURNS.test(query) ? rows.length : 0);
		}
		const result = statement.run(...params);
		return cursorOf<T>([], Number(result.changes));
	};

	const sql = {
		exec,
		get databaseSize() {
			return 0;
		},
	} as unknown as SqlStorage;

	const transactionSync = <T>(closure: () => T): T => {
		const name = depth === 0 ? null : `sp_${++savepoint}`;
		db.exec(name === null ? "BEGIN" : `SAVEPOINT ${name}`);
		depth++;
		try {
			const result = closure();
			depth--;
			db.exec(name === null ? "COMMIT" : `RELEASE ${name}`);
			return result;
		} catch (error) {
			depth--;
			db.exec(
				name === null ? "ROLLBACK" : `ROLLBACK TO ${name}; RELEASE ${name}`,
			);
			throw error;
		}
	};

	return {
		db,
		sql,
		transactionSync,
		getAlarm: () => Promise.resolve(alarm),
		setAlarm: (at: number | Date) => {
			alarm = typeof at === "number" ? at : at.getTime();
			return Promise.resolve();
		},
		deleteAlarm: () => {
			alarm = null;
			return Promise.resolve();
		},
		alarm: () => alarm,
		depth: () => depth,
	} as FakeStorage;
};
