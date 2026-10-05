// Environment checks with the container retry:
// the first start of a new container app can take ≈ 54 s or fail once, so
// while the `containers` check fails the wizard re-runs the checks every
// `intervalMs` for up to `maxMs` (2 minutes) before reporting it unavailable.
// Other checks are reported as they are; they do not trigger retries.

import type { EnvironmentCheck } from "@tartan/contract/api.ts";
import type { Scheduler } from "../live/scheduler.ts";

export const CONTAINER_RETRY_MS = 120_000;
export const CONTAINER_RETRY_INTERVAL_MS = 10_000;

export type ChecksProgress = {
	readonly checks: readonly EnvironmentCheck[];
	/** True while another attempt is scheduled for the container check. */
	readonly retrying: boolean;
	readonly attempt: number;
	/** Milliseconds left in the retry window. */
	readonly remainingMs: number;
};

export const containersPending = (
	checks: readonly EnvironmentCheck[],
): boolean => checks.some((c) => c.id === "containers" && !c.ok);

/** Every required (non-optional) check passed. */
export const requiredChecksPass = (
	checks: readonly EnvironmentCheck[],
): boolean => checks.length > 0 && checks.every((c) => c.ok || c.optional);

export const runChecksWithRetry = async (deps: {
	readonly fetchChecks: () => Promise<readonly EnvironmentCheck[]>;
	readonly scheduler: Scheduler;
	readonly onProgress: (progress: ChecksProgress) => void;
	readonly maxMs?: number;
	readonly intervalMs?: number;
	/** Resolves true to stop early (the view unmounted). */
	readonly cancelled?: () => boolean;
}): Promise<readonly EnvironmentCheck[]> => {
	const maxMs = deps.maxMs ?? CONTAINER_RETRY_MS;
	const intervalMs = deps.intervalMs ?? CONTAINER_RETRY_INTERVAL_MS;
	const started = deps.scheduler.now();
	let attempt = 0;
	for (;;) {
		attempt += 1;
		const checks = await deps.fetchChecks();
		const elapsed = deps.scheduler.now() - started;
		const remainingMs = Math.max(0, maxMs - elapsed);
		const retry = containersPending(checks) && remainingMs >= intervalMs &&
			!(deps.cancelled?.() ?? false);
		deps.onProgress({ checks, retrying: retry, attempt, remainingMs });
		if (!retry) return checks;
		await new Promise<void>((resolve) => {
			deps.scheduler.setTimeout(resolve, intervalMs);
		});
		if (deps.cancelled?.()) return checks;
	}
};
