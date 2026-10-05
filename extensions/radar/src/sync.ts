// Event handlers. Every handler is idempotent and replay-safe: it gathers facts
// through caps first, then changes state and plans its effects in one
// transaction, then flushes the outbox.
//
// - `lane.opened`: the lane joins the projection with its footprint;
//   declared overlaps are recorded and the other owners told. An `opening`
//   lane is never projected (no touches, no conflict until `lane.opened`).
// - `push.diffed`: the lane's touches become its range `rangeBase..after`
//   (K17): the event's paths when it carries a `diffKey`, else
//   `caps.repo.laneRange` + `caps.repo.diffPaths` over that range (never
//   `before..after`). A stale event (the lane moved on) is skipped.
// - `ref.advanced`: landings are recorded in trunk order; the landed lanes'
//   conflicts clear (`materialized` when still open) and every active lane
//   touching a landed path gets `trunk_drift`.
// - `lane.closed/lost/archived/deleted`: the lane leaves the joins.
// - `changes.submitted/abandoned/superseded`: the change map and the
//   submitted state (suggestions name a lane that is ahead).

import type { Envelope, ExtCtx, Footprint, Lane } from "@tartan/contract";
import { type Db, db } from "@tartan/ext-api";
import { analyzeLane, driftFindings, pairFindings } from "./analyze.ts";
import {
	ensureRepoMeta,
	fetchLane,
	gatherLane,
	isActiveLaneState,
	projectState,
	repoIdOf,
	rootsAt,
	textEnv,
} from "./facts.ts";
import { ACTIVE_SQL, isCounted, type LaneRow } from "./model.ts";
import { flushOutbox } from "./outbox.ts";
import { projectOf } from "./paths.ts";
import {
	type Change,
	clearRow,
	planEffects,
	reconcileLane,
	type Run,
} from "./reconcile.ts";
import {
	addStat,
	dropTouches,
	getLane,
	getMeta,
	isActive,
	laneByChange,
	liveConflictsOf,
	recordLanding,
	replaceTouches,
	setFootprint,
	setLaneState,
	type Touch,
	touchesOf,
	upsertLane,
} from "./store.ts";

const runOf = (x: ExtCtx, d: Db, repoId: string): Run => ({
	d,
	now: x.caps.clock.now(),
	ulid: () => x.caps.ids.ulid(),
	repoId,
	env: textEnv(x, d),
});

type LaneEventData = {
	readonly laneId: string;
	readonly owner: string;
	readonly entity?: { readonly kind: string; readonly id: string };
	readonly base: string;
	readonly head?: string;
	readonly footprint?: Footprint;
	readonly mode: string;
};

type PushDiffedData = {
	readonly pushId: string;
	readonly target: string;
	readonly ref: string;
	readonly after: string;
	readonly rangeBase: string;
	readonly rangeTruncated: boolean;
	readonly commits: readonly { readonly sha: string }[];
	readonly paths: readonly string[];
	readonly truncated: boolean;
	readonly diffKey?: string;
};

type RefAdvancedData = {
	readonly ref: string;
	readonly old: string;
	readonly new: string;
	readonly advanceId: string;
	readonly changes: readonly {
		readonly changeId: string;
		readonly laneId: string;
		readonly commit: string;
	}[];
};

/** Recomputes one lane against everything and records the effects. */
const analyzeAndPlan = (run: Run, laneId: string): Change[] => {
	const lane = getLane(run.d, laneId);
	if (lane === null) return [];
	const changes = reconcileLane(run, lane, analyzeLane(run.d, laneId), {
		scope: "all",
		avoidable: true,
	});
	planEffects(run, lane, changes);
	return changes;
};

// ---------------------------------------------------------------------------
// lane.opened
// ---------------------------------------------------------------------------

const onLaneOpened = async (ev: Envelope, x: ExtCtx, d: Db): Promise<void> => {
	const data = ev.data as LaneEventData;
	const repoId = repoIdOf(x, ev.repo);
	await ensureRepoMeta(x, d, repoId);
	const { facts, footprint } = await gatherLane(x, {
		laneId: data.laneId,
		owner: data.owner,
		entity: data.entity,
		base: data.base,
		head: data.head,
		mode: data.mode,
		state: "open",
		footprint: data.footprint,
		openedAt: ev.at,
	});
	if (!isActiveLaneState(facts.state)) return;
	const run = runOf(x, d, repoId);
	d.tx(() => {
		upsertLane(d, facts);
		setFootprint(d, data.laneId, footprint);
		const lane = getLane(d, data.laneId)!;
		const changes = reconcileLane(
			run,
			lane,
			[...pairFindings(d, lane), ...driftFindings(d, lane)],
			{ scope: "all", avoidable: true },
		);
		planEffects(run, lane, changes);
	});
};

// ---------------------------------------------------------------------------
// push.diffed
// ---------------------------------------------------------------------------

type Range = {
	readonly head: string;
	readonly rangeBase: string;
	readonly rangeTruncated: boolean;
	readonly truncated: boolean;
	readonly paths: readonly {
		readonly path: string;
		readonly change: string;
		readonly project?: string;
	}[];
};

/**
 * The lane range of this push (K17): the event's own diff when it names one,
 * else the lane's current range through caps. Null when the push is stale.
 */
const rangeOf = async (
	x: ExtCtx,
	repoId: string,
	laneId: string,
	data: PushDiffedData,
): Promise<Range | null> => {
	if (data.diffKey) {
		return {
			head: data.after,
			rangeBase: data.rangeBase,
			rangeTruncated: data.rangeTruncated,
			truncated: data.truncated,
			paths: data.paths.map((path) => ({ path, change: "changed" })),
		};
	}
	const range = await x.caps.repo.laneRange(laneId);
	if (range.head !== data.after) return null;
	const diff = await x.caps.repo.diffPaths(
		{ repoId, laneId },
		range.rangeBase,
		range.head,
	);
	return {
		head: range.head,
		rangeBase: range.rangeBase,
		rangeTruncated: range.rangeTruncated,
		truncated: diff.truncated,
		// A rename touches both its old and its new path.
		paths: diff.paths.flatMap((p) => [
			...(p.oldPath ? [{ path: p.oldPath, change: "deleted" }] : []),
			{
				path: p.path,
				change: p.change,
				...(p.project !== undefined ? { project: p.project } : {}),
			},
		]),
	};
};

const onPushDiffed = async (ev: Envelope, x: ExtCtx, d: Db): Promise<void> => {
	const data = ev.data as PushDiffedData;
	if (data.target === "repo") return; // a human branch or trunk: not a lane
	const laneId = data.target;
	const known = getLane(d, laneId);
	if (known?.touches_at === data.after) return; // already at this head
	const repoId = repoIdOf(x, ev.repo);
	await ensureRepoMeta(x, d, repoId);
	const lane: Lane | null = await fetchLane(x, laneId);
	if (lane !== null) {
		if (!isActiveLaneState(lane.state)) {
			if (known !== null && known.state !== projectState(lane.state)) {
				d.tx(() => setLaneState(d, laneId, projectState(lane.state)));
			}
			return; // `opening`, or ended: no touches
		}
		if (lane.head !== undefined && lane.head !== data.after) return; // stale
	} else if (known === null) {
		x.log.warn(`radar: push.diffed for unknown lane ${laneId}`);
		return;
	}
	const range = await rangeOf(x, repoId, laneId, data);
	if (range === null) return;
	const gathered = known === null || known.owner_label === null
		? await gatherLane(x, {
			laneId,
			owner: lane?.owner ?? known!.owner,
			base: range.rangeBase,
			head: range.head,
			mode: lane?.mode ?? known!.mode,
			state: lane?.state ?? known!.state,
			openedAt: lane?.createdAt ?? ev.at,
		}, lane)
		: null;
	const roots = await rootsAt(x, d, repoId, range.rangeBase);
	const touches: Touch[] = range.paths.map((p) => ({
		path: p.path,
		project: p.project ?? projectOf(roots, p.path),
		change: p.change,
	}));
	const run = runOf(x, d, repoId);
	d.tx(() => {
		if (gathered !== null) {
			upsertLane(d, gathered.facts);
			if (known === null) setFootprint(d, laneId, gathered.footprint);
		} else if (lane !== null) {
			setLaneState(d, laneId, projectState(lane.state));
		}
		replaceTouches(d, laneId, touches, {
			head: range.head,
			rangeBase: range.rangeBase,
			rangeTruncated: range.rangeTruncated,
			commits: data.commits.map((c) => c.sha),
			truncated: range.truncated,
			at: ev.at,
		});
		analyzeAndPlan(run, laneId);
	});
};

// ---------------------------------------------------------------------------
// ref.advanced
// ---------------------------------------------------------------------------

/** A landed lane leaves the joins; its live file overlaps (open or acked) materialized. */
const landLane = (run: Run, lane: LaneRow): Change[] => {
	const changes: Change[] = [];
	for (const row of liveConflictsOf(run.d, lane.lane_id)) {
		if (isCounted(row.severity)) {
			addStat(run.d, "materialized");
		}
		changes.push(clearRow(run, row, false));
	}
	setLaneState(run.d, lane.lane_id, "landed");
	dropTouches(run.d, lane.lane_id);
	run.d.run("DELETE FROM footprints WHERE lane_id = ?", lane.lane_id);
	return changes;
};

const onRefAdvanced = async (ev: Envelope, x: ExtCtx, d: Db): Promise<void> => {
	const data = ev.data as RefAdvancedData;
	const repoId = repoIdOf(x, ev.repo);
	await ensureRepoMeta(x, d, repoId);
	// Only trunk advances move lanes' bases (when the trunk branch is known).
	const trunk = getMeta(d, "default_branch");
	if (trunk !== null && data.ref !== `refs/heads/${trunk}`) return;
	const roots = await rootsAt(x, d, repoId, data.old);
	// Paths of each landed change: the lane's touches, else the landed commit's
	// own diff against its parent in the batch (changes land in order).
	const landed: {
		change: RefAdvancedData["changes"][number];
		parent: string;
		paths: { path: string; project: string | null }[];
	}[] = [];
	let parent = data.old;
	for (const change of data.changes) {
		const lane = getLane(d, change.laneId);
		let paths = lane?.touches_at ? touchesOf(d, change.laneId) : null;
		if (paths === null || paths.length === 0) {
			try {
				const diff = await x.caps.repo.diffPaths(
					{ repoId },
					parent,
					change.commit,
				);
				paths = diff.paths.map((p) => ({
					path: p.path,
					project: p.project ?? projectOf(roots, p.path),
				}));
			} catch {
				paths = paths ?? [];
			}
		}
		landed.push({ change, parent, paths });
		parent = change.commit;
	}
	const run = runOf(x, d, repoId);
	d.tx(() => {
		const seqs: number[] = [];
		for (const l of landed) {
			const seq = recordLanding(d, {
				advanceId: data.advanceId,
				laneId: l.change.laneId,
				changeId: l.change.changeId,
				commit: l.change.commit,
				trunk: data.new,
				old: l.parent,
				at: ev.at,
			}, l.paths);
			if (seq === null) continue;
			seqs.push(seq);
			const lane = getLane(d, l.change.laneId);
			if (lane !== null && lane.state !== "landed") {
				planEffects(run, lane, landLane(run, lane));
			}
		}
		if (seqs.length === 0) return;
		const drifted = d.all<{ lane_id: string }>(
			`SELECT DISTINCT t.lane_id AS lane_id FROM touches t
			JOIN landed_paths lp ON lp.path = t.path
			JOIN lanes l ON l.lane_id = t.lane_id
			WHERE lp.seq IN (SELECT value FROM json_each(?)) AND l.state IN ${ACTIVE_SQL}`,
			JSON.stringify(seqs),
		);
		for (const { lane_id } of drifted) {
			const lane = getLane(d, lane_id)!;
			const changes = reconcileLane(run, lane, driftFindings(d, lane), {
				scope: "trunk",
				avoidable: false,
			});
			planEffects(run, lane, changes);
		}
	});
};

// ---------------------------------------------------------------------------
// lane end, changes
// ---------------------------------------------------------------------------

const END_STATE: Readonly<Record<string, string>> = {
	"lane.closed": "closed",
	"lane.lost": "lost",
	"lane.archived": "archived",
	"lane.deleted": "deleted",
};

const onLaneEnded = (ev: Envelope, x: ExtCtx, d: Db): void => {
	const { laneId } = ev.data as { laneId: string };
	const lane = getLane(d, laneId);
	if (lane === null) return;
	const state = END_STATE[ev.type];
	if (lane.state === state) return;
	if (lane.state === "landed") {
		// Its conflicts cleared when it landed; only the state moves on.
		d.tx(() => setLaneState(d, laneId, state));
		return;
	}
	const run = runOf(x, d, repoIdOf(x, ev.repo));
	d.tx(() => {
		// Closed or archived before landing: the overlap never reached trunk
		// (avoided when its owners had been told). A lost lease is no resolution.
		const avoidable = ev.type !== "lane.lost";
		const changes = liveConflictsOf(d, laneId).map((row) =>
			clearRow(run, row, avoidable)
		);
		setLaneState(d, laneId, state);
		if (ev.type !== "lane.lost") {
			dropTouches(d, laneId);
			d.run("DELETE FROM footprints WHERE lane_id = ?", laneId);
		}
		planEffects(run, lane, changes);
	});
};

const onChangeEvent = (ev: Envelope, d: Db): void => {
	const data = ev.data as { changeId: string; laneId?: string };
	const lane = data.laneId
		? getLane(d, data.laneId)
		: laneByChange(d, data.changeId);
	if (lane === null) return;
	d.tx(() => {
		if (ev.type === "changes.submitted") {
			d.run(
				`UPDATE lanes SET change_id = ?, state = CASE WHEN state = 'open' THEN 'submitted' ELSE state END
				WHERE lane_id = ?`,
				data.changeId,
				lane.lane_id,
			);
		} else if (lane.state === "submitted") {
			setLaneState(d, lane.lane_id, "open");
		}
	});
};

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

const HANDLERS: Readonly<
	Record<string, (ev: Envelope, x: ExtCtx, d: Db) => Promise<void> | void>
> = {
	"lane.opened": onLaneOpened,
	"push.diffed": onPushDiffed,
	"ref.advanced": onRefAdvanced,
	"lane.closed": onLaneEnded,
	"lane.lost": onLaneEnded,
	"lane.archived": onLaneEnded,
	"lane.deleted": onLaneEnded,
	"changes.submitted": (ev, _x, d) => onChangeEvent(ev, d),
	"changes.abandoned": (ev, _x, d) => onChangeEvent(ev, d),
	"changes.superseded": (ev, _x, d) => onChangeEvent(ev, d),
};

/**
 * Handles one event, then flushes the outbox, including entries an earlier
 * run left behind (a retried event finds its state already applied and
 * returns early; its effects still go out here).
 */
export const handleEvent = async (ev: Envelope, x: ExtCtx): Promise<void> => {
	const d = db(x.sql);
	await HANDLERS[ev.type]?.(ev, x, d);
	await flushOutbox(x, d);
};

/**
 * Activation: active lanes that opened before the installation join the
 * projection with their footprints (their touches arrive with their next
 * push). Best effort.
 */
export const seedLanes = async (x: ExtCtx): Promise<void> => {
	const d = db(x.sql);
	const repoId = repoIdOf(x);
	if (repoId === "") return;
	await ensureRepoMeta(x, d, repoId);
	let lanes: Lane[];
	try {
		lanes = await x.caps.lanes.list({
			repo: { id: repoId },
			state: ["open", "submitted", "landing"],
		});
	} catch (error) {
		x.log.warn("radar: could not list lanes at activation", {
			error: error instanceof Error ? error.message : String(error),
		});
		return;
	}
	d.tx(() => {
		for (const lane of lanes) {
			if (getLane(d, lane.id) !== null) continue;
			upsertLane(d, {
				laneId: lane.id,
				owner: lane.owner,
				entityKind: lane.entity?.kind ?? null,
				entityId: lane.entity?.id ?? null,
				base: lane.base,
				head: lane.head ?? null,
				state: projectState(lane.state),
				mode: lane.mode,
				ref: lane.ref,
				remote: lane.remote,
				openedAt: lane.createdAt,
			});
			setFootprint(d, lane.id, lane.footprint);
		}
	});
};

export const handleTimer = async (key: string, x: ExtCtx): Promise<void> => {
	if (key === "flush") await flushOutbox(x, db(x.sql));
};

export { isActive };
