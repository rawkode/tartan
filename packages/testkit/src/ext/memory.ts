// In-memory `Kv` and `Logger` for extension tests, and the read-only `Sql`
// guard (SELECT-only in render and context; `_*` and `sqlite_*` tables
// are rejected everywhere).

import type { Kv, Logger, Sql, SqlRow, SqlValue } from "@tartan/contract";
import { denied, invalid } from "@tartan/contract";

export const createMemoryKv = (): Kv & {
	readonly entries: Map<string, Uint8Array>;
} => {
	const entries = new Map<string, Uint8Array>();
	return {
		entries,
		get: (key) => entries.get(key) ?? null,
		put: (key, value) => {
			entries.set(key, value.slice());
		},
		delete: (key) => entries.delete(key),
		listKeys: (prefix, limit) =>
			[...entries.keys()].filter((k) => k.startsWith(prefix)).sort().slice(
				0,
				limit,
			),
	};
};

export type LogLine = {
	readonly level: "debug" | "info" | "warn" | "error";
	readonly msg: string;
	readonly data?: unknown;
};

export const createRecordingLogger = (): Logger & {
	readonly lines: LogLine[];
} => {
	const lines: LogLine[] = [];
	const at = (level: LogLine["level"]) => (msg: string, data?: unknown) => {
		lines.push(data === undefined ? { level, msg } : { level, msg, data });
	};
	return {
		lines,
		debug: at("debug"),
		info: at("info"),
		warn: at("warn"),
		error: at("error"),
	};
};

const RESERVED_TABLE = /\b(?:_[A-Za-z0-9_]*|sqlite_[A-Za-z0-9_]*)\b/;
const READ_ONLY = /^\s*(?:select|with)\b/i;
const WRITES = /\b(?:insert|update|delete|replace|create|drop|alter)\b/i;

/** Applies the host's statement rules to an `Sql`. */
export const guardSql = (inner: Sql, readOnly: boolean): Sql => ({
	exec: <T extends SqlRow = SqlRow>(query: string, ...bindings: SqlValue[]) => {
		if (RESERVED_TABLE.test(query)) {
			throw invalid("statements may not name _* or sqlite_* tables");
		}
		if (readOnly && (!READ_ONLY.test(query) || WRITES.test(query))) {
			throw denied("read-only", "read-only ExtCtx: SELECT only");
		}
		return inner.exec<T>(query, ...bindings);
	},
	transaction: (fn) => inner.transaction(fn),
});
