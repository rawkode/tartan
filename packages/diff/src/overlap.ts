// Hunk proximity on a shared base (radar's `same_file` → `adjacent` → `textual`
// ladder). Classification policy is the radar's (WP13); these are the geometric
// primitives it needs.

import type { Hunk } from "./hunks.ts";

/** Hunks within this many base lines of each other are "adjacent". */
export const ADJACENT_LINES = 3;

/** 0-based half-open base interval of a hunk (an insertion is zero-width). */
const interval = (h: Hunk): readonly [number, number] => {
	const start = h.oldLines === 0 ? h.oldStart : h.oldStart - 1;
	return [start, start + h.oldLines];
};

/** Lines strictly between two hunks on the base (negative when they overlap). */
const gap = (x: Hunk, y: Hunk): number => {
	const [x0, x1] = interval(x);
	const [y0, y1] = interval(y);
	return Math.max(x0, y0) - Math.min(x1, y1);
};

const overlaps = (x: Hunk, y: Hunk): boolean => {
	const g = gap(x, y);
	return g < 0 || (g === 0 && (x.oldLines === 0 || y.oldLines === 0) &&
		interval(x)[0] === interval(y)[0]);
};

/** Index pairs `[i, j]` of hunks of `a` and `b` that change the same base lines. */
export const overlapHunks = (
	a: readonly Hunk[],
	b: readonly Hunk[],
): [number, number][] =>
	a.flatMap((x, i) =>
		b.flatMap((y, j): [number, number][] => overlaps(x, y) ? [[i, j]] : [])
	);

/** Index pairs of hunks that do not overlap but lie within `distance` base lines. */
export const adjacentHunks = (
	a: readonly Hunk[],
	b: readonly Hunk[],
	distance: number = ADJACENT_LINES,
): [number, number][] =>
	a.flatMap((x, i) =>
		b.flatMap((y, j): [number, number][] =>
			!overlaps(x, y) && gap(x, y) <= distance ? [[i, j]] : []
		)
	);
