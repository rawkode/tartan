// Affected projects and the K6 disjointness test. A changed path is global when
// it matches a global file, is a project manifest (`manifestPath`), or lies
// outside every project root; a global change affects every project. Otherwise
// the affected set is the projects holding a changed path (longest root wins)
// plus everything that depends on them, transitively.

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

	/** The project whose root holds `path` (the longest root wins). */
	const projectOf = (path: string): string | null =>
		byLength.find((p) => isUnder(path, p.root))?.name ?? null;

	const globalReason = (path: string): GlobalReason | null => {
		if (globals.some((m) => m(path))) return "global-file";
		if (manifests.has(path)) return "manifest";
		if (projectOf(path) === null) return "outside-projects";
		return null;
	};

	/** `names` plus every project that depends on one of them, transitively. */
	const dependentsClosure = (names: Iterable<string>): Set<string> => {
		const out = new Set<string>();
		const queue = [...names];
		while (queue.length > 0) {
			const name = queue.pop()!;
			if (out.has(name) || !byName.has(name)) continue;
			out.add(name);
			queue.push(...byName.get(name)!.dependents);
		}
		return out;
	};

	/** `names` plus everything they depend on, transitively (input hashes). */
	const depsClosure = (names: Iterable<string>): Set<string> => {
		const out = new Set<string>();
		const queue = [...names];
		while (queue.length > 0) {
			const name = queue.pop()!;
			if (out.has(name) || !byName.has(name)) continue;
			out.add(name);
			queue.push(...byName.get(name)!.deps);
		}
		return out;
	};

	const allNames = graph.projects.map((p) => p.name).sort();

	/** The affected set of a list of changed paths. */
	const affected = (paths: readonly string[]): Affected => {
		const globalPaths = paths.filter((p) => globalReason(p) !== null);
		if (globalPaths.length > 0) {
			return { projects: allNames, global: true, globalPaths };
		}
		const direct = new Set(paths.map(projectOf).filter((n) => n !== null));
		return { projects: [...dependentsClosure(direct)].sort(), global: false };
	};

	return {
		projectOf,
		globalReason,
		dependentsClosure,
		depsClosure,
		affected,
		project: (name: string) => byName.get(name) ?? null,
	};
};
export type ProjectIndex = ReturnType<typeof createProjectIndex>;

/** Shorthand: the affected set of `paths` on `graph`. */
export const affectedBy = (
	graph: GraphLike,
	paths: readonly string[],
): Affected => createProjectIndex(graph).affected(paths);

export type Landing = {
	readonly id: string;
	readonly paths: readonly string[];
	/** Projects recorded when it landed (`landings.projects_json`), if any. */
	readonly projects?: readonly string[];
};

export type DisjointReason =
	| { readonly kind: "batch-global"; readonly paths: readonly string[] }
	| {
		readonly kind: "landing-global";
		readonly landing: string;
		readonly paths: readonly string[];
	}
	| {
		readonly kind: "overlap";
		readonly landing: string;
		readonly projects: readonly string[];
	};

export type DisjointResult = {
	readonly disjoint: boolean;
	/** The batch's affected set, recomputed on the graph at T. */
	readonly affected: Affected;
	readonly reasons: readonly DisjointReason[];
};

/**
 * K6: may a batch tested on base B land on trunk T without re-test? Its
 * affected set is recomputed on the graph at T; no landing in (B, T] may
 * share a project with it, and neither side may touch a global file, a
 * manifest or a path outside every project root. (`git merge-tree`
 * cleanliness is the Advance's own check.)
 */
export const checkDisjoint = (
	graphAtT: GraphLike,
	batchPaths: readonly string[],
	landings: readonly Landing[],
): DisjointResult => {
	const index = createProjectIndex(graphAtT);
	const affected = index.affected(batchPaths);
	const reasons: DisjointReason[] = [];
	if (affected.global) {
		reasons.push({ kind: "batch-global", paths: affected.globalPaths ?? [] });
	}
	const mine = new Set(affected.projects);
	for (const landing of landings) {
		const theirs = index.affected(landing.paths);
		if (theirs.global) {
			reasons.push({
				kind: "landing-global",
				landing: landing.id,
				paths: theirs.globalPaths ?? [],
			});
			continue;
		}
		const touched = new Set([...theirs.projects, ...(landing.projects ?? [])]);
		const shared = [...touched].filter((p) => mine.has(p)).sort();
		if (shared.length > 0) {
			reasons.push({ kind: "overlap", landing: landing.id, projects: shared });
		}
	}
	return { disjoint: reasons.length === 0, affected, reasons };
};
