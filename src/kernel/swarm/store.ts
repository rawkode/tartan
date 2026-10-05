// Swarm status in R2 (`BLOBS`, WP20): the plan (`swarm/<id>/plan.json`),
// one counters file per cohort (`swarm/<id>/c<nn>.json`, rewritten after
// every round by the cohort's current generation) and the stop marker
// (`swarm/<id>/stop`). No DO and no binding of its own: the files are small,
// written once a minute per cohort, and read by `GET /-/api/swarm`. No
// token or other secret is ever written here.

import type { SwarmStatus } from "@tartan/contract";
import type { SimStats } from "./agent.ts";
import type { SwarmPlan } from "./plan.ts";
import type { ShardReady } from "./setup.ts";

export type PlanFile = {
	readonly id: string;
	readonly state: "planning" | "running" | "error";
	readonly plan: SwarmPlan;
	readonly shards?: readonly ShardReady[];
	readonly by: string;
	readonly error?: string;
	readonly updatedAt: number;
};

export type CohortFile = {
	readonly cohort: number;
	readonly generation: number;
	readonly state: "running" | "done" | "stopped" | "error";
	readonly round: number;
	readonly stats: SimStats;
	/** Estimated subrequests of the current generation. */
	readonly subrequests: number;
	readonly probe?: "refused" | "accepted" | "inconclusive";
	readonly agentsDone: number;
	readonly error?: string;
	readonly updatedAt: number;
};

export type SwarmDetail = SwarmStatus & {
	readonly capped: boolean;
	readonly simGroup: string;
	readonly shards: readonly { path: string; repoId: string }[];
	readonly claims: number;
	readonly submits: number;
	readonly rywChecks: number;
	readonly rywMismatches: number;
	readonly pushesRejected: number;
	/**
	 * The wrong-lane probe per cohort: refused as not-your-lane, accepted, or
	 * inconclusive (refused for another reason, or an error).
	 */
	readonly wrongLane: {
		readonly refused: number;
		readonly accepted: number;
		readonly inconclusive: number;
	};
	readonly generations: number;
	readonly lastError?: string;
};

/** The R2 operations the store uses (a subset of `R2Bucket`). */
export type Bucket = Pick<R2Bucket, "get" | "put" | "head" | "list">;

const planKey = (id: string) => `swarm/${id}/plan.json`;
const cohortKey = (id: string, cohort: number) =>
	`swarm/${id}/c${String(cohort).padStart(2, "0")}.json`;
const stopKey = (id: string) => `swarm/${id}/stop`;

const readJson = async <T>(bucket: Bucket, key: string): Promise<T | null> => {
	const object = await bucket.get(key);
	return object ? await object.json<T>() : null;
};

const writeJson = (bucket: Bucket, key: string, value: unknown) =>
	bucket.put(key, JSON.stringify(value), {
		httpMetadata: { contentType: "application/json" },
	});

export const createSwarmStore = (bucket: Bucket) => ({
	writePlan: (file: PlanFile) => writeJson(bucket, planKey(file.id), file),
	readPlan: (id: string) => readJson<PlanFile>(bucket, planKey(id)),
	writeCohort: (id: string, file: CohortFile) =>
		writeJson(bucket, cohortKey(id, file.cohort), file),
	readCohort: (id: string, cohort: number) =>
		readJson<CohortFile>(bucket, cohortKey(id, cohort)),
	stop: (id: string, at: number) =>
		bucket.put(stopKey(id), String(at)).then(() => undefined),
	stopped: async (id: string) => (await bucket.head(stopKey(id))) !== null,
	/** Swarm ids, newest first (ids are ULID-based). */
	list: async (limit = 20): Promise<string[]> => {
		const out = await bucket.list({ prefix: "swarm/", delimiter: "/" });
		return (out.delimitedPrefixes ?? [])
			.map((p) => p.slice("swarm/".length, -1))
			.filter((id) => id !== "")
			.sort()
			.reverse()
			.slice(0, limit);
	},
});

export type SwarmStore = ReturnType<typeof createSwarmStore>;

/** The status `GET /-/api/swarm/<id>` answers: the plan merged with every cohort's counters. */
export const summarize = (
	plan: PlanFile,
	cohorts: readonly (CohortFile | null)[],
	stopped: boolean,
	now: number,
): SwarmDetail => {
	const present = cohorts.filter((c): c is CohortFile => c !== null);
	const sum = (pick: (s: SimStats) => number) =>
		present.reduce((n, c) => n + pick(c.stats), 0);
	const allEnded = present.length === plan.plan.cohorts.length &&
		present.every((c) => c.state !== "running");
	const state: SwarmStatus["state"] = plan.state === "error"
		? "error"
		: plan.state === "planning"
		? "planning"
		: allEnded
		? "done"
		: stopped
		? "stopping"
		: now > plan.plan.endsAt + 5 * 60_000
		? "done"
		: "running";
	const lastError = plan.error ??
		present.map((c) => c.error ?? c.stats.lastError).find((e) =>
			e !== undefined
		);
	return {
		id: plan.id,
		state,
		agents: plan.plan.agents,
		cohorts: plan.plan.cohorts.length,
		pushes: sum((s) => s.pushes),
		errors: sum((s) => s.errors) + (plan.state === "error" ? 1 : 0),
		startedAt: plan.plan.startedAt,
		endsAt: plan.plan.endsAt,
		capped: plan.plan.capped,
		simGroup: plan.plan.simGroup,
		shards: (plan.shards ?? []).map((s) => ({
			path: s.path,
			repoId: s.repoId,
		})),
		claims: sum((s) => s.claims),
		submits: sum((s) => s.submits),
		rywChecks: sum((s) => s.rywChecks),
		rywMismatches: sum((s) => s.rywMismatches),
		pushesRejected: sum((s) => s.pushesRejected),
		wrongLane: {
			refused: present.filter((c) => c.probe === "refused").length,
			accepted: present.filter((c) => c.probe === "accepted").length,
			inconclusive: present.filter((c) => c.probe === "inconclusive").length,
		},
		generations: present.reduce((n, c) => Math.max(n, c.generation + 1), 0),
		...(lastError !== undefined ? { lastError } : {}),
	};
};
