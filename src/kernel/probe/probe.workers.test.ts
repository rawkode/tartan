/// <reference types="@cloudflare/vitest-pool-workers/types" />
// RepoProbe and the RepoDO `probe` module in workerd (vitest project
// `probe`): the module's migrations and graph cache on a real RepoDO; the
// RepoProbe entrypoint over RPC through `ctx.exports` (it resolves every
// source through RepoDO `core().upstream`, a WP5a stub until that merges);
// and the probe itself in workerd with the real Cache API and R2 `BLOBS`
// over the offline git fixture.

import { runInDurableObject } from "cloudflare:test";
import {
	fromRpcError,
	type ProjectGraph,
	type PushDiff,
} from "@tartan/contract";
import { describe, expect, it } from "vitest";
import { testEnv as env } from "../../../test/env.ts";
import { loopback } from "../../exports.ts";
import { createObjectCache } from "./cache.ts";
import { createRepoProbe } from "./probe.ts";
import fixtureJson from "./test/fixtures/histories.json" with { type: "json" };
import { createHarness, type Fixture } from "./test/fixture-store.ts";

const fixture = fixtureJson as unknown as Fixture;
const REPO = "01k6aaaaaaaaaaaaaaaaaaaaaa";
const LANE = "ln_01k6cccccccccccccccccccccc";
const [, , T2, , T4] = fixture.trunk;

const graph = (sha: string, key: string): ProjectGraph => ({
	sha,
	manifestsTreeSha: key,
	projects: [{
		name: "api",
		root: "services/api",
		deps: [],
		dependents: [],
		owners: [],
		sensitive: false,
		source: "pnpm-workspace",
		manifestPath: "services/api/package.json",
		testCmd: "pnpm test",
	}],
	globalFiles: [{ glob: "*.cue", source: "detector-default" }],
});

const repoStub = () =>
	env.REPO.getByName(`repo:${crypto.randomUUID().replaceAll("-", "")}`);

describe("RepoDO probe module", () => {
	it("applies migrations 250–251 and caches graphs per commit and manifest key", async () => {
		const repo = repoStub();
		const key = "a".repeat(64);
		const g1 = graph("1".repeat(40), key);
		await repo.probe().putProjects(g1);
		await repo.probe().putProjects({ ...g1, sha: "2".repeat(40) });
		expect(await repo.probe().projects("1".repeat(40))).toEqual(g1);
		expect(await repo.probe().projects("2".repeat(40))).toEqual({
			...g1,
			sha: "2".repeat(40),
		});
		expect(await repo.probe().projects("3".repeat(40))).toBeNull();
		await runInDurableObject(repo, (_instance, state) => {
			const sql = state.storage.sql;
			const applied = sql.exec<{ n: number }>(
				"SELECT n FROM _migrations WHERE n BETWEEN 250 AND 299 ORDER BY n",
			).toArray().map((r) => r.n);
			expect(applied).toEqual([250, 251]);
			expect(sql.exec("SELECT COUNT(*) AS n FROM project_graphs").one().n).toBe(
				1,
			);
			const rows = sql.exec<{ name: string; manifest_path: string }>(
				"SELECT name, manifest_path FROM projects",
			).toArray();
			expect(rows).toEqual([{
				name: "api",
				manifest_path: "services/api/package.json",
			}]);
			expect(
				sql.exec("SELECT glob, source FROM global_files").toArray(),
			).toEqual([{ glob: "*.cue", source: "detector-default" }]);
		});
	});

	it("refuses a malformed graph", async () => {
		const repo = repoStub();
		const error = await repo.probe().putProjects(graph("nope", "b".repeat(64)))
			.catch((e: unknown) => e);
		expect(fromRpcError(error).code).toBe("invalid");
		const lookup = await repo.probe().projects("main").catch((e: unknown) => e);
		expect(fromRpcError(lookup).code).toBe("invalid");
	});

	it("diffPaths delegates to the RepoProbe entrypoint over ctx.exports", async () => {
		const repo = repoStub();
		// RepoProbe resolves the source through core().upstream (WP5a); this
		// repo was never initialized, so core answers not_found.
		const error = await repo.probe().diffPaths({ repoId: REPO }, T2, T4)
			.catch((e: unknown) => e);
		expect(fromRpcError(error)).toMatchObject({
			code: "not_found",
			text: "repo is not initialized",
		});
	});
});

describe("RepoProbe entrypoint", () => {
	it("is reachable over RPC and resolves sources through RepoDO, never an input name", async () => {
		const repo = repoStub();
		await runInDurableObject(repo, async (_instance, state) => {
			const probe = loopback(state).RepoProbe;
			const error = await probe.treeHash(
				{ repoId: REPO, laneId: LANE },
				T4,
				"src",
			)
				.catch((e: unknown) => e);
			// Reached core().upstream (WP5a) on a repo never initialized.
			expect(fromRpcError(error).text).toBe("repo is not initialized");
			const bad = await probe.diffPaths(
				{ repoId: `r-${REPO}` } as never,
				T2,
				T4,
			).catch((e: unknown) => e);
			expect(fromRpcError(bad).code).toBe("invalid");
		});
	});
});

describe("createRepoProbe in workerd (Cache API + R2)", () => {
	it("writes the push diff to R2 diffs/ and refills objects from the Cache API", async () => {
		const edge =
			(globalThis as unknown as { caches: { default: Cache } }).caches.default;
		const h = createHarness(fixture, {
			cache: createObjectCache({ edge }),
		});
		h.store.setRepo(`r-${REPO}`, Object.values(fixture.refs));
		const probe = createRepoProbe({
			...h.deps,
			diffs: {
				get: (key) => env.BLOBS.get(key),
				put: (key, value) => env.BLOBS.put(key, value),
			},
		});
		const result = await probe.laneDiff(
			{ repoId: REPO, laneId: LANE },
			fixture.refs["at-base"],
		);
		expect(result.rangeBase).toBe(fixture.lanes["at-base"].mergeBase);
		const stored = await env.BLOBS.get(result.diffKey);
		expect(stored).not.toBeNull();
		const diff = JSON.parse(await stored!.text()) as PushDiff;
		expect(diff.files.map((f) => f.path)).toEqual([
			"services/api/a.ts",
			"services/api/b.ts",
		]);
		// A fresh isolate cache (empty LRU) is served by the Cache API layer.
		const cold = createHarness(fixture, {
			cache: createObjectCache({ edge }),
		});
		cold.store.setRepo(`r-${REPO}`, Object.values(fixture.refs));
		const hunks = await createRepoProbe(cold.deps).hunks(
			{ repoId: REPO },
			T2,
			fixture.refs["at-base"],
			["services/api/a.ts"],
		);
		expect(hunks[0].hunks).toEqual([
			{ oldStart: 5, oldLines: 0, newStart: 6, newLines: 1 },
		]);
		expect(cold.store.calls.filter((c) => c.op === "readBlob")).toEqual([]);
		expect(cold.cache.stats().edgeHits).toBeGreaterThan(0);
	});
});
