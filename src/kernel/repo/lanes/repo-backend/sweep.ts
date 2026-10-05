// The orphan sweep (WP5b): `sweepLaneRepos(names, now)` for the `l-*` names of
// THIS repo family (the cron hands each family its names from
// `ARTIFACTS.list()` and the `pending`/`live` lane rows of `artifacts_index`).
//
// A name is deleted only when it is older than `LANE_ORPHAN_AGE_MS` (by its
// index row's `created_at`, or since the sweep first saw it when no row
// exists) AND one of:
//   (a) no lane row exists for its lane id;
//   (b) it is not the lane's current `repo_name` and no live attempt uses it
//       (its attempt is below `seed_attempt`, or the lane is no longer
//       `opening`): a superseded attempt, or a lane that fell back to
//       `branch`;
//   (c) it is the lane's current `repo_name`, the lane is `closed` or
//       `deleted`, and `seed_ms IS NULL` (closed while `opening`).
// A lane repo of a lane that OPENED is never the sweep's: from `open` to
// `archived` and until `delete_after`, only lane GC deletes it.

import {
	laneId as laneIdOf,
	parseArtifactsName,
	ZERO_SHA,
} from "@tartan/contract";
import type { LaneRow, SweepResult } from "@tartan/contract/kernel.ts";
import { LANE_ORPHAN_AGE_MS } from "../../../../constants.ts";
import { first } from "../../core.ts";
import { type Ctx, errorText, identity, lane as laneOf } from "./context.ts";
import { deleteLaneRepo } from "./gc.ts";

/** At most this many names are handled per call (the cron pages). */
export const SWEEP_BATCH = 200;

export type SweepVerdict =
	| { readonly delete: true; readonly rule: "a" | "b" | "c" }
	| { readonly delete: false; readonly why: string };

/** The orphan predicate, on one name of this family (age checked by the caller). */
export const orphanVerdict = (
	name: string,
	attempt: number,
	row: LaneRow | null,
): SweepVerdict => {
	if (row === null) return { delete: true, rule: "a" };
	if (row.repo_name !== name) {
		const live = row.state === "opening" && attempt >= row.seed_attempt;
		return live
			? { delete: false, why: "a live attempt uses it" }
			: { delete: true, rule: "b" };
	}
	if (
		(row.state === "closed" || row.state === "deleted") && row.seed_ms === null
	) {
		return { delete: true, rule: "c" };
	}
	return { delete: false, why: `the lane's repo (${row.state})` };
};

export const createSweep = (ctx: Ctx) => {
	/** When the sweep may judge the name: its index row's age, else first sight. */
	const ageOf = async (name: string, now: number): Promise<number> => {
		let indexed: number | null = null;
		try {
			const row = await ctx.deps.forgeTree().lookupArtifacts(name);
			indexed = row?.created_at ?? null;
		} catch (error) {
			ctx.ports.log("sweep: index lookup failed", {
				name,
				error: errorText(error),
			});
		}
		if (indexed !== null) return now - indexed;
		const seen = ctx.tx(() => {
			ctx.sql.exec(
				`INSERT INTO lane_repo_sightings (name, first_seen_at) VALUES (?, ?)
				 ON CONFLICT (name) DO NOTHING`,
				name,
				now,
			);
			return first<{ first_seen_at: number }>(
				ctx.sql,
				"SELECT first_seen_at FROM lane_repo_sightings WHERE name = ?",
				name,
			)?.first_seen_at ?? now;
		});
		return now - seen;
	};

	const sweepLaneRepos = async (
		names: readonly string[],
		now: number,
	): Promise<SweepResult> => {
		const repoId = identity(ctx).repoId;
		const deleted: string[] = [];
		const kept: string[] = [];
		const unique = [...new Set(names.map((n) => String(n).toLowerCase()))]
			.slice(0, SWEEP_BATCH);
		for (const name of unique) {
			const parsed = parseArtifactsName(name);
			if (
				parsed === null || parsed.kind !== "lane" ||
				parsed.repoUlid !== repoId
			) {
				kept.push(name);
				continue;
			}
			const laneId = laneIdOf(parsed.laneUlid);
			const verdict = orphanVerdict(name, parsed.attempt, laneOf(ctx, laneId));
			if (!verdict.delete) {
				kept.push(name);
				continue;
			}
			if (await ageOf(name, now) < LANE_ORPHAN_AGE_MS) {
				kept.push(name);
				continue;
			}
			try {
				await deleteLaneRepo(ctx, {
					name,
					laneId,
					purpose: "lane-delete",
					expectOld: ZERO_SHA,
					ownerId: `sweep:${verdict.rule}`,
				});
				deleted.push(name);
			} catch (error) {
				ctx.ports.log("sweep: delete failed", {
					name,
					error: errorText(error),
				});
				kept.push(name);
			}
		}
		// A lane closed while `opening` whose repos are all gone is `deleted`
		// (lane GC then reads `missing`).
		return { deleted, kept };
	};

	return { sweepLaneRepos };
};
