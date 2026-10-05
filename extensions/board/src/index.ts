// tartan.board: Kanban projection of work, changes, queue and lanes.
// Backfills every event at install (`backfill: "all"`). WP12.
//
// The manifest (`../tartan.json`), migrations and exports are the registry
// contract with `src/builtins.ts` (`extension`, `migrations`, `protocol`).

import type { Envelope, ExtCtx } from "@tartan/contract";
import { defineExtension } from "@tartan/ext-api";
import { createProjection } from "./projection.ts";
import { createStore } from "./store.ts";
import { onAction, render } from "./ui.ts";

export { migrations } from "./migrations.ts";
/** Protocol card (`contributes.protocol`); the board has none. */
export const protocol: string | undefined = undefined;

const init = (x: ExtCtx): Promise<void> => {
	createStore(x.sql).ensureBoard(x.install.node.id);
	return Promise.resolve();
};

const onEvent = (ev: Envelope, x: ExtCtx): Promise<void> => {
	const store = createStore(x.sql);
	store.ensureBoard(x.install.node.id);
	createProjection(store).apply(ev);
	return Promise.resolve();
};

export const extension = defineExtension({ init, onEvent, render, onAction });

export default extension;
