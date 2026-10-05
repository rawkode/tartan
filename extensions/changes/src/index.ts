// tartan.changes: changes@1 provider: agent-first changes, revisions, threads.
// WP12.
//
// The manifest (`../tartan.json`), migrations and exports are the registry
// contract with `src/builtins.ts` (`extension`, `migrations`, `protocol`).

import { defineExtension } from "@tartan/ext-api";
import { onEvent } from "./events.ts";
import { callTool } from "./tools.ts";
import { onAction, render } from "./ui.ts";

export { migrations } from "./migrations.ts";
export { protocol } from "./protocol.ts";

export const extension = defineExtension({
	onEvent,
	render,
	onAction,
	callTool,
});

export default extension;
