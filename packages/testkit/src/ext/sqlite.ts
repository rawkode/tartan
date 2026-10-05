// `Sql` over an in-memory `node:sqlite` database for Deno unit tests of
// extensions (`@tartan/testkit/sqlite`). Not for workerd: there, pass a
// Durable Object's `ctx.storage.sql` adapter to `runExtension` instead.

import { DatabaseSync } from "node:sqlite";
import type { Sql, SqlCursor, SqlRow, SqlValue } from "@tartan/contract";

const cursorOf = <T extends SqlRow>(
	rows: T[],
	rowsRead: number,
	rowsWritten: number,
): SqlCursor<T> => ({
	toArray: () => rows,
	one: () => {
		if (rows.length !== 1) {
			throw new Error(`expected one row, got ${rows.length}`);
		}
		return rows[0];
	},
	rowsRead,
	rowsWritten,
	[Symbol.iterator]: () => rows[Symbol.iterator](),
});

/** A fresh in-memory database; `transaction` uses SAVEPOINTs so it nests. */
export const createSqliteSql = (): Sql & { close(): void } => {
	const db = new DatabaseSync(":memory:");
	let depth = 0;
	return {
		exec: <T extends SqlRow = SqlRow>(
			query: string,
			...bindings: SqlValue[]
		) => {
			const trimmed = query.trim();
			const statements = trimmed.split(";").map((s) => s.trim()).filter(
				Boolean,
			);
			if (statements.length > 1 && bindings.length === 0) {
				db.exec(trimmed);
				return cursorOf<T>([], 0, statements.length);
			}
			const stmt = db.prepare(trimmed);
			const params = bindings.map((b) =>
				b instanceof ArrayBuffer ? new Uint8Array(b) : b
			);
			if (stmt.columns().length > 0) {
				const rows = stmt.all(...params) as T[];
				return cursorOf(rows, rows.length, 0);
			}
			const info = stmt.run(...params);
			return cursorOf<T>([], 0, Number(info.changes));
		},
		transaction: <T>(fn: () => T): T => {
			const name = `tk_${++depth}`;
			db.exec(`SAVEPOINT ${name}`);
			try {
				const result = fn();
				db.exec(`RELEASE ${name}`);
				return result;
			} catch (e) {
				db.exec(`ROLLBACK TO ${name}`);
				db.exec(`RELEASE ${name}`);
				throw e;
			} finally {
				depth--;
			}
		},
		close: () => db.close(),
	};
};
