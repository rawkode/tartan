// The `bus` cron task (WP26; trigger and recovery), every 5
// minutes:
//   1. wakes each consumer (re-arms a lost poll timer; a lost nudge costs at
//      most 5 s, a lost timer at most this cron);
//   2. kicks the ForgeDO relay and every repo whose relay is behind, so a
//      quiet DO never strands its backlog (the append timer is the primary
//      trigger; this is the watchdog), bounded per run;
//   3. records the worst relay lags on `bus:workloads:0` for the status page.
// With no producer binding the relays are `off` and only step 1 runs.
// Each step and repo is isolated; failures are reported once at the end.

import { FORGE_DO_NAME, repoDoName } from "@tartan/contract";
import type { CronTask } from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import { sweepArchived } from "../../constants.ts";
import { busDoName, K2_GROUPS } from "./config.ts";
import type {
	BusFacade,
	BusRelayFacade,
	RelayLag,
	RelayStatus,
} from "./contract.ts";
import { type BusRelayStub, k2Env } from "./k2.ts";
import { disposeRpc, withRpc } from "../../do/dispose.ts";

/** Repos visited per run (the rest wait for the next run). */
export const BUS_CRON_MAX_REPOS = 1000;
const PAGE = 100;

export type BusCronDeps = {
	readonly relaysOn: boolean;
	/** Every consumer worker of every group. */
	consumers(): { name: string; bus: BusFacade }[];
	forgeRelay(): BusRelayFacade;
	repoRelay(repoId: string): BusRelayFacade;
	listRepos(
		options: { cursor?: string; limit: number; archived?: boolean },
	): Promise<{ repos: { id: string }[]; cursor?: string }>;
};

export const busCronDeps = (env: Env): BusCronDeps => {
	const k2 = k2Env(env);
	return {
		relaysOn: k2.EVENT_LOG !== undefined &&
			typeof k2.TARTAN_K2_STREAM === "string" && k2.TARTAN_K2_STREAM !== "",
		consumers: () =>
			k2.BUS === undefined ? [] : Object.entries(K2_GROUPS).flatMap((
				[group, config],
			) =>
				Array.from({ length: config.workers }, (_, n) => {
					const name = busDoName(group, n);
					return { name, bus: k2.BUS!.getByName(name).bus() };
				})
			),
		forgeRelay: () =>
			(env.FORGE.getByName(FORGE_DO_NAME) as unknown as BusRelayStub).bus(),
		repoRelay: (repoId) =>
			(env.REPO.getByName(repoDoName(repoId)) as unknown as BusRelayStub)
				.bus(),
		listRepos: (options) =>
			withRpc(
				() => env.FORGE.getByName(FORGE_DO_NAME).tree(),
				(tree) => tree.listRepos(options),
			),
	};
};

const lagOf = (s: RelayStatus): RelayLag => ({
	stream: s.stream,
	state: s.state,
	lag: s.lag,
	oldestUnrelayedAt: s.oldestUnrelayedAt,
});

export const runBusCron = async (
	deps: BusCronDeps,
	now: number = Date.now(),
): Promise<
	{ woken: number; repos: number; kicked: number; failures: string[] }
> => {
	const consumers = deps.consumers();
	try {
		return await runWith(deps, consumers, now);
	} finally {
		// Every DO call context this run opened is closed.
		for (const { bus } of consumers) disposeRpc(bus);
	}
};

const runWith = async (
	deps: BusCronDeps,
	consumers: readonly { name: string; bus: BusFacade }[],
	now: number,
): Promise<
	{ woken: number; repos: number; kicked: number; failures: string[] }
> => {
	const failures: string[] = [];
	for (const { name, bus } of consumers) {
		try {
			await bus.wake();
		} catch (error) {
			failures.push(`${name} wake: ${String(error)}`);
		}
	}
	if (!deps.relaysOn) {
		return { woken: consumers.length, repos: 0, kicked: 0, failures };
	}
	const lags: RelayLag[] = [];
	let kicked = 0;
	let forge: BusRelayFacade | null = null;
	try {
		forge = deps.forgeRelay();
		const status = await forge.status();
		lags.push(lagOf(status.lag > 0 ? (kicked++, await forge.kick()) : status));
	} catch (error) {
		failures.push(`forge relay: ${String(error)}`);
	} finally {
		disposeRpc(forge);
	}
	let repos = 0;
	let cursor: string | undefined;
	do {
		let page: { repos: { id: string }[]; cursor?: string };
		try {
			page = await deps.listRepos({
				...(cursor !== undefined ? { cursor } : {}),
				limit: PAGE,
				// Archived repos are read-only: once a day only.
				archived: sweepArchived(now),
			});
		} catch (error) {
			failures.push(`listRepos: ${String(error)}`);
			break;
		}
		for (const { id } of page.repos) {
			if (repos >= BUS_CRON_MAX_REPOS) break;
			repos++;
			let relay: BusRelayFacade | null = null;
			try {
				relay = deps.repoRelay(id);
				const status = await relay.status();
				if (status.state === "off") continue;
				const after = status.lag > 0 ? (kicked++, await relay.kick()) : status;
				lags.push(lagOf(after));
			} catch (error) {
				failures.push(`${id} relay: ${String(error)}`);
			} finally {
				// One RepoDO call context per repo, closed before the next.
				disposeRpc(relay);
			}
		}
		cursor = page.cursor;
	} while (cursor !== undefined && repos < BUS_CRON_MAX_REPOS);
	const leader = consumers[0];
	if (leader !== undefined) {
		try {
			await leader.bus.recordRelayLags(lags);
		} catch (error) {
			failures.push(`record lags: ${String(error)}`);
		}
	}
	return { woken: consumers.length, repos, kicked, failures };
};

export const busCron: CronTask<Env> = async (env, _ctx, now) => {
	const result = await runBusCron(busCronDeps(env), now);
	if (result.failures.length > 0) {
		throw new Error(
			`bus cron: ${result.failures.length} failure(s); first: ${
				result.failures[0]
			}`,
		);
	}
};
