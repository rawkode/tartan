// Applies one lane's findings to the `conflicts` table:
// upsert by `(a, b, path)`, escalate, clear what no longer holds, keep the
// stats, and plan the effects (events and owner notices) into the outbox in
// the same transaction. Synchronous: the caller runs it inside `db.tx`.
//
// Keys: a lane pair is stored with `a < b`; trunk drift as `(lane, trunk)`.
// Stats (CK metric): `predicted` counts each detection of a
// file overlap (`same_file` and above); `avoided` counts such a conflict
// cleared before either lane landed, after its owners were told;
// `materialized` counts one still live (open or acked) when a lane landed.
// Notices are deduplicated per severity: a row is announced once per
// severity it reaches (`notified` holds the rank last announced).

import { type Db, json } from "@tartan/ext-api";
import type { Finding } from "./analyze.ts";
import {
	type ConflictRow,
	EXT_SHORT,
	isCounted,
	isEventful,
	type LaneRow,
	MAX_NOTICE_ITEMS,
	MAX_NOTIFY_PEERS,
	SEVERITY_RANK,
	TRUNK,
} from "./model.ts";
import { fnv64 } from "./paths.ts";
import {
	addStat,
	conflictByKey,
	enqueue,
	getLanes,
	liveConflictsOf,
} from "./store.ts";
import {
	type NoticeItem,
	peerNotice,
	selfNotice,
	sideOf,
	suggest,
	type TextEnv,
} from "./texts.ts";
import type { ConflictSeverity, Suggestion } from "./types.ts";

export type Run = {
	readonly d: Db;
	readonly now: number;
	readonly ulid: () => string;
	readonly repoId: string;
	readonly env: TextEnv;
};

export type ChangeKind = "detected" | "escalated" | "cleared" | "kept";

export type Change = {
	readonly kind: ChangeKind;
	/** The row after the change. */
	readonly row: ConflictRow;
	readonly from?: ConflictSeverity;
	/** Not yet announced at this severity. */
	readonly announce: boolean;
};

export const pairKey = (
	laneId: string,
	other: string,
): { a: string; b: string } =>
	other === TRUNK
		? { a: laneId, b: TRUNK }
		: laneId < other
		? { a: laneId, b: other }
		: { a: other, b: laneId };

/** Which existing rows of the lane a run may clear. */
export type Scope = "all" | "trunk" | "pairs";

const inScope = (row: ConflictRow, scope: Scope): boolean =>
	scope === "all" ||
	(scope === "trunk" ? row.b === TRUNK : row.b !== TRUNK);

const loadRow = (d: Db, id: string): ConflictRow =>
	d.one<ConflictRow>("SELECT * FROM conflicts WHERE id = ?", id);

/**
 * Upserts `findings` for `lane` and clears its rows in `scope` that no
 * longer hold. `avoidable`: a cleared, announced file overlap counts as
 * avoided (false when the clear is caused by a landing).
 */
export const reconcileLane = (
	run: Run,
	lane: LaneRow,
	findings: readonly Finding[],
	options: { readonly scope: Scope; readonly avoidable: boolean },
): Change[] => {
	const { d, now } = run;
	const changes: Change[] = [];
	const others = getLanes(
		d,
		[...new Set(findings.map((f) => f.other).filter((o) => o !== TRUNK))],
	);
	const seen = new Set<string>();
	for (const f of findings) {
		const { a, b } = pairKey(lane.lane_id, f.other);
		const other = f.other === TRUNK ? null : others.get(f.other) ?? null;
		const suggestion = suggest(f.severity, lane, other);
		const rank = SEVERITY_RANK[f.severity];
		const existing = conflictByKey(d, a, b, f.path);
		let kind: ChangeKind;
		let from: ConflictSeverity | undefined;
		let id: string;
		if (existing === null) {
			id = `cf_${run.ulid()}`;
			d.run(
				`INSERT INTO conflicts (id, a, b, path, project, severity, detail_json, suggestion, state, notified,
					first_seen, last_seen)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', 0, ?, ?)`,
				id,
				a,
				b,
				f.path,
				f.project,
				f.severity,
				json.encode(f.detail),
				suggestion,
				now,
				now,
			);
			kind = "detected";
		} else if (existing.state === "cleared") {
			id = existing.id;
			d.run(
				`UPDATE conflicts SET state = 'open', severity = ?, project = ?, detail_json = ?, suggestion = ?,
					notified = 0, ack_json = NULL, cleared_at = NULL, avoided = NULL, last_seen = ?
				WHERE id = ?`,
				f.severity,
				f.project,
				json.encode(f.detail),
				suggestion,
				now,
				id,
			);
			kind = "detected";
		} else {
			id = existing.id;
			const before = SEVERITY_RANK[existing.severity];
			const escalated = rank > before;
			d.run(
				`UPDATE conflicts SET severity = ?, project = ?, detail_json = ?, suggestion = ?, last_seen = ?,
					state = CASE WHEN ? THEN 'open' ELSE state END
				WHERE id = ?`,
				f.severity,
				f.project,
				json.encode(f.detail),
				suggestion,
				now,
				escalated ? 1 : 0,
				id,
			);
			kind = escalated ? "escalated" : "kept";
			if (escalated) from = existing.severity;
		}
		if (kind === "detected" && isCounted(f.severity)) addStat(d, "predicted");
		if (
			kind === "escalated" && isCounted(f.severity) && from !== undefined &&
			!isCounted(from)
		) addStat(d, "predicted");
		seen.add(id);
		const row = loadRow(d, id);
		changes.push({
			kind,
			row,
			from,
			announce: row.state === "open" && rank > row.notified,
		});
	}
	for (const row of liveConflictsOf(d, lane.lane_id)) {
		if (seen.has(row.id) || !inScope(row, options.scope)) continue;
		changes.push(clearRow(run, row, options.avoidable));
	}
	return changes;
};

/** Clears one live row; `avoidable` as in `reconcileLane`. */
export const clearRow = (
	run: Run,
	row: ConflictRow,
	avoidable: boolean,
): Change => {
	const avoided = avoidable && isCounted(row.severity) && row.notified > 0;
	run.d.run(
		"UPDATE conflicts SET state = 'cleared', cleared_at = ?, avoided = ? WHERE id = ?",
		run.now,
		avoided ? 1 : 0,
		row.id,
	);
	if (avoided) addStat(run.d, "avoided");
	return {
		kind: "cleared",
		row: loadRow(run.d, row.id),
		announce: false,
	};
};

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

export type EmitBody = {
	readonly type: string;
	readonly data: Record<string, unknown>;
	readonly subject: { readonly kind: "conflict"; readonly id: string };
	readonly correlation?: string;
};

export type NotifyBody = {
	readonly principal: string;
	readonly notice: {
		readonly repo: { readonly id: string };
		readonly laneId?: string;
		readonly kind: "conflict" | "trunk_drift";
		readonly severity: "info" | "warn";
		readonly text: string;
		readonly data: Record<string, unknown>;
		readonly dedupeKey: string;
	};
};

const eventOf = (c: Change): EmitBody | null => {
	const { row } = c;
	if (!isEventful(row.severity)) return null;
	const subject = { kind: "conflict", id: row.id } as const;
	const correlation = `lane:${row.a}`;
	// A row that only now becomes eventful is new to every consumer.
	const kind = c.kind === "escalated" && c.from !== undefined &&
			!isEventful(c.from)
		? "detected"
		: c.kind;
	switch (kind) {
		case "detected":
			return {
				type: "conflicts.detected",
				data: {
					conflictId: row.id,
					a: row.a,
					b: row.b,
					path: row.path,
					severity: row.severity,
					suggestion: row.suggestion,
					...(row.project !== null ? { project: row.project } : {}),
				},
				subject,
				correlation,
			};
		case "escalated":
			return {
				type: "conflicts.escalated",
				data: { conflictId: row.id, from: c.from, to: row.severity },
				subject,
				correlation,
			};
		case "cleared":
			return {
				type: "conflicts.cleared",
				data: { conflictId: row.id, avoided: row.avoided === 1 },
				subject,
				correlation,
			};
		case "kept":
			return null;
	}
};

/** Who hears about a row at all: file overlaps, trunk drift, and declared (other side only). */
const notifiable = (s: ConflictSeverity): boolean =>
	isCounted(s) || s === "trunk_drift" || s === "declared";

const dedupeKey = (recipient: string, rows: readonly ConflictRow[]): string =>
	`${EXT_SHORT}:${
		fnv64(
			`${recipient}|${
				rows.map((r) => `${r.id}:${r.severity}`).sort().join(",")
			}`,
		)
	}`;

const byRank = (a: ConflictRow, b: ConflictRow): number =>
	SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
	(a.path < b.path ? -1 : 1);

/**
 * Plans events and notices for `changes` made on behalf of `trigger` (the
 * lane that pushed, opened or drifted) and marks what was announced.
 */
export const planEffects = (
	run: Run,
	trigger: LaneRow,
	changes: readonly Change[],
): void => {
	const { d, now } = run;
	for (const c of changes) {
		const ev = eventOf(c);
		if (ev) enqueue(d, `ev_${run.ulid()}`, "emit", ev, now);
	}
	const fresh = changes.filter((c) => c.announce && notifiable(c.row.severity))
		.map((c) => c.row);
	if (fresh.length === 0) return;
	const lanes = getLanes(d, [
		...new Set(fresh.flatMap((r) => [r.a, r.b]).filter((s) => s !== TRUNK)),
	]);
	const announced = new Set<string>();

	// The trigger's owner: file overlaps and drift (declared overlaps were in
	// its claim response already).
	const mine = fresh.filter((r) => r.severity !== "declared").sort(byRank);
	if (mine.length > 0) {
		const items: NoticeItem[] = mine.map((r) => {
			const otherId = sideOf(r, trigger.lane_id);
			return {
				severity: r.severity,
				path: r.path,
				other: otherId === TRUNK ? null : lanes.get(otherId) ?? null,
			};
		});
		const top = mine[0];
		const suggestion = top.suggestion;
		const body: NotifyBody = {
			principal: trigger.owner,
			notice: {
				repo: { id: run.repoId },
				laneId: trigger.lane_id,
				kind: mine.every((r) => r.b === TRUNK) ? "trunk_drift" : "conflict",
				severity: "warn",
				text: selfNotice(trigger, items, suggestion, run.env, MAX_NOTICE_ITEMS),
				data: {
					conflictId: top.id,
					conflictIds: mine.slice(0, 50).map((r) => r.id),
					suggestion,
					severity: top.severity,
				},
				dedupeKey: dedupeKey(trigger.owner, mine),
			},
		};
		enqueue(d, `nt_${run.ulid()}`, "notify", body, now);
		for (const r of mine) announced.add(r.id);
	}

	// Each other owner, once per peer lane, highest severity first.
	const byPeer = new Map<string, ConflictRow[]>();
	for (const r of fresh) {
		if (r.b === TRUNK) continue;
		const peer = sideOf(r, trigger.lane_id);
		byPeer.set(peer, [...(byPeer.get(peer) ?? []), r]);
	}
	const peers = [...byPeer].map(([peer, rows]) =>
		[peer, rows.sort(byRank)] as const
	)
		.sort(([, a], [, b]) => byRank(a[0], b[0]))
		.slice(0, MAX_NOTIFY_PEERS);
	for (const [peerId, rows] of peers) {
		const peer = lanes.get(peerId);
		if (!peer) continue;
		const top = rows[0];
		const suggestion: Suggestion = suggest(top.severity, peer, trigger);
		const counted = rows.some((r) => isCounted(r.severity));
		const body: NotifyBody = {
			principal: peer.owner,
			notice: {
				repo: { id: run.repoId },
				laneId: peer.lane_id,
				kind: "conflict",
				severity: counted ? "warn" : "info",
				text: peerNotice(
					peer,
					trigger,
					rows.map((r) => ({
						severity: r.severity,
						path: r.path,
						other: trigger,
					})),
					suggestion,
					run.env,
					MAX_NOTICE_ITEMS,
				),
				data: {
					conflictId: top.id,
					conflictIds: rows.slice(0, 50).map((r) => r.id),
					suggestion,
					severity: top.severity,
					other: trigger.lane_id,
				},
				dedupeKey: dedupeKey(peer.owner, rows),
			},
		};
		enqueue(d, `nt_${run.ulid()}`, "notify", body, now);
		for (const r of rows) announced.add(r.id);
	}

	for (const r of fresh) {
		if (!announced.has(r.id)) continue;
		d.run(
			"UPDATE conflicts SET notified = ? WHERE id = ? AND notified < ?",
			SEVERITY_RANK[r.severity],
			r.id,
			SEVERITY_RANK[r.severity],
		);
	}
};
