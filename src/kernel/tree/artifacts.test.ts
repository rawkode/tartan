// `artifacts_index` (WP3): lane rows of several seed attempts beside one
// canonical row, a second canonical row refused, case-folded lookups, upsert
// semantics, the forge-wide lane-repo ceiling and the sweep listing.

import { deepStrictEqual, equal } from "node:assert/strict";
import {
	fromRpcError,
	laneArtifactsName,
	laneId,
	repoArtifactsName,
	type TartanError,
} from "@tartan/contract";
import { MAX_LANE_REPOS_FORGE } from "../../constants.ts";
import { createTreeHarness } from "./testing/harness.ts";

const code = async (p: Promise<unknown>): Promise<TartanError> => {
	try {
		await p;
	} catch (error) {
		return fromRpcError(error);
	}
	throw new Error("expected a rejection");
};

Deno.test("index: l-<repo>-<a>, l-<repo>-<a>-2, l-<repo>-<b> and one canonical row coexist; lookups fold case", async () => {
	const h = createTreeHarness();
	const repo = h.ulid();
	const a = h.ulid();
	const b = h.ulid();
	const rows = [
		{ name: repoArtifactsName(repo), kind: "repo" as const },
		{ name: laneArtifactsName(repo, a), kind: "lane" as const, lane: a },
		{ name: laneArtifactsName(repo, a, 2), kind: "lane" as const, lane: a },
		{ name: laneArtifactsName(repo, b), kind: "lane" as const, lane: b },
	];
	for (const row of rows) {
		deepStrictEqual(
			await h.facade.indexArtifacts({
				name: row.name,
				kind: row.kind,
				repoId: repo,
				...(row.lane ? { laneId: laneId(row.lane) } : {}),
				state: "pending",
			}),
			{ ok: true },
		);
	}
	const upper = `L-${repo.toUpperCase()}-${a.toUpperCase()}`;
	const found = await h.facade.lookupArtifacts(upper);
	equal(found?.name, laneArtifactsName(repo, a));
	equal(found?.lane_id, laneId(a));
	equal(found?.repo_id, repo);
	equal(
		(await h.facade.lookupArtifacts(laneArtifactsName(repo, a, 2)))?.kind,
		"lane",
	);
	deepStrictEqual(await h.facade.countLaneRepos(), {
		retained: 3,
		max: MAX_LANE_REPOS_FORGE,
	});
	// An upper-case name is stored lowercase.
	const c = h.ulid();
	await h.facade.indexArtifacts({
		name: laneArtifactsName(repo, c).toUpperCase(),
		kind: "lane",
		repoId: repo,
		laneId: laneId(c),
		state: "pending",
	});
	equal(
		(await h.facade.lookupArtifacts(laneArtifactsName(repo, c)))?.name,
		laneArtifactsName(repo, c),
	);
});

Deno.test("index: a second canonical row for a repo and mismatched fields are refused", async () => {
	const h = createTreeHarness();
	const repo = h.ulid();
	const other = h.ulid();
	const lane = h.ulid();
	await h.facade.indexArtifacts({
		name: repoArtifactsName(repo),
		kind: "repo",
		repoId: repo,
		state: "pending",
	});
	for (
		const input of [
			// Another canonical name claiming the same repo.
			{ name: repoArtifactsName(other), kind: "repo" as const, repoId: repo },
			// Kind and name disagree.
			{ name: repoArtifactsName(repo), kind: "lane" as const, repoId: repo },
			// A lane row with the wrong lane id, or none.
			{
				name: laneArtifactsName(repo, lane),
				kind: "lane" as const,
				repoId: repo,
				laneId: laneId(other),
			},
			{
				name: laneArtifactsName(repo, lane),
				kind: "lane" as const,
				repoId: repo,
			},
			// A canonical row with a lane id.
			{
				name: repoArtifactsName(repo),
				kind: "repo" as const,
				repoId: repo,
				laneId: laneId(lane),
			},
			// Names Tartan never creates.
			{ name: "my-repo", kind: "repo" as const, repoId: repo },
			{ name: `r-${repo}-x`, kind: "repo" as const, repoId: repo },
		]
	) {
		equal(
			(await code(h.facade.indexArtifacts({ ...input, state: "pending" })))
				.code,
			"invalid",
			JSON.stringify(input),
		);
	}
	equal(
		h.storage.sql.exec<{ n: number }>(
			"SELECT COUNT(*) AS n FROM artifacts_index WHERE kind = 'repo'",
		).toArray()[0].n,
		1,
	);
});

Deno.test("index: an upsert; pending twice is a no-op, live without pending inserts, states only move forward", async () => {
	const h = createTreeHarness();
	const repo = h.ulid();
	const lane = h.ulid();
	const name = laneArtifactsName(repo, lane);
	const input = {
		name,
		kind: "lane" as const,
		repoId: repo,
		laneId: laneId(lane),
	};
	await h.facade.indexArtifacts({ ...input, state: "pending" });
	const first = await h.facade.lookupArtifacts(name);
	h.clock.advance(1000);
	await h.facade.indexArtifacts({ ...input, state: "pending" });
	deepStrictEqual(await h.facade.lookupArtifacts(name), first);
	await h.facade.indexArtifacts({ ...input, state: "live" });
	equal((await h.facade.lookupArtifacts(name))?.state, "live");
	equal(
		(await h.facade.lookupArtifacts(name))?.updated_at,
		first!.updated_at + 1000,
	);
	await h.facade.indexArtifacts({ ...input, state: "pending" });
	equal((await h.facade.lookupArtifacts(name))?.state, "live");
	await h.facade.indexArtifacts({ ...input, state: "deleted" });
	await h.facade.indexArtifacts({ ...input, state: "live" });
	equal((await h.facade.lookupArtifacts(name))?.state, "deleted");
	const late = laneArtifactsName(repo, h.ulid(), 3);
	const lateLane = laneId(late.split("-")[2]);
	await h.facade.indexArtifacts({
		name: late,
		kind: "lane",
		repoId: repo,
		laneId: lateLane,
		state: "live",
	});
	equal((await h.facade.lookupArtifacts(late))?.state, "live");
	equal(
		await h.facade.lookupArtifacts(laneArtifactsName(repo, h.ulid())),
		null,
	);
});

Deno.test("index: lane-repo-ceiling for a new pending lane row at MAX_LANE_REPOS_FORGE; canonical rows never refused", async () => {
	const h = createTreeHarness();
	const repo = h.ulid();
	const now = h.clock.now();
	// Fill the ceiling directly (fast), half pending and half live, plus deleted rows that do not count.
	for (let i = 0; i < MAX_LANE_REPOS_FORGE; i++) {
		const lane = h.ulid();
		h.storage.sql.exec(
			"INSERT INTO artifacts_index (name, kind, repo_id, lane_id, state, created_at, updated_at) VALUES (?, 'lane', ?, ?, ?, ?, ?)",
			laneArtifactsName(repo, lane),
			repo,
			laneId(lane),
			i % 2 === 0 ? "pending" : "live",
			now,
			now,
		);
	}
	const gone = h.ulid();
	h.storage.sql.exec(
		"INSERT INTO artifacts_index (name, kind, repo_id, lane_id, state, created_at, updated_at) VALUES (?, 'lane', ?, ?, 'deleted', ?, ?)",
		laneArtifactsName(repo, gone),
		repo,
		laneId(gone),
		now,
		now,
	);
	deepStrictEqual(await h.facade.countLaneRepos(), {
		retained: MAX_LANE_REPOS_FORGE,
		max: MAX_LANE_REPOS_FORGE,
	});
	const lane = h.ulid();
	deepStrictEqual(
		await h.facade.indexArtifacts({
			name: laneArtifactsName(repo, lane),
			kind: "lane",
			repoId: repo,
			laneId: laneId(lane),
			state: "pending",
		}),
		{ ok: false, reason: "lane-repo-ceiling" },
	);
	equal(await h.facade.lookupArtifacts(laneArtifactsName(repo, lane)), null);
	const canonical = h.ulid();
	deepStrictEqual(
		await h.facade.indexArtifacts({
			name: repoArtifactsName(canonical),
			kind: "repo",
			repoId: canonical,
			state: "pending",
		}),
		{ ok: true },
	);
	// An existing pending lane row moves to live at the ceiling.
	const existing = h.storage.sql.exec<{ name: string; lane_id: string }>(
		"SELECT name, lane_id FROM artifacts_index WHERE state = 'pending' AND kind = 'lane' LIMIT 1",
	).toArray()[0];
	deepStrictEqual(
		await h.facade.indexArtifacts({
			name: existing.name,
			kind: "lane",
			repoId: repo,
			laneId: existing.lane_id,
			state: "live",
		}),
		{ ok: true },
	);
});

Deno.test("listArtifactsIndex: rows in a state older than a time, oldest first", async () => {
	const h = createTreeHarness();
	const repo = h.ulid();
	const names: string[] = [];
	for (let i = 0; i < 3; i++) {
		const lane = h.ulid();
		const name = laneArtifactsName(repo, lane);
		names.push(name);
		await h.facade.indexArtifacts({
			name,
			kind: "lane",
			repoId: repo,
			laneId: laneId(lane),
			state: "pending",
		});
		h.clock.advance(1000);
	}
	const cutoff = h.clock.now() - 1500;
	deepStrictEqual(
		(await h.facade.listArtifactsIndex("pending", cutoff)).map((r) => r.name),
		names.slice(0, 2),
	);
	deepStrictEqual(await h.facade.listArtifactsIndex("live", h.clock.now()), []);
	equal(
		(await code(h.facade.listArtifactsIndex("weird" as "live", 0))).code,
		"invalid",
	);
});
