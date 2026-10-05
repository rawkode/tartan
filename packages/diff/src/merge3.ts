// Three-way line merge with conflict regions, aiming at the result of
// `git merge-file` (default "merge" marker style, zealous refinement, and
// alphanumeric-aware coalescing):
//
// 1. Diff base→ours and base→theirs.
// 2. Walk both change lists in base order. A change that ends strictly
//    before the other side's next change starts is taken from its side; two
//    changes that overlap or touch conflict, unless both replace the same
//    base lines with the same text. Consecutive pieces that touch in ours or
//    theirs coordinates coalesce (a mix of sides becomes a conflict).
// 3. Each conflict is narrowed by diffing its ours text against its theirs
//    text: equal stretches leave the conflict, so one conflict can split
//    into several, and one whose sides are equal resolves to that text.
// 4. Two conflicts separated by at most three lines, or by lines with no
//    ASCII letter or digit, are joined into one.
//
// Our own implementation (MIT); no code is taken from any merge library.

import { decodeText, isBinary, splitLines } from "./lines.ts";
import type { Change } from "./myers.ts";
import { diffLines } from "./hunks.ts";

/**
 * A conflict, in each of the three texts, with git hunk numbering (1-based;
 * a side with no lines reports the line it follows). Same shape as the
 * contract's `ConflictRegion`.
 */
export type ConflictRegion = {
	readonly baseStart: number;
	readonly baseLines: number;
	readonly oursStart: number;
	readonly oursLines: number;
	readonly theirsStart: number;
	readonly theirsLines: number;
};

export type Merge3Labels = {
	readonly ours?: string;
	readonly theirs?: string;
};

export type Merge3Options = {
	readonly labels?: Merge3Labels;
	/** Conflict marker length (git's default 7). */
	readonly markerSize?: number;
};

export type Merge3Outcome = {
	readonly clean: boolean;
	readonly binary: boolean;
	/** Number of conflicts (`git merge-file`'s exit status, uncapped). */
	readonly conflicts: number;
	readonly regions: readonly ConflictRegion[];
	/** The merged text, with conflict markers when not clean ("" for binary conflicts). */
	readonly text: string;
};

type Kind = "ours" | "theirs" | "conflict" | "same";

/** 0-based ranges in base (b), ours (o) and theirs (t). */
type Piece = {
	kind: Kind;
	b: number;
	nb: number;
	o: number;
	no: number;
	t: number;
	nt: number;
};

const sameLines = (
	x: readonly string[],
	xi: number,
	y: readonly string[],
	yi: number,
	n: number,
): boolean => {
	for (let k = 0; k < n; k++) if (x[xi + k] !== y[yi + k]) return false;
	return true;
};

/** Appends `piece`, coalescing it into the last piece when they touch. */
const append = (pieces: Piece[], piece: Piece): void => {
	const last = pieces.at(-1);
	if (
		last &&
		(piece.o <= last.o + last.no || piece.t <= last.t + last.nt)
	) {
		if (last.kind !== piece.kind) last.kind = "conflict";
		last.nb = Math.max(last.b + last.nb, piece.b + piece.nb) - last.b;
		last.no = piece.o + piece.no - last.o;
		last.nt = piece.t + piece.nt - last.t;
		return;
	}
	pieces.push({ ...piece });
};

const end = (c: Change): number => c.aStart + c.aLen;

/** Step 2: the pieces of both change lists, in base order. */
const walk = (
	ours: readonly string[],
	theirs: readonly string[],
	baseLength: number,
	c1: readonly Change[],
	c2: readonly Change[],
): Piece[] => {
	const pieces: Piece[] = [];
	let p = 0;
	let q = 0;
	// Offset of a side relative to base at the base position of its next
	// change (or at the end of the file when none is left).
	const shiftOurs = (): number =>
		p < c1.length ? c1[p].bStart - c1[p].aStart : ours.length - baseLength;
	const shiftTheirs = (): number =>
		q < c2.length ? c2[q].bStart - c2[q].aStart : theirs.length - baseLength;
	while (p < c1.length || q < c2.length) {
		const x = c1[p];
		const y = c2[q];
		if (x && (!y || end(x) < y.aStart)) {
			append(pieces, {
				kind: "ours",
				b: x.aStart,
				nb: x.aLen,
				o: x.bStart,
				no: x.bLen,
				t: x.aStart + shiftTheirs(),
				nt: x.aLen,
			});
			p++;
			continue;
		}
		if (y && (!x || end(y) < x.aStart)) {
			append(pieces, {
				kind: "theirs",
				b: y.aStart,
				nb: y.aLen,
				o: y.aStart + shiftOurs(),
				no: y.aLen,
				t: y.bStart,
				nt: y.bLen,
			});
			q++;
			continue;
		}
		const identical = x.aStart === y.aStart && x.aLen === y.aLen &&
			x.bLen === y.bLen && sameLines(ours, x.bStart, theirs, y.bStart, x.bLen);
		if (!identical) {
			const lo = Math.min(x.aStart, y.aStart);
			const hi = Math.max(end(x), end(y));
			const o = x.bStart - (x.aStart - lo);
			const t = y.bStart - (y.aStart - lo);
			append(pieces, {
				kind: "conflict",
				b: lo,
				nb: hi - lo,
				o,
				no: x.bStart + x.bLen + (hi - end(x)) - o,
				t,
				nt: y.bStart + y.bLen + (hi - end(y)) - t,
			});
		}
		const ex = end(x);
		const ey = end(y);
		if (ex >= ey) q++;
		if (ey >= ex) p++;
	}
	return pieces;
};

/** Step 3: narrows each conflict to the lines where ours and theirs differ. */
const refine = (
	pieces: readonly Piece[],
	ours: readonly string[],
	theirs: readonly string[],
): Piece[] =>
	pieces.flatMap((piece): Piece[] => {
		if (piece.kind !== "conflict" || piece.no === 0 || piece.nt === 0) {
			return [piece];
		}
		const inner = diffLines(
			ours.slice(piece.o, piece.o + piece.no),
			theirs.slice(piece.t, piece.t + piece.nt),
		);
		if (inner.length === 0) return [{ ...piece, kind: "same" }];
		return inner.map((c) => ({
			kind: "conflict",
			b: piece.b,
			nb: piece.nb,
			o: piece.o + c.aStart,
			no: c.aLen,
			t: piece.t + c.bStart,
			nt: c.bLen,
		}));
	});

const ALNUM = /[A-Za-z0-9]/;

/** Step 4: joins conflicts separated by few or letter-free lines. */
const coalesce = (pieces: Piece[], ours: readonly string[]): Piece[] => {
	const out = pieces.map((p) => ({ ...p }));
	let i = 0;
	while (i + 1 < out.length) {
		const cur = out[i];
		const next = out[i + 1];
		const from = cur.o + cur.no;
		const gap = next.o - from;
		const join = cur.kind === "conflict" && next.kind === "conflict" &&
			(gap <= 3 ||
				!ours.slice(from, next.o).some((line) => ALNUM.test(line)));
		if (!join) {
			i++;
			continue;
		}
		const baseEnd = Math.max(cur.b + cur.nb, next.b + next.nb);
		cur.b = Math.min(cur.b, next.b);
		cur.nb = baseEnd - cur.b;
		cur.no = next.o + next.no - cur.o;
		cur.nt = next.t + next.nt - cur.t;
		out.splice(i + 1, 1);
	}
	return out;
};

const withEol = (lines: readonly string[]): string =>
	lines.map((l, i) =>
		i === lines.length - 1 && !l.endsWith("\n") ? `${l}\n` : l
	)
		.join("");

const marker = (char: string, size: number, label?: string): string =>
	`${char.repeat(size)}${label ? ` ${label}` : ""}\n`;

const start1 = (start: number, len: number): number =>
	len === 0 ? start : start + 1;

const toRegion = (p: Piece): ConflictRegion => ({
	baseStart: start1(p.b, p.nb),
	baseLines: p.nb,
	oursStart: start1(p.o, p.no),
	oursLines: p.no,
	theirsStart: start1(p.t, p.nt),
	theirsLines: p.nt,
});

/** Merges three line arrays (each line with its terminator). */
export const merge3Lines = (
	base: readonly string[],
	ours: readonly string[],
	theirs: readonly string[],
	options: Merge3Options = {},
): Merge3Outcome => {
	const c1 = diffLines(base, ours);
	const c2 = diffLines(base, theirs);
	if (c1.length === 0 || c2.length === 0) {
		return {
			clean: true,
			binary: false,
			conflicts: 0,
			regions: [],
			text: (c1.length === 0 ? theirs : ours).join(""),
		};
	}
	const pieces = coalesce(
		refine(walk(ours, theirs, base.length, c1, c2), ours, theirs),
		ours,
	);
	const size = options.markerSize ?? 7;
	const labels = options.labels ?? { ours: "ours", theirs: "theirs" };
	let text = "";
	let at = 0;
	const conflicts: Piece[] = [];
	for (const piece of pieces) {
		if (piece.kind === "same") continue;
		text += ours.slice(at, piece.o).join("");
		if (piece.kind === "conflict") {
			conflicts.push(piece);
			text += marker("<", size, labels.ours) +
				withEol(ours.slice(piece.o, piece.o + piece.no)) +
				marker("=", size) +
				withEol(theirs.slice(piece.t, piece.t + piece.nt)) +
				marker(">", size, labels.theirs);
		} else if (piece.kind === "ours") {
			text += ours.slice(piece.o, piece.o + piece.no).join("");
		} else {
			text += theirs.slice(piece.t, piece.t + piece.nt).join("");
		}
		at = piece.o + piece.no;
	}
	text += ours.slice(at).join("");
	return {
		clean: conflicts.length === 0,
		binary: false,
		conflicts: conflicts.length,
		regions: conflicts.map(toRegion),
		text,
	};
};

/** Merges three texts. */
export const merge3Text = (
	base: string,
	ours: string,
	theirs: string,
	options?: Merge3Options,
): Merge3Outcome =>
	merge3Lines(splitLines(base), splitLines(ours), splitLines(theirs), options);

const sameBytes = (x: Uint8Array, y: Uint8Array): boolean =>
	x.length === y.length && x.every((v, i) => v === y[i]);

/**
 * Merges three blobs (`base` null for an add/add). Binary content (a NUL in
 * the first 8000 bytes of any side) is not merged line by line: it is clean
 * only when one side kept the base or both sides are equal.
 */
export const merge3Bytes = (
	base: Uint8Array | null,
	ours: Uint8Array,
	theirs: Uint8Array,
	options?: Merge3Options,
): Merge3Outcome => {
	const baseBytes = base ?? new Uint8Array();
	if ([baseBytes, ours, theirs].some(isBinary)) {
		const clean = sameBytes(ours, theirs) || sameBytes(baseBytes, ours) ||
			sameBytes(baseBytes, theirs);
		return {
			clean,
			binary: true,
			conflicts: clean ? 0 : 1,
			regions: [],
			text: "",
		};
	}
	return merge3Text(
		decodeText(baseBytes),
		decodeText(ours),
		decodeText(theirs),
		options,
	);
};
