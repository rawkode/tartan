// Lane-repo reconciliation (WP5b; K2): the cron reads
// each active `repo` lane's CURRENT lane repo by exact name
// (`lanes.repo_name`), paced at `LANE_RECONCILE_PER_S`, and hands every
// difference to WP5a's `observeSync`, which merges it into a recorded push
// or kernel write or parks it for K2 (quarantining that lane only):
// - `refs/heads/main` ≠ `lanes.head_sha` ⇒ an observation of the head;
// - any other ref of a lane repo (a tag, a branch) ⇒ an observation;
// - a missing repo ⇒ `main → zeros`.
// A lane with no push since its last check is read at most hourly
// (`LANE_IDLE_RECONCILE_MS`). Each pass also re-upserts the index row
// `live` (the open transaction's upsert is best effort).

import { LANE_REPO_HEAD_REF, ZERO_SHA } from "@tartan/contract";
import type { LaneRepoReconcileRun, LaneRow } from "@tartan/contract/kernel.ts";
import {
	LANE_IDLE_RECONCILE_MS,
	LANE_RECONCILE_PER_S,
} from "../../../../constants.ts";
import { rows } from "../../core.ts";
import { ACTIVE_SQL } from "../rows.ts";
import {
	type Ctx,
	errorText,
	identity,
	laneRepoRefs,
	setUpkeep,
	upkeep,
} from "./context.ts";

/** Lanes read per pass (the cron runs every 5 minutes). */
export const RECONCILE_BATCH = 100;

export const createLaneRepoReconciler = (ctx: Ctx) => {
	const due = (row: LaneRow, now: number): boolean => {
		const last = upkeep(ctx, row.id)?.reconciled_at ?? null;
		if (last === null) return true;
		if ((row.last_push_at ?? row.created_at) > last) return true;
		return now - last >= LANE_IDLE_RECONCILE_MS;
	};

	/** Reads one lane repo and observes every difference; the number observed. */
	const reconcileOne = async (row: LaneRow): Promise<number> => {
		const name = row.repo_name as string;
		const refs = await laneRepoRefs(ctx, name, ["refs/"]);
		const observations: {
			ref: string;
			before: string;
			after: string;
		}[] = [];
		const head = row.head_sha ?? ZERO_SHA;
		const main = refs === null
			? ZERO_SHA
			: refs.find((r) => r.ref === LANE_REPO_HEAD_REF)?.sha ?? ZERO_SHA;
		if (main !== head) {
			observations.push({ ref: LANE_REPO_HEAD_REF, before: head, after: main });
		}
		for (const ref of refs ?? []) {
			if (ref.ref === LANE_REPO_HEAD_REF) continue;
			observations.push({ ref: ref.ref, before: ZERO_SHA, after: ref.sha });
		}
		ctx.tx(() => {
			for (const o of observations) {
				ctx.deps.core.internal.observeSync({
					target: row.id,
					repoName: name,
					...o,
				});
			}
			setUpkeep(ctx, row.id, { reconciled_at: ctx.now() });
		});
		if (refs !== null) {
			await ctx.deps.forgeTree().indexArtifacts({
				name,
				kind: "lane",
				repoId: identity(ctx).repoId,
				laneId: row.id,
				state: "live",
			}).catch(() => {});
		}
		return observations.length;
	};

	const reconcileLaneRepos = async (
		now: number,
	): Promise<LaneRepoReconcileRun> => {
		identity(ctx);
		const lanes = rows<LaneRow>(
			ctx.sql,
			`SELECT * FROM lanes WHERE mode = 'repo' AND repo_name IS NOT NULL
			 AND state IN (${ACTIVE_SQL}) ORDER BY id`,
		).filter((row) => due(row, now)).slice(0, RECONCILE_BATCH);
		let checked = 0;
		let observed = 0;
		const gap = Math.ceil(1000 / LANE_RECONCILE_PER_S);
		for (const row of lanes) {
			if (checked > 0) await ctx.ports.sleep(gap);
			try {
				observed += await reconcileOne(row);
				checked++;
			} catch (error) {
				ctx.ports.log("lane repo reconcile failed", {
					laneId: row.id,
					error: errorText(error),
				});
			}
		}
		return { checked, observed };
	};

	return { reconcileLaneRepos, reconcileOne };
};
