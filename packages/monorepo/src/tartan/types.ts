// The project-graph shapes the detector writes: the contract's optional
// `Project` and `ProjectGraph` fields, named here for the detector's own modules.

import type { Project, ProjectGraph } from "@tartan/contract";

export {
	PROJECT_SLUG_RE,
	type ProjectExtensions,
	type ProjectFidelity,
	type ProjectIssue,
} from "@tartan/contract";

/** How a project's name was found. */
export type NameSource = NonNullable<Project["nameSource"]>;

/** The optional per-project fields of a detected project. */
export type ProjectExtras = Pick<
	Project,
	| "key"
	| "slug"
	| "declaredName"
	| "nameSource"
	| "fidelity"
	| "issues"
	| "extensions"
>;

/** The optional graph-level fields of a detected graph. */
export type GraphExtras = Pick<
	ProjectGraph,
	| "detector"
	| "fidelity"
	| "skipped"
	| "warnings"
	| "truncated"
	| "packages"
>;
