// repo cron task (WP5a), per repo: reconciliation of the canonical repo and
// branch-lane refs by `ls-refs` (`R.core().reconcile()`, which skips idle repos
// except once a day) and lane GC of both backends (`R.core().gcLanes`, which
// delegates `repo` lanes to WP5b's `gc`). The seed re-drive, lane-repo
// reconciliation and the orphan sweep of `l-*` lane repos are WP5b's own task
// (`lanes/repo-backend/cron.ts`, `repoBackend`). Registered in `src/cron.ts`;
// runs every 5 minutes in its own try/catch. One repo's failure is logged and
// never skips another.

import { FORGE_DO_NAME, repoDoName } from "@tartan/contract";
import type { CronTask } from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import { sweepArchived } from "../../constants.ts";
import { withRpc } from "../../do/dispose.ts";

/** Repos per `listRepos` page, and how many are swept at once. */
const PAGE = 100;
const PARALLEL = 4;

export type RepoSweepOutcome = {
	readonly repos: number;
	readonly failed: readonly {
		readonly repoId: string;
		readonly error: string;
	}[];
};

const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/** One repo: reconcile, then lane GC. */
export const sweepRepo = async (
	env: Env,
	repoId: string,
	now: number,
): Promise<void> => {
	await withRpc(
		() => env.REPO.getByName(repoDoName(repoId)).core(),
		async (core) => {
			await core.reconcile();
			await core.gcLanes(now);
		},
	);
};

/** Every repo of the forge, `PARALLEL` at a time. */
export const sweepRepos = async (
	env: Env,
	now: number,
	sweep: (repoId: string) => Promise<void> = (repoId) =>
		sweepRepo(env, repoId, now),
): Promise<RepoSweepOutcome> => {
	const failed: { repoId: string; error: string }[] = [];
	let repos = 0;
	let cursor: string | undefined;
	do {
		const page = await withRpc(
			() => env.FORGE.getByName(FORGE_DO_NAME).tree(),
			(tree) =>
				tree.listRepos({
					limit: PAGE,
					...(cursor !== undefined ? { cursor } : {}),
					// Archived repos get their lane GC once a day only.
					archived: sweepArchived(now),
				}),
		);
		for (let i = 0; i < page.repos.length; i += PARALLEL) {
			const batch = page.repos.slice(i, i + PARALLEL);
			await Promise.all(batch.map(async ({ id }) => {
				repos++;
				try {
					await sweep(id);
				} catch (error) {
					failed.push({ repoId: id, error: errorText(error) });
				}
			}));
		}
		cursor = page.cursor;
	} while (cursor !== undefined);
	return { repos, failed };
};

export const repoCron: CronTask<Env> = async (env, _ctx, now) => {
	const outcome = await sweepRepos(env, now);
	if (outcome.failed.length > 0) {
		console.error(
			"[tartan] repo cron: some repos failed",
			JSON.stringify(outcome.failed.slice(0, 20)),
		);
	}
};
