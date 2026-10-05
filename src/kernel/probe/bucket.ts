// Binding-read rate limits: a token bucket shared
// by every RepoProbe call in this isolate (`BINDING_READS_PER_S`, 250/s:
// sustained reads stayed free of 429s there) and a per-request cap on
// reads in flight (`BINDING_READS_CONCURRENCY`, 16). Essential reads (range
// walks, tree diffs) wait for a token, so one busy request self-queues;
// optional detail (hunks, merge3) asks with `tryTake` and degrades to path
// level when the bucket is empty.

import type { Clock } from "@tartan/contract/kernel.ts";
import { BINDING_READS_PER_S } from "../../constants.ts";

export type TokenBucket = {
	/** Waits until a token is available, then takes it. */
	take(): Promise<void>;
	/** Takes `n` tokens now if available; false (taking none) otherwise. */
	tryTake(n?: number): boolean;
	/** Tokens available now. */
	available(): number;
};

export type BucketOptions = {
	readonly ratePerSecond?: number;
	/** Bucket size (default one second of tokens). */
	readonly burst?: number;
	readonly clock?: Clock;
	/** Injected for tests; defaults to setTimeout. */
	readonly sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

export const createTokenBucket = (options: BucketOptions = {}): TokenBucket => {
	const rate = options.ratePerSecond ?? BINDING_READS_PER_S;
	const burst = options.burst ?? rate;
	const now = () => (options.clock ?? Date).now();
	const sleep = options.sleep ?? defaultSleep;
	let tokens = burst;
	let at = now();
	const refill = () => {
		const t = now();
		tokens = Math.min(burst, tokens + ((t - at) * rate) / 1000);
		at = t;
	};
	const tryTake = (n = 1): boolean => {
		refill();
		if (tokens < n) return false;
		tokens -= n;
		return true;
	};
	const take = async (): Promise<void> => {
		while (!tryTake(1)) {
			await sleep(Math.max(1, Math.ceil(((1 - tokens) * 1000) / rate)));
		}
	};
	return {
		take,
		tryTake,
		available: () => {
			refill();
			return Math.floor(tokens);
		},
	};
};

/** The isolate-wide bucket every RepoProbe call shares. */
export const isolateReadBucket: TokenBucket = createTokenBucket();
