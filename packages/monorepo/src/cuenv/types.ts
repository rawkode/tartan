// The project-graph shapes the cuenv detector writes (WP25 slice A′): the
// contract's optional `Project` and `ProjectGraph` fields, named here for
// the detector's own modules.

import type { Project, ProjectGraph } from "@tartan/contract";

export {
	PROJECT_SLUG_RE,
	type ProjectFidelity,
	type ProjectIssue,
	type ProjectLayer,
} from "@tartan/contract";

/** Where a graph's projects came from. */
export type GraphDetector = NonNullable<ProjectGraph["detector"]>;

/** How a project's name was found. */
export type NameSource = NonNullable<Project["nameSource"]>;

/** The optional per-project fields of a cuenv project. */
export type ProjectExtras = Pick<
	Project,
	"key" | "slug" | "cuenvName" | "nameSource" | "layers" | "fidelity" | "issues"
>;

/** The optional graph-level fields of a graph computed with `cuenv`. */
export type GraphExtras = Pick<
	ProjectGraph,
	| "detector"
	| "fidelity"
	| "layers"
	| "skipped"
	| "warnings"
	| "truncated"
	| "packages"
	| "rootProject"
>;
