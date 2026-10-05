// Deterministic randomness for the simulated swarm (WP20): every agent's
// choices (which file, which template, its pacing jitter) derive from the
// swarm id, the agent and a counter, so a cohort that hands over to a
// successor instance continues the same sequence and a test sees the same
// run twice. Not for anything secret.

/** FNV-1a over a string: a 32-bit seed. */
export const seedOf = (text: string): number => {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
};

/** mulberry32: a small, fast PRNG with a 32-bit state. */
export const createRng = (seed: number) => {
	let state = seed >>> 0;
	const next = (): number => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return {
		/** [0, 1). */
		next,
		/** An integer in [0, n). */
		int: (n: number): number => Math.floor(next() * Math.max(1, n)),
		/** True with probability `p`. */
		chance: (p: number): boolean => next() < p,
		pick: <T>(items: readonly T[]): T =>
			items[Math.floor(next() * items.length)]!,
	};
};

export type Rng = ReturnType<typeof createRng>;

/** A fresh generator for one decision of one agent (stable across hand-overs). */
export const rngFor = (...parts: readonly (string | number)[]): Rng =>
	createRng(seedOf(parts.join("\u0000")));
