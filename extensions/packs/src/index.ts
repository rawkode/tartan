// tartan.pack.swarm and tartan.pack.classic: protocol packs.
// Owned by WP12 after M0.
//
// A pack is a manifest (`../swarm/tartan.json`, `../classic/tartan.json`) whose
// `members` the registry installs together at a node. It has no code, storage
// or protocol card of its own (the members' cards are concatenated), so both
// packs share this empty module. Keep the export shape (`extension`,
// `migrations`, `protocol`) so `src/builtins.ts` needs no edit.

import type { ExtensionModule, ExtMigration } from "@tartan/contract";

export const migrations: readonly ExtMigration[] = [];
/** Packs carry no card of their own. */
export const protocol: string | undefined = undefined;

export const extension: ExtensionModule = {};

export default extension;
