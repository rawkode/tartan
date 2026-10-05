// The probe's side of WP25 slice A′: how a cuenv graph
// is told apart from a graph computed without cuenv, and which of its fields
// RepoDO stores. No migration: the graph JSON in `project_graphs` carries
// the contract's optional graph fields as they are; the `projects` mirror keeps its
// columns, and `name` stays its primary key because cuenv names are unique
// by construction.

import type { ProjectGraph } from "@tartan/contract";
import type { GraphExtras } from "@tartan/monorepo/cuenv/types.ts";
import type { ProjectsMode } from "../projects/mode.ts";

/**
 * The `TARTAN_PROJECTS` mode a stored graph was computed under: every graph
 * of `scan` names its detector, and no graph of `off` does. RepoProbe
 * recomputes a cached graph whose mode differs (a switch flip), as it does
 * for a graph computed under another trunk config.
 */
export const graphMode = (graph: ProjectGraph): ProjectsMode =>
	graph.detector === undefined ? "off" : "scan";

const EXTRA_KEYS = [
	"detector",
	"fidelity",
	"layers",
	"skipped",
	"warnings",
	"truncated",
	"packages",
	"rootProject",
] as const satisfies readonly (keyof GraphExtras)[];

/** The cuenv graph-level fields of `graph`, for `project_graphs.graph_json`. */
export const storedExtras = (graph: ProjectGraph): GraphExtras => {
	const v = graph as Record<string, unknown>;
	return Object.fromEntries(
		EXTRA_KEYS.flatMap((k) => v[k] === undefined ? [] : [[k, v[k]]]),
	) as GraphExtras;
};
