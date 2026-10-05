// tartan.hud: the forge heads-up display. Node scope: one installation counts
// every repository under its node. Counters: active lanes, predicted conflicts,
// conflicts avoided, landed per hour and the changes that needed a human, each
// with a one-hour sparkline and the share that came from simulated agents
// (events flagged `sim`).
//
// It subscribes to the lane, conflict, advance and review events only (never
// `*`), keeps one cursor per stream so redelivery and backfill count each
// event once, and renders read-only from its own tables.
//
// The manifest (`../tartan.json`), migrations and exports are the registry
// contract with `src/builtins.ts` (`extension`, `migrations`, `protocol`).

import type { Envelope, ExtCtx } from "@tartan/contract";
import { defineExtension } from "@tartan/ext-api";
import { createStore } from "./store.ts";
import { render } from "./ui.ts";

export { migrations } from "./migrations.ts";
/** Protocol card (`contributes.protocol`); the HUD has none. */
export const protocol: string | undefined = undefined;

const init = (_x: ExtCtx): Promise<void> => Promise.resolve();

const onEvent = (ev: Envelope, x: ExtCtx): Promise<void> => {
	createStore(x.sql).apply(ev);
	return Promise.resolve();
};

export const extension = defineExtension({ init, onEvent, render });

export default extension;
