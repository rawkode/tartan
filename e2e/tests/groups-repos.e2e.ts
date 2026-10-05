// Groups, repos and the role matrix. The owner creates a group and
// an empty repository with the forms; the repo frame shows the kernel tabs,
// the Classic pack's tabs (from the manifests, never literals) and Settings
// for Owners only. A Reporter sees no Settings; anonymous visitors see a
// not-found or no-access state for a private repo, never its content.

import { expect, type Screen } from "e2e";
import { test } from "../support/fixtures.ts";
import { pageApi, query } from "../support/http.ts";
import { PACK_GROUP, repoSlug } from "../support/names.ts";
import {
	expectApiClean,
	expectSlotsSettled,
	urlOf,
	viewOf,
	watchApi,
} from "../support/page.ts";
import { archiveNode, fixtureRepo } from "../support/repos.ts";
import { packTabs } from "../support/tabs.ts";
import { RENDERED } from "../support/view.ts";

const KERNEL_TABS_SIGNED_IN = ["Code", "History", "Lanes", "Runs", "Advances"];
/** Repository config (RepoFrame.vue): every member (Reporter+) reads it. */
const MEMBER_TABS = ["Config"];
const classicRepoTabs = packTabs()
	.filter((t) => t.pack === "classic" && t.slot === "repo.tab")
	.map((t) => t.label);

/**
 * The repo tab bar of a member: the kernel tabs in their order, every
 * Classic tab from the manifests (in the order the forge gives them), then
 * Config, then Settings for Owners only, and nothing else.
 */
const expectRepoTabs = async (
	screen: Screen,
	options: { readonly settings: boolean },
): Promise<void> => {
	const nav = screen.getByRole("navigation", "Repository");
	await expect(nav.getByRole("link")).toContainText([
		...KERNEL_TABS_SIGNED_IN,
		...MEMBER_TABS,
		...(options.settings ? ["Settings"] : []),
	]);
	for (const label of [...classicRepoTabs, ...MEMBER_TABS]) {
		await expect(nav.getByRole("link", label)).toBeVisible();
	}
	await expect(nav.getByRole("link", "Settings")).toHaveCount(
		options.settings ? 1 : 0,
	);
	await expect(nav.getByRole("link")).toHaveCount(
		KERNEL_TABS_SIGNED_IN.length + classicRepoTabs.length +
			MEMBER_TABS.length + (options.settings ? 1 : 0),
	);
};

test.describe(
	"groups and repositories",
	{ tags: ["groups", "regression"] },
	() => {
		test("the owner creates a group and a repository with the forms", {
			session: "owner",
			tags: ["owner", "smoke"],
		}, async ({ app, screen, browser, stage }) => {
			const group = repoSlug(stage.runId, "groups");
			const groupPath = `${PACK_GROUP.classic}/${group}`;
			try {
				await app.open(`/${PACK_GROUP.classic}`);
				await watchApi(browser);
				await expect(
					screen.getByRole("heading", { name: "classic", level: 1 }),
				).toBeVisible();
				await screen.getByRole("button", "New group").tap();
				await screen.getByLabel("Name").fill(group);
				await screen.getByLabel("Visibility").selectOption({
					value: "private",
				});
				await screen.getByRole("button", "Create group").tap();
				// The group lists its children a page at a time, and archived
				// nodes stay listed: page on until the new one shows.
				const created = screen.getByRole("link", group);
				await expect.poll(async () => {
					if (await created.count() > 0) return true;
					const more = screen.getByRole("button", "Load more");
					if (await more.count() > 0) await more.tap();
					return false;
				}, { timeout: 30_000 }).toBe(true);
				await created.tap();

				await expect(browser).toHaveURL(urlOf(stage.origin, `/${groupPath}`));
				await expect(screen.getByRole("heading", { name: group, level: 1 }))
					.toBeVisible();
				await expect(
					screen.getByRole("navigation", "Namespace").getByRole("link"),
				).toHaveText(["e2e", "classic", group]);

				await screen.getByRole("button", "New repository").tap();
				await screen.getByLabel("Name").fill("repo");
				await screen.getByRole("radio", /^Empty repository/).check();
				await screen.getByRole("button", "Create repo").tap();
				await expect(browser).toHaveURL(
					urlOf(stage.origin, `/${groupPath}/repo`),
					{
						timeout: 30_000,
					},
				);
				await expect(screen.getByRole("heading", { name: "repo", level: 1 }))
					.toBeVisible();

				await expectRepoTabs(screen, { settings: true });
				const view = await viewOf(browser, `${groupPath}/repo`, "");
				await expectSlotsSettled(browser, view, RENDERED.repoCode);
				await expectApiClean(browser);
			} finally {
				await archiveNode(stage, `${groupPath}/repo`).catch(() => {});
				await archiveNode(stage, groupPath).catch(() => {});
			}
		});

		test("a Reporter sees the repository without Settings", {
			session: "reporter",
			tags: ["reporter"],
		}, async ({ app, screen, browser, stage }) => {
			const repo = await fixtureRepo(stage, "classic", "roles");
			await app.open(`/${repo.path}`);
			await watchApi(browser);
			await expectRepoTabs(screen, { settings: false });
			await expect(screen.getByRole("link", "README.md")).toBeVisible();
			const view = await viewOf(browser, repo.path, "");
			expect(view.viewer.role, "Reporter on /e2e").toBe(20);
			await expectSlotsSettled(browser, view, RENDERED.repoCode);
			await expectApiClean(browser);

			// The settings page renders for a Reporter, read-only: its Lanes
			// section says who may change it and offers no form.
			await app.open(`/${repo.path}/-/settings`);
			const lanes = screen.getByRole("region", "Lanes");
			await expect(lanes).toBeVisible();
			await expect(
				lanes.getByText(/Only an Owner of this repository can change/),
			).toBeVisible();
			await expect(lanes.getByRole("button", "Save lane settings"))
				.toHaveCount(0);
			await expect(screen.getByLabel("Lane mode")).toHaveCount(0);
		});

		test("anonymous visitors never see a private repository", {
			tags: ["anonymous"],
		}, async ({ app, screen, browser, stage }) => {
			const repo = await fixtureRepo(stage, "classic", "roles");
			await app.open(`/${repo.path}`);
			await expect(screen.getByRole("alert")).toContainText(
				/was not found|do not have access/,
			);
			await expect(screen.getByRole("link", "README.md")).toHaveCount(0);
			await expect(browser.locator('nav[aria-label="Repository"]')).toHaveCount(
				0,
			);
		});

		test("anonymous visitors see nothing under /e2e", {
			tags: ["anonymous"],
		}, async ({ app, screen, browser }) => {
			// The e2e groups stay private: a public test forge must not host
			// content anyone can read (it may share an account with production).
			await app.open("/e2e");
			await expect(screen.getByRole("alert")).toContainText(
				/was not found|do not have access/,
			);
			const roots = await pageApi(browser).get<{ nodes: { path: string }[] }>(
				"/-/api/nodes",
			);
			expect(roots.status).toBe(200);
			expect(roots.body?.nodes.map((n) => n.path) ?? []).not.toContain("e2e");
			for (const group of ["e2e", PACK_GROUP.swarm, PACK_GROUP.classic]) {
				const children = await pageApi(browser).get<{ nodes: unknown[] }>(
					`/-/api/nodes?${query({ parent: group })}`,
				);
				expect(children.body?.nodes ?? [], group).toEqual([]);
			}
		});
	},
);
