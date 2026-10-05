// The slice of DO SQLite the WP6 modules use, typed structurally so the same
// code runs on `ctx.storage.sql` in workerd and on the `node:sqlite` fake
// under `deno test` (`./testing/sqlite.ts`).

export type SqlRow = Record<string, SqlStorageValue>;

export type SqlCursor<T> = {
	toArray(): T[];
	one(): T;
	readonly rowsWritten: number;
};

export interface SqlExec {
	// deno-lint-ignore no-explicit-any
	exec<T extends SqlRow>(query: string, ...bindings: any[]): SqlCursor<T>;
}

/** Runs `fn` atomically (`ctx.storage.transactionSync`). */
export type TransactSync = <T>(fn: () => T) => T;

/** The first row, or null. */
export const first = <T>(cursor: SqlCursor<T>): T | null =>
	cursor.toArray()[0] ?? null;

/** A list bound as one JSON array parameter, expanded with `json_each`. */
export const jsonList = (values: readonly string[]): string =>
	JSON.stringify(values);
