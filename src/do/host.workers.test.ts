/// <reference types="@cloudflare/vitest-pool-workers/types" />
// The DO host: the migration runner with two fake
// modules, sibling resolution, RpcTarget facades over real DO RPC
// (pipelining through the thin ForgeDO/RepoDO/InboxDO getters) and the
// WebSocket dispatch table.

import { runInDurableObject } from "cloudflare:test";
import { RpcTarget } from "cloudflare:workers";
import { createUlid, fromRpcError, inboxDoName } from "@tartan/contract";
import {
	DO_MODULE_HEADER,
	type DoModule,
	FORGE_TIMERS,
	type Migration,
	MIGRATION_RANGES,
	moduleRequest,
	REPO_TIMERS,
	type SocketHandlers,
} from "@tartan/contract/kernel.ts";
import { describe, expect, it } from "vitest";
import { testEnv as env, uniqueName } from "../../test/env.ts";
import type { Env } from "../env.ts";
import { FORGE_COMMON, FORGE_MODULES } from "./forge.ts";
import { createDoHost, moduleMapIssues } from "./host.ts";
import {
	COMMON_MIGRATIONS,
	migrationSourceIssues,
	runMigrations,
} from "./migrations.ts";
import { REPO_COMMON, REPO_MODULES } from "./repo.ts";
import { rpcFacade } from "./rpc.ts";
import { createSocketDispatch } from "./sockets.ts";

// ---------------------------------------------------------------------------
// Two fake modules: alpha (900–949) and beta (950–999), above every real
// RepoDO range (1–429; repoconfig is 400–429), so module WPs adding RepoDO
// migrations never collide.
// ---------------------------------------------------------------------------

type AlphaFacade = { count(): Promise<number> };
type AlphaInternal = { countSync(): number };
type BetaFacade = { summary(): Promise<{ alpha: number; beta: number }> };
type BetaInternal = Record<string, never>;
type Siblings = { readonly alpha: AlphaInternal; readonly beta: BetaInternal };

const ALPHA_V1: readonly Migration[] = [
	{
		n: 900,
		name: "alpha_items",
		sql: "CREATE TABLE alpha_items (id TEXT PRIMARY KEY, v INTEGER NOT NULL)",
	},
	{
		n: 901,
		name: "alpha seed (two statements)",
		sql:
			"INSERT INTO alpha_items (id, v) VALUES ('one', 1);\nINSERT INTO alpha_items (id, v) VALUES ('two', 2)",
	},
];

const alpha = (
	migrations: readonly Migration[] = ALPHA_V1,
): DoModule<AlphaFacade, AlphaInternal, Env, Siblings> => ({
	name: "alpha",
	range: [900, 949],
	migrations,
	create: ({ sql }) => {
		const countSync = (): number =>
			sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM alpha_items").one().n;
		return {
			facade: { count: () => Promise.resolve(countSync()) },
			internal: { countSync },
		};
	},
});

const beta: DoModule<BetaFacade, BetaInternal, Env, Siblings> = {
	name: "beta",
	range: [950, 999],
	migrations: [
		{
			n: 950,
			name: "beta_items",
			sql: "CREATE TABLE beta_items (id TEXT PRIMARY KEY)",
		},
	],
	create: ({ sql, modules }) => ({
		facade: {
			// Sibling internals are resolved lazily, at call time.
			summary: () =>
				Promise.resolve({
					alpha: modules.alpha.countSync(),
					beta: sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM beta_items")
						.one().n,
				}),
		},
		internal: {},
	}),
};

/** Applied migrations, ignoring the real RepoDO modules' own (100–899). */
const applied = (sql: SqlStorage): number[] =>
	sql.exec<{ n: number }>(
		"SELECT n FROM _migrations WHERE n < 100 OR n >= 900 ORDER BY n",
	).toArray().map((row) => row.n);

const tables = (sql: SqlStorage): string[] =>
	sql.exec<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf%' ESCAPE '\\' AND name NOT LIKE 'sqlite%' ORDER BY name",
	).toArray().map((row) => row.name);

const freshDo = () => env.REPO.getByName(uniqueName("test-host"));

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

describe("migration runner", () => {
	it("applies common + two modules' migrations once, in order, and records them", async () => {
		await runInDurableObject(freshDo(), async (_instance, state) => {
			const sql = state.storage.sql;
			// The RepoDO itself already applied its common migration (n=1).
			expect(applied(sql)).toEqual([1]);

			const host = createDoHost({
				kind: "test",
				ctx: state,
				env,
				modules: { alpha: alpha(), beta },
				common: [COMMON_MIGRATIONS.base],
			});
			await host.ready;
			expect(applied(sql)).toEqual([1, 900, 901, 950]);
			expect(tables(sql)).toEqual(
				expect.arrayContaining([
					"_migrations",
					"_timers",
					"alpha_items",
					"beta_items",
					"meta",
				]),
			);
			// Both statements of migration 901 ran.
			expect(await host.facade("alpha").count()).toBe(2);
			expect(await host.facade("beta").summary()).toEqual({
				alpha: 2,
				beta: 0,
			});
			const names = sql.exec<{ n: number; name: string }>(
				"SELECT n, name FROM _migrations WHERE n >= 900 ORDER BY n",
			).toArray();
			expect(names).toEqual([
				{ n: 900, name: "alpha: alpha_items" },
				{ n: 901, name: "alpha: alpha seed (two statements)" },
				{ n: 950, name: "beta: beta_items" },
			]);

			// A restart (new host on the same storage) applies nothing again.
			const again = createDoHost({
				kind: "test",
				ctx: state,
				env,
				modules: { alpha: alpha(), beta },
				common: [COMMON_MIGRATIONS.base],
			});
			await again.ready;
			expect(applied(sql)).toEqual([1, 900, 901, 950]);
			expect(await again.facade("alpha").count()).toBe(2);

			// A migration added later runs alone, even below an applied number of another module.
			const v2 = createDoHost({
				kind: "test",
				ctx: state,
				env,
				modules: {
					alpha: alpha([
						...ALPHA_V1,
						{
							n: 902,
							name: "alpha three",
							sql: "INSERT INTO alpha_items (id, v) VALUES ('three', 3)",
						},
					]),
					beta,
				},
				common: [COMMON_MIGRATIONS.base],
			});
			await v2.ready;
			expect(applied(sql)).toEqual([1, 900, 901, 902, 950]);
			expect(await v2.facade("alpha").count()).toBe(3);
		});
	});

	it("rolls back a failing migration and keeps the ones before it", async () => {
		await runInDurableObject(freshDo(), (_instance, state) => {
			const sql = state.storage.sql;
			const clock = { now: () => 1 };
			const sources = [
				{
					name: "alpha",
					range: [900, 949] as const,
					migrations: [
						ALPHA_V1[0],
						{
							n: 901,
							name: "half-broken",
							sql:
								"CREATE TABLE alpha_extra (id TEXT);\nINSERT INTO no_such_table VALUES (1)",
						},
					],
				},
			];
			expect(() => runMigrations(state.storage, sources, clock)).toThrow(
				/no such table/,
			);
			expect(applied(sql)).toEqual([1, 900]);
			expect(tables(sql)).toContain("alpha_items");
			expect(tables(sql)).not.toContain("alpha_extra");
		});
	});

	it("refuses migrations outside the module range, duplicates and overlapping ranges before touching storage", async () => {
		await runInDurableObject(freshDo(), (_instance, state) => {
			const sql = state.storage.sql;
			const clock = { now: () => 1 };
			const outside = [{
				name: "alpha",
				range: [900, 949] as const,
				migrations: [{
					n: 1050,
					name: "stray",
					sql: "CREATE TABLE stray (id TEXT)",
				}],
			}];
			expect(() => runMigrations(state.storage, outside, clock)).toThrow(
				/alpha: migration 1050 outside 900–949/,
			);
			expect(tables(sql)).not.toContain("stray");
			expect(applied(sql)).toEqual([1]);

			expect(migrationSourceIssues([
				{ name: "a", range: [100, 199], migrations: [] },
				{ name: "b", range: [150, 249], migrations: [] },
			])).toEqual(["a range 100–199 overlaps b range 150–249"]);
			expect(migrationSourceIssues([
				{
					name: "a",
					range: [100, 199],
					migrations: [
						{ n: 101, name: "x", sql: "" },
						{ n: 100, name: "y", sql: "" },
					],
				},
			])).toEqual(["a: migration 100 out of order"]);
			expect(moduleMapIssues({ wrong: alpha() }, [])).toEqual([
				'module key "wrong" names module "alpha"',
			]);
			expect(() =>
				createDoHost({
					kind: "test",
					ctx: state,
					env,
					modules: { alpha: alpha([{ n: 99, name: "x", sql: "" }]) },
					common: [COMMON_MIGRATIONS.base],
				})
			).toThrow(/alpha: migration 99 outside 900–949/);
		});
	});

	it("the real DO module maps use exactly the declared ranges and timer owners", () => {
		expect(moduleMapIssues(FORGE_MODULES, FORGE_COMMON)).toEqual([]);
		expect(moduleMapIssues(REPO_MODULES, REPO_COMMON)).toEqual([]);
		for (const [name, module] of Object.entries(FORGE_MODULES)) {
			expect(module.range, name).toEqual(
				MIGRATION_RANGES.forge[name as keyof typeof MIGRATION_RANGES.forge],
			);
		}
		for (const [name, module] of Object.entries(REPO_MODULES)) {
			expect(module.range, name).toEqual(
				MIGRATION_RANGES.repo[name as keyof typeof MIGRATION_RANGES.repo],
			);
		}
		// Every declared timer user is a module of its DO.
		for (const module of Object.keys(FORGE_TIMERS)) {
			expect(Object.keys(FORGE_MODULES)).toContain(module);
		}
		for (const module of Object.keys(REPO_TIMERS)) {
			expect(Object.keys(REPO_MODULES)).toContain(module);
		}
	});
});

// ---------------------------------------------------------------------------
// Facades over RPC
// ---------------------------------------------------------------------------

describe("RpcTarget facades", () => {
	it("installs facade methods on the prototype of an RpcTarget", () => {
		const target = rpcFacade("alpha", { count: () => Promise.resolve(7) });
		expect(target).toBeInstanceOf(RpcTarget);
		expect(Object.hasOwn(target, "count")).toBe(false);
		expect(typeof target.count).toBe("function");
	});

	it("pipelines a stub module call through the thin DO getters", async () => {
		const repo = env.REPO.getByName(uniqueName("test-rpc"));
		const coreError = await repo.core().info().catch((e: unknown) => e);
		// WP5a's core is implemented: an uninitialized repo answers not_found.
		expect(fromRpcError(coreError)).toMatchObject({
			code: "not_found",
			text: "repo is not initialized",
		});
		// WP6 implemented `events`: a fresh log has head 0.
		expect(await repo.events().head()).toBe(0);
		// WP8 implemented `probe`: projects() without its input is refused.
		const probeError = await (repo.probe() as unknown as {
			projects(): Promise<unknown>;
		}).projects().catch((e: unknown) => e);
		expect(fromRpcError(probeError).code).toBe("invalid");
		// `runs` is implemented (WP9); its facade is covered by the runs project.
		// WP10 implemented `land`: an unknown batch has no status.
		expect(await repo.land().status("lb_01k6aaaaaaaaaaaaaaaaaaaaaa"))
			.toBeNull();

		const forge = env.FORGE.getByName(uniqueName("test-rpc"));
		// identity is implemented (WP2): it answers through the same getter.
		expect(await forge.identity().setupState()).toMatchObject({
			state: "fresh",
		});
		// tree is implemented (WP3): an unknown node id is null.
		expect(await forge.tree().node("x")).toBeNull();
		// registry is implemented (WP7a): promoting an unknown installation is not found.
		const promote: () => Promise<unknown> = () =>
			forge.registry().promote("u_x", "i_x");
		const promoted = await promote().catch((e: unknown) => e);
		expect(fromRpcError(promoted).code).toBe("not_found");

		// WP6 implemented ForgeDO `events` and InboxDO.
		expect(await forge.events().head()).toBe(0);
		const inbox = env.INBOX.getByName(inboxDoName(`u_${createUlid()()}`));
		expect(await inbox.unreadCount()).toBe(0);
	});

	it("rejects facade access before the host is ready", async () => {
		await runInDurableObject(freshDo(), (_instance, state) => {
			const host = createDoHost({
				kind: "test",
				ctx: state,
				env,
				modules: { alpha: alpha(), beta },
				common: [COMMON_MIGRATIONS.base],
			});
			// blockConcurrencyWhile has not run the callback to completion yet.
			expect(() => host.facade("alpha")).toThrow(/test DO is starting/);
			return host.ready;
		});
	});
});

// ---------------------------------------------------------------------------
// WebSocket dispatch
// ---------------------------------------------------------------------------

type Recorded = { prefix: string; kind: string; data?: unknown };

const recorder = (
	prefix: string,
	log: Recorded[],
	fail = false,
): SocketHandlers => ({
	tagPrefix: prefix,
	message: (_ws, data) => {
		log.push({ prefix, kind: "message", data });
		if (fail) throw new Error("handler failed");
	},
	close: (_ws, code) => {
		log.push({ prefix, kind: "close", data: code });
	},
	error: () => {
		log.push({ prefix, kind: "error" });
	},
});

describe("WebSocket dispatch", () => {
	const fakeSocket = () => {
		const closed: { code?: number; reason?: string } = {};
		const ws = {
			close: (code: number, reason: string) => {
				closed.code = code;
				closed.reason = reason;
			},
		} as unknown as WebSocket;
		return { ws, closed };
	};

	it("routes by the first hibernation tag's prefix and isolates failures", async () => {
		const log: Recorded[] = [];
		const tags = new Map<WebSocket, string[]>();
		const dispatch = createSocketDispatch({
			ctx: { getTags: (ws) => tags.get(ws) ?? [] },
			handlers: [recorder("feed", log), recorder("runs", log, true)],
			log: () => {},
		});
		const feed = fakeSocket();
		const runs = fakeSocket();
		const stray = fakeSocket();
		tags.set(feed.ws, ["feed:repo1", "role:30"]);
		tags.set(runs.ws, ["runs"]);
		tags.set(stray.ws, ["role:30", "feed"]);

		await dispatch.message(feed.ws, "hello");
		await dispatch.close(feed.ws, 1000, "bye", true);
		await dispatch.message(runs.ws, "boom");
		await dispatch.message(stray.ws, "lost");
		await dispatch.error(stray.ws, new Error("x"));

		expect(log).toEqual([
			{ prefix: "feed", kind: "message", data: "hello" },
			{ prefix: "feed", kind: "close", data: 1000 },
			{ prefix: "runs", kind: "message", data: "boom" },
		]);
		expect(feed.closed).toEqual({});
		expect(runs.closed).toEqual({ code: 1011, reason: "internal error" });
		expect(stray.closed).toEqual({ code: 1011, reason: "no handler" });
	});

	it("rejects duplicate or malformed tag prefixes", () => {
		const log: Recorded[] = [];
		expect(() =>
			createSocketDispatch({
				ctx: { getTags: () => [] },
				handlers: [recorder("feed", log), recorder("feed", log)],
			})
		).toThrow(/registered twice/);
		expect(() =>
			createSocketDispatch({
				ctx: { getTags: () => [] },
				handlers: [recorder("Feed:x", log)],
			})
		).toThrow(/invalid socket tag prefix/);
	});

	it("dispatches hibernatable sockets accepted by a module inside a real DO", async () => {
		await runInDurableObject(freshDo(), async (_instance, state) => {
			const log: Recorded[] = [];
			const live: DoModule<object, object, Env> = {
				name: "live",
				range: [200, 249],
				migrations: [],
				create: () => ({
					facade: {},
					internal: {},
					sockets: [recorder("feed", log)],
				}),
			};
			const host = createDoHost({
				kind: "test",
				ctx: state,
				env,
				modules: { live },
				common: [COMMON_MIGRATIONS.base],
			});
			await host.ready;
			const [, server] = Object.values(new WebSocketPair());
			state.acceptWebSocket(server, ["feed:repo1"]);
			await host.webSocketMessage(server, "frame");
			await host.webSocketClose(server, 1001, "going away", true);
			expect(log).toEqual([
				{ prefix: "feed", kind: "message", data: "frame" },
				{ prefix: "feed", kind: "close", data: 1001 },
			]);
			server.close(1000, "test done");
		});
	});
});

// ---------------------------------------------------------------------------
// Module fetch: the WebSocket upgrade seam
// ---------------------------------------------------------------------------

describe("module fetch", () => {
	it("routes by DO_MODULE_HEADER to the module that accepts a hibernatable upgrade", async () => {
		await runInDurableObject(freshDo(), async (_instance, state) => {
			const log: Recorded[] = [];
			const live: DoModule<object, object, Env> = {
				name: "live",
				range: [200, 249],
				migrations: [],
				create: ({ ctx }) => ({
					facade: {},
					internal: {},
					sockets: [recorder("feed", log)],
					fetch: (req) => {
						if (req.headers.get("upgrade") !== "websocket") {
							return new Response("upgrade required", { status: 426 });
						}
						const [client, server] = Object.values(new WebSocketPair());
						ctx.acceptWebSocket(server, ["feed:repo1", "role:30"]);
						return new Response(null, { status: 101, webSocket: client });
					},
				}),
			};
			const quiet: DoModule<object, object, Env> = {
				name: "quiet",
				range: [100, 199],
				migrations: [],
				create: () => ({ facade: {}, internal: {} }),
			};
			const host = createDoHost({
				kind: "test",
				ctx: state,
				env,
				modules: { quiet, live },
				common: [COMMON_MIGRATIONS.base],
			});
			await host.ready;
			const upgrade = new Request("https://forge.test/-/live?repo=x", {
				headers: { upgrade: "websocket", [DO_MODULE_HEADER]: "quiet" },
			});
			// moduleRequest overwrites a client-supplied header.
			const routed = moduleRequest("live", upgrade);
			expect(routed.headers.get(DO_MODULE_HEADER)).toBe("live");
			const res = await host.fetch(routed);
			expect(res.status).toBe(101);
			const [server] = state.getWebSockets("feed:repo1");
			expect(server).toBeDefined();
			await host.webSocketMessage(server, "frame");
			expect(log).toEqual([{ prefix: "feed", kind: "message", data: "frame" }]);
			server.close(1000, "test done");

			expect((await host.fetch(upgrade)).status).toBe(404);
			expect(
				(await host.fetch(new Request("https://forge.test/-/live"))).status,
			).toBe(404);
			expect(
				(await host.fetch(moduleRequest("nope", upgrade))).status,
			).toBe(404);
			expect(
				(await host.fetch(moduleRequest("__proto__", upgrade))).status,
			).toBe(404);
		});
	});

	it("the thin RepoDO, ForgeDO and InboxDO answer 404 for a module without fetch", async () => {
		const req = (module: string): Request =>
			moduleRequest(
				module,
				new Request("https://forge.test/-/live", {
					headers: { upgrade: "websocket" },
				}),
			);
		// RepoDO `events` registers fetch since WP6 (the /-/live upgrade).
		const stubs = [
			[env.REPO.getByName(uniqueName("test-fetch")), "core"],
			[env.FORGE.getByName(uniqueName("test-fetch")), "events"],
			[env.INBOX.getByName(uniqueName("test-fetch")), "inbox"],
		] as const;
		for (const [stub, module] of stubs) {
			const res = await stub.fetch(req(module));
			expect(res.status).toBe(404);
			expect(await res.json()).toMatchObject({ error: "not_found" });
		}
	});
});
