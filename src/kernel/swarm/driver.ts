// What the SwarmWorkflow does (WP20), over injected
// steps and deps so Deno tests drive it without workerd. Two instance kinds:
//
// - `plan` (`swarm-<ulid>`): plans the swarm, provisions the sim repos
//   (`setup.ts`), starts one cohort instance per shard
//   (`swarm-<ulid>-c<nn>-g0`), and records the plan in R2. It never drives
//   agents itself.
// - `cohort`: runs rounds (one step each, `cohort.ts`) until the swarm ends,
//   is stopped, or every agent is done. Each round mints the cohort's agent
//   tokens for that round only (bulk mint, 15-minute TTL; the tokens live in
//   the step's memory and are never a step output, a param or a log line),
//   drives the agents through the Worker's own router, waits for the
//   requests' background work, and writes the cohort's counters. At
//   80% of the estimated subrequest budget the cohort hands its agents'
//   JSON state to a successor instance (`…-g<n+1>`) and ends.

import { type SwarmRequest, SwarmRequestSchema } from "@tartan/contract";
import {
	addStats,
	emptyStats,
	type SimAgentState,
	type SimStats,
} from "./agent.ts";
import {
	estimateSubrequests,
	runRound,
	type WrongLaneProbe,
} from "./cohort.ts";
import {
	cohortInstanceId,
	planSwarm,
	SWARM_ID_RE,
	SWARM_LIMITS,
	swarmInstanceId,
	type SwarmPlan,
} from "./plan.ts";
import { prepareSwarm, type SetupDeps, type ShardReady } from "./setup.ts";
import type { CohortFile, SwarmStore } from "./store.ts";
import { createInProcessPort, type Handle } from "./transport.ts";

export type SwarmPlanParams = {
	readonly kind: "plan";
	readonly swarmId: string;
	readonly request: SwarmRequest;
	/** The agent cap the caller allowed (default 300). */
	readonly cap: number;
	/** The admin who started it (bulk mint owner, installs, repo creates). */
	readonly by: string;
	/** The forge's canonical origin, for in-process requests. */
	readonly origin: string;
	readonly now: number;
};

export type CohortConfig = {
	readonly itemsPerAgent: number;
	readonly pushesPerItem: number;
	readonly overlap: number;
	readonly hotFiles: number;
	readonly paceMs: number;
	readonly roundMs: number;
	readonly endsAt: number;
	readonly budget: number;
};

export type SwarmCohortParams = {
	readonly kind: "cohort";
	readonly swarmId: string;
	readonly cohort: number;
	readonly generation: number;
	readonly by: string;
	readonly origin: string;
	readonly repo: { readonly path: string; readonly id: string };
	readonly prefix: string;
	readonly agents: readonly SimAgentState[];
	readonly config: CohortConfig;
	readonly probed: boolean;
	/** Counters carried over from earlier generations. */
	readonly totals: SimStats;
};

export type SwarmWorkflowParams = SwarmPlanParams | SwarmCohortParams;

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isCount = (value: unknown, max = Number.MAX_SAFE_INTEGER): boolean =>
	typeof value === "number" && Number.isInteger(value) && value >= 0 &&
	value <= max;

const isHttpsOrigin = (value: unknown): boolean => {
	if (typeof value !== "string") return false;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && url.origin === value;
	} catch {
		return false;
	}
};

/**
 * Why an instance's params cannot run (null: they can). The instance id must
 * be the one the params name (deterministic ids), so a stray instance
 * never drives another swarm's agents.
 */
export const paramsProblem = (
	params: unknown,
	instanceId: string,
): string | null => {
	if (!isObject(params)) return "params are not an object";
	const { kind, swarmId } = params;
	if (typeof swarmId !== "string" || !SWARM_ID_RE.test(swarmId)) {
		return "swarmId is not a swarm id";
	}
	if (typeof params["by"] !== "string" || params["by"] === "") {
		return "by is required";
	}
	if (!isHttpsOrigin(params["origin"])) return "origin is not an https origin";
	if (kind === "plan") {
		if (instanceId !== swarmInstanceId(swarmId)) {
			return "the instance id does not match the swarm";
		}
		if (!isCount(params["cap"], SWARM_LIMITS.maxAgents)) {
			return "cap is out of range";
		}
		const request = SwarmRequestSchema.safeParse(params["request"]);
		return request.success ? null : "request is not a swarm request";
	}
	if (kind === "cohort") {
		const { cohort, generation, repo, config, agents } = params;
		if (!isCount(cohort, 99) || !isCount(generation)) {
			return "cohort and generation are counts";
		}
		if (
			instanceId !==
				cohortInstanceId(swarmId, cohort as number, generation as number)
		) {
			return "the instance id does not match the cohort";
		}
		if (
			!isObject(repo) || typeof repo["path"] !== "string" ||
			typeof repo["id"] !== "string"
		) return "repo is required";
		if (!isObject(config) || !isCount(config["endsAt"])) {
			return "config is required";
		}
		return Array.isArray(agents) ? null : "agents are required";
	}
	return "kind is plan or cohort";
};

/** The subset of `WorkflowStep` the driver uses. */
export type Step = {
	do<T>(name: string, fn: () => Promise<T>): Promise<T>;
};

export type DriverDeps = {
	readonly store: SwarmStore;
	readonly setup: () => SetupDeps;
	createInstance(id: string, params: SwarmWorkflowParams): Promise<void>;
	/** Bulk-minted agent tokens (`<prefix>-1…n`), in handle order. */
	mintAgents(input: {
		readonly prefix: string;
		readonly count: number;
		readonly nodeId: string;
		readonly ttlMs: number;
	}): Promise<readonly { principal: string; token: string }[]>;
	/** A fresh in-process router context per round: requests, then their background work. */
	router(): { readonly handle: Handle; readonly settle: () => Promise<number> };
	readonly now: () => number;
	readonly sleep: (ms: number) => Promise<void>;
};

const messageOf = (error: unknown): string =>
	(error instanceof Error ? error.message : String(error)).slice(0, 300);

/** The plan instance. */
export const runPlan = async (
	params: SwarmPlanParams,
	step: Step,
	deps: DriverDeps,
): Promise<{ readonly cohorts: number; readonly agents: number }> => {
	const plan: SwarmPlan = planSwarm({
		swarmId: params.swarmId,
		request: params.request,
		now: params.now,
		cap: params.cap,
	});
	await step.do("record plan", () =>
		deps.store.writePlan({
			id: params.swarmId,
			state: "planning",
			plan,
			by: params.by,
			updatedAt: deps.now(),
		}).then(() => true));
	let shards: readonly ShardReady[];
	try {
		shards = await step.do(
			"prepare sim repos",
			() => prepareSwarm(deps.setup(), plan),
		);
	} catch (error) {
		await step.do("record failure", () =>
			deps.store.writePlan({
				id: params.swarmId,
				state: "error",
				plan,
				by: params.by,
				error: messageOf(error),
				updatedAt: deps.now(),
			}).then(() => true));
		throw error;
	}
	await step.do("start cohorts", async () => {
		for (const cohort of plan.cohorts) {
			const shard = shards[cohort.shard]!;
			await deps.createInstance(
				cohortInstanceId(params.swarmId, cohort.index, 0),
				{
					kind: "cohort",
					swarmId: params.swarmId,
					cohort: cohort.index,
					generation: 0,
					by: params.by,
					origin: params.origin,
					repo: { path: shard.path, id: shard.repoId },
					prefix: cohort.prefix,
					agents: cohort.agents.map((handle) => ({
						handle,
						items: 0,
						phase: "idle" as const,
						pushes: 0,
						ticks: 0,
					})),
					config: {
						itemsPerAgent: plan.itemsPerAgent,
						pushesPerItem: plan.pushesPerItem,
						overlap: plan.overlap,
						hotFiles: plan.hotFiles,
						paceMs: plan.paceMs,
						roundMs: SWARM_LIMITS.roundMs,
						endsAt: plan.endsAt,
						budget: SWARM_LIMITS.subrequestBudget,
					},
					probed: false,
					totals: emptyStats(),
				},
			);
		}
		return true;
	});
	await step.do("record running", () =>
		deps.store.writePlan({
			id: params.swarmId,
			state: "running",
			plan,
			shards,
			by: params.by,
			updatedAt: deps.now(),
		}).then(() => true));
	return { cohorts: plan.cohorts.length, agents: plan.agents };
};

type RoundOutput = {
	readonly ended: "time" | "stopped" | null;
	readonly agents: readonly SimAgentState[];
	readonly stats: SimStats;
	readonly subrequests: number;
	readonly probe?: WrongLaneProbe;
};

/** Mint cost: one bulk RPC plus the identity writes behind it. */
const MINT_SUBREQUESTS = 4;

export type CohortOutcome = {
	readonly state: CohortFile["state"];
	readonly rounds: number;
	readonly totals: SimStats;
	readonly successor?: string;
};

/** A cohort instance (one generation). */
export const runCohort = async (
	params: SwarmCohortParams,
	step: Step,
	deps: DriverDeps,
): Promise<CohortOutcome> => {
	const cfg = params.config;
	let agents = params.agents;
	let totals = params.totals;
	let subrequests = 0;
	let probe: WrongLaneProbe | undefined = undefined;
	let probed = params.probed;
	const write = (
		state: CohortFile["state"],
		round: number,
		error?: string,
	) =>
		deps.store.writeCohort(params.swarmId, {
			cohort: params.cohort,
			generation: params.generation,
			state,
			round,
			stats: totals,
			subrequests,
			...(probe ? { probe } : {}),
			agentsDone: agents.filter((a) => a.phase === "done").length,
			...(error ? { error } : {}),
			updatedAt: deps.now(),
		});
	for (let round = 0;; round++) {
		let out: RoundOutput;
		try {
			out = await step.do(`round ${round}`, async () => {
				if (deps.now() >= cfg.endsAt) {
					return { ended: "time", agents, stats: emptyStats(), subrequests: 0 };
				}
				if (await deps.store.stopped(params.swarmId)) {
					return {
						ended: "stopped",
						agents,
						stats: emptyStats(),
						subrequests: 0,
					};
				}
				const minted = await deps.mintAgents({
					prefix: params.prefix,
					count: agents.length,
					nodeId: params.repo.id,
					ttlMs: SWARM_LIMITS.tokenTtlMs,
				});
				const tokens = new Map(
					agents.map((a, i) => [a.handle, minted[i]?.token ?? ""]),
				);
				const router = deps.router();
				const result = await runRound({
					cfg: {
						swarmId: params.swarmId,
						repo: params.repo.path,
						itemsPerAgent: cfg.itemsPerAgent,
						pushesPerItem: cfg.pushesPerItem,
						overlap: cfg.overlap,
						hotFiles: cfg.hotFiles,
						now: deps.now,
					},
					agents,
					portOf: (handle) =>
						createInProcessPort({
							handle: router.handle,
							origin: params.origin,
							token: tokens.get(handle) ?? "",
							repo: params.repo.path,
						}),
					round,
					roundMs: Math.min(cfg.roundMs, Math.max(0, cfg.endsAt - deps.now())),
					paceMs: cfg.paceMs,
					now: deps.now,
					sleep: deps.sleep,
					probe: !probed,
				});
				// Phase 2 of push recording and event pokes finish inside the step.
				await router.settle();
				return {
					ended: null,
					agents: result.agents,
					stats: result.stats,
					subrequests: estimateSubrequests(result.stats) + MINT_SUBREQUESTS,
					...(result.probe ? { probe: result.probe } : {}),
				};
			});
		} catch (error) {
			// The step gave up after its retries: say so in the status, then fail.
			await step.do(
				`record error ${round}`,
				() => write("error", round, messageOf(error)).then(() => true),
			);
			throw error;
		}
		agents = out.agents;
		totals = addStats(totals, out.stats);
		subrequests += out.subrequests;
		if (out.probe) {
			probe = out.probe;
			probed = true;
		}
		if (out.ended !== null) {
			const state = out.ended === "stopped" ? "stopped" : "done";
			await step.do(
				`record ${state}`,
				() => write(state, round).then(() => true),
			);
			return { state, rounds: round, totals };
		}
		if (agents.every((a) => a.phase === "done")) {
			await step.do("record done", () => write("done", round).then(() => true));
			return { state: "done", rounds: round + 1, totals };
		}
		await step.do(
			`record round ${round}`,
			() => write("running", round).then(() => true),
		);
		if (subrequests >= cfg.budget * SWARM_LIMITS.handoverAt) {
			const successor = cohortInstanceId(
				params.swarmId,
				params.cohort,
				params.generation + 1,
			);
			await step.do("hand over", async () => {
				await deps.createInstance(successor, {
					...params,
					generation: params.generation + 1,
					agents,
					totals,
					probed,
				});
				return true;
			});
			return { state: "running", rounds: round + 1, totals, successor };
		}
	}
};
