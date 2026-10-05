// Per-installation effects token bucket. One bucket per ExtensionDO, in memory:
// the rate limits one installation scope's effects, never correctness.

import type { Clock } from "@tartan/contract/kernel.ts";

/** Used when the manifest declares no `limits.effects_per_second`. */
export const DEFAULT_EFFECTS_PER_SECOND = 50;

export type RateLimiter = {
	/** Takes one token; false when the bucket is empty. */
	take(): boolean;
};

/** A token bucket refilled at `perSecond`, holding at most `burst` tokens. */
export const createTokenBucket = (
	clock: Clock,
	perSecond: number,
	burst: number = Math.max(1, perSecond * 2),
): RateLimiter => {
	let tokens = burst;
	let at = clock.now();
	return {
		take: () => {
			const now = clock.now();
			tokens = Math.min(burst, tokens + ((now - at) / 1000) * perSecond);
			at = now;
			if (tokens < 1) return false;
			tokens -= 1;
			return true;
		},
	};
};
