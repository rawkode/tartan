/// <reference types="@cloudflare/vitest-pool-workers/types" />
// WP26 in workerd (project `bus`): the thin
// BusDO class and the `bus` modules registered in RepoDO and ForgeDO, over
// RPC; and the consumer module over real DO SQLite and timers polling
// FakeK2's data plane. The pool has no K2 binding and no token, so the real
// classes run `off` (relay) and `consume: off` (consumer), as on the
// Deploy-button path.

import { runInDurableObject } from "cloudflare:test";
import { type Envelope, repoDoName, ulid } from "@tartan/contract";
import { COMMON_DDL } from "@tartan/contract/kernel.ts";
import { createFakeK2 } from "@tartan/testkit/k2/fake.ts";
import { afterAll, describe, expect, it } from "vitest";
import {
	settleBackground,
	testEnv as env,
	uniqueName,
} from "../../../test/env.ts";
import { createDoHost } from "../../do/host.ts";
import { createK2Client } from "./client.ts";
import { toLogRecord } from "./codec.ts";
import { busDoName } from "./config.ts";
import { createBusConsumerModule } from "./consumer.ts";
import type { BusFacade, BusRelayFacade } from "./contract.ts";
import { createWorkloadsHandler } from "./workloads.ts";

type BusEnv = {
	BUS: { getByName(name: string): { bus(): BusFacade } };
	REPO: { getByName(name: string): { bus(): BusRelayFacade } };
	FORGE: { getByName(name: string): { bus(): BusRelayFacade } };
};
const benv = env as unknown as BusEnv;

// The RepoDO's event pokes and the ForgeDO's first boot run in the
// background of these tests.
afterAll(() => settleBackground());

describe("BusDO and the relay modules over RPC (the button path: no binding, no token)", () => {
	it("BusDO answers status over RPC and stays idle with consume off", async () => {
		const bus = benv.BUS.getByName(busDoName("workloads", 0)).bus();
		const status = await bus.status();
		expect(status).toMatchObject({
			group: "workloads",
			worker: 0,
			consume: "off",
			subscription: null,
			dead: 0,
			retry: 0,
		});
		await bus.nudge();
		expect((await bus.deadList({})).dead).toEqual([]);
		expect(await bus.deadRetry("nope")).toBe(false);
		expect((await bus.wake()).consume).toBe("off");
	});

	it("the RepoDO log accepts the queued run.started with its transport and run.dispatched", async () => {
		const repo = ulid();
		const events = env.REPO.getByName(repoDoName(repo)).events();
		const base = {
			source: { kind: "kernel" as const },
			actor: { kind: "system" as const, id: "sys_kernel" },
			node: repo,
			repo,
			depth: 0,
			shadow: false,
		};
		const runId = ulid();
		await events.append({
			...base,
			type: "run.started",
			data: {
				runId,
				state: "queued",
				kind: "ci",
				transport: "k2",
				priority: "land",
			},
			idemKey: `runs:${runId}:run.started:0`,
		});
		await events.append({
			...base,
			type: "run.dispatched",
			data: { runId, state: "queued", via: "k2", lagMs: 812 },
			idemKey: `runs:${runId}:run.dispatched:0`,
		});
		const read = (await events.read({ since: 0 })) as unknown as Envelope[];
		expect(read.map((e) => e.type)).toEqual(["run.started", "run.dispatched"]);
		expect(read[1].data).toMatchObject({ via: "k2", lagMs: 812 });
	});

	it("RepoDO and ForgeDO register the relay: off without EVENT_LOG", async () => {
		const repo = benv.REPO.getByName(repoDoName(ulid())).bus();
		expect(await repo.status()).toMatchObject({ state: "off", lag: 0 });
		const forge = benv.FORGE.getByName(uniqueName("forge")).bus();
		expect(await forge.status()).toMatchObject({
			state: "off",
			stream: "forge",
		});
	});
});

describe("the consumer module in a Durable Object, against FakeK2", () => {
	it("subscribes, consumes, dispatches, acks; one batch per alarm", async () => {
		// A BusDO name the real class never polls (worker 7 of workloads).
		const stub = (env as unknown as { BUS: DurableObjectNamespace }).BUS
			.getByName(busDoName("workloads", 7));
		await runInDurableObject(stub, async (_instance, state) => {
			const k2 = createFakeK2();
			const dispatched: string[] = [];
			const host = createDoHost({
				kind: "bus-test",
				ctx: state,
				env,
				modules: {
					bus: createBusConsumerModule({
						ports: ({ countViaSync }) => ({
							client: createK2Client({
								endpoint: k2.endpoint,
								token: () => Promise.resolve(k2.token),
								fetch: k2.fetch,
							}),
							handlers: {
								workloads: createWorkloadsHandler({
									dispatch: (_repo, runId) => {
										dispatched.push(runId);
										return Promise.resolve("dispatched");
									},
									countViaSync,
								}),
							},
							leaderSubscription: () => Promise.resolve("workloads-test"),
							log: () => {},
						}),
					}),
				},
				common: [{
					n: 1,
					name: "base",
					sql: `${COMMON_DDL.meta};\n${COMMON_DDL.timers}`,
				}],
			});
			await host.ready;
			const bus = host.facade("bus");
			const due = () =>
				state.storage.sql.exec(
					"UPDATE _timers SET at = 1 WHERE module = 'bus' AND key = 'poll'",
				);
			await bus.nudge();
			due();
			await host.alarm();
			expect(k2.subscriptions()[0]?.name).toBe("workloads-test");
			const repo = ulid();
			const runId = ulid();
			const envelope = {
				id: ulid(),
				seq: 1,
				stream: `repo:${repo}` as const,
				type: "run.started",
				v: 1,
				source: { kind: "kernel" as const },
				actor: { kind: "system" as const, id: "sys_kernel" },
				node: repo,
				repo,
				depth: 0,
				shadow: false,
				at: Date.now(),
				data: { runId, state: "queued", transport: "k2" },
			};
			const record = toLogRecord({
				seq: 1,
				idemKey: "k",
				prevHash: null,
				hash: null,
				repo,
				envelope,
			}, { stage: "test", stream: `repo:${repo}`, epoch: ulid() });
			await k2.producer.send([{
				content: record.content,
				headers: record.headers,
			}]);
			await bus.nudge();
			due();
			await host.alarm();
			expect(dispatched).toEqual([runId]);
			expect(k2.calls.ack).toBe(1);
			const status = await bus.status();
			expect(status).toMatchObject({ consume: "ok", records: 1, dead: 0 });
		});
	});
});
