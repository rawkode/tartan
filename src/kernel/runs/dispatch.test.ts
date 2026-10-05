// WP26: run transport, `dispatch()` and the outbox backstop, on the runs
// module over node:sqlite.

import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import type { RunStatus } from "@tartan/contract";
import { K2_DISPATCH_GRACE_MS } from "../bus/config.ts";
import type { RunStatusK2 } from "../bus/contract.ts";
import { OUTBOX_RETRY_AFTER_MS } from "./module.ts";
import { ciGraph, runsHarness } from "./testing/runs.ts";

const EXT = "i_01k6aaaaaaaaaaaaaaaaaaaaab";

const dispatchedEvents = (h: ReturnType<typeof runsHarness>) =>
	h.events.appended.filter((e) => e.type === "run.dispatched");

Deno.test("a k2 run is not dispatched inline; the consumer's dispatch creates it once", async () => {
	const h = runsHarness({}, { transport: "k2" });
	const { runId } = await h.runs.start({
		graph: ciGraph({ subject: { kind: "land", id: "b1" } }),
		idemKey: "k1",
		requestedBy: EXT,
	});
	equal(h.calls.created.length, 0);
	const row = h.internal.runSync(runId)!;
	equal(row.transport, "k2");
	equal(row.dispatch_due_at, h.clock.now() + K2_DISPATCH_GRACE_MS);
	equal(h.timers.get("outbox"), h.clock.now() + K2_DISPATCH_GRACE_MS);
	const started = h.events.appended[0].data as Record<string, unknown>;
	equal(started.transport, "k2");
	equal(started.priority, "land");
	equal(started.kind, "ci");

	h.clock.advance(900);
	equal(await h.runs.dispatch(runId, { via: "k2" }), "dispatched");
	equal(await h.runs.dispatch(runId, { via: "k2" }), "already");
	equal(h.calls.created.length, 1);
	const events = dispatchedEvents(h);
	equal(events.length, 1);
	deepEqual(events[0].data, {
		runId,
		state: "queued",
		via: "k2",
		lagMs: 900,
		subject: { kind: "land", id: "b1" },
	});
	const status = (await h.runs.get(runId))! as RunStatus & RunStatusK2;
	equal(status.transport, "k2");
	equal(status.via, "k2");
	equal(status.dispatchedAt, h.clock.now());

	// The backstop finds nothing left to do.
	h.clock.advance(K2_DISPATCH_GRACE_MS);
	await h.fireOutbox();
	equal(h.calls.created.length, 1);
	equal(dispatchedEvents(h).length, 1);
});

Deno.test("K2 silent and no further start: the backstop dispatches within the grace (via backstop)", async () => {
	const h = runsHarness({}, { transport: "k2" });
	const { runId } = await h.runs.start({
		graph: ciGraph({ subject: { kind: "land", id: "b1" } }),
		idemKey: "k1",
		requestedBy: EXT,
	});
	const due = h.timers.get("outbox")!;
	ok(due - h.clock.now() <= K2_DISPATCH_GRACE_MS);
	h.clock.set(due);
	await h.fireOutbox();
	equal(h.internal.runSync(runId)!.via, "backstop");
	equal(h.calls.created.length, 1);
	equal(
		(dispatchedEvents(h)[0].data as Record<string, unknown>).via,
		"backstop",
	);
	// A late consumer delivery is harmless.
	equal(await h.runs.dispatch(runId, { via: "k2" }), "already");
	equal(dispatchedEvents(h).length, 1);
});

Deno.test("concurrent dispatch (the consumer racing the backstop) gives one instance and one run.dispatched", async () => {
	const h = runsHarness({}, { transport: "k2", createDelayMs: 20 });
	const { runId } = await h.runs.start({
		graph: ciGraph(),
		idemKey: "k1",
		requestedBy: EXT,
	});
	h.clock.advance(K2_DISPATCH_GRACE_MS);
	const [a, b] = await Promise.all([
		h.runs.dispatch(runId, { via: "k2" }),
		h.fireOutbox().then(() => "fired"),
		h.runs.dispatch(runId, { via: "backstop" }),
	]);
	equal(a, "dispatched");
	equal(b, "fired");
	equal(h.calls.created.length, 1);
	equal(dispatchedEvents(h).length, 1);
	equal(await h.runs.dispatch(runId, { via: "k2" }), "already");
});

Deno.test("dispatch skips terminal, superseded and unknown runs", async () => {
	const h = runsHarness({}, { transport: "k2" });
	const graph = ciGraph({ concurrencyGroup: "change:c1" });
	const first = await h.runs.start({ graph, idemKey: "r1", requestedBy: EXT });
	const second = await h.runs.start({ graph, idemKey: "r2", requestedBy: EXT });
	equal(await h.runs.dispatch(first.runId, { via: "k2" }), "superseded");
	await h.runs.cancel(second.runId, "u_01k6aaaaaaaaaaaaaaaaaaaaac");
	equal(await h.runs.dispatch(second.runId, { via: "k2" }), "terminal");
	equal(
		await h.runs.dispatch("01k6zzzzzzzzzzzzzzzzzzzzzz", { via: "k2" }),
		"unknown-run",
	);
	equal(h.calls.created.length, 0);
	// The backstop skips them too.
	h.clock.advance(K2_DISPATCH_GRACE_MS);
	await h.fireOutbox();
	equal(h.calls.created.length, 0);
	equal(h.timers.get("outbox") ?? null, null);
	await rejects(
		h.runs.dispatch(first.runId, { via: "nope" as "k2" }),
		/via is k2, backstop or local/,
	);
	await rejects(h.runs.dispatch("x", { via: "k2" }), /ulid/);
});

Deno.test("a failed create under k2 dispatch throws (the consumer retries) and the timer retries it", async () => {
	const h = runsHarness({}, { transport: "k2" });
	const { runId } = await h.runs.start({
		graph: ciGraph(),
		idemKey: "k1",
		requestedBy: EXT,
	});
	h.failNextCreates(1);
	await rejects(
		h.runs.dispatch(runId, { via: "k2" }),
		/workflows unavailable/,
	);
	const retryAt = h.clock.now() + OUTBOX_RETRY_AFTER_MS;
	equal(h.internal.runSync(runId)!.dispatch_due_at, retryAt);
	// The grace timer fires first and finds the row not yet due.
	h.clock.advance(K2_DISPATCH_GRACE_MS);
	await h.fireOutbox();
	equal(h.calls.created.length, 0);
	equal(h.timers.get("outbox"), retryAt);
	h.clock.set(retryAt);
	await h.fireOutbox();
	equal(h.calls.created.length, 1);
	equal(h.internal.runSync(runId)!.via, "backstop");
});

Deno.test("the outbox dispatches at most 25 per run and re-arms while due rows remain", async () => {
	const h = runsHarness({}, { transport: "k2" });
	for (let i = 0; i < 30; i++) {
		await h.runs.start({
			graph: ciGraph({ subject: { kind: "change", id: `c${i}` } }),
			idemKey: `k${i}`,
			requestedBy: EXT,
		});
	}
	h.clock.advance(K2_DISPATCH_GRACE_MS);
	await h.fireOutbox();
	equal(h.calls.created.length, 25);
	ok((h.timers.get("outbox") ?? Infinity) <= h.clock.now() + 1);
	await h.fireOutbox();
	equal(h.calls.created.length, 30);
	equal(dispatchedEvents(h).length, 30);
	ok(
		dispatchedEvents(h).every((e) =>
			(e.data as Record<string, unknown>).via === "backstop"
		),
	);
});

Deno.test("the transport port decides per run; a repeated k2 start does not bypass the log", async () => {
	const asked: { kind: string; requestedBy: string }[] = [];
	const h = runsHarness({}, {
		transport: {
			choose: (input) => {
				asked.push(input);
				return Promise.resolve(input.requestedBy === "kernel" ? "local" : "k2");
			},
		},
	});
	const kernel = await h.runs.start({
		graph: ciGraph(),
		idemKey: "a",
		requestedBy: "kernel",
	});
	const ext = await h.runs.start({
		graph: ciGraph(),
		idemKey: "b",
		requestedBy: EXT,
	});
	deepEqual(asked, [
		{ kind: "ci", requestedBy: "kernel" },
		{ kind: "ci", requestedBy: EXT },
	]);
	equal(h.internal.runSync(kernel.runId)!.instance_created, 1);
	equal(h.internal.runSync(ext.runId)!.instance_created, 0);
	await h.runs.start({ graph: ciGraph(), idemKey: "b", requestedBy: EXT });
	equal(h.internal.runSync(ext.runId)!.instance_created, 0);
	equal(asked.length, 2);
});

Deno.test("two starts with one idemKey racing over the transport choice give one run", async () => {
	// A cold k2 health cache: choose() is an RPC, and the input gate opens.
	let open!: () => void;
	const health = new Promise<void>((resolve) => {
		open = resolve;
	});
	const h = runsHarness({}, {
		transport: { choose: () => health.then(() => "local" as const) },
	});
	const start = () =>
		h.runs.start({ graph: ciGraph(), idemKey: "same", requestedBy: EXT });
	const both = Promise.all([start(), start()]);
	await new Promise((resolve) => setTimeout(resolve, 0));
	open();
	const [a, b] = await both;
	equal(a.runId, b.runId, "the second start returns the first run");
	equal(
		h.events.appended.filter((e) => e.type === "run.started").length,
		1,
	);
	equal(h.calls.created.length, 1, "one instance");
});
