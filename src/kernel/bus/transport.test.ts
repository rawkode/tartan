// Runtime transport selection (WP26).

import { equal } from "node:assert/strict";
import { K2_HEALTH_FRESH_MS, K2_HEALTH_TTL_MS } from "./config.ts";
import type { BusStatus } from "./contract.ts";
import type { K2Env } from "./k2.ts";
import {
	consumerIsHealthy,
	createConsumerHealth,
	createTransportPort,
	selectTransport,
	type TransportInputs,
} from "./transport.ts";
import { testClock } from "./testing/do.ts";

const ALL: TransportInputs = {
	kind: "ci",
	requestedBy: "i_01k6aaaaaaaaaaaaaaaaaaaaab",
	maximum: "k2",
	producer: true,
	stream: true,
	token: true,
	relay: "ok",
	consumerHealthy: true,
};

Deno.test("selectTransport: k2 only when every condition holds", () => {
	equal(selectTransport(ALL), "k2");
	const misses: Partial<TransportInputs>[] = [
		{ kind: "git" },
		{ requestedBy: "kernel" },
		{ maximum: "local" },
		{ producer: false },
		{ stream: false },
		{ token: false },
		{ relay: "backoff" },
		{ relay: "blocked" },
		{ relay: "off" },
		{ relay: null },
		{ consumerHealthy: false },
	];
	for (const miss of misses) {
		equal(selectTransport({ ...ALL, ...miss }), "local", JSON.stringify(miss));
	}
});

const status = (over: Partial<BusStatus> = {}): BusStatus => ({
	group: "workloads",
	worker: 0,
	consume: "ok",
	subscription: "workloads-x",
	lastPollOkAt: 1_000_000,
	lastRecordAt: null,
	consumerLagMs: null,
	records: 0,
	retry: 0,
	dead: 0,
	resubscribed: 0,
	lastError: null,
	via: [],
	relayLags: [],
	relayLagsAt: null,
	...over,
});

Deno.test("consumerIsHealthy: polled within 15 s with a subscription", () => {
	const now = 1_000_000;
	equal(consumerIsHealthy(status(), now), true);
	equal(consumerIsHealthy(status(), now + K2_HEALTH_FRESH_MS), true);
	equal(consumerIsHealthy(status(), now + K2_HEALTH_FRESH_MS + 1), false);
	equal(consumerIsHealthy(status({ consume: "off" }), now), false);
	equal(consumerIsHealthy(status({ consume: "error" }), now), false);
	equal(consumerIsHealthy(status({ subscription: null }), now), false);
	equal(consumerIsHealthy(status({ lastPollOkAt: null }), now), false);
	equal(consumerIsHealthy(null, now), false);
});

Deno.test("consumer health is cached 30 s (one RPC per DO); errors and timeouts are unhealthy", async () => {
	const clock = testClock(1_000_000);
	let calls = 0;
	let answer: () => Promise<BusStatus | null> = () =>
		Promise.resolve(status({ lastPollOkAt: clock.now() }));
	const health = createConsumerHealth({
		clock,
		status: () => {
			calls += 1;
			return answer();
		},
		timeoutMs: 20,
	});
	equal(await health.healthy(), true);
	equal(await health.healthy(), true);
	equal(calls, 1);
	clock.advance(K2_HEALTH_TTL_MS);
	answer = () => Promise.reject(new Error("RPC down"));
	equal(await health.healthy(), false);
	equal(calls, 2);
	clock.advance(K2_HEALTH_TTL_MS);
	answer = () => new Promise(() => {});
	equal(await health.healthy(), false);
	clock.advance(K2_HEALTH_TTL_MS);
	answer = () =>
		Promise.resolve(status({ lastPollOkAt: clock.now() - 60_000 }));
	equal(await health.healthy(), false);
	// Concurrent callers share one RPC.
	clock.advance(K2_HEALTH_TTL_MS);
	answer = () => Promise.resolve(status({ lastPollOkAt: clock.now() }));
	const before = calls;
	const both = await Promise.all([health.healthy(), health.healthy()]);
	equal(both.every(Boolean), true);
	equal(calls, before + 1);
});

const bus = (s: () => Promise<BusStatus>, counter: { n: number }) => ({
	getByName: () => ({
		bus: () => ({
			status: () => {
				counter.n += 1;
				return s();
			},
			nudge: () => Promise.resolve(),
			wake: () => s(),
			deadList: () => Promise.resolve({ dead: [] }),
			deadRetry: () => Promise.resolve(false),
			deadDiscard: () => Promise.resolve(false),
			recordRelayLags: () => Promise.resolve(),
		}),
	}),
});

const env = (
	over: Partial<K2Env>,
	counter: { n: number },
	clock: { now(): number },
): K2Env => ({
	TARTAN_STAGE: "dev",
	EVENT_LOG: { send: () => Promise.resolve({ success: true }) },
	TARTAN_K2_STREAM: "0123456789abcdef0123456789abcdef",
	TARTAN_K2_TOKEN: { get: () => Promise.resolve("t") },
	BUS: bus(
		() => Promise.resolve(status({ lastPollOkAt: clock.now() })),
		counter,
	),
	...over,
});

Deno.test("transport port: no token, no binding (the button path) or local switch → local, without asking the consumer", async () => {
	const clock = testClock();
	const cases: Partial<K2Env>[] = [
		{ TARTAN_K2_TOKEN: undefined },
		{ EVENT_LOG: undefined },
		{ TARTAN_K2_STREAM: undefined },
		{ TARTAN_K2_STREAM: "" },
	];
	for (const over of cases) {
		const counter = { n: 0 };
		const port = createTransportPort({
			maximum: "k2",
			env: env(over, counter, clock),
			relay: () => "ok",
			clock,
		});
		equal(await port.choose({ kind: "ci", requestedBy: "i_x" }), "local");
		equal(counter.n, 0);
	}
	const counter = { n: 0 };
	const local = createTransportPort({
		maximum: "local",
		env: env({}, counter, clock),
		relay: () => "ok",
		clock,
	});
	equal(await local.choose({ kind: "ci", requestedBy: "i_x" }), "local");
	equal(counter.n, 0);
});

Deno.test("transport port: kernel and git runs are always local; healthy everything is k2", async () => {
	const clock = testClock();
	const counter = { n: 0 };
	const port = createTransportPort({
		maximum: "k2",
		env: env({}, counter, clock),
		relay: () => "ok",
		clock,
	});
	equal(await port.choose({ kind: "ci", requestedBy: "kernel" }), "local");
	equal(await port.choose({ kind: "git", requestedBy: "i_x" }), "local");
	equal(counter.n, 0);
	equal(await port.choose({ kind: "ci", requestedBy: "i_x" }), "k2");
	equal(await port.choose({ kind: "ci", requestedBy: "i_y" }), "k2");
	equal(counter.n, 1);
});

Deno.test("transport port: an unhealthy BusDO or a relay not ok → local", async () => {
	const clock = testClock();
	const counter = { n: 0 };
	const stale = createTransportPort({
		maximum: "k2",
		env: env(
			{
				BUS: bus(() => Promise.resolve(status({ lastPollOkAt: 0 })), counter),
			},
			counter,
			clock,
		),
		relay: () => "ok",
		clock,
	});
	equal(await stale.choose({ kind: "ci", requestedBy: "i_x" }), "local");
	let relay: "ok" | "backoff" = "backoff";
	const backingOff = createTransportPort({
		maximum: "k2",
		env: env({}, { n: 0 }, clock),
		relay: () => relay,
		clock,
	});
	equal(await backingOff.choose({ kind: "ci", requestedBy: "i_x" }), "local");
	relay = "ok";
	equal(await backingOff.choose({ kind: "ci", requestedBy: "i_x" }), "k2");
	const noBus = createTransportPort({
		maximum: "k2",
		env: env({ BUS: undefined }, { n: 0 }, clock),
		relay: () => "ok",
		clock,
	});
	equal(await noBus.choose({ kind: "ci", requestedBy: "i_x" }), "local");
});
