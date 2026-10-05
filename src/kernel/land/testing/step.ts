// Test-only: a Workflows step runner for Deno tests of LandWorkflow's driver.
// `do` caches each step's (JSON round-tripped) result by name, like the
// engine, so a second run with the same runner is a replay; a step name
// used twice within one run fails the test (never rely on implicit
// de-duplication). Faults: `crashAfter` throws once right after a step's
// body ran (its side effects happened, its result was not persisted: the
// engine re-runs the body), `failTimes` makes a step's body throw before it
// runs; `sleep` and timed-out waits advance the fake clock.

import type { StepConfig, StepLike } from "../../runs/driver.ts";

export type FakeStep = StepLike & {
	/** Step names in the order their bodies ran (re-runs included). */
	readonly ran: string[];
	readonly results: Map<string, unknown>;
	readonly sleeps: { name: string; ms: number }[];
	readonly waits: string[];
	/** Throws once, after the named step's body completed. */
	crashAfter: Set<string>;
	/** The named step's body throws this many times before it runs. */
	failTimes: Map<string, number>;
	/** Queues an event for `waitForEvent`. */
	send(type: string, payload: unknown): void;
	/** Starts a new run (a replay): cached steps return their results. */
	replay(): void;
	/** Called before each step body (fault injection between steps). */
	before?: (name: string) => Promise<void> | void;
	/** Called before each `waitForEvent` reads its queue. */
	onWait?: (name: string) => Promise<void> | void;
};

export const createFakeStep = (deps: {
	readonly clock: { advance(ms: number): void };
}): FakeStep => {
	const results = new Map<string, unknown>();
	const ran: string[] = [];
	const sleeps: { name: string; ms: number }[] = [];
	const waits: string[] = [];
	const queues = new Map<string, unknown[]>();
	let seen = new Set<string>();

	const claim = (name: string) => {
		if (seen.has(name)) throw new Error(`step name used twice: ${name}`);
		seen.add(name);
	};

	const step: FakeStep = {
		ran,
		results,
		sleeps,
		waits,
		crashAfter: new Set(),
		failTimes: new Map(),
		send: (type, payload) => {
			const q = queues.get(type) ?? [];
			q.push(payload);
			queues.set(type, q);
		},
		replay: () => {
			seen = new Set();
		},
		do: (async <T>(
			name: string,
			configOrFn: StepConfig | (() => Promise<T>),
			maybeFn?: () => Promise<T>,
		): Promise<T> => {
			claim(name);
			if (results.has(name)) return results.get(name) as T;
			const fn = typeof configOrFn === "function"
				? configOrFn
				: maybeFn as () => Promise<T>;
			const config = typeof configOrFn === "function" ? {} : configOrFn;
			const limit = (config.retries?.limit ?? 0) + 1;
			let lastError: unknown;
			for (let i = 0; i < limit; i++) {
				try {
					await step.before?.(name);
					const failing = step.failTimes.get(name) ?? 0;
					if (failing > 0) {
						step.failTimes.set(name, failing - 1);
						throw new Error(`injected failure in ${name}`);
					}
					ran.push(name);
					const value = await fn();
					const persisted = value === undefined
						? undefined
						: JSON.parse(JSON.stringify(value));
					if (step.crashAfter.has(name)) {
						step.crashAfter.delete(name);
						throw new Error(`injected crash after ${name}`);
					}
					results.set(name, persisted);
					return persisted as T;
				} catch (error) {
					lastError = error;
				}
			}
			throw lastError;
		}) as StepLike["do"],
		sleep: (name, ms) => {
			claim(name);
			sleeps.push({ name, ms });
			deps.clock.advance(ms);
			return Promise.resolve();
		},
		waitForEvent: <T>(
			name: string,
			options: { type: string; timeout: number },
		) => {
			claim(name);
			waits.push(name);
			return Promise.resolve(step.onWait?.(name)).then(() => {
				const q = queues.get(options.type) ?? [];
				if (q.length > 0) return { payload: q.shift() as T };
				deps.clock.advance(options.timeout);
				throw new Error(`waitForEvent ${name} timed out`);
			});
		},
	};
	return step;
};
