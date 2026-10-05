// tartan.board slots and the move action: the
// `board` host component for the subtree (`node.tab` "board", reached from
// `nav.global` "nav") or for one repo (`repo.tab` "repo-board"). A viewer
// sees only the cards of repos it can read. Moving a card calls
// `work@1`'s `work_update{ref, state}` as the viewing user: the card itself
// moves when the resulting `work.updated` event arrives, so the board stays
// a projection of events (and rebuilds identically from history).

import {
	type ActionResult,
	type ExtCtx,
	invalid,
	type SlotContext,
	type UiDoc,
	WORK_REF_RE,
} from "@tartan/contract";
import { action, result, ui } from "@tartan/ext-api";
import { badgesOf, type CardRow, createStore } from "./store.ts";

const REFRESH = ["work.*", "changes.*", "queue.*", "lane.*"];
/** `tartan-ui@1` allows 500 cards; Done keeps the most recent ones. */
const MAX_CARDS = 400;
const MAX_DONE = 50;

/** The `work@1` state a column stands for (moves set it through `work_update`). */
const COLUMN_STATE: Readonly<Record<string, string>> = {
	backlog: "open",
	progress: "claimed",
	review: "in_review",
	done: "done",
};

const refParts = (
	ref: string,
): { readonly repo: string; readonly n: string } | null => {
	if (!WORK_REF_RE.test(ref)) return null;
	const at = ref.lastIndexOf("#");
	return { repo: ref.slice(0, at), n: ref.slice(at + 1) };
};

const hrefOf = (card: CardRow): string | undefined => {
	const parts = refParts(card.ref);
	return parts ? `/${parts.repo}/-/work/${parts.n}` : undefined;
};

/** Cards of repos the viewer reads (one `authz.check` per repo). */
const visibleCards = async (
	x: ExtCtx,
	ctx: SlotContext,
	cards: readonly CardRow[],
): Promise<CardRow[]> => {
	// The kernel-derived viewer, else the render's acting principal when it is
	// a person (an anonymous render acts as the installation: no cards).
	const viewer = ctx.viewer ??
		(x.actor.kind === "user" || x.actor.kind === "agent" ? x.actor : undefined);
	if (viewer === undefined) return [];
	const repos = [
		...new Set(cards.map((c) => c.repo_id).filter((r) => r !== null)),
	];
	const readable = new Set<string>();
	for (const repo of repos) {
		try {
			if (await x.caps.authz.check(viewer.id, { id: repo! }, "read")) {
				readable.add(repo!);
			}
		} catch {
			// Outside the subtree or gone: not shown.
		}
	}
	return cards.filter((c) => c.repo_id !== null && readable.has(c.repo_id));
};

export const render = async (
	slot: string,
	ctx: SlotContext,
	_props: unknown,
	x: ExtCtx,
): Promise<UiDoc> => {
	if (slot !== "board" && slot !== "repo-board" && slot !== "nav") {
		return ui.doc(ui.empty(`tartan.board has no slot ${slot}`));
	}
	const store = createStore(x.sql);
	const columns = store.columns();
	const repoOnly = slot === "repo-board" ? ctx.repo : undefined;
	const all = await visibleCards(x, ctx, store.cards(repoOnly));
	const done = all.filter((c) => c.column_id === "done")
		.sort((a, b) => b.rank.localeCompare(a.rank))
		.slice(0, MAX_DONE);
	const open = all.filter((c) => c.column_id !== "done").slice(0, MAX_CARDS);
	const cards = [...open, ...done].sort((a, b) =>
		a.rank.localeCompare(b.rank) || a.ref.localeCompare(b.ref)
	);
	const board = ui.board(
		columns.map((c) => ({
			id: c.id,
			title: c.name,
			...(c.wip !== null ? { wip: c.wip } : {}),
		})),
		cards.map((c) => {
			const href = hrefOf(c);
			const badges = badgesOf(c);
			return {
				id: c.ref,
				col: c.column_id,
				title: c.title,
				...(href ? { href } : {}),
				...(badges.length > 0 ? { badges } : {}),
			};
		}),
		action("move"),
	);
	return ui.doc(
		all.length === 0
			? ui.stack([
				board,
				ui.empty(
					"No work yet",
					"Cards appear as work is created, claimed, submitted and landed.",
				),
			])
			: board,
		{ refreshOn: REFRESH },
	);
};

const text = (payload: unknown, name: string): string => {
	const v = (payload as Record<string, unknown> | null)?.[name];
	return typeof v === "string" ? v : "";
};

export const onAction = async (
	name: string,
	payload: unknown,
	_ctx: SlotContext,
	x: ExtCtx,
): Promise<ActionResult> => {
	if (name !== "move") throw invalid(`tartan.board has no action ${name}`);
	const ref = text(payload, "card");
	const to = text(payload, "to");
	const card = createStore(x.sql).card(ref);
	if (card === null) throw invalid(`no card ${ref}`);
	const parts = refParts(ref);
	if (card.kind !== "work" || parts === null) {
		return result.toast(
			"warning",
			"This card follows its change; it moves by itself.",
		);
	}
	const state = COLUMN_STATE[to];
	if (state === undefined) {
		return result.toast(
			"warning",
			"Landing is driven by the queue; cards move there by themselves.",
		);
	}
	if (card.column_id === to) return result.ok();
	// As the viewing user (interactive actor, bounded by its role).
	await x.caps.interfaces.call(
		"work@1",
		"work_update",
		{ ref, state },
		{ path: parts.repo },
	);
	return result.toast("success", `Moved ${ref}`);
};
