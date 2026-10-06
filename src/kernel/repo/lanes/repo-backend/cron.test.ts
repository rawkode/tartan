// The `repoBackend` cron task: per repo the seed re-drive and lane-repo
// reconciliation; forge-wide the orphan sweep, every `l-*` name grouped by its
// repo family from `ARTIFACTS.list()` and the index; one failure never skips
// another.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	createUlid,
	laneArtifactsName,
	repoArtifactsName,
} from "@tartan/contract";
import type { ArtifactsIndexRow } from "@tartan/contract/kernel.ts";
import { LANE_ORPHAN_AGE_MS } from "../../../../constants.ts";
import { runRepoBackendCron } from "./cron.ts";

const ulid = createUlid();

Deno.test("the cron groups l-* names by family, pages the listing and isolates failures", async () => {
	const repoA = ulid();
	const repoB = ulid();
	const laneNamesA = Array.from(
		{ length: 150 },
		() => laneArtifactsName(repoA, ulid()),
	);
	const laneB = laneArtifactsName(repoB, ulid(), 2);
	const indexOnly = laneArtifactsName(repoB, ulid());
	const listed = [
		repoArtifactsName(repoA),
		...laneNamesA,
		laneB,
		"not-a-tartan-repo",
	];
	const pages: (string | undefined)[] = [];
	const calls: string[] = [];
	const now = 10 * LANE_ORPHAN_AGE_MS;
	let olderThan = 0;
	const outcome = await runRepoBackendCron({
		artifacts: {
			list: (opts?: { limit?: number; cursor?: string }) => {
				pages.push(opts?.cursor);
				const start = opts?.cursor === undefined ? 0 : Number(opts.cursor);
				const limit = opts?.limit ?? 50;
				const slice = listed.slice(start, start + limit);
				const next = start + limit < listed.length
					? String(start + limit)
					: undefined;
				return Promise.resolve({
					repos: slice.map((name) => ({ name })),
					total: listed.length,
					...(next !== undefined ? { cursor: next } : {}),
				}) as never;
			},
		},
		tree: {
			listRepos: () => Promise.reject(new Error("unused")),
			listArtifactsIndex: (state, older) => {
				olderThan = older;
				return Promise.resolve(
					state === "pending"
						? [{ name: indexOnly, kind: "lane" } as ArtifactsIndexRow]
						: [],
				);
			},
		},
		core: (repoId) => ({
			redriveSeeds: () => {
				calls.push(`redrive ${repoId}`);
				return repoId === repoA
					? Promise.reject(new Error("redrive boom"))
					: Promise.resolve({ laneIds: [] });
			},
			reconcileLaneRepos: () => {
				calls.push(`reconcile ${repoId}`);
				return Promise.resolve({ checked: 0, observed: 0 });
			},
			sweepLaneRepos: (names) => {
				calls.push(`sweep ${repoId} ${names.length}`);
				if (repoId === repoB) return Promise.reject(new Error("sweep boom"));
				return Promise.resolve({
					deleted: names.slice(0, 1),
					kept: names.slice(1),
				});
			},
		}),
		log: () => {},
		forEachRepo: async (work) => {
			await work(repoA);
			await work(repoB);
		},
	}, now);
	equal(outcome.repos, 2);
	ok(pages.length >= 1);
	equal(olderThan, now - LANE_ORPHAN_AGE_MS);
	// Both repos re-driven and reconciled, despite repo A's failure.
	deepStrictEqual(
		calls.filter((c) => !c.startsWith("sweep")),
		[
			`redrive ${repoA}`,
			`reconcile ${repoA}`,
			`redrive ${repoB}`,
			`reconcile ${repoB}`,
		],
	);
	// Family A's 150 names in chunks of 100; family B's two names in one call.
	deepStrictEqual(
		calls.filter((c) => c.startsWith("sweep")),
		[`sweep ${repoA} 100`, `sweep ${repoA} 50`, `sweep ${repoB} 2`],
	);
	equal(outcome.swept.deleted.length, 2);
	equal(outcome.failed.length, 2);
	ok(outcome.failed.some((f) => f.includes("redrive boom")));
	ok(outcome.failed.some((f) => f.includes("sweep boom")));
});

Deno.test("a failed Artifacts listing (an internal error) still sweeps the index's names", async () => {
	const repoA = ulid();
	const indexed = laneArtifactsName(repoA, ulid());
	const swept: string[][] = [];
	const logged: string[] = [];
	const outcome = await runRepoBackendCron({
		artifacts: {
			list: () => Promise.reject(new Error("An internal error occurred.")),
		} as never,
		tree: {
			listRepos: () => Promise.reject(new Error("unused")),
			listArtifactsIndex: (state) =>
				Promise.resolve(
					state === "live"
						? [{ name: indexed, kind: "lane" } as ArtifactsIndexRow]
						: [],
				),
		},
		core: () => ({
			redriveSeeds: () => Promise.resolve({ laneIds: [] }),
			reconcileLaneRepos: () => Promise.resolve({ checked: 0, observed: 0 }),
			sweepLaneRepos: (names) => {
				swept.push([...names]);
				return Promise.resolve({ deleted: [], kept: [...names] });
			},
		}),
		log: (message) => {
			logged.push(message);
		},
		forEachRepo: () => Promise.resolve(),
	}, 10 * LANE_ORPHAN_AGE_MS);
	deepStrictEqual(swept, [[indexed]]);
	deepStrictEqual(outcome.failed, []);
	ok(logged.some((m) => m.includes("Artifacts listing failed")));
});
