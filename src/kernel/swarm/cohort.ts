// One round of a cohort (WP20): every agent of the
// cohort acts concurrently for `roundMs` of wall time, one action every
// `paceMs` (with a per-agent, per-round jitter so 50 agents do not fire at
// once). A round is one Workflow step; its result (the agents' JSON state
// and the round's counters, never a token) is the step's output.
//
// Once per cohort, when two agents hold lanes, one agent pushes to the
// other's lane ref: the gateway must refuse it.

import {
	addStats,
	type AgentRuntime,
	createRuntime,
	emptyStats,
	probeWrongLane,
	type SimAgentState,
	type SimConfig,
	type SimLane,
	type SimPort,
	type SimStats,
	tick,
	type WrongLaneProbe,
} from "./agent.ts";
import { rngFor } from "./rng.ts";

/**
 * Subrequests one in-process request costs, estimated: the security
 * middleware's token lookup, the MCP host's registry and ExtensionDO calls
 * or the gateway's RepoDO, Artifacts token and upstream calls, and the
 * event pokes. A cohort hands over at 80% of its budget by this estimate.
 */
export const SUBREQUESTS_PER_REQUEST = 8;

export type { WrongLaneProbe } from "./agent.ts";

export type RoundInput = {
	readonly cfg: SimConfig;
	readonly agents: readonly SimAgentState[];
	/** The agent's port for this round (its token is minted for the round). */
	readonly portOf: (handle: string) => SimPort;
	readonly round: number;
	readonly roundMs: number;
	readonly paceMs: number;
	readonly now: () => number;
	readonly sleep: (ms: number) => Promise<void>;
	/** Run the wrong-lane probe this round (once per cohort). */
	readonly probe: boolean;
	/** Stops a round early (e.g. the swarm was stopped); checked between actions. */
	readonly stopped?: () => boolean;
};

export type RoundResult = {
	readonly agents: readonly SimAgentState[];
	readonly stats: SimStats;
	readonly probe?: WrongLaneProbe;
};

export const estimateSubrequests = (stats: Pick<SimStats, "requests">) =>
	stats.requests * SUBREQUESTS_PER_REQUEST;

const runAgent = async (
	rt: AgentRuntime,
	input: RoundInput,
	start: SimAgentState,
	end: number,
): Promise<{
	state: SimAgentState;
	stats: SimStats;
	/** The last lane the agent held during the round, with its head then. */
	lane?: { lane: SimLane; head?: string };
}> => {
	const stats = emptyStats();
	const rng = rngFor(rt.cfg.swarmId, start.handle, "pace", input.round);
	let state = start;
	let lane: { lane: SimLane; head?: string } | undefined = start.lane
		? { lane: start.lane, ...(start.head ? { head: start.head } : {}) }
		: undefined;
	// Spread the first actions over one pace interval.
	await input.sleep(Math.floor(rng.next() * input.paceMs));
	while (
		input.now() < end && state.phase !== "done" && !(input.stopped?.() ?? false)
	) {
		state = await tick(rt, state, stats);
		if (state.lane) {
			lane = {
				lane: state.lane,
				...(state.head ? { head: state.head } : {}),
			};
		}
		const jitter = 0.5 + rng.next();
		const wait = Math.floor(input.paceMs * jitter);
		if (input.now() + wait >= end) break;
		await input.sleep(wait);
	}
	return { state, stats, ...(lane ? { lane } : {}) };
};

export const runRound = async (input: RoundInput): Promise<RoundResult> => {
	const end = input.now() + input.roundMs;
	const runtimes = new Map<string, AgentRuntime>();
	const runtimeOf = (handle: string): AgentRuntime => {
		let rt = runtimes.get(handle);
		if (!rt) {
			rt = createRuntime(input.portOf(handle), input.cfg);
			runtimes.set(handle, rt);
		}
		return rt;
	};
	const results = await Promise.all(
		input.agents.map((agent) =>
			runAgent(runtimeOf(agent.handle), input, agent, end)
		),
	);
	let stats = results.reduce((acc, r) => addStats(acc, r.stats), emptyStats());
	const agents = results.map((r) => r.state);
	let probe: WrongLaneProbe | undefined;
	if (input.probe) {
		const seen = results.filter((r) => r.lane !== undefined);
		if (seen.length >= 2) {
			const [prober, victim] = seen as [
				(typeof results)[number],
				(typeof results)[number],
			];
			const probeStats = emptyStats();
			probe = await probeWrongLane(
				runtimeOf(prober.state.handle).port,
				victim.lane!.lane,
				victim.lane!.head,
				probeStats,
				input.cfg.repo,
			);
			stats = addStats(stats, probeStats);
		}
	}
	return { agents, stats, ...(probe ? { probe } : {}) };
};
