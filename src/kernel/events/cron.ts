// events cron task (WP6), every 5 minutes, per repo (`TreeFacade.listRepos`,
// paged, bounded):
//   1. retention: `R.events().prune(now)` (30 d, `sim` 24 h, pinned never;
//      the chain stays verifiable);
//   2. subscriber refresh and known_head recovery: the subscriber rows are
//      rebuilt from the registry and `refreshSubscribers` pokes every
//      subscriber with the current head, so a lost poke is caught here
//      (bounded fan-out: one poke per subscriber per repo per run).
// Each repo and each step is isolated; failures are collected and reported
// once at the end so `runCron` logs them without skipping other repos.

import { FORGE_DO_NAME } from "@tartan/contract";
import type { CronTask, RepoEventsFacade } from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import { sweepArchived } from "../../constants.ts";
import { disposeRpc, withRpc } from "../../do/dispose.ts";
import { kernelPorts } from "./http.ts";
import {
	registrySubscriberSource,
	type SubscriberSource,
} from "./subscribers.ts";

/** Repos visited per run (the rest wait for the next run). */
export const CRON_MAX_REPOS = 1000;
const PAGE = 100;

export type EventsCronDeps = {
	listRepos(
		options: { cursor?: string; limit: number; archived?: boolean },
	): Promise<{ repos: { id: string }[]; cursor?: string }>;
	repoEvents(repoId: string): Pick<
		RepoEventsFacade,
		"prune" | "refreshSubscribers"
	>;
	readonly subscribers: SubscriberSource;
};

export const eventsCronDeps = (env: Env): EventsCronDeps => {
	const ports = kernelPorts(env);
	return {
		listRepos: (options) =>
			withRpc(
				() => env.FORGE.getByName(FORGE_DO_NAME).tree(),
				(tree) => tree.listRepos(options),
			),
		repoEvents: ports.repoEvents,
		subscribers: registrySubscriberSource(env),
	};
};

export const runEventsCron = async (
	deps: EventsCronDeps,
	now: number,
): Promise<{ repos: number; pruned: number; failures: string[] }> => {
	const failures: string[] = [];
	let repos = 0;
	let pruned = 0;
	let cursor: string | undefined;
	do {
		const page = await deps.listRepos({
			...(cursor !== undefined ? { cursor } : {}),
			limit: PAGE,
			// Archived repos are pruned once a day only.
			archived: sweepArchived(now),
		});
		for (const { id } of page.repos) {
			if (repos >= CRON_MAX_REPOS) break;
			repos++;
			const events = deps.repoEvents(id);
			try {
				try {
					pruned += (await events.prune(now)).deleted;
				} catch (error) {
					failures.push(`${id} prune: ${String(error)}`);
				}
				try {
					const loaded = await deps.subscribers.load(id);
					await events.refreshSubscribers(loaded.rows, loaded.extVersion);
				} catch (error) {
					failures.push(`${id} subscribers: ${String(error)}`);
				}
			} finally {
				// One RepoDO call context per repo, closed before the next.
				disposeRpc(events);
			}
		}
		cursor = page.cursor;
	} while (cursor !== undefined && repos < CRON_MAX_REPOS);
	return { repos, pruned, failures };
};

export const eventsCron: CronTask<Env> = async (env, _ctx, now) => {
	const result = await runEventsCron(eventsCronDeps(env), now);
	if (result.failures.length > 0) {
		throw new Error(
			`events cron: ${result.failures.length} failure(s); first: ${
				result.failures[0]
			}`,
		);
	}
};
