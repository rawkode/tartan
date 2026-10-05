// One ref transition `(repo, ref, before, after)` as the push log records it
// (K2, K3): the cross-channel merge rule, the row, the index or lane-head
// update it implies, and its `push.accepted`. Phase 1 of recording is I/O-free:
// nothing here reads Artifacts.

import {
	type AppendResult,
	LANE_LEASE_MS,
	LANE_REPO_HEAD_REF,
	ZERO_SHA,
} from "@tartan/contract";
import type {
	LaneRow,
	PushDiffState,
	PushRow,
	PushVia,
} from "@tartan/contract/kernel.ts";
import { DIFF_BACKSTOP_MS } from "../../constants.ts";
import { actorOf, type Core, emit, first, rows } from "./core.ts";
import {
	isResumable,
	laneEventData,
	laneRow,
	mayWriteLane,
} from "./lanes/rows.ts";
import {
	CANONICAL,
	type CasOutcome,
	casRef,
	isOlderTransition,
	laneRepoSide,
	type TransitionSide,
} from "./refs.ts";

/** The cross-channel merge window. */
export const MERGE_WINDOW_MS = 10 * 60 * 1000;

/** Channels whose report carries the pusher (they overwrite a trigger row's attribution). */
export const ATTRIBUTING: readonly PushVia[] = ["gateway", "swarm"];

export type Transition = {
	readonly side: TransitionSide;
	/** `"repo"` or a lane id. */
	readonly target: string;
	readonly ref: string;
	readonly before: string;
	readonly after: string;
};

export type SeenEntry = {
	readonly via: PushVia;
	readonly id: string | null;
	readonly at: number;
};

export const seenOf = (row: Pick<PushRow, "seen_via_json">): SeenEntry[] => {
	try {
		const parsed = JSON.parse(row.seen_via_json) as unknown;
		return Array.isArray(parsed) ? parsed as SeenEntry[] : [];
	} catch {
		return [];
	}
};

const seenBy = (row: PushRow, via: PushVia): boolean =>
	row.via === via || seenOf(row).some((entry) => entry.via === via);

export const pushRow = (sql: SqlStorage, id: string): PushRow | null =>
	first<PushRow>(sql, "SELECT * FROM pushes WHERE id = ?", id);

export const pushByRequest = (
	sql: SqlStorage,
	via: PushVia,
	requestId: string,
	ref: string,
): PushRow | null =>
	first<PushRow>(
		sql,
		"SELECT * FROM pushes WHERE via = ? AND request_id = ? AND ref = ?",
		via,
		requestId,
		ref,
	);

/** The side of a transition from a push row. */
export const sideOf = (row: Pick<PushRow, "repo_name">): TransitionSide =>
	row.repo_name === null ? CANONICAL : laneRepoSide(row.repo_name);

/**
 * The oldest row with the same transition within the window that `via`
 * has not reported yet (A→B, B→A, A→B are three rows; a channel's second A→B
 * merges into the second row).
 */
export const mergeCandidate = (
	core: Core,
	t: Transition,
	via: PushVia,
): PushRow | null =>
	rows<PushRow>(
		core.sql,
		`SELECT * FROM pushes WHERE ref = ? AND before = ? AND after = ? AND at >= ?
		 AND ${t.side.clause} ORDER BY at, id`,
		t.ref,
		t.before,
		t.after,
		core.clock.now() - MERGE_WINDOW_MS,
		...t.side.bindings,
	).find((row) => !seenBy(row, via)) ?? null;

export const addSeen = (
	core: Core,
	row: PushRow,
	entry: SeenEntry,
): void => {
	const seen = seenOf(row);
	if (seen.some((e) => e.via === entry.via && e.id === entry.id)) return;
	core.sql.exec(
		"UPDATE pushes SET seen_via_json = ? WHERE id = ?",
		JSON.stringify([...seen, entry]),
		row.id,
	);
};

export type NewPush = {
	readonly t: Transition;
	readonly via: PushVia;
	readonly requestId: string | null;
	readonly principal: string | null;
	readonly onBehalfOf?: string | null;
	readonly tokenId?: string | null;
	readonly bytes?: number | null;
	readonly kernelWriteId?: string | null;
	readonly diffState: PushDiffState;
	readonly seen?: readonly SeenEntry[];
};

/** Arms the `diff` timer (backstop) unless it fires earlier already. */
export const scheduleDiffTimer = (core: Core, at: number): void => {
	const current = core.timers.get("diff");
	if (current === null || current > at) core.timers.schedule("diff", at);
};

export const insertPush = (core: Core, input: NewPush): PushRow => {
	const id = `ps_${core.ids.ulid()}`;
	const now = core.clock.now();
	core.sql.exec(
		`INSERT INTO pushes (id, at, target, repo_name, bytes, ref, before, after, principal_id,
		   on_behalf_of, token_id, via, seen_via_json, request_id, kernel_write_id, diff_state)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id,
		now,
		input.t.target,
		input.t.side.repoName,
		input.bytes ?? null,
		input.t.ref,
		input.t.before,
		input.t.after,
		input.principal,
		input.onBehalfOf ?? null,
		input.tokenId ?? null,
		input.via,
		JSON.stringify(input.seen ?? []),
		input.requestId,
		input.kernelWriteId ?? null,
		input.diffState,
	);
	if (input.diffState === "pending") {
		scheduleDiffTimer(core, now + DIFF_BACKSTOP_MS);
	}
	return pushRow(core.sql, id) as PushRow;
};

/**
 * `push.accepted` for a row (slim). Keyed by the push id, so a second
 * call for the same row (a merge) returns the existing event.
 */
export const appendAccepted = (core: Core, row: PushRow): AppendResult =>
	emit(core, {
		type: "push.accepted",
		actor: actorOf(row.principal_id, row.on_behalf_of),
		...(row.target !== "repo"
			? { subject: { kind: "lane", id: row.target } }
			: {}),
		data: {
			pushId: row.id,
			target: row.target,
			ref: row.ref,
			before: row.before,
			after: row.after,
			via: row.via,
		},
		idemKey: `core:push:${row.id}:push.accepted`,
	});

/** True when `t` moves the head ref of lane `lane` (in the repo that holds it). */
export const movesLaneHead = (lane: LaneRow, t: Transition): boolean =>
	lane.mode === "branch"
		? t.side.repoName === null && t.ref === lane.ref
		: t.side.repoName !== null && t.side.repoName === lane.repo_name &&
			t.ref === LANE_REPO_HEAD_REF;

export type LaneHeadOutcome = CasOutcome;

/** The lane-head CAS. */
export const casLaneHead = (
	core: Core,
	lane: LaneRow,
	t: Transition,
): LaneHeadOutcome => {
	const current = lane.head_sha ?? ZERO_SHA;
	if (current === t.after) return "noop";
	const write = () =>
		core.sql.exec(
			"UPDATE lanes SET head_sha = ? WHERE id = ?",
			t.after === ZERO_SHA ? null : t.after,
			lane.id,
		);
	if (current === t.before) {
		write();
		return "applied";
	}
	if (isOlderTransition(core, t.side, t.ref, t.after, current)) return "older";
	write();
	return "missed";
};

export type ApplyResult = {
	/** The canonical index CAS, for canonical refs. */
	readonly ref: CasOutcome | null;
	/** The lane-head CAS, for lane heads. */
	readonly lane: LaneHeadOutcome | null;
};

/**
 * The state a recorded transition implies: the canonical index and,
 * for a lane head, `lanes.head_sha`. An attributing push by the lane's owner
 * or a delegate also counts the push, renews the lease, resumes a `lost`
 * lane within its window and clears a K2 quarantine (the owner re-attributed
 * the head).
 */
export const applyTransition = (
	core: Core,
	t: Transition,
	row: PushRow,
	options: { readonly attributedTo: string | null } = { attributedTo: null },
): ApplyResult => {
	const refOutcome = t.side.repoName === null
		? casRef(core, t.ref, t.before, t.after, row.id)
		: null;
	if (t.target === "repo") return { ref: refOutcome, lane: null };
	const lane = laneRow(core.sql, t.target);
	if (lane === null || !movesLaneHead(lane, t)) {
		return { ref: refOutcome, lane: null };
	}
	const laneOutcome = casLaneHead(core, lane, t);
	const pusher = options.attributedTo;
	if (pusher !== null && mayWriteLane(lane, pusher)) {
		const now = core.clock.now();
		const resume = lane.state === "lost" && isResumable(lane, now);
		core.sql.exec(
			`UPDATE lanes SET pushes = pushes + 1, last_push_at = ?, lease_expires_at = ?,
			   quarantined = 0, state = ? WHERE id = ?`,
			now,
			now + LANE_LEASE_MS,
			resume ? "open" : lane.state,
			lane.id,
		);
		if (lane.quarantined === 1) {
			core.sql.exec(
				"DELETE FROM pending_observations WHERE lane_id = ?",
				lane.id,
			);
		}
		if (resume) {
			const after = laneRow(core.sql, lane.id) as LaneRow;
			emit(core, {
				type: "lane.opened",
				actor: actorOf(pusher),
				subject: { kind: "lane", id: lane.id },
				data: laneEventData(after, { reason: "resumed" }),
			});
		}
	}
	return { ref: refOutcome, lane: laneOutcome };
};
