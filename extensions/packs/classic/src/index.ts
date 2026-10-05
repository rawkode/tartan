// tartan.pack.classic: the Classic protocol pack. Like
// every pack it has no code or storage; unlike the Swarm pack it carries its
// own protocol card (`../protocol.md`): the issues and pull requests wording
// an agent reads first in a Classic subtree, before its members' cards.
//
// The card is embedded so the Worker bundle needs no text-module rules;
// `extensions/packs/test/packs.test.ts` fails if it drifts from the file.
// `src/builtins.ts` registers this module for the Classic pack.

import type { ExtensionModule, ExtMigration } from "@tartan/contract";

export const migrations: readonly ExtMigration[] = [];

export const protocol: string =
	"Classic protocol: issues and pull requests. Here an issue is a `work` item and a pull request is a `change`.\n\n- Issues: `work_list` and `work_get` read them, `work_create` files one, and `work_claim {ref}` takes one and opens your lane.\n- Pull requests: your lane is a draft pull request. Push with the lane's `git.push` command, then call `changes_submit {laneId, title, summary}` to open it for review.\n- A human Maintainer reviews every pull request; nothing is approved automatically. Answer review threads with `changes_comment`; every push is a new revision and is reviewed again.\n- Approved pull requests land one at a time, first in, first out (`queue_status`). There are no conflict notices here: fetch trunk and rebase before you submit.\n";

export const extension: ExtensionModule = {};

export default extension;
