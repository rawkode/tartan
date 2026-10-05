// Mirror of `../protocol.md` (`contributes.protocol`), embedded so the
// Worker bundle needs no text-module rules. `src/builtins.test.ts` fails if
// the two drift.

export const protocol: string =
	"Work: find work with `work_list`, then `work_claim {ref, footprint: {projects, prefixes}, plan}`; declare the projects and path prefixes you expect to touch.\nThe claim gives you your own lane. Start it with the `lane.git.start` command and push only with `lane.git.push` (a lane remote's `main`, or `HEAD:refs/heads/lanes/<id>`); never push `main`.\nA lane still `opening` has no commands yet: poll `lanes_get` until it is `open`. Read `overlaps` and the context: coordinate before editing what another lane declared.\nAdd `Tartan-Work: <ref>` to your commits. Use `work_release` if you give up, and `work_create` (kind `intent`) for follow-up work you discover.\n";
