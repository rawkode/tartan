// The board projection: cards move by the
// columns' auto rules as `work.*`, `changes.*`, `queue.*` and `lane.*` events
// arrive, from any repo stream of the installation's subtree.
//
// It is a pure function of each card's own events, so a board rebuilt from
// history (`backfill: "all"`) equals the board that followed live, whatever
// order the repo streams interleave in: a card's events all come from its
// repo's stream (ordered), every write is keyed by the card, and a card's
// rank is the id of the event that moved it into its column (ULIDs sort by
// time), never a counter or the clock. Redelivered events change nothing.

import type { Envelope } from "@tartan/contract";
import { json } from "@tartan/ext-api";
import {
	type AutoRule,
	badgesOf,
	BOARD_ID,
	type BoardStore,
	type CardRow,
} from "./store.ts";

type Data = Record<string, unknown>;

const str = (v: unknown): string | undefined =>
	typeof v === "string" && v !== "" ? v : undefined;

type Placement = AutoRule | "backlog";

const STATE_PLACEMENT: Readonly<Record<string, Placement | "drop">> = {
	open: "backlog",
	claimed: "work.claimed",
	in_review: "changes.submitted",
	done: "changes.landed",
	abandoned: "drop",
};

const changeCardRef = (changeId: string): string => `change:${changeId}`;

export const createProjection = (store: BoardStore) => {
	const columns = store.columns();
	const columnOf = (p: Placement): string => {
		const found = p === "backlog"
			? columns.find((c) => c.auto_rule === null)
			: columns.find((c) => c.auto_rule === p);
		return (found ?? columns[0]).id;
	};

	const write = (
		ev: Envelope<Data>,
		ref: string,
		patch: {
			readonly placement?: Placement;
			readonly title?: string;
			readonly kind?: CardRow["kind"];
			readonly add?: readonly string[];
			readonly remove?: (badge: string) => boolean;
			readonly create?: boolean;
		},
	): void => {
		const current = store.card(ref);
		if (current === null && patch.create === false) return;
		const column = patch.placement !== undefined
			? columnOf(patch.placement)
			: current?.column_id ?? columnOf("backlog");
		const moved = current === null || current.column_id !== column;
		const kept = badgesOf(current).filter((b) => !(patch.remove?.(b) ?? false));
		const badges = [
			...kept,
			...(patch.add ?? []).filter((b) => !kept.includes(b)),
		];
		store.putCard({
			ref,
			board_id: BOARD_ID,
			column_id: column,
			rank: moved ? ev.id : current.rank,
			title: patch.title ?? current?.title ?? ref,
			badges_json: json.encode(badges),
			updated_at: moved ? ev.at : current.updated_at,
			repo_id: current?.repo_id ?? ev.repo ?? null,
			kind: patch.kind ?? current?.kind ?? "work",
		});
	};

	/** The card a change event names: its work item, else the change's own card. */
	const cardOfChange = (data: Data): string | null => {
		const changeId = str(data.changeId);
		const workRef = str(data.workRef);
		if (workRef) return workRef;
		if (changeId) {
			return store.linked(`change:${changeId}`) ?? null;
		}
		return null;
	};

	const isRevision = (b: string) => /^r[0-9]+$/.test(b);
	const QUEUE_FLAGS = ["queued", "ejected"];

	const handlers: Readonly<Record<string, (ev: Envelope<Data>) => void>> = {
		"work.created": (ev) => {
			const ref = str(ev.data.ref);
			if (!ref) return;
			const kind = str(ev.data.kind);
			write(ev, ref, {
				title: str(ev.data.title) ?? ref,
				kind: "work",
				...(store.card(ref) === null ? { placement: "backlog" } : {}),
				add: kind ? [kind] : [],
			});
		},
		"work.claimed": (ev) => {
			const ref = str(ev.data.ref);
			const laneId = str(ev.data.laneId);
			if (!ref) return;
			if (laneId) store.link(`lane:${laneId}`, ref);
			write(ev, ref, {
				placement: "work.claimed",
				remove: (b) => b === "lane lost",
			});
		},
		"work.released": (ev) => {
			const ref = str(ev.data.ref);
			if (!ref) return;
			write(ev, ref, {
				placement: "backlog",
				remove: (b) =>
					b === "lane lost" || isRevision(b) ||
					QUEUE_FLAGS.includes(b),
			});
		},
		"work.updated": (ev) => {
			const ref = str(ev.data.ref);
			if (!ref) return;
			const state = str(ev.data.state);
			const target = state ? STATE_PLACEMENT[state] : undefined;
			if (target === "drop") {
				store.dropCard(ref);
				return;
			}
			const priority = typeof ev.data.priority === "number"
				? `p${ev.data.priority}`
				: undefined;
			write(ev, ref, {
				...(target ? { placement: target } : {}),
				...(priority
					? { add: [priority], remove: (b) => /^p[0-4]$/.test(b) }
					: {}),
			});
		},
		"work.done": (ev) => {
			const ref = str(ev.data.ref);
			if (ref) {
				write(ev, ref, {
					placement: "changes.landed",
					remove: (b) => QUEUE_FLAGS.includes(b),
				});
			}
		},
		"changes.opened": (ev) => {
			const changeId = str(ev.data.changeId);
			if (!changeId) return;
			const workRef = str(ev.data.workRef);
			const ref = workRef ?? changeCardRef(changeId);
			store.link(`change:${changeId}`, ref);
			const laneId = str(ev.data.laneId);
			if (laneId) store.link(`lane:${laneId}`, ref);
			if (workRef === undefined) {
				write(ev, ref, {
					kind: "change",
					title: str(ev.data.title) ?? ref,
					...(store.card(ref) === null ? { placement: "work.claimed" } : {}),
				});
			}
		},
		"changes.submitted": (ev) => revision(ev),
		"changes.revised": (ev) => revision(ev),
		"changes.landed": (ev) => {
			const ref = cardOfChange(ev.data);
			if (ref) {
				write(ev, ref, {
					placement: "changes.landed",
					remove: (b) => QUEUE_FLAGS.includes(b),
				});
			}
		},
		"changes.abandoned": (ev) => abandoned(ev),
		"changes.superseded": (ev) => abandoned(ev),
		"queue.enqueued": (ev) => {
			const ref = cardOfChange(ev.data);
			if (ref) {
				write(ev, ref, {
					add: ["queued"],
					remove: (b) => b === "ejected",
					create: false,
				});
			}
		},
		"queue.batched": (ev) => {
			const ids = Array.isArray(ev.data.changes) ? ev.data.changes : [];
			for (const id of ids) {
				const ref = cardOfChange({ changeId: id });
				if (ref) {
					write(ev, ref, { placement: "queue.batched", create: false });
				}
			}
		},
		"queue.ejected": (ev) => {
			const ref = cardOfChange(ev.data);
			if (ref) {
				write(ev, ref, {
					placement: "changes.submitted",
					add: ["ejected"],
					remove: (b) => b === "queued",
					create: false,
				});
			}
		},
		"queue.landed": (ev) => {
			const ref = cardOfChange(ev.data);
			if (ref) {
				write(ev, ref, {
					placement: "changes.landed",
					remove: (b) => QUEUE_FLAGS.includes(b),
					create: false,
				});
			}
		},
		"lane.lost": (ev) => {
			const laneId = str(ev.data.laneId);
			const ref = laneId ? store.linked(`lane:${laneId}`) : null;
			if (ref) write(ev, ref, { add: ["lane lost"], create: false });
		},
		"lane.opened": (ev) => {
			const laneId = str(ev.data.laneId);
			const ref = laneId ? store.linked(`lane:${laneId}`) : null;
			if (ref) {
				write(ev, ref, { remove: (b) => b === "lane lost", create: false });
			}
		},
	};

	function revision(ev: Envelope<Data>): void {
		const ref = cardOfChange(ev.data);
		if (!ref) return;
		const n = typeof ev.data.revision === "number" ? ev.data.revision : 1;
		write(ev, ref, {
			placement: "changes.submitted",
			add: [`r${n}`],
			remove: (b) => isRevision(b) || QUEUE_FLAGS.includes(b),
		});
	}

	function abandoned(ev: Envelope<Data>): void {
		const ref = cardOfChange(ev.data);
		if (!ref) return;
		const card = store.card(ref);
		if (card?.kind === "change") {
			store.dropCard(ref);
			return;
		}
		write(ev, ref, {
			remove: (b) => isRevision(b) || QUEUE_FLAGS.includes(b),
			create: false,
		});
	}

	/** Applies one event (any type; unknown ones are ignored). */
	const apply = (ev: Envelope): void => {
		if (ev.shadow) return;
		const handler = handlers[ev.type];
		if (handler === undefined) return;
		store.db.tx(() => handler(ev as Envelope<Data>));
	};

	return { apply };
};
