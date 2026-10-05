// Changes ("pull requests"), lanes and CI runs on a
// Classic repo, where review is human-required, so the changes stay open.
//
// The agent work is one shared setup per run (support/shared.ts): agent A
// opens two lanes with `lanes_open` over MCP (JSON-RPC with its Bearer
// token), runs each handle's `git.start` and `git.push` (parsed, never
// through a shell), submits both with `changes_submit`, and comments once on
// each change over MCP. Every check is then its own test that reaches the
// setup, so one failing check never skips another: the Changes tab, the
// change page's overview and tabs, its diff lines, Revisions, commenting in
// the UI, moving from A to B in place, the Lanes view and lane pages and,
// with containers, the CI run the submit started.

import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect } from "e2e";
import type { LaneHandle } from "@tartan/contract/interfaces.ts";
import type {
	JobLogResponse,
	RunsResponse,
	ViewResponse,
} from "@tartan/contract/api.ts";
import type { RepoConfigStateDto } from "@tartan/contract/repoconfig.ts";
import { scriptedAgent } from "../support/agent.ts";
import { sharedStore, test } from "../support/fixtures.ts";
import { CI_MARKER, FIXTURE_HEAD } from "../support/fixture-repo.ts";
import { ok, pageApi, tokenApi } from "../support/http.ts";
import { slotLabel } from "../support/labels.ts";
import { PACK_GROUP } from "../support/names.ts";
import {
	expectApiClean,
	expectSlotsSettled,
	fetchMatching,
	spaNavigate,
	trackFetches,
	urlOf,
	viewOf,
	watchApi,
} from "../support/page.ts";
import { fixtureRepo } from "../support/repos.ts";
import { keyOf, sharedDirOf } from "../support/shared.ts";
import { type Stage, tokensOf } from "../support/stage.ts";
import {
	activeChangeTab,
	ctxOfSlotRequest,
	RENDERED,
} from "../support/view.ts";

type Opened = {
	readonly key: "A" | "B";
	readonly title: string;
	/** The line the change adds to docs/guide.md. */
	readonly line: string;
	readonly laneId: string;
	readonly changeId: string;
	/** The lane head after the push (revision 1). */
	readonly head: string;
	/** The comment agent A left on the change over MCP. */
	readonly comment: string;
};

type Setup = {
	readonly repo: {
		readonly path: string;
		readonly id: string;
		readonly remote: string;
	};
	readonly opened: readonly Opened[];
};

const THREADS = 'section[data-slot="change.panel"][data-ext="tartan.changes"]';
const LANE_SIDEBAR =
	'section[data-slot="lane.sidebar"][data-ext="tartan.changes"]';
/** The change tabs `tartan.changes` contributes, from its manifest. */
const MANIFEST_CHANGE_TABS = [
	slotLabel("tartan.changes", "change.tab", "diff"),
	slotLabel("tartan.changes", "change.tab", "revisions"),
];

/** The run's changes setup (instance `index`: one per `--repeat-each` repeat). */
const setupOf = (stage: Stage, index: number): Promise<Setup> =>
	sharedStore().once(`changes-${index}-setup`, async (): Promise<Setup> => {
		const suite = index === 0 ? "changes" : `changes-${index}`;
		const repo = await fixtureRepo(stage, "classic", suite);
		const agent = scriptedAgent(stage, PACK_GROUP.classic, "A");
		// The clone outlives this test: it lives in the run's shared directory,
		// which the launcher removes after the run.
		const root = path.join(
			sharedDirOf(tmpdir(), stage.runId),
			`scratch-${suite}`,
		);
		const clone = await agent.clone(root, repo.remote);
		const opened: Opened[] = [];
		for (const key of ["A", "B"] as const) {
			const { lane: first } = await agent.mcp.call<{ lane: LaneHandle }>(
				"lanes_open",
				{ repo: repo.path, purpose: `e2e change ${key}` },
			);
			const lane = await agent.awaitOpen(repo.path, first);
			if (lane.base !== FIXTURE_HEAD) {
				throw new Error(`lane ${key} does not start at the fixture head`);
			}
			await agent.runLane(lane.git.start, clone);
			const line = `Change ${key} for ${stage.runId}/${index}.`;
			await appendFile(path.join(clone, "docs", "guide.md"), `\n${line}\n`);
			const head = await agent.commit(clone, `Change ${key}`);
			await agent.runLane(lane.git.push, clone);
			const title = `Change ${key} ${stage.runId}/${index}`;
			const submitted = await agent.mcp.call<
				{ changeId: string; revision: number }
			>("changes_submit", {
				repo: repo.path,
				laneId: lane.id,
				title,
				summary: `Adds a line to the guide (${key}).`,
			});
			if (submitted.revision !== 1) {
				throw new Error(
					`change ${key} starts at revision ${submitted.revision}`,
				);
			}
			const comment = `Agent note on ${key} for ${stage.runId}/${index}`;
			await agent.mcp.call("changes_comment", {
				repo: repo.path,
				changeId: submitted.changeId,
				body: comment,
			});
			opened.push({
				key,
				title,
				line,
				laneId: lane.id,
				changeId: submitted.changeId,
				head,
				comment,
			});
		}
		return {
			repo: { path: repo.path, id: repo.id, remote: repo.remote },
			opened,
		};
	});

/** The setup of this attempt: the n-th time this test runs in the run. */
const changesFor = async (stage: Stage, title: string): Promise<Setup> =>
	setupOf(
		stage,
		await sharedStore().claimIndex(`claim-changes-${keyOf(title)}`),
	);

const change = (s: Setup, key: "A" | "B"): Opened => {
	const found = s.opened.find((o) => o.key === key);
	if (found === undefined) throw new Error(`change ${key} was not opened`);
	return found;
};

const T = {
	setup: "an agent opens two lanes, pushes and submits two changes",
	list: "the Changes tab lists both changes",
	page: "a change page has its overview and the manifest's tabs",
	diff: "the Diff tab shows the lines the change adds",
	revisions: "Revisions lists revision 1 at the lane head",
	comment: "a comment typed on a change shows in its threads",
	inPlace: "A to B in place shows B's threads, never A's",
	lanes: "the Lanes view lists both lanes",
	lanePages: "lane pages render their slots and follow in-view navigation",
	ci: "the submit started a CI run whose job log has the fixture's marker",
} as const;

test.describe("changes, lanes and runs", {
	session: "developer",
	tags: ["changes", "lanes", "regression", "developer"],
}, () => {
	test(T.setup, {
		tags: ["agent", "mcp", "git"],
		timeout: 300_000,
	}, async ({ stage }) => {
		const s = await changesFor(stage, T.setup);
		const agent = scriptedAgent(stage, PACK_GROUP.classic, "A");
		for (const o of s.opened) {
			const got = await agent.mcp.call<
				{ state: string; laneId: string; revisions: { head: string }[] }
			>("changes_get", { repo: s.repo.path, changeId: o.changeId });
			expect(got.laneId).toBe(o.laneId);
			expect(got.revisions.map((r) => r.head)).toEqual([o.head]);
		}
	});

	test(T.list, { tags: ["slot-ctx"], timeout: 300_000 }, async ({
		app,
		screen,
		browser,
		stage,
	}) => {
		const s = await changesFor(stage, T.list);
		await app.open(`/${s.repo.path}/-/changes`);
		await watchApi(browser);
		for (const o of s.opened) {
			await expect(screen.getByRole("link", o.title)).toBeVisible();
		}
		const view = await viewOf(browser, s.repo.path, "changes");
		await expectSlotsSettled(browser, view, RENDERED.repoTab("changes"));
		await expectApiClean(browser);
	});

	test(T.page, {
		tags: ["change-tabs", "change-overview"],
		timeout: 300_000,
	}, async ({ app, screen, browser, stage }) => {
		const s = await changesFor(stage, T.page);
		const a = change(s, "A");
		await app.open(`/${s.repo.path}/-/changes/${a.changeId}`);
		await watchApi(browser);
		const view = await viewOf(browser, s.repo.path, `changes/${a.changeId}`);
		await expectSlotsSettled(
			browser,
			view,
			RENDERED.change(activeChangeTab(view)),
		);
		// The overview is a change.panel and comes first.
		await expect(browser.locator(THREADS).first()).toContainText(a.title);
		// The tab bar is the view's change.tab contributions, in order,
		// which are the manifest's.
		const served = view.static.tabs.filter((t) => t.slot === "change.tab")
			.slice().sort((x, y) => x.order - y.order).map((t) => t.label ?? t.id);
		expect([...served].sort()).toEqual([...MANIFEST_CHANGE_TABS].sort());
		const nav = screen.getByRole("navigation", "Change");
		await expect(nav.getByRole("link")).toHaveText(served);
		await expect(nav.getByRole("link", served[0])).toHaveAttribute(
			"aria-current",
			"page",
		);
		const diff = browser.locator('section[data-slot="change.tab"]');
		await expect(diff).toContainText("docs/guide.md", { timeout: 20_000 });
		await expectApiClean(browser);
	});

	test(T.diff, {
		tags: ["change-tabs", "known-bug"],
		timeout: 300_000,
	}, async ({ app, browser, stage }) => {
		// Fails while the kernel's file diffs carry no patch text (the SPA then
		// prints "Patch too large to show inline." for every file).
		const s = await changesFor(stage, T.diff);
		const a = change(s, "A");
		await app.open(`/${s.repo.path}/-/changes/${a.changeId}`);
		const diff = browser.locator('section[data-slot="change.tab"]');
		await expect(diff).toContainText("docs/guide.md", { timeout: 20_000 });
		await expect(diff).toContainText(a.line);
	});

	test(T.revisions, { tags: ["change-tabs"], timeout: 300_000 }, async ({
		app,
		browser,
		stage,
	}) => {
		const s = await changesFor(stage, T.revisions);
		const a = change(s, "A");
		await app.open(`/${s.repo.path}/-/changes/${a.changeId}/revisions`);
		const view = await viewOf(
			browser,
			s.repo.path,
			`changes/${a.changeId}/revisions`,
		);
		await expectSlotsSettled(
			browser,
			view,
			RENDERED.change(activeChangeTab(view, "revisions")),
		);
		const revisions = browser.locator('section[data-slot="change.tab"]');
		await expect(revisions.getByRole("link", "r1")).toBeVisible();
		await expect(revisions).toContainText(a.head.slice(0, 12));
	});

	test(T.comment, { tags: ["form-payload"], timeout: 300_000 }, async ({
		app,
		browser,
		stage,
	}) => {
		const s = await changesFor(stage, T.comment);
		const a = change(s, "A");
		await app.open(`/${s.repo.path}/-/changes/${a.changeId}`);
		const threads = browser.locator(THREADS).filter({
			has: browser.locator("form"),
		});
		await expect(threads).toContainText(a.comment, { timeout: 20_000 });
		const text = `Developer comment on A for ${stage.runId}`;
		await threads.getByRole("textbox", /^Comment/).fill(text);
		await threads.getByRole("button", "Comment").tap();
		await expect(threads).toContainText(text);
	});

	test(T.inPlace, {
		tags: ["in-view-nav", "cross-page-ctx"],
		timeout: 300_000,
	}, async ({ app, browser, stage }) => {
		const s = await changesFor(stage, T.inPlace);
		const a = change(s, "A");
		const b = change(s, "B");
		await app.open(`/${s.repo.path}/-/changes/${a.changeId}`);
		const threads = browser.locator(THREADS).filter({
			has: browser.locator("form"),
		});
		await expect(threads).toContainText(a.comment, { timeout: 20_000 });

		// The threads render for B: the request whose ctx names B, whatever
		// live refresh of A races the navigation.
		await trackFetches(browser);
		await spaNavigate(browser, `/${s.repo.path}/-/changes/${b.changeId}`);
		const render = await fetchMatching(browser, (f) => {
			if (
				f.method !== "GET" || !/^\/-\/api\/slot\/[^/]+\/threads$/.test(f.path)
			) {
				return false;
			}
			const ctx = ctxOfSlotRequest(`${stage.origin}${f.path}${f.search}`);
			return (ctx.entity as { id?: unknown } | undefined)?.id === b.changeId;
		}, { message: "the threads slot never rendered for change B" });
		expect(render.status).toBe(200);
		await expect(threads).toContainText(b.comment);
		await expect(threads).not.toContainText(a.comment);
		await expect(browser.locator(THREADS).first()).toContainText(b.title);
		const view = await viewOf(browser, s.repo.path, `changes/${b.changeId}`);
		await expectSlotsSettled(
			browser,
			view,
			RENDERED.change(activeChangeTab(view)),
		);
	});

	test(T.lanes, { tags: ["slot-ctx"], timeout: 300_000 }, async ({
		app,
		browser,
		stage,
	}) => {
		const s = await changesFor(stage, T.lanes);
		await app.open(`/${s.repo.path}/-/lanes`);
		await watchApi(browser);
		await expect(browser.locator('[aria-label="Lane summary"]')).toBeVisible();
		await expect(browser.locator('ol[aria-label="Lanes"]')).toBeVisible();
		for (const o of s.opened) {
			await expect(
				browser.locator(
					`ol[aria-label="Lanes"] a[href$="/-/lanes/${o.laneId}"]`,
				).first(),
			).toBeVisible();
		}
		await expectApiClean(browser);
	});

	test(T.lanePages, {
		tags: ["slot-ctx-narrowing", "in-view-nav"],
		timeout: 300_000,
	}, async ({ app, browser, stage }) => {
		const s = await changesFor(stage, T.lanePages);
		const a = change(s, "A");
		const b = change(s, "B");
		await app.open(`/${s.repo.path}/-/lanes/${a.laneId}`);
		await watchApi(browser);
		const title = browser.locator("#lane-detail-title");
		await expect(title).toHaveText(a.laneId);
		let view: ViewResponse = await viewOf(
			browser,
			s.repo.path,
			`lanes/${a.laneId}`,
		);
		await expectSlotsSettled(browser, view, RENDERED.lane);
		const sidebar = browser.locator(LANE_SIDEBAR);
		await expect(sidebar).toContainText(a.title);

		await browser.locator(
			`ol[aria-label="Lanes"] a[href$="/-/lanes/${b.laneId}"]`,
		).first().tap();
		await expect(browser).toHaveURL(
			urlOf(stage.origin, `/${s.repo.path}/-/lanes/${b.laneId}`),
		);
		await expect(title).toHaveText(b.laneId);
		await expect(sidebar).toContainText(b.title);
		await expect(sidebar).not.toContainText(a.title);
		view = await viewOf(browser, s.repo.path, `lanes/${b.laneId}`);
		await expectSlotsSettled(browser, view, RENDERED.lane);
		await expectApiClean(browser);
	});

	test(T.ci, {
		tags: ["containers", "runs", "stub-pages"],
		timeout: 600_000,
	}, async ({ app, screen, browser, stage }) => {
		test.skip(
			!stage.containers,
			"the stage runs without containers (stage up --no-containers): no CI",
		);
		const s = await changesFor(stage, T.ci);
		const owner = tokenApi(stage.origin, tokensOf(stage).ownerPat);
		const config = ok(
			"GET",
			"/-/api/repos/<id>/config",
			await owner.get<RepoConfigStateDto>(
				`/-/api/repos/${encodeURIComponent(s.repo.id)}/config`,
			),
		);
		test.skip(
			!config.enabled,
			"repository config is off on this stage: the fixture's CI job comes from its package tartan (stage up deploys with --repo-config)",
		);
		await app.open(`/${s.repo.path}/-/runs`);
		const api = pageApi(browser);
		let runId = "";
		let jobId = "";
		await expect.poll(async () => {
			const runs = await api.get<RunsResponse>(
				`/-/api/runs/${encodeURIComponent(s.repo.id)}`,
			);
			const run = runs.body?.runs.find((x) =>
				s.opened.some((o) => x.subject?.id === o.changeId)
			);
			runId = run?.runId ?? "";
			jobId = run?.jobs[0]?.jobId ?? "";
			return jobId !== "";
		}, {
			timeout: 300_000,
			interval: 5_000,
			message: "no CI run for the changes",
		})
			.toBe(true);
		await expect.poll(async () => {
			const log = await api.get<JobLogResponse>(
				`/-/api/runs/${encodeURIComponent(s.repo.id)}/${
					encodeURIComponent(runId)
				}/jobs/${encodeURIComponent(jobId)}/log`,
			);
			return log.body?.text.includes(CI_MARKER) ?? false;
		}, {
			timeout: 300_000,
			interval: 5_000,
			message: "the job log never showed the marker",
		})
			.toBe(true);

		await app.open(`/${s.repo.path}/-/runs`);
		await expect(browser.locator(`tr[data-run="${runId}"]`)).toBeVisible();
		await app.open(`/${s.repo.path}/-/runs/${runId}/jobs/${jobId}`);
		await expect(screen.getByRole("region", "Job log")).toContainText(
			CI_MARKER,
		);
	});
});
