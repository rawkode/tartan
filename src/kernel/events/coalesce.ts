// In-memory coalescing (WP6): many triggers become one run, at most one run per
// `minIntervalMs`. Idle, a trigger runs after `delayMs` (25 ms); under load the
// runs stretch to one per `minIntervalMs` (250 ms), so each subscriber sees at
// most 4 pokes per second and each live socket at most 4 frames per second.
// Lost on eviction by design: the 5-minute cron re-pokes and live clients
// resume with `since`.

export type Schedule = (fn: () => void, ms: number) => void;

export type CoalescerDeps = {
	readonly delayMs: number;
	readonly minIntervalMs: number;
	readonly now: () => number;
	readonly schedule: Schedule;
	readonly run: () => void | Promise<void>;
	readonly onError?: (error: unknown) => void;
};

export type Coalescer = {
	/** Requests a run; a no-op while one is already scheduled. */
	trigger(): void;
	/** True while a run is scheduled and has not started. */
	pending(): boolean;
};

export const createCoalescer = (deps: CoalescerDeps): Coalescer => {
	let scheduled = false;
	let lastRun = Number.NEGATIVE_INFINITY;

	const fire = (): void => {
		scheduled = false;
		lastRun = deps.now();
		try {
			const result = deps.run();
			if (result instanceof Promise) result.catch((e) => deps.onError?.(e));
		} catch (error) {
			deps.onError?.(error);
		}
	};

	return {
		trigger: () => {
			if (scheduled) return;
			scheduled = true;
			const now = deps.now();
			const at = Math.max(now + deps.delayMs, lastRun + deps.minIntervalMs);
			deps.schedule(fire, Math.max(0, at - now));
		},
		pending: () => scheduled,
	};
};

/** `setTimeout` as a `Schedule` (DOs keep running timers while awake). */
export const timerSchedule: Schedule = (fn, ms) => {
	setTimeout(fn, ms);
};
