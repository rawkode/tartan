// The 5-minute cron. Integrator-owned registry: each owning module exports one
// `CronTask` from its own `cron.ts` and is listed here once, so no WP edits
// `src/index.ts`. Tasks run concurrently, each isolated: one failure is logged
// and never skips another. Repo sweeps enumerate repos with
// `TreeFacade.listRepos`.

import type { CronTask } from "@tartan/contract/kernel.ts";
import type { Env } from "./env.ts";
import { busCron } from "./kernel/bus/cron.ts";
import { eventsCron } from "./kernel/events/cron.ts";
import { exthostCron } from "./kernel/exthost/host/cron.ts";
import { identityCron } from "./kernel/identity/cron.ts";
import { repoCron } from "./kernel/repo/cron.ts";
import { repoBackendCron } from "./kernel/repo/lanes/repo-backend/cron.ts";

/**
 * Task name → task; the name is `<module>` of its owner.
 * `repo` is WP5a's, `repoBackend` WP5b's (the `repo` lane backend).
 */
export const CRON_TASKS: Readonly<Record<string, CronTask<Env>>> = {
	identity: identityCron,
	repo: repoCron,
	repoBackend: repoBackendCron,
	events: eventsCron,
	exthost: exthostCron,
	bus: busCron,
};

export type CronOutcome = {
	readonly task: string;
	readonly ok: boolean;
	readonly error?: string;
};

export const runCron = async (
	tasks: Readonly<Record<string, CronTask<Env>>>,
	env: Env,
	ctx: ExecutionContext,
	now: number,
	log: (message: string, data: Record<string, unknown>) => void = (
		message,
		data,
	) => console.error(`[tartan] ${message}`, JSON.stringify(data)),
): Promise<CronOutcome[]> =>
	await Promise.all(
		Object.entries(tasks).map(async ([task, run]): Promise<CronOutcome> => {
			try {
				await run(env, ctx, now);
				return { task, ok: true };
			} catch (cause) {
				const error = cause instanceof Error ? cause.message : String(cause);
				log("cron task failed", { task, error });
				return { task, ok: false, error };
			}
		}),
	);
