// @tartan/diff unit tests: edit-script correctness and minimality against a
// dynamic-programming LCS on random inputs, hunk numbering, unified patches,
// merge3 edge cases (binary, add/add, identical changes, missing EOL) and
// the overlap/adjacency primitives.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	addedLines,
	adjacentHunks,
	diffLines,
	diffStat,
	diffTexts,
	isBinary,
	lineHunks,
	merge3Bytes,
	merge3Text,
	overlapHunks,
	splitLines,
	unifiedPatch,
} from "../src/index.ts";

const prng = (seed: number) => {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

const lcsLength = (a: readonly string[], b: readonly string[]): number => {
	const row = new Array<number>(b.length + 1).fill(0);
	for (let i = 1; i <= a.length; i++) {
		let diag = 0;
		for (let j = 1; j <= b.length; j++) {
			const up = row[j];
			row[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(row[j], row[j - 1]);
			diag = up;
		}
	}
	return row[b.length];
};

/** Applies the changes to `a`, taking inserted lines from `b`. */
const apply = (
	a: readonly string[],
	b: readonly string[],
	changes: ReturnType<typeof diffLines>,
): string[] => {
	const out: string[] = [];
	let i = 0;
	for (const c of changes) {
		out.push(...a.slice(i, c.aStart), ...b.slice(c.bStart, c.bStart + c.bLen));
		i = c.aStart + c.aLen;
	}
	return [...out, ...a.slice(i)];
};

Deno.test("diffLines: rebuilds the new side and is minimal (vs DP LCS) on 500 random pairs", () => {
	const rng = prng(42);
	const alphabet = ["a\n", "b\n", "c\n", "d\n", "}\n", "\n"];
	const gen = () =>
		Array.from(
			{ length: Math.floor(rng() * 30) },
			() => alphabet[Math.floor(rng() * alphabet.length)],
		);
	for (let n = 0; n < 500; n++) {
		const a = gen();
		const b = gen();
		const changes = diffLines(a, b);
		deepStrictEqual(apply(a, b, changes), b);
		const { additions, deletions } = diffStat(changes);
		const lcs = lcsLength(a, b);
		equal(deletions, a.length - lcs, `case ${n}: not minimal`);
		equal(additions, b.length - lcs);
		for (let k = 1; k < changes.length; k++) {
			const prev = changes[k - 1];
			ok(changes[k].aStart > prev.aStart + prev.aLen, "changes never touch");
		}
	}
});

Deno.test("diffLines: big files with a few edits are fast; disjoint big files stay bounded", () => {
	const base = Array.from({ length: 20_000 }, (_, i) => `line ${i}\n`);
	const edited = [...base];
	edited.splice(100, 1, "changed\n");
	edited.splice(15_000, 0, "added\n");
	let t = performance.now();
	const changes = diffLines(base, edited);
	ok(performance.now() - t < 1000);
	equal(changes.length, 2);
	const other = Array.from({ length: 5_000 }, (_, i) => `other ${i}\n`);
	const mixed = base.slice(0, 5_000).map((l, i) => i % 3 === 0 ? l : other[i]);
	t = performance.now();
	const big = diffLines(base.slice(0, 5_000), mixed);
	ok(performance.now() - t < 3000);
	deepStrictEqual(apply(base.slice(0, 5_000), mixed, big), mixed);
});

Deno.test("lineHunks: git -U0 numbering for insert, delete and modify", () => {
	deepStrictEqual(lineHunks("a\nb\nc\n", "a\nx\nb\nc\n"), [
		{ oldStart: 1, oldLines: 0, newStart: 2, newLines: 1 },
	]);
	deepStrictEqual(lineHunks("a\nb\nc\n", "a\nc\n"), [
		{ oldStart: 2, oldLines: 1, newStart: 1, newLines: 0 },
	]);
	deepStrictEqual(lineHunks("a\nb\nc\n", "a\nB\nc\n"), [
		{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 },
	]);
	deepStrictEqual(lineHunks("", "a\n"), [
		{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1 },
	]);
	deepStrictEqual(lineHunks("a\n", "a"), [
		{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 },
	]);
});

Deno.test("unifiedPatch: headers, context, merged groups and no-EOL marker", () => {
	const old = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n";
	const neu = "1\n2\nthree\n4\n5\n6\n7\n8\n9\nten";
	equal(
		unifiedPatch(old, neu, { oldPath: "f.txt" }),
		"--- a/f.txt\n+++ b/f.txt\n" +
			"@@ -1,10 +1,10 @@\n 1\n 2\n-3\n+three\n 4\n 5\n 6\n 7\n 8\n 9\n-10\n+ten\n" +
			"\\ No newline at end of file\n",
	);
	equal(
		unifiedPatch(old, neu, { context: 1 }),
		"@@ -2,3 +2,3 @@\n 2\n-3\n+three\n 4\n@@ -9,2 +9,2 @@\n 9\n-10\n+ten\n" +
			"\\ No newline at end of file\n",
	);
	equal(unifiedPatch(old, old), "");
});

Deno.test("addedLines and diffStat", () => {
	const neu = splitLines("a\nnew1\nb\nnew2");
	const changes = diffTexts("a\nb\n", "a\nnew1\nb\nnew2");
	deepStrictEqual(addedLines(neu, changes), [
		{ line: 2, text: "new1" },
		{ line: 4, text: "new2" },
	]);
	deepStrictEqual(diffStat(changes), { additions: 2, deletions: 0 });
});

Deno.test("merge3: clean disjoint edits, identical edits, conflicts with regions", () => {
	const base = "a\nb\nc\nd\ne\nf\ng\nh\n";
	const clean = merge3Text(
		base,
		"A\nb\nc\nd\ne\nf\ng\nh\n",
		"a\nb\nc\nd\ne\nf\ng\nH\n",
	);
	ok(clean.clean);
	equal(clean.text, "A\nb\nc\nd\ne\nf\ng\nH\n");
	const same = merge3Text(
		base,
		"a\nB\nc\nd\ne\nf\ng\nh\n",
		"a\nB\nc\nd\ne\nf\ng\nh\n",
	);
	ok(same.clean);
	equal(same.text, "a\nB\nc\nd\ne\nf\ng\nh\n");
	const conflict = merge3Text(
		base,
		"a\nb\nOURS\nd\ne\nf\ng\nh\n",
		"a\nb\nTHEIRS\nd\ne\nf\ng\nh\n",
		{
			labels: { ours: "ln_a", theirs: "ln_b" },
		},
	);
	equal(conflict.conflicts, 1);
	deepStrictEqual(conflict.regions, [{
		baseStart: 3,
		baseLines: 1,
		oursStart: 3,
		oursLines: 1,
		theirsStart: 3,
		theirsLines: 1,
	}]);
	equal(
		conflict.text,
		"a\nb\n<<<<<<< ln_a\nOURS\n=======\nTHEIRS\n>>>>>>> ln_b\nd\ne\nf\ng\nh\n",
	);
});

Deno.test("merge3: adjacent edits conflict (git semantics); a missing EOL gets one inside markers", () => {
	const adjacent = merge3Text("a\nb\nc\n", "A\nb\nc\n", "a\nB\nc\n");
	equal(adjacent.conflicts, 1);
	const noEol = merge3Text("a\nb", "a\nX", "a\nY");
	equal(noEol.text, "a\n<<<<<<< ours\nX\n=======\nY\n>>>>>>> theirs\n");
});

Deno.test("merge3Bytes: add/add, binary detection and trivial binary merges", () => {
	const enc = (s: string) => new TextEncoder().encode(s);
	const addAdd = merge3Bytes(null, enc("x\n"), enc("y\n"));
	equal(addAdd.conflicts, 1);
	const bin = new Uint8Array([0x89, 0x50, 0x00, 0x01]);
	const bin2 = new Uint8Array([0x89, 0x50, 0x00, 0x02]);
	ok(isBinary(bin));
	const conflicted = merge3Bytes(bin, bin2, new Uint8Array([7, 0, 7]));
	deepStrictEqual(
		{ clean: conflicted.clean, binary: conflicted.binary },
		{ clean: false, binary: true },
	);
	const oneSide = merge3Bytes(bin, bin2, bin);
	deepStrictEqual({ clean: oneSide.clean, binary: oneSide.binary }, {
		clean: true,
		binary: true,
	});
});

Deno.test("overlapHunks / adjacentHunks: same lines, within three lines, far apart", () => {
	const a = lineHunks(
		"1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n",
		"1\nX\n3\n4\n5\n6\n7\n8\n9\n10\n",
	);
	const sameLine = lineHunks(
		"1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n",
		"1\nY\n3\n4\n5\n6\n7\n8\n9\n10\n",
	);
	const near = lineHunks(
		"1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n",
		"1\n2\n3\n4\nZ\n6\n7\n8\n9\n10\n",
	);
	const far = lineHunks(
		"1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n",
		"1\n2\n3\n4\n5\n6\n7\n8\n9\nW\n",
	);
	deepStrictEqual(overlapHunks(a, sameLine), [[0, 0]]);
	deepStrictEqual(overlapHunks(a, near), []);
	deepStrictEqual(adjacentHunks(a, near), [[0, 0]]);
	deepStrictEqual(adjacentHunks(a, far), []);
	const insertA = lineHunks("1\n2\n", "1\nI\n2\n");
	const insertB = lineHunks("1\n2\n", "1\nJ\n2\n");
	deepStrictEqual(overlapHunks(insertA, insertB), [[0, 0]]);
});
