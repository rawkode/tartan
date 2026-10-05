// RepoProbe building blocks: the K17 walk on synthetic histories (bounds,
// paging, merges), the read bucket, the family object cache (isolate LRU and
// Cache API layers) and trailer parsing.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import type { RepoStoreCommit, ResolvedSha } from "@tartan/contract/kernel.ts";
import { createTokenBucket } from "./bucket.ts";
import { type CacheLike, cacheUrl, createObjectCache } from "./cache.ts";
import { walkLaneRange } from "./range.ts";
import { subjectOf, trailersOf } from "./trailers.ts";

const sha = (n: number): string => n.toString(16).padStart(40, "0");
const at = (n: number): ResolvedSha => sha(n) as ResolvedSha;

const commit = (n: number, parents: number[]): RepoStoreCommit => ({
	hash: sha(n),
	treeHash: sha(1_000_000 + n),
	message: `c${n}`,
	author: { name: "a", email: "a@x" },
	committer: { name: "a", email: "a@x" },
	parents: parents.map(sha),
	authoredAt: n,
	committedAt: n,
});

/** A history from `{child: parents}` with a trunk `seq` map. */
const history = (
	graph: Record<number, number[]>,
	trunk: number[],
) => {
	const commits = new Map(
		Object.entries(graph).map((
			[n, ps],
		) => [sha(Number(n)), commit(Number(n), ps)]),
	);
	const seqs = new Map(trunk.map((n, i) => [sha(n), i]));
	const calls = { log: 0, seqs: 0 };
	return {
		calls,
		deps: {
			log: (from: ResolvedSha, o: { limit: number }) => {
				calls.log++;
				const out: RepoStoreCommit[] = [];
				let cur: string | undefined = from;
				while (cur && commits.has(cur) && out.length < o.limit) {
					out.push(commits.get(cur)!);
					cur = commits.get(cur)!.parents[0];
				}
				return Promise.resolve(out);
			},
			trunkSeqs: (shas: readonly string[]) => {
				calls.seqs++;
				return Promise.resolve(
					Object.fromEntries(
						shas.flatMap((s) => seqs.has(s) ? [[s, seqs.get(s)!]] : []),
					),
				);
			},
		},
	};
};

const chain = (
	from: number,
	count: number,
	base: number,
): Record<number, number[]> =>
	Object.fromEntries(
		Array.from(
			{ length: count },
			(_, i) => [from + i, [i === 0 ? base : from + i - 1]],
		),
	);

Deno.test("walk: 500 lane commits fit, 501 truncate (LANE_RANGE_MAX_COMMITS)", async () => {
	const trunk = { 1: [], 2: [1] };
	const ok500 = history({ ...trunk, ...chain(100, 500, 2) }, [1, 2]);
	const fits = await walkLaneRange(ok500.deps, at(599));
	deepStrictEqual([fits.rangeBase, fits.truncated, fits.commits.length], [
		sha(2),
		false,
		500,
	]);
	equal(ok500.calls.log, 2); // a 100-commit first page, then the rest in one
	const tooMany = history({ ...trunk, ...chain(100, 501, 2) }, [1, 2]);
	const cut = await walkLaneRange(tooMany.deps, at(600));
	deepStrictEqual([cut.rangeBase, cut.truncated, cut.reason], [
		null,
		true,
		"too-many-commits",
	]);
});

Deno.test("walk: the highest-seq trunk commit across merge parents wins; dates are ignored", async () => {
	// trunk 1-2-3-4; lane 10 (from 2) merges 4 at 11, then 12; a side branch 20 from 1 merged at 13.
	const h = history({
		1: [],
		2: [1],
		3: [2],
		4: [3],
		10: [2],
		11: [10, 4],
		20: [1],
		12: [11],
		13: [12, 20],
	}, [1, 2, 3, 4]);
	const walk = await walkLaneRange(h.deps, at(13));
	equal(walk.rangeBase, sha(4));
	deepStrictEqual(
		walk.commits.map((c) => c.hash),
		[13, 12, 11, 10, 20].map(sha),
	);
	equal(h.calls.seqs, h.calls.log);
});

Deno.test("walk: after is itself on trunk; missing and rootless histories truncate", async () => {
	const h = history({ 1: [], 2: [1] }, [1, 2]);
	deepStrictEqual(
		[
			(await walkLaneRange(h.deps, at(2))).rangeBase,
			(await walkLaneRange(h.deps, at(2))).commits,
		],
		[sha(2), []],
	);
	equal((await walkLaneRange(h.deps, at(99))).reason, "missing-commit");
	const orphan = history({ 1: [], 2: [1], 50: [], 51: [50] }, [1, 2]);
	equal(
		(await walkLaneRange(orphan.deps, at(51))).reason,
		"root-outside-trunk",
	);
});

Deno.test("bucket: refills at its rate; tryTake never blocks; take waits", async () => {
	let now = 0;
	const slept: number[] = [];
	const bucket = createTokenBucket({
		ratePerSecond: 10,
		burst: 2,
		clock: { now: () => now },
		sleep: (ms) => {
			slept.push(ms);
			now += ms;
			return Promise.resolve();
		},
	});
	ok(bucket.tryTake());
	ok(bucket.tryTake());
	ok(!bucket.tryTake());
	equal(bucket.available(), 0);
	await bucket.take();
	ok(slept.length > 0 && slept[0] >= 100);
	now += 1000;
	equal(bucket.available(), 2);
	ok(!bucket.tryTake(3));
	equal(bucket.available(), 2);
});

Deno.test("cache: keyed by family; LRU bounded; the Cache API layer serves another isolate", async () => {
	const edgeStore = new Map<string, Response>();
	const edge: CacheLike = {
		match: (req) => Promise.resolve(edgeStore.get(req.url)?.clone()),
		put: (req, res) => {
			edgeStore.set(req.url, res);
			return Promise.resolve();
		},
	};
	const a = createObjectCache({ edge, maxEntries: 2 });
	await a.put("fam1", "blob", "aa", new Uint8Array([1, 2]));
	deepStrictEqual(await a.get("fam1", "blob", "aa"), new Uint8Array([1, 2]));
	equal(await a.get("fam2", "blob", "aa"), null);
	ok(edgeStore.has(cacheUrl("fam1", "blob", "aa")));
	// Another isolate: empty LRU, same Cache API.
	const b = createObjectCache({ edge });
	deepStrictEqual(await b.get("fam1", "blob", "aa"), new Uint8Array([1, 2]));
	equal(b.stats().edgeHits, 1);
	// LRU eviction (no edge).
	const c = createObjectCache({ edge: null, maxEntries: 2 });
	await c.put("f", "tree", "1", []);
	await c.put("f", "tree", "2", []);
	await c.put("f", "tree", "3", []);
	equal(await c.get("f", "tree", "1"), null);
	deepStrictEqual(await c.get("f", "tree", "3"), []);
	// Oversized blobs are not cached.
	const d = createObjectCache({ edge: null, maxBlobBytes: 1 });
	await d.put("f", "blob", "big", new Uint8Array([1, 2]));
	equal(await d.get("f", "blob", "big"), null);
});

Deno.test("trailers and subjects", () => {
	equal(subjectOf("fix: thing\n\nbody"), "fix: thing");
	deepStrictEqual(
		trailersOf("fix\n\nbody\n\nChange-Id: abc\nCo-Authored-By: x <y>"),
		[
			{ key: "Change-Id", value: "abc" },
			{ key: "Co-Authored-By", value: "x <y>" },
		],
	);
	deepStrictEqual(trailersOf("fix\n\nnot a trailer\nKey: v"), []);
	deepStrictEqual(trailersOf("only subject"), []);
});
