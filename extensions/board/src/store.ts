// tartan.board storage: one board per installation with fixed columns, each
// with the auto rule that moves cards into it, the cards, and links from change
// and lane ids to cards.

import type { Sql } from "@tartan/contract";
import { type Db, db, json } from "@tartan/ext-api";

export const BOARD_ID = "main";

/** The rule a column is the target of (`columns.auto_rule`); null = the backlog. */
export type AutoRule =
	| "work.claimed"
	| "changes.submitted"
	| "queue.batched"
	| "changes.landed";

export type ColumnSpec = {
	readonly id: string;
	readonly name: string;
	readonly ord: number;
	readonly wip: number | null;
	readonly rule: AutoRule | null;
};

/** The default columns. */
export const DEFAULT_COLUMNS: readonly ColumnSpec[] = [
	{ id: "backlog", name: "Backlog", ord: 0, wip: null, rule: null },
	{
		id: "progress",
		name: "In progress",
		ord: 1,
		wip: null,
		rule: "work.claimed",
	},
	{
		id: "review",
		name: "In review",
		ord: 2,
		wip: null,
		rule: "changes.submitted",
	},
	{
		id: "landing",
		name: "Landing",
		ord: 3,
		wip: null,
		rule: "queue.batched",
	},
	{ id: "done", name: "Done", ord: 4, wip: null, rule: "changes.landed" },
];

export type ColumnRow = {
	readonly id: string;
	readonly board_id: string;
	readonly name: string;
	readonly ord: number;
	readonly wip: number | null;
	readonly auto_rule: AutoRule | null;
};

export type CardRow = {
	readonly ref: string;
	readonly board_id: string;
	readonly column_id: string;
	readonly rank: string;
	readonly title: string;
	readonly badges_json: string;
	readonly updated_at: number;
	readonly repo_id: string | null;
	readonly kind: "work" | "change";
};

const CARD_COLUMNS =
	"ref, board_id, column_id, rank, title, badges_json, updated_at, repo_id, kind";

export const createStore = (sql: Sql) => {
	const d: Db = db(sql);

	/** Idempotent: the board of this installation and its default columns. */
	const ensureBoard = (nodeId: string): void => {
		d.tx(() => {
			d.run(
				"INSERT OR IGNORE INTO boards (id, node_id, name) VALUES (?, ?, 'Board')",
				BOARD_ID,
				nodeId,
			);
			for (const c of DEFAULT_COLUMNS) {
				d.run(
					"INSERT OR IGNORE INTO columns (id, board_id, name, ord, wip, auto_rule) VALUES (?, ?, ?, ?, ?, ?)",
					c.id,
					BOARD_ID,
					c.name,
					c.ord,
					c.wip,
					c.rule,
				);
			}
		});
	};

	const columns = (): ColumnRow[] =>
		d.all<ColumnRow>(
			"SELECT id, board_id, name, ord, wip, auto_rule FROM columns WHERE board_id = ? ORDER BY ord, id",
			BOARD_ID,
		);

	const card = (ref: string): CardRow | null =>
		d.first<CardRow>(`SELECT ${CARD_COLUMNS} FROM cards WHERE ref = ?`, ref);

	const cards = (repoId?: string): CardRow[] =>
		repoId === undefined
			? d.all<CardRow>(
				`SELECT ${CARD_COLUMNS} FROM cards WHERE board_id = ? ORDER BY column_id, rank, ref`,
				BOARD_ID,
			)
			: d.all<CardRow>(
				`SELECT ${CARD_COLUMNS} FROM cards WHERE board_id = ? AND repo_id = ? ORDER BY column_id, rank, ref`,
				BOARD_ID,
				repoId,
			);

	const putCard = (c: CardRow): void => {
		d.run(
			`INSERT INTO cards (ref, board_id, column_id, rank, title, badges_json, updated_at, repo_id, kind)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (ref) DO UPDATE SET column_id = excluded.column_id, rank = excluded.rank,
			 title = excluded.title, badges_json = excluded.badges_json, updated_at = excluded.updated_at,
			 repo_id = excluded.repo_id, kind = excluded.kind`,
			c.ref,
			c.board_id,
			c.column_id,
			c.rank,
			c.title,
			c.badges_json,
			c.updated_at,
			c.repo_id,
			c.kind,
		);
	};

	const dropCard = (ref: string): void => {
		d.run("DELETE FROM cards WHERE ref = ?", ref);
	};

	const link = (key: string, ref: string): void => {
		d.run(
			"INSERT INTO links (link_key, ref) VALUES (?, ?) ON CONFLICT (link_key) DO UPDATE SET ref = excluded.ref",
			key,
			ref,
		);
	};
	const linked = (key: string): string | null =>
		d.value<string>("SELECT ref FROM links WHERE link_key = ?", key);

	return {
		db: d,
		ensureBoard,
		columns,
		card,
		cards,
		putCard,
		dropCard,
		link,
		linked,
	};
};

export type BoardStore = ReturnType<typeof createStore>;

export const badgesOf = (row: CardRow | null): string[] =>
	row === null ? [] : json.decode<string[]>(row.badges_json, []);
