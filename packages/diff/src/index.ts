// @tartan/diff (WP8): Myers line diff, git-like hunks, unified patches and a
// three-way merge with conflict regions. Pure functions; no I/O. RepoProbe
// (src/kernel/probe) feeds it blobs read by SHA.

export {
	BINARY_SNIFF_BYTES,
	decodeText,
	hasEol,
	internLines,
	isBinary,
	splitLines,
} from "./lines.ts";
export { type Change, diffSequences } from "./myers.ts";
export {
	addedLines,
	changeToHunk,
	diffLines,
	type DiffStat,
	diffStat,
	diffTexts,
	type Hunk,
	lineHunks,
	patchHunks,
	type PatchOptions,
	unifiedPatch,
} from "./hunks.ts";
export {
	type ConflictRegion,
	merge3Bytes,
	type Merge3Labels,
	merge3Lines,
	type Merge3Options,
	type Merge3Outcome,
	merge3Text,
} from "./merge3.ts";
export { ADJACENT_LINES, adjacentHunks, overlapHunks } from "./overlap.ts";
