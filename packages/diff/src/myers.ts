// Line diff: Myers' O(ND) algorithm, linear-space variant (E. W. Myers, "An
// O(ND) Difference Algorithm and Its Variations", Algorithmica 1986): the
// forward and the reverse search run in turn, one edit at a time, until
// they meet; the meeting point splits the problem in two. Diagonals are
// scanned from the deletion-heavy side first and ties prefer deletions, so
// the output lines up with git's for equal-cost alternatives. Then:
//
// - lines that cannot match anything on the other side are set aside
//   before the search (see "Pre-filtering" below);
// - a run of changed lines that can slide (the line before it equals its
//   last line, or the line after it equals its first line) is moved as far
//   down as it goes, absorbing neighbouring runs it touches;
// - if, somewhere along that slide, the run sat opposite a run of changes in
//   the other sequence, it is moved back up to the lowest such position, so
//   a deletion and an insertion line up as one modification.
//
// Our own implementation (MIT), written from the paper and from git's
// documented output behaviour; no code is taken from any diff library.

/** One difference: `a[aStart, aStart + aLen)` became `b[bStart, bStart + bLen)` (0-based). */
export type Change = {
	readonly aStart: number;
	readonly aLen: number;
	readonly bStart: number;
	readonly bLen: number;
};

type Box = readonly [aLo: number, aHi: number, bLo: number, bHi: number];

/** Edits after which a search settles for its furthest point (bounds CPU on huge diffs). */
const MIN_COST_LIMIT = 256;

type Search = {
	readonly a: Int32Array;
	readonly b: Int32Array;
	/** Furthest forward x per diagonal k = x - y (index `off + k`). */
	readonly vf: Int32Array;
	/** Furthest (smallest) reverse x per diagonal. */
	readonly vb: Int32Array;
	readonly off: number;
	readonly costLimit: number;
};

const UNREACHED_HIGH = 0x7fffffff;

/**
 * A point on a shortest edit path through `box` (whose first and last
 * lines differ), where the forward and reverse searches meet.
 */
const meetingPoint = (s: Search, box: Box): readonly [number, number] => {
	const { a, b, vf, vb, off } = s;
	const [aLo, aHi, bLo, bHi] = box;
	const kMin = aLo - bHi;
	const kMax = aHi - bLo;
	const fMid = aLo - bLo;
	const rMid = aHi - bHi;
	const odd = ((fMid - rMid) & 1) !== 0;
	let fLo = fMid;
	let fHi = fMid;
	let rLo = rMid;
	let rHi = rMid;
	vf[off + fMid] = aLo;
	vb[off + rMid] = aHi;
	for (let d = 1;; d++) {
		if (fLo > kMin) vf[off + --fLo - 1] = -1;
		else fLo++;
		if (fHi < kMax) vf[off + ++fHi + 1] = -1;
		else fHi--;
		for (let k = fHi; k >= fLo; k -= 2) {
			let x = vf[off + k - 1] >= vf[off + k + 1]
				? vf[off + k - 1] + 1
				: vf[off + k + 1];
			let y = x - k;
			while (x < aHi && y < bHi && a[x] === b[y]) {
				x++;
				y++;
			}
			vf[off + k] = x;
			if (odd && k >= rLo && k <= rHi && vb[off + k] <= x) return [x, y];
		}
		if (rLo > kMin) vb[off + --rLo - 1] = UNREACHED_HIGH;
		else rLo++;
		if (rHi < kMax) vb[off + ++rHi + 1] = UNREACHED_HIGH;
		else rHi--;
		for (let k = rHi; k >= rLo; k -= 2) {
			let x = vb[off + k - 1] < vb[off + k + 1]
				? vb[off + k - 1]
				: vb[off + k + 1] - 1;
			let y = x - k;
			while (x > aLo && y > bLo && a[x - 1] === b[y - 1]) {
				x--;
				y--;
			}
			vb[off + k] = x;
			if (!odd && k >= fLo && k <= fHi && x <= vf[off + k]) return [x, y];
		}
		if (d >= s.costLimit) {
			// Too expensive to finish: take whichever search got furthest.
			let best: readonly [number, number] = [aLo, bLo];
			let progress = -1;
			for (let k = fHi; k >= fLo; k -= 2) {
				const x = Math.min(vf[off + k], aHi);
				const y = x - k;
				if (y >= bLo && y <= bHi && x + y - aLo - bLo > progress) {
					progress = x + y - aLo - bLo;
					best = [x, y];
				}
			}
			for (let k = rHi; k >= rLo; k -= 2) {
				const x = Math.max(vb[off + k], aLo);
				const y = x - k;
				if (y >= bLo && y <= bHi && aHi + bHi - x - y > progress) {
					progress = aHi + bHi - x - y;
					best = [x, y];
				}
			}
			return best;
		}
	}
};

/**
 * Marks the lines of `a` that are deleted (`ca[i] = 1`) and of `b` that are
 * inserted (`cb[j] = 1`) on a shortest edit script (or a short one past the
 * cost limit).
 */
const markEdits = (
	a: Int32Array,
	b: Int32Array,
	ca: Uint8Array,
	cb: Uint8Array,
): void => {
	const off = b.length + 2;
	const size = a.length + b.length + 5;
	const search: Search = {
		a,
		b,
		vf: new Int32Array(size),
		vb: new Int32Array(size),
		off,
		costLimit: Math.max(MIN_COST_LIMIT, manyThreshold(a.length + b.length + 3)),
	};
	const work: Box[] = [[0, a.length, 0, b.length]];
	while (work.length > 0) {
		let [aLo, aHi, bLo, bHi] = work.pop()!;
		while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) {
			aLo++;
			bLo++;
		}
		while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) {
			aHi--;
			bHi--;
		}
		if (aLo === aHi) {
			cb.fill(1, bLo, bHi);
			continue;
		}
		if (bLo === bHi) {
			ca.fill(1, aLo, aHi);
			continue;
		}
		const [x, y] = meetingPoint(search, [aLo, aHi, bLo, bHi]);
		const stuck = (x === aLo && y === bLo) || (x === aHi && y === bHi);
		if (stuck) {
			// Cannot happen on a shortest path; stay correct regardless.
			ca.fill(1, aLo, aHi);
			cb.fill(1, bLo, bHi);
			continue;
		}
		work.push([x, aHi, y, bHi], [aLo, x, bLo, y]);
	}
};

/**
 * For each count `c` of unchanged lines, whether `flags` has a run of
 * changed lines right after the `c`-th unchanged line (index c).
 */
const runsByUnchangedCount = (flags: Uint8Array): Uint8Array => {
	let unchanged = 0;
	for (const f of flags) if (!f) unchanged++;
	const out = new Uint8Array(unchanged + 1);
	let count = 0;
	for (const f of flags) {
		if (f) out[count] = 1;
		else count++;
	}
	return out;
};

/** Slides the change runs of one side (see the file comment). */
const slideRuns = (
	lines: Int32Array,
	flags: Uint8Array,
	other: Uint8Array,
): void => {
	const n = lines.length;
	const opposite = runsByUnchangedCount(other);
	let start = 0;
	let count = 0;
	const up = (s: number, e: number): [number, number] => {
		flags[--s] = 1;
		flags[--e] = 0;
		while (s > 0 && flags[s - 1]) s--;
		count--;
		return [s, e];
	};
	while (start < n) {
		if (!flags[start]) {
			start++;
			count++;
			continue;
		}
		let end = start;
		while (end < n && flags[end]) end++;
		let size: number;
		let topEnd: number;
		let alignedEnd: number;
		do {
			size = end - start;
			while (start > 0 && lines[start - 1] === lines[end - 1]) {
				[start, end] = up(start, end);
			}
			topEnd = end;
			alignedEnd = opposite[count] ? end : -1;
			while (end < n && lines[start] === lines[end]) {
				flags[start++] = 0;
				flags[end++] = 1;
				while (end < n && flags[end]) end++;
				count++;
				if (opposite[count]) alignedEnd = end;
			}
		} while (size !== end - start);
		if (end !== topEnd && alignedEnd !== -1) {
			while (
				!opposite[count] && start > 0 && lines[start - 1] === lines[end - 1]
			) {
				[start, end] = up(start, end);
			}
		}
		start = end;
	}
};

/** Walks both change maps in step and emits the changes, in order. */
const collect = (ca: Uint8Array, cb: Uint8Array): Change[] => {
	const changes: Change[] = [];
	let i = 0;
	let j = 0;
	while (i < ca.length || j < cb.length) {
		if ((i < ca.length && ca[i]) || (j < cb.length && cb[j])) {
			const aStart = i;
			const bStart = j;
			while (i < ca.length && ca[i]) i++;
			while (j < cb.length && cb[j]) j++;
			changes.push({ aStart, aLen: i - aStart, bStart, bLen: j - bStart });
		} else {
			i++;
			j++;
		}
	}
	return changes;
};

// ---------------------------------------------------------------------------
// Pre-filtering (the "discard lines that cannot match" step of classic diff
// implementations): inside the region left after trimming the common prefix
// and suffix, a line with no equal line on the other side is a change
// outright, and a line with very many equals on the other side is dropped
// from the search when it sits inside a run of such unmatched lines. This
// speeds the search up and steers ties towards the alignment git picks.
// ---------------------------------------------------------------------------

const NO_MATCH = 0;
const MATCH = 1;
const MANY = 2;
/** How far the run scan looks around a many-match line. */
const SCAN_WINDOW = 100;
/** A many-match line goes when such lines are under 1/RUN_RATIO of its run. */
const RUN_RATIO = 4;
const MANY_CAP = 1024;

/** A cheap power-of-two square-root estimate: the many-match threshold. */
const manyThreshold = (n: number): number => {
	let estimate = 1;
	for (let rest = n; rest > 0; rest = Math.floor(rest / 4)) estimate *= 2;
	return Math.min(estimate, MANY_CAP);
};

const occurrences = (seq: Int32Array): Map<number, number> => {
	const counts = new Map<number, number>();
	for (const id of seq) counts.set(id, (counts.get(id) ?? 0) + 1);
	return counts;
};

/** Whether the many-match line at `i` is dropped (see above). */
const dropMany = (
	kind: Uint8Array,
	i: number,
	lo: number,
	hi: number,
): boolean => {
	const from = Math.max(lo, i - SCAN_WINDOW);
	const to = Math.min(hi, i + SCAN_WINDOW);
	let unmatched = 0;
	let many = 2; // the line itself, counted once per direction
	let before = 0;
	for (let j = i - 1; j >= from && kind[j] !== MATCH; j--) {
		if (kind[j] === NO_MATCH) before++;
		else many++;
	}
	if (before === 0) return false;
	let after = 0;
	for (let j = i + 1; j <= to && kind[j] !== MATCH; j++) {
		if (kind[j] === NO_MATCH) after++;
		else many++;
	}
	if (after === 0) return false;
	unmatched = before + after;
	return many * RUN_RATIO < many + unmatched;
};

/**
 * Classifies `seq[lo, hi)` against the other side's line counts, marks the
 * dropped lines as changed and returns the indexes of the kept lines.
 */
const keptLines = (
	seq: Int32Array,
	lo: number,
	hi: number,
	other: Map<number, number>,
	flags: Uint8Array,
): number[] => {
	const threshold = manyThreshold(seq.length);
	const kind = new Uint8Array(seq.length);
	for (let i = lo; i < hi; i++) {
		const n = other.get(seq[i]) ?? 0;
		kind[i] = n === 0 ? NO_MATCH : n >= threshold ? MANY : MATCH;
	}
	const kept: number[] = [];
	for (let i = lo; i < hi; i++) {
		const keep = kind[i] === MATCH ||
			(kind[i] === MANY && !dropMany(kind, i, lo, hi - 1));
		if (keep) kept.push(i);
		else flags[i] = 1;
	}
	return kept;
};

/** The changes turning `a` into `b`, with git-like hunk placement. */
export const diffSequences = (a: Int32Array, b: Int32Array): Change[] => {
	const ca = new Uint8Array(a.length);
	const cb = new Uint8Array(b.length);
	let lo = 0;
	while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
	let aHi = a.length;
	let bHi = b.length;
	while (aHi > lo && bHi > lo && a[aHi - 1] === b[bHi - 1]) {
		aHi--;
		bHi--;
	}
	const keptA = keptLines(a, lo, aHi, occurrences(b), ca);
	const keptB = keptLines(b, lo, bHi, occurrences(a), cb);
	const ra = Int32Array.from(keptA, (i) => a[i]);
	const rb = Int32Array.from(keptB, (j) => b[j]);
	const rca = new Uint8Array(ra.length);
	const rcb = new Uint8Array(rb.length);
	markEdits(ra, rb, rca, rcb);
	rca.forEach((f, k) => {
		if (f) ca[keptA[k]] = 1;
	});
	rcb.forEach((f, k) => {
		if (f) cb[keptB[k]] = 1;
	});
	slideRuns(a, ca, cb);
	slideRuns(b, cb, ca);
	return collect(ca, cb);
};
