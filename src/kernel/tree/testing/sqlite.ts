// A Durable Object storage stand-in over `node:sqlite` for WP3's Deno unit
// tests: `sql.exec` with the cursor methods the tree module uses,
// `transactionSync` (nested calls become savepoints, a throw rolls back) and
// foreign keys on, as Durable Object SQLite enforces them. Deno only.

import { DatabaseSync } from "node:sqlite";

type Row = Record<string, SqlStorageValue>;

const cursorOf = (rows: Row[], rowsWritten: number) => ({
	toArray: () => rows,
	one: () => {
		if (rows.length !== 1) {
			throw new Error(`expected one row, got ${rows.length}`);
		}
		return rows[0];
	},
	rowsRead: rows.length,
	rowsWritten,
	columnNames: rows[0] ? Object.keys(rows[0]) : [],
	raw: () => rows.map((r) => Object.values(r))[Symbol.iterator](),
	next: () => ({ done: true, value: undefined }),
	[Symbol.iterator]: () => rows[Symbol.iterator](),
});

export type TestStorage = DurableObjectStorage & { readonly db: DatabaseSync };

export const createTestStorage = (): TestStorage => {
	const db = new DatabaseSync(":memory:");
	db.exec("PRAGMA foreign_keys = ON");
	let depth = 0;

	const exec = (query: string, ...bindings: unknown[]) => {
		const trimmed = query.trim().replace(/;\s*$/, "");
		if (bindings.length === 0 && trimmed.includes(";")) {
			db.exec(trimmed);
			return cursorOf([], 0);
		}
		const statement = db.prepare(trimmed);
		const rows = statement.all(
			...(bindings as (string | number | null | Uint8Array)[]),
		) as Row[];
		const writes = /^\s*(insert|update|delete|replace)/i.test(trimmed)
			? Number((db.prepare("SELECT changes() AS n").get() as { n: number }).n)
			: 0;
		return cursorOf(rows.map((r) => ({ ...r })), writes);
	};

	const transactionSync = <T>(fn: () => T): T => {
		const savepoint = `sp_${depth}`;
		db.exec(depth === 0 ? "BEGIN" : `SAVEPOINT ${savepoint}`);
		depth++;
		try {
			const result = fn();
			depth--;
			db.exec(depth === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
			return result;
		} catch (error) {
			depth--;
			db.exec(
				depth === 0
					? "ROLLBACK"
					: `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`,
			);
			throw error;
		}
	};

	return {
		db,
		sql: { exec } as unknown as SqlStorage,
		transactionSync,
	} as unknown as TestStorage;
};
