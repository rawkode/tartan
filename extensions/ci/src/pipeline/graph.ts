// Affected projects over a project graph: a
// changed path is global when it matches a global file, is a project
// manifest, or lies outside every project root, and a global change affects
// every project. Otherwise the affected set is the projects holding a changed
// path (longest root wins) plus their dependents, transitively.
//
// K13: CI and review compute the affected set on the graph **at the change's
// base on trunk** (`caps.repo.projectGraph(repo, base)`), never on the
// lane's own graph, so a lane cannot shrink its test set by editing project
// declarations (those edits are manifest or root `*.cue` changes, which
// are global anyway). Same semantics as WP8's `affectedBy`
// (`packages/pipeline/test/graph.test.ts` compares them).
// `extensions/review/src/lib/graph.ts` must stay identical.

import type { Affected, Project } from "@tartan/contract";
import { globMatcher, isUnder } from "./glob.ts";

export type GraphLike = {
	readonly projects: readonly Project[];
	readonly globalFiles: readonly { readonly glob: string }[];
};

export type GlobalReason = "global-file" | "manifest" | "outside-projects";

/** Path → project lookups and closures over one graph. */
export const createProjectIndex = (graph: GraphLike) => {
	const byLength = [...graph.projects].sort((a, b) =>
		b.root.length - a.root.length
	);
	const globals = graph.globalFiles.map((g) => globMatcher(g.glob));
	const manifests = new Set(
		graph.projects.flatMap((p) => p.manifestPath ? [p.manifestPath] : []),
	);
	const byName = new Map(graph.projects.map((p) => [p.name, p]));

	const projectOf = (path: string): string | null =>
		byLength.find((p) => isUnder(path, p.root))?.name ?? null;

	const globalReason = (path: string): GlobalReason | null => {
		if (globals.some((m) => m(path))) return "global-file";
		if (manifests.has(path)) return "manifest";
		if (projectOf(path) === null) return "outside-projects";
		return null;
	};

	const closure = (
		names: Iterable<string>,
		next: (p: Project) => readonly string[],
	): Set<string> => {
		const out = new Set<string>();
		const queue = [...names];
		while (queue.length > 0) {
			const name = queue.pop()!;
			const project = byName.get(name);
			if (out.has(name) || project === undefined) continue;
			out.add(name);
			queue.push(...next(project));
		}
		return out;
	};

	/** `names` plus every project that depends on one of them, transitively. */
	const dependentsClosure = (names: Iterable<string>): Set<string> =>
		closure(names, (p) => p.dependents);

	/** `names` plus everything they depend on, transitively (input hashes). */
	const depsClosure = (names: Iterable<string>): Set<string> =>
		closure(names, (p) => p.deps);

	const allNames = graph.projects.map((p) => p.name).sort();

	const affected = (paths: readonly string[]): Affected => {
		const globalPaths = paths.filter((p) => globalReason(p) !== null);
		if (globalPaths.length > 0) {
			return { projects: allNames, global: true, globalPaths };
		}
		const direct = new Set(
			paths.map(projectOf).filter((n): n is string => n !== null),
		);
		return { projects: [...dependentsClosure(direct)].sort(), global: false };
	};

	return {
		projectOf,
		globalReason,
		dependentsClosure,
		depsClosure,
		affected,
		allNames,
		project: (name: string): Project | null => byName.get(name) ?? null,
	};
};
export type ProjectIndex = ReturnType<typeof createProjectIndex>;

/** The affected set of `paths` on `graph`. */
export const affectedOn = (
	graph: GraphLike,
	paths: readonly string[],
): Affected => createProjectIndex(graph).affected(paths);
