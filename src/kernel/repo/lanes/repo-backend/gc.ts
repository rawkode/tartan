// Lane-repo deletion (WP5b): lane GC of `repo` lanes (`LaneBackend.gc`),
// archive on the `repo` backend, an Owner's purge, and the one deletion routine
// they and the orphan sweep share. Every deletion registers its intent first
// (`lane-delete`, or `purge` for an Owner's purge; target = the lane, new SHA
// zeros), then deletes the repo from RepoDO through the control bucket, marks
// the intent and moves the repo's `artifacts_index` row to `deleted`.

import {
	type ArchiveResult,
	ATTIC_RETENTION_DEFAULT_MS,
	ATTIC_RETENTION_MAX_MS,
	changeRef,
	conflict,
	invalid,
	isIdOf,
	type KernelWritePurpose,
	LANE_REPO_HEAD_REF,
	notFound,
	parseArtifactsName,
	ZERO_SHA,
} from "@tartan/contract";
import type { LaneGcOutcome, LaneRow } from "@tartan/contract/kernel.ts";
import { LANE_GC_DEFER_ALERT_MS } from "../../../../constants.ts";
import { getMetaNumber } from "../../core.ts";
import { getRef } from "../../refs.ts";
import {
	type Ctx,
	errorText,
	identity,
	landingOf,
	lane as laneOf,
	laneRepoRefs,
	notifyOwner,
	setUpkeep,
	upkeep,
} from "./context.ts";

/** The lane repo's head, null when the repo is gone or has no `main`. */
export const readTip = async (
	ctx: Ctx,
	name: string,
): Promise<string | null> => {
	const refs = await laneRepoRefs(ctx, name, [LANE_REPO_HEAD_REF]);
	return refs?.find((r) => r.ref === LANE_REPO_HEAD_REF)?.sha ?? null;
};

/**
 * Deletes one lane repo of this repo family: the intent first (when its lane
 * row exists), then `ARTIFACTS.delete`, then the intent and the index row.
 * Returns false when the repo was already gone.
 */
export const deleteLaneRepo = async (
	ctx: Ctx,
	input: {
		readonly name: string;
		readonly laneId: string;
		readonly purpose: Extract<KernelWritePurpose, "lane-delete" | "purge">;
		readonly expectOld: string;
		readonly ownerId: string;
	},
): Promise<boolean> => {
	const name = input.name.toLowerCase();
	const parsed = parseArtifactsName(name);
	const repoId = identity(ctx).repoId;
	if (parsed === null || parsed.kind !== "lane" || parsed.repoUlid !== repoId) {
		throw invalid(`not a lane repo of this repo: ${name}`);
	}
	const intent = laneOf(ctx, input.laneId) === null
		? null
		: ctx.tx(() =>
			ctx.deps.core.internal.registerKernelWriteSync({
				target: input.laneId,
				ref: LANE_REPO_HEAD_REF,
				expectOld: input.expectOld,
				newSha: ZERO_SHA,
				purpose: input.purpose,
				ownerKind: "kernel",
				ownerId: input.ownerId,
			})
		);
	let existed: boolean;
	try {
		existed = await ctx.access.control(() => ctx.deps.artifacts.delete(name));
	} catch (error) {
		if (intent !== null) {
			ctx.tx(() =>
				ctx.deps.core.internal.markKernelWriteSync(intent.id, "abandoned")
			);
		}
		throw error;
	}
	ctx.access.forget(name);
	ctx.tx(() => {
		if (intent !== null) {
			ctx.deps.core.internal.markKernelWriteSync(intent.id, "pushed");
		}
		ctx.sql.exec("DELETE FROM lane_repo_sightings WHERE name = ?", name);
	});
	await ctx.deps.forgeTree().indexArtifacts({
		name,
		kind: "lane",
		repoId,
		laneId: input.laneId,
		state: "deleted",
	}).catch((error) =>
		ctx.ports.log("index upsert (deleted) failed", {
			name,
			error: errorText(error),
		})
	);
	return existed !== false;
};

/** The repo's attic retention: `meta.attic_retention_ms`, default 7 days, at most 30. */
export const atticRetentionMs = (ctx: Ctx): number => {
	const own = getMetaNumber(ctx.sql, "attic_retention_ms");
	return own === null || own <= 0
		? ATTIC_RETENTION_DEFAULT_MS
		: Math.min(own, ATTIC_RETENTION_MAX_MS);
};

export const createLaneRepoGc = (ctx: Ctx) => {
	/**
	 * A landed lane's repo may hold the only copy of the landed history until
	 * `refs/tartan/changes/<changeId>` exists in the canonical index.
	 */
	const changeRefReady = (row: LaneRow): boolean | "not-landed" => {
		const landing = landingOf(ctx, row.id);
		if (landing === null) return "not-landed";
		const indexed = getRef(ctx.sql, changeRef(landing.change_id));
		return indexed?.sha === landing.lane_head;
	};

	const defer = (row: LaneRow): LaneGcOutcome => {
		const now = ctx.now();
		const kept = upkeep(ctx, row.id);
		const since = kept?.gc_deferred_since ?? now;
		const alert = (kept?.gc_alerted_at ?? null) === null &&
			now - since >= LANE_GC_DEFER_ALERT_MS;
		ctx.tx(() =>
			setUpkeep(ctx, row.id, {
				gc_deferred_since: since,
				...(alert ? { gc_alerted_at: now } : {}),
			})
		);
		if (alert) {
			ctx.ports.log("lane repo GC deferred for 24 h", { laneId: row.id });
			notifyOwner(
				ctx,
				row,
				"This landed lane's repository is kept because its change ref is not in the canonical repository yet; an Owner should check the landing.",
				"lane-gc-deferred",
			);
		}
		return { deleted: false, reason: "change-ref-missing" };
	};

	/** `LaneBackend.gc` of a `repo` lane, at `expectHead` only. */
	const gc = async (
		row: LaneRow,
		expectHead: string,
	): Promise<LaneGcOutcome> => {
		const name = row.repo_name;
		if (row.mode !== "repo" || name === null) {
			return { deleted: false, reason: "missing" };
		}
		if (row.seed_ms === null) {
			// Never opened (closed while `opening`): nothing was ever handed out.
			const existed = await deleteLaneRepo(ctx, {
				name,
				laneId: row.id,
				purpose: "lane-delete",
				expectOld: ZERO_SHA,
				ownerId: `lane-gc:${row.id}`,
			});
			return existed
				? { deleted: true }
				: { deleted: false, reason: "missing" };
		}
		const ready = changeRefReady(row);
		if (ready === false) return defer(row);
		const tip = await readTip(ctx, name);
		if (tip === null) {
			ctx.access.forget(name);
			return { deleted: false, reason: "missing" };
		}
		if (expectHead === ZERO_SHA || tip !== expectHead) {
			return { deleted: false, reason: "head-moved" };
		}
		const existed = await deleteLaneRepo(ctx, {
			name,
			laneId: row.id,
			purpose: "lane-delete",
			expectOld: tip,
			ownerId: `lane-gc:${row.id}`,
		});
		ctx.tx(() => setUpkeep(ctx, row.id, { gc_deferred_since: null }));
		return existed ? { deleted: true } : { deleted: false, reason: "missing" };
	};

	/**
	 * Archive on the `repo` backend, after K16 and WP10's advisory gates: the
	 * lane repo is the attic until now + the attic retention, or it is deleted
	 * at once on a veto or while the forge is at its lane-repo ceiling.
	 */
	const archive = async (
		laneId: string,
		o: { readonly vetoed: boolean },
	): Promise<ArchiveResult> => {
		if (!isIdOf("lane", laneId)) throw invalid(`not a lane id: ${laneId}`);
		const row = laneOf(ctx, laneId);
		if (row === null) throw notFound(`unknown lane: ${laneId}`);
		if (row.mode !== "repo" || row.repo_name === null) {
			throw conflict(`lane ${laneId} has no lane repo`);
		}
		const atCeiling = o.vetoed ? false : await ctx.deps.forgeTree()
			.countLaneRepos()
			.then((c) => c.retained >= c.max)
			.catch(() => false);
		const head = row.head_sha;
		if (o.vetoed || atCeiling || head === null) {
			await deleteLaneRepo(ctx, {
				name: row.repo_name,
				laneId,
				purpose: "lane-delete",
				expectOld: head ?? ZERO_SHA,
				ownerId: `archive:${laneId}`,
			});
			ctx.tx(() =>
				ctx.sql.exec(
					"UPDATE lanes SET delete_after = ? WHERE id = ?",
					ctx.now(),
					laneId,
				)
			);
			return { kind: "summary" };
		}
		const until = ctx.now() + atticRetentionMs(ctx);
		ctx.tx(() =>
			ctx.sql.exec(
				"UPDATE lanes SET delete_after = ? WHERE id = ?",
				until,
				laneId,
			)
		);
		return { kind: "lane", laneId, head, until };
	};

	/** An Owner's purge (after K16 `purge`): the lane repo goes at once. */
	const purge = async (laneId: string): Promise<void> => {
		if (!isIdOf("lane", laneId)) throw invalid(`not a lane id: ${laneId}`);
		const row = laneOf(ctx, laneId);
		if (row === null) throw notFound(`unknown lane: ${laneId}`);
		if (row.mode !== "repo" || row.repo_name === null) return;
		let tip: string | null = null;
		try {
			tip = await readTip(ctx, row.repo_name);
		} catch (error) {
			ctx.ports.log("purge: lane repo unreadable", {
				laneId,
				error: errorText(error),
			});
		}
		await deleteLaneRepo(ctx, {
			name: row.repo_name,
			laneId,
			purpose: "purge",
			expectOld: tip ?? ZERO_SHA,
			ownerId: `purge:${laneId}`,
		});
	};

	return { gc, archive, purge };
};
