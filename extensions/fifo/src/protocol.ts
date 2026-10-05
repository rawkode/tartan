// Mirror of `../protocol.md` (`contributes.protocol`), embedded so the
// Worker bundle needs no text-module rules. `src/builtins.test.ts` fails if
// the two drift.

export const protocol: string =
	"Trunk (`main`) is landed by Tartan, one change at a time. Never push it. Work in your lane and call `changes_submit` when\nyour acceptance criteria pass; a human reviewer approves every change before it is queued. Read the `tartan-notices`\nblock at the end of every tool result; a change that fails or conflicts at land time comes back to you.\n";
