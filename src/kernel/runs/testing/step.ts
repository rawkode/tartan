// A Workflows `step` fake for driver tests (Deno only): runs `do` callbacks
// with their retry budget, records every step name and output (outputs are
// structured-cloned, as the engine serializes them), advances a fake clock on
// `sleep`, and resolves `waitForEvent` from buffered events or a scenario
// hook, else throws the timeout error the engine throws.

import type { StepConfig, StepLike } from "../driver.ts";

export type WaitHook = (
	name: string,
	type: string,
) => Promise<void> | void;

/** Workflows retries a step with no config 5 times. */
const DEFAULT_RETRIES = 5;

export const fakeStep = (options: { onWait?: WaitHook } = {}) => {
	const names: string[] = [];
	const outputs: { name: string; output: unknown }[] = [];
	const buffered = new Map<string, unknown[]>();
	const slept: { name: string; ms: number }[] = [];
	const take = (type: string): { payload: unknown } | null => {
		const queue = buffered.get(type);
		if (queue === undefined || queue.length === 0) return null;
		return { payload: queue.shift() };
	};
	const step: StepLike = {
		do: (async (
			name: string,
			configOrFn: StepConfig | (() => Promise<unknown>),
			maybeFn?: () => Promise<unknown>,
		) => {
			const fn = maybeFn ?? configOrFn as () => Promise<unknown>;
			const config = maybeFn === undefined
				? undefined
				: configOrFn as StepConfig;
			names.push(name);
			const tries = (config?.retries?.limit ?? DEFAULT_RETRIES) + 1;
			let last: unknown;
			for (let i = 0; i < tries; i++) {
				try {
					const output = await fn();
					const cloned = output === undefined
						? undefined
						: structuredClone(output);
					outputs.push({ name, output: cloned });
					return cloned;
				} catch (error) {
					last = error;
				}
			}
			throw last;
		}) as StepLike["do"],
		sleep: (name, ms) => {
			names.push(name);
			slept.push({ name, ms });
			return Promise.resolve();
		},
		waitForEvent: (async (name: string, opts: { type: string }) => {
			names.push(name);
			const ready = take(opts.type);
			if (ready) return ready;
			await options.onWait?.(name, opts.type);
			const later = take(opts.type);
			if (later) return later;
			throw new Error(`waitForEvent ${name} timed out`);
		}) as StepLike["waitForEvent"],
	};
	return {
		step,
		names,
		outputs,
		slept,
		send: (type: string, payload: unknown) => {
			buffered.set(type, [...(buffered.get(type) ?? []), payload]);
		},
	};
};
