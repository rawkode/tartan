// Live: monorepo projects, the first slice. On a forge deployed with
// `--projects` (scan), a
// repository's directories holding a `package tartan` file are its projects.
// Each project gets a page at `/<repo>:<name>` with its
// README. A project's Issues and Pull requests came from the work and change
// extensions, which this branch removed; those checks are gone with them.
//
// One shared setup per instance (support/shared.ts): the monorepo fixture
// (`MONOREPO_FIXTURE`: two `package tartan` directories) imported into
// `e2e/swarm`.

import { expect } from "e2e";
import type {
	ProjectDetailResponse,
	ProjectsResponse,
} from "@tartan/contract/api.ts";
import { sharedStore, test } from "../../support/fixtures.ts";
import {
	MONOREPO_FIXTURE,
	MONOREPO_PROJECTS,
	type MonorepoProject,
} from "../../support/fixture-repo.ts";
import { ok, tokenApi } from "../../support/http.ts";
import { expectApiClean, urlOf, watchApi } from "../../support/page.ts";
import { fixtureRepo } from "../../support/repos.ts";
import { keyOf } from "../../support/shared.ts";
import { type Stage, tokensOf } from "../../support/stage.ts";

const DETECTOR: ProjectsResponse["detector"] = "tartan";
const MIN = 60_000;
const PROJECTS = Object.keys(MONOREPO_PROJECTS) as MonorepoProject[];

type Setup = {
	readonly repo: { readonly path: string; readonly id: string };
	/** The slug of each project, as the graph answered it. */
	readonly slugs: Readonly<Record<MonorepoProject, string>>;
};

const skipUnlessProjects = (stage: Stage) =>
	test.skip(
		!stage.switches.projects,
		"projects are off on this stage: deploy it with `stage up --projects`",
	);

const api = (stage: Stage) => tokenApi(stage.origin, tokensOf(stage).ownerPat);
const projectsAt = (repoId: string, rest = "") =>
	`/-/api/repos/${encodeURIComponent(repoId)}/projects${rest}`;

const setupOf = (stage: Stage, index: number): Promise<Setup> =>
	sharedStore().once(`projects-${index}-setup`, async (): Promise<Setup> => {
		const repo = await fixtureRepo(
			stage,
			"swarm",
			index === 0 ? "projects" : `projects-${index}`,
			MONOREPO_FIXTURE,
		);
		// The graph at the trunk tip (detected lazily on its first read).
		let graph: ProjectsResponse | null = null;
		await expect.poll(async () => {
			const reply = await api(stage).get<ProjectsResponse>(
				projectsAt(repo.id),
			);
			graph = reply.status === 200 ? reply.body : null;
			return graph?.projects.length ?? 0;
		}, {
			timeout: 2 * MIN,
			interval: 2_000,
			message: "the repo's project graph",
		}).toBe(PROJECTS.length);
		const slugs = {} as Record<MonorepoProject, string>;
		for (const p of PROJECTS) {
			const found = graph!.projects.find((x) =>
				x.root === MONOREPO_PROJECTS[p].root
			);
			if (found === undefined) {
				throw new Error(`no project at ${MONOREPO_PROJECTS[p].root}`);
			}
			slugs[p] = found.slug;
		}
		return { repo: { path: repo.path, id: repo.id }, slugs };
	});

const setupFor = async (stage: Stage, title: string) =>
	setupOf(
		stage,
		await sharedStore().claimIndex(`claim-projects-${keyOf(title)}`),
	);

const T = {
	graph: "a monorepo's package tartan directories are its projects",
	card: "the repo home's Projects card lists the projects and opens one",
} as const;

test.describe("monorepo projects", {
	tags: ["projects", "m2", "regression", "developer"],
	session: "developer",
}, () => {
	test(T.graph, { tags: ["smoke"], timeout: 10 * MIN }, async ({ stage }) => {
		skipUnlessProjects(stage);
		const s = await setupFor(stage, T.graph);
		const graph = ok(
			"GET",
			"/-/api/repos/<id>/projects",
			await api(stage).get<ProjectsResponse>(projectsAt(s.repo.id)),
		);
		expect(graph.detector).toBe(DETECTOR);
		expect(graph.truncated).toBe(false);
		expect(graph.projects.map((p) => p.name).sort()).toEqual(
			PROJECTS.map((p) => MONOREPO_PROJECTS[p].name).sort(),
		);
		for (const p of graph.projects) {
			expect(p.source).toBe(DETECTOR);
		}
		const detail = ok(
			"GET",
			"/-/api/repos/<id>/projects/<slug>",
			await api(stage).get<ProjectDetailResponse>(
				projectsAt(s.repo.id, `/${s.slugs.design}`),
			),
		);
		expect(detail.project.root).toBe(MONOREPO_PROJECTS.design.root);
		expect(detail.readme?.text).toContain("Design system");
	});

	test(T.card, { tags: ["ui"], timeout: 10 * MIN }, async ({
		app,
		browser,
		stage,
	}) => {
		skipUnlessProjects(stage);
		const s = await setupFor(stage, T.card);
		await app.open(`/${s.repo.path}`);
		await watchApi(browser);
		const main = browser.locator("#main");
		for (const p of PROJECTS) {
			await expect(main.getByRole("link", MONOREPO_PROJECTS[p].name))
				.toBeVisible();
		}
		await main.getByRole("link", MONOREPO_PROJECTS.design.name).tap();
		await expect(browser).toHaveURL(
			urlOf(stage.origin, `/${s.repo.path}:${MONOREPO_PROJECTS.design.name}`),
		);
		await expect(main.getByRole("heading", MONOREPO_PROJECTS.design.name))
			.toBeVisible();
		const page = main;
		await expect(page).toContainText("Tokens and components");
		await expectApiClean(browser);
	});
});
