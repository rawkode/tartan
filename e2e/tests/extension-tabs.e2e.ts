// One test per tab a pack adds, generated from the manifests in
// this checkout (support/tabs.ts), never from literals: every `repo.tab` of
// each pack's members on a repo under the pack's group, and every
// `node.tab` on the group itself. Each tab page is reached from its own
// link, marks that link current, renders exactly its own contribution (the
// page instance, plus the repo sidebar), settles every slot without an error
// chip and makes no failing API request. Renamed labels and removed
// extensions change the generated tests without a test edit.

import { expect } from "e2e";
import { test } from "../support/fixtures.ts";
import { PACK_GROUP } from "../support/names.ts";
import {
	expectApiClean,
	expectSlotsSettled,
	urlOf,
	viewOf,
	watchApi,
} from "../support/page.ts";
import { fixtureRepo } from "../support/repos.ts";
import { packTabs } from "../support/tabs.ts";
import { RENDERED, tabContribution } from "../support/view.ts";

for (const tab of packTabs()) {
	const where = tab.slot === "repo.tab" ? "repo" : "group";
	test(`${tab.pack}: the ${tab.label} ${where} tab (${tab.ext} ${tab.id})`, {
		session: "developer",
		tags: [
			"tabs",
			"regression",
			"developer",
			tab.pack,
			"slot-ctx",
			"slot-ctx-narrowing",
			"mock-parity",
			"pack-stubs",
		],
	}, async ({ app, screen, browser, stage }) => {
		if (tab.slot === "repo.tab") {
			const repo = await fixtureRepo(stage, tab.pack, "tabs");
			await app.open(`/${repo.path}`);
			const nav = screen.getByRole("navigation", "Repository");
			await nav.getByRole("link", tab.label).tap();
			await expect(browser).toHaveURL(
				urlOf(stage.origin, `/${repo.path}/-/${tab.route}`),
			);
			await watchApi(browser);
			await expect(nav.getByRole("link", tab.label)).toHaveAttribute(
				"aria-current",
				"page",
			);
			const view = await viewOf(browser, repo.path, tab.route);
			expect(tabContribution(view, tab.route)?.id, "the page's tab").toBe(
				tab.id,
			);
			await expectSlotsSettled(browser, view, RENDERED.repoTab(tab.id));
			await expect(
				browser.locator(
					`section[data-slot="repo.tab"][data-ext="${tab.ext}"]`,
				),
			).toHaveCount(1);
		} else {
			const group = PACK_GROUP[tab.pack];
			await app.open(`/${group}`);
			await screen.getByRole("navigation", "Pages").getByRole("link", tab.label)
				.tap();
			await expect(browser).toHaveURL(
				urlOf(stage.origin, `/${group}/-/${tab.route}`),
			);
			await watchApi(browser);
			await expect(
				screen.getByRole("heading", { name: tab.label, level: 1 }),
			).toBeVisible();
			const view = await viewOf(browser, group, tab.route);
			expect(tabContribution(view, tab.route)?.id, "the page's tab").toBe(
				tab.id,
			);
			await expectSlotsSettled(browser, view, RENDERED.nodeTab(tab.id));
		}
		await expectApiClean(browser);
	});
}

test("forge-level slots (nav, home, HUD metrics) have a host", {
	tags: ["tabs", "pending", "forge-slots"],
	skip:
		"pending (M2): no forge-level /-/api/view, no nav.global or home.section host",
}, async ({ app, browser }) => {
	await app.open("/");
	await expect(browser.locator('section[data-slot="home.section"]')).not
		.toHaveCount(0);
});
