// The live tail of a run page (WP19, runs and logs): the
// repo's `/-/live` feed re-reads the run when one of its `run.*` / `job.*`
// events arrives (at most once a second), and while the selected job's log
// is live it is re-read every `LOG_POLL_MS` (WP9's log route returns the
// redacted tail; there is no log stream to subscribe to). Following can be
// paused. Timers come from the injected scheduler, so tests use a fake clock.

import { onScopeDispose, type Ref, ref, watch } from "vue";
import type { Envelope } from "@tartan/contract/events.ts";
import { createThrottle, type Scheduler } from "../../../live/scheduler.ts";
import type { LiveStore } from "../../../live/store.ts";

export const LOG_POLL_MS = 2000;
export const RUN_REFRESH_MS = 1000;
export const RUN_EVENT_PATTERNS = ["run.*", "job.*"] as const;

/** True when `ev` is about `runId` (a run or job event of that run). */
export const isRunEvent = (ev: Envelope, runId: string): boolean => {
	if (!ev.type.startsWith("run.") && !ev.type.startsWith("job.")) return false;
	const data = ev.data as { runId?: unknown } | null;
	return typeof data === "object" && data !== null && data.runId === runId;
};

export type RunTailDeps = {
	readonly live: LiveStore | null;
	readonly scheduler: Scheduler;
	readonly repoId: () => string | undefined;
	readonly runId: () => string;
	/** A job's log is on screen and the server says it is still live. */
	readonly logLive: () => boolean;
	readonly reloadRun: () => Promise<void>;
	readonly reloadLog: () => Promise<void>;
};

export type RunTail = {
	readonly following: Ref<boolean>;
	readonly toggle: () => void;
	/** Run events seen since the page opened (for the "live" chip). */
	readonly events: Ref<number>;
};

export const useRunTail = (deps: RunTailDeps): RunTail => {
	const following = ref(true);
	const events = ref(0);
	const runThrottle = createThrottle(
		() => void deps.reloadRun(),
		RUN_REFRESH_MS,
		deps.scheduler,
	);

	let poll: unknown = null;
	const stopPolling = (): void => {
		if (poll !== null) deps.scheduler.clearTimeout(poll);
		poll = null;
	};
	const schedulePoll = (): void => {
		stopPolling();
		if (!following.value || !deps.logLive()) return;
		poll = deps.scheduler.setTimeout(async () => {
			poll = null;
			try {
				await deps.reloadLog();
			} finally {
				schedulePoll();
			}
		}, LOG_POLL_MS);
	};

	let unsubscribe: (() => void) | null = null;
	watch(
		() => [deps.repoId(), deps.runId()] as const,
		([repoId]) => {
			unsubscribe?.();
			unsubscribe = null;
			if (!repoId || !deps.live) return;
			unsubscribe = deps.live.subscribe(repoId, {
				patterns: RUN_EVENT_PATTERNS,
				onEvents: (batch: readonly Envelope[]) => {
					const mine = batch.filter((ev) => isRunEvent(ev, deps.runId()));
					if (mine.length === 0) return;
					events.value += mine.length;
					runThrottle.trigger();
					if (following.value && deps.logLive()) void deps.reloadLog();
				},
				onResync: () => {
					runThrottle.trigger();
					void deps.reloadLog();
				},
			});
		},
		{ immediate: true },
	);

	watch(() => [following.value, deps.logLive()], () => schedulePoll(), {
		immediate: true,
	});

	onScopeDispose(() => {
		unsubscribe?.();
		runThrottle.cancel();
		stopPolling();
	});

	return {
		following,
		events,
		toggle: () => {
			following.value = !following.value;
		},
	};
};
