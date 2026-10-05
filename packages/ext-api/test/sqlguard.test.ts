// The statement guard of a builtin's `sql` handle: host tables are unreachable
// in every spelling, read-only contexts run one SELECT and roll back anything
// that wrote, and the quota stops growth but not deletes.

import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { fromRpcError } from "@tartan/contract";
import { checkSql, createGuardedSql, scanSql } from "../src/sqlguard.ts";
import { createMemoryStorage } from "../src/testing.ts";

const deniedReason = (fn: () => unknown): string | undefined => {
	try {
		fn();
	} catch (error) {
		const e = fromRpcError(error);
		return e.code === "denied" ? e.reason : e.code;
	}
	return undefined;
};

Deno.test("scanSql splits statements, skips comments and keeps trigger bodies whole", () => {
	const scan = scanSql(
		"-- a comment ; with a semicolon\nCREATE TABLE t (a TEXT); /* ; */ INSERT INTO t VALUES ('x;y');" +
			"CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE t SET a = CASE WHEN a = 'q' THEN 'r' ELSE a END; DELETE FROM t WHERE a = 'z'; END;",
	);
	ok(scan.ok);
	if (!scan.ok) return;
	deepStrictEqual(scan.statements.map((s) => s.first), [
		"CREATE",
		"INSERT",
		"CREATE",
	]);
	deepStrictEqual(scan.statements[1].literals, ["x;y"]);
	ok(scan.statements[2].words.includes("DELETE"));
});

Deno.test("host tables are unreachable in every spelling (denied scope)", () => {
	const spellings = [
		"SELECT * FROM _host",
		"SELECT * FROM main._host",
		'SELECT * FROM "_host"',
		"SELECT * FROM `_cursors`",
		"SELECT * FROM [_timers]",
		"SELECT * FROM '_dead'",
		"SELECT name FROM sqlite_master",
		"SELECT name FROM SQLITE_SCHEMA",
		"DELETE FROM _seen",
		"CREATE VIEW v AS SELECT * FROM _render_cache",
		"CREATE TRIGGER t AFTER INSERT ON items BEGIN DELETE FROM _retry; END",
		"INSERT INTO items SELECT k FROM _host",
		// Table-valued pragma functions would list the host tables.
		"SELECT name FROM pragma_table_list",
		"SELECT * FROM PRAGMA_TABLE_INFO(char(95) || 'host')",
	];
	for (const query of spellings) {
		const check = checkSql(query, { readOnly: false });
		ok(!check.ok, query);
		if (!check.ok) strictEqual(check.reason, "scope", query);
	}
	ok(checkSql("SELECT * FROM items WHERE name = ?", { readOnly: false }).ok);
});

Deno.test("only DML and DDL statements are allowed", () => {
	for (
		const query of [
			"PRAGMA table_list",
			"ATTACH DATABASE 'x' AS y",
			"BEGIN",
			"VACUUM",
			"EXPLAIN SELECT 1",
		]
	) {
		const check = checkSql(query, { readOnly: false });
		ok(!check.ok, query);
		if (!check.ok) strictEqual(check.reason, "statement", query);
	}
});

Deno.test("read-only: one SELECT, no write keyword", () => {
	ok(
		checkSql("SELECT replace(name, 'a', 'b') FROM items", { readOnly: true })
			.ok,
	);
	ok(
		checkSql("WITH x AS (SELECT 1 AS n) SELECT n FROM x", { readOnly: true })
			.ok,
	);
	for (
		const query of [
			"INSERT INTO items VALUES ('a')",
			"WITH x AS (SELECT 1) DELETE FROM items",
			"SELECT 1; SELECT 2",
			"UPDATE items SET name = 'b'",
		]
	) {
		const check = checkSql(query, { readOnly: true });
		ok(!check.ok, query);
		if (!check.ok) strictEqual(check.reason, "read-only", query);
	}
});

Deno.test("read-only exec rolls back a statement that wrote after all", () => {
	const storage = createMemoryStorage();
	try {
		storage.sql.exec("CREATE TABLE items (name TEXT PRIMARY KEY)");
		const ro = createGuardedSql(storage, { readOnly: true });
		strictEqual(
			deniedReason(() =>
				ro.exec("WITH x AS (SELECT 1) REPLACE INTO items VALUES ('sneaky')")
			),
			"read-only",
		);
		strictEqual(
			storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM items").one()
				.n,
			0,
		);
		const rw = createGuardedSql(storage, { readOnly: false });
		rw.exec("INSERT INTO items VALUES (?)", "a");
		deepStrictEqual(ro.exec("SELECT name FROM items").toArray(), [{
			name: "a",
		}]);
		strictEqual(deniedReason(() => ro.exec("SELECT * FROM _host")), "scope");
	} finally {
		storage.close();
	}
});

Deno.test("quota: growing statements are refused, deletes still run", () => {
	const storage = createMemoryStorage();
	try {
		storage.sql.exec("CREATE TABLE blobs (k INTEGER PRIMARY KEY, v TEXT)");
		const quota = storage.sql.databaseSize + 4096;
		let hits = 0;
		const sql = createGuardedSql(storage, {
			readOnly: false,
			quotaBytes: quota,
			onQuota: () => {
				hits += 1;
			},
		});
		let refused = false;
		for (let k = 0; k < 200 && !refused; k++) {
			try {
				sql.exec("INSERT INTO blobs (k, v) VALUES (?, ?)", k, "x".repeat(2000));
			} catch (error) {
				strictEqual(fromRpcError(error).reason, "quota");
				refused = true;
			}
		}
		ok(refused, "the quota stops inserts");
		strictEqual(hits, 1);
		sql.exec("DELETE FROM blobs");
		ok(sql.exec("SELECT COUNT(*) AS n FROM blobs").one().n === 0);
	} finally {
		storage.close();
	}
});

Deno.test("transactions nest and roll back", () => {
	const storage = createMemoryStorage();
	try {
		const sql = createGuardedSql(storage, { readOnly: false });
		sql.exec("CREATE TABLE t (v INTEGER)");
		throws(() =>
			sql.transaction(() => {
				sql.exec("INSERT INTO t VALUES (1)");
				sql.transaction(() => sql.exec("INSERT INTO t VALUES (2)"));
				throw new Error("boom");
			})
		);
		strictEqual(sql.exec("SELECT COUNT(*) AS n FROM t").one().n, 0);
	} finally {
		storage.close();
	}
});
