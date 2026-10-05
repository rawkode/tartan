/// <reference types="@cloudflare/vitest-pool-workers/types" />
// WP26 in workerd (project `events`): the global log relay beside the real
// RepoDO event log over DO SQLite and the WP0 timers, producing to FakeK2's
// binding (the pool's miniflare has no K2 plugin, so the producer is
// injected).

import { runInDurableObject } from "cloudflare:test";
import { type AppendInput, ulid } from "@tartan/contract";
import { COMMON_DDL, type RepoEventsFacade } from "@tartan/contract/kernel.ts";
import type { TimerOutcome } from "../../do/timers.ts";
import type { BusRelayFacade } from "../bus/contract.ts";
import { createFakeK2 } from "@tartan/testkit/k2/fake.ts";
import { describe, expect, it } from "vitest";
import { testEnv as env, uniqueName } from "../../../test/env.ts";
import { createDoHost } from "../../do/host.ts";
import { HEADERS } from "../bus/codec.ts";
import { createRepoBusModule } from "../bus/relay.ts";
import { createRepoEventsModule } from "./repo.ts";

const presence = (repo: string, n: number): AppendInput => ({
	type: "presence.changed",
	source: { kind: "kernel" },
	actor: { kind: "system", id: "sys_kernel" },
	node: repo,
	repo,
	depth: 0,
	shadow: false,
	data: { principal: "u_01k6aaaaaaaaaaaaaaaaaaaaac", status: `s${n}` },
	idemKey: `relay-test:${n}`,
});

const withRelay = (
	body: (h: {
		host: {
			facade(name: "events"): RepoEventsFacade;
			facade(name: "bus"): BusRelayFacade;
			alarm(): Promise<TimerOutcome[]>;
		};
		state: DurableObjectState;
		k2: ReturnType<typeof createFakeK2>;
		repo: string;
	}) => Promise<void>,
) => {
	const repo = ulid();
	return runInDurableObject(
		env.REPO.getByName(uniqueName("relay-host")),
		async (_instance, state) => {
			const k2 = createFakeK2();
			const host = createDoHost({
				kind: "test",
				ctx: state,
				env: {
					...env,
					TARTAN_STAGE: "test",
					TARTAN_K2_STREAM: k2.streamId,
				} as typeof env,
				modules: {
					core: {
						name: "core",
						range: [100, 199] as const,
						migrations: [],
						create: () => ({
							facade: {},
							internal: { applyLaneEventSync: () => {} },
						}),
					},
					events: createRepoEventsModule({
						poke: () => () => Promise.resolve(),
						subscribers: () => ({
							extVersion: () => Promise.resolve(0),
							load: () => Promise.resolve({ rows: [], extVersion: 0 }),
						}),
					}),
					bus: createRepoBusModule({
						producer: () => k2.producer,
						nudge: () => () => Promise.resolve(),
					}),
				},
				common: [{
					n: 1,
					name: "base",
					sql: `${COMMON_DDL.meta};\n${COMMON_DDL.timers}`,
				}],
			});
			await host.ready;
			await body({
				host: {
					facade: ((name: "events" | "bus") => host.facade(name)) as {
						(name: "events"): RepoEventsFacade;
						(name: "bus"): BusRelayFacade;
					},
					alarm: () => host.alarm(),
				},
				state,
				k2,
				repo,
			});
		},
	);
};

const relayTimer = (state: DurableObjectState): number | null =>
	state.storage.sql.exec<{ at: number }>(
		"SELECT at FROM _timers WHERE module = 'bus' AND key = 'relay'",
	).toArray()[0]?.at ?? null;

describe("the global log relay in a Durable Object (WP26)", () => {
	it("an append arms bus/relay within 1 s and the coalescer flush relays it in seq order", async () => {
		await withRelay(async ({ host, state, k2, repo }) => {
			const before = Date.now();
			for (let i = 1; i <= 3; i++) {
				await host.facade("events").append(presence(repo, i));
			}
			const at = relayTimer(state)!;
			expect(at).toBeGreaterThanOrEqual(before);
			expect(at - Date.now()).toBeLessThanOrEqual(1_000);
			// The flush (25 ms) is the fast path.
			await new Promise((r) => setTimeout(r, 200));
			expect(k2.records().map((r) => r.headers[HEADERS.seq])).toEqual([
				"1",
				"2",
				"3",
			]);
			expect(k2.records()[0].headers[HEADERS.stream]).toBe(`repo:${repo}`);
			const status = await host.facade("bus").status();
			expect(status).toMatchObject({ state: "ok", relayedSeq: 3, lag: 0 });
		});
	});

	it("with the flush lost (an eviction), the durable timer relays the backlog from alarm()", async () => {
		await withRelay(async ({ host, state, k2, repo }) => {
			k2.sendFault({ kind: "error", code: 10213 });
			await host.facade("events").append(presence(repo, 1));
			await new Promise((r) => setTimeout(r, 200));
			expect(k2.records()).toHaveLength(0);
			expect((await host.facade("bus").status()).state).toBe("backoff");
			state.storage.sql.exec(
				"UPDATE k2_relay SET next_at = 1 WHERE id = 1",
			);
			state.storage.sql.exec(
				"UPDATE _timers SET at = 1 WHERE module = 'bus' AND key = 'relay'",
			);
			const outcomes = await host.alarm();
			expect(outcomes).toContainEqual(
				expect.objectContaining({ module: "bus", key: "relay", ok: true }),
			);
			expect(k2.records()).toHaveLength(1);
			const status = await host.facade("bus").status();
			expect(status).toMatchObject({
				state: "ok",
				relayedSeq: 1,
				unknownOutcomes: 1,
			});
		});
	});

	it("the prune guard keeps unrelayed rows (relay blocked)", async () => {
		await withRelay(async ({ host, k2, repo }) => {
			k2.sendFault({ kind: "error", code: 10400 });
			await host.facade("events").append(presence(repo, 1));
			await host.facade("events").append(presence(repo, 2));
			await new Promise((r) => setTimeout(r, 200));
			expect((await host.facade("bus").status()).state).toBe("blocked");
			const later = Date.now() + 40 * 24 * 60 * 60 * 1000;
			expect((await host.facade("events").prune(later)).deleted).toBe(0);
		});
	});
});
