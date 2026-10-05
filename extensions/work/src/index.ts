// tartan.work: work@1 provider: issues, intents, resolver items, claims.
// WP12.
//
// The manifest (`../tartan.json`), migrations and exports are the registry
// contract with `src/builtins.ts` (`extension`, `migrations`, `protocol`).

import type { ContextRequest, ContextSection, ExtCtx } from "@tartan/contract";
import { defineExtension } from "@tartan/ext-api";
import { itemSections } from "./context.ts";
import { onEvent } from "./events.ts";
import { repoOf, workItemOf } from "./repo.ts";
import { createStore, type ItemRow, parseWorkRef } from "./store.ts";
import { callTool } from "./tools.ts";
import { onAction, render } from "./ui.ts";

export { migrations } from "./migrations.ts";
export { protocol } from "./protocol.ts";

/** `context@1`: the item named by `work`, else the one claimed with `laneId`. */
const context = async (
	req: ContextRequest,
	x: ExtCtx,
): Promise<ContextSection[]> => {
	const store = createStore(x.sql);
	const parsed = req.work ? parseWorkRef(req.work) : null;
	let row: ItemRow | null = null;
	if (parsed) {
		row = store.itemByNumber(parsed.n);
	} else if (req.laneId) {
		const claim = store.claimByLane(req.laneId);
		row = claim ? store.item(claim.item_id) : null;
	}
	if (row === null) return [];
	const repo = await repoOf(x, req.repoId);
	if (parsed && parsed.repo !== repo.path) return [];
	return itemSections(workItemOf(x, repo, row), req.maxBytes);
};

export const extension = defineExtension({
	onEvent,
	render,
	onAction,
	callTool,
	context,
});

export default extension;
