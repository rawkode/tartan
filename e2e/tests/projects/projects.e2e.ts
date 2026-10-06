// Live: monorepo projects, the first slice. On a forge deployed with
// `--projects` (scan), a
// repository's cuenv `#Project` definitions (`package cuenv` files that
// declare `schema.#Project` with a `name`) are its projects, `#Base` files
// its layers. Each project gets a page at `/<repo>/-/p/<slug>` with its
// README and its own Issues and Pull requests: the work items whose
// footprint names it, and the changes whose affected set holds it.
//
// One shared setup per instance (support/shared.ts): the monorepo fixture
// (`MONOREPO_FIXTURE`: two cuenv projects under a root layer) imported into
// `e2e/swarm`; agent A files and works on the design system, agent B on the
// website, each with a footprint naming its project and a change under its
// project's root.

import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect } from "e2e";
import type { LaneHandle, WorkItem } from "@tartan/contract/interfaces.ts";
import type {
	ProjectChangesResponse,
	ProjectDetailResponse,
	ProjectIssuesResponse,
	ProjectsResponse,
} from "@tartan/contract/api.ts";
import { type AgentName, scriptedAgent } from "../../support/agent.ts";
import { sharedStore, test } from "../../support/fixtures.ts";
import {
	MONOREPO_FIXTURE,
	MONOREPO_PROJECTS,
	type MonorepoProject,
} from "../../support/fixture-repo.ts";
import { ok, tokenApi } from "../../support/http.ts";
import { PACK_GROUP } from "../../support/names.ts";
import { expectApiClean, urlOf, watchApi } from "../../support/page.ts";
import { fixtureRepo } from "../../support/repos.ts";
import { keyOf, sharedDirOf } from "../../support/shared.ts";
import { type Stage, tokensOf } from "../../support/stage.ts";

const CUENV: ProjectsResponse["detector"] = "cuenv";
const MIN = 60_000;
/** Which agent works on which project. */
const OWNERS: Readonly<Record<MonorepoProject, AgentName>> = {
	design: "A",
	web: "B",
};
const PROJECTS = Object.keys(MONOREPO_PROJECTS) as MonorepoProject[];

type Setup = {
	readonly repo: { readonly path: string; readonly id: string };
	/** The slug of each project, as the graph answered it. */
	readonly slugs: Readonly<Record<MonorepoProject, string>>;
	readonly items: Readonly<Record<MonorepoProject, string>>;
	readonly changes: Readonly<Record<MonorepoProject, string>>;
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
		const items = {} as Record<MonorepoProject, string>;
		const changes = {} as Record<MonorepoProject, string>;
		for (const p of PROJECTS) {
			const project = MONOREPO_PROJECTS[p];
			const agent = scriptedAgent(stage, PACK_GROUP.swarm, OWNERS[p]);
			const footprint = {
				projects: [project.name],
				prefixes: [project.root],
			};
			const item = await agent.mcp.call<WorkItem>("work_create", {
				repo: repo.path,
				kind: "intent",
				title: `Polish ${project.name} (${stage.runId}/${index})`,
				why: `The e2e projects check needs one item in ${project.name}.`,
				acceptance: [`${project.root} changes`],
				footprint,
			});
			items[p] = item.ref;
			const { lane: first } = await agent.mcp.call<{ lane: LaneHandle }>(
				"lanes_open",
				{ repo: repo.path, purpose: `projects: ${project.name}`, footprint },
			);
			const lane = await agent.awaitOpen(repo.path, first);
			const scratch = path.join(
				sharedDirOf(tmpdir(), stage.runId),
				`scratch-projects-${index}-${p}`,
			);
			const clone = await agent.clone(scratch, repo.remote);
			await agent.runLane(lane.git.start, clone);
			await writeFile(
				path.join(clone, ...project.root.split("/"), "CHANGELOG.md"),
				`# ${project.name}\n\n- ${stage.runId}\n`,
			);
			await agent.commit(clone, `projects: ${project.name}`);
			await agent.runLane(lane.git.push, clone);
			const { changeId } = await agent.mcp.call<{ changeId: string }>(
				"changes_submit",
				{
					repo: repo.path,
					laneId: lane.id,
					title: `${project.name}: a changelog (${stage.runId}/${index})`,
					summary: `Touches ${project.root} only.`,
				},
			);
			changes[p] = changeId;
		}
		return {
			repo: { path: repo.path, id: repo.id },
			slugs,
			items,
			changes,
		};
	});

const setupFor = async (stage: Stage, title: string) =>
	setupOf(
		stage,
		await sharedStore().claimIndex(`claim-projects-${keyOf(title)}`),
	);

const T = {
	graph: "a monorepo's cuenv #Projects are its projects, under its root layer",
	card: "the repo home's Projects card lists the projects and opens one",
	issues: "a project's Issues are the work items whose footprint names it",
	changes:
		"a project's Pull requests are the changes whose affected set holds it",
} as const;

test.describe("monorepo projects (cuenv)", {
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
		expect(graph.detector).toBe(CUENV);
		expect(graph.truncated).toBe(false);
		expect(graph.projects.map((p) => p.name).sort()).toEqual(
			PROJECTS.map((p) => MONOREPO_PROJECTS[p].name).sort(),
		);
		for (const p of graph.projects) {
			expect(p.source).toBe(CUENV);
			// Every project sits under the root layer.
			expect(p.layers).toContain("");
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
		const card = browser.locator('[data-testid="projects-card"]');
		for (const p of PROJECTS) {
			await expect(
				card.getByRole("link", MONOREPO_PROJECTS[p].name),
			).toBeVisible();
		}
		await card.getByRole("link", MONOREPO_PROJECTS.design.name).tap();
		await expect(browser).toHaveURL(
			urlOf(stage.origin, `/${s.repo.path}/-/p/${s.slugs.design}`),
		);
		const page = browser.locator(`article[data-project="${s.slugs.design}"]`);
		await expect(page.getByRole("heading", MONOREPO_PROJECTS.design.name))
			.toBeVisible();
		await expect(page).toContainText("Tokens and components");
		await expectApiClean(browser);
	});

	test(T.issues, { tags: ["ui", "agent"], timeout: 10 * MIN }, async ({
		app,
		browser,
		stage,
	}) => {
		skipUnlessProjects(stage);
		const s = await setupFor(stage, T.issues);
		for (const p of PROJECTS) {
			const other = PROJECTS.find((q) => q !== p)!;
			// API: the project's issues hold its own item and not the other's.
			const issues = ok(
				"GET",
				"/-/api/repos/<id>/projects/<slug>/issues",
				await api(stage).get<ProjectIssuesResponse>(
					projectsAt(s.repo.id, `/${s.slugs[p]}/issues`),
				),
			);
			const refs = issues.items.map((i) => i.ref);
			expect(refs, `${p}'s issues`).toContain(s.items[p]);
			expect(refs, `${p}'s issues`).not.toContain(s.items[other]);
		}
		// UI: the design system's Issues tab.
		await app.open(`/${s.repo.path}/-/p/${s.slugs.design}/issues`);
		await watchApi(browser);
		await expect(browser.locator('ul[aria-label="Issues"]')).toBeVisible();
		await expect(
			browser.locator(
				`ul[aria-label="Issues"] li[data-ref="${s.items.design}"]`,
			),
		)
			.toBeVisible();
		await expect(
			browser.locator(`ul[aria-label="Issues"] li[data-ref="${s.items.web}"]`),
		).toHaveCount(0);
		await expectApiClean(browser);
	});

	test(T.changes, { tags: ["ui", "agent"], timeout: 10 * MIN }, async ({
		app,
		browser,
		stage,
	}) => {
		skipUnlessProjects(stage);
		const s = await setupFor(stage, T.changes);
		for (const p of PROJECTS) {
			const other = PROJECTS.find((q) => q !== p)!;
			// The affected set is computed after the submit (the first push
			// after an import included: the cold-start case).
			await expect.poll(async () => {
				const changes = ok(
					"GET",
					"/-/api/repos/<id>/projects/<slug>/changes",
					await api(stage).get<ProjectChangesResponse>(
						projectsAt(s.repo.id, `/${s.slugs[p]}/changes`),
					),
				).changes.map((c) => c.changeId);
				return changes.includes(s.changes[p]) &&
					!changes.includes(s.changes[other]);
			}, {
				timeout: 3 * MIN,
				interval: 3_000,
				message: `${p}'s pull requests to be exactly its own change`,
			}).toBe(true);
		}
		await app.open(`/${s.repo.path}/-/p/${s.slugs.web}/changes`);
		await watchApi(browser);
		await expect(browser.locator('ul[aria-label="Pull requests"]'))
			.toBeVisible();
		await expect(
			browser.locator(
				`ul[aria-label="Pull requests"] li[data-change="${s.changes.web}"]`,
			),
		)
			.toBeVisible();
		await expect(
			browser.locator(
				`ul[aria-label="Pull requests"] li[data-change="${s.changes.design}"]`,
			),
		)
			.toHaveCount(0);
		await expectApiClean(browser);
	});
});
