// tartan.epics: cross-repo epics and rollups.
// Owned by WP12 after M0.
//
// M0 stub. Renders are a placeholder. The `decompose` tool (MCP
// `epics_decompose`) and slot actions arrive with the implementation (M2), so
// until then agents are not offered a tool that always fails, and a slot
// action is refused with "has no actions" instead of a silent no-op. The
// manifest (`../tartan.json`), migrations and exports are the registry
// contract with `src/builtins.ts`; keep the export shape (`extension`,
// `migrations`, `protocol`) so the registry needs no edit.

import { type ExtensionModule, type UiDoc } from "@tartan/contract";

export { migrations } from "./migrations.ts";
/** Protocol card (`contributes.protocol`); none yet. */
export const protocol: string | undefined = undefined;

const EXT_ID = "tartan.epics";

const placeholder = (slot: string): UiDoc => ({
	v: 1,
	root: { t: "empty", text: `${EXT_ID} ${slot}: not implemented yet` },
});

export const extension: ExtensionModule = {
	init: () => Promise.resolve(),
	onEvent: () => Promise.resolve(),
	render: (slot) => Promise.resolve(placeholder(slot)),
};

export default extension;
