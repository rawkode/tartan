// Test harness for the RepoDO runs module (Deno only): the module over
// node:sqlite with a fake event log and recorded side effects.

import {
	COMMON_DDL,
	type ModuleDeps,
	type RepoInternals,
} from "@tartan/contract/kernel.ts";
import {
	type JobGraph,
	type JobGraphInput,
	JobGraphSchema,
} from "@tartan/contract";
import type { Env } from "../../../env.ts";
import type { RunTransport } from "../../bus/contract.ts";
import type { TransportPort } from "../../bus/transport.ts";
import {
	createRepoRunsModule,
	RUNS_MIGRATIONS,
	type RunsEffects,
} from "../module.ts";
import {
	fakeClock,
	fakeDoState,
	fakeEvents,
	fakeIds,
	fakeTimers,
} from "./fakes.ts";

export const REPO = "01k6aaaaaaaaaaaaaaaaaaaaaa";
export const SHA = "a".repeat(40);

export const ciGraph = (
	overrides: Partial<JobGraphInput> = {},
): JobGraph =>
	JobGraphSchema.parse({
		repo: { id: REPO },
		kind: "ci",
		subject: { kind: "change", id: "c1" },
		source: { repoId: REPO },
		sha: SHA,
		jobs: [
			{ id: "install", run: "pnpm install" },
			{ id: "lint", needs: ["install"], run: "pnpm lint", optional: true },
			{ id: "test", needs: ["install"], run: "pnpm test" },
		],
		...overrides,
	});

export type RunsHarnessOptions = {
	/** The transport every new run gets (default `local`), or a port. */
	readonly transport?: RunTransport | TransportPort;
	/** A run's `RUNS.create` takes this long (ms). */
	readonly createDelayMs?: number;
};

export const runsHarness = (
	effectsOverride: Partial<RunsEffects> = {},
	options: RunsHarnessOptions = {},
) => {
	const state = fakeDoState();
	state.sql.exec(COMMON_DDL.meta);
	for (const m of RUNS_MIGRATIONS) state.sql.exec(m.sql);
	const events = fakeEvents();
	const clock = fakeClock();
	const calls = {
		created: [] as { instanceId: string; params: unknown }[],
		stopped: [] as string[],
		woken: [] as { instanceId: string; type: string; state: string }[],
	};
	let failCreates = 0;
	const logs = new Map<string, string>();
	const effects: RunsEffects = {
		createInstance: async (instanceId, params) => {
			if (options.createDelayMs) {
				await new Promise((r) => setTimeout(r, options.createDelayMs));
			}
			if (failCreates > 0) {
				failCreates -= 1;
				throw new Error("workflows unavailable");
			}
			const exists = calls.created.some((c) => c.instanceId === instanceId);
			calls.created.push({ instanceId, params });
			return exists ? "exists" : "created";
		},
		stopSandbox: (runId) => {
			calls.stopped.push(runId);
			return Promise.resolve();
		},
		wake: (instanceId, type, payload) => {
			calls.woken.push({ instanceId, type, state: payload.state });
			return Promise.resolve();
		},
		readLog: (key, tail) =>
			Promise.resolve(logs.has(key) ? logs.get(key)!.slice(-tail) : null),
		...effectsOverride,
	};
	const transport = options.transport ?? "local";
	const port: TransportPort = typeof transport === "string"
		? { choose: () => Promise.resolve(transport) }
		: transport;
	const module = createRepoRunsModule({
		effects: () => effects,
		background: (_deps, work) => {
			state.background.push(work);
		},
		transport: () => port,
	});
	const timers = fakeTimers();
	const deps = {
		sql: state.sql,
		storage: state.storage,
		ctx: state.ctx,
		env: {} as Env,
		modules: { events: events.internal } as unknown as RepoInternals,
		timers: timers.api,
		clock,
		ids: fakeIds(),
	} as ModuleDeps<Env, RepoInternals>;
	const instance = module.create(deps);
	return {
		...state,
		runs: instance.facade,
		internal: instance.internal,
		events,
		clock,
		calls,
		logs,
		/** Pending timers (`outbox` → at). */
		timers: timers.pending,
		/** Runs the outbox timer as the alarm would (the key's row is consumed). */
		fireOutbox: async () => {
			timers.pending.delete("outbox");
			await instance.onTimer?.("outbox");
		},
		failNextCreates: (n: number) => {
			failCreates = n;
		},
	};
};
