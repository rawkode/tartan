// tartan.changes event handlers:
//
// - `lane.opened` starts the lane's draft (never `lane.opening`, so a repo
//   lane that never opens has no change); `lane.closed` abandons a change
//   that was not landed;
// - `push.diffed` of a submitted lane adds a revision with `head = after`
//   and `base = rangeBase` (K17), when `after` is still the lane's head and
//   not already the latest revision (a submit right after the push recorded
//   it) ⇒ `changes.revised` (a new revision invalidates approvals, K4);
// - `review.decided` approves the revision and head it names; `queue.*` and
//   `land.*` move the state; `ref.advanced` (or `land.completed`) lands it
//   ⇒ `changes.landed{commit, advanceId}`.
//
// Handlers are idempotent: state checks guard every transition, timeline rows
// are keyed by event id, and emits come before writes so a retried handler
// re-emits under the same host idempotency key.

import {
	advanceId,
	type Envelope,
	type ExtCtx,
	isChangeId,
	WORK_REF_RE,
} from "@tartan/contract";
import {
	affectedOf,
	diffstatOf,
	emitChange,
	type RepoCtx,
	repoOf,
} from "./core.ts";
import {
	type ChangeRow,
	type ChangeState,
	createStore,
	FINAL,
	REVISABLE,
} from "./store.ts";
import { ensureDraft } from "./tools.ts";

type Data = Record<string, unknown>;
type Handler = (ev: Envelope<Data>, x: ExtCtx) => Promise<void>;

const str = (v: unknown): string | undefined =>
	typeof v === "string" && v !== "" ? v : undefined;
const num = (v: unknown): number | undefined =>
	typeof v === "number" && Number.isFinite(v) ? v : undefined;

const laneOpened: Handler = async (ev, x) => {
	const laneId = str(ev.data.laneId);
	const owner = str(ev.data.owner);
	if (laneId === undefined || owner === undefined) return;
	if (createStore(x.sql).changeByLane(laneId) !== null) return;
	const entity = ev.data.entity as { kind?: string; id?: string } | undefined;
	const workRef = entity?.kind === "work" && entity.id &&
			WORK_REF_RE.test(entity.id)
		? entity.id
		: undefined;

	const repo = await repoOf(x, ev.repo);
	await ensureDraft(x, repo, {
		laneId,
		owner,
		...(ev.actor.id === owner && ev.actor.onBehalfOf
			? { onBehalfOf: ev.actor.onBehalfOf }
			: {}),
		...(workRef ? { workRef } : {}),
		at: ev.at,
	});
};

/** A lane that closes takes its unlanded change with it. */
const laneClosed: Handler = async (ev, x) => {
	const laneId = str(ev.data.laneId);
	if (laneId === undefined) return;
	const store = createStore(x.sql);
	const row = store.changeByLane(laneId);
	if (row === null || row.state === "landing" || FINAL.includes(row.state)) {
		return;
	}
	const repo = await repoOf(x, ev.repo);
	const reason = str(ev.data.reason) ?? "lane closed";
	await emitChange(x, repo, row, "changes.abandoned", {
		changeId: row.change_id,
		laneId,
		reason,
	});
	store.db.tx(() => {
		store.setState(row.change_id, "abandoned", ev.at);
		store.note({
			id: ev.id,
			change_id: row.change_id,
			at: ev.at,
			kind: "abandoned",
			text: `abandoned: ${reason}`,
			actor: ev.actor.id,
			revision: null,
		});
	});
};

/** Phase 2 of a push to a submitted lane: a new revision (K4, K17). */
const pushDiffed: Handler = async (ev, x) => {
	const target = str(ev.data.target);
	const after = str(ev.data.after);
	const rangeBase = str(ev.data.rangeBase);
	if (
		target === undefined || target === "repo" || after === undefined ||
		rangeBase === undefined
	) {
		return;
	}
	const store = createStore(x.sql);
	const row = store.changeByLane(target);
	if (row === null || !REVISABLE.includes(row.state)) return;
	const latest = store.latest(row.change_id);
	if (latest?.head === after) return;
	const repo = await repoOf(x, ev.repo);
	// An older push whose phase 2 finished late is not a revision.
	const lane = await x.caps.lanes.get(target, { repo: { id: repo.id } });
	if (lane.head !== after) return;
	const n = (latest?.n ?? 0) + 1;
	const paths = Array.isArray(ev.data.paths) ? ev.data.paths.length : 0;
	const affected = await affectedOf(x, repo, target, rangeBase, after);
	const diffstat = await diffstatOf(x, repo, target, rangeBase, after, paths);
	await emitChange(x, repo, row, "changes.revised", {
		changeId: row.change_id,
		laneId: target,
		revision: n,
		head: after,
		base: rangeBase,
		affected,
		...(row.work_ref ? { workRef: row.work_ref } : {}),
	});
	store.db.tx(() => {
		store.insertRevision({
			changeId: row.change_id,
			n,
			head: after,
			base: rangeBase,
			affected,
			diffstat,
			at: ev.at,
		});
		store.setState(row.change_id, "submitted", ev.at);
		store.note({
			id: ev.id,
			change_id: row.change_id,
			at: ev.at,
			kind: "revised",
			text: `revision ${n} pushed at ${after.slice(0, 12)}${
				row.state === "submitted"
					? ""
					: ` (was ${row.state}; review starts again)`
			}`,
			actor: ev.actor.id,
			revision: n,
		});
	});
};

const changeFor = (x: ExtCtx, data: Data): ChangeRow | null => {
	const id = str(data.changeId);
	return id && isChangeId(id) ? createStore(x.sql).change(id) : null;
};

/** Moves a change from one of `from` to `to` with a timeline row (no event). */
const move = (
	x: ExtCtx,
	row: ChangeRow,
	from: readonly ChangeState[],
	to: ChangeState,
	ev: Envelope<Data>,
	text: string,
	suffix = "",
): void => {
	const store = createStore(x.sql);
	store.db.tx(() => {
		if (from.includes(row.state)) store.setState(row.change_id, to, ev.at);
		store.note({
			id: `${ev.id}${suffix}`,
			change_id: row.change_id,
			at: ev.at,
			kind: ev.type,
			text,
			actor: ev.actor.id,
			revision: num(ev.data.revision) ?? null,
		});
	});
};

const reviewDecided: Handler = async (ev, x) => {
	const row = changeFor(x, ev.data);
	if (row === null) return;
	const store = createStore(x.sql);
	const latest = store.latest(row.change_id);
	const revision = num(ev.data.revision);
	const head = str(ev.data.head);
	const decision = str(ev.data.decision);
	const current = latest !== null && latest.n === revision &&
		latest.head === head;
	store.setReview(row.change_id, {
		revision,
		head,
		decision,
		route: ev.data.route,
		decidedBy: ev.data.decidedBy,
		current,
	}, ev.at);
	if (!current) {
		move(x, row, [], row.state, ev, `review of revision ${revision} (stale)`);
		return;
	}
	if (decision === "approve") {
		move(x, row, ["submitted"], "approved", ev, `approved (${ev.data.route})`);
		return;
	}
	move(x, row, [], row.state, ev, "changes requested");
	try {
		const repo = await repoOf(x, ev.repo);
		await x.caps.notify.send(row.author_id, {
			repo: { id: repo.id },
			laneId: row.lane_id,
			kind: "review",
			severity: "warn",
			text: `Review requested changes on ${row.title} (revision ${revision}).`,
			data: { changeId: row.change_id, revision },
			dedupeKey: `review:${row.change_id}:${revision}`,
		});
	} catch (error) {
		x.log.warn("notify failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
};

const reviewRequested: Handler = (ev, x) => {
	const row = changeFor(x, ev.data);
	if (row !== null) {
		move(x, row, [], row.state, ev, "review routed to a human");
	}
	return Promise.resolve();
};

const queueEnqueued: Handler = (ev, x) => {
	const row = changeFor(x, ev.data);
	if (row !== null) {
		move(
			x,
			row,
			["approved", "ejected"],
			"queued",
			ev,
			`queued (${str(ev.data.partition) ?? "default"})`,
		);
	}
	return Promise.resolve();
};

const queueBatched: Handler = (ev, x) => {
	const ids = Array.isArray(ev.data.changes) ? ev.data.changes : [];
	for (const id of ids) {
		const row = changeFor(x, { changeId: id });
		if (row !== null) {
			move(
				x,
				row,
				[],
				row.state,
				ev,
				`batched in ${str(ev.data.batchId) ?? "a batch"}`,
				`:${row.change_id}`,
			);
		}
	}
	return Promise.resolve();
};

const queueEjected: Handler = (ev, x) => {
	const row = changeFor(x, ev.data);
	if (row !== null) {
		move(
			x,
			row,
			["approved", "queued", "landing"],
			"ejected",
			ev,
			`ejected: ${str(ev.data.reason) ?? "unknown"}`,
		);
	}
	return Promise.resolve();
};

const landSubmitted: Handler = (ev, x) => {
	const batchId = str(ev.data.batchId);
	const attempt = num(ev.data.attempt) ?? 1;
	const list = Array.isArray(ev.data.changes)
		? ev.data.changes as { changeId?: string }[]
		: [];
	const rows = list.map((c) => changeFor(x, { changeId: c.changeId }))
		.filter((r): r is ChangeRow => r !== null);
	if (batchId) {
		createStore(x.sql).recordBatch(
			batchId,
			attempt,
			rows.map((r) => r.change_id),
		);
	}
	for (const row of rows) {
		move(
			x,
			row,
			["approved", "queued"],
			"landing",
			ev,
			`landing in ${batchId ?? "a batch"} (attempt ${attempt})`,
			`:${row.change_id}`,
		);
	}
	return Promise.resolve();
};

const landNoted = (label: string): Handler => (ev, x) => {
	const row = changeFor(x, ev.data);
	if (row !== null) {
		move(
			x,
			row,
			[],
			row.state,
			ev,
			`${label}${str(ev.data.message) ? `: ${str(ev.data.message)}` : ""}`,
		);
	}
	return Promise.resolve();
};

/** A failed batch: its changes wait in the queue again (the Weave decides). */
const landFailed: Handler = (ev, x) => {
	const batchId = str(ev.data.batchId);
	if (batchId === undefined) return Promise.resolve();
	for (const id of createStore(x.sql).batchChanges(batchId)) {
		const row = createStore(x.sql).change(id);
		if (row !== null) {
			move(
				x,
				row,
				["landing"],
				"queued",
				ev,
				`batch ${batchId} failed (${str(ev.data.reason) ?? "error"})`,
				`:${id}`,
			);
		}
	}
	return Promise.resolve();
};

const landChange = async (
	x: ExtCtx,
	repo: RepoCtx,
	ev: Envelope<Data>,
	changeId: string,
	commit: string,
	advance: string,
): Promise<void> => {
	const store = createStore(x.sql);
	const row = store.change(changeId);
	if (row === null || FINAL.includes(row.state)) return;
	await emitChange(x, repo, row, "changes.landed", {
		changeId,
		laneId: row.lane_id,
		commit,
		advanceId: advance,
		...(row.work_ref ? { workRef: row.work_ref } : {}),
	}, `landed:${changeId}`);
	store.db.tx(() => {
		store.setLanded(changeId, commit, ev.at);
		store.note({
			id: `${ev.id}:${changeId}`,
			change_id: changeId,
			at: ev.at,
			kind: "landed",
			text: `landed as ${commit.slice(0, 12)} (${advance})`,
			actor: ev.actor.id,
			revision: null,
		});
	});
	try {
		await x.caps.notify.send(row.author_id, {
			repo: { id: repo.id },
			laneId: row.lane_id,
			kind: "system",
			severity: "info",
			text: `Landed: ${row.title} as ${commit.slice(0, 12)}.`,
			data: { changeId, commit },
			dedupeKey: `landed:${changeId}`,
		});
	} catch (error) {
		x.log.warn("notify failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
};

const refAdvanced: Handler = async (ev, x) => {
	const advance = str(ev.data.advanceId);
	const list = Array.isArray(ev.data.changes)
		? ev.data.changes as { changeId?: string; commit?: string }[]
		: [];
	if (advance === undefined || list.length === 0) return;
	const repo = await repoOf(x, ev.repo);
	for (const c of list) {
		if (c.changeId && isChangeId(c.changeId) && c.commit) {
			await landChange(x, repo, ev, c.changeId, c.commit, advance);
		}
	}
};

const landCompleted: Handler = async (ev, x) => {
	const batchId = str(ev.data.batchId);
	const attempt = num(ev.data.attempt);
	const landed = Array.isArray(ev.data.landed)
		? ev.data.landed as { changeId?: string; commit?: string }[]
		: [];
	if (batchId === undefined || attempt === undefined || landed.length === 0) {
		return;
	}
	let advance: string;
	try {
		advance = advanceId(batchId, attempt);
	} catch {
		return;
	}
	const repo = await repoOf(x, ev.repo);
	for (const c of landed) {
		if (c.changeId && isChangeId(c.changeId) && c.commit) {
			await landChange(x, repo, ev, c.changeId, c.commit, advance);
		}
	}
};

const HANDLERS: Readonly<Record<string, Handler>> = {
	"lane.opened": laneOpened,
	"lane.closed": laneClosed,
	"push.diffed": pushDiffed,
	"review.decided": reviewDecided,
	"review.requested": reviewRequested,
	"queue.enqueued": queueEnqueued,
	"queue.batched": queueBatched,
	"queue.ejected": queueEjected,
	"land.submitted": landSubmitted,
	"land.conflicted": landNoted("conflicted at land time"),
	"land.vetoed": landNoted("vetoed at land time"),
	"land.failed": landFailed,
	"land.completed": landCompleted,
	"ref.advanced": refAdvanced,
};

export const onEvent = async (ev: Envelope, x: ExtCtx): Promise<void> => {
	if (ev.shadow) return;
	await HANDLERS[ev.type]?.(ev as Envelope<Data>, x);
};
