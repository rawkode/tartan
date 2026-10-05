// Which work items and changes belong on a project's page (WP25 slice
// A′). Projects are a filter, not a store:
//
// - a work item is the project's when its footprint names the project (by
//   graph name, raw cuenv name, slug or root) or a footprint prefix lies in
//   the project's root (the longest root holding it, as radar maps paths);
// - a change is the project's when its latest revision's affected set holds
//   the project's name, or `*` (a global file changed: every project is
//   affected). A draft never submitted has no revision and no set.

import type {
	Change,
	ProjectChangeDto,
	ProjectDto,
	ProjectGraph,
	ProjectWorkItemDto,
	WorkItem,
} from "@tartan/contract";
import { createProjectIndex } from "@tartan/monorepo";

const LIVE_CLAIMS = new Set(["active", "submitted"]);

const normalPrefix = (prefix: string): string =>
	prefix.replace(/^\.?\/+/, "").replace(/\/+$/, "");

/** A footprint's match with the project, or null. */
export const workMatch = (
	item: Pick<WorkItem, "footprint">,
	project: ProjectDto,
	projectOf: (path: string) => string | null,
): ProjectWorkItemDto["matched"] | null => {
	const names = new Set(
		[project.name, project.cuenvName, project.slug, project.root].filter((
			n,
		): n is string => typeof n === "string" && n !== ""),
	);
	if (item.footprint.projects.some((p) => names.has(p))) return "project";
	return item.footprint.prefixes.some((prefix) => {
			const path = normalPrefix(prefix);
			return path !== "" && projectOf(path) === project.name;
		})
		? "prefix"
		: null;
};

/** The project's work items among `items`, reduced to the page's fields. */
export const filterWork = (
	graph: ProjectGraph,
	project: ProjectDto,
	items: readonly WorkItem[],
): ProjectWorkItemDto[] => {
	const index = createProjectIndex(graph);
	return items.flatMap((item) => {
		const matched = workMatch(item, project, index.projectOf);
		if (matched === null) return [];
		return [{
			ref: item.ref,
			kind: item.kind,
			title: item.title,
			state: item.state,
			labels: item.labels,
			priority: item.priority,
			footprint: {
				projects: item.footprint.projects,
				prefixes: item.footprint.prefixes,
			},
			claims: item.claims.filter((c) => LIVE_CLAIMS.has(c.state)).length,
			matched,
		}];
	});
};

/** The latest revision of a change (highest `n`), or null for a draft. */
const latest = (change: Pick<Change, "revisions">) =>
	change.revisions.reduce<Change["revisions"][number] | null>(
		(best, r) => best === null || r.n > best.n ? r : best,
		null,
	);

/** The project's changes among `changes`, reduced to the page's fields. */
export const filterChanges = (
	project: ProjectDto,
	changes: readonly Change[],
): ProjectChangeDto[] =>
	changes.flatMap((change) => {
		const revision = latest(change);
		if (revision === null) return [];
		const global = revision.affected.includes("*");
		if (!global && !revision.affected.includes(project.name)) return [];
		return [{
			changeId: change.changeId,
			title: change.title,
			state: change.state,
			...(change.workRef !== undefined ? { workRef: change.workRef } : {}),
			laneId: change.laneId,
			author: change.author,
			revision: revision.n,
			affected: revision.affected,
			global,
			at: revision.at,
		}];
	});
