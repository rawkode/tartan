// Slot ctx hints the SPA sends with `/-/api/slot/*`. The type, the shape and
// the per-slot rule are the contract's (`@tartan/contract/slot-ctx.ts`, the
// same rule the kernel refuses with):
//
// - each page builds ONE hint with the builders below (typed against
//   `SlotCtxHint`, so `vue-tsc` refuses a key the kernel does not take);
// - `SlotHost` narrows it per slot with `narrowCtx` before every render and
//   action, so a page hosting slots with different contexts (a file banner
//   next to the repo sidebar, a change tab next to the change panels) sends
//   each slot only what its catalogue context takes.
//
// Every value is a hint: the kernel resolves and confines all of them
// (K12). Pages name their node with `node` (a repo page's node is the repo; the
// kernel derives `repo` from the node's kind).

import {
	narrowSlotCtx,
	type SlotCtxHint,
	type SlotCtxLines,
	type SlotEntityKind,
} from "@tartan/contract/slot-ctx.ts";
import { isKnownSlot } from "@tartan/contract/slots.ts";

export type { SlotCtxHint, SlotEntityKind };

/** A node or repo page with nothing more specific (overview, compare, settings). */
export const nodeCtx = (node: string): SlotCtxHint => ({ node });

/** A repo code page: tree, file, history, commit or blame. */
export const repoCtx = (
	node: string,
	at: {
		/** Branch, tag or SHA; empty means the default branch (no hint). */
		readonly ref?: string;
		/** Repo-relative file path (file and blame pages). */
		readonly path?: string;
		readonly lines?: SlotCtxLines;
	} = {},
): SlotCtxHint => ({
	node,
	...(at.ref ? { ref: at.ref } : {}),
	...(at.path ? { path: at.path } : {}),
	...(at.lines ? { lines: at.lines } : {}),
});

/** A change, lane or work item page. */
export const entityCtx = (
	node: string,
	kind: SlotEntityKind,
	id: string,
	more: {
		/** The selected `change.tab` (its route). */
		readonly route?: string;
		readonly revision?: number;
		readonly gate?: string;
	} = {},
): SlotCtxHint => ({
	node,
	entity: { kind, id },
	...(more.route ? { route: more.route } : {}),
	...(more.revision !== undefined ? { revision: more.revision } : {}),
	...(more.gate ? { gate: more.gate } : {}),
});

/** An extension tab page (`/-/<tab>/<route>`): the sub-route after the tab. */
export const tabCtx = (node: string, route?: string): SlotCtxHint => ({
	node,
	...(route ? { route } : {}),
});

/**
 * What one slot takes of a page's hint (`narrowSlotCtx`, the contract's
 * rule). Unknown slots get the page hint unchanged; the kernel refuses them.
 */
export const narrowCtx = (slot: string, ctx: SlotCtxHint): SlotCtxHint =>
	isKnownSlot(slot) ? narrowSlotCtx(slot, ctx) : ctx;

/**
 * A stable key for a narrowed hint (a slot re-renders when it changes):
 * top-level keys sorted; `narrowSlotCtx` rebuilds `entity` and `lines` in a
 * fixed key order.
 */
export const ctxKey = (ctx: SlotCtxHint): string =>
	JSON.stringify(
		Object.fromEntries(
			Object.entries(ctx).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
		),
	);
