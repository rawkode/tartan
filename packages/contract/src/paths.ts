// Node and repo path shapes. A module of its own,
// with no imports and no top-level work, so the SPA bundle can import it
// (through slot-ctx.ts) without pulling in anything else.

/** Node path: slugs joined by `/` (`NodePathSchema` adds the 1–16384 length). */
export const NODE_PATH_RE = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;
/** Repo-relative path: no leading `/`, no `..` segment, no control characters. */
export const REPO_PATH_RE =
	// deno-lint-ignore no-control-regex
	/^(?!\/)(?!(?:.*\/)?\.\.(?:\/|$))[^\u0000-\u001f]*$/;

/**
 * K13.3 (ADR repo config): whether a repo-relative path is a policy path:
 * its first segment, a root entry, is named `*.cue` (a `*.cue` file directly
 * in the repository root, of any CUE package, or anything under a root
 * directory so named). Tartan config is the root package `tartan`, but the
 * kernel never reads package clauses (a second loader could disagree with
 * the CLI), so every root `*.cue` entry counts: exactly the entries the
 * evaluator's input set and the policy digest are built from (a directory
 * named `*.cue` is rejected there, and changing it needs a sign-off too).
 * Compared byte for byte on the raw path with no normalization, so no line
 * terminator, case or Unicode trick steps around it. A rename is
 * policy-touching when either name is. The kernel, repository config and
 * `tartan.review` share this one predicate.
 */
export const isPolicyPath = (path: string): boolean =>
	(path.split("/")[0] ?? "").endsWith(".cue");
