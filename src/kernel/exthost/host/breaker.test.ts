// The circuit breaker and the write-ahead markers, on an isolated runtime (the
// js/wasm path; builtins never strike). The cases run on fakes: a facet that
// overruns is aborted and restarts, three timeouts open the breaker (gates then
// default, renders chip, events wait for `breaker_until`), a half-open success
// closes it, and a host killed mid-call (no timer, no rejection) leaves a
// marker that the next entry turns into a `reset` strike.

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import {
	effectiveGateDecision,
	type ExtensionModule,
	fromRpcError,
	gateOnTruncated,
} from "@tartan/contract";
import { BREAKER } from "@tartan/contract/kernel.ts";
import { INFLIGHT_GRACE_MS, strikeKindOf } from "./breaker.ts";
import {
	addHello,
	deliveries,
	poke,
	renderCtx,
	viewer,
} from "./testing/conformance.ts";
import { NODES, PRINCIPALS, userActor } from "./testing/fakes.ts";
import { helloManifest, helloModule } from "./testing/hello.ts";
import { createTestHost, query, type TestHost } from "./testing/memory.ts";

const breakerState = (t: TestHost) =>
	Object.fromEntries(
		query<{ k: string; v: string }>(
			t,
			"SELECT k, v FROM _host WHERE k LIKE 'breaker%'",
		).map((r) => [r.k, r.v]),
	);

const strikes = (t: TestHost) =>
	query<{ kind: string; method: string }>(
		t,
		"SELECT kind, method FROM _strikes ORDER BY seq",
	);

const advanceInput = {
	point: "ref.advance" as const,
	repo: NODES.router.id,
	ref: "refs/heads/main",
	base: "a".repeat(40),
	head: "b".repeat(40),
	changeId: "k".repeat(32),
	changedPaths: [],
	addedLines: [],
	truncated: false,
	workRefs: [],
	actor: userActor(PRINCIPALS.dev),
};

Deno.test("strikeKindOf classifies facet RPC rejections", () => {
	strictEqual(
		strikeKindOf(new Error("Worker exceeded CPU time limit.")),
		"cpu",
	);
	strictEqual(strikeKindOf(new Error("The code had hung")), "hung");
	strictEqual(
		strikeKindOf(
			new Error("Durable Object reset because its code was updated."),
		),
		"reset",
	);
	// A workerd internal error from a facet call is a platform failure.
	strictEqual(
		strikeKindOf(
			new Error("internal error; reference = 0000000000000000"),
		),
		"reset",
	);
	strictEqual(strikeKindOf(new Error("boom")), null);
	strictEqual(strikeKindOf(new Error("internal: an extension error")), null);
});

Deno.test("builtins never strike: an overrun is a timeout, nothing more", async () => {
	const t = await createTestHost({ budgets: { event: 20 } });
	try {
		addHello(t, "slow", { ms: 60 });
		await poke(t);
		strictEqual(strikes(t).length, 0);
		strictEqual(query(t, "SELECT 1 FROM _inflight").length, 0);
		ok(
			query<{ error: string }>(t, "SELECT error FROM _retry")[0].error.includes(
				"exceeded",
			),
		);
	} finally {
		t.close();
	}
});

Deno.test("breaker: an awaiting facet that overruns its budget is aborted and the next call restarts it", async () => {
	let instances = 0;
	const t = await createTestHost({
		isolated: true,
		budgets: { event: 20 },
		module: () => {
			instances += 1;
			return helloModule;
		},
	});
	try {
		addHello(t, "slow", { ms: 5000 });
		const started = Date.now();
		await poke(t);
		ok(Date.now() - started < 1000, "the host did not wait for the facet");
		deepStrictEqual(strikes(t), [{ kind: "timeout", method: "onEvent" }]);
		strictEqual(instances, 2, "aborted, then restarted fresh");
		strictEqual(query(t, "SELECT 1 FROM _inflight").length, 0);
	} finally {
		t.close();
	}
});

Deno.test("breaker: three timeouts in 10 minutes open the breaker; gates default, renders chip, events wait; a half-open success closes it", async () => {
	const t = await createTestHost({
		isolated: true,
		budgets: { event: 20, render: 20 },
	});
	try {
		addHello(t, "slow", { ms: 5000 });
		await poke(t);
		// The retries of the same event are the next two timeouts.
		for (let i = 0; i < 2; i++) {
			const next =
				query<{ at: number }>(t, "SELECT MIN(at) AS at FROM _timers")[0].at;
			t.clock.set(next);
			await t.alarm();
		}
		strictEqual(strikes(t).length, BREAKER.strikes);
		const state = breakerState(t);
		strictEqual(state.breaker, "open");
		const until = Number(state.breaker_until);
		strictEqual(until, t.clock.now() + BREAKER.cooldownMs);
		const errors = t.kernel.forgeAppended as { data: { breaker?: string } }[];
		ok(
			errors.some((e) => e.data.breaker === "open"),
			"extension.error{breaker:'open'}",
		);
		const [notice] = t.kernel.notices;
		strictEqual(
			notice.principal,
			PRINCIPALS.maintainer,
			"the installer is told",
		);
		strictEqual(notice.notice.severity, "critical");

		// A gate short-circuits: the dispatcher maps it to the manifest default.
		const gateError = await t.host.gate("ref.advance", advanceInput, renderCtx)
			.then(() => null, (e) => e);
		strictEqual(fromRpcError(gateError).code, "unavailable");
		const gate = helloManifest().gates![0];
		const effective = effectiveGateDecision({
			installation: "i",
			ext: "tartan.hello",
			mode: "enforce",
			onTruncated: gateOnTruncated(gate),
			default: gate.default,
			outcome: { kind: "error", message: fromRpcError(gateError).text },
		}, false);
		deepStrictEqual([effective.decision, effective.basis], [
			"allow",
			"default",
		]);

		// Renders return the error chip.
		const chip = await t.host.render(
			"greeting",
			renderCtx,
			viewer(PRINCIPALS.dev),
		);
		strictEqual(chip.root.t, "error-chip");

		// Events wait for breaker_until without spending attempts.
		const before = deliveries(t).length;
		addHello(t, "note");
		await poke(t);
		strictEqual(deliveries(t).length, before);
		const retry =
			query<{ next_at: number }>(t, "SELECT next_at FROM _retry")[0];
		ok(retry.next_at <= until);

		// Half-open after the cooldown: one call is let through; success closes it.
		t.clock.set(until);
		const ok1 = await t.host.render(
			"greeting",
			renderCtx,
			viewer(PRINCIPALS.dev),
		);
		strictEqual(ok1.root.t, "stack");
		strictEqual(breakerState(t).breaker, "closed");
		strictEqual(strikes(t).length, 0);
	} finally {
		t.close();
	}
});

Deno.test("a strike while half-open reopens the breaker with a doubled cooldown", async () => {
	const t = await createTestHost({ isolated: true, budgets: { render: 20 } });
	try {
		for (let i = 0; i < BREAKER.strikes; i++) {
			await t.host.render("slow", renderCtx, viewer(PRINCIPALS.dev));
		}
		const first = Number(breakerState(t).breaker_until);
		t.clock.set(first);
		await t.host.render("slow", renderCtx, viewer(PRINCIPALS.dev));
		const state = breakerState(t);
		strictEqual(state.breaker, "open");
		strictEqual(Number(state.breaker_until), first + 2 * BREAKER.cooldownMs);
		strictEqual(state.breaker_trips, "2");
	} finally {
		t.close();
	}
});

Deno.test("breaker: the status lists its strikes; an Owner reset closes it and the next call runs", async () => {
	const t = await createTestHost({ isolated: true, budgets: { render: 20 } });
	try {
		const fresh = await t.host.breaker();
		deepStrictEqual(
			[fresh.state, fresh.until, fresh.trips, fresh.recentStrikes],
			["closed", null, 0, 0],
		);
		for (let i = 0; i < BREAKER.strikes; i++) {
			await t.host.render("slow", renderCtx, viewer(PRINCIPALS.dev));
		}
		const open = await t.host.breaker();
		strictEqual(open.state, "open");
		strictEqual(open.trips, 1);
		strictEqual(open.recentStrikes, BREAKER.strikes);
		deepStrictEqual(open.strikes.map((s) => [s.method, s.kind]), [
			["render slow", "timeout"],
			["render slow", "timeout"],
			["render slow", "timeout"],
		]);
		ok(open.strikes[0].seq > open.strikes[2].seq, "newest first");
		// Outside the window the strikes stay listed but no longer count.
		t.clock.set(t.clock.now() + BREAKER.windowMs + 1);
		strictEqual((await t.host.breaker()).recentStrikes, 0);
		strictEqual((await t.host.breaker()).strikes.length, BREAKER.strikes);

		const reset = await t.host.resetBreaker(PRINCIPALS.maintainer);
		deepStrictEqual(
			[reset.state, reset.until, reset.trips, reset.strikes.length],
			["closed", null, 0, 0],
		);
		const lines = await t.host.console(0, 100);
		ok(
			lines.some((l) =>
				l.msg.includes(`circuit breaker reset by ${PRINCIPALS.maintainer}`) &&
				l.msg.includes("was open")
			),
			JSON.stringify(lines),
		);
		// A call that does not overrun runs at once (no half-open wait).
		const greeting = await t.host.render(
			"greeting",
			renderCtx,
			viewer(PRINCIPALS.dev),
		);
		strictEqual(greeting.root.t, "stack");
	} finally {
		t.close();
	}
});

Deno.test("a host killed mid-call leaves a marker; the next entry converts it into a reset strike; three open the breaker", async () => {
	// A facet whose call never settles and whose host dies with it.
	const hung: ExtensionModule = {
		...helloModule,
		callTool: () => new Promise(() => {}),
	};
	const t = await createTestHost({
		isolated: true,
		module: () => hung,
		budgets: { tool: 60_000 },
	});
	try {
		for (let i = 0; i < BREAKER.strikes; i++) {
			// Fire and forget: the "invocation" never returns.
			void t.host.callTool("count", {}, {
				node: NODES.router.id,
				repo: NODES.router.id,
				scope: NODES.router.path,
				actor: userActor(PRINCIPALS.dev),
				mode: "enforce",
			}, { maxRole: 50, scopes: null, nodeId: null, laneId: null }).catch(
				() => {},
			);
			await new Promise((r) => setTimeout(r, 5));
			strictEqual(
				query(t, "SELECT 1 FROM _inflight").length,
				1,
				"marker written ahead",
			);
			ok(t.storage.syncs > 0, "storage.sync() before the facet call");
			// The host dies: a new instance over the same storage, no timer, no rejection.
			await t.restart();
			t.clock.advance(60_000 + INFLIGHT_GRACE_MS + 1);
			// Any later entry converts the stale marker first.
			await poke(t);
			strictEqual(strikes(t).length, i + 1);
		}
		deepStrictEqual(strikes(t).map((s) => s.kind), ["reset", "reset", "reset"]);
		strictEqual(query(t, "SELECT 1 FROM _inflight").length, 0);
		strictEqual(breakerState(t).breaker, "open");
		const errors = t.kernel.forgeAppended as { data: { breaker?: string } }[];
		ok(errors.some((e) => e.data.breaker === "open"));
	} finally {
		t.close();
	}
});
