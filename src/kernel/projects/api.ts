// The read-only projects API (WP25 slice A′), behind `TARTAN_PROJECTS`
// (404 everywhere while `off`):
//
//   GET /-/api/repos/<repoId>/projects[?sha=]          the graph
//   GET /-/api/repos/<repoId>/projects/<slug>          one project
//   GET /-/api/repos/<repoId>/projects/<slug>/issues   its work items
//   GET /-/api/repos/<repoId>/projects/<slug>/changes  its changes
//
// Reads follow the repo: whoever may read it reads its projects (the public
// view of a public repo included). The graph is the one at the trunk tip
// (K13: projects are facts of trunk), detected lazily on its first read;
// `?sha=` needs Reporter+ and a trunk commit, and an uncached one is
// rate-limited per principal. The project segment is a slug, a root, a
// graph name or a raw cuenv name. The lists call `work_list` and
// `changes_list` on the providers in force **as the viewer** (the tools' own
// role check decides; anonymous callers are asked to sign in) and keep the
// items whose footprint names the project and the changes whose latest
// revision's affected set holds it.

import {
	type Change,
	ChangeStateSchema,
	type InstallationInForce,
	invalid,
	isSha,
	isUlid,
	type NodeDto,
	notFound,
	type ProjectGraph,
	rateLimited,
	ROLE,
	scopesAllow,
	type ToolContext,
	unauthenticated,
	type WorkItem,
	WorkStateSchema,
} from "@tartan/contract";
import { actorBoundsOf, type AuthContext } from "@tartan/contract/kernel.ts";
import type { RouteContext, RouteHandler } from "../../router.ts";
import { failure, json, optionalParam } from "../browse/http.ts";
import { graphMode } from "../probe/projects.ts";
import { accessFacts, decide, memberRole } from "../tree/authz.ts";
import { type ProjectsDeps, projectsDepsOf } from "./deps.ts";
import { docsOf } from "./docs.ts";
import type {
	ProjectChangesResponse,
	ProjectDetailResponse,
	ProjectDto,
	ProjectIssuesResponse,
	ProjectRefDto,
	ProjectsRepoDto,
} from "@tartan/contract";
import { filterChanges, filterWork } from "./filter.ts";
import { projectsResponse, projectView, resolveProject } from "./resolve.ts";

/** Items per `work_list`/`changes_list` page (the tools' maximum). */
export const LIST_PAGE = 200;
/** Pages one list request reads before it answers `complete: false`. */
export const LIST_PAGES_MAX = 5;
/** Items or changes one list answers. */
export const LIST_MAX = 200;
/** Known slugs named in a 404 for an unknown project. */
const KNOWN_SLUGS_SHOWN = 64;

export type ProjectsDepsFor = (c: RouteContext) => ProjectsDeps;
const defaultDeps: ProjectsDepsFor = (c) => projectsDepsOf(c.env, c.ctx);

type Target = {
	readonly node: NodeDto;
	readonly repo: ProjectsRepoDto;
	/** Below Reporter as a member: the public view (no `?sha=`). */
	readonly publicView: boolean;
};

/** A repo the caller may read, by id (404 for one it may not even see). */
const openRepo = async (
	deps: ProjectsDeps,
	auth: AuthContext | null,
	repoId: string,
): Promise<Target> => {
	if (!isUlid(repoId)) throw notFound("no such repo");
	const tree = deps.tree();
	const node = await tree.node(repoId);
	if (node === null || node.kind !== "repo") throw notFound("no such repo");
	const facts = await accessFacts(tree, auth, node);
	try {
		decide(auth, node, facts, "read-metadata");
	} catch {
		throw notFound("no such repo");
	}
	decide(auth, node, facts, "read");
	const readable = auth === null ||
		scopesAllow(actorBoundsOf(auth).scopes, "read");
	const member = readable ? memberRole(auth, node, facts) : ROLE.none;
	return {
		node,
		repo: { id: node.id, path: node.path },
		publicView: member < ROLE.reporter,
	};
};

/** The graph at the trunk tip, or at a trunk commit named by `?sha=`. */
const graphOf = async (
	deps: ProjectsDeps,
	target: Target,
	url: URL,
	auth: AuthContext | null,
): Promise<ProjectGraph | null> => {
	const sha = optionalParam(url, "sha", 64);
	const repoId = target.node.id;
	if (sha === undefined) {
		const tip = (await deps.repo(repoId).info()).trunkSha;
		return tip === null ? null : await deps.graph(repoId, tip);
	}
	if (target.publicView || auth === null) {
		throw notFound(`unknown commit ${sha}`);
	}
	if (!isSha(sha)) throw invalid("sha is a 40-hex commit sha");
	const seqs = await deps.repo(repoId).trunkSeqs([sha]);
	if (seqs[sha] === undefined) throw notFound(`${sha} is not a trunk commit`);
	const cached = await deps.cachedGraph(repoId, sha);
	if (cached !== null && graphMode(cached) === deps.mode) return cached;
	if (!deps.admit(auth.principal)) {
		throw rateLimited("too many uncached project graph requests", 60_000);
	}
	return await deps.graph(repoId, sha);
};

const decodeSegment = (segment: string): string => {
	try {
		return decodeURIComponent(segment);
	} catch {
		throw notFound("no such project");
	}
};

const refOf = (p: ProjectDto): ProjectRefDto => ({
	name: p.name,
	slug: p.slug,
	root: p.root,
});

// ---------------------------------------------------------------------------
// Lists: the providers' tools as the viewer, filtered
// ---------------------------------------------------------------------------

type Page<T> = { readonly entries: readonly T[]; readonly cursor?: string };

const pageOf = <T>(out: unknown, field: string): Page<T> => {
	const value = out as Record<string, unknown> | null;
	const entries = value?.[field];
	const cursor = value?.cursor;
	return {
		entries: Array.isArray(entries) ? entries as T[] : [],
		...(typeof cursor === "string" && cursor !== "" ? { cursor } : {}),
	};
};

const listAll = async <T, R>(
	call: (cursor: string | undefined) => Promise<Page<T>>,
	keep: (entries: readonly T[]) => R[],
): Promise<{ kept: R[]; scanned: number; complete: boolean }> => {
	const kept: R[] = [];
	let scanned = 0;
	let cursor: string | undefined;
	for (let page = 0; page < LIST_PAGES_MAX; page++) {
		const out = await call(cursor);
		scanned += out.entries.length;
		kept.push(...keep(out.entries));
		cursor = out.cursor;
		if (cursor === undefined || kept.length >= LIST_MAX) break;
	}
	return {
		kept: kept.slice(0, LIST_MAX),
		scanned,
		// The last page may push the matches past the cap.
		complete: cursor === undefined && kept.length <= LIST_MAX,
	};
};

const stateParam = (
	url: URL,
	states: readonly string[],
): string | undefined => {
	const state = optionalParam(url, "state", 32);
	if (state === undefined || state === "all") return undefined;
	if (!states.includes(state)) {
		throw invalid(`state is one of all, ${states.join(", ")}`);
	}
	return state;
};

const toolContext = (target: Target, auth: AuthContext): ToolContext => ({
	node: target.node.id,
	repo: target.node.id,
	scope: target.node.path,
	actor: {
		kind: auth.kind,
		id: auth.principal,
		...(auth.onBehalfOf ? { onBehalfOf: auth.onBehalfOf } : {}),
	},
	mode: "enforce",
});

const listVia = async <T, R>(
	deps: ProjectsDeps,
	target: Target,
	auth: AuthContext | null,
	iface: string,
	tool: string,
	field: string,
	args: Record<string, unknown>,
	keep: (entries: readonly T[]) => R[],
): Promise<
	{
		provider: InstallationInForce | null;
		kept: R[];
		scanned: number;
		complete: boolean;
	}
> => {
	if (auth === null) {
		throw unauthenticated(`sign in to list ${tool.replace("_list", "")}`);
	}
	const provider = await deps.provider(iface, target.node.id);
	if (provider === null) {
		return { provider, kept: [], scanned: 0, complete: true };
	}
	const ctx = toolContext(target, auth);
	const bounds = actorBoundsOf(auth);
	const listed = await listAll<T, R>(
		async (cursor) =>
			pageOf<T>(
				await deps.callTool(
					provider,
					target.node.id,
					tool,
					{
						repo: target.node.path,
						limit: LIST_PAGE,
						...args,
						...(cursor !== undefined ? { cursor } : {}),
					},
					ctx,
					bounds,
				),
				field,
			),
		keep,
	);
	return { provider, ...listed };
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const createProjectsHandler = (
	depsFor: ProjectsDepsFor = defaultDeps,
): RouteHandler =>
async (c) => {
	try {
		const deps = depsFor(c);
		if (deps.mode === "off") {
			throw notFound("projects are not enabled on this forge");
		}
		const target = await openRepo(deps, c.auth, c.params.repoId ?? "");
		const rest = (c.params.rest ?? "").split("/").filter((s) => s !== "");
		if (rest.length > 2) throw notFound("no such projects resource");
		const graph = await graphOf(deps, target, c.url, c.auth);
		if (rest.length === 0) return json(projectsResponse(target.repo, graph));
		if (graph === null) throw notFound("the repo has no commits yet");
		const view = projectView(graph);
		const wanted = decodeSegment(rest[0]);
		const project = resolveProject(view, wanted);
		if (project === null) {
			const known = view.projects.map((p) => p.slug);
			throw notFound(`no project ${wanted} at ${graph.sha}`, {
				known: known.slice(0, KNOWN_SLUGS_SHOWN),
				...(known.length > KNOWN_SLUGS_SHOWN ? { more: true } : {}),
			});
		}
		const listing = {
			repo: target.repo,
			project: refOf(project),
		};
		if (rest.length === 1) {
			const reads = await deps.reads(target.node.id);
			let docs: Pick<ProjectDetailResponse, "readme" | "agentsDoc">;
			try {
				docs = await docsOf(reads, graph.sha, project.root);
			} finally {
				reads.close();
			}
			const layers = view.graph.layers ?? [];
			return json(
				{
					repo: target.repo,
					sha: graph.sha,
					detector: view.graph.detector ?? null,
					fidelity: view.graph.fidelity ?? null,
					project,
					layers: project.layers.flatMap((root) =>
						layers.filter((l) => l.root === root)
					),
					deps: project.deps.flatMap((n) => view.ref(n) ?? []),
					dependents: project.dependents.flatMap((n) => view.ref(n) ?? []),
					...docs,
					total: view.projects.length,
				} satisfies ProjectDetailResponse,
			);
		}
		if (rest[1] === "issues") {
			const state = stateParam(c.url, WorkStateSchema.options);
			const out = await listVia<
				WorkItem,
				ReturnType<typeof filterWork>[number]
			>(
				deps,
				target,
				c.auth,
				"work@1",
				"work_list",
				"items",
				state ? { state } : {},
				(items) => filterWork(graph, project, items),
			);
			return json(
				{
					...listing,
					provider: out.provider?.manifest.id ?? null,
					items: out.kept,
					scanned: out.scanned,
					complete: out.complete,
				} satisfies ProjectIssuesResponse,
			);
		}
		if (rest[1] === "changes") {
			const state = stateParam(c.url, ChangeStateSchema.options);
			const out = await listVia<
				Change,
				ReturnType<typeof filterChanges>[number]
			>(
				deps,
				target,
				c.auth,
				"changes@1",
				"changes_list",
				"changes",
				state ? { state } : {},
				(changes) => filterChanges(project, changes),
			);
			return json(
				{
					...listing,
					provider: out.provider?.manifest.id ?? null,
					changes: out.kept,
					scanned: out.scanned,
					complete: out.complete,
				} satisfies ProjectChangesResponse,
			);
		}
		throw notFound("no such projects resource");
	} catch (error) {
		return failure(error);
	}
};
