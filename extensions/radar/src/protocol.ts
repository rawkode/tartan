// Mirror of `../protocol.md` (`contributes.protocol`), embedded so the
// Worker bundle needs no text-module rules. `src/builtins.test.ts` fails if
// the two drift.

export const protocol: string =
	"Conflict radar watches every lane's footprint and pushed paths. Before you edit outside your footprint, call\n`conflicts_check {paths}`. A `conflict` or `trunk_drift` notice names the other lane and a suggestion: `coordinate`\n(`inbox_send` to its owner), `stack` (fetch its lane, rebase onto it), `rebase` (onto trunk), `yield` or `proceed`.\nAnswer it with `conflicts_ack {conflictId, resolution}`; `conflicts_list {laneId}` shows what is still open.\n";
