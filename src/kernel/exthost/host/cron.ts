// exthost cron task (WP7b): the backstop for lost pokes and missed retries.
// Every 5 minutes it walks the repos (`TreeFacade.listRepos`), finds the
// subscribing installations in force at each (`RegistryFacade.inForce`), and
// pokes each installation scope with the stream's current head: the repo
// stream, plus the forge stream for installations that subscribe to forge
// events. A poke on a scope that is caught up costs one cursor read; one behind
// drains, and one with a due retry runs it. Fan-out is bounded per tick
// (`EXTHOST_CRON_MAX_POKES`); when there are more candidates, each tick pokes
// the next window of them (rotating by the tick number, no stored cursor), so
// every scope is reached within ⌈candidates / max⌉ ticks. Each poke is
// isolated, so one failing installation never stops the rest, and at most
// `EXTHOST_CRON_PARALLEL` are in flight: every poke wakes an ExtensionDO that
// reads ForgeDO's registry, so an unbounded fan-out would compete with the
// forge's own requests for the length of the tick. Registered in `src/cron.ts`.

import {
	extDoName,
	type ExtScope,
	FORGE_DO_NAME,
	KERNEL_EVENT_STREAMS,
	matchesEventPattern,
	repoDoName,
	type StreamRef,
} from "@tartan/contract";
import type { CronTask, InstallationInForce } from "@tartan/contract/kernel.ts";
import { withRpc } from "../../../do/dispose.ts";
import type { Env } from "../../../env.ts";
import { sweepArchived } from "../../../constants.ts";

export const EXTHOST_CRON_MAX_POKES = 500;
/** Pokes in flight at once (the repo cron sweeps 4 repos at a time). */
export const EXTHOST_CRON_PARALLEL = 8;
/** The cron's period (every 5 minutes): one rotation step per tick. */
export const EXTHOST_CRON_PERIOD_MS = 5 * 60 * 1000;

export type ExthostCronDeps = {
	listRepos(
		cursor?: string,
	): Promise<{ repos: { id: string; path: string }[]; cursor?: string }>;
	inForce(nodeId: string): Promise<InstallationInForce[]>;
	repoHead(repoId: string): Promise<number>;
	forgeHead(): Promise<number>;
	poke(
		installationId: string,
		scope: ExtScope,
		input: { stream: StreamRef; head: number },
	): Promise<void>;
};

export type ExthostCronRun = {
	readonly pokes: number;
	readonly failed: number;
	readonly capped: boolean;
};

const FORGE_TYPES = Object.entries(KERNEL_EVENT_STREAMS)
	.filter(([, stream]) => stream !== "repo")
	.map(([type]) => type);

const wantsForge = (i: InstallationInForce): boolean =>
	(i.manifest.subscribe ?? []).some((s) =>
		FORGE_TYPES.some((type) => matchesEventPattern(s.event, type))
	);

type PlannedPoke = {
	installationId: string;
	scope: ExtScope;
	stream: StreamRef;
	repoId?: string;
};

/**
 * `rotation` (the tick number) picks which window of at most `max`
 * candidates this run pokes when there are more than `max`.
 */
export const runExthostCron = async (
	deps: ExthostCronDeps,
	max = EXTHOST_CRON_MAX_POKES,
	rotation = 0,
	parallel = EXTHOST_CRON_PARALLEL,
): Promise<ExthostCronRun> => {
	const candidates = new Map<string, PlannedPoke>();
	let cursor: string | undefined;
	do {
		const page = await deps.listRepos(cursor);
		for (const repo of page.repos) {
			const subscribers = (await deps.inForce(repo.id)).filter((i) =>
				(i.installation.mode === "enforce" ||
					i.installation.mode === "shadow") &&
				(i.manifest.subscribe ?? []).length > 0
			);
			for (const i of subscribers) {
				const scope: ExtScope = i.installation.storageScope === "repo"
					? { kind: "repo", repoId: repo.id }
					: { kind: "node" };
				const scopeKey = scope.kind === "repo" ? `repo:${repo.id}` : "node";
				const streams: StreamRef[] = [`repo:${repo.id}`];
				if (wantsForge(i)) streams.push("forge");
				for (const stream of streams) {
					const key = `${i.installation.id}|${scopeKey}|${stream}`;
					if (candidates.has(key)) continue;
					candidates.set(key, {
						installationId: i.installation.id,
						scope,
						stream,
						...(stream === "forge" ? {} : { repoId: repo.id }),
					});
				}
			}
		}
		cursor = page.cursor;
	} while (cursor !== undefined);

	const all = [...candidates.values()];
	const capped = all.length > max;
	const start = capped ? (rotation * max) % all.length : 0;
	const planned = capped
		? Array.from({ length: max }, (_, k) => all[(start + k) % all.length])
		: all;

	const heads = new Map<string, Promise<number>>();
	const head = (stream: StreamRef, repoId?: string): Promise<number> => {
		let found = heads.get(stream);
		if (found === undefined) {
			found = repoId === undefined ? deps.forgeHead() : deps.repoHead(repoId);
			heads.set(stream, found);
		}
		return found;
	};
	let failed = 0;
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < planned.length) {
			const p = planned[next++];
			try {
				await deps.poke(p.installationId, p.scope, {
					stream: p.stream,
					head: await head(p.stream, p.repoId),
				});
			} catch {
				failed++;
			}
		}
	};
	await Promise.all(
		Array.from(
			{ length: Math.max(1, Math.min(parallel, planned.length)) },
			worker,
		),
	);
	return { pokes: planned.length, failed, capped };
};

/**
 * The registered task. A failure to list repos or installations throws, so
 * `runCron` reports and logs it; poke failures are counted and logged. A
 * Worker without the ForgeDO or ExtensionDO binding has nothing to sweep.
 */
export const exthostCron: CronTask<Env> = async (env, _ctx, now) => {
	if (env.FORGE === undefined || env.EXT === undefined) return;
	const forge = () => env.FORGE.getByName(FORGE_DO_NAME);
	// Each facade stub is disposed once its call settles.
	const run = await runExthostCron(
		{
			listRepos: (cursor) =>
				withRpc(
					() => forge().tree(),
					(tree) =>
						tree.listRepos({
							...(cursor === undefined ? {} : { cursor }),
							// Archived repos are read-only: once a day only.
							archived: sweepArchived(now),
						}),
				),
			inForce: (nodeId) =>
				withRpc(() => forge().registry(), (r) => r.inForce(nodeId)),
			repoHead: (repoId) =>
				withRpc(
					() => env.REPO.getByName(repoDoName(repoId)).events(),
					(events) => events.head(),
				),
			forgeHead: () => withRpc(() => forge().events(), (e) => e.head()),
			poke: (installationId, scope, input) =>
				env.EXT.getByName(extDoName(installationId, scope)).poke(input),
		},
		EXTHOST_CRON_MAX_POKES,
		Math.floor(Date.now() / EXTHOST_CRON_PERIOD_MS),
	);
	if (run.failed > 0 || run.capped) {
		console.error(
			`[tartan] exthost cron: ${run.pokes} pokes, ${run.failed} failed${
				run.capped ? ", capped" : ""
			}`,
		);
	}
};
