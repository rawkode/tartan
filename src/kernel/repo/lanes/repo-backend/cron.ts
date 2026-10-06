// repoBackend cron task (WP5b), every 5 minutes, each part in its own
// try/catch:
// - per repo: the seed re-drive (`R.core().redriveSeeds`) and lane-repo
//   reconciliation by exact name (`R.core().reconcileLaneRepos`, paced);
// - forge-wide: the orphan sweep. The `l-*` names of `ARTIFACTS.list()` and
//   the `pending`/`live` lane rows of `artifacts_index` older than the
//   orphan age are parsed to their repo family (`parseArtifactsName`) and
//   handed to that repo's `R.core().sweepLaneRepos(names, now)`, which
//   alone decides (it knows the lanes).
// Lane GC of both backends stays in WP5a's `repo` task (`gcLanes`).

import {
	FORGE_DO_NAME,
	parseArtifactsName,
	repoDoName,
} from "@tartan/contract";
import type {
	CronTask,
	RepoCoreFacade,
	RepoStore,
	SweepResult,
	TreeFacade,
} from "@tartan/contract/kernel.ts";
import { LANE_ORPHAN_AGE_MS } from "../../../../constants.ts";
import type { Env } from "../../../../env.ts";
import { sweepRepos } from "../../cron.ts";

/** `ARTIFACTS.list()` page size and the most pages one run reads. */
const LIST_PAGE = 200;
const LIST_PAGES_MAX = 50;
/** Names handed to one `sweepLaneRepos` call. */
const SWEEP_CHUNK = 100;

export type RepoBackendCronDeps = {
	readonly artifacts: Pick<RepoStore, "list">;
	readonly tree: Pick<TreeFacade, "listRepos" | "listArtifactsIndex">;
	core(repoId: string): Pick<
		RepoCoreFacade,
		"redriveSeeds" | "reconcileLaneRepos" | "sweepLaneRepos"
	>;
	log(message: string, data: Record<string, unknown>): void;
	/** Per-repo work (default: every repo of the tree). */
	forEachRepo?: (work: (repoId: string) => Promise<void>) => Promise<void>;
};

const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/** Every `l-*` name to judge, grouped by repo family. */
export const laneRepoFamilies = async (
	deps: RepoBackendCronDeps,
	now: number,
): Promise<Map<string, string[]>> => {
	const families = new Map<string, Set<string>>();
	const add = (name: string) => {
		const parsed = parseArtifactsName(name);
		if (parsed === null || parsed.kind !== "lane") return;
		const set = families.get(parsed.repoUlid) ?? new Set<string>();
		set.add(name.toLowerCase());
		families.set(parsed.repoUlid, set);
	};
	// A failed listing (Artifacts answered "An internal error occurred." on
	// every cron tick of dev-e2e) keeps the pages read so far and the
	// index's names below: the sweep still runs over what it knows.
	let cursor: string | undefined;
	try {
		for (let page = 0; page < LIST_PAGES_MAX; page++) {
			const listed = await deps.artifacts.list({
				limit: LIST_PAGE,
				...(cursor !== undefined ? { cursor } : {}),
			});
			for (const repo of listed.repos) add(repo.name);
			cursor = listed.cursor;
			if (cursor === undefined || listed.repos.length === 0) break;
		}
	} catch (error) {
		deps.log("repoBackend cron: Artifacts listing failed", {
			error: errorText(error),
		});
	}
	for (const state of ["pending", "live"] as const) {
		try {
			const rows = await deps.tree.listArtifactsIndex(
				state,
				now - LANE_ORPHAN_AGE_MS,
			);
			for (const row of rows) if (row.kind === "lane") add(row.name);
		} catch (error) {
			deps.log("repoBackend cron: index listing failed", {
				state,
				error: errorText(error),
			});
		}
	}
	return new Map([...families].map(([k, v]) => [k, [...v]]));
};

export type RepoBackendCronOutcome = {
	readonly repos: number;
	readonly swept: SweepResult;
	readonly failed: readonly string[];
};

export const runRepoBackendCron = async (
	deps: RepoBackendCronDeps,
	now: number,
): Promise<RepoBackendCronOutcome> => {
	const failed: string[] = [];
	let repos = 0;
	const perRepo = async (repoId: string) => {
		repos++;
		const core = deps.core(repoId);
		try {
			await core.redriveSeeds(now);
		} catch (error) {
			failed.push(`${repoId} redrive: ${errorText(error)}`);
		}
		try {
			await core.reconcileLaneRepos(now);
		} catch (error) {
			failed.push(`${repoId} reconcile: ${errorText(error)}`);
		}
	};
	try {
		if (deps.forEachRepo !== undefined) await deps.forEachRepo(perRepo);
	} catch (error) {
		failed.push(`repos: ${errorText(error)}`);
	}
	const deleted: string[] = [];
	const kept: string[] = [];
	try {
		const families = await laneRepoFamilies(deps, now);
		for (const [repoId, names] of families) {
			for (let i = 0; i < names.length; i += SWEEP_CHUNK) {
				try {
					const result = await deps.core(repoId).sweepLaneRepos(
						names.slice(i, i + SWEEP_CHUNK),
						now,
					);
					deleted.push(...result.deleted);
					kept.push(...result.kept);
				} catch (error) {
					failed.push(`${repoId} sweep: ${errorText(error)}`);
				}
			}
		}
	} catch (error) {
		failed.push(`sweep: ${errorText(error)}`);
	}
	if (failed.length > 0) {
		deps.log("repoBackend cron: some parts failed", {
			failed: failed.slice(0, 20),
		});
	}
	return { repos, swept: { deleted, kept }, failed };
};

export const repoBackendCron: CronTask<Env> = async (env, _ctx, now) => {
	const tree = env.FORGE.getByName(FORGE_DO_NAME).tree();
	await runRepoBackendCron({
		artifacts: env.ARTIFACTS,
		tree: tree as unknown as Pick<
			TreeFacade,
			"listRepos" | "listArtifactsIndex"
		>,
		core: (repoId) =>
			env.REPO.getByName(repoDoName(repoId)).core() as unknown as Pick<
				RepoCoreFacade,
				"redriveSeeds" | "reconcileLaneRepos" | "sweepLaneRepos"
			>,
		log: (message, data) =>
			console.error(`[tartan] ${message}`, JSON.stringify(data)),
		forEachRepo: async (work) => {
			await sweepRepos(env, now, work);
		},
	}, now);
};
