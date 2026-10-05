/// <reference types="@cloudflare/vitest-pool-workers/types" />
// WP6 in workerd: the RepoDO `events` module over real DO RPC and SQLite (total
// order under concurrent appends, idempotency, depth guard, shadow isolation,
// chain verification, the 1,000 appends/s micro-bench, lane transition
// atomicity) and, on a host with injected ports, coalesced pokes and the
// subscriber refresh.

import { runInDurableObject } from "cloudflare:test";
import {
	type AppendInput,
	createUlid,
	type Envelope,
	fromRpcError,
	repoDoName,
	type StreamRef,
} from "@tartan/contract";
import {
	type DoModule,
	type RepoCoreInternal,
	type RepoEventsFacade,
	type SubscriberRow,
} from "@tartan/contract/kernel.ts";
import { describe, expect, it } from "vitest";
import { testEnv as env } from "../../../test/env.ts";
import { createDoHost } from "../../do/host.ts";
import { COMMON_MIGRATIONS } from "../../do/migrations.ts";
import type { Env } from "../../env.ts";
import { createRepoEventsModule } from "./repo.ts";

const ulid = createUlid();
const USER = `u_${ulid()}`;
const INST = `i_${ulid()}`;
const LANE = `ln_${ulid()}`;
const SHA = "a".repeat(40);
const CHANGE = "k".repeat(32);

let n = 0;
const pushAccepted = (
	repo: string,
	overrides: Partial<AppendInput> = {},
): AppendInput => ({
	type: "push.accepted",
	source: { kind: "kernel" },
	actor: { kind: "user", id: USER },
	node: repo,
	repo,
	depth: 0,
	shadow: false,
	data: {
		pushId: `p${n}`,
		target: "repo",
		ref: "refs/heads/main",
		before: SHA,
		after: "b".repeat(40),
		via: "gateway",
	},
	idemKey: `kernel:r${n++}:push.accepted:0`,
	...overrides,
});

const extEvent = (
	repo: string,
	overrides: Partial<AppendInput> = {},
): AppendInput => ({
	type: "x.acme.radar.ping",
	source: { kind: "installation", id: INST, ext: "acme.radar@1.0.0" },
	actor: { kind: "ext", id: `x_${INST}` },
	node: repo,
	depth: 1,
	shadow: false,
	data: { n },
	idemKey: `${INST}:c${n++}:x.acme.radar.ping:0`,
	...overrides,
});

/** The facade as callers type it (RPC maps `data: unknown` envelopes to never). */
const eventsOf = (repoId: string): RepoEventsFacade =>
	env.REPO.getByName(repoDoName(repoId))
		.events() as unknown as RepoEventsFacade;

const freshRepo = () => {
	const repoId = ulid();
	const stub = env.REPO.getByName(repoDoName(repoId));
	return { repoId, stub: { events: () => eventsOf(repoId) }, raw: stub };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("RepoDO events over RPC", () => {
	it("keeps total order under concurrent appends and the chain verifies", async () => {
		const { repoId, stub } = freshRepo();
		const results = await Promise.all(
			Array.from(
				{ length: 200 },
				() => stub.events().append(pushAccepted(repoId)),
			),
		);
		const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
		expect(seqs).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
		expect(new Set(results.map((r) => r.id)).size).toBe(200);
		expect(await stub.events().head()).toBe(200);
		const events = await stub.events().read({ since: 0, limit: 500 });
		expect(events.map((e) => e.seq)).toEqual(seqs);
		// ULIDs follow seq order (one writer).
		expect([...events.map((e) => e.id)].sort()).toEqual(
			events.map((e) => e.id),
		);
		expect(await stub.events().verifyChain(1, 200)).toEqual({ ok: true });
	});

	it("is idempotent on idemKey, also for concurrent duplicates", async () => {
		const { repoId, stub } = freshRepo();
		const input = pushAccepted(repoId);
		const [a, b, c] = await Promise.all([
			stub.events().append(input),
			stub.events().append(input),
			stub.events().append(input),
		]);
		expect(new Set([a.id, b.id, c.id]).size).toBe(1);
		expect([a, b, c].filter((r) => r.created)).toHaveLength(1);
		expect(await stub.events().head()).toBe(1);
	});

	it("guards depth (K10) and re-checks namespaces and schemas", async () => {
		const { repoId, stub } = freshRepo();
		const codes = async (input: AppendInput) => {
			const error = await stub.events().append(input).catch((e) => e);
			const t = fromRpcError(error);
			return `${t.code}${t.reason ? `:${t.reason}` : ""}`;
		};
		expect(await codes(extEvent(repoId, { depth: 9 }))).toBe("denied:depth");
		expect(
			await codes(
				pushAccepted(repoId, {
					source: { kind: "installation", id: INST, ext: "acme.radar@1.0.0" },
				}),
			),
		).toBe("denied:namespace");
		expect(await codes(pushAccepted(repoId, { data: {} }))).toBe("invalid");
		// Another repo's event cannot enter this log.
		expect(await codes(pushAccepted(ulid()))).toBe("invalid");
		expect(await stub.events().head()).toBe(0);
	});

	it("isolates shadow events from default reads", async () => {
		const { repoId, stub } = freshRepo();
		await stub.events().append(extEvent(repoId, { shadow: true }));
		await stub.events().append(extEvent(repoId));
		expect((await stub.events().read({ since: 0 })).map((e) => e.seq)).toEqual(
			[2],
		);
		expect(
			(await stub.events().read({ since: 0, includeShadow: true })).map((e) =>
				e.shadow
			),
		).toEqual([true, false]);
	});

	it("gets envelopes by id and prunes past retention, keeping the chain verifiable", async () => {
		const { repoId, stub } = freshRepo();
		const a = await stub.events().append(pushAccepted(repoId));
		await stub.events().append(pushAccepted(repoId));
		const got = await stub.events().get([a.id, "missing"]);
		expect(got.map((e) => e.id)).toEqual([a.id]);
		const later = Date.now() + 31 * 24 * 3600 * 1000;
		expect(await stub.events().prune(later)).toEqual({ deleted: 1 });
		expect(await stub.events().head()).toBe(2);
		expect(await stub.events().verifyChain(1, 2)).toEqual({ ok: true });
	});

	it("micro-bench: at least 1,000 appends per second", async () => {
		const { repoId, stub, raw } = freshRepo();
		const count = 1000;
		const inputs = Array.from({ length: count }, () => pushAccepted(repoId));
		const started = performance.now();
		await Promise.all(inputs.map((input) => stub.events().append(input)));
		const rpcMs = performance.now() - started;
		const rpcRate = count / (rpcMs / 1000);
		expect(await stub.events().head()).toBe(count);

		// The same work inside the DO (the kernel path: appendSync in a transaction).
		const inDoMs = await runInDurableObject(raw, (_instance, state) => {
			const host = createDoHost({
				kind: "bench",
				ctx: state,
				env,
				modules: {
					events: createRepoEventsModule({ schedule: () => {} }),
				},
				common: [COMMON_MIGRATIONS.base],
			});
			return host.ready.then(() => {
				const events = host.internal("events");
				const t0 = performance.now();
				for (let i = 0; i < count; i++) {
					state.storage.transactionSync(() =>
						events.appendSync(pushAccepted(repoId))
					);
				}
				return performance.now() - t0;
			});
		});
		const inDoRate = count / (inDoMs / 1000);
		console.log(
			`[bench] ${count} appends: RPC ${rpcMs.toFixed(0)} ms (${
				rpcRate.toFixed(0)
			}/s), in-DO ${inDoMs.toFixed(0)} ms (${inDoRate.toFixed(0)}/s)`,
		);
		expect(rpcRate).toBeGreaterThanOrEqual(1000);
		expect(inDoRate).toBeGreaterThanOrEqual(1000);
		expect(await stub.events().verifyChain(1, 2 * count)).toEqual({ ok: true });
	});
});

// ---------------------------------------------------------------------------
// Pokes, subscribers and lane transitions on a host with injected ports
// ---------------------------------------------------------------------------

type Poke = { host: string; stream: StreamRef; head: number; at: number };

const fakeCore = (
	lane: Envelope[],
	fail = false,
): DoModule<object, Pick<RepoCoreInternal, "applyLaneEventSync">, Env> => ({
	name: "core",
	range: [100, 199],
	migrations: [],
	create: () => ({
		facade: {},
		internal: {
			applyLaneEventSync: (event) => {
				if (fail) throw new Error("lane transition refused");
				lane.push(event);
			},
		},
	}),
});

const subscriber = (
	host: string,
	pattern: string,
	mode = "enforce",
): SubscriberRow => ({
	installation_id: `i_${host}`,
	host_name: host,
	pattern,
	mode,
	ext_version: 1,
});

const withHost = async <T>(
	repoId: string,
	options: {
		rows?: SubscriberRow[];
		failLane?: boolean;
	},
	fn: (ctx: {
		append: (input: AppendInput) => Promise<unknown>;
		pokes: Poke[];
		lane: Envelope[];
		state: DurableObjectState;
		loads: () => number;
	}) => Promise<T>,
): Promise<T> => {
	const { stub } = { stub: env.REPO.getByName(repoDoName(repoId)) };
	return await runInDurableObject(stub, async (_instance, state) => {
		const pokes: Poke[] = [];
		const lane: Envelope[] = [];
		let loads = 0;
		const host = createDoHost({
			kind: "test",
			ctx: state,
			env,
			modules: {
				core: fakeCore(lane, options.failLane),
				events: createRepoEventsModule({
					poke: () => (h, input) => {
						pokes.push({ host: h, ...input, at: Date.now() });
						return Promise.resolve();
					},
					subscribers: () => ({
						extVersion: () => Promise.resolve(1),
						load: () => {
							loads++;
							return Promise.resolve({
								rows: options.rows ?? [],
								extVersion: 1,
							});
						},
					}),
					log: () => {},
				}),
			},
			common: [COMMON_MIGRATIONS.base],
		});
		await host.ready;
		const facade = host.facade("events");
		return await fn({
			append: (input) => facade.append(input),
			pokes,
			lane,
			state,
			loads: () => loads,
		});
	});
};

describe("pokes", () => {
	it("refreshes subscribers from the registry and pokes matching hosts with the head", async () => {
		const repoId = ulid();
		const rows = [
			subscriber("ext:a", "push.*"),
			subscriber("ext:b", "x.acme.radar.*"),
			subscriber("ext:c", "lane.*"),
		];
		await withHost(repoId, { rows }, async ({ append, pokes, loads }) => {
			await append(pushAccepted(repoId));
			await sleep(80);
			// The first run loaded the registry and poked every new subscriber.
			expect(loads()).toBe(1);
			expect(new Set(pokes.map((p) => p.host))).toEqual(
				new Set(["ext:a", "ext:b", "ext:c"]),
			);
			pokes.length = 0;
			await sleep(300);
			await append(extEvent(repoId));
			await sleep(80);
			expect(pokes.map((p) => [p.host, p.stream, p.head])).toEqual([
				["ext:b", `repo:${repoId}`, 2],
			]);
		});
	});

	it("bounds pokes to ≤ 4/s per subscriber under load", async () => {
		const repoId = ulid();
		const rows = [subscriber("ext:hot", "*")];
		await withHost(repoId, { rows }, async ({ append, pokes }) => {
			await append(pushAccepted(repoId));
			await sleep(60);
			pokes.length = 0;
			const started = Date.now();
			let appended = 0;
			while (Date.now() - started < 1500) {
				await Promise.all(
					Array.from({ length: 10 }, () => append(pushAccepted(repoId))),
				);
				appended += 10;
				await sleep(5);
			}
			await sleep(300);
			const elapsed = (Date.now() - started) / 1000;
			const hot = pokes.filter((p) => p.host === "ext:hot");
			console.log(
				`[pokes] ${appended} appends in ${
					elapsed.toFixed(2)
				} s → ${hot.length} pokes`,
			);
			expect(appended).toBeGreaterThan(100);
			// ≤ 4 per second, plus the trailing run.
			expect(hot.length).toBeLessThanOrEqual(Math.ceil(elapsed * 4) + 1);
			// Runs start ≥ 250 ms apart. A poke is stamped after its run's own
			// reads, so two stamps can be closer by that run's latency (230 ms
			// seen under the full suite); without the bound they are ~25 ms.
			for (let i = 1; i < hot.length; i++) {
				expect(hot[i].at - hot[i - 1].at).toBeGreaterThanOrEqual(200);
			}
			// The last poke carries the final head.
			expect(hot.at(-1)?.head).toBe(appended + 1);
		});
	});

	it("routes shadow events only to shadow subscribers", async () => {
		const repoId = ulid();
		const rows = [
			subscriber("ext:live", "x.acme.radar.*", "enforce"),
			subscriber("ext:shadow", "x.acme.radar.*", "shadow"),
			subscriber("ext:off", "x.acme.radar.*", "disabled"),
		];
		await withHost(repoId, { rows }, async ({ append, pokes }) => {
			await append(pushAccepted(repoId));
			await sleep(60);
			pokes.length = 0;
			await sleep(300);
			await append(extEvent(repoId, { shadow: true }));
			await sleep(60);
			expect(pokes.map((p) => p.host)).toEqual(["ext:shadow"]);
			pokes.length = 0;
			await sleep(300);
			await append(extEvent(repoId));
			await sleep(60);
			expect(pokes.map((p) => p.host).sort()).toEqual([
				"ext:live",
				"ext:shadow",
			]);
		});
	});
});

describe("lane events", () => {
	const submitted = (repoId: string, shadow = false): AppendInput =>
		extEvent(repoId, {
			type: "changes.submitted",
			source: { kind: "installation", id: INST, ext: "tartan.changes@0.1.0" },
			shadow,
			data: {
				changeId: CHANGE,
				laneId: LANE,
				revision: 1,
				head: SHA,
				base: SHA,
				affected: [],
			},
		});

	it("calls core.applyLaneEventSync for non-shadow lane events", async () => {
		const repoId = ulid();
		await withHost(repoId, {}, async ({ append, lane }) => {
			await append(submitted(repoId, true));
			expect(lane).toHaveLength(0);
			await append(submitted(repoId));
			expect(lane.map((e) => e.type)).toEqual(["changes.submitted"]);
		});
	});

	it("rolls the append back when the lane transition throws", async () => {
		const repoId = ulid();
		await withHost(repoId, { failLane: true }, async ({ append, state }) => {
			await expect(append(submitted(repoId))).rejects.toThrow(/refused/);
			const count = state.storage.sql.exec<{ n: number }>(
				"SELECT COUNT(*) AS n FROM events",
			).one().n;
			expect(count).toBe(0);
		});
	});
});
