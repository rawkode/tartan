// RepoProbe against the offline git fixture (test/fixtures/histories.json):
// the K17 cases, the lane range cases and the lane repo cases. Every
// expectation was produced by real git when the fixture was generated
// (`git merge-base`, `git diff --name-status --find-renames=100% main...`,
// `git diff -U0`, `git merge-file`).

import {
	deepStrictEqual,
	equal,
	notEqual,
	ok,
	rejects,
} from "node:assert/strict";
import { fromRpcError, type Hunk, type PushDiff } from "@tartan/contract";
import { adjacentHunks, merge3Bytes, overlapHunks } from "@tartan/diff";
import { createTokenBucket } from "./bucket.ts";
import { createObjectCache } from "./cache.ts";
import { createRepoProbe } from "./probe.ts";
import {
	blobBytes,
	createHarness,
	type Fixture,
	loadFixture,
} from "./test/fixture-store.ts";

const fixture: Fixture = loadFixture(
	await Deno.readTextFile(
		new URL("./test/fixtures/histories.json", import.meta.url),
	),
);
const REPO = "01k6aaaaaaaaaaaaaaaaaaaaaa";
const OTHER_REPO = "01k6bbbbbbbbbbbbbbbbbbbbbb";
const LANE_X = "ln_01k6cccccccccccccccccccccc";
const LANE_Y = "ln_01k6dddddddddddddddddddddd";
const CANONICAL = `r-${REPO}`;
const [T0, T1, T2, T3, T4] = fixture.trunk;
const head = (lane: string) => fixture.refs[lane];
const allHeads = Object.values(fixture.refs);

const STATUS: Record<string, string> = {
	A: "added",
	M: "modified",
	D: "deleted",
	R100: "renamed",
	T: "type",
};

/** `git diff --name-status` rows as `[change, path, oldPath?]`. */
const gitChanges = (lane: string) =>
	fixture.lanes[lane].nameStatus!.map((row) =>
		row[0].startsWith("R")
			? [STATUS[row[0]], row[2], row[1]]
			: [STATUS[row[0]], row[1]]
	);

const canonicalHarness = () => {
	const h = createHarness(fixture);
	h.store.setRepo(CANONICAL, allHeads);
	return { ...h, probe: createRepoProbe(h.deps) };
};

const pushDiffOf = async (
	h: ReturnType<typeof canonicalHarness>,
	key: string,
): Promise<PushDiff> => JSON.parse(await (await h.diffs.get(key))!.text());

// ---------------------------------------------------------------------------
// K17 on branch lanes in the canonical repo
// ---------------------------------------------------------------------------

const K17_LANES = [
	"at-base",
	"merged-trunk",
	"rebased",
	"stack-b",
	"forged-dates",
];

Deno.test("K17: rangeBase equals git merge-base for every lane range history", async () => {
	for (const lane of K17_LANES) {
		const h = canonicalHarness();
		const result = await h.probe.laneDiff(
			{ repoId: REPO, laneId: LANE_X },
			head(lane),
		);
		equal(result.rangeBase, fixture.lanes[lane].mergeBase, lane);
		equal(result.rangeTruncated, false, lane);
		equal(
			result.diffKey,
			`diffs/${REPO}/${result.rangeBase}..${head(lane)}.json`,
		);
	}
});

Deno.test("K17: the range diff equals git diff main...head (paths, kinds, -U0 hunks)", async () => {
	for (
		const lane of Object.keys(fixture.lanes).filter((l) =>
			fixture.lanes[l].mergeBase
		)
	) {
		const h = canonicalHarness();
		const result = await h.probe.laneDiff(
			{ repoId: REPO, laneId: LANE_X },
			head(lane),
		);
		const diff = await pushDiffOf(h, result.diffKey);
		deepStrictEqual(
			diff.files.map((f) =>
				f.oldPath ? [f.change, f.path, f.oldPath] : [f.change, f.path]
			),
			gitChanges(lane),
			lane,
		);
		const gitHunks = fixture.lanes[lane].hunks!;
		for (const file of diff.files) {
			if (file.change === "renamed") continue; // git -U0 ran with --no-renames
			const expected = gitHunks[file.path];
			if (expected?.[0] === "binary") ok(file.binary, `${lane} ${file.path}`);
			else deepStrictEqual(file.hunks, expected, `${lane} ${file.path}`);
		}
		equal(diff.rangeBase, fixture.lanes[lane].mergeBase);
		equal(diff.target, LANE_X);
	}
});

Deno.test("K17: a create never diffs against the empty tree; a rebase drops landed paths", async () => {
	const h = canonicalHarness();
	// at-base's first push is a ref create (before = zeros): still T2..head.
	const created = await h.probe.laneDiff(
		{ repoId: REPO, laneId: LANE_X },
		head("at-base"),
	);
	deepStrictEqual(created.paths, ["services/api/a.ts", "services/api/b.ts"]);
	// rebased onto T3: trunk's T2/T3 paths are not in the lane's range.
	const rebased = await h.probe.laneDiff(
		{ repoId: REPO, laneId: LANE_X },
		head("rebased"),
	);
	equal(rebased.rangeBase, T3);
	deepStrictEqual(rebased.paths, ["services/api/r.ts"]);
});

Deno.test("K17: a typical lane push walks one log page, one trunkSeqs batch", async () => {
	const h = canonicalHarness();
	await h.probe.laneDiff({ repoId: REPO, laneId: LANE_X }, head("at-base"));
	equal(h.store.calls.filter((c) => c.op === "log").length, 1);
	equal(h.state.trunkSeqCalls, 1);
});

Deno.test("K17: merges walk each parent chain; commits carry subjects and trailers", async () => {
	const h = canonicalHarness();
	const merged = await h.probe.laneDiff(
		{ repoId: REPO, laneId: LANE_X },
		head("merged-trunk"),
	);
	equal(merged.rangeBase, T3);
	ok(h.store.calls.filter((c) => c.op === "log").length >= 2);
	deepStrictEqual(merged.commits.map((c) => c.subject), [
		"api: add c",
		"merge trunk",
		"api: two more",
	]);
	const h2 = canonicalHarness();
	const atBase = await h2.probe.laneDiff(
		{ repoId: REPO, laneId: LANE_X },
		head("at-base"),
	);
	deepStrictEqual(atBase.commits[0].trailers, [
		{ key: "Co-Authored-By", value: "agent <a@x>" },
	]);
});

Deno.test("K17: a root outside trunk falls back to lanes.base_sha, or the trunk tip off-lane", async () => {
	const h = canonicalHarness();
	h.state.laneBases.set(LANE_X, T2);
	const lane = await h.probe.laneDiff(
		{ repoId: REPO, laneId: LANE_X },
		head("orphan"),
	);
	deepStrictEqual([lane.rangeBase, lane.rangeTruncated], [T2, true]);
	const branch = await h.probe.laneDiff({ repoId: REPO }, head("orphan"));
	deepStrictEqual([branch.rangeBase, branch.rangeTruncated], [T4, true]);
	// An unknown lane has no base to fall back to.
	await rejects(
		h.probe.laneDiff({ repoId: REPO, laneId: LANE_Y }, head("orphan")),
		(e) => fromRpcError(e).code === "not_found",
	);
});

Deno.test("K17: phase 2 is idempotent per (rangeBase, after): the stored diff is reused", async () => {
	const h = canonicalHarness();
	const first = await h.probe.laneDiff(
		{ repoId: REPO, laneId: LANE_X },
		head("at-base"),
	);
	const trees = h.store.calls.filter((c) => c.op === "readTree").length;
	const second = await h.probe.laneDiff(
		{ repoId: REPO, laneId: LANE_X },
		head("at-base"),
	);
	deepStrictEqual(second, first);
	equal(h.store.calls.filter((c) => c.op === "readTree").length, trees);
	deepStrictEqual(h.diffs.keys(), [first.diffKey]);
});

Deno.test("laneDiff with addedLines stores the added lines of the range", async () => {
	const h = canonicalHarness();
	const result = await h.probe.laneDiff(
		{ repoId: REPO, laneId: LANE_X },
		head("at-base"),
		{ addedLines: true },
	);
	const diff = await pushDiffOf(h, result.diffKey);
	deepStrictEqual(diff.addedLines, [
		{ path: "services/api/a.ts", line: 6, text: "api-a line 6" },
		{ path: "services/api/b.ts", line: 1, text: "b" },
	]);
});

Deno.test("K15: reads take SHAs; a non-sha `after` is refused before any read", async () => {
	const h = canonicalHarness();
	await rejects(
		h.probe.laneDiff({ repoId: REPO, laneId: LANE_X }, "refs/heads/lanes/x"),
		(e) => fromRpcError(e).code === "invalid",
	);
	equal(h.store.calls.length, 0);
	// The binding cannot resolve a lane ref, but both sides as SHAs work.
	const handle = await h.store.get(CANONICAL);
	deepStrictEqual(await handle.log({ ref: `refs/heads/lanes/${LANE_X}` }), []);
	const paths = await h.probe.diffPaths(
		{ repoId: REPO, laneId: LANE_X },
		T4,
		head("at-base"),
	);
	ok(paths.paths.some((p) => p.path === "services/api/b.ts"));
	// A ref name is resolved through RepoDO, never the binding.
	const viaRef = await h.probe.diffPaths(
		{ repoId: REPO },
		"main",
		head("at-base"),
	);
	deepStrictEqual(viaRef, paths);
	ok(!h.store.calls.some((c) => c.arg === "main"));
});

// ---------------------------------------------------------------------------
// `repo` lanes read their own lane repo
// ---------------------------------------------------------------------------

Deno.test("repo lanes: a repo lane's walk and diff read only its lane repo and equal git diff", async () => {
	const h = createHarness(fixture);
	h.store.setRepo(CANONICAL, [T4]);
	h.store.setRepo("l-x", [head("at-base")]); // seeded at T2 plus two lane commits
	h.state.laneRepos.set(LANE_X, "l-x");
	const probe = createRepoProbe(h.deps);
	const result = await probe.laneDiff(
		{ repoId: REPO, laneId: LANE_X },
		head("at-base"),
	);
	equal(result.rangeBase, fixture.lanes["at-base"].mergeBase);
	deepStrictEqual(
		result.paths,
		gitChanges("at-base").map((r) => r[1]),
	);
	ok(h.store.calls.length > 0);
	deepStrictEqual(
		h.store.calls.filter((c) => c.repo !== "l-x"),
		[],
		"no canonical reads",
	);
	deepStrictEqual(h.state.upstreamCalls, [{ laneId: LANE_X }]);
});

Deno.test("repo lanes: after a rebase pushed into the lane repo, the range excludes landed paths", async () => {
	const h = createHarness(fixture);
	h.store.setRepo(CANONICAL, [T4]);
	h.store.setRepo("l-x", [head("rebased")]); // now holds T3 too
	h.state.laneRepos.set(LANE_X, "l-x");
	const probe = createRepoProbe(h.deps);
	const result = await probe.laneDiff(
		{ repoId: REPO, laneId: LANE_X },
		head("rebased"),
	);
	equal(result.rangeBase, T3);
	deepStrictEqual(result.paths, ["services/api/r.ts"]);
	ok(!result.paths.includes("apps/web/main.ts"));
	ok(h.store.calls.every((c) => c.repo === "l-x"));
});

Deno.test("repo lanes: diff-of-diffs between two lane repos reads each head from its own repo", async () => {
	const h = createHarness(fixture);
	h.store.setRepo("l-a", [head("same-line-a")]);
	h.store.setRepo("l-b", [head("same-line-b")]);
	h.state.laneRepos.set(LANE_X, "l-a");
	h.state.laneRepos.set(LANE_Y, "l-b");
	const probe = createRepoProbe(h.deps);
	const files = await probe.diff(
		{ repoId: REPO, laneId: LANE_X, sha: head("same-line-a") },
		{ repoId: REPO, laneId: LANE_Y, sha: head("same-line-b") },
	);
	deepStrictEqual(files.map((f) => [f.path, f.change, f.hunks]), [[
		"src/app.ts",
		"modified",
		[{ oldStart: 10, oldLines: 1, newStart: 10, newLines: 1 }],
	]]);
	deepStrictEqual(
		h.store.calls.filter((c) => c.op === "readCommit").map((
			c,
		) => [c.repo, c.arg]),
		[["l-a", head("same-line-a")], ["l-b", head("same-line-b")]],
	);
	ok(h.diffs.keys()[0].startsWith(`diffs/${REPO}/`));
	await rejects(
		probe.diff(
			{ repoId: REPO, sha: head("same-line-a") },
			{ repoId: OTHER_REPO, sha: head("same-line-b") },
		),
		(e) => fromRpcError(e).code === "invalid",
	);
});

Deno.test("diff with {patch: true}: git-style unified patches, cached apart from the plain answer", async () => {
	const h = canonicalHarness();
	const plain = await h.probe.diff(
		{ repoId: REPO, sha: T2 },
		{ repoId: REPO, sha: head("at-base") },
	);
	ok(plain.every((f) => f.patch === undefined && f.patchOmitted === undefined));
	const files = await h.probe.diff(
		{ repoId: REPO, sha: T2 },
		{ repoId: REPO, sha: head("at-base") },
		{ patch: true },
	);
	const byPath = new Map(files.map((f) => [f.path, f]));
	// An added file: git's header, /dev/null on the old side.
	equal(
		byPath.get("services/api/b.ts")?.patch,
		[
			"diff --git a/services/api/b.ts b/services/api/b.ts",
			"new file mode 100644",
			"--- /dev/null",
			"+++ b/services/api/b.ts",
			"@@ -0,0 +1 @@",
			"+b",
			"",
		].join("\n"),
	);
	// A modified file: the added line with up to 3 lines of context.
	const a = byPath.get("services/api/a.ts")!;
	ok(
		a.patch?.startsWith(
			"diff --git a/services/api/a.ts b/services/api/a.ts\n--- a/services/api/a.ts\n+++ b/services/api/a.ts\n@@ -3,3 +3,4 @@\n",
		),
		a.patch,
	);
	ok(a.patch?.endsWith("+api-a line 6\n"), a.patch);
	equal(a.patchOmitted, undefined);
	// Asked with and without patches: two cache entries, never mixed up.
	deepStrictEqual(
		h.diffs.keys().filter((k) => k.endsWith(".files.json")).length,
		1,
	);
	deepStrictEqual(
		h.diffs.keys().filter((k) => k.endsWith(".patch.json")).length,
		1,
	);
	const again = await h.probe.diff(
		{ repoId: REPO, sha: T2 },
		{ repoId: REPO, sha: head("at-base") },
	);
	ok(again.every((f) => f.patch === undefined));
});

/** Two one-commit histories over `files` (path → text), for the patch caps. */
const syntheticFixture = (
	before: Record<string, string>,
	after: Record<string, string>,
): { fixture: Fixture; a: string; b: string } => {
	let n = 0;
	const id = () => (++n).toString(16).padStart(40, "0");
	const commits: Record<string, unknown> = {};
	const trees: Record<string, unknown[]> = {};
	const blobs: Record<string, string> = {};
	const commitOf = (files: Record<string, string>, parents: string[]) => {
		const tree = id();
		trees[tree] = Object.entries(files).map(([name, text]) => {
			const hash = id();
			blobs[hash] = btoa(text);
			return { name, mode: "100644", hash, type: "blob" };
		});
		const hash = id();
		commits[hash] = {
			hash,
			treeHash: tree,
			message: "synthetic",
			author: { name: "T", email: "t@tartan.test" },
			committer: { name: "T", email: "t@tartan.test" },
			parents,
			authoredAt: 1,
			committedAt: 1,
		};
		return hash;
	};
	const a = commitOf(before, []);
	const b = commitOf(after, [a]);
	return {
		a,
		b,
		fixture: {
			trunk: [a, b],
			refs: {},
			lanes: {},
			pairs: [],
			objects: { commits, trees, blobs } as unknown as Fixture["objects"],
		},
	};
};

Deno.test("diff patches are capped per file (too-large) and per answer (budget), never silently", async () => {
	const lines = (prefix: string, count: number) =>
		Array.from({ length: count }, (_, i) => `${prefix} ${i}\n`).join("");
	// ~330 KiB of changed lines: over the 256 KiB per-file cap.
	const huge = lines("x".repeat(60), 5000);
	// ~185 KB each: five fit in the 1 MiB answer, the sixth does not.
	const big = (k: number) => lines(`${k}`.repeat(30), 5000);
	const before: Record<string, string> = { "huge.txt": "old\n" };
	const after: Record<string, string> = { "huge.txt": huge };
	for (let k = 1; k <= 6; k++) {
		before[`f${k}.txt`] = "old\n";
		after[`f${k}.txt`] = big(k);
	}
	before["small.txt"] = "a\n";
	after["small.txt"] = "b\n";
	const s = syntheticFixture(before, after);
	const h = createHarness(s.fixture);
	h.store.setRepo(CANONICAL, [s.b]);
	const probe = createRepoProbe(h.deps);
	const files = await probe.diff(
		{ repoId: REPO, sha: s.a },
		{ repoId: REPO, sha: s.b },
		{ patch: true },
	);
	const reason = Object.fromEntries(
		files.map((
			f,
		) => [f.path, f.patch !== undefined ? "patch" : f.patchOmitted]),
	);
	deepStrictEqual(reason, {
		"f1.txt": "patch",
		"f2.txt": "patch",
		"f3.txt": "patch",
		"f4.txt": "patch",
		"f5.txt": "patch",
		"f6.txt": "budget",
		"huge.txt": "too-large",
		// The budget is spent but a later small file still fits.
		"small.txt": "patch",
	});
	// Counts and hunks stay, whatever happened to the patch.
	const huge0 = files.find((f) => f.path === "huge.txt")!;
	deepStrictEqual([huge0.additions, huge0.deletions], [5000, 1]);
	const total = files.reduce(
		(sum, f) => sum + new TextEncoder().encode(f.patch ?? "").length,
		0,
	);
	ok(total <= 1024 * 1024, `${total}`);
});

Deno.test("a cached blob from l-x serves l-y of the same family, never another family", async () => {
	const cache = createObjectCache({ edge: null });
	const h = createHarness(fixture, { cache });
	h.store.setRepo("l-x", [head("same-line-a")]);
	h.store.setRepo("l-y", [head("same-line-a")]);
	h.state.laneRepos.set(LANE_X, "l-x");
	h.state.laneRepos.set(LANE_Y, "l-y");
	const probe = createRepoProbe(h.deps);
	const args = [T2, head("same-line-a"), ["src/app.ts"]] as const;
	const viaX = await probe.hunks({ repoId: REPO, laneId: LANE_X }, ...args);
	const viaY = await probe.hunks({ repoId: REPO, laneId: LANE_Y }, ...args);
	deepStrictEqual(viaY, viaX);
	deepStrictEqual(h.store.calls.filter((c) => c.repo === "l-y"), []);
	// Another repo family holding the very same objects misses the cache.
	const other = createHarness(fixture, { cache });
	other.store.setRepo(`r-${OTHER_REPO}`, [head("same-line-a")]);
	const otherProbe = createRepoProbe(other.deps);
	await otherProbe.hunks({ repoId: OTHER_REPO }, ...args);
	ok(other.store.calls.some((c) => c.op === "readBlob"));
});

// ---------------------------------------------------------------------------
// Radar scenarios: hunks and merge3 against git
// ---------------------------------------------------------------------------

Deno.test("scenarios: hunks of each lane equal git diff -U0 (same-line … different bases)", async () => {
	const h = canonicalHarness();
	for (const pair of fixture.pairs) {
		for (const lane of [pair.a, pair.b]) {
			const base = fixture.lanes[lane].mergeBase!;
			const paths = gitChanges(lane).flatMap((r) => r.slice(1)) as string[];
			const hunks = await h.probe.hunks(
				{ repoId: REPO },
				base,
				head(lane),
				paths,
			);
			for (const fh of hunks) {
				const expected = fixture.lanes[lane].hunks![fh.path];
				if (expected === undefined) continue; // the renamed path (git ran --no-renames)
				if (expected[0] === "binary") ok(fh.binary, `${lane} ${fh.path}`);
				else deepStrictEqual(fh.hunks, expected, `${lane} ${fh.path}`);
			}
		}
	}
});

Deno.test("scenarios: hunk geometry tells same-line, adjacent and disjoint apart", async () => {
	const h = canonicalHarness();
	const hunksOf = async (lane: string) =>
		(await h.probe.hunks({ repoId: REPO }, T2, head(lane), ["src/app.ts"]))[0]
			.hunks as Hunk[];
	const pairOf = async (name: string) => [
		await hunksOf(`${name}-a`),
		await hunksOf(`${name}-b`),
	];
	const [sa, sb] = await pairOf("same-line");
	deepStrictEqual(overlapHunks(sa, sb), [[0, 0]]);
	const [aa, ab] = await pairOf("adjacent");
	deepStrictEqual([overlapHunks(aa, ab), adjacentHunks(aa, ab)], [[], [[
		0,
		0,
	]]]);
	const [da, db] = await pairOf("same-file-disjoint");
	deepStrictEqual([overlapHunks(da, db), adjacentHunks(da, db)], [[], []]);
});

Deno.test("scenarios: merge3 agrees with git merge-file on every shared path", async () => {
	const h = canonicalHarness();
	for (const pair of fixture.pairs) {
		for (const file of pair.files) {
			if (!file.merge || !file.ours || !file.theirs) continue; // rename, delete-vs-modify
			const [result] = await h.probe.merge3([{
				repoId: REPO,
				path: file.path,
				base: file.base,
				ours: file.ours,
				theirs: file.theirs,
			}]);
			if (file.merge.exit === 255) {
				deepStrictEqual(
					[result.binary, result.clean],
					[true, false],
					pair.name,
				);
				continue;
			}
			equal(result.clean, file.merge.exit === 0, pair.name);
			equal(result.regions.length, file.merge.exit, pair.name);
			const text = merge3Bytes(
				file.base ? blobBytes(fixture, file.base) : null,
				blobBytes(fixture, file.ours),
				blobBytes(fixture, file.theirs),
			).text;
			equal(text, file.merge.output, pair.name);
		}
	}
});

Deno.test("budgets: > 40 merge3 inputs and an empty bucket degrade to path level", async () => {
	const h = canonicalHarness();
	const file = fixture.pairs.find((p) => p.name === "same-line")!.files[0];
	const input = {
		repoId: REPO,
		path: file.path,
		base: file.base,
		ours: file.ours!,
		theirs: file.theirs!,
	};
	const results = await h.probe.merge3(Array.from({ length: 41 }, () => input));
	equal(results.length, 41);
	deepStrictEqual(results[0].regions.length, 1);
	deepStrictEqual(results[40], {
		path: file.path,
		clean: false,
		binary: false,
		regions: [],
		pathLevel: true,
	});
	const drained = createHarness(fixture, { bucketRate: 0.001 });
	drained.store.setRepo(CANONICAL, allHeads);
	const bucket = createTokenBucket({ ratePerSecond: 1, burst: 50 });
	const probe = createRepoProbe({ ...drained.deps, bucket });
	// The bucket holds enough for the trees and commits, not for the blobs.
	while (bucket.available() > 6) bucket.tryTake();
	const hunks = await probe.hunks({ repoId: REPO }, T2, head("same-line-a"), [
		"src/app.ts",
	]);
	deepStrictEqual(hunks, [{
		path: "src/app.ts",
		binary: false,
		hunks: [],
		pathLevel: true,
	}]);
	deepStrictEqual(drained.store.calls.filter((c) => c.op === "readBlob"), []);
});

Deno.test("merge3: a blob only a lane repo holds is path-level unless the family cache has it", async () => {
	const h = createHarness(fixture);
	h.store.setRepo(CANONICAL, [T4]);
	h.store.setRepo("l-a", [head("same-line-a")]);
	h.store.setRepo("l-b", [head("same-line-b")]);
	h.state.laneRepos.set(LANE_X, "l-a");
	h.state.laneRepos.set(LANE_Y, "l-b");
	const probe = createRepoProbe(h.deps);
	const file = fixture.pairs.find((p) => p.name === "same-line")!.files[0];
	const input = {
		repoId: REPO,
		path: file.path,
		base: file.base,
		ours: file.ours!,
		theirs: file.theirs!,
	};
	const [cold] = await probe.merge3([input]);
	equal((cold as { pathLevel?: boolean }).pathLevel, true);
	// Radar reads each lane's hunks first, which fills the family cache.
	await probe.hunks({ repoId: REPO, laneId: LANE_X }, T2, head("same-line-a"), [
		file.path,
	]);
	await probe.hunks({ repoId: REPO, laneId: LANE_Y }, T2, head("same-line-b"), [
		file.path,
	]);
	const [warm] = await probe.merge3([input]);
	deepStrictEqual([warm.clean, warm.regions.length], [false, 1]);
});

// ---------------------------------------------------------------------------
// Planner over the fixture's sample monorepo
// ---------------------------------------------------------------------------

Deno.test("projectGraph at a commit is computed once and cached in RepoDO", async () => {
	const h = canonicalHarness();
	const graph = await h.probe.projectGraph(REPO, T4);
	deepStrictEqual(graph.projects.map((p) => [p.name, p.root]), [
		["api", "services/api"],
		["web", "apps/web"],
	]);
	equal(graph.sha, T4);
	ok(h.state.graphs.has(T4));
	const reads = h.store.calls.length;
	deepStrictEqual(await createRepoProbe(h.deps).projectGraph(REPO, T4), graph);
	equal(h.store.calls.length, reads);
});

Deno.test("affected: lane range paths on the graph at head, or at a given trunk commit", async () => {
	const h = canonicalHarness();
	deepStrictEqual(
		await h.probe.affected(REPO, T2, head("at-base"), {
			source: { repoId: REPO, laneId: LANE_X },
		}),
		{ projects: ["api"], global: false },
	);
	// trunk/t*.txt lie outside every project root: global.
	deepStrictEqual(await h.probe.affected(REPO, T0, T4, { graphAt: T4 }), {
		projects: ["api", "web"],
		global: true,
		globalPaths: ["trunk/t1.txt", "trunk/t2.txt", "trunk/t4.txt"],
	});
});

Deno.test("treeHash and addedLines", async () => {
	const h = canonicalHarness();
	const root = fixture.objects.commits[T4].treeHash;
	const services = fixture.objects.trees[root].find((e) =>
		e.name === "services"
	)!;
	const api = fixture.objects.trees[services.hash].find((e) =>
		e.name === "api"
	)!;
	equal(await h.probe.treeHash({ repoId: REPO }, T4, "services/api"), api.hash);
	equal(await h.probe.treeHash({ repoId: REPO }, T4, "nope"), null);
	notEqual(await h.probe.treeHash({ repoId: REPO }, T4, ""), null);
	const added = await h.probe.addedLines({ repoId: REPO }, T2, head("at-base"));
	deepStrictEqual(added, {
		lines: [
			{ path: "services/api/a.ts", line: 6, text: "api-a line 6" },
			{ path: "services/api/b.ts", line: 1, text: "b" },
		],
		truncated: false,
	});
	const capped = await h.probe.addedLines(
		{ repoId: REPO },
		T2,
		head("at-base"),
		{
			lines: 1,
			bytes: 1000,
		},
	);
	deepStrictEqual([capped.lines.length, capped.truncated], [1, true]);
});

Deno.test("bad sources are refused (K12 shapes: never a raw Artifacts name)", async () => {
	const h = canonicalHarness();
	await rejects(
		h.probe.diffPaths({ repoId: CANONICAL } as never, T2, T4),
		(e) => fromRpcError(e).code === "invalid",
	);
	await rejects(
		h.probe.diffPaths({ repoId: REPO, laneId: "l-x" } as never, T2, T4),
		(e) => fromRpcError(e).code === "invalid",
	);
	equal(T1.length, 40);
});

// ---------------------------------------------------------------------------
// Repository config (ADR repo config): configured projects at the trunk base
// ---------------------------------------------------------------------------

Deno.test("projects of package tartan come from the commit's trunk base: a lane head reads its merge base's config; root *.cue is global; the config key moves the graph", async () => {
	const configAt = new Map<string, string>();
	const asked: string[] = [];
	const h = createHarness(fixture);
	h.store.setRepo(CANONICAL, allHeads);
	h.state.projectConfig = (sha) => {
		asked.push(sha);
		const key = configAt.get(sha);
		if (!fixture.trunk.includes(sha)) return { needsBase: true };
		return key === undefined
			? { key: "none", projects: null, global: [], provisional: false }
			: {
				key,
				projects: { api: { root: "services/api" } },
				global: ["pnpm-lock.yaml"],
				provisional: key.startsWith("provisional:"),
			};
	};
	configAt.set(T2, "k".repeat(64));
	const probe = createRepoProbe({ ...h.deps, repoConfig: true });
	const lane = head("at-base");
	const graph = await probe.projectGraph(REPO, lane);
	// The lane head is not on trunk: its K17 merge base (T2) answers.
	deepStrictEqual(asked, [lane, T2]);
	deepStrictEqual(graph.projects.map((p) => [p.name, p.root, p.source]), [
		["api", "services/api", "tartan-config"],
	]);
	equal(graph.configKey, "k".repeat(64));
	ok(graph.globalFiles.some((g) => g.glob === "*.cue"));
	ok(graph.globalFiles.some((g) => g.glob === "pnpm-lock.yaml"));
	equal(graph.provisional, undefined);
	// Another trunk config at the same base is another graph.
	const h2 = createHarness(fixture);
	h2.store.setRepo(CANONICAL, allHeads);
	h2.state.projectConfig = (sha) =>
		fixture.trunk.includes(sha)
			? {
				key: "provisional:" + "k".repeat(64),
				projects: { api: { root: "services/api" } },
				global: ["pnpm-lock.yaml"],
				provisional: true,
			}
			: { needsBase: true };
	const pending = await createRepoProbe({ ...h2.deps, repoConfig: true })
		.projectGraph(REPO, lane);
	notEqual(pending.manifestsTreeSha, graph.manifestsTreeSha);
	equal(pending.provisional, true);
	// With repository config off the probe never asks (detectors only).
	const off = canonicalHarness();
	let offAsked = 0;
	off.state.projectConfig = () => {
		offAsked += 1;
		return { key: "none", projects: null, global: [], provisional: false };
	};
	const offGraph = await off.probe.projectGraph(REPO, lane);
	equal(offAsked, 0);
	equal(offGraph.configKey, "off");
});
