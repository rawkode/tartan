// tartan.work storage: typed rows over the extension's own SQLite database and
// the mappers to the `work@1` entity. Raw SQL, no ORM; every write is a single
// statement or runs inside `db.tx`.

import {
	EMPTY_FOOTPRINT,
	type Footprint,
	type Sql,
	type WorkItem,
} from "@tartan/contract";
import { type Db, db, json } from "@tartan/ext-api";

export type ItemState = WorkItem["state"];
export type ClaimState = WorkItem["claims"][number]["state"];

export type ItemRow = {
	readonly id: string;
	readonly number: number;
	readonly kind: WorkItem["kind"];
	readonly title: string;
	readonly why: string;
	readonly acceptance_json: string;
	readonly footprint_json: string;
	readonly parent_ref: string | null;
	readonly origin_json: string;
	readonly state: ItemState;
	readonly priority: number;
	readonly labels_json: string;
	readonly created_by: string;
	readonly created_at: number;
	readonly updated_at: number;
	readonly landed_commit: string | null;
};

export type ClaimRow = {
	readonly item_id: string;
	readonly lane_id: string;
	readonly principal_id: string;
	readonly state: ClaimState;
	readonly plan: string | null;
	readonly claimed_at: number;
	readonly ended_at: number | null;
	readonly change_id: string | null;
};

export type CommentRow = {
	readonly id: string;
	readonly item_id: string;
	readonly author_id: string;
	readonly body_md: string;
	readonly at: number;
};

/** Claims that still hold the item (a lane is working on it). */
export const LIVE_CLAIM_STATES: readonly ClaimState[] = ["active", "submitted"];

const ITEM_COLUMNS =
	"id, number, kind, title, why, acceptance_json, footprint_json, parent_ref, origin_json, state, priority, labels_json, created_by, created_at, updated_at, landed_commit";
const CLAIM_COLUMNS =
	"item_id, lane_id, principal_id, state, plan, claimed_at, ended_at, change_id";

export type NewItem = {
	readonly id: string;
	readonly kind: WorkItem["kind"];
	readonly title: string;
	readonly why: string;
	readonly acceptance: readonly string[];
	readonly footprint: Footprint;
	readonly parent?: string;
	readonly origin?: Record<string, unknown>;
	readonly priority: number;
	readonly labels: readonly string[];
	readonly createdBy: string;
	readonly at: number;
};

export type ItemFilter = {
	readonly state?: ItemState;
	readonly kind?: WorkItem["kind"];
	readonly labels?: readonly string[];
	readonly after?: number;
	readonly limit: number;
};

export type WorkStore = ReturnType<typeof createStore>;

export const createStore = (sql: Sql) => {
	const d: Db = db(sql);

	const item = (id: string): ItemRow | null =>
		d.first<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM items WHERE id = ?`, id);
	const itemByNumber = (n: number): ItemRow | null =>
		d.first<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM items WHERE number = ?`, n);
	const itemByCommit = (sha: string): ItemRow | null =>
		d.first<ItemRow>(
			`SELECT ${ITEM_COLUMNS} FROM items WHERE landed_commit = ?`,
			sha,
		);

	const items = (f: ItemFilter): ItemRow[] => {
		const where: string[] = ["number > ?"];
		const bindings: (string | number)[] = [f.after ?? 0];
		if (f.state !== undefined) {
			where.push("state = ?");
			bindings.push(f.state);
		}
		if (f.kind !== undefined) {
			where.push("kind = ?");
			bindings.push(f.kind);
		}
		for (const label of f.labels ?? []) {
			where.push(
				"EXISTS (SELECT 1 FROM json_each(labels_json) WHERE value = ?)",
			);
			bindings.push(label);
		}
		return d.all<ItemRow>(
			`SELECT ${ITEM_COLUMNS} FROM items WHERE ${
				where.join(" AND ")
			} ORDER BY number LIMIT ?`,
			...bindings,
			f.limit,
		);
	};

	const claimsOf = (itemId: string): ClaimRow[] =>
		d.all<ClaimRow>(
			`SELECT ${CLAIM_COLUMNS} FROM claims WHERE item_id = ? ORDER BY claimed_at, lane_id`,
			itemId,
		);
	const claimByLane = (laneId: string): ClaimRow | null =>
		d.first<ClaimRow>(
			`SELECT ${CLAIM_COLUMNS} FROM claims WHERE lane_id = ? ORDER BY claimed_at DESC`,
			laneId,
		);
	const claimByChange = (changeId: string): ClaimRow | null =>
		d.first<ClaimRow>(
			`SELECT ${CLAIM_COLUMNS} FROM claims WHERE change_id = ? ORDER BY claimed_at DESC`,
			changeId,
		);

	const nextNumber = (): number =>
		Number(d.value<number>("SELECT COALESCE(MAX(number), 0) + 1 FROM items"));

	const insertItem = (n: NewItem): number =>
		d.tx(() => {
			const number = nextNumber();
			d.run(
				`INSERT INTO items (id, number, kind, title, why, acceptance_json, footprint_json, parent_ref, origin_json, state, priority, labels_json, created_by, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
				n.id,
				number,
				n.kind,
				n.title,
				n.why,
				json.encode(n.acceptance),
				json.encode(n.footprint),
				n.parent ?? null,
				json.encode(n.origin ?? {}),
				n.priority,
				json.encode(n.labels),
				n.createdBy,
				n.at,
				n.at,
			);
			d.run(
				"INSERT INTO items_fts (rowid, title, why) SELECT rowid, title, why FROM items WHERE id = ?",
				n.id,
			);
			return number;
		});

	const setItemState = (id: string, state: ItemState, at: number): void => {
		d.run(
			"UPDATE items SET state = ?, updated_at = ? WHERE id = ?",
			state,
			at,
			id,
		);
	};

	const updateItem = (
		id: string,
		patch: {
			readonly state?: ItemState;
			readonly priority?: number;
			readonly labels?: readonly string[];
		},
		at: number,
	): void => {
		d.run(
			`UPDATE items SET state = COALESCE(?, state), priority = COALESCE(?, priority),
			 labels_json = COALESCE(?, labels_json), updated_at = ? WHERE id = ?`,
			patch.state ?? null,
			patch.priority ?? null,
			patch.labels === undefined ? null : json.encode(patch.labels),
			at,
			id,
		);
	};

	const insertClaim = (c: {
		readonly itemId: string;
		readonly laneId: string;
		readonly principal: string;
		readonly plan: string | null;
		readonly at: number;
	}): void => {
		d.run(
			`INSERT OR IGNORE INTO claims (item_id, lane_id, principal_id, state, plan, claimed_at)
			 VALUES (?, ?, ?, 'active', ?, ?)`,
			c.itemId,
			c.laneId,
			c.principal,
			c.plan,
			c.at,
		);
	};

	const setClaim = (
		itemId: string,
		laneId: string,
		state: ClaimState,
		at: number,
		changeId?: string,
	): void => {
		const ended = LIVE_CLAIM_STATES.includes(state) ? null : at;
		d.run(
			`UPDATE claims SET state = ?, ended_at = ?, change_id = COALESCE(?, change_id)
			 WHERE item_id = ? AND lane_id = ?`,
			state,
			ended,
			changeId ?? null,
			itemId,
			laneId,
		);
	};

	const setLandedCommit = (id: string, sha: string): void => {
		d.run("UPDATE items SET landed_commit = ? WHERE id = ?", sha, id);
	};

	const comments = (itemId: string): CommentRow[] =>
		d.all<CommentRow>(
			"SELECT id, item_id, author_id, body_md, at FROM comments WHERE item_id = ? ORDER BY at, id",
			itemId,
		);
	const insertComment = (c: CommentRow): void => {
		d.run(
			"INSERT INTO comments (id, item_id, author_id, body_md, at) VALUES (?, ?, ?, ?, ?)",
			c.id,
			c.item_id,
			c.author_id,
			c.body_md,
			c.at,
		);
	};

	return {
		db: d,
		item,
		itemByNumber,
		itemByCommit,
		items,
		claimsOf,
		claimByLane,
		claimByChange,
		insertItem,
		setItemState,
		updateItem,
		insertClaim,
		setClaim,
		setLandedCommit,
		comments,
		insertComment,
	};
};

/** The `work@1` entity of an item (`WorkItemSchema`). */
export const toWorkItem = (
	row: ItemRow,
	claims: readonly ClaimRow[],
	repoPath: string,
): WorkItem => {
	const origin = json.decode<Record<string, unknown>>(row.origin_json, {});
	return {
		ref: workRef(repoPath, row.number),
		kind: row.kind,
		title: row.title,
		why: row.why,
		acceptance: json.decode<string[]>(row.acceptance_json, []),
		footprint: json.decode<Footprint>(row.footprint_json, EMPTY_FOOTPRINT),
		...(row.parent_ref ? { parent: row.parent_ref } : {}),
		...(Object.keys(origin).length > 0 ? { origin } : {}),
		state: row.state,
		claims: claims.map((c) => ({
			principal: c.principal_id,
			laneId: c.lane_id,
			state: c.state,
		})),
		labels: json.decode<string[]>(row.labels_json, []),
		priority: row.priority,
	};
};

/** `<repoPath>#<n>` (`WORK_REF_RE`). */
export const workRef = (repoPath: string, n: number): string =>
	`${repoPath}#${n}`;

/** Splits a work ref into its repo path and number. */
export const parseWorkRef = (
	ref: string,
): { readonly repo: string; readonly n: number } | null => {
	const at = ref.lastIndexOf("#");
	if (at <= 0) return null;
	const n = Number(ref.slice(at + 1));
	return Number.isInteger(n) && n > 0 ? { repo: ref.slice(0, at), n } : null;
};
