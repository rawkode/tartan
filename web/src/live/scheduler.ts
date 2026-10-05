// Timers as an explicit dependency, so the live store, slot refresh and the
// setup checks can be tested with a fake clock.

import { inject, type InjectionKey } from "vue";

export type TimerHandle = unknown;

export type Scheduler = {
	readonly now: () => number;
	readonly setTimeout: (fn: () => void, ms: number) => TimerHandle;
	readonly clearTimeout: (handle: TimerHandle) => void;
};

export const browserScheduler: Scheduler = {
	now: () => Date.now(),
	setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
	clearTimeout: (handle) =>
		globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Runs `fn` at most once per `intervalMs`: a call inside the window schedules
 * one trailing run at the window's end (later calls in the same window fold
 * into it). Used for slot refreshes (≤ 1/s per slot).
 */
export const createThrottle = (
	fn: () => void,
	intervalMs: number,
	scheduler: Scheduler,
): { readonly trigger: () => void; readonly cancel: () => void } => {
	let last = -Infinity;
	let pending: TimerHandle | null = null;
	const run = (): void => {
		pending = null;
		last = scheduler.now();
		fn();
	};
	return {
		trigger: () => {
			if (pending !== null) return;
			const wait = last + intervalMs - scheduler.now();
			if (wait <= 0) run();
			else pending = scheduler.setTimeout(run, wait);
		},
		cancel: () => {
			if (pending !== null) scheduler.clearTimeout(pending);
			pending = null;
		},
	};
};

/** The app's scheduler (tests provide a fake clock). */
export const SCHEDULER: InjectionKey<Scheduler> = Symbol("scheduler");

export const useScheduler = (): Scheduler =>
	inject(SCHEDULER, null) ?? browserScheduler;
