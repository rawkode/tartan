// The probe's side of project discovery: which graph fields RepoDO stores. No
// migration: the graph JSON in `project_graphs` carries the contract's optional
// graph fields as they are; the `projects` mirror keeps its columns, and `name`
// stays its primary key because names are unique by construction.

import type { ProjectGraph } from "@tartan/contract";
import type { GraphExtras } from "@tartan/monorepo/tartan/types.ts";

/**
 * Whether a stored graph came from the current detector: RepoProbe recomputes
 * any other, as it does for a graph computed under another trunk config.
 */
export const isCurrentGraph = (graph: ProjectGraph): boolean =>
	graph.detector === "tartan";

const EXTRA_KEYS = [
	"detector",
	"fidelity",
	"skipped",
	"warnings",
	"truncated",
	"packages",
] as const satisfies readonly (keyof GraphExtras)[];

/** The detector's graph-level fields of `graph`, for `project_graphs.graph_json`. */
export const storedExtras = (graph: ProjectGraph): GraphExtras => {
	const v = graph as Record<string, unknown>;
	return Object.fromEntries(
		EXTRA_KEYS.flatMap((k) => v[k] === undefined ? [] : [[k, v[k]]]),
	) as GraphExtras;
};
