// Work items ("issues") on a Classic repo. A Developer creates one
// with the Work tab's form; the form's fields reach the extension at the top
// level, so nothing answers "… is required". The list links it, its
// page renders the item panel, and comments land in its timeline. The repo
// header's "New work" action leads to the Work tab. Going from one
// item to another inside the page renders the second item's panel, never
// the first's. A Reporter can comment on an item too.

import { expect, type Screen } from "e2e";
import type { Browser } from "@e2e-dev/web";
import type { WorkItem } from "@tartan/contract";
import { test } from "../support/fixtures.ts";
import { workNoun } from "../support/labels.ts";
import { mcpClient } from "../support/mcp.ts";
import { PACK_GROUP } from "../support/names.ts";
import {
	expectApiClean,
	expectSlotsSettled,
	spaNavigate,
	urlOf,
	viewOf,
	watchApi,
} from "../support/page.ts";
import { fixtureRepo } from "../support/repos.ts";
import { tokensOf } from "../support/stage.ts";
import { RENDERED } from "../support/view.ts";

const ITEM_PANEL = 'section[data-slot="work.panel"][data-ext="tartan.work"]';
const WORK_TAB = 'section[data-slot="repo.tab"][data-ext="tartan.work"]';

/** No toast or alert says a field is missing (the form-payload symptom). */
const expectNoMissingField = async (screen: Screen): Promise<void> => {
	await expect(screen.getByRole("alert").filter({ hasText: /is required/ }))
		.toHaveCount(0);
	await expect(screen.getByRole("status").filter({ hasText: /is required/ }))
		.toHaveCount(0);
};

/**
 * Comments on the item page's panel: the action succeeds (its toast), then
 * the panel shows the comment in place. The action answers with a toast
 * only, so the in-place update comes from the live feed's `work.*` event.
 */
const comment = async (
	screen: Screen,
	browser: Browser,
	text: string,
): Promise<void> => {
	const panel = browser.locator(ITEM_PANEL);
	await panel.getByRole("textbox", /^Comment/).fill(text);
	await panel.getByRole("button", "Comment").tap();
	await expect(screen.getByRole("status").getByText("Comment added"))
		.toBeVisible();
	await expectNoMissingField(screen);
	await expect(panel.getByText(text)).toBeVisible();
};

test.describe("work items", {
	serial: true,
	session: "developer",
	tags: ["issues", "regression", "developer"],
}, () => {
	const created: { n: number; title: string }[] = [];

	test("a Developer creates a work item with the Work tab's form", {
		tags: ["smoke", "slot-ctx", "form-payload"],
	}, async ({ app, screen, browser, stage }) => {
		const repo = await fixtureRepo(stage, "classic", "issues");
		await app.open(`/${repo.path}/-/work`);
		await watchApi(browser);
		const view = await viewOf(browser, repo.path, "work");
		await expectSlotsSettled(browser, view, RENDERED.repoTab("work"));

		const form = browser.locator(WORK_TAB);
		// The Classic pack calls a work item an issue (its member's wording).
		await expect(form.getByRole("heading", `New ${workNoun("classic")}`))
			.toBeVisible();
		const title = `Rate limits for ${stage.runId}`;
		const why = `Bursts overload the router (${stage.runId}).`;
		const acceptance = ["429 after 100 requests", "Retry-After is set"];
		await form.getByRole("textbox", /^Title/).fill(title);
		await expect(form.getByRole("combobox", /^Kind/)).toHaveValue("0");
		await form.getByRole("textbox", /^Why/).fill(why);
		await form.getByRole("textbox", /^Acceptance/).fill(acceptance.join("\n"));
		await form.getByRole("button", "Create").tap();

		await expect(browser).toHaveURL(
			new RegExp(`/${repo.path}/-/work/(\\d+)$`),
			{ timeout: 20_000 },
		);
		await expectNoMissingField(screen);
		const n = Number(new URL(await browser.url()).pathname.split("/").at(-1));
		created.push({ n, title });
		// Every field of the form reached the extension.
		const panel = browser.locator(ITEM_PANEL);
		await expect(panel).toContainText(title);
		await expect(panel).toContainText(why);
		for (const line of acceptance) await expect(panel).toContainText(line);
		const agent = mcpClient(
			stage.origin,
			PACK_GROUP.classic,
			tokensOf(stage).developerAgent,
		);
		const item = await agent.call<WorkItem>("work_get", {
			ref: `${repo.path}#${n}`,
		});
		const ISSUE: WorkItem["kind"] = "issue";
		expect(item).toMatchObject({ title, why, acceptance, kind: ISSUE });
		await expectApiClean(browser);
	});

	test("the Work tab lists the item and its page settles", async ({ app, screen, browser, stage }) => {
		const repo = await fixtureRepo(stage, "classic", "issues");
		const [first] = created;
		await app.open(`/${repo.path}/-/work`);
		await screen.getByRole("link", first.title).tap();
		await expect(browser).toHaveURL(
			urlOf(stage.origin, `/${repo.path}/-/work/${first.n}`),
		);
		await watchApi(browser);
		const view = await viewOf(browser, repo.path, `work/${first.n}`);
		await expectSlotsSettled(browser, view, RENDERED.work);
		await expectApiClean(browser);
	});

	test("a Developer comments on the item", { tags: ["form-payload"] }, async ({
		app,
		screen,
		browser,
		stage,
	}) => {
		const repo = await fixtureRepo(stage, "classic", "issues");
		await app.open(`/${repo.path}/-/work/${created[0].n}`);
		await comment(screen, browser, `Developer note ${stage.runId}`);
	});

	test("the header's New work action opens the Work tab", {
		tags: ["header-actions"],
	}, async ({ app, browser, stage }) => {
		const repo = await fixtureRepo(stage, "classic", "issues");
		await app.open(`/${repo.path}`);
		await browser.locator('button[data-action="new-work"]').tap();
		await expect(browser).toHaveURL(
			urlOf(stage.origin, `/${repo.path}/-/work`),
		);
	});

	test("item 1 to item 2 in place renders item 2's panel", {
		tags: ["in-view-nav"],
	}, async ({ app, browser, stage }) => {
		const repo = await fixtureRepo(stage, "classic", "issues");
		const agent = mcpClient(
			stage.origin,
			PACK_GROUP.classic,
			tokensOf(stage).developerAgent,
		);
		const second = await agent.call<WorkItem>("work_create", {
			repo: repo.path,
			kind: "issue",
			title: `Second item for ${stage.runId}`,
		});
		const n2 = Number(second.ref.split("#").at(-1));

		await app.open(`/${repo.path}/-/work/${created[0].n}`);
		const panel = browser.locator(ITEM_PANEL);
		await expect(panel).toContainText(created[0].title);
		await spaNavigate(browser, `/${repo.path}/-/work/${n2}`);
		await expect(panel).toContainText(second.title);
		await expect(panel).not.toContainText(created[0].title);
		const view = await viewOf(browser, repo.path, `work/${n2}`);
		await expectSlotsSettled(browser, view, RENDERED.work);
	});
});

test("a Reporter comments on a work item", {
	session: "reporter",
	tags: ["issues", "regression", "reporter"],
}, async ({ app, screen, browser, stage }) => {
	const repo = await fixtureRepo(stage, "classic", "issues-reporter");
	const agent = mcpClient(
		stage.origin,
		PACK_GROUP.classic,
		tokensOf(stage).developerAgent,
	);
	const item = await agent.call<WorkItem>("work_create", {
		repo: repo.path,
		kind: "issue",
		title: `Reporter thread for ${stage.runId}`,
	});
	await app.open(`/${repo.path}/-/work/${item.ref.split("#").at(-1)}`);
	await watchApi(browser);
	await expect(browser.locator(ITEM_PANEL)).toContainText(item.title);
	await comment(screen, browser, `Reporter note ${stage.runId}`);
	await expectApiClean(browser);
});
