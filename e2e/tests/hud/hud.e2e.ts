// Live: the HUD, the simulated swarm and the coordination views. On a dev
// stage with dev tools, a forge admin starts a small simulated swarm (`POST /-/api/swarm`,
// ≤ 20 agents labelled sim) on the namespace `e2e`: it provisions
// `e2e/sim/router-<nn>` (branch lanes), the Swarm pack there and tartan.hud on
// the namespace, whose `hud.metric` slots count what the agents do.
//
// - the HUD counters move while the swarm runs, and the simulated agents
//   are labelled as such;
// - the dev tools behind seed and reset (the swarm and seed-history routes)
//   refuse a Reporter and an agent token;
// - the Change Graph shows the swarm's lanes; a change of the run lands, and
//   the Runs view's live tail, the Advances view and Why-blame render it.

import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Browser } from "@e2e-dev/web";
import { expect } from "e2e";
import type { Change, LaneHandle } from "@tartan/contract/interfaces.ts";
import type {
	AdvancesResponse,
	LandBatchDto,
	RunsResponse,
	SwarmStatus,
	ViewResponse,
} from "@tartan/contract/api.ts";
import type { ErrorCode } from "@tartan/contract/errors.ts";
import { scriptedAgent } from "../../support/agent.ts";
import { sharedStore, test } from "../../support/fixtures.ts";
import { CI_MARKER } from "../../support/fixture-repo.ts";
import { ok, pageApi, query, tokenApi } from "../../support/http.ts";
import { PACK_GROUP } from "../../support/names.ts";
import { expectApiClean, viewOf, watchApi } from "../../support/page.ts";
import { fixtureRepo } from "../../support/repos.ts";
import { keyOf, sharedDirOf } from "../../support/shared.ts";
import { type Stage, tokensOf } from "../../support/stage.ts";

const NAMESPACE = "e2e";
/** The first shard of the namespace's sim group (`router-<nn>` from 01, plan.ts). */
const SIM_REPO = `${NAMESPACE}/sim/router-01`;
const PREDICTED = "Predicted conflicts";
/**
 * A small swarm: 6 simulated agents for a couple of minutes, so even three
 * repeats at once (`--repeat-each 3`) stay within 20 simulated agents.
 */
const SWARM = {
	agents: 6,
	workItems: 6,
	overlap: 0.3,
	hotFiles: 3,
	minutes: 2,
} as const;
const SWARM_CAP = 20;
const DENIED: ErrorCode = "denied";
const LANDED: Change["state"] = "landed";
const MIN = 60_000;
const METRIC = 'section[data-slot="hud.metric"][data-ext="tartan.hud"]';
const HOME = 'section[data-slot="home.section"][data-ext="tartan.hud"]';

type Swarm = { readonly id: string; readonly before: number };

/** A metric slot's stat value and its trend's last (this minute's) bucket. */
const metricValue = async (
	browser: Browser,
	title: string,
): Promise<{ value: number; last: number } | null> => {
	// The slot shows "Loading <title>…" until its render arrives: read the
	// stat's value and the sparkline's label ("trend of 60: min …, max …,
	// last N", N this minute) once the stat is there.
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		const read = await browser.evaluate(
			(a: { sel: string; title: string }) => {
				const section = [...document.querySelectorAll(a.sel)].find((el) =>
					(el.textContent ?? "").includes(a.title)
				);
				return {
					value: section?.querySelector(".ui-stat__value")?.textContent ??
						"",
					trend: section?.querySelector('[aria-label^="trend of"]')
						?.getAttribute("aria-label") ?? "",
				};
			},
			{ sel: METRIC, title },
		).catch(() => ({ value: "", trend: "" }));
		const value = numberOf(read.value);
		if (value !== null) {
			return {
				value,
				last: numberOf(/last (\S+)/.exec(read.trend)?.[1]) ?? 0,
			};
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	return null;
};

/** A number as `formatNumber` prints it: `3,594`, or compact `120K`, `1.2M`. */
const numberOf = (text: string | undefined): number | null => {
	const m = /(\d[\d,]*(?:\.\d+)?)\s*([KMB])?/.exec(text ?? "");
	if (m === null) return null;
	const scales: Readonly<Record<string, number>> = { K: 1e3, M: 1e6, B: 1e9 };
	const scale = scales[m[2] ?? ""] ?? 1;
	return Number(m[1].replaceAll(",", "")) * scale;
};

const swarmOf = (
	stage: Stage,
	index: number,
	browser: Browser,
	before: number,
): Promise<Swarm> =>
	sharedStore().once(`hud-${index}-swarm`, async (): Promise<Swarm> => {
		const repo = await fixtureRepo(
			stage,
			"swarm",
			index === 0 ? "hud" : `hud-${index}`,
		);
		const started = await pageApi(browser).send<SwarmStatus>(
			"POST",
			`/-/api/swarm?${query({ max: String(SWARM_CAP) })}`,
			{ repo: repo.path, ...SWARM },
		);
		if (started.status !== 202 || started.body === null) {
			throw new Error(
				`swarm start: HTTP ${started.status} ${started.error?.code ?? ""}`,
			);
		}
		return { id: started.body.id, before };
	});

type Landed = {
	readonly repo: { readonly path: string; readonly id: string };
	readonly changeId: string;
	readonly commit: string;
	readonly runId: string;
	readonly jobId: string;
	readonly file: string;
};

/** One change of the run lands on the hud repo (auto review, the Weave). */
const landedOf = (stage: Stage, index: number): Promise<Landed> =>
	sharedStore().once(`hud-${index}-landed`, async (): Promise<Landed> => {
		const repo = await fixtureRepo(
			stage,
			"swarm",
			index === 0 ? "hud-views" : `hud-views-${index}`,
		);
		const agent = scriptedAgent(stage, PACK_GROUP.swarm, "A");
		const { lane: first } = await agent.mcp.call<{ lane: LaneHandle }>(
			"lanes_open",
			{ repo: repo.path, purpose: "coordination views: one landed change" },
		);
		const lane = await agent.awaitOpen(repo.path, first);
		const clone = await agent.clone(
			path.join(sharedDirOf(tmpdir(), stage.runId), `scratch-hud-${index}`),
			repo.remote,
		);
		await agent.runLane(lane.git.start, clone);
		const file = "docs/views.md";
		await writeFile(
			path.join(clone, file),
			`# Views\n\nLanded by the e2e run ${stage.runId}.\n`,
		);
		await agent.commit(clone, "Document the coordination views");
		await agent.runLane(lane.git.push, clone);
		const { changeId } = await agent.mcp.call<{ changeId: string }>(
			"changes_submit",
			{
				repo: repo.path,
				laneId: lane.id,
				title: `coordination views (${stage.runId}/${index})`,
				summary: "One documentation page.",
			},
		);
		let commit = "";
		await expect.poll(async () => {
			const change = await agent.mcp.call<Change>("changes_get", {
				repo: repo.path,
				changeId,
			});
			commit = change.landedCommit ?? "";
			return change.state;
		}, {
			timeout: 20 * MIN,
			interval: 5_000,
			message: "the change to land",
		}).toBe(LANDED);
		const owner = tokenApi(stage.origin, tokensOf(stage).ownerPat);
		const run = ok(
			"GET",
			"/-/api/runs/<repoId>",
			await owner.get<RunsResponse>(
				`/-/api/runs/${encodeURIComponent(repo.id)}`,
			),
		).runs.find((r) => r.subject?.id === changeId);
		if (run === undefined || run.jobs[0] === undefined) {
			throw new Error("the change has no CI run with a job");
		}
		return {
			repo: { path: repo.path, id: repo.id },
			changeId,
			commit,
			runId: run.runId,
			jobId: run.jobs[0].jobId,
			file,
		};
	});

const T = {
	counters:
		"the HUD counters move during a small simulated swarm, its agents labelled sim",
	graph: "the Change Graph shows the swarm's lanes",
	runs: "the Runs view's job page tails the CI log",
	advances: "the Advances view lists the Advance that landed the change",
	why: "Why-blame names the change's commit for the file it wrote",
	refused:
		"the dev tools behind seed and reset refuse a Reporter and an agent token",
} as const;

const skipWithoutDevTools = (stage: Stage) =>
	test.skip(
		!/^https:\/\/tartan-dev-/.test(stage.origin),
		"the swarm is a dev tool (dev stages only)",
	);

test.describe("the HUD and a simulated swarm", {
	tags: ["hud", "m2", "swarm", "regression", "owner"],
	session: "owner",
}, () => {
	test(T.counters, { tags: ["sim", "smoke"], timeout: 15 * MIN }, async ({
		app,
		browser,
		stage,
	}) => {
		skipWithoutDevTools(stage);
		await app.open(`/-/hud?${query({ node: NAMESPACE })}`);
		// The baseline is a rendered value: Predicted conflicts is the
		// namespace's all-time total, so it only grows. On a namespace the
		// HUD is not on yet (the swarm installs it), the baseline is read
		// once it renders, while this swarm still runs.
		const before = await metricValue(browser, PREDICTED).catch(() => null);
		const index = await sharedStore().claimIndex(`claim-${keyOf(T.counters)}`);
		const s = await swarmOf(stage, index, browser, before?.value ?? -1);
		// API: the swarm runs and its cohorts push.
		let status: SwarmStatus | null = null;
		await expect.poll(async () => {
			status = ok(
				"GET",
				"/-/api/swarm/<id>",
				await pageApi(browser).get<SwarmStatus>(`/-/api/swarm/${s.id}`),
			);
			return status.pushes;
		}, {
			timeout: 6 * MIN,
			interval: 5_000,
			message: "the swarm's agents to push",
		}).toBeGreaterThan(0);
		expect(status!.agents).toBeLessThanOrEqual(SWARM_CAP);
		// UI: the namespace's HUD counts the swarm's lanes.
		await app.open(`/-/hud?${query({ node: NAMESPACE })}`);
		await watchApi(browser);
		const view = await viewOf(browser, NAMESPACE, "hud");
		expect(
			view.slots.filter((x) => x.slot === "hud.metric").length,
			"tartan.hud is in force on the namespace",
		).toBeGreaterThan(0);
		// The counters move with the swarm's activity: Predicted conflicts
		// (the all-time total) grows past a rendered baseline while this
		// swarm pushes (a parallel repeat's swarm counts too: the namespace's
		// HUD cannot tell them apart). The active lanes say how many are
		// simulated agents.
		let baseline = s.before;
		if (baseline < 0) {
			const first = await metricValue(browser, PREDICTED);
			expect(first, "the Predicted conflicts stat renders").not.toBeNull();
			baseline = first!.value;
		}
		const MOVED = "moved";
		await expect.poll(async () => {
			await app.open(`/-/hud?${query({ node: NAMESPACE })}`);
			const now = await metricValue(browser, PREDICTED);
			if (now === null) return "not rendered";
			return now.value > baseline
				? MOVED
				: `total ${now.value} (baseline ${baseline}), this minute ${now.last}`;
		}, {
			timeout: 4 * MIN,
			interval: 10_000,
			message: "the Predicted conflicts total to grow past its baseline",
		}).toBe(MOVED);
		await expect(
			browser.locator(METRIC).filter({ hasText: "Active lanes" }).first(),
		).toContainText(/[1-9]\d* of them simulated agents/, { timeout: 20_000 });
		// The home section tells real agents from simulated ones.
		await app.open(`/-/hud?${query({ node: NAMESPACE })}`);
		await expect(browser.locator(HOME)).toContainText(/simulated/i, {
			timeout: 30_000,
		});
		await expectApiClean(browser);
	});

	test(T.graph, { tags: ["sim", "ui"], timeout: 15 * MIN }, async ({
		app,
		browser,
		stage,
	}) => {
		skipWithoutDevTools(stage);
		await app.open("/");
		const index = await sharedStore().claimIndex(`claim-${keyOf(T.graph)}`);
		await swarmOf(stage, index, browser, 0);
		await expect.poll(async () => {
			const view = await pageApi(browser).get<ViewResponse>(
				`/-/api/view?${query({ path: SIM_REPO, view: "lanes" })}`,
			);
			return view.status;
		}, { timeout: 6 * MIN, interval: 5_000, message: "the sim repo" }).toBe(
			200,
		);
		// The graph renders after its event fetch: read once the list is there.
		await expect.poll(async () => {
			await app.open(`/${SIM_REPO}/-/lanes`);
			await browser.locator('ol[aria-label="Lanes"]').waitFor({
				state: "visible",
				timeout: 20_000,
			}).catch(() => {});
			return await browser.locator('ol[aria-label="Lanes"] [data-sim]')
				.count();
		}, {
			timeout: 6 * MIN,
			interval: 10_000,
			message: "the swarm's simulated lanes in the Change Graph",
		}).toBeGreaterThan(0);
		await expect(browser.locator('[aria-label="Lane summary"]')).toBeVisible();
	});

	test(
		T.runs,
		{ tags: ["containers", "runs", "ui"], timeout: 25 * MIN },
		async ({
			app,
			screen,
			stage,
		}) => {
			test.skip(!stage.containers, "CI runs need containers");
			const l = await landedOf(
				stage,
				await sharedStore().claimIndex(`claim-${keyOf(T.runs)}`),
			);
			await app.open(`/${l.repo.path}/-/runs/${l.runId}/jobs/${l.jobId}`);
			await expect(screen.getByRole("region", "Job log")).toContainText(
				CI_MARKER,
				{ timeout: 60_000 },
			);
		},
	);

	test(
		T.advances,
		{ tags: ["containers", "land", "ui"], timeout: 25 * MIN },
		async ({
			app,
			browser,
			stage,
		}) => {
			test.skip(!stage.containers, "landing needs CI and the Advance");
			const l = await landedOf(
				stage,
				await sharedStore().claimIndex(`claim-${keyOf(T.advances)}`),
			);
			const owner = tokenApi(stage.origin, tokensOf(stage).ownerPat);
			const advances = ok(
				"GET",
				"/-/api/advances",
				await owner.get<AdvancesResponse>(
					`/-/api/advances?${query({ repo: l.repo.path })}`,
				),
			).advances;
			// The Advance that landed this change: its new trunk is the
			// change's commit, or its batch holds the change (a batch of
			// several changes advances trunk past it).
			let advance = advances.find((a) => a.newSha === l.commit);
			for (const a of advances) {
				if (advance !== undefined) break;
				if (a.state !== "done") continue;
				const batch = ok(
					"GET",
					"/-/api/advances/<batchId>",
					await owner.get<LandBatchDto>(
						`/-/api/advances/${encodeURIComponent(a.batchId)}?${
							query({ repo: l.repo.path })
						}`,
					),
				);
				if (batch.changes.some((c) => c.changeId === l.changeId)) advance = a;
			}
			expect(advance, "the Advance that landed the run's change").toBeDefined();
			await app.open(`/${l.repo.path}/-/advances`);
			await watchApi(browser);
			await expect(
				browser.locator(`[data-advance="${advance!.id}"]`),
			).toBeVisible({ timeout: 30_000 });
			await expect(browser.locator("[data-advances-summary]")).toBeVisible();
			await expectApiClean(browser);
		},
	);

	test(T.why, { tags: ["containers", "why", "ui"], timeout: 25 * MIN }, async ({
		app,
		browser,
		stage,
	}) => {
		test.skip(!stage.containers, "landing needs CI and the Advance");
		const l = await landedOf(
			stage,
			await sharedStore().claimIndex(`claim-${keyOf(T.why)}`),
		);
		await app.open(`/${l.repo.path}/-/blame/main/${l.file}`);
		await watchApi(browser);
		await expect(browser.locator(`[data-why-row="${l.commit}"]`)).toBeVisible({
			timeout: 30_000,
		});
		await expectApiClean(browser);
	});
});

test.describe("dev tools are the forge admin's", {
	tags: ["hud", "m2", "swarm", "regression", "reporter"],
	session: "reporter",
}, () => {
	test(T.refused, { tags: ["security"], timeout: 3 * MIN }, async ({
		app,
		browser,
		stage,
	}) => {
		skipWithoutDevTools(stage);
		await app.open("/");
		const page = pageApi(browser);
		const body = { repo: `${PACK_GROUP.swarm}/nope`, ...SWARM };
		for (
			const [method, at, payload] of [
				["POST", "/-/api/swarm", body],
				["DELETE", "/-/api/swarm", undefined],
				["POST", `/-/api/seed-history?${query({ repo: SIM_REPO })}`, {
					count: 1,
				}],
			] as const
		) {
			const reply = await page.send(method, at, payload);
			expect(reply.status, `${method} ${at.split("?")[0]} as a Reporter`)
				.toBe(403);
			expect(reply.error?.code).toBe(DENIED);
		}
		const agent = tokenApi(stage.origin, tokensOf(stage).developerAgent);
		const asAgent = await agent.send("POST", "/-/api/swarm", body);
		expect(asAgent.status, "an agent token").toBe(403);
	});
});
