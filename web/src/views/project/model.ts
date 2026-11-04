// Pure helpers of the project pages (WP25 slice A′): grouping, notes,
// captions. No Vue, so the specs test them directly.

import type {
	ProjectChangeDto,
	ProjectDto,
	ProjectWorkItemDto,
} from "./types.ts";

export type ProjectGroup = {
	readonly key: string;
	readonly label: string;
	readonly projects: readonly ProjectDto[];
};

const byRoot = (a: ProjectDto, b: ProjectDto) =>
	a.root < b.root ? -1 : a.root > b.root ? 1 : 0;

/**
 * Projects grouped by the deepest layer above them (`byLayer`), or by
 * their top-level directory; groups and projects sorted by path.
 */
export const groupProjects = (
	projects: readonly ProjectDto[],
	byLayer: boolean,
): ProjectGroup[] => {
	const groups = new Map<string, ProjectDto[]>();
	for (const p of projects) {
		const key = byLayer
			? p.layers.at(-1) ?? ""
			: p.root.includes("/")
			? p.root.slice(0, p.root.indexOf("/"))
			: "";
		groups.set(key, [...(groups.get(key) ?? []), p]);
	}
	return [...groups.entries()]
		.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
		.map(([key, list]) => ({
			key,
			label: key === ""
				? (byLayer ? "Repository root layer" : "Top level")
				: key,
			projects: [...list].sort(byRoot),
		}));
};

export type Note = {
	readonly label: string;
	readonly tone: "muted" | "info" | "warning";
	readonly title: string;
};

/** Chips for what the scan could not settle about a project. */
export const projectNotes = (p: ProjectDto): Note[] => {
	const notes: Note[] = [];
	if (p.nameSource === "directory") {
		notes.push({
			label: "name from the directory",
			tone: "info",
			title: "No literal name in its .cue file; the directory name is used",
		});
	}
	if (p.declaredName !== undefined) {
		notes.push({
			label: "duplicate name",
			tone: "warning",
			title: `Another project is also named ${p.declaredName}`,
		});
	}
	if (p.issues.some((i) => i.code === "nested-project")) {
		notes.push({
			label: "nested",
			tone: "info",
			title: "Inside another project; the longest root wins",
		});
	}
	return notes;
};

/** Where the project came from, for its chip. */
export const sourceLabel = (p: ProjectDto): string =>
	p.source === "tartan" ? "package tartan" : p.source;

/** "matched by footprint" captions of a work item. */
export const matchLabel = (item: ProjectWorkItemDto): string =>
	item.matched === "project"
		? "footprint names this project"
		: "footprint path in this project";

/** "affects 2 of 38" for a change (every project for a global change). */
export const affectsLabel = (change: ProjectChangeDto, total: number): string =>
	change.global
		? `affects all ${total} (repo-wide file)`
		: `affects ${change.affected.length} of ${total}`;
