// `artifacts_index` (WP3): one row per Artifacts repo Tartan creates, canonical
// (`r-<repo>`) or one lane-repo seed attempt (`l-<repo>-<lane>[-<n>]`). Every
// create or import attempt upserts `pending` first; `live` and `deleted` are
// upserts too, and a row only moves forward (pending → live → deleted). The
// name carries the repo family, so a lane row is a cache entry (IngestWorkflow
// parses the family from the name itself). A new `pending` lane row is refused
// at the forge-wide ceiling of retained lane repos; canonical rows never are.

import {
	invalid,
	laneId as laneIdOf,
	parseArtifactsName,
} from "@tartan/contract";
import type {
	ArtifactsIndexRow,
	IndexArtifactsInput,
	IndexArtifactsResult,
} from "@tartan/contract/kernel.ts";
import { MAX_LANE_REPOS_FORGE } from "../../constants.ts";
import type { TreeContext } from "./context.ts";
import { count, indexRow, rows } from "./store.ts";

const STATE_ORDER: Readonly<Record<ArtifactsIndexRow["state"], number>> = {
	pending: 0,
	live: 1,
	deleted: 2,
};

/** Rows `listArtifactsIndex` returns per call (the sweeps page by `updated_at`). */
export const INDEX_PAGE = 500;

export const retainedLaneRepos = (sql: SqlStorage): number =>
	count(
		sql,
		"SELECT COUNT(*) AS n FROM artifacts_index WHERE kind = 'lane' AND state IN ('pending','live')",
	);

/** The validated, lowercased row an upsert writes (`invalid` when the name and fields disagree). */
const checkInput = (input: IndexArtifactsInput) => {
	if (typeof input.name !== "string") throw invalid("name is required");
	const name = input.name.toLowerCase();
	const parsed = parseArtifactsName(name);
	if (parsed === null) {
		throw invalid(`not an Artifacts name Tartan creates: ${input.name}`);
	}
	if (parsed.kind !== input.kind) {
		throw invalid(`${name} is a ${parsed.kind} name, not ${input.kind}`);
	}
	if (parsed.repoUlid !== input.repoId) {
		throw invalid(`${name} does not belong to repo ${input.repoId}`);
	}
	if (!(input.state in STATE_ORDER)) {
		throw invalid(`unknown index state ${input.state}`);
	}
	if (parsed.kind === "lane") {
		const lane = laneIdOf(parsed.laneUlid);
		if (input.laneId !== lane) {
			throw invalid(`${name} is lane ${lane}, not ${input.laneId ?? "none"}`);
		}
		return { name, laneId: lane };
	}
	if (input.laneId !== undefined) {
		throw invalid("a canonical repo row has no lane");
	}
	return { name, laneId: null };
};

/** The index upsert: idempotent, forward-only, ceiling on new `pending` lane rows. */
export const indexArtifactsSync = (
	c: TreeContext,
	input: IndexArtifactsInput,
): IndexArtifactsResult => {
	const { name, laneId } = checkInput(input);
	const now = c.clock.now();
	const existing = indexRow(c.sql, name);
	if (existing !== null) {
		if (STATE_ORDER[input.state] > STATE_ORDER[existing.state]) {
			c.sql.exec(
				"UPDATE artifacts_index SET state = ?, updated_at = ? WHERE name = ?",
				input.state,
				now,
				name,
			);
		}
		return { ok: true };
	}
	if (
		input.kind === "lane" && input.state === "pending" &&
		retainedLaneRepos(c.sql) >= MAX_LANE_REPOS_FORGE
	) {
		return { ok: false, reason: "lane-repo-ceiling" };
	}
	c.sql.exec(
		`INSERT INTO artifacts_index (name, kind, repo_id, lane_id, state, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		name,
		input.kind,
		input.repoId,
		laneId,
		input.state,
		now,
		now,
	);
	return { ok: true };
};

export const lookupArtifactsSync = (
	c: TreeContext,
	name: string,
): ArtifactsIndexRow | null =>
	typeof name === "string" ? indexRow(c.sql, name.toLowerCase()) : null;

/** Rows in `state` last updated before `olderThan`, oldest first (≤ `INDEX_PAGE`). */
export const listArtifactsIndexSync = (
	c: TreeContext,
	state: ArtifactsIndexRow["state"],
	olderThan: number,
): ArtifactsIndexRow[] => {
	if (!(state in STATE_ORDER)) throw invalid(`unknown index state ${state}`);
	return rows<ArtifactsIndexRow>(
		c.sql,
		"SELECT * FROM artifacts_index WHERE state = ? AND updated_at < ? ORDER BY updated_at, name LIMIT ?",
		state,
		olderThan,
		INDEX_PAGE,
	);
};

export const countLaneReposSync = (
	c: TreeContext,
): { retained: number; max: number } => ({
	retained: retainedLaneRepos(c.sql),
	max: MAX_LANE_REPOS_FORGE,
});
