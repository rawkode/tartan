// tartan.changes storage: typed rows over the extension's own SQLite database
// and the mapper to the `changes@1` entity.

import { type Change, changeIdFromBytes, type Sql } from "@tartan/contract";
import { type Db, db, json } from "@tartan/ext-api";

export type ChangeState = Change["state"];

export type ChangeRow = {
	readonly change_id: string;
	readonly work_ref: string | null;
	readonly lane_id: string;
	readonly source_ref: string | null;
	readonly title: string;
	readonly summary_md: string | null;
	readonly author_id: string;
	readonly on_behalf_of: string | null;
	readonly state: ChangeState;

	readonly landed_commit: string | null;
	readonly created_at: number;
	readonly updated_at: number;
	readonly review_json: string | null;
};

export type RevisionRow = {
	readonly change_id: string;
	readonly n: number;
	readonly head: string;
	readonly base: string;
	readonly affected_json: string;
	readonly diffstat_json: string;
	readonly at: number;
};

export type CommentRow = {
	readonly id: string;
	readonly change_id: string;
	readonly n: number;
	readonly path: string | null;
	readonly line: number | null;
	readonly side: "base" | "head" | null;
	readonly body_md: string;
	readonly author_id: string;
	readonly resolved: number;
	readonly at: number;
};

export type TimelineRow = {
	readonly id: string;
	readonly change_id: string;
	readonly at: number;
	readonly kind: string;
	readonly text: string;
	readonly actor: string | null;
	readonly revision: number | null;
};

export type Diffstat = {
	readonly files: number;
	readonly additions: number;
	readonly deletions: number;
};

/** States in which a push to the lane makes a new revision. */
export const REVISABLE: readonly ChangeState[] = [
	"submitted",
	"approved",
	"queued",
	"ejected",
];
/** States that are over: nothing moves them any more. */
export const FINAL: readonly ChangeState[] = [
	"landed",
	"abandoned",
	"superseded",
];

const CHANGE_COLUMNS =
	"change_id, work_ref, lane_id, source_ref, title, summary_md, author_id, on_behalf_of, state, landed_commit, created_at, updated_at, review_json";
const REVISION_COLUMNS =
	"change_id, n, head, base, affected_json, diffstat_json, at";

export type NewChange = {
	readonly changeId: string;
	readonly laneId: string;
	readonly workRef?: string;
	readonly sourceRef?: string;
	readonly title: string;
	readonly author: string;
	readonly onBehalfOf?: string;
	readonly at: number;
};

export const createStore = (sql: Sql) => {
	const d: Db = db(sql);

	const change = (id: string): ChangeRow | null =>
		d.first<ChangeRow>(
			`SELECT ${CHANGE_COLUMNS} FROM changes WHERE change_id = ?`,
			id,
		);
	const changeByLane = (laneId: string): ChangeRow | null =>
		d.first<ChangeRow>(
			`SELECT ${CHANGE_COLUMNS} FROM changes WHERE lane_id = ?`,
			laneId,
		);
	const changes = (f: {
		readonly state?: ChangeState;
		readonly authors?: readonly string[];
		readonly offset?: number;
		readonly limit: number;
	}): ChangeRow[] => {
		const where = ["1 = 1"];
		const bindings: (string | number)[] = [];
		if (f.state !== undefined) {
			where.push("state = ?");
			bindings.push(f.state);
		}
		if (f.authors !== undefined) {
			where.push(
				"(author_id IN (SELECT value FROM json_each(?)) OR on_behalf_of IN (SELECT value FROM json_each(?)))",
			);
			bindings.push(json.encode(f.authors), json.encode(f.authors));
		}
		return d.all<ChangeRow>(
			`SELECT ${CHANGE_COLUMNS} FROM changes WHERE ${
				where.join(" AND ")
			} ORDER BY created_at DESC, change_id LIMIT ? OFFSET ?`,
			...bindings,
			f.limit,
			f.offset ?? 0,
		);
	};

	const insertChange = (c: NewChange): boolean =>
		d.run(
			`INSERT OR IGNORE INTO changes (change_id, work_ref, lane_id, source_ref, title, author_id, on_behalf_of, state, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
			c.changeId,
			c.workRef ?? null,
			c.laneId,
			c.sourceRef ?? null,
			c.title,
			c.author,
			c.onBehalfOf ?? null,
			c.at,
			c.at,
		).rowsWritten > 0;

	const setState = (id: string, state: ChangeState, at: number): void => {
		d.run(
			"UPDATE changes SET state = ?, updated_at = ? WHERE change_id = ?",
			state,
			at,
			id,
		);
	};
	const setText = (
		id: string,
		title: string,
		summary: string,
		at: number,
	): void => {
		d.run(
			"UPDATE changes SET title = ?, summary_md = ?, updated_at = ? WHERE change_id = ?",
			title,
			summary,
			at,
			id,
		);
	};
	const setLanded = (id: string, commit: string, at: number): void => {
		d.run(
			"UPDATE changes SET state = 'landed', landed_commit = ?, updated_at = ? WHERE change_id = ?",
			commit,
			at,
			id,
		);
	};
	const setReview = (id: string, review: unknown, at: number): void => {
		d.run(
			"UPDATE changes SET review_json = ?, updated_at = ? WHERE change_id = ?",
			json.encode(review),
			at,
			id,
		);
	};

	const revisions = (changeId: string): RevisionRow[] =>
		d.all<RevisionRow>(
			`SELECT ${REVISION_COLUMNS} FROM revisions WHERE change_id = ? ORDER BY n`,
			changeId,
		);
	const latest = (changeId: string): RevisionRow | null =>
		d.first<RevisionRow>(
			`SELECT ${REVISION_COLUMNS} FROM revisions WHERE change_id = ? ORDER BY n DESC LIMIT 1`,
			changeId,
		);
	const insertRevision = (r: {
		readonly changeId: string;
		readonly n: number;
		readonly head: string;
		readonly base: string;
		readonly affected: readonly string[];
		readonly diffstat: Diffstat;
		readonly at: number;
	}): void => {
		d.run(
			`INSERT INTO revisions (change_id, n, head, base, affected_json, diffstat_json, at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			r.changeId,
			r.n,
			r.head,
			r.base,
			json.encode(r.affected),
			json.encode(r.diffstat),
			r.at,
		);
	};

	const comments = (changeId: string): CommentRow[] =>
		d.all<CommentRow>(
			"SELECT id, change_id, n, path, line, side, body_md, author_id, resolved, at FROM comments WHERE change_id = ? ORDER BY at, id",
			changeId,
		);
	const comment = (id: string): CommentRow | null =>
		d.first<CommentRow>(
			"SELECT id, change_id, n, path, line, side, body_md, author_id, resolved, at FROM comments WHERE id = ?",
			id,
		);
	const insertComment = (c: Omit<CommentRow, "resolved">): void => {
		d.run(
			"INSERT INTO comments (id, change_id, n, path, line, side, body_md, author_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			c.id,
			c.change_id,
			c.n,
			c.path,
			c.line,
			c.side,
			c.body_md,
			c.author_id,
			c.at,
		);
	};
	/** Resolves the thread a comment starts: every comment on the same file and line. */
	const resolveThread = (c: CommentRow): void => {
		d.run(
			"UPDATE comments SET resolved = 1 WHERE change_id = ? AND path IS ? AND line IS ?",
			c.change_id,
			c.path,
			c.line,
		);
	};

	const timeline = (changeId: string): TimelineRow[] =>
		d.all<TimelineRow>(
			"SELECT id, change_id, at, kind, text, actor, revision FROM timeline WHERE change_id = ? ORDER BY at, id",
			changeId,
		);
	const note = (t: TimelineRow): void => {
		d.run(
			"INSERT OR IGNORE INTO timeline (id, change_id, at, kind, text, actor, revision) VALUES (?, ?, ?, ?, ?, ?, ?)",
			t.id,
			t.change_id,
			t.at,
			t.kind,
			t.text,
			t.actor,
			t.revision,
		);
	};

	const recordBatch = (
		batchId: string,
		attempt: number,
		changeIds: readonly string[],
	): void => {
		for (const id of changeIds) {
			d.run(
				"INSERT OR REPLACE INTO batches (batch_id, change_id, attempt) VALUES (?, ?, ?)",
				batchId,
				id,
				attempt,
			);
		}
	};
	const batchChanges = (batchId: string): string[] =>
		d.all<{ change_id: string }>(
			"SELECT change_id FROM batches WHERE batch_id = ? ORDER BY change_id",
			batchId,
		).map((r) => r.change_id);

	return {
		db: d,
		change,
		changeByLane,
		changes,
		insertChange,
		setState,
		setText,
		setLanded,
		setReview,
		revisions,
		latest,
		insertRevision,
		comments,
		comment,
		insertComment,
		resolveThread,
		timeline,
		note,
		recordBatch,
		batchChanges,
	};
};

export type ChangesStore = ReturnType<typeof createStore>;

export const toChange = (
	row: ChangeRow,
	revisions: readonly RevisionRow[],
	repo: string,
): Change => ({
	changeId: row.change_id,
	repo,
	...(row.work_ref ? { workRef: row.work_ref } : {}),
	laneId: row.lane_id,
	...(row.source_ref ? { sourceRef: row.source_ref } : {}),
	title: row.title,
	summary: row.summary_md ?? "",
	author: row.author_id,
	...(row.on_behalf_of ? { onBehalfOf: row.on_behalf_of } : {}),
	revisions: revisions.map((r) => ({
		n: r.n,
		head: r.head,
		base: r.base,
		affected: json.decode<string[]>(r.affected_json, []),
		diffstat: json.decode<Diffstat>(r.diffstat_json, {
			files: 0,
			additions: 0,
			deletions: 0,
		}),
		at: r.at,
	})),
	state: row.state,
	...(row.landed_commit ? { landedCommit: row.landed_commit } : {}),
});

/**
 * The change id of a lane: 16 bytes of SHA-256(`tartan.changes:<laneId>`) as
 * reverse hex. One lane has one change, so a retried handler
 * mints the same id (the emit of `changes.opened` is deduped by the host).
 */
export const changeIdForLane = async (laneId: string): Promise<string> => {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(`tartan.changes:${laneId}`),
	);
	return changeIdFromBytes(new Uint8Array(digest));
};
