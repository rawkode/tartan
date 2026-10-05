// Hunks and unified patches over the line diff. Hunk numbers follow git's
// `-U0` convention: 1-based starts, and a side with no lines reports the
// line it follows (0 at the top of the file).

import { hasEol, internLines, splitLines } from "./lines.ts";
import { type Change, diffSequences } from "./myers.ts";

/** Same shape as the contract's `Hunk` (`@tartan/contract` git.ts). */
export type Hunk = {
	readonly oldStart: number;
	readonly oldLines: number;
	readonly newStart: number;
	readonly newLines: number;
};

/** The changes between two line arrays. */
export const diffLines = (
	oldLines: readonly string[],
	newLines: readonly string[],
): Change[] => {
	const [a, b] = internLines(oldLines, newLines);
	return diffSequences(a, b);
};

/** The changes between two texts. */
export const diffTexts = (oldText: string, newText: string): Change[] =>
	diffLines(splitLines(oldText), splitLines(newText));

const start1 = (start: number, len: number): number =>
	len === 0 ? start : start + 1;

/** A change as a zero-context hunk. */
export const changeToHunk = (change: Change): Hunk => ({
	oldStart: start1(change.aStart, change.aLen),
	oldLines: change.aLen,
	newStart: start1(change.bStart, change.bLen),
	newLines: change.bLen,
});

/** Zero-context hunks (`git diff -U0`) between two texts. */
export const lineHunks = (oldText: string, newText: string): Hunk[] =>
	diffTexts(oldText, newText).map(changeToHunk);

export type DiffStat = {
	readonly additions: number;
	readonly deletions: number;
};

export const diffStat = (changes: readonly Change[]): DiffStat => ({
	additions: changes.reduce((sum, c) => sum + c.bLen, 0),
	deletions: changes.reduce((sum, c) => sum + c.aLen, 0),
});

/** Lines added by the changes, 1-based in the new text, without terminators. */
export const addedLines = (
	newLines: readonly string[],
	changes: readonly Change[],
): { readonly line: number; readonly text: string }[] =>
	changes.flatMap((c) =>
		newLines.slice(c.bStart, c.bStart + c.bLen).map((text, i) => ({
			line: c.bStart + i + 1,
			text: text.endsWith("\n") ? text.slice(0, -1) : text,
		}))
	);

export type PatchOptions = {
	/** Context lines around each change (git's default 3). */
	readonly context?: number;
	readonly oldPath?: string;
	readonly newPath?: string;
};

const NO_EOL = "\\ No newline at end of file\n";

const patchLine = (prefix: string, line: string): string =>
	hasEol(line) ? `${prefix}${line}` : `${prefix}${line}\n${NO_EOL}`;

const rangeText = (start: number, len: number): string =>
	len === 1 ? `${start}` : `${start},${len}`;

/**
 * The hunks of a unified patch (`@@ … @@` headers and their lines, grouped
 * as `git diff -U<context>` does) for two line arrays and the changes
 * already computed between them; "" when there are none. No file headers:
 * RepoProbe writes its own git-style ones.
 */
export const patchHunks = (
	a: readonly string[],
	b: readonly string[],
	changes: readonly Change[],
	context = 3,
): string => {
	if (changes.length === 0) return "";
	const groups: Change[][] = [];
	for (const change of changes) {
		const last = groups.at(-1)?.at(-1);
		if (last && change.aStart - (last.aStart + last.aLen) <= 2 * context) {
			groups.at(-1)!.push(change);
		} else {
			groups.push([change]);
		}
	}
	let out = "";
	for (const group of groups) {
		const first = group[0];
		const last = group.at(-1)!;
		const aFrom = Math.max(0, first.aStart - context);
		const aTo = Math.min(a.length, last.aStart + last.aLen + context);
		const bFrom = first.bStart - (first.aStart - aFrom);
		const bTo = last.bStart + last.bLen + (aTo - (last.aStart + last.aLen));
		out += `@@ -${rangeText(start1(aFrom, aTo - aFrom), aTo - aFrom)} +${
			rangeText(start1(bFrom, bTo - bFrom), bTo - bFrom)
		} @@\n`;
		let i = aFrom;
		for (const change of group) {
			for (; i < change.aStart; i++) out += patchLine(" ", a[i]);
			for (let k = 0; k < change.aLen; k++) {
				out += patchLine("-", a[change.aStart + k]);
			}
			for (let k = 0; k < change.bLen; k++) {
				out += patchLine("+", b[change.bStart + k]);
			}
			i = change.aStart + change.aLen;
		}
		for (; i < aTo; i++) out += patchLine(" ", a[i]);
	}
	return out;
};

/**
 * A unified patch (`git diff -U<context>` body). With paths it starts with
 * `--- a/<old>` and `+++ b/<new>` headers; identical texts give "".
 */
export const unifiedPatch = (
	oldText: string,
	newText: string,
	options: PatchOptions = {},
): string => {
	const a = splitLines(oldText);
	const b = splitLines(newText);
	const hunks = patchHunks(a, b, diffLines(a, b), options.context ?? 3);
	if (hunks === "") return "";
	const headers = options.oldPath !== undefined || options.newPath !== undefined
		? `--- a/${options.oldPath ?? options.newPath}\n+++ b/${
			options.newPath ?? options.oldPath
		}\n`
		: "";
	return headers + hunks;
};
