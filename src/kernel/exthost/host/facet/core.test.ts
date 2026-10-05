// The facet core as a facet loads it (its own source text, testing/facet.ts
// `shippedCore`): the SQL guard over a facet's own database, kv, migrations,
// ULIDs, error data and the WIT conversions.

import {
	deepStrictEqual,
	match,
	ok,
	strictEqual,
	throws,
} from "node:assert/strict";
import { createMemoryStorage } from "@tartan/ext-api/testing.ts";
import { fromRpcError, isTartanError } from "@tartan/contract";
import type { CallEnv, CoreStorage } from "./core.ts";
import { shippedCore } from "../testing/facet.ts";

const core = await shippedCore();

const storage = () => {
	const s = createMemoryStorage();
	return { mem: s, core: s as unknown as CoreStorage };
};

const code = (fn: () => unknown): string => {
	try {
		fn();
		return "ok";
	} catch (error) {
		const e = fromRpcError(error);
		return e.reason ? `${e.code}:${e.reason}` : e.code;
	}
};

const env = (over: Partial<CallEnv> = {}): CallEnv => ({
	method: "render",
	readOnly: false,
	install: {
		id: "i_01k60000000000000000000201",
		extId: "acme.x",
		version: "0.1.0",
		node: { id: "01k60000000000000000000001", path: "acme" },
		scopeKey: "repo:01k60000000000000000000002",
		mode: "enforce",
	},
	actor: { kind: "user", id: "u_01k60000000000000000000101" },
	config: { a: 1 },
	now: Date.UTC(2026, 9, 5),
	quotaBytes: 1024 * 1024,
	grants: { notify: false, notes: false },
	repo: "01k60000000000000000000002",
	...over,
});

Deno.test("the shipped core is self-contained (it runs from its own source)", () => {
	ok(typeof core.facetRuntime === "function");
	ok(typeof core.callWasm === "function");
});

Deno.test("facet sql: DML and DDL only, reserved names refused in every spelling", () => {
	const s = storage();
	const sql = core.facetSql(s.core, { readOnly: false, quotaBytes: 1e9 });
	sql.exec("CREATE TABLE t (k TEXT, v INTEGER)");
	strictEqual(sql.exec("INSERT INTO t VALUES (?, ?)", "a", 1).rowsWritten, 1);
	deepStrictEqual(sql.exec("SELECT k, v FROM t").toArray(), [{ k: "a", v: 1 }]);
	strictEqual(sql.exec("SELECT COUNT(*) AS n FROM t").one?.().n, 1);
	strictEqual(code(() => sql.exec("PRAGMA table_list")), "invalid");
	strictEqual(code(() => sql.exec("ATTACH 'x' AS y")), "invalid");
	strictEqual(code(() => sql.exec("SELECT 1; PRAGMA x")), "invalid");
	strictEqual(code(() => sql.exec("   ")), "invalid");
	for (
		const q of [
			"SELECT * FROM _ext_migrations",
			'SELECT * FROM "_ext_migrations"',
			"SELECT * FROM `_x`",
			"SELECT * FROM [_x]",
			"SELECT * FROM '_x'",
			"SELECT * FROM sqlite_master",
			"SELECT * FROM pragma_table_list",
		]
	) {
		strictEqual(code(() => sql.exec(q)), "denied:scope", q);
	}
	// Comments are skipped, not scanned.
	strictEqual(code(() => sql.exec("SELECT 1 -- _x\n")), "ok");
	strictEqual(code(() => sql.exec("SELECT /* _x */ 1")), "ok");
	s.mem.close();
});

Deno.test("facet sql: read-only allows one read and rolls back a write that slipped through", () => {
	const s = storage();
	core.facetSql(s.core, { readOnly: false, quotaBytes: 1e9 }).exec(
		"CREATE TABLE t (k TEXT)",
	);
	const ro = core.facetSql(s.core, { readOnly: true, quotaBytes: 1e9 });
	deepStrictEqual(ro.exec("SELECT COUNT(*) AS n FROM t").toArray(), [{ n: 0 }]);
	deepStrictEqual(ro.exec("VALUES (1)").toArray().length, 1);
	for (
		const q of [
			"INSERT INTO t VALUES ('x')",
			"DELETE FROM t",
			"SELECT 1; SELECT 2",
			"WITH a AS (SELECT 1) INSERT INTO t SELECT * FROM a",
			"CREATE TABLE u (x)",
		]
	) {
		strictEqual(code(() => ro.exec(q)), "denied:read-only", q);
	}
	s.mem.close();
});

Deno.test("facet sql: growth above the quota is denied with the size; deletes still run", () => {
	const s = storage();
	core.facetSql(s.core, { readOnly: false, quotaBytes: 1e9 }).exec(
		"CREATE TABLE t (k TEXT)",
	);
	const sql = core.facetSql(s.core, { readOnly: false, quotaBytes: 1 });
	let error: unknown;
	try {
		sql.exec("INSERT INTO t VALUES ('x')");
	} catch (e) {
		error = e;
	}
	ok(isTartanError(error));
	const e = fromRpcError(error);
	strictEqual(e.reason, "quota");
	ok(typeof e.details?.size === "number");
	strictEqual(code(() => sql.exec("DELETE FROM t")), "ok");
	strictEqual(code(() => sql.exec("SELECT * FROM t")), "ok");
	s.mem.close();
});

Deno.test("facet kv: Uint8Array values, read-only refused, key limits", () => {
	const s = storage();
	const kv = core.facetKv(s.core, false);
	kv.put("a/1", new Uint8Array([1, 2]));
	kv.put("a/2", new Uint8Array([3]));
	deepStrictEqual(kv.get("a/1"), new Uint8Array([1, 2]));
	strictEqual(kv.get("nope"), null);
	deepStrictEqual(kv.listKeys("a/", 10), ["a/1", "a/2"]);
	strictEqual(kv.delete("a/2"), true);
	strictEqual(code(() => kv.put("", new Uint8Array())), "invalid");
	strictEqual(
		code(() => kv.put("x", "text" as unknown as Uint8Array)),
		"invalid",
	);
	const ro = core.facetKv(s.core, true);
	strictEqual(code(() => ro.put("x", new Uint8Array())), "denied:read-only");
	strictEqual(code(() => ro.delete("a/1")), "denied:read-only");
	deepStrictEqual(ro.get("a/1"), new Uint8Array([1, 2]));
	s.mem.close();
});

Deno.test("facet migrations: forward-only, once, in number order, guarded", () => {
	const s = storage();
	const now = 1000;
	const m1 = {
		n: 1,
		name: "init",
		sql: "CREATE TABLE a (x);\nCREATE TABLE b (y)",
	};
	const m2 = {
		n: 2,
		name: "more",
		sql:
			"-- comment; with a semicolon\nALTER TABLE a ADD COLUMN z TEXT DEFAULT 'a;b'",
	};
	deepStrictEqual(core.migrate(s.core, [m2, m1], now), [1, 2]);
	deepStrictEqual(core.migrate(s.core, [m1, m2], now), []);
	deepStrictEqual(
		s.mem.sql.exec("SELECT n, name, at FROM _ext_migrations ORDER BY n")
			.toArray(),
		[{ n: 1, name: "init", at: now }, { n: 2, name: "more", at: now }],
	);
	throws(() =>
		core.migrate(s.core, [{
			n: 3,
			name: "bad",
			sql: "DROP TABLE _ext_migrations",
		}], now)
	);
	strictEqual(
		s.mem.sql.exec("SELECT COUNT(*) AS n FROM _ext_migrations").one().n,
		2,
		"a refused migration records nothing",
	);
	deepStrictEqual(core.splitStatements("a; 'x;y'; [b;c]; -- d;\n e"), [
		"a",
		"'x;y'",
		"[b;c]",
		"e",
	]);
	s.mem.close();
});

Deno.test("ULIDs: Crockford, time-prefixed, monotonic within a millisecond", () => {
	const make = core.ulidFactory(() => Date.UTC(2026, 9, 5));
	const a = make();
	const b = make();
	match(a, /^[0-7][0-9a-hjkmnp-tv-z]{25}$/);
	ok(b > a);
	strictEqual(a.slice(0, 10), b.slice(0, 10));
});

Deno.test("error data survives as data: TartanErrors, prefixed messages, plain errors", () => {
	const e = core.tartanError("denied", "no", "grant", { x: 1 });
	ok(isTartanError(e));
	deepStrictEqual(core.errorData(e), {
		code: "denied",
		text: "no",
		reason: "grant",
		details: { x: 1 },
	});
	deepStrictEqual(core.errorData(new Error("conflict: busy")), {
		code: "conflict",
		text: "busy",
	});
	deepStrictEqual(core.errorData(new Error("boom")), {
		code: "internal",
		text: "boom",
	});
	deepStrictEqual(core.errorData("text"), { code: "internal", text: "text" });
});

Deno.test("WIT conversions: events and slot contexts as jco records", () => {
	const ev = core.witEvent({
		id: "01k60000000000000000000a01",
		seq: 7,
		stream: "repo:01k60000000000000000000002",
		type: "push.accepted",
		v: 1,
		source: { kind: "kernel" },
		actor: { kind: "agent", id: "a_1", onBehalfOf: "u_1" },
		node: "01k60000000000000000000002",
		repo: "01k60000000000000000000002",
		depth: 1,
		shadow: false,
		at: 1234,
		data: { target: "repo" },
	});
	strictEqual(ev.seq, 7n);
	strictEqual(ev.timeMs, 1234n);
	strictEqual(ev.kind, "push.accepted");
	strictEqual(ev.source, "kernel");
	deepStrictEqual(ev.actor, { kind: "agent", id: "a_1", onBehalfOf: "u_1" });
	strictEqual(ev.data, '{"target":"repo"}');
	const tool = core.witSlotContext({
		node: "n",
		repo: "r",
		scope: "acme/router",
		laneId: "ln_1",
		actor: { kind: "user", id: "u_1" },
		mode: "enforce",
	}, env());
	deepStrictEqual(tool.entity, { kind: "lane", id: "ln_1" });
	deepStrictEqual(tool.viewer, {
		kind: "user",
		id: "u_1",
		onBehalfOf: undefined,
	});
	deepStrictEqual(JSON.parse(tool.extra!), {
		scope: "acme/router",
		laneId: "ln_1",
	});
	const slot = core.witSlotContext({
		slot: "repo.tab",
		node: "n",
		ref: "refs/heads/main",
		mode: "shadow",
		extra: { route: "secrets" },
	}, env());
	strictEqual(slot.gitRef, "refs/heads/main");
	strictEqual(slot.mode, "shadow");
	strictEqual(slot.repo, env().repo, "defaults to the installation's repo");
	deepStrictEqual(JSON.parse(slot.extra!), { route: "secrets" });
});

Deno.test("a js call builds a fresh ExtCtx; clock and ids answer locally; caps expire with the call", async () => {
	const s = storage();
	let stashed: { clock: { now(): number } } | null = null;
	const module = {
		render: (
			_slot: string,
			_ctx: unknown,
			_props: unknown,
			x: {
				caps: { clock: { now(): number }; ids: { ulid(): string } };
				log: { info(m: string, d?: unknown): void };
				config: unknown;
			},
		) => {
			stashed = x.caps;
			x.log.info("hello", { a: 1 });
			return Promise.resolve({
				now: x.caps.clock.now(),
				id: x.caps.ids.ulid().length,
				config: x.config,
			});
		},
	};
	const out = await core.callJs(
		{ kind: "js", module },
		"render",
		["s", {}, null],
		env({ readOnly: true }),
		{
			sql: core.facetSql(s.core, { readOnly: true, quotaBytes: 0 }),
			kv: core.facetKv(s.core, true),
		},
		undefined,
	);
	ok(out.ok);
	deepStrictEqual(out.value, { now: env().now, id: 26, config: { a: 1 } });
	deepStrictEqual(out.logs, [{ level: "info", msg: 'hello {"a":1}' }]);
	strictEqual(code(() => stashed!.clock.now()), "unavailable");
	const missing = await core.callJs(
		{ kind: "js", module },
		"onEvent",
		[],
		env(),
		{
			sql: core.facetSql(s.core, { readOnly: false, quotaBytes: 1e9 }),
			kv: core.facetKv(s.core, false),
		},
		undefined,
	);
	ok(!missing.ok);
	strictEqual(missing.error.code, "not_found");
	s.mem.close();
});

Deno.test("js caps forward over the bridge and keep the error's code and reason", async () => {
	const s = storage();
	const calls: string[] = [];
	const bridge = {
		call: (path: string, args: unknown[]) => {
			calls.push(`${path}:${JSON.stringify(args)}`);
			return Promise.resolve(
				path === "runs.get"
					? {
						ok: false as const,
						error: { code: "denied", reason: "grant", text: "runs" },
					}
					: { ok: true as const, value: "e_1" },
			);
		},
	};
	const module = {
		onEvent: async (
			_ev: unknown,
			x: {
				caps: {
					events: { emit(t: string, d: unknown): Promise<string> };
					runs: { get(id: string): Promise<unknown> };
				};
			},
		) => {
			const id = await x.caps.events.emit("x.acme.x.y", { a: 1 });
			try {
				await x.caps.runs.get("r");
			} catch (e) {
				const err = e as { code: string; reason: string };
				return `${id} ${err.code}:${err.reason}`;
			}
		},
	};
	const out = await core.callJs(
		{ kind: "js", module },
		"onEvent",
		[{}],
		env(),
		{
			sql: core.facetSql(s.core, { readOnly: false, quotaBytes: 1e9 }),
			kv: core.facetKv(s.core, false),
		},
		bridge,
	);
	ok(out.ok);
	strictEqual(out.value, "e_1 denied:grant");
	deepStrictEqual(calls, [
		'events.emit:["x.acme.x.y",{"a":1}]',
		'runs.get:["r"]',
	]);
	s.mem.close();
});
