// Projects of a graph as the API shows them, and `resolveProject`: a
// project named by its slug, its root (the key), its graph name or its raw
// cuenv name (agents type either a name or a root; URLs carry the slug).
// Graphs without slugs (the workspace detectors) get them here by the
// same rule as the cuenv detector, so every project has a page.

import { slugOf } from "@tartan/monorepo/cuenv/identity.ts";
import type {
	Project,
	ProjectDto,
	ProjectGraph,
	ProjectRefDto,
	ProjectsRepoDto,
	ProjectsResponse,
} from "@tartan/contract";

/** Slugs for every project: the graph's own, else `slugOf(name)` made unique by `-<n>`. */
const slugsOf = (projects: readonly Project[]): Map<string, string> => {
	const out = new Map<string, string>();
	const used = new Set(
		projects.flatMap((p) => p.slug !== undefined ? [p.slug] : []),
	);
	for (const p of [...projects].sort((a, b) => a.root < b.root ? -1 : 1)) {
		if (p.slug !== undefined) {
			out.set(p.name, p.slug);
			continue;
		}
		const base = slugOf(p.name);
		let slug = base;
		for (let n = 2; used.has(slug); n++) slug = `${base.slice(0, 120)}-${n}`;
		used.add(slug);
		out.set(p.name, slug);
	}
	return out;
};

export type ProjectView = {
	readonly graph: ProjectGraph;
	readonly projects: readonly ProjectDto[];
	/** By slug. */
	readonly bySlug: ReadonlyMap<string, ProjectDto>;
	readonly ref: (name: string) => ProjectRefDto | null;
};

const dtoOf = (p: Project, slug: string): ProjectDto => ({
	key: p.key ?? p.root,
	name: p.name,
	slug,
	root: p.root,
	...(p.cuenvName !== undefined ? { cuenvName: p.cuenvName } : {}),
	source: p.source,
	...(p.nameSource !== undefined ? { nameSource: p.nameSource } : {}),
	...(p.fidelity !== undefined ? { fidelity: p.fidelity } : {}),
	layers: p.layers ?? [],
	deps: p.deps,
	dependents: p.dependents,
	...(p.manifestPath !== undefined ? { manifestPath: p.manifestPath } : {}),
	issues: p.issues ?? [],
});

/** The DTOs of a graph's projects, sorted by root. */
export const projectView = (graph: ProjectGraph): ProjectView => {
	const g = graph;
	const slugs = slugsOf(g.projects);
	const projects = [...g.projects]
		.sort((a, b) => a.root < b.root ? -1 : a.root > b.root ? 1 : 0)
		.map((p) => dtoOf(p, slugs.get(p.name)!));
	const byName = new Map(projects.map((p) => [p.name, p]));
	return {
		graph: g,
		projects,
		bySlug: new Map(projects.map((p) => [p.slug, p])),
		ref: (name) => {
			const p = byName.get(name);
			return p ? { name: p.name, slug: p.slug, root: p.root } : null;
		},
	};
};

/**
 * A project by slug, root, graph name or raw cuenv name (in that order of
 * precedence); null when none matches.
 */
export const resolveProject = (
	view: ProjectView,
	ref: string,
): ProjectDto | null =>
	view.bySlug.get(ref) ??
		view.projects.find((p) => p.root === ref) ??
		view.projects.find((p) => p.name === ref) ??
		view.projects.find((p) => p.cuenvName === ref) ??
		null;

/** The list response for a graph (or for a repo without commits). */
export const projectsResponse = (
	repo: ProjectsRepoDto,
	graph: ProjectGraph | null,
): ProjectsResponse => {
	if (graph === null) {
		return {
			repo,
			sha: null,
			detector: null,
			fidelity: null,
			projects: [],
			layers: [],
			skipped: [],
			warnings: [],
			truncated: false,
			global: [],
		};
	}
	const view = projectView(graph);
	const g = view.graph;
	return {
		repo,
		sha: g.sha,
		detector: g.detector ?? null,
		fidelity: g.fidelity ?? null,
		projects: view.projects,
		layers: g.layers ?? [],
		skipped: g.skipped ?? [],
		warnings: g.warnings ?? [],
		truncated: g.truncated === true,
		...(g.rootProject ? { rootProject: g.rootProject } : {}),
		global: g.globalFiles.map((f) => f.glob),
	};
};
