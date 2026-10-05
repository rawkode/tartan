// The extension conformance suite: one list of cases
// every runtime must pass with the `hello` extension: migrations and init,
// dedupe, ordering, backfill from 0, retry → dead letter, `skip` vs `block`,
// timers, quota, render validation and the error chip, a denied capability,
// the kill switch and upgrade through `abort`. TEST FIXTURE (Deno: it runs on
// the in-memory host).
//
// `conformance.test.ts` runs it for the builtin runtime, for an isolated
// in-process runtime (breaker, markers, abort) and for the `js` runtime: the
// dynamic loader and the shipped facet core over an in-memory facet with its
// own database (testing/facet.ts). Extension tables are read from the
// extension's database (`extQuery`), host tables from the host's.

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import type { Manifest } from "@tartan/contract";
import { EVENT_RETRY_BACKOFF_MS } from "@tartan/contract/kernel.ts";
import { BLOCKED_AT, EVENT_MAX_ATTEMPTS } from "../host.ts";
import { INSTALLATION_REVALIDATE_MS } from "../installation.ts";
import { NODES, PRINCIPALS, userActor } from "./fakes.ts";
import { helloManifest } from "./hello.ts";
import {
	extQuery,
	query,
	type TestHost,
	type TestHostOptions,
} from "./memory.ts";

export const ROUTER_STREAM = `repo:${NODES.router.id}` as const;

export const addHello = (
	t: TestHost,
	name: string,
	data: Record<string, unknown> = {},
	at?: number,
) =>
	t.kernel.addEvent(NODES.router.id, {
		type: `x.tartan.hello.${name}`,
		data,
		...(at === undefined ? {} : { at }),
	});

export const poke = (t: TestHost) =>
	t.host.poke({ stream: ROUTER_STREAM, head: t.kernel.head(NODES.router.id) });

export const deliveries = (t: TestHost) =>
	extQuery<{ event_id: string; seq: number; type: string; actor: string }>(
		t,
		"SELECT event_id, seq, type, actor FROM deliveries ORDER BY rowid",
	);

export const counter = (t: TestHost, k: string): number =>
	Number(
		extQuery<{ n: number }>(t, "SELECT n FROM counters WHERE k = ?", k)[0]?.n ??
			0,
	);

export const cursor = (t: TestHost) =>
	query<{ seq: number; known_head: number }>(
		t,
		"SELECT seq, known_head FROM _cursors WHERE stream = ?",
		ROUTER_STREAM,
	)[0];

/** Advances the clock to the next pending timer and runs the alarm. */
export const nextAlarm = async (t: TestHost): Promise<boolean> => {
	const next = query<{ at: number | null }>(
		t,
		"SELECT MIN(at) AS at FROM _timers",
	)[0]
		?.at;
	if (next === null || next === undefined) return false;
	if (next > t.clock.now()) t.clock.set(next);
	await t.alarm();
	return true;
};

export const viewer = (id: string, role = 30) => ({
	actor: userActor(id),
	role,
	kind: "user" as const,
});

export const renderCtx = {
	node: NODES.router.id,
	repo: NODES.router.id,
	mode: "enforce" as const,
};

export type ConformanceCase = {
	readonly name: string;
	readonly options?: TestHostOptions;
	run(t: TestHost): Promise<void>;
};

export const CONFORMANCE: readonly ConformanceCase[] = [
	{
		name:
			"migrations run once, then init once per version (also across a restart)",
		run: async (t) => {
			await t.host.console(0, 10);
			await poke(t);
			strictEqual(counter(t, "init"), 1);
			deepStrictEqual(
				extQuery(t, "SELECT n FROM _ext_migrations ORDER BY n").map((r) => r.n),
				[1],
			);
			await t.restart();
			await poke(t);
			strictEqual(counter(t, "init"), 1);
		},
	},
	{
		name: "ordering: events are delivered in seq order",
		run: async (t) => {
			for (let i = 0; i < 5; i++) addHello(t, "note", { i });
			await poke(t);
			deepStrictEqual(deliveries(t).map((d) => d.seq), [1, 2, 3, 4, 5]);
			strictEqual(cursor(t).seq, 5);
		},
	},
	{
		name: "dedupe: a repeated poke or a rewound cursor never redelivers",
		run: async (t) => {
			addHello(t, "note");
			addHello(t, "note");
			await poke(t);
			await poke(t);
			t.storage.sql.exec("UPDATE _cursors SET seq = 0");
			await poke(t);
			strictEqual(deliveries(t).length, 2);
		},
	},
	{
		name: "backfill from 0: history before the first poke is delivered",
		run: async (t) => {
			addHello(t, "old", {}, 1);
			addHello(t, "old", {}, 2);
			addHello(t, "old", {}, 3);
			await poke(t);
			strictEqual(deliveries(t).length, 3);
		},
	},
	{
		name: "backfill none: only events after the install are delivered",
		options: { installation: { backfill: "none", installedAt: 10_000 } },
		run: async (t) => {
			for (let at = 1000; at <= 9000; at += 1000) addHello(t, "old", {}, at);
			addHello(t, "new", {}, 20_000);
			addHello(t, "new", {}, 30_000);
			await poke(t);
			deepStrictEqual(deliveries(t).map((d) => d.type), [
				"x.tartan.hello.new",
				"x.tartan.hello.new",
			]);
		},
	},
	{
		name:
			"manifest filters: only matching events are delivered, the cursor moves past the rest",
		run: async (t) => {
			t.kernel.addEvent(NODES.router.id, {
				type: "review.decided",
				data: { decision: "request_changes" },
			});
			t.kernel.addEvent(NODES.router.id, {
				type: "review.decided",
				data: { decision: "approve" },
			});
			await poke(t);
			deepStrictEqual(deliveries(t).map((d) => d.seq), [2]);
			strictEqual(cursor(t).seq, 2);
		},
	},
	{
		name: "retry with backoff, then a dead letter (onError skip moves on)",
		run: async (t) => {
			const bad = addHello(t, "fail");
			const after = addHello(t, "note");
			await poke(t);
			const firstRetry = query<{ attempts: number; next_at: number }>(
				t,
				"SELECT attempts, next_at FROM _retry",
			)[0];
			strictEqual(firstRetry.attempts, 1);
			strictEqual(
				firstRetry.next_at,
				t.clock.now() + EVENT_RETRY_BACKOFF_MS[0],
			);
			for (let i = 0; i < EVENT_MAX_ATTEMPTS + 2; i++) await nextAlarm(t);
			const dead = query<{ event_id: string; attempts: number }>(
				t,
				"SELECT event_id, attempts FROM _dead",
			);
			deepStrictEqual(dead, [{
				event_id: bad.id,
				attempts: EVENT_MAX_ATTEMPTS,
			}]);
			strictEqual(
				deliveries(t).filter((d) => d.event_id === bad.id).length,
				EVENT_MAX_ATTEMPTS,
			);
			ok(
				deliveries(t).some((d) => d.event_id === after.id),
				"the stream moved on",
			);
			const errors = t.kernel.forgeAppended as {
				type: string;
				data: { eventId?: string };
			}[];
			ok(
				errors.some((e) =>
					e.type === "extension.error" && e.data.eventId === bad.id
				),
			);
			deepStrictEqual(
				await t.host.deadLetters(10).then((d) => d.map((r) => r.event_id)),
				[
					bad.id,
				],
			);
		},
	},
	{
		name: "a flaky handler succeeds on retry and is then seen once",
		run: async (t) => {
			const flaky = addHello(t, "flaky", { failTimes: 2 });
			await poke(t);
			await nextAlarm(t);
			await nextAlarm(t);
			strictEqual(
				query(t, "SELECT 1 FROM _seen WHERE event_id = ?", flaky.id).length,
				1,
			);
			strictEqual(query(t, "SELECT 1 FROM _retry").length, 0);
			strictEqual(cursor(t).seq, 1);
		},
	},
	{
		name: "onError block: the dead letter pauses the stream",
		options: { manifest: helloManifest({ onError: "block" }) },
		run: async (t) => {
			addHello(t, "fail");
			const later = addHello(t, "note");
			await poke(t);
			for (let i = 0; i < EVENT_MAX_ATTEMPTS + 2; i++) await nextAlarm(t);
			strictEqual(query(t, "SELECT 1 FROM _dead").length, 1);
			const retry = query<{ next_at: number; error: string }>(
				t,
				"SELECT next_at, error FROM _retry",
			)[0];
			strictEqual(retry.next_at, BLOCKED_AT);
			ok(retry.error.startsWith("blocked:"));
			await poke(t);
			ok(!deliveries(t).some((d) => d.event_id === later.id), "blocked");
		},
	},
	{
		name:
			"timers: set from a handler, fired by the alarm; a failing timer gives up after its attempts",
		run: async (t) => {
			addHello(t, "timer", { key: "tick", inMs: 1000 });
			addHello(t, "timer", { key: "fail-once", inMs: 1000 });
			await poke(t);
			ok(
				query(t, "SELECT 1 FROM _timers WHERE module = 'ext' AND key = 'tick'")
					.length,
			);
			for (let i = 0; i < 12; i++) {
				if (!await nextAlarm(t)) break;
			}
			deepStrictEqual(
				extQuery<{ key: string; n: number }>(
					t,
					"SELECT key, COUNT(*) AS n FROM fired GROUP BY key ORDER BY key",
				),
				[{ key: "fail-once", n: 5 }, { key: "tick", n: 1 }],
			);
			strictEqual(
				query(t, "SELECT 1 FROM _timers WHERE module = 'ext'").length,
				0,
			);
			const errors = t.kernel.forgeAppended as { data: { error: string } }[];
			ok(errors.some((e) => e.data.error.includes("timer fail-once")));
		},
	},
	{
		name: "quota: growth above quotaMB is denied (quota) and reported",
		options: {
			manifest: helloManifest({
				storage: {
					scope: "repo",
					migrations: ["migrations/0001_init.sql"],
					quotaMB: 1,
				},
			}),
		},
		run: async (t) => {
			addHello(t, "bloat", { rows: 700, size: 2000 });
			await poke(t);
			const retry = query<{ error: string }>(t, "SELECT error FROM _retry")[0];
			ok(retry?.error.includes("quota"), retry?.error);
			const errors = t.kernel.forgeAppended as { data: { error: string } }[];
			ok(errors.some((e) => e.data.error.includes("storage quota exceeded")));
		},
	},
	{
		name:
			"render: a valid tree passes; an invalid one or an overrun is the error chip",
		options: { budgets: { render: 50 } },
		run: async (t) => {
			const good = await t.host.render(
				"greeting",
				renderCtx,
				viewer(PRINCIPALS.dev),
			);
			strictEqual(good.root.t, "stack");
			for (const slot of ["bad", "slow", "nope"]) {
				const chip = await t.host.render(
					slot,
					renderCtx,
					viewer(PRINCIPALS.dev),
				);
				deepStrictEqual(chip.root, {
					t: "error-chip",
					text: "tartan.hello: render failed",
				}, slot);
			}
		},
	},
	{
		name: "a denied capability is denied (grant), not silently done",
		run: async (t) => {
			addHello(t, "ungranted");
			await poke(t);
			strictEqual(counter(t, "ungranted:denied:grant"), 1);
			strictEqual(t.kernel.called("runs.get").length, 0);
		},
	},
	{
		name:
			"kill switch: a disabled installation refuses calls; re-enabled, it catches up",
		run: async (t) => {
			await poke(t);
			await t.host.abort("disabled");
			addHello(t, "note");
			await poke(t);
			strictEqual(deliveries(t).length, 0);
			const chip = await t.host.render(
				"greeting",
				renderCtx,
				viewer(PRINCIPALS.dev),
			);
			strictEqual(chip.root.t, "error-chip");
			const gate = await t.host.gate("push", {
				point: "push",
				repo: NODES.router.id,
				target: "repo",
				commands: [],
				actor: userActor(PRINCIPALS.dev),
				truncated: false,
			}, renderCtx).catch((e: { code?: string; reason?: string }) =>
				`${e.code}:${e.reason}`
			);
			strictEqual(gate, "denied:disabled");
			// Re-enabled in the registry: noticed at the next revalidation.
			t.installations.set((s) => s);
			t.clock.advance(INSTALLATION_REVALIDATE_MS);
			await poke(t);
			strictEqual(deliveries(t).length, 1);
		},
	},
	{
		name: "upgrade through abort: the new version's migrations run, then init",
		run: async (t) => {
			await poke(t);
			strictEqual(counter(t, "init"), 1);
			const v2: Manifest = helloManifest({
				version: "0.2.0",
				storage: {
					scope: "repo",
					migrations: ["migrations/0001_init.sql", "migrations/0002_notes.sql"],
				},
			});
			t.installations.set((s) => ({
				...s,
				manifest: v2,
				installation: { ...s.installation, version: "0.2.0" },
				sha256: "b".repeat(64),
			}));
			await t.host.abort("upgrade");
			await poke(t);
			deepStrictEqual(
				extQuery(t, "SELECT n FROM _ext_migrations ORDER BY n").map((r) => r.n),
				[1, 2],
			);
			strictEqual(counter(t, "init"), 2);
		},
	},
];
