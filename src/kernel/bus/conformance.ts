// The K2 conformance suite (WP26): the same scenarios against
// FakeK2 (always, `conformance.test.ts`) and against a live stream (the
// dev-only route `/-/dev/k2/conformance` on a `dev-*` stage, inside the
// Worker that holds the binding and the Secrets Store token). Each scenario
// uses its own `latest` subscription, tags its records with a run header so
// the stream's other records are ignored, and deletes its subscription. Its
// records carry a unique `ce_id` and `ce_type: tartan.conformance`, so the
// forge's own `workloads` consumer skips them (never parks them).
// Results carry names, verdicts, counts and timings only. Runtime code
// reaches it only through that dev route.

import type { K2Client } from "./client.ts";
import type { K2Producer } from "./k2.ts";

export const CONFORMANCE_TAG_HEADER = "tartan_conformance";
/** `ce_type` of a conformance record: the `workloads` consumer skips it. */
export const CONFORMANCE_TYPE = "tartan.conformance";

let counter = 0;
/** Headers of one conformance record: a unique `ce_id`, never an event type. */
export const conformanceHeaders = (tag: string): Record<string, string> => {
	counter += 1;
	return {
		ce_specversion: "1.0",
		ce_id: `conformance-${tag}-${counter}`,
		ce_type: CONFORMANCE_TYPE,
		[CONFORMANCE_TAG_HEADER]: tag,
	};
};

export type ConformanceTarget = {
	readonly producer: K2Producer;
	readonly client: K2Client;
	/** Subscription and worker names start with this (letters, digits, `-`). */
	readonly prefix: string;
	/** Waits between polls (live: ~500 ms; FakeK2: none). */
	readonly sleep: (ms: number) => Promise<void>;
	/** Polls before a scenario gives up waiting for its records. */
	readonly maxPolls?: number;
	readonly now?: () => number;
};

export type ConformanceResult = {
	readonly name: string;
	readonly ok: boolean;
	readonly detail?: string;
	readonly ms: number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Ctx = {
	readonly t: ConformanceTarget;
	readonly tag: string;
	readonly subscription: string;
	readonly worker: (n: number) => string;
};

const produce = async (ctx: Ctx, values: readonly string[]): Promise<void> => {
	const result = await ctx.t.producer.send(values.map((v) => ({
		content: encoder.encode(v),
		headers: conformanceHeaders(ctx.tag),
	})));
	if (!result.success) throw new Error(`send failed: K2 ${result.error.code}`);
};

/** Consumes until `count` tagged records arrived (acking every batch). */
const collect = async (
	ctx: Ctx,
	count: number,
	worker = ctx.worker(0),
): Promise<string[]> => {
	const got: string[] = [];
	const polls = ctx.t.maxPolls ?? 20;
	for (let i = 0; i < polls && got.length < count; i++) {
		const batch = await ctx.t.client.consume(ctx.subscription, worker, 100);
		if (batch.batchId === null) {
			await ctx.t.sleep(500);
			continue;
		}
		for (const r of batch.records) {
			if (r.headers[CONFORMANCE_TAG_HEADER] === ctx.tag) {
				got.push(decoder.decode(r.content));
			}
		}
		await ctx.t.client.ack(ctx.subscription, batch.batchId, worker);
	}
	return got;
};

const expect = (ok: boolean, detail: string): void => {
	if (!ok) throw new Error(detail);
};

/** Scenario name → body. */
export const CONFORMANCE_SCENARIOS: Readonly<
	Record<string, (ctx: Ctx) => Promise<string | void>>
> = {
	"produce-ack": async (ctx) => {
		const result = await ctx.t.producer.send([{
			content: encoder.encode("p"),
			headers: conformanceHeaders(ctx.tag),
		}]);
		expect(result.success === true, "send answered success: false");
	},
	"latest-sees-only-new": async (ctx) => {
		// A tagged "before" record was produced before the subscription existed.
		await produce(ctx, ["new-1", "new-2"]);
		const got = await collect(ctx, 2);
		expect(
			got.join(",") === "new-1,new-2",
			`got ${got.length} tagged records`,
		);
	},
	"empty-consume": async (ctx) => {
		const batch = await ctx.t.client.consume(
			ctx.subscription,
			ctx.worker(0),
			10,
		);
		expect(
			batch.batchId === null && batch.records.length === 0,
			"a new latest subscription delivered records",
		);
	},
	"order-one-producer": async (ctx) => {
		for (let i = 0; i < 5; i++) {
			await produce(
				ctx,
				Array.from({ length: 10 }, (_, j) => String(i * 10 + j)),
			);
		}
		const got = (await collect(ctx, 50)).map(Number);
		expect(got.length === 50, `got ${got.length} of 50`);
		expect(
			got.every((v, i) => i === 0 || v > got[i - 1]),
			"records out of production order",
		);
		return `${got.length} in order`;
	},
	"same-worker-reconsume": async (ctx) => {
		await produce(ctx, ["r1"]);
		let first = null;
		for (let i = 0; i < (ctx.t.maxPolls ?? 20) && first === null; i++) {
			const batch = await ctx.t.client.consume(
				ctx.subscription,
				ctx.worker(0),
				10,
			);
			if (batch.batchId !== null) first = batch;
			else await ctx.t.sleep(500);
		}
		expect(first !== null, "no batch");
		const again = await ctx.t.client.consume(
			ctx.subscription,
			ctx.worker(0),
			10,
		);
		expect(
			again.batchId === first!.batchId,
			"a new batch while the lease is held",
		);
		await ctx.t.client.ack(ctx.subscription, first!.batchId!, ctx.worker(0));
		// Ack is idempotent.
		await ctx.t.client.ack(ctx.subscription, first!.batchId!, ctx.worker(0));
	},
	"nack-redelivers": async (ctx) => {
		await produce(ctx, ["n1"]);
		let batch = null;
		for (let i = 0; i < (ctx.t.maxPolls ?? 20) && batch === null; i++) {
			const b = await ctx.t.client.consume(ctx.subscription, ctx.worker(0), 10);
			if (b.batchId !== null) batch = b;
			else await ctx.t.sleep(500);
		}
		expect(batch !== null, "no batch");
		await ctx.t.client.nack(ctx.subscription, batch!.batchId!, ctx.worker(0));
		const got = await collect(ctx, 1, ctx.worker(1));
		expect(got.includes("n1"), "the nacked record was not redelivered");
	},
	"extend": async (ctx) => {
		await produce(ctx, ["e1"]);
		let batch = null;
		for (let i = 0; i < (ctx.t.maxPolls ?? 20) && batch === null; i++) {
			const b = await ctx.t.client.consume(ctx.subscription, ctx.worker(0), 10);
			if (b.batchId !== null) batch = b;
			else await ctx.t.sleep(500);
		}
		expect(batch !== null, "no batch");
		const until = await ctx.t.client.extend(
			ctx.subscription,
			batch!.batchId!,
			ctx.worker(0),
		);
		expect(
			until !== null && until >= (batch!.leasedUntilMs ?? 0),
			"extend did not move the lease",
		);
		let lost = false;
		try {
			await ctx.t.client.extend(
				ctx.subscription,
				batch!.batchId!,
				ctx.worker(9),
			);
		} catch {
			lost = true;
		}
		expect(lost, "a non-holder extended the lease");
		await ctx.t.client.ack(ctx.subscription, batch!.batchId!, ctx.worker(0));
	},
};

const random = (): string =>
	Array.from(crypto.getRandomValues(new Uint8Array(6)))
		.map((b) => b.toString(16).padStart(2, "0")).join("");

/** Runs `names` (default: all), each isolated, each cleaning up after itself. */
export const runConformance = async (
	target: ConformanceTarget,
	names: readonly string[] = Object.keys(CONFORMANCE_SCENARIOS),
): Promise<ConformanceResult[]> => {
	const now = target.now ?? (() => Date.now());
	const results: ConformanceResult[] = [];
	for (const name of names) {
		const body = CONFORMANCE_SCENARIOS[name];
		const started = now();
		if (body === undefined) {
			results.push({ name, ok: false, detail: "unknown scenario", ms: 0 });
			continue;
		}
		const id = random();
		const subscriptionName = `${target.prefix}-${name}-${id}`;
		let subscription: string | null = null;
		try {
			// A record from before the subscription: `latest` must never deliver it.
			const before = await target.producer.send([{
				content: encoder.encode("before"),
				headers: conformanceHeaders(`${name}-${id}`),
			}]);
			if (!before.success) {
				throw new Error(`send failed: K2 ${before.error.code}`);
			}
			subscription = await target.client.createSubscription(
				subscriptionName,
				"latest",
			);
			const detail = await body({
				t: target,
				tag: `${name}-${id}`,
				subscription,
				worker: (n) => `${target.prefix}-${id}-${n}`,
			});
			results.push({
				name,
				ok: true,
				...(detail ? { detail } : {}),
				ms: now() - started,
			});
		} catch (error) {
			results.push({
				name,
				ok: false,
				detail: error instanceof Error ? error.message : "error",
				ms: now() - started,
			});
		} finally {
			if (subscription !== null) {
				await target.client.deleteSubscription(subscription).catch(() => {});
			}
		}
	}
	return results;
};
