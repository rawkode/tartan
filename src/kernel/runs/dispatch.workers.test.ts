/// <reference types="@cloudflare/vitest-pool-workers/types" />
// WP26 in workerd (project `runs`): run transport, `dispatch()` and the
// outbox backstop over real DO SQLite, the WP0 timers and `alarm()`, with
// the Workflow create and the event log as test doubles.

import { runInDurableObject } from "cloudflare:test";
import type { JobGraphInput } from "@tartan/contract";
import { COMMON_DDL } from "@tartan/contract/kernel.ts";
import type { TimerOutcome } from "../../do/timers.ts";
import { describe, expect, it } from "vitest";
import { testEnv as env, uniqueName } from "../../../test/env.ts";
import { createDoHost } from "../../do/host.ts";
import type { RunTransport } from "../bus/contract.ts";
import {
	createRepoRunsModule,
	type RepoRunsFacadeK2,
	type RunsEffects,
} from "./module.ts";

const REPO = "01k6aaaaaaaaaaaaaaaaaaaaaa";
const EXT = "i_01k6aaaaaaaaaaaaaaaaaaaaab";

const graph = (n: number): JobGraphInput => ({
	repo: { id: REPO },
	kind: "ci",
	subject: { kind: "land", id: `b${n}` },
	source: { repoId: REPO },
	sha: "c".repeat(40),
	jobs: [{ id: "test", run: "true" }],
});

const withHost = (
	transport: RunTransport,
	body: (h: {
		runs: RepoRunsFacadeK2;
		host: { alarm(): Promise<TimerOutcome[]> };
		state: DurableObjectState;
		created: string[];
		appended: { type: string; data: unknown }[];
		failCreates: (n: number) => void;
	}) => Promise<void>,
) =>
	runInDurableObject(
		env.REPO.getByName(uniqueName("dispatch-host")),
		async (_instance, state) => {
			const created: string[] = [];
			const appended: { type: string; data: unknown }[] = [];
			let failures = 0;
			const effects: RunsEffects = {
				createInstance: async (id) => {
					await new Promise((r) => setTimeout(r, 5));
					if (failures > 0) {
						failures -= 1;
						throw new Error("workflows unavailable");
					}
					const exists = created.includes(id);
					created.push(id);
					return exists ? "exists" : "created";
				},
				stopSandbox: () => Promise.resolve(),
				wake: () => Promise.resolve(),
				readLog: () => Promise.resolve(null),
			};
			const host = createDoHost({
				kind: "test",
				ctx: state,
				env,
				modules: {
					runs: createRepoRunsModule({
						effects: () => effects,
						transport: () => ({ choose: () => Promise.resolve(transport) }),
					}),
					events: {
						name: "events",
						range: [200, 249] as const,
						migrations: [],
						create: () => ({
							facade: {},
							internal: {
								appendSync: (input: { type: string; data: unknown }) => {
									appended.push({ type: input.type, data: input.data });
									return {
										id: "e",
										seq: appended.length,
										hash: "0",
										created: true,
									};
								},
							},
						}),
					},
				},
				common: [{
					n: 1,
					name: "base",
					sql: `${COMMON_DDL.meta};\n${COMMON_DDL.timers}`,
				}],
			});
			await host.ready;
			await body({
				runs: host.facade("runs"),
				host,
				state,
				created,
				appended,
				failCreates: (n) => {
					failures = n;
				},
			});
		},
	);

const outboxAt = (state: DurableObjectState): number | null =>
	state.storage.sql.exec<{ at: number }>(
		"SELECT at FROM _timers WHERE module = 'runs' AND key = 'outbox'",
	).toArray()[0]?.at ?? null;

const makeDue = (state: DurableObjectState): void => {
	state.storage.sql.exec(
		"UPDATE runs SET dispatch_due_at = 1 WHERE instance_created = 0",
	);
	state.storage.sql.exec(
		"UPDATE _timers SET at = 1 WHERE module = 'runs' AND key = 'outbox'",
	);
};

describe("run dispatch in a Durable Object (WP26)", () => {
	it("no token or no binding means local: dispatched inline, run.dispatched once, via local", async () => {
		await withHost("local", async ({ runs, created, appended, state }) => {
			const { runId } = await runs.start({
				graph: graph(1) as never,
				idemKey: "k1",
				requestedBy: EXT,
			});
			expect(created).toHaveLength(1);
			expect(appended.map((e) => e.type)).toEqual([
				"run.started",
				"run.dispatched",
			]);
			expect(appended[0].data).toMatchObject({
				state: "queued",
				transport: "local",
				priority: "land",
				kind: "ci",
			});
			expect(appended[1].data).toMatchObject({ runId, via: "local" });
			const row = state.storage.sql.exec<{ via: string; transport: string }>(
				"SELECT via, transport FROM runs WHERE id = ?",
				runId,
			).one();
			expect(row).toEqual({ via: "local", transport: "local" });
		});
	});

	it("a failed create in a quiet repo is retried by the outbox timer alone", async () => {
		await withHost(
			"local",
			async ({ runs, host, created, appended, state, failCreates }) => {
				failCreates(1);
				const { runId } = await runs.start({
					graph: graph(2) as never,
					idemKey: "k2",
					requestedBy: EXT,
				});
				expect(created).toHaveLength(0);
				expect(outboxAt(state)).not.toBeNull();
				makeDue(state);
				const outcomes = await host.alarm();
				expect(outcomes).toContainEqual(
					expect.objectContaining({ module: "runs", key: "outbox", ok: true }),
				);
				expect(created).toHaveLength(1);
				expect(appended.filter((e) => e.type === "run.dispatched"))
					.toHaveLength(1);
				expect(await runs.dispatch(runId, { via: "k2" })).toBe("already");
			},
		);
	});

	it("k2: not dispatched inline; the consumer's dispatch creates it once; a late backstop finds nothing", async () => {
		await withHost("k2", async ({ runs, host, created, appended, state }) => {
			const { runId } = await runs.start({
				graph: graph(3) as never,
				idemKey: "k3",
				requestedBy: EXT,
			});
			expect(created).toHaveLength(0);
			const at = outboxAt(state)!;
			expect(at - Date.now()).toBeGreaterThan(15_000);
			expect(at - Date.now()).toBeLessThanOrEqual(20_000);
			const [a, b] = await Promise.all([
				runs.dispatch(runId, { via: "k2" }),
				runs.dispatch(runId, { via: "backstop" }),
			]);
			expect([a, b]).toEqual(["dispatched", "dispatched"]);
			expect(created).toHaveLength(1);
			makeDue(state);
			await host.alarm();
			expect(created).toHaveLength(1);
			expect(
				appended.filter((e) => e.type === "run.dispatched").map((e) =>
					(e.data as { via: string }).via
				),
			).toEqual(["k2"]);
		});
	});

	it("k2 with K2 silent: the backstop dispatches the run after the grace (via backstop)", async () => {
		await withHost("k2", async ({ runs, host, created, appended, state }) => {
			const { runId } = await runs.start({
				graph: graph(4) as never,
				idemKey: "k4",
				requestedBy: EXT,
			});
			makeDue(state);
			await host.alarm();
			expect(created).toHaveLength(1);
			expect(
				(appended.find((e) => e.type === "run.dispatched")!.data as {
					via: string;
				}).via,
			).toBe("backstop");
			const status = await runs.get(runId) as unknown as { via: string };
			expect(status.via).toBe("backstop");
		});
	});
});
