// Browsing code in a Swarm repo (the fixture history, constant
// SHAs). Tree, blob, commit and compare pages render from the kernel's
// browse API; every slot on them settles without an error chip;
// the repository sidebar column shows only when the view lists a
// `repo.sidebar` instance; moving from one file to another inside the
// page re-renders the file banner for the new file.

import { expect } from "e2e";
import { test } from "../support/fixtures.ts";
import {
	FIXTURE_COMMITS,
	FIXTURE_COMPARE_PATHS,
	FIXTURE_GUIDE_LINE,
	FIXTURE_ROOT,
	FIXTURE_SHAS,
} from "../support/fixture-repo.ts";
import {
	expectApiClean,
	expectSlotsSettled,
	fetchMatching,
	namingFailedRequests,
	spaNavigate,
	trackFetches,
	viewOf,
	watchApi,
} from "../support/page.ts";
import { fixtureRepo } from "../support/repos.ts";
import { ctxOfSlotRequest, RENDERED } from "../support/view.ts";

const SIDEBAR = 'aside[aria-label="Repository sidebar"]';

test.describe("browsing code", {
	session: "developer",
	tags: ["browse", "regression", "developer"],
}, () => {
	test("the repo home shows the tree, the README and a settled sidebar", {
		tags: ["smoke", "slot-ctx", "repo-sidebar"],
	}, async ({ app, screen, browser, stage }) => {
		const repo = await fixtureRepo(stage, "swarm", "browse");
		await app.open(`/${repo.path}`);
		await watchApi(browser);
		await namingFailedRequests(browser, () =>
			expect(
				screen.getByRole("heading", {
					name: repo.path.split("/").at(-1),
					level: 1,
				}),
			).toBeVisible());
		for (const entry of FIXTURE_ROOT) {
			await expect(screen.getByRole("link", entry)).toBeVisible();
		}
		await expect(screen.getByRole("heading", { name: /README\.md/ }))
			.toBeVisible();
		const view = await viewOf(browser, repo.path, "");
		await expectSlotsSettled(browser, view, RENDERED.repoCode);
		const sidebar = view.slots.some((s) => s.slot === "repo.sidebar");
		await expect(browser.locator(SIDEBAR)).toHaveCount(sidebar ? 1 : 0);
		await expectApiClean(browser);
	});

	test("tree and history show the sidebar only when the view lists one", {
		tags: ["repo-sidebar"],
	}, async ({ app, screen, browser, stage }) => {
		const repo = await fixtureRepo(stage, "swarm", "browse");
		for (
			const [url, view] of [
				[`/${repo.path}/-/tree/main`, "tree/main"],
				[`/${repo.path}/-/commits/main`, "commits/main"],
			] as const
		) {
			await app.open(url);
			await watchApi(browser);
			const v = await viewOf(browser, repo.path, view);
			await expectSlotsSettled(browser, v, RENDERED.repoCode);
			const sidebar = v.slots.some((s) => s.slot === "repo.sidebar");
			await expect(browser.locator(SIDEBAR)).toHaveCount(sidebar ? 1 : 0);
			await expectApiClean(browser);
		}
		await expect(screen.getByRole("link", FIXTURE_COMMITS[2].subject))
			.toBeVisible();
	});

	test("a file shows its lines and a settled file banner", {
		tags: ["slot-ctx-narrowing"],
	}, async ({ app, screen, browser, stage }) => {
		const repo = await fixtureRepo(stage, "swarm", "browse");
		await app.open(`/${repo.path}/-/blob/main/src/router/index.ts`);
		await watchApi(browser);
		await expect(
			screen.getByRole("region", "Contents of src/router/index.ts"),
		).toContainText("export const route");
		const view = await viewOf(
			browser,
			repo.path,
			"blob/main/src/router/index.ts",
		);
		await expectSlotsSettled(browser, view, RENDERED.blob);
		await expectApiClean(browser);
	});

	test("moving to another file re-renders the file banner for it", {
		tags: ["in-view-nav"],
	}, async ({ app, screen, browser, stage }) => {
		const repo = await fixtureRepo(stage, "swarm", "browse");
		await app.open(`/${repo.path}/-/blob/main/src/router/index.ts`);
		const view = await viewOf(
			browser,
			repo.path,
			"blob/main/src/router/index.ts",
		);
		await expectSlotsSettled(browser, view, RENDERED.blob);
		const banners = view.slots.filter((s) => s.slot === "file.banner");
		test.skip(banners.length === 0, "no extension shows a file banner here");

		// The banner renders for the new file: the request whose ctx names it,
		// whatever refresh of the first file races the navigation.
		const ids = new Set(banners.map((b) => encodeURIComponent(b.id)));
		await trackFetches(browser);
		await spaNavigate(browser, `/${repo.path}/-/blob/main/docs/guide.md`);
		const render = await fetchMatching(browser, (f) => {
			const m = /^\/-\/api\/slot\/[^/]+\/([^/]+)$/.exec(f.path);
			if (f.method !== "GET" || m === null || !ids.has(m[1])) return false;
			const ctx = ctxOfSlotRequest(`${stage.origin}${f.path}${f.search}`);
			return ctx.path === "docs/guide.md";
		}, { message: "the file banner never rendered for docs/guide.md" });
		expect(render.status).toBe(200);
		expect(
			ctxOfSlotRequest(`${stage.origin}${render.path}${render.search}`),
		).toMatchObject({ path: "docs/guide.md", ref: "main" });
		await expect(screen.getByRole("region", "Contents of docs/guide.md"))
			.toContainText("The router maps paths to handlers.");
		const next = await viewOf(browser, repo.path, "blob/main/docs/guide.md");
		await expectSlotsSettled(browser, next, RENDERED.blob);
	});

	test("a commit shows its subject and full SHA", async ({ app, screen, browser, stage }) => {
		const repo = await fixtureRepo(stage, "swarm", "browse");
		await app.open(`/${repo.path}/-/commit/${FIXTURE_SHAS[2]}`);
		await watchApi(browser);
		await namingFailedRequests(browser, () =>
			expect(
				screen.getByRole("heading", { name: FIXTURE_COMMITS[2].subject }),
			).toBeVisible());
		await expect(screen.getByText(FIXTURE_SHAS[2], { exact: true }))
			.toBeVisible();
		await expect(browser.locator(".diff-files__path")).toHaveText([
			"docs/guide.md",
		]);
		await expectApiClean(browser);
	});

	test("compare lists the paths changed between two commits", async ({ app, browser, stage }) => {
		const repo = await fixtureRepo(stage, "swarm", "browse");
		await app.open(
			`/${repo.path}/-/compare/${FIXTURE_SHAS[0]}...${FIXTURE_SHAS[2]}`,
		);
		await watchApi(browser);
		await expect(browser.locator(".diff-files__path")).toHaveText([
			...FIXTURE_COMPARE_PATHS,
		]);
		await expectApiClean(browser);
	});

	// The diffs' lines, apart from the paths above: these fail while the
	// kernel's file diffs carry no patch text (every file then reads "Patch
	// too large to show inline.").
	test("a commit's diff shows the lines it adds", {
		tags: ["known-bug"],
	}, async ({ app, browser, stage }) => {
		const repo = await fixtureRepo(stage, "swarm", "browse");
		await app.open(`/${repo.path}/-/commit/${FIXTURE_SHAS[2]}`);
		const files = browser.locator(".diff-files");
		await expect(files).toContainText("docs/guide.md");
		await expect(files).toContainText(FIXTURE_GUIDE_LINE);
	});

	test("compare shows the lines between two commits", {
		tags: ["known-bug"],
	}, async ({ app, browser, stage }) => {
		const repo = await fixtureRepo(stage, "swarm", "browse");
		await app.open(
			`/${repo.path}/-/compare/${FIXTURE_SHAS[0]}...${FIXTURE_SHAS[2]}`,
		);
		const files = browser.locator(".diff-files");
		await expect(files).toContainText(FIXTURE_GUIDE_LINE);
		await expect(files).toContainText("export const route");
	});
});
