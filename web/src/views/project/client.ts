// The SPA's client of the projects API (WP25 slice A′):
// `GET /-/api/repos/<repoId>/projects[/<slug>[/issues|/changes]]`, and the
// project page URLs (`/<repo>/-/p[/<slug>[/<tab>]]`). The client is
// provided by the app (in `main.ts`: the mock build passes its
// mock fetch); without a provider it uses the browser's fetch, which is
// what a production build's API client uses too.

import { inject, type InjectionKey } from "vue";
import { createHttp, type Http } from "../../api/http.ts";
import { nodeHref } from "../../router/params.ts";
import type {
	ProjectChangesResponse,
	ProjectDetailResponse,
	ProjectIssuesResponse,
	ProjectsResponse,
} from "./types.ts";

export type ProjectsClient = {
	readonly list: (repoId: string) => Promise<ProjectsResponse>;
	readonly detail: (
		repoId: string,
		project: string,
	) => Promise<ProjectDetailResponse>;
	readonly issues: (
		repoId: string,
		project: string,
		state?: string,
	) => Promise<ProjectIssuesResponse>;
	readonly changes: (
		repoId: string,
		project: string,
		state?: string,
	) => Promise<ProjectChangesResponse>;
};

const enc = encodeURIComponent;

/** `/-/api/repos/<repoId>/projects[/<rest>]`. */
export const projectsEndpoint = (repoId: string, ...rest: string[]): string =>
	[`/-/api/repos/${enc(repoId)}/projects`, ...rest.map(enc)].join("/");

export const createProjectsClient = (http: Http): ProjectsClient => ({
	list: (repoId) => http.get<ProjectsResponse>(projectsEndpoint(repoId)),
	detail: (repoId, project) =>
		http.get<ProjectDetailResponse>(projectsEndpoint(repoId, project)),
	issues: (repoId, project, state) =>
		http.get<ProjectIssuesResponse>(
			projectsEndpoint(repoId, project, "issues"),
			{ state },
		),
	changes: (repoId, project, state) =>
		http.get<ProjectChangesResponse>(
			projectsEndpoint(repoId, project, "changes"),
			{ state },
		),
});

export const PROJECTS: InjectionKey<ProjectsClient> = Symbol("projects");

let fallback: ProjectsClient | null = null;

/** The provided client, else one over the browser's fetch. */
export const useProjects = (): ProjectsClient =>
	inject(PROJECTS, null) ??
		(fallback ??= createProjectsClient(
			createHttp((input, init) => globalThis.fetch(input, init)),
		));

export type ProjectTab = "overview" | "issues" | "changes";

/** `/<repo>/-/p` (every project) or `/<repo>/-/p/<slug>[/<tab>]`. */
export const projectHref = (
	repoPath: string,
	slug?: string,
	tab: ProjectTab = "overview",
): string =>
	slug === undefined
		? `${nodeHref(repoPath)}/-/p`
		: `${nodeHref(repoPath)}/-/p/${enc(slug)}${
			tab === "overview" ? "" : `/${tab}`
		}`;

/** `/<repo>/-/work/<n>` for a work ref `<repo>#<n>`. */
export const workHref = (repoPath: string, ref: string): string =>
	`${nodeHref(repoPath)}/-/work/${enc(ref.slice(ref.lastIndexOf("#") + 1))}`;

/** A one-line summary of a graph for the repo overview card. */
export const graphSummary = (graph: ProjectsResponse): string => {
	const n = graph.projects.length;
	const parts = [
		graph.detector === "cuenv"
			? `${n} cuenv ${n === 1 ? "project" : "projects"} found${
				graph.fidelity === "scan" ? " (textual scan)" : ""
			}`
			: `${n} ${n === 1 ? "project" : "projects"} detected${
				graph.detector === "config" ? " from package tartan" : ""
			}`,
	];
	if (graph.layers.length > 0) {
		parts.push(
			`${graph.layers.length} ${
				graph.layers.length === 1 ? "layer" : "layers"
			}`,
		);
	}
	const nested = graph.skipped.filter((s) => !s.endsWith("-limit")).length;
	if (nested > 0) {
		parts.push(
			`${nested} nested ${nested === 1 ? "module" : "modules"} skipped`,
		);
	}
	return parts.join(" · ");
};
