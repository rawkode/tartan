// ExtensionDO host tables (MIGRATION_RANGES.ext.host 1–99, recorded in
// `_migrations`) and the extension's own forward-only migrations
// (`manifest.storage.migrations`, 1–999, recorded in `_ext_migrations`). A
// builtin's own tables share this database; its migrations pass through the
// same statement guard as its `sql` handle, so they can never touch a
// `_`-prefixed table.

import { type ExtMigration, internal } from "@tartan/contract";
import {
	type Clock,
	COMMON_DDL,
	type Migration,
	MIGRATION_RANGES,
	migrationIssues,
} from "@tartan/contract/kernel.ts";
import { createGuardedSql, type SqlTarget } from "@tartan/ext-api/sqlguard.ts";
import {
	type MigrationStorage,
	runMigrations,
} from "../../../do/migrations.ts";

/** Host-table migrations (1–99). */
export const HOST_MIGRATIONS: readonly Migration[] = [
	{
		n: 1,
		name: "exthost: host tables",
		sql: [
			"CREATE TABLE IF NOT EXISTS _host (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
			"CREATE TABLE IF NOT EXISTS _ext_migrations (n INTEGER PRIMARY KEY, name TEXT NOT NULL, at INTEGER NOT NULL)",
			"CREATE TABLE IF NOT EXISTS _cursors (stream TEXT PRIMARY KEY, seq INTEGER NOT NULL, known_head INTEGER NOT NULL)",
			"CREATE TABLE IF NOT EXISTS _seen (event_id TEXT PRIMARY KEY, at INTEGER NOT NULL)",
			"CREATE INDEX IF NOT EXISTS _seen_at ON _seen (at)",
			"CREATE TABLE IF NOT EXISTS _retry (stream TEXT PRIMARY KEY, event_id TEXT NOT NULL, attempts INTEGER NOT NULL, next_at INTEGER NOT NULL, error TEXT)",
			"CREATE TABLE IF NOT EXISTS _dead (event_id TEXT PRIMARY KEY, stream TEXT NOT NULL, attempts INTEGER NOT NULL, error TEXT NOT NULL, at INTEGER NOT NULL)",
			COMMON_DDL.timers,
			"CREATE TABLE IF NOT EXISTS _render_cache (key TEXT PRIMARY KEY, data_version INTEGER NOT NULL, ui_json TEXT NOT NULL, at INTEGER NOT NULL)",
			"CREATE INDEX IF NOT EXISTS _render_cache_at ON _render_cache (at)",
			"CREATE TABLE IF NOT EXISTS _console (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, level TEXT NOT NULL, msg TEXT NOT NULL)",
			"CREATE TABLE IF NOT EXISTS _strikes (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, method TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('timeout','cpu','hung','reset')))",
			"CREATE TABLE IF NOT EXISTS _inflight (call_id TEXT PRIMARY KEY, method TEXT NOT NULL, started_at INTEGER NOT NULL, budget_ms INTEGER NOT NULL)",
		].join(";\n"),
	},
];

/**
 * Applies the host-table migrations with WP0's runner; synchronous (call
 * inside `blockConcurrencyWhile`). The runner only calls `sql.exec` and
 * `transactionSync`, which every `SqlTarget` (the DO storage, the Deno
 * memory storage) provides.
 */
export const migrateHostTables = (
	storage: SqlTarget,
	clock: Clock,
): number[] =>
	runMigrations(storage as unknown as MigrationStorage, [{
		name: "exthost",
		range: MIGRATION_RANGES.ext.host,
		migrations: HOST_MIGRATIONS,
	}], clock);

/**
 * Applies the extension's pending migrations in order, each in its own
 * transaction with its `_ext_migrations` row, through the statement guard.
 * Forward-only: applied numbers are skipped. Returns the numbers applied.
 */
export const migrateExtension = (
	target: SqlTarget,
	migrations: readonly ExtMigration[],
	clock: Clock,
): number[] => {
	const issues = migrationIssues(
		"extension",
		MIGRATION_RANGES.ext.extension,
		migrations,
	);
	if (issues.length > 0) {
		throw internal(`invalid extension migrations: ${issues.join("; ")}`);
	}
	const applied = new Set(
		target.sql.exec<{ n: number }>("SELECT n FROM _ext_migrations").toArray()
			.map((row) => row.n),
	);
	const guarded = createGuardedSql(target, { readOnly: false });
	const pending = migrations.filter((m) => !applied.has(m.n));
	for (const m of pending) {
		target.transactionSync(() => {
			guarded.exec(m.sql).toArray();
			target.sql.exec(
				"INSERT INTO _ext_migrations (n, name, at) VALUES (?, ?, ?)",
				m.n,
				m.name,
				clock.now(),
			);
		});
	}
	return pending.map((m) => m.n);
};
