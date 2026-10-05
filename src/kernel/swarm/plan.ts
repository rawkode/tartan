// Planning a simulated swarm (WP20). Pure.
//
// - Agents default to 300 and are capped at 300 unless the caller raises the
//   cap (up to the contract's 1,000): the HUD's honest default.
// - The swarm is sharded over k sim repos `<namespace>/sim/router-<nn>`, at
//   most 50 agents each (S4c's single-repo sizing); one cohort drives one
//   shard, so a cohort's agents share hot files and the overlap knob works
//   within a repo.
// - Each agent creates its own work items from templates (`workItems` in
//   all, spread evenly), claims one at a time, pushes a few commits to its
//   lane and submits; agents act every `paceMs` with jitter.
// - A cohort instance stops at 80% of its subrequest budget and hands over
//   to a successor (`swarm-<id>-c<nn>-g<n+1>`).

import type { SwarmRequest } from "@tartan/contract";

export const SWARM_LIMITS = {
	/** Agents when the request names none, and the default cap. */
	defaultAgents: 300,
	defaultCap: 300,
	/** The contract's ceiling (`SwarmRequestSchema`). */
	maxAgents: 1000,
	/** Agents per sim repo (one cohort per shard). */
	agentsPerShard: 50,
	/** Commits each agent pushes to a lane before it submits. */
	pushesPerItem: 3,
	/** Mean time between an agent's actions. */
	paceMs: 15_000,
	/** Wall time of one cohort step (a round). */
	roundMs: 60_000,
	/** A Workflow instance's subrequest budget. */
	subrequestBudget: 10_000,
	/** Hand over to a successor at this share of the budget. */
	handoverAt: 0.8,
	/** Agent tokens live this long (each round mints its own). */
	tokenTtlMs: 15 * 60_000,
} as const;

export type ShardPlan = {
	readonly index: number;
	/** `<namespace>/sim/router-<nn>`. */
	readonly path: string;
	readonly slug: string;
};

export type CohortPlan = {
	readonly index: number;
	readonly shard: number;
	/** The cohort's bulk-mint prefix (`sim-<swarm tail>-c<nn>`, ≤ 20 chars). */
	readonly prefix: string;
	/** Agent handles: `<prefix>-<n>`, as bulk minting names them. */
	readonly agents: readonly string[];
};

export type SwarmPlan = {
	readonly swarmId: string;
	readonly namespace: string;
	/** `<namespace>/sim`. */
	readonly simGroup: string;
	readonly agents: number;
	readonly capped: boolean;
	readonly shards: readonly ShardPlan[];
	readonly cohorts: readonly CohortPlan[];
	readonly itemsPerAgent: number;
	readonly pushesPerItem: number;
	readonly overlap: number;
	readonly hotFiles: number;
	readonly paceMs: number;
	readonly startedAt: number;
	readonly endsAt: number;
};

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** The first segment of a node path: the namespace the sim group lives in. */
export const namespaceOf = (path: string): string =>
	path.replace(/^\/+/, "").split("/")[0] ?? "";

/**
 * A cohort's bulk-mint prefix: `sim-`, the swarm id's last 8 characters and
 * the cohort (`[a-z0-9-]{1,20}`); the minted handles are `<prefix>-<n>`, so
 * cohorts never share a principal.
 */
export const cohortPrefix = (swarmId: string, cohort: number): string =>
	`sim-${swarmId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-8)}-c${
		pad2(cohort + 1)
	}`;

export const planSwarm = (input: {
	readonly swarmId: string;
	readonly request: SwarmRequest;
	readonly now: number;
	/** The caller's cap (default 300, at most 1,000). */
	readonly cap?: number;
	readonly paceMs?: number;
	readonly pushesPerItem?: number;
}): SwarmPlan => {
	const cap = Math.min(
		SWARM_LIMITS.maxAgents,
		Math.max(1, input.cap ?? SWARM_LIMITS.defaultCap),
	);
	const wanted = input.request.agents;
	const agents = Math.min(wanted, cap);
	const namespace = namespaceOf(input.request.repo);
	const simGroup = `${namespace}/sim`;
	const shardCount = Math.ceil(agents / SWARM_LIMITS.agentsPerShard);
	const shards = Array.from({ length: shardCount }, (_, i): ShardPlan => ({
		index: i,
		slug: `router-${pad2(i + 1)}`,
		path: `${simGroup}/router-${pad2(i + 1)}`,
	}));
	// Agents spread evenly: shard sizes differ by at most one.
	const cohorts = shards.map((shard): CohortPlan => {
		const from = Math.floor((shard.index * agents) / shardCount);
		const to = Math.floor(((shard.index + 1) * agents) / shardCount);
		const prefix = cohortPrefix(input.swarmId, shard.index);
		return {
			index: shard.index,
			shard: shard.index,
			prefix,
			agents: Array.from({ length: to - from }, (_, j) => `${prefix}-${j + 1}`),
		};
	});
	return {
		swarmId: input.swarmId,
		namespace,
		simGroup,
		agents,
		capped: agents < wanted,
		shards,
		cohorts,
		itemsPerAgent: Math.max(
			1,
			Math.ceil(input.request.workItems / Math.max(1, agents)),
		),
		pushesPerItem: input.pushesPerItem ?? SWARM_LIMITS.pushesPerItem,
		overlap: input.request.overlap,
		hotFiles: input.request.hotFiles,
		paceMs: input.paceMs ?? SWARM_LIMITS.paceMs,
		startedAt: input.now,
		endsAt: input.now + input.request.minutes * 60_000,
	};
};

/** Deterministic instance ids: parent and cohort generations. */
export const swarmInstanceId = (swarmId: string): string => swarmId;
export const cohortInstanceId = (
	swarmId: string,
	cohort: number,
	generation: number,
): string => `${swarmId}-c${pad2(cohort)}-g${generation}`;

/** A swarm id: `swarm-<ulid>` (lowercase). */
export const SWARM_ID_RE = /^swarm-[0-9a-z]{26}$/;
