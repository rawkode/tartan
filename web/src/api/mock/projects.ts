// The mock forge's projects API (WP25 slice A′): the sample repo answers
// as the demo-shaped cuenv monorepo of `packages/monorepo/test/fixtures/
// cuenv-demo.ts`, so the Projects card and the project pages render in mock
// builds and SPA specs. A Deno test (`src/kernel/projects/mock.test.ts`)
// checks the list and detail against the real handler over that fixture,
// and the workerd test checks the shapes against the live Worker.
//
// `withMockProjects` wraps the mock fetch
// (`api/mock/index.ts`, `test/support/app.ts`).

import {
	CUENV_DEMO_FILES,
	CUENV_DEMO_LAYERS,
	CUENV_DEMO_NESTED,
	CUENV_DEMO_PROJECTS,
} from "../../../../packages/monorepo/test/fixtures/cuenv-demo.ts";
import type {
	ProjectChangeDto,
	ProjectChangesResponse,
	ProjectDetailResponse,
	ProjectDto,
	ProjectIssuesResponse,
	ProjectLayerDto,
	ProjectsResponse,
	ProjectWorkItemDto,
} from "../../views/project/types.ts";
import type { FetchLike } from "../http.ts";
import { REPO_ID, SHAS } from "./fixtures.ts";

const REPO = { id: REPO_ID, path: "acme/platform/router" } as const;
const DS = "rawkode-academy-design-system";
const WEB = "rawkode-academy-website";
const NOTIFICATIONS = "rawkode-academy-platform-notifications";
const STUDIO = "rawkode-academy-studio";

/** The workspace edges lifted onto cuenv projects (as the detector finds them). */
const DEPS: Readonly<Record<string, readonly string[]>> = {
	[WEB]: [DS, NOTIFICATIONS],
	[STUDIO]: [NOTIFICATIONS],
};

const isUnder = (path: string, root: string): boolean =>
	root === "" || path === root || path.startsWith(`${root}/`);

const PROJECTS: readonly ProjectDto[] = CUENV_DEMO_PROJECTS
	.map(([name, root]) => ({
		key: root,
		name,
		slug: name,
		root,
		source: "cuenv",
		nameSource: "literal" as const,
		fidelity: "scan" as const,
		layers: CUENV_DEMO_LAYERS.filter((l) => isUnder(root, l)),
		deps: [...(DEPS[name] ?? [])],
		dependents: Object.entries(DEPS)
			.filter(([, deps]) => deps.includes(name))
			.map(([n]) => n)
			.sort(),
		manifestPath: `${root}/env.cue`,
		issues: [],
	}))
	.sort((a, b) => a.root < b.root ? -1 : a.root > b.root ? 1 : 0);

const ROOTS = PROJECTS.map((p) => p.root);

const LAYERS: readonly ProjectLayerDto[] = CUENV_DEMO_LAYERS.map((root) => ({
	root,
	paths: Object.keys(CUENV_DEMO_FILES)
		.filter((path) =>
			path.endsWith(".cue") && !path.startsWith("cue.mod/") &&
			!path.startsWith(`${CUENV_DEMO_NESTED}/`) &&
			!ROOTS.some((r) => isUnder(path, r))
		)
		.filter((path) => {
			const dir = path.includes("/")
				? path.slice(0, path.lastIndexOf("/"))
				: "";
			const deepest = CUENV_DEMO_LAYERS.filter((l) => isUnder(dir, l))
				.sort((a, b) => b.length - a.length)[0];
			return deepest === root;
		})
		.sort(),
}));

const LIST: ProjectsResponse = {
	repo: REPO,
	sha: SHAS.c3,
	detector: "cuenv",
	fidelity: "scan",
	projects: PROJECTS,
	layers: LAYERS,
	skipped: [CUENV_DEMO_NESTED],
	warnings: [
		{
			code: "workspace-member-without-project",
			path: "content",
			message:
				"workspace member @rawkodeacademy/content is outside every cuenv project; its paths are global",
		},
		{
			code: "workspace-member-without-project",
			path: "projects/rawkode.academy/platform/youtube-scraper",
			message:
				"workspace member youtube-scraper is outside every cuenv project; its paths are global",
		},
		{
			code: "edge-dropped",
			path: "projects/rawkode.academy/website",
			message:
				"website depends on @rawkodeacademy/content at content, outside every cuenv project",
		},
	],
	truncated: false,
	global: [
		"*.cue",
		"bun.lock",
		"cue.mod/**",
		"package-lock.json",
		"package.json",
	],
};

const README_NAMES = ["README.md", "readme.md", "README"];
const AGENTS_NAMES = ["AGENTS.md", "CLAUDE.md"];

const detailOf = (p: ProjectDto): ProjectDetailResponse => {
	const readme = README_NAMES.map((n) => `${p.root}/${n}`).find((path) =>
		CUENV_DEMO_FILES[path] !== undefined
	);
	const segments = p.root.split("/");
	let agentsDoc: string | undefined;
	for (let depth = segments.length; depth >= 0 && !agentsDoc; depth--) {
		const dir = segments.slice(0, depth).join("/");
		agentsDoc = AGENTS_NAMES.map((n) => dir === "" ? n : `${dir}/${n}`)
			.find((path) => CUENV_DEMO_FILES[path] !== undefined);
	}
	const ref = (name: string) => {
		const q = PROJECTS.find((x) => x.name === name)!;
		return { name: q.name, slug: q.slug, root: q.root };
	};
	return {
		repo: REPO,
		sha: SHAS.c3,
		detector: "cuenv",
		fidelity: "scan",
		project: p,
		layers: p.layers.flatMap((root) => LAYERS.filter((l) => l.root === root)),
		deps: p.deps.map(ref),
		dependents: p.dependents.map(ref),
		...(readme
			? {
				readme: {
					path: readme,
					text: CUENV_DEMO_FILES[readme],
					truncated: false,
				},
			}
			: {}),
		...(agentsDoc ? { agentsDoc: { path: agentsDoc } } : {}),
		total: PROJECTS.length,
	};
};

/** Mock work items and changes, each with the projects whose page lists it. */
const ITEMS:
	readonly (ProjectWorkItemDto & { readonly on: readonly string[] })[] = [
		{
			ref: `${REPO.path}#21`,
			kind: "issue",
			title: "Tighten the button contrast",
			state: "claimed",
			labels: ["a11y"],
			priority: 1,
			footprint: { projects: [DS], prefixes: ["packages/design-system"] },
			claims: 1,
			matched: "project",
			on: [DS],
		},
		{
			ref: `${REPO.path}#22`,
			kind: "issue",
			title: "Document the token scale",
			state: "open",
			labels: [],
			priority: 2,
			footprint: { projects: [], prefixes: ["packages/design-system/src"] },
			claims: 0,
			matched: "prefix",
			on: [DS],
		},
		{
			ref: `${REPO.path}#23`,
			kind: "issue",
			title: "Lazy-load the course pages",
			state: "open",
			labels: [],
			priority: 2,
			footprint: { projects: [WEB], prefixes: [] },
			claims: 0,
			matched: "project",
			on: [WEB],
		},
	];

const ALL = PROJECTS.map((p) => p.name).sort();
const CHANGES:
	readonly (ProjectChangeDto & { readonly on: readonly string[] })[] = [
		{
			changeId: "kqzvmxrstnpwylokqzvmxrstnpwylo01",
			title: "Tighten the button contrast",
			state: "submitted",
			workRef: `${REPO.path}#21`,
			laneId: "ln_01k6m0ck0000000000000000a1",
			author: "a_01k6m0ck0000000000000claude",
			revision: 2,
			affected: [DS, WEB],
			global: false,
			at: Date.UTC(2026, 9, 2, 15, 0, 0),
			on: [DS, WEB],
		},
		{
			changeId: "kqzvmxrstnpwylokqzvmxrstnpwylo02",
			title: "Bump the workspace lockfile",
			state: "approved",
			workRef: `${REPO.path}#24`,
			laneId: "ln_01k6m0ck0000000000000000a2",
			author: "a_01k6m0ck0000000000000claude",
			revision: 1,
			affected: [...ALL, "*"],
			global: true,
			at: Date.UTC(2026, 9, 2, 14, 0, 0),
			on: ALL,
		},
	];

const strip = <T extends { readonly on: readonly string[] }>(
	{ on: _on, ...rest }: T,
): Omit<T, "on"> => rest;

const find = (ref: string): ProjectDto | undefined =>
	PROJECTS.find((p) =>
		p.slug === ref || p.root === ref || p.name === ref || p.cuenvName === ref
	);

export type MockProjects = {
	readonly repoId: string;
	list(repoId: string): ProjectsResponse | null;
	detail(repoId: string, project: string): ProjectDetailResponse | null;
	issues(repoId: string, project: string): ProjectIssuesResponse | null;
	changes(repoId: string, project: string): ProjectChangesResponse | null;
};

export const createMockProjects = (): MockProjects => {
	const listing = (p: ProjectDto) => ({
		repo: REPO,
		project: { name: p.name, slug: p.slug, root: p.root },
		scanned: ITEMS.length,
		complete: true,
	});
	return {
		repoId: REPO_ID,
		list: (repoId) => repoId === REPO_ID ? LIST : null,
		detail: (repoId, ref) => {
			const p = repoId === REPO_ID ? find(ref) : undefined;
			return p ? detailOf(p) : null;
		},
		issues: (repoId, ref) => {
			const p = repoId === REPO_ID ? find(ref) : undefined;
			return p
				? {
					...listing(p),
					provider: "tartan.work",
					items: ITEMS.filter((i) => i.on.includes(p.name)).map(strip),
				}
				: null;
		},
		changes: (repoId, ref) => {
			const p = repoId === REPO_ID ? find(ref) : undefined;
			return p
				? {
					...listing(p),
					scanned: CHANGES.length,
					provider: "tartan.changes",
					changes: CHANGES.filter((c) => c.on.includes(p.name)).map(strip),
				}
				: null;
		},
	};
};

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const PATH_RE =
	/^\/-\/api\/repos\/([^/?]+)\/projects(?:\/([^/?]+))?(?:\/(issues|changes))?$/;

/** Answers `GET /-/api/repos/<id>/projects…` from the mock; everything else goes to `inner`. */
export const withMockProjects = (
	inner: FetchLike,
	mock: MockProjects = createMockProjects(),
): FetchLike =>
async (input, init) => {
	const url = new URL(input, "https://mock.invalid");
	const m = PATH_RE.exec(url.pathname);
	if (m === null || (init?.method ?? "GET").toUpperCase() !== "GET") {
		return await inner(input, init);
	}
	const [, repoId, project, list] = m.map((s) =>
		s === undefined ? undefined : decodeURIComponent(s)
	);
	const body = project === undefined
		? mock.list(repoId!)
		: list === "issues"
		? mock.issues(repoId!, project)
		: list === "changes"
		? mock.changes(repoId!, project)
		: mock.detail(repoId!, project);
	if (body === null) {
		return json({ error: "not_found", message: "no such project" }, 404);
	}
	return json(body);
};
