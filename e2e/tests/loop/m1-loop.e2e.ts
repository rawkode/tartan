// The M1 exit, end to end and deterministic (claim → lane →
// push → radar → submit → CI → review → Weave → Advance → why-notes): one
// test per step, each checking its step on the UI (the Owner's browser) and
// on the API (Node, with the run's tokens), over one shared loop instance
// (support/loop.ts). The loop's progress lives in shared stages, so a
// failed check never stops the loop; a failed stage fails every later test
// with the stage that broke it.
//
// Two scripted agents (MCP JSON-RPC and stock git, support/agent.ts) do the
// agent work; the Owner sets the repo up from a fixture whose root package
// `tartan` enables CI and review (ADR repo config), and approves both changes on
// their change pages. Names come from the contract (types) and the
// manifests; the only UI literals are the kernel views' own landmarks.
//
// Needs containers (CI, the review's CUE policy and the Advance run in
// them) and repository config: without either, every test skips with the
// reason, and the run summary lists it.

import { expect } from "e2e";
import type {
	Change,
	Conflict,
	QueueEntry,
	Review,
	WorkItem,
} from "@tartan/contract/interfaces.ts";
import type {
	AdvancesResponse,
	JobLogResponse,
	MeResponse,
	RunsResponse,
	WhyResponse,
} from "@tartan/contract/api.ts";
import type { RepoConfigStateDto } from "@tartan/contract/repoconfig.ts";
import { test } from "../../support/fixtures.ts";
import {
	CI_JOB,
	CI_MARKER,
	LOOP_CUE_FILES,
	LOOP_EDITS,
	LOOP_FILE,
	LOOP_PROJECT,
	LOOP_SENSITIVITY,
	LOOP_SHAS,
} from "../../support/fixture-repo.ts";
import { ok, query, tokenApi } from "../../support/http.ts";
import { slotLabel } from "../../support/labels.ts";
import {
	APPROVE_LABEL,
	type Loop,
	loopFor,
	type OwnerUi,
	type RepoOutcome,
	REVIEW_PANEL,
} from "../../support/loop.ts";
import {
	expectApiClean,
	expectSlotsSettled,
	fetchesOf,
	trackFetches,
	urlOf,
	viewOf,
	watchApi,
} from "../../support/page.ts";
import { type Stage, tokensOf } from "../../support/stage.ts";
import { activeChangeTab, RENDERED } from "../../support/view.ts";

// Contract names, checked by `deno task check` against the contract types.
const CURRENT: RepoConfigStateDto["status"] = "current";
const NEEDS_APPLY: RepoConfigStateDto["status"] = "needs-apply";
/** The Config page's apply button (a kernel view: RepoConfigView.vue). */
const APPLY_LABEL = "Apply trunk config";
const CLAIMED: WorkItem["state"] = "claimed";
const SUBMITTED: Change["state"] = "submitted";
const LANDED: Change["state"] = "landed";
const DONE: WorkItem["state"] = "done";
const HUMAN: Review["route"] = "human";
const APPROVE: NonNullable<Review["decision"]> = "approve";
const QUEUE_LANDED: QueueEntry["state"] = "landed";
/**
 * A file-level prediction or stronger (contract `CONFLICT_SEVERITIES`):
 * path-level radar (M1) reports `same_file`; hunks and diff3 are M2.
 */
const AT_LEAST_SAME_FILE: readonly Conflict["severity"][] = [
	"same_file",
	"adjacent",
	"textual",
	"semantic",
];
const DECLARED: Conflict["severity"] = "declared";

const LOOP_HEAD = LOOP_SHAS[LOOP_SHAS.length - 1];
const RADAR_TAB = slotLabel("tartan.radar", "repo.tab", "radar");
const WEAVE_TAB = slotLabel("tartan.weave", "repo.tab", "weave");
const CHANGES_TAB = slotLabel("tartan.changes", "repo.tab", "changes");

const NO_CONTAINERS =
	"the M1 loop needs containers: CI, the CUE policy and the Advance run in them (the stage was deployed with --no-containers)";

const MIN = 60_000;

type Fx = Parameters<Parameters<typeof test>[2]>[0];
/**
 * The fixtures a loop step uses, named one by one: spreading the fixture
 * object reads every fixture, `agent` included, which needs a model and
 * stops the whole run (MODEL_UNAVAILABLE).
 */
type LoopFx = Pick<Fx, "app" | "screen" | "browser" | "stage" | "workdir">;
type Body = (
	fx: LoopFx & { readonly loop: Loop; readonly repo: RepoOutcome },
) => Promise<void>;

/**
 * One loop step as a test: owner session, the containers precondition, the
 * loop instance of this attempt, the started/done marks the approval waits
 * for, and the repository-config precondition.
 */
const loopTest = (
	step: number,
	title: string,
	timeout: number,
	tags: readonly string[],
	body: Body,
): void => {
	const name = `${step}. ${title}`;
	test(name, {
		session: "owner",
		timeout,
		tags: ["loop", "m1", "containers", "regression", "owner", ...tags],
	}, async (fx) => {
		test.skip(!fx.stage.containers, NO_CONTAINERS);
		const loop = await loopFor(fx.stage, name);
		const done = await loop.checking(step);
		try {
			const repo = await loop.repo();
			test.skip(
				!repo.configEnabled,
				"repository config is off on this stage: the loop's CI and review come from its package tartan (stage up deploys with --repo-config)",
			);
			await body({
				app: fx.app,
				screen: fx.screen,
				browser: fx.browser,
				stage: fx.stage,
				workdir: fx.workdir,
				loop,
				repo,
			});
		} finally {
			await done();
		}
	});
};

const ownerApi = (stage: Stage) =>
	tokenApi(stage.origin, tokensOf(stage).ownerPat);

/**
 * Samples a repo's config state every 3 s until stopped: each change of
 * status, pending or applied sha, with the seconds since the start.
 */
const configTrail = (stage: Stage, at: string) => {
	const seen: string[] = [];
	let last = "";
	let running = true;
	const t0 = Date.now();
	const loop = (async () => {
		while (running) {
			try {
				const x = ok(
					"GET",
					at,
					await ownerApi(stage).get<RepoConfigStateDto>(at),
				);
				const now = `${x.status} pending=${
					x.pendingSha?.slice(0, 7) ?? "-"
				} applied=${x.appliedSha?.slice(0, 7) ?? "-"}`;
				if (now !== last) {
					seen.push(`${Math.round((Date.now() - t0) / 1000)}s ${now}`);
					last = now;
				}
			} catch (error) {
				seen.push(`error ${(error as Error).message.slice(0, 80)}`);
			}
			await new Promise((r) => setTimeout(r, 3_000));
		}
	})();
	return {
		stop: async (): Promise<string[]> => {
			running = false;
			await loop;
			return seen;
		},
	};
};

const uiOf = (fx: Pick<Fx, "app" | "screen" | "browser">): OwnerUi => ({
	app: fx.app,
	screen: fx.screen,
	browser: fx.browser,
});

const AGENTS = ["A", "B"] as const;

test.describe("M1 loop", { tags: ["loop"] }, () => {
	loopTest(
		1,
		"the Owner sets up the repo from the fixture; package tartan configures CI and review",
		8 * MIN,
		["cue-config"],
		async ({ app, screen, browser, stage, repo }) => {
			// API: trunk's config evaluated and in force as repo policy; the
			// cuenv file is sent with the others and left alone. The import
			// moved trunk outside the Advance, so the installations wait for a
			// Maintainer's apply (`needs-apply`) unless it already happened.
			expect([CURRENT, NEEDS_APPLY]).toContain(repo.configStatus);
			expect(repo.rootFiles).toEqual([...LOOP_CUE_FILES]);
			expect(repo.pipelineJobs).toEqual([CI_JOB]);
			expect(repo.ownerPaths).toEqual(["src/**"]);
			expect(repo.projects).toEqual([LOOP_PROJECT]);

			// UI: Repository → Config; the Owner applies trunk's config there.
			await app.open(`/${repo.path}/-/settings/extensions`);
			await watchApi(browser);
			await trackFetches(browser);
			const state = screen.getByRole("region", "State");
			const chip = browser.locator(
				'section[aria-labelledby="config-state"] [data-status]',
			);
			const at = `/-/api/repos/${encodeURIComponent(repo.id)}/config`;
			const before = ok(
				"GET",
				at,
				await ownerApi(stage).get<RepoConfigStateDto>(at),
			);
			if (before.status === NEEDS_APPLY) {
				expect(before.trunkSha, "needs-apply names trunk").toBe(LOOP_HEAD);
				await state.getByRole("button", APPLY_LABEL).tap();
			}
			// The apply resolves in the background (evaluation, then the
			// registry applies the installations); the page follows it on the
			// live feed. While the chip is awaited, the API's state is sampled,
			// so a failure says whether the kernel or the page lagged.
			const trail = configTrail(stage, at);
			try {
				await expect(chip).toHaveText(CURRENT, { timeout: 4 * MIN });
			} catch (error) {
				const fetched = (await fetchesOf(browser))
					.filter((f) => f.path === at)
					.map((f) => `${f.method} ${f.status}`);
				throw new Error(
					`${(error as Error).message}\nAPI states: ${
						(await trail.stop()).join(" | ")
					}\nthe page's config requests: ${fetched.join(", ")}`,
				);
			}
			await trail.stop();
			const after = ok(
				"GET",
				at,
				await ownerApi(stage).get<RepoConfigStateDto>(at),
			);
			expect(after.status).toBe(CURRENT);
			expect(after.appliedSha).toBe(LOOP_HEAD);
			if (before.status === NEEDS_APPLY) {
				const me = ok(
					"GET",
					"/-/api/me",
					await ownerApi(stage).get<MeResponse>("/-/api/me"),
				);
				expect(after.appliedBy).toContain(me.principal?.id);
			}
			for (const file of LOOP_CUE_FILES) {
				await expect(state.getByRole("link", file)).toBeVisible();
			}
			const policy = screen.getByRole("region", "Repo policy");
			await expect(policy).toContainText(CI_JOB);
			await expect(policy).toContainText("src/**");
			await expect(policy).toContainText(LOOP_PROJECT);
			await expectApiClean(browser);
		},
	);

	loopTest(
		2,
		"two agents claim work items and open lanes",
		10 * MIN,
		["agent", "mcp", "lanes"],
		async ({ app, browser, stage, loop, repo }) => {
			const c = await loop.claimed();
			// API: each item carries its agent's lane; B's claim was told about
			// A's lane (declared footprints over the same project and prefix).
			for (const name of AGENTS) {
				const item = await loop.agentOf(name).mcp.call<WorkItem>("work_get", {
					ref: c.items[name].ref,
				});
				expect(item.title).toBe(c.items[name].title);
				expect(c.items[name].state, `item ${name} after its claim`).toBe(
					CLAIMED,
				);
				expect(item.claims.map((x) => x.laneId)).toContain(
					c.lanes[name].id,
				);
				expect(c.lanes[name].base, `lane ${name} starts at trunk`).toBe(
					LOOP_HEAD,
				);
				expect(c.lanes[name].ref).toBe(`refs/heads/lanes/${c.lanes[name].id}`);
			}
			const toA = c.overlapsB.find((o) => o.laneId === c.lanes.A.id);
			expect(toA, "B's claim lists A's lane as an overlap").toBeDefined();
			expect([DECLARED, ...AT_LEAST_SAME_FILE]).toContain(toA?.severity);

			// UI: the Lanes view lists both lanes; each work item shows its claim.
			await app.open(`/${repo.path}/-/lanes`);
			await watchApi(browser);
			for (const name of AGENTS) {
				await expect(
					browser.locator(
						`ol[aria-label="Lanes"] a[href$="/-/lanes/${c.lanes[name].id}"]`,
					).first(),
				).toBeVisible();
			}
			await expectApiClean(browser);
			const n = c.items.A.ref.split("#").at(-1);
			await app.open(`/${repo.path}/-/work/${n}`);
			const view = await viewOf(browser, repo.path, `work/${n}`);
			await expectSlotsSettled(browser, view, RENDERED.work);
			const panel = browser.locator(
				'section[data-slot="work.panel"][data-ext="tartan.work"]',
			);
			await expect(panel).toContainText(c.items.A.title);
			await expect(browser).toHaveURL(
				urlOf(stage.origin, `/${repo.path}/-/work/${n}`),
			);
		},
	);

	loopTest(
		3,
		"each agent pushes to its lane; radar predicts the overlap and the UI shows it",
		12 * MIN,
		["agent", "git", "radar"],
		async ({ app, screen, browser, loop, repo, workdir }) => {
			const c = await loop.claimed();
			const p = await loop.pushed();
			// git: each lane head is on the forge under its own lane ref.
			for (const name of AGENTS) {
				const agent = loop.agentOf(name);
				const clone = await agent.clone(workdir, repo.remote);
				const refs = await agent.git(clone, [
					"ls-remote",
					"origin",
					c.lanes[name].ref,
				]);
				expect(refs.trim().split(/\s+/)[0], `lane ${name}'s head`).toBe(
					p.heads[name],
				);
			}
			// API: radar's conflict between the two lanes, in the shared file.
			expect(p.conflict.path).toBe(LOOP_FILE);
			expect(AT_LEAST_SAME_FILE).toContain(p.conflict.severity);
			const { conflicts } = await loop.agentOf("B").mcp.call<
				{ conflicts: Conflict[] }
			>("conflicts_list", { repo: repo.path, laneId: c.lanes.B.id });
			expect(conflicts.map((x) => x.id)).toContain(p.conflict.id);
			// A's next tool result carried radar's notice about B's lane.
			expect(p.noticeA, "agent A was notified about B's lane").not.toBeNull();

			// UI: the Radar tab lists the conflict with both lanes.
			await app.open(`/${repo.path}`);
			await screen.getByRole("navigation", "Repository").getByRole(
				"link",
				RADAR_TAB,
			).tap();
			await watchApi(browser);
			const radar = browser.locator(
				'section[data-slot="repo.tab"][data-ext="tartan.radar"]',
			);
			const row = radar.getByRole("row").filter({ hasText: LOOP_FILE });
			await expect(row).toHaveCount(1, { timeout: 20_000 });
			await expect(row).toContainText(p.conflict.severity);
			await expect(row).toContainText(c.lanes.A.id);
			await expect(row).toContainText(c.lanes.B.id);
			await expectApiClean(browser);

			// UI: A's lane page badge and the file's banner show it too.
			await app.open(`/${repo.path}/-/lanes/${c.lanes.A.id}`);
			const lane = await viewOf(browser, repo.path, `lanes/${c.lanes.A.id}`);
			await expectSlotsSettled(browser, lane, RENDERED.lane);
			await expect(
				browser.locator(
					'section[data-slot="lane.badge"][data-ext="tartan.radar"]',
				),
			).toContainText(p.conflict.severity.replace("_", " "));
			await app.open(`/${repo.path}/-/blob/main/${LOOP_FILE}`);
			const banner = browser.locator(
				'section[data-slot="file.banner"][data-ext="tartan.radar"]',
			);
			await expect(banner).toContainText(c.lanes.A.id, { timeout: 20_000 });
			await expect(banner).toContainText(c.lanes.B.id);
		},
	);

	loopTest(
		4,
		"both agents submit their changes",
		12 * MIN,
		["agent", "mcp", "changes"],
		async ({ app, screen, browser, loop, repo }) => {
			const c = await loop.claimed();
			const p = await loop.pushed();
			const s = await loop.submitted();
			// API: one change per lane, revision 1 at the pushed head.
			for (const name of AGENTS) {
				const change = await loop.agentOf(name).mcp.call<Change>(
					"changes_get",
					{
						repo: repo.path,
						changeId: s.changes[name].changeId,
					},
				);
				expect(change.laneId).toBe(c.lanes[name].id);
				expect(change.state).toBe(SUBMITTED);
				expect(change.revisions.map((r) => r.head)).toEqual([p.heads[name]]);
				expect(change.revisions[0].affected).toContain(LOOP_PROJECT);
			}
			// UI: the Changes tab lists both; A's page shows its overview and diff.
			await app.open(`/${repo.path}`);
			await screen.getByRole("navigation", "Repository").getByRole(
				"link",
				CHANGES_TAB,
			).tap();
			for (const name of AGENTS) {
				await expect(screen.getByRole("link", s.changes[name].title))
					.toBeVisible();
			}
			await app.open(`/${repo.path}/-/changes/${s.changes.A.changeId}`);
			await watchApi(browser);
			const view = await viewOf(
				browser,
				repo.path,
				`changes/${s.changes.A.changeId}`,
			);
			await expectSlotsSettled(
				browser,
				view,
				RENDERED.change(activeChangeTab(view)),
			);
			await expect(
				browser.locator(
					'section[data-slot="change.panel"][data-ext="tartan.changes"]',
				).first(),
			).toContainText(s.changes.A.title);
			await expect(browser.locator('section[data-slot="change.tab"]'))
				.toContainText(LOOP_FILE, { timeout: 20_000 });
			await expectApiClean(browser);
		},
	);

	loopTest(
		5,
		"CI runs in containers and goes green",
		25 * MIN,
		["ci", "runs", "stub-pages"],
		async ({ app, browser, stage, loop, repo }) => {
			const s = await loop.submitted();
			const ci = await loop.ciGreen();
			const owner = ownerApi(stage);
			for (const name of AGENTS) {
				const job = ci.checks[name].find((x) => x.context.startsWith(CI_JOB));
				expect(job?.runId, `change ${name} ran ${CI_JOB}`).toBeTruthy();
				const runs = ok(
					"GET",
					"/-/api/runs/<repo>",
					await owner.get<RunsResponse>(
						`/-/api/runs/${encodeURIComponent(repo.id)}`,
					),
				);
				const run = runs.runs.find((r) => r.runId === job?.runId);
				expect(run?.subject).toMatchObject({
					kind: "change",
					id: s.changes[name].changeId,
				});
				const jobId = (run?.jobs.find((j) =>
					j.jobId.startsWith(CI_JOB)
				) ?? run?.jobs[0])
					?.jobId ?? "";
				const log = ok(
					"GET",
					"/-/api/runs/<repo>/<run>/jobs/<job>/log",
					await owner.get<JobLogResponse>(
						`/-/api/runs/${encodeURIComponent(repo.id)}/${
							encodeURIComponent(job?.runId ?? "")
						}/jobs/${encodeURIComponent(jobId)}/log`,
					),
				);
				expect(log.text).toContain(CI_MARKER);
			}
			// UI: the change's CI sidebar, the Runs view and the job log.
			const jobA = ci.checks.A.find((x) => x.context.startsWith(CI_JOB));
			await app.open(`/${repo.path}/-/changes/${s.changes.A.changeId}`);
			const sidebar = browser.locator(
				'section[data-slot="change.sidebar"][data-ext="tartan.ci"]',
			);
			await expect(sidebar).toContainText(CI_JOB, { timeout: 20_000 });
			await expect(sidebar).toContainText(jobA?.state ?? "success");
			await app.open(`/${repo.path}/-/runs`);
			await watchApi(browser);
			await expect(browser.locator(`tr[data-run="${jobA?.runId}"]`))
				.toBeVisible({ timeout: 20_000 });
			await expectApiClean(browser);
		},
	);

	loopTest(
		6,
		"a human reviewer approves both changes in the UI",
		30 * MIN,
		["review", "human"],
		async (fx) => {
			const { app, browser, stage, loop, repo } = fx;
			const s = await loop.submitted();
			const rv = await loop.reviewHuman();
			for (const name of AGENTS) {
				expect(rv.reviews[name].route).toBe(HUMAN);
				expect(
					rv.reviews[name].factors.sensitive,
					`the owners rule (sensitivity ${LOOP_SENSITIVITY}) marks change ${name}`,
				).toBe(LOOP_SENSITIVITY / 3);
			}
			const ap = await loop.approved(uiOf(fx));
			// API: the Owner (a user, Maintainer+) decided both, at their heads.
			const me = ok(
				"GET",
				"/-/api/me",
				await ownerApi(stage).get<MeResponse>("/-/api/me"),
			);
			const ownerId = me.principal === null ? "(nobody)" : me.principal.id;
			for (const name of AGENTS) {
				const review = await loop.agentOf(name).mcp.call<Review>("review_get", {
					repo: repo.path,
					changeId: s.changes[name].changeId,
				});
				expect(review.decision).toBe(APPROVE);
				expect(review.decidedBy).toMatchObject({ kind: "user", id: ownerId });
				expect(ap.decidedBy[name]).toBe(ownerId);
			}
			// UI: a decided review offers no approve button any more.
			for (const name of AGENTS) {
				const changeId = s.changes[name].changeId;
				await app.open(`/${repo.path}/-/changes/${changeId}`);
				const view = await viewOf(browser, repo.path, `changes/${changeId}`);
				await expectSlotsSettled(
					browser,
					view,
					RENDERED.change(activeChangeTab(view)),
				);
				const panel = browser.locator(REVIEW_PANEL);
				await expect(panel).toBeVisible();
				await expect(panel.getByRole("button", APPROVE_LABEL)).toHaveCount(0);
				await expect(browser.locator(`${REVIEW_PANEL} button`)).toHaveCount(0);
			}
		},
	);

	loopTest(
		7,
		"the Weave orders both changes and an Advance lands them on trunk",
		50 * MIN,
		["weave", "advance", "land"],
		async (fx) => {
			const { app, screen, browser, stage, loop, repo } = fx;
			const s = await loop.submitted();
			const l = await loop.landed(uiOf(fx));
			const owner = ownerApi(stage);
			// API: both landed, on trunk, newest first in the order they landed.
			for (const name of AGENTS) {
				const change = await loop.agentOf(name).mcp.call<Change>(
					"changes_get",
					{
						repo: repo.path,
						changeId: s.changes[name].changeId,
					},
				);
				expect(change.state).toBe(LANDED);
				expect(change.landedCommit).toBe(l.commits[name]);
			}
			expect(l.trunk.slice(0, 2)).toEqual(
				[...l.order].reverse().map((name) => l.commits[name]),
			);
			// The Weave's queue holds only what is still to land: neither change.
			const queue = await loop.agentOf("A").mcp.call<
				{ partitions: { entries: QueueEntry[] }[] }
			>("queue_status", { repo: repo.path });
			const queued = queue.partitions.flatMap((p) => p.entries).map((e) =>
				e.changeId
			);
			for (const name of AGENTS) {
				expect(queued, `change ${name} left the queue`).not.toContain(
					s.changes[name].changeId,
				);
			}
			const advances = ok(
				"GET",
				"/-/api/advances",
				await owner.get<AdvancesResponse>(
					`/-/api/advances?${query({ repo: repo.path })}`,
				),
			).advances;
			const moved = advances.filter((a) => a.state === "done" && a.newSha);
			expect(moved.map((a) => a.newSha)).toContain(l.trunk[0]);

			// UI: the Weave tab's recent landings, the Advances view, History.
			await app.open(`/${repo.path}`);
			await screen.getByRole("navigation", "Repository").getByRole(
				"link",
				WEAVE_TAB,
			).tap();
			const weave = browser.locator(
				'section[data-slot="repo.tab"][data-ext="tartan.weave"]',
			);
			for (const name of AGENTS) {
				const row = weave.getByRole("row").filter({
					hasText: s.changes[name].changeId,
				});
				await expect(row).toContainText(QUEUE_LANDED, { timeout: 20_000 });
				await expect(row).toContainText(l.commits[name]);
			}
			// Each change's Weave panel names its landed commit.
			await app.open(`/${repo.path}/-/changes/${s.changes.A.changeId}`);
			const position = browser.locator(
				'section[data-slot="change.sidebar"][data-ext="tartan.weave"]',
			);
			await expect(position).toContainText(QUEUE_LANDED, { timeout: 20_000 });
			await expect(position).toContainText(l.commits.A.slice(0, 12));
			await app.open(`/${repo.path}/-/advances`);
			await watchApi(browser);
			const tip = moved.find((a) => a.newSha === l.trunk[0]);
			await expect(
				browser.locator(
					`li[data-advance="${tip?.id}"] a[href$="/-/commit/${l.trunk[0]}"]`,
				),
			).toBeVisible({ timeout: 20_000 });
			await expectApiClean(browser);
			await app.open(`/${repo.path}/-/commits/main`);
			const subjects = browser.locator("ol.commits .commits__subject");
			await expect(subjects.nth(0)).toHaveText(
				s.changes[l.order[1]].title,
			);
			await expect(subjects.nth(1)).toHaveText(
				s.changes[l.order[0]].title,
			);
		},
	);

	loopTest(
		8,
		"why-notes and provenance are visible for a landed line",
		50 * MIN,
		["why", "provenance", "notes"],
		async (fx) => {
			const { app, browser, stage, loop, repo, workdir } = fx;
			const c = await loop.claimed();
			const p = await loop.pushed();
			const s = await loop.submitted();
			const l = await loop.landed(uiOf(fx));
			const line = LOOP_EDITS.A.line;
			const owner = ownerApi(stage);
			// API: why for A's landed commit names A's change, lane and head.
			const why = ok(
				"GET",
				"/-/api/why",
				await owner.get<WhyResponse>(
					`/-/api/why?${query({ repo: repo.path, sha: l.commits.A })}`,
				),
			);
			expect(why.commit).toBe(l.commits.A);
			expect(why.note?.kernel).toMatchObject({
				change: s.changes.A.changeId,
				lane: c.lanes.A.id,
				laneHead: p.heads.A,
				provenance: "complete",
				checks: { state: "success" },
			});
			expect(why.events.length).toBeGreaterThan(0);
			// API: why for a path (and line) is the newest landing that touched the
			// file; line-level why-blame is M2 (src/kernel/land/routes.ts), so here
			// it is the last of the two.
			const last = l.order[1];
			const byPath = ok(
				"GET",
				"/-/api/why",
				await owner.get<WhyResponse>(
					`/-/api/why?${
						query({ repo: repo.path, path: LOOP_FILE, line: String(line) })
					}`,
				),
			);
			expect(byPath.commit).toBe(l.commits[last]);
			expect(byPath.note?.kernel).toMatchObject({
				change: s.changes[last].changeId,
				lane: c.lanes[last].id,
			});

			// git: the why note travels with the commit (`refs/notes/tartan`).
			const agent = loop.agentOf("A");
			const clone = await agent.clone(workdir, repo.remote);
			await agent.git(clone, [
				"fetch",
				"-q",
				"origin",
				"refs/notes/tartan:refs/notes/tartan",
			]);
			const note = JSON.parse(
				await agent.git(clone, ["notes", "--ref=tartan", "show", l.commits.A]),
			) as { kernel?: { change?: string; lane?: string } };
			expect(note.kernel).toMatchObject({
				change: s.changes.A.changeId,
				lane: c.lanes.A.id,
			});

			// UI: Why for the file (the newest landing, as the API answers), and
			// A's landed commit page with its why note.
			await app.open(`/${repo.path}/-/blame/main/${LOOP_FILE}?line=${line}`);
			await watchApi(browser);
			const article = browser.locator(
				`article.why[data-commit="${l.commits[last]}"]`,
			);
			await expect(article).toBeVisible({ timeout: 20_000 });
			await expect(article).toContainText(s.changes[last].changeId);
			await expect(article).toContainText(c.lanes[last].id);
			await expectApiClean(browser);
			await app.open(`/${repo.path}/-/commit/${l.commits.A}`);
			await expect(browser.locator("#why-title")).toBeVisible();
			await expect(browser.locator("dl.commit__meta")).toContainText(
				s.changes.A.changeId,
			);
		},
	);

	loopTest(
		9,
		"the work items close",
		55 * MIN,
		["work", "close"],
		async (fx) => {
			const { app, browser, loop, repo } = fx;
			const c = await loop.claimed();
			const closed = await loop.closed(uiOf(fx));
			for (const name of AGENTS) {
				expect(closed.states[name]).toBe(DONE);
				const item = await loop.agentOf(name).mcp.call<WorkItem>("work_get", {
					ref: c.items[name].ref,
				});
				expect(item.state).toBe(DONE);
			}
			const n = c.items.B.ref.split("#").at(-1);
			await app.open(`/${repo.path}/-/work/${n}`);
			const view = await viewOf(browser, repo.path, `work/${n}`);
			await expectSlotsSettled(browser, view, RENDERED.work);
			await expect(
				browser.locator(
					'section[data-slot="work.panel"][data-ext="tartan.work"]',
				),
			).toContainText(DONE);
		},
	);
});
