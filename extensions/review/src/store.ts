// tartan.review storage (`migrations/0001_init.sql`, `0002_flow.sql`).

import type { Sql } from "@tartan/contract";
import { db, json } from "@tartan/ext-api";
import type { OwnerRule } from "./owners.ts";

export type ChangeRow = {
	readonly changeId: string;
	readonly laneId: string;
	readonly authorId: string;
	readonly onBehalfOf: string | null;
	readonly workRef: string | null;
	readonly revision: number;
	readonly head: string;
	readonly base: string;
	readonly state: string;
	readonly updatedAt: number;
};

export type ReviewRow = {
	readonly changeId: string;
	readonly n: number;
	readonly head: string | null;
	readonly risk: number;
	readonly factors: Readonly<Record<string, number>>;
	readonly route: "auto" | "human";
	readonly decision: "approve" | "request_changes" | null;
	readonly decidedBy: string | null;
	readonly decidedKind: string | null;
	readonly evidence: Record<string, unknown>;
	readonly shadow: boolean;
	readonly ci: string | null;
	readonly notified: boolean;
	readonly at: number;
};

type RawReview = {
	change_id: string;
	n: number;
	head: string | null;
	risk: number;
	factors_json: string;
	route: string;
	decision: string | null;
	decided_by: string | null;
	decided_kind: string | null;
	evidence_json: string;
	shadow: number;
	ci: string | null;
	notified: number;
	at: number;
};

const toReview = (r: RawReview): ReviewRow => ({
	changeId: r.change_id,
	n: r.n,
	head: r.head,
	risk: r.risk,
	factors: json.decode(r.factors_json, {}),
	route: r.route as "auto" | "human",
	decision: r.decision as ReviewRow["decision"],
	decidedBy: r.decided_by,
	decidedKind: r.decided_kind,
	evidence: json.decode(r.evidence_json, {}),
	shadow: r.shadow === 1,
	ci: r.ci,
	notified: r.notified === 1,
	at: r.at,
});

type RawChange = {
	change_id: string;
	lane_id: string;
	author_id: string;
	on_behalf_of: string | null;
	work_ref: string | null;
	revision: number;
	head: string;
	base: string;
	state: string;
	updated_at: number;
};

const toChange = (r: RawChange): ChangeRow => ({
	changeId: r.change_id,
	laneId: r.lane_id,
	authorId: r.author_id,
	onBehalfOf: r.on_behalf_of,
	workRef: r.work_ref,
	revision: r.revision,
	head: r.head,
	base: r.base,
	state: r.state,
	updatedAt: r.updated_at,
});

export type Track = {
	readonly landed: number;
	readonly ejected: number;
	readonly vetoed: number;
	readonly reverted: number;
};

export const createStore = (sql: Sql) => {
	const d = db(sql);

	const change = (id: string): ChangeRow | null => {
		const r = d.first<RawChange>(
			"SELECT * FROM changes WHERE change_id = ?",
			id,
		);
		return r ? toChange(r) : null;
	};

	const writeChange = (c: ChangeRow): void => {
		d.run(
			`INSERT INTO changes (change_id, lane_id, author_id, on_behalf_of, work_ref, revision, head, base, state, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (change_id) DO UPDATE SET lane_id = excluded.lane_id, author_id = excluded.author_id,
			   on_behalf_of = excluded.on_behalf_of, work_ref = excluded.work_ref, revision = excluded.revision,
			   head = excluded.head, base = excluded.base, state = excluded.state, updated_at = excluded.updated_at`,
			c.changeId,
			c.laneId,
			c.authorId,
			c.onBehalfOf,
			c.workRef,
			c.revision,
			c.head,
			c.base,
			c.state,
			c.updatedAt,
		);
	};

	const setChangeState = (id: string, state: string, at: number): void => {
		d.run(
			"UPDATE changes SET state = ?, updated_at = ? WHERE change_id = ?",
			state,
			at,
			id,
		);
	};

	const review = (
		changeId: string,
		n: number,
		shadow: boolean,
	): ReviewRow | null => {
		const r = d.first<RawReview>(
			"SELECT * FROM reviews WHERE change_id = ? AND n = ? AND shadow = ?",
			changeId,
			n,
			shadow ? 1 : 0,
		);
		return r ? toReview(r) : null;
	};

	const writeReview = (r: ReviewRow): void => {
		d.run(
			`INSERT INTO reviews (change_id, n, risk, factors_json, route, decision, decided_by, evidence_json, shadow, at, head, decided_kind, ci, notified)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (change_id, n, shadow) DO UPDATE SET risk = excluded.risk, factors_json = excluded.factors_json,
			   route = excluded.route, decision = excluded.decision, decided_by = excluded.decided_by,
			   evidence_json = excluded.evidence_json, at = excluded.at, head = excluded.head,
			   decided_kind = excluded.decided_kind, ci = excluded.ci, notified = excluded.notified`,
			r.changeId,
			r.n,
			r.risk,
			json.encode(r.factors),
			r.route,
			r.decision,
			r.decidedBy,
			json.encode(r.evidence),
			r.shadow ? 1 : 0,
			r.at,
			r.head,
			r.decidedKind,
			r.ci,
			r.notified ? 1 : 0,
		);
	};

	/** A user's approval of exactly `head` (human-required gate). */
	const userApproval = (changeId: string, head: string): ReviewRow | null => {
		const r = d.first<RawReview>(
			`SELECT * FROM reviews WHERE change_id = ? AND head = ? AND shadow = 0
			 AND decision = 'approve' AND decided_kind = 'user' ORDER BY at DESC LIMIT 1`,
			changeId,
			head,
		);
		return r ? toReview(r) : null;
	};

	/** Human-routed reviews of the latest revisions still waiting for a decision. */
	const waiting = (shadow: boolean): ReviewRow[] =>
		d.all<RawReview>(
			`SELECT r.* FROM reviews r JOIN changes c ON c.change_id = r.change_id AND c.revision = r.n
			 WHERE r.route = 'human' AND r.decision IS NULL AND r.shadow = ? AND c.state = 'submitted'
			 ORDER BY r.at`,
			shadow ? 1 : 0,
		).map(toReview);

	const attention = (changeId: string): string[] =>
		d.all<{ principal_id: string }>(
			"SELECT principal_id FROM attention WHERE change_id = ? ORDER BY principal_id",
			changeId,
		).map((r) => r.principal_id);

	const attentionFor = (principal: string): string[] =>
		d.all<{ change_id: string }>(
			"SELECT change_id FROM attention WHERE principal_id = ? ORDER BY since",
			principal,
		).map((r) => r.change_id);

	const setAttention = (
		changeId: string,
		principals: readonly string[],
		reason: string,
		at: number,
	): void => {
		d.run("DELETE FROM attention WHERE change_id = ?", changeId);
		for (const p of principals) {
			d.run(
				"INSERT INTO attention (change_id, principal_id, reason, since) VALUES (?, ?, ?, ?)",
				changeId,
				p,
				reason,
				at,
			);
		}
	};

	const openConflictSeverities = (laneId: string): string[] =>
		d.all<{ severity: string }>(
			"SELECT severity FROM lane_conflicts WHERE (a = ? OR b = ?) AND state = 'open'",
			laneId,
			laneId,
		).map((r) => r.severity);

	const upsertConflict = (
		id: string,
		a: string,
		b: string,
		severity: string,
		state: string,
		at: number,
	): void => {
		d.run(
			`INSERT INTO lane_conflicts (conflict_id, a, b, severity, state, at) VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT (conflict_id) DO UPDATE SET a = excluded.a, b = excluded.b,
			   severity = excluded.severity, state = excluded.state, at = excluded.at`,
			id,
			a,
			b,
			severity,
			state,
			at,
		);
	};

	const updateConflict = (
		id: string,
		set: { severity?: string; state?: string },
		at: number,
	): void => {
		if (set.severity !== undefined) {
			d.run(
				"UPDATE lane_conflicts SET severity = ?, at = ? WHERE conflict_id = ?",
				set.severity,
				at,
				id,
			);
		}
		if (set.state !== undefined) {
			d.run(
				"UPDATE lane_conflicts SET state = ?, at = ? WHERE conflict_id = ?",
				set.state,
				at,
				id,
			);
		}
	};

	const track = (principal: string): Track =>
		d.first<Track>(
			"SELECT landed, ejected, vetoed, reverted FROM track WHERE principal_id = ?",
			principal,
		) ?? { landed: 0, ejected: 0, vetoed: 0, reverted: 0 };

	/** Counts one event once (at-least-once delivery). */
	const bump = (
		eventId: string,
		principal: string,
		field: "landed" | "ejected" | "vetoed" | "reverted",
	): void => {
		d.tx(() => {
			const seen = d.run(
				"INSERT INTO track_seen (event_id) VALUES (?) ON CONFLICT (event_id) DO NOTHING",
				`${eventId}:${principal}:${field}`,
			);
			if (seen.rowsWritten === 0) return;
			d.run(
				`INSERT INTO track (principal_id, ${field}) VALUES (?, 1)
				 ON CONFLICT (principal_id) DO UPDATE SET ${field} = ${field} + 1`,
				principal,
			);
		});
	};

	const rules = (): { sha: string | null; rules: OwnerRule[] } => {
		const rows = d.all<
			{
				glob: string;
				sensitivity: number;
				owners_json: string;
				trunk_sha: string;
			}
		>("SELECT * FROM rules ORDER BY glob");
		return {
			sha: rows[0]?.trunk_sha ?? null,
			rules: rows.map((r) => ({
				glob: r.glob,
				sensitivity: r.sensitivity,
				owners: json.decode<string[]>(r.owners_json, []),
			})),
		};
	};

	/** Replaces the cached rules with those read at `sha` (context@1 reads them). */
	const writeRules = (sha: string, list: readonly OwnerRule[]): void => {
		d.tx(() => {
			d.run("DELETE FROM rules");
			const merged = new Map<string, OwnerRule>();
			for (const r of list) {
				const prev = merged.get(r.glob);
				merged.set(
					r.glob,
					prev
						? {
							glob: r.glob,
							sensitivity: Math.max(prev.sensitivity, r.sensitivity),
							owners: [...new Set([...prev.owners, ...r.owners])],
						}
						: r,
				);
			}
			for (const r of merged.values()) {
				d.run(
					"INSERT INTO rules (glob, sensitivity, owners_json, trunk_sha) VALUES (?, ?, ?, ?)",
					r.glob,
					r.sensitivity,
					json.encode(r.owners),
					sha,
				);
			}
		});
	};

	return {
		change,
		writeChange,
		setChangeState,
		review,
		writeReview,
		userApproval,
		waiting,
		attention,
		attentionFor,
		setAttention,
		openConflictSeverities,
		upsertConflict,
		updateConflict,
		track,
		bump,
		rules,
		writeRules,
		tx: d.tx,
	};
};
export type Store = ReturnType<typeof createStore>;
