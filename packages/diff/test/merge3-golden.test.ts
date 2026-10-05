// `merge3` agrees with `git merge-file` on 200
// generated cases. The fixture (test/fixtures/merge3-golden.json) was
// produced offline by scripts/gen-merge3-golden.ts with real git; agreement
// means the same conflict count (git's exit status) and byte-identical
// merged output, conflict markers included. The same fixture carries the
// `git diff -U0` hunk headers of each side, which `lineHunks` must equal.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { type Hunk, lineHunks, merge3Text } from "../src/index.ts";

type GoldenCase = {
	readonly id: number;
	readonly base: string;
	readonly ours: string;
	readonly theirs: string;
	readonly exit: number;
	readonly output: string;
	readonly oursHunks: readonly Hunk[];
	readonly theirsHunks: readonly Hunk[];
};

const fixture = JSON.parse(
	await Deno.readTextFile(
		new URL("./fixtures/merge3-golden.json", import.meta.url),
	),
) as { readonly cases: readonly GoldenCase[] };

Deno.test("merge3 golden: the fixture holds 200 cases, clean and conflicted", () => {
	equal(fixture.cases.length, 200);
	ok(fixture.cases.some((c) => c.exit === 0));
	ok(fixture.cases.some((c) => c.exit > 1));
});

Deno.test("merge3 golden: agrees with git merge-file on every case", () => {
	const mismatches = fixture.cases.flatMap((c) => {
		const result = merge3Text(c.base, c.ours, c.theirs);
		const agrees = result.conflicts === c.exit &&
			result.clean === (c.exit === 0) &&
			result.text === c.output &&
			result.regions.length === c.exit;
		return agrees ? [] : [c.id];
	});
	deepStrictEqual(mismatches, []);
});

Deno.test("hunk golden: lineHunks equals git diff -U0 for both sides of every case", () => {
	const mismatches = fixture.cases.flatMap((c) => {
		const oursOk = JSON.stringify(lineHunks(c.base, c.ours)) ===
			JSON.stringify(c.oursHunks);
		const theirsOk = JSON.stringify(lineHunks(c.base, c.theirs)) ===
			JSON.stringify(c.theirsHunks);
		return oursOk && theirsOk ? [] : [c.id];
	});
	deepStrictEqual(mismatches, []);
});
