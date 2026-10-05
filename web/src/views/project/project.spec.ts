// The project pages on the mock kernel (WP25 slice A′, without the
// switcher): the repo overview's Projects card links to
// the list and to project pages; `/<repo>/-/p` lists the 38 projects by
// layer; `/<repo>/-/p/<slug>` shows the overview (README, layers, edges,
// agent doc), and its Issues and Pull requests tabs list what the API
// filtered to the project. The router here is the app's own table, whose
// project routes come before the extension-tab catch-all.

import { h } from "vue";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import { afterEach, describe, expect, it } from "vitest";
import { createApi } from "../../api/client.ts";
import { createHttp, type FetchLike } from "../../api/http.ts";
import { createMockFetch } from "../../api/mock/server.ts";
import { REPO_ID } from "../../api/mock/fixtures.ts";
import {
	createMockProjects,
	withMockProjects,
} from "../../api/mock/projects.ts";
import { API, LIVE, SESSION } from "../../app/context.ts";
import { createSession } from "../../auth/session.ts";
import { SCHEDULER } from "../../live/scheduler.ts";
import { createLiveStore } from "../../live/store.ts";
import { NODE_SEGMENT, routes } from "../../router/routes.ts";
import { SETUP_TOKEN } from "../../setup/fragment.ts";
import { createToasts, TOASTS } from "../../shell/toasts.ts";
import { fakeClock } from "../../../test/support/fakes.ts";
import {
	byAttr,
	byTag,
	flush,
	mount,
	type TestElement,
	text,
} from "../../../test/support/renderer.ts";
import { silentConnect } from "../../../test/support/app.ts";
import ProjectsCard from "./ProjectsCard.vue";
import {
	createProjectsClient,
	graphSummary,
	projectHref,
	PROJECTS,
	workHref,
} from "./client.ts";
import { affectsLabel, groupProjects, projectNotes } from "./model.ts";
import { PROJECT_NODE_SEGMENT } from "./routes.ts";

const REPO = "acme/platform/router";
const DS = "rawkode-academy-design-system";
const WEB = "rawkode-academy-website";

const links = (root: TestElement): string[] =>
	byTag(root, "a").map((a) => a.attrs["href"] ?? "");

const recording = (inner: FetchLike) => {
	const paths: string[] = [];
	const fetch: FetchLike = (input, init) => {
		paths.push(input);
		return inner(input, init);
	};
	return { fetch, paths };
};

/** The app's route table: the project routes come before the extension-tab catch-all. */
const table = () => {
	const project = routes.findIndex((r) => r.name === "project");
	const slotTab = routes.findIndex((r) => r.name === "slot-tab");
	if (project < 0 || project > slotTab) {
		throw new Error("router/routes.ts lost the project routes");
	}
	return [...routes];
};

let unmounts: (() => void)[] = [];
afterEach(() => {
	for (const u of unmounts) u();
	unmounts = [];
});

const mountPage = async (
	path: string,
	options: { signedIn?: boolean; fetch?: FetchLike } = {},
) => {
	const { fetch, paths } = recording(
		options.fetch ??
			withMockProjects(createMockFetch({ signedIn: options.signedIn ?? true })),
	);
	const http = createHttp(fetch);
	const api = createApi(http);
	const session = createSession(api);
	await session.load();
	const router = createRouter({
		history: createMemoryHistory(),
		routes: table(),
	});
	const clock = fakeClock();
	const { root, unmount } = mount({ render: () => h(RouterView) }, {
		provide: [
			[API, api],
			[PROJECTS, createProjectsClient(http)],
			[SESSION, session],
			[LIVE, createLiveStore({ connect: silentConnect, scheduler: clock })],
			[TOASTS, createToasts(() => undefined)],
			[SETUP_TOKEN, null],
			[SCHEDULER, clock],
		],
		plugins: [router],
	});
	unmounts.push(unmount);
	await router.push(path);
	await router.isReady();
	await flush(20);
	return { root, router, paths };
};

describe("project routes", () => {
	it("repeat the app's node segment and win over the extension-tab catch-all", async () => {
		expect(PROJECT_NODE_SEGMENT).toBe(NODE_SEGMENT);
		const { router } = await mountPage(`/${REPO}/-/p/${DS}/issues`);
		expect(router.currentRoute.value.name).toBe("project");
		expect(router.currentRoute.value.params["tab"]).toBe("issues");
		await router.push(`/${REPO}/-/p`);
		expect(router.currentRoute.value.name).toBe("projects");
		// Another first segment is still an extension tab.
		await router.push(`/${REPO}/-/work`);
		expect(router.currentRoute.value.name).toBe("slot-tab");
	});

	it("build links to pages, tabs and work items", () => {
		expect(projectHref(REPO)).toBe(`/${REPO}/-/p`);
		expect(projectHref(REPO, DS)).toBe(`/${REPO}/-/p/${DS}`);
		expect(projectHref(REPO, DS, "changes")).toBe(`/${REPO}/-/p/${DS}/changes`);
		expect(workHref(REPO, `${REPO}#21`)).toBe(`/${REPO}/-/work/21`);
	});
});

describe("Projects card", () => {
	it("summarises the scan and links to the list and the projects", async () => {
		const { fetch } = recording(withMockProjects(createMockFetch()));
		const router = createRouter({
			history: createMemoryHistory(),
			routes: [{ path: "/:p(.*)*", component: { render: () => null } }],
		});
		const { root, unmount } = mount(ProjectsCard, {
			props: { repoId: REPO_ID, repoPath: REPO },
			provide: [[PROJECTS, createProjectsClient(createHttp(fetch))]],
			plugins: [router],
		});
		unmounts.push(unmount);
		await flush(20);
		expect(text(byAttr(root, "data-testid", "projects-summary")[0]!)).toBe(
			"38 cuenv projects found (textual scan) · 3 layers · 1 nested module skipped",
		);
		const hrefs = links(root);
		expect(hrefs).toContain(`/${REPO}/-/p`);
		// The projects with dependents come first.
		expect(hrefs).toContain(`/${REPO}/-/p/${DS}`);
		expect(hrefs).toContain(
			`/${REPO}/-/p/rawkode-academy-platform-notifications`,
		);
		expect(text(root)).toContain("and 32 more");
	});

	it("renders nothing when projects are off (404) or the repo has none", async () => {
		for (
			const answer of [
				new Response(JSON.stringify({ error: "not_found", message: "off" }), {
					status: 404,
				}),
				new Response(
					JSON.stringify({
						...createMockProjects().list(REPO_ID)!,
						projects: [],
					}),
				),
			]
		) {
			const router = createRouter({
				history: createMemoryHistory(),
				routes: [{ path: "/:p(.*)*", component: { render: () => null } }],
			});
			const { root, unmount } = mount(ProjectsCard, {
				props: { repoId: REPO_ID, repoPath: REPO },
				provide: [[
					PROJECTS,
					createProjectsClient(createHttp(() => Promise.resolve(answer))),
				]],
				plugins: [router],
			});
			unmounts.push(unmount);
			await flush(20);
			expect(byAttr(root, "data-testid", "projects-card")).toEqual([]);
		}
	});
});

describe("projects list", () => {
	it("groups the 38 projects by their deepest layer, with edges and notes", async () => {
		const { root, paths } = await mountPage(`/${REPO}/-/p`);
		expect(paths).toContain(`/-/api/repos/${REPO_ID}/projects`);
		expect(text(root)).toContain("38 cuenv projects found (textual scan)");
		expect(byAttr(root, "data-project", DS)).toHaveLength(1);
		const rows = findRows(root);
		expect(rows).toHaveLength(38);
		const web = byAttr(root, "data-project", WEB)[0]!;
		expect(links(web)).toContain(`/${REPO}/-/p/${DS}`);
		expect(text(root)).toContain("Detection notes (4)");
		expect(text(root)).toContain("workspace-member-without-project");
	});
});

const findRows = (root: TestElement) =>
	byTag(root, "tr").filter((r) => r.attrs["data-project"] !== undefined);

describe("project page", () => {
	it("shows the overview: root, manifest, layers, edges, agent doc and README", async () => {
		const { root, paths } = await mountPage(`/${REPO}/-/p/${DS}`);
		expect(paths).toContain(`/-/api/repos/${REPO_ID}/projects/${DS}`);
		const page = byAttr(root, "data-project", DS)[0]!;
		const body = text(page);
		expect(body).toContain(DS);
		expect(body).toContain("cuenv · textual scan");
		expect(body).toContain("packages/design-system/env.cue");
		expect(body).toContain("Shared components for every site.");
		expect(links(page)).toContain(`/${REPO}/-/p/${WEB}`);
		expect(links(page)).toContain(`/${REPO}/-/blob/main/AGENTS.md`);
		expect(links(page)).toContain(
			`/${REPO}/-/tree/main/packages/design-system`,
		);
		// The tabs.
		expect(links(page)).toContain(`/${REPO}/-/p/${DS}/issues`);
		expect(links(page)).toContain(`/${REPO}/-/p/${DS}/changes`);
	});

	it("lists the project's issues, filtered by footprint", async () => {
		const { root, paths } = await mountPage(`/${REPO}/-/p/${DS}/issues`);
		expect(paths).toContain(`/-/api/repos/${REPO_ID}/projects/${DS}/issues`);
		const rows = byAttr(root, "data-ref", `${REPO}#21`);
		expect(rows).toHaveLength(1);
		expect(text(rows[0]!)).toContain("1 working");
		expect(text(rows[0]!)).toContain("footprint names this project");
		expect(byAttr(root, "data-ref", `${REPO}#22`)).toHaveLength(1);
		expect(byAttr(root, "data-ref", `${REPO}#23`)).toHaveLength(0);
		expect(links(root)).toContain(`/${REPO}/-/work/21`);
	});

	it("lists the changes that affect the project, global ones marked", async () => {
		const { root } = await mountPage(`/${REPO}/-/p/${DS}/changes`);
		const rows = byTag(root, "li").filter((li) =>
			li.attrs["data-change"] !== undefined
		);
		expect(rows.map((r) => text(r))).toEqual([
			expect.stringContaining("affects 2 of 38"),
			expect.stringContaining("affects all 38 (repo-wide file)"),
		]);
	});

	it("asks a signed-out viewer to sign in for the lists, and reads no list", async () => {
		const { root, paths } = await mountPage(`/${REPO}/-/p/${DS}/issues`, {
			signedIn: false,
		});
		expect(byAttr(root, "data-testid", "sign-in")).toHaveLength(1);
		expect(paths.some((p) => p.endsWith("/issues"))).toBe(false);
	});

	it("says when the project does not exist", async () => {
		const { root } = await mountPage(`/${REPO}/-/p/nope`);
		expect(text(root)).toContain("this project was not found");
	});
});

describe("captions", () => {
	it("follow the detector and the graph", () => {
		const list = createMockProjects().list(REPO_ID)!;
		expect(
			graphSummary({
				...list,
				detector: "workspaces",
				layers: [],
				skipped: [],
			}),
		)
			.toBe("38 projects detected");
		const one = { ...list, projects: list.projects.slice(0, 1), skipped: [] };
		expect(graphSummary(one)).toBe(
			"1 cuenv project found (textual scan) · 3 layers",
		);
		const ds = list.projects.find((p) => p.name === DS)!;
		expect(projectNotes(ds)).toEqual([]);
		expect(
			projectNotes({ ...ds, nameSource: "unresolved", cuenvName: "x" }).map((
				n,
			) => n.label),
		).toEqual(["name from the directory", "duplicate name"]);
		expect(
			groupProjects(list.projects, true).map((g) => [g.key, g.projects.length]),
		).toEqual([["", 2], ["projects", 10], ["projects/rawkode.academy", 26]]);
		expect(
			affectsLabel({
				changeId: "c",
				title: "t",
				state: "draft",
				laneId: "l",
				author: "a",
				revision: 1,
				affected: [DS],
				global: false,
			}, 38),
		).toBe("affects 1 of 38");
	});
});
