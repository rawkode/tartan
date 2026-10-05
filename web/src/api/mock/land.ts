// Mock fixtures and answers for the runs (WP9 `handleRuns`) and land (WP10
// `handleAdvances`, `handleWhy`, `handleBlame`) reads of the sample repo,
// with the kernel's paths, query names, auth rules and response shapes:
//
//   GET /-/api/runs/<repoId>[?subject=&cursor=&limit=]   signed-in callers
//   GET /-/api/runs/<repoId>/<runId>[/jobs/<jobId>/log]
//   GET /-/api/advances?repo=<path>[&cursor=&limit=]     public repo: anyone
//   GET /-/api/advances/<batchId>?repo=<path>
//   GET /-/api/why?repo=<path>&(sha=|path=[&line=])
//   GET /-/api/blame                                     501 (M2)
//
// Also the mock of a `static+action` result the views exercise: `tartan.work`
// answers its "New work" header action (`new-work`) by navigating to the
// repo's Work tab, as `extensions/work/src/ui.ts` does.

import type {
	ActionResponse,
	AdvanceDto,
	AdvancesResponse,
	LandBatchDto,
	NodeDto,
	RunDto,
	WhyResponse,
} from "@tartan/contract/api.ts";
import type { SlotCtxHint } from "@tartan/contract/slot-ctx.ts";
import { CHANGE_ID_2, EVENTS, LANE_IDS } from "./coord.ts";
import {
	CHANGE_ID,
	instId,
	MOCK_NOW,
	mockUlid,
	OWNER_ID,
	REPO_ID,
	SHAS,
} from "./fixtures.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

export const RUN_IDS = {
	passed: mockUlid(5001),
	failed: mockUlid(5002),
	running: mockUlid(5003),
} as const;

export const BATCH_IDS = {
	landed: `lb_${mockUlid(6001)}`,
	conflicted: `lb_${mockUlid(6002)}`,
} as const;

const CI = instId("tartan.ci");

export const RUNS: readonly RunDto[] = [
	{
		runId: RUN_IDS.running,
		repoId: REPO_ID,
		kind: "ci",
		state: "running",
		subject: { kind: "change", id: CHANGE_ID_2 },
		sha: SHAS.lane,
		requestedBy: CI,
		createdAt: MOCK_NOW - 4 * MIN,
		jobs: [
			{
				jobId: "test-shared",
				project: "packages/shared",
				state: "success",
				exitCode: 0,
				startedAt: MOCK_NOW - 4 * MIN,
				finishedAt: MOCK_NOW - 3 * MIN,
			},
			{
				jobId: "test-api",
				project: "services/api",
				state: "running",
				startedAt: MOCK_NOW - 3 * MIN,
			},
		],
	},
	{
		runId: RUN_IDS.failed,
		repoId: REPO_ID,
		kind: "ci",
		state: "failure",
		subject: { kind: "change", id: CHANGE_ID },
		sha: SHAS.c3,
		requestedBy: CI,
		createdAt: MOCK_NOW - 2 * HOUR - 20 * MIN,
		finishedAt: MOCK_NOW - 2 * HOUR - 12 * MIN,
		jobs: [
			{
				jobId: "test-web",
				project: "apps/web",
				state: "failure",
				exitCode: 1,
				startedAt: MOCK_NOW - 2 * HOUR - 20 * MIN,
				finishedAt: MOCK_NOW - 2 * HOUR - 12 * MIN,
			},
		],
	},
	{
		runId: RUN_IDS.passed,
		repoId: REPO_ID,
		kind: "git",
		state: "success",
		sha: SHAS.c2,
		requestedBy: "sys_kernel",
		createdAt: MOCK_NOW - 5 * HOUR - 10 * MIN,
		finishedAt: MOCK_NOW - 5 * HOUR - 9 * MIN,
		jobs: [
			{
				jobId: "compose",
				state: "success",
				exitCode: 0,
				cached: true,
				startedAt: MOCK_NOW - 5 * HOUR - 10 * MIN,
				finishedAt: MOCK_NOW - 5 * HOUR - 9 * MIN,
			},
		],
	},
];

export const JOB_LOGS: Readonly<Record<string, string>> = {
	[`${RUN_IDS.running}/test-shared`]:
		"$ pnpm --filter @router/shared test\n✓ limit caps at 100 (2 ms)\n1 passed\n",
	[`${RUN_IDS.running}/test-api`]:
		"$ pnpm --filter @router/api test\n✓ GET /n answers 200 (8 ms)\n",
	[`${RUN_IDS.failed}/test-web`]:
		"$ pnpm --filter @router/web test\n✗ theme toggle remembers dark (12 ms)\n  expected 'dark', got 'light'\n1 failed\n",
	[`${RUN_IDS.passed}/compose`]:
		"git merge-tree --write-tree main lanes/x\ncomposed 3 files\n",
};

export const ADVANCES: readonly AdvanceDto[] = [
	{
		id: `adv_${mockUlid(6001)}_1`,
		batchId: BATCH_IDS.landed,
		attempt: 1,
		ref: "refs/heads/main",
		expectOld: SHAS.c1,
		newSha: SHAS.c2,
		ownerInstance: "repo-do",
		leaseUntil: MOCK_NOW - 5 * HOUR,
		step: "refs-pushed",
		state: "done",
		evidenceReused: false,
		createdAt: MOCK_NOW - 5 * HOUR - 6 * MIN,
		finishedAt: MOCK_NOW - 5 * HOUR - 5 * MIN,
		gateResults: [
			{ ext: "acme.no-secrets", decision: "allow", mode: "enforce" },
			{
				ext: "tartan.radar",
				decision: "advise",
				mode: "shadow",
				message: "services/api/src/server.ts is also edited in another lane",
			},
		],
		chainSeq: 2,
		chainHead: "9".repeat(64),
	},
	{
		id: `adv_${mockUlid(6002)}_2`,
		batchId: BATCH_IDS.conflicted,
		attempt: 2,
		ref: "refs/heads/main",
		expectOld: SHAS.c3,
		ownerInstance: "repo-do",
		leaseUntil: MOCK_NOW - 50 * MIN,
		step: "locked",
		state: "stale",
		evidenceReused: true,
		createdAt: MOCK_NOW - 55 * MIN,
		finishedAt: MOCK_NOW - 54 * MIN,
	},
];

export const BATCHES: readonly LandBatchDto[] = [
	{
		batchId: BATCH_IDS.landed,
		repoId: REPO_ID,
		ref: "refs/heads/main",
		state: "landed",
		attempt: 1,
		candidateSha: SHAS.c2,
		baseSha: SHAS.c1,
		changes: [
			{
				changeId: CHANGE_ID,
				laneId: LANE_IDS.router,
				outcome: "landed",
				commit: SHAS.c2,
			},
		],
		advanceId: `adv_${mockUlid(6001)}_1`,
		createdAt: MOCK_NOW - 5 * HOUR - 12 * MIN,
		finishedAt: MOCK_NOW - 5 * HOUR - 5 * MIN,
	},
	{
		batchId: BATCH_IDS.conflicted,
		repoId: REPO_ID,
		ref: "refs/heads/main",
		state: "conflicted",
		attempt: 2,
		baseSha: SHAS.c3,
		changes: [
			{
				changeId: CHANGE_ID_2,
				laneId: LANE_IDS.web,
				outcome: "conflicted",
			},
		],
		advanceId: `adv_${mockUlid(6002)}_2`,
		createdAt: MOCK_NOW - 58 * MIN,
		finishedAt: MOCK_NOW - 54 * MIN,
	},
];

/** The why answer for the landed batch's commit (and the files it touched). */
export const WHY: WhyResponse = {
	repo: "acme/platform/router",
	commit: SHAS.c2,
	note: {
		v: 1,
		kernel: {
			advance: `adv_${mockUlid(6001)}_1`,
			ref: "refs/heads/main",
			batch: BATCH_IDS.landed,
			landedBy: instId("tartan.weave"),
			actor: OWNER_ID,
			change: CHANGE_ID,
			lane: LANE_IDS.router,
			laneHead: SHAS.lane,
			laneMode: "branch",
			laneHeadRef: `refs/tartan/changes/${CHANGE_ID}`,
			rangeBase: SHAS.c1,
			firstPushers: [],
			provenance: "complete",
			reason: {
				summary:
					"Split the router config by service so each team owns its routes",
				events: EVENTS.slice(0, 2).map((e) => e.id),
			},
			gates: [
				{ ext: "acme.no-secrets@1.0.0", decision: "allow", mode: "enforce" },
			],
			checks: {
				state: "success",
				runs: [RUN_IDS.passed],
				evidenceReused: false,
			},
			chain: { seq: 2, head: "9".repeat(64) },
		},
		// The sections tartan.work, tartan.changes and tartan.review contribute
		// (their `noteSection`s), keyed by extension id.
		ext: {
			"tartan.work": {
				ref: "acme/platform/router#17",
				title: "Split router into modules",
				kind: "intent",
				why:
					"Each team should own its routes without merge fights in one file.",
				acceptance: [
					"routes load per service",
					"no route is registered twice",
				],
				plan: "One module per service, a registry in shared",
				agent: "a_claude-1",
			},
			"tartan.changes@0.1.0": {
				change: CHANGE_ID,
				title: "api: split router into modules",
				summary: "Moves each service's routes into its own module.",
				revision: 2,
			},
			"tartan.review": { route: "auto", risk: 0.18 },
		},
	},
	events: EVENTS.slice(0, 2),
	chainVerified: true,
};

/** Files the landed commit touched (the why-by-path answer). */
const WHY_PATHS: ReadonlySet<string> = new Set([
	"services/api/src/server.ts",
	"packages/shared/index.ts",
]);

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const error = (status: number, code: string, message: string): Response =>
	json({ error: code, message }, status);

const page = <T>(
	items: readonly T[],
	cursor: string,
	limit: string,
): { items: readonly T[]; cursor?: string } => {
	const from = Number(cursor || "0");
	const size = Math.min(200, Math.max(1, Number(limit || "50")));
	const next = from + size;
	return {
		items: items.slice(from, next),
		...(next < items.length ? { cursor: String(next) } : {}),
	};
};

export type LandApiRequest = {
	readonly path: string;
	readonly method: string;
	readonly query: URLSearchParams;
	readonly signedIn: boolean;
	readonly nodes: readonly NodeDto[];
};

/** Answers the runs and land reads, or `null` for any other path. */
export const answerLandApi = (req: LandApiRequest): Response | null => {
	const q = (key: string): string => req.query.get(key) ?? "";
	if (req.path.startsWith("/-/api/runs")) {
		if (req.method !== "GET") return error(404, "not_found", "not found");
		if (!req.signedIn) return error(401, "unauthenticated", "Sign in first.");
		const [repoId, runId, ...tail] = req.path.slice("/-/api/runs".length)
			.split("/").filter((p) => p !== "");
		if (repoId === undefined) {
			return error(404, "not_found", "runs are listed per repo");
		}
		if (!req.nodes.some((n) => n.id === repoId && n.kind === "repo")) {
			return error(404, "not_found", "no such repo");
		}
		const runs = RUNS.filter((r) => r.repoId === repoId);
		if (runId === undefined) {
			const subject = q("subject");
			const matching = subject === ""
				? runs
				: runs.filter((r) =>
					r.subject !== undefined &&
					`${r.subject.kind}:${r.subject.id}` === subject
				);
			const { items, cursor } = page(matching, q("cursor"), q("limit"));
			return json({ runs: items, ...(cursor ? { cursor } : {}) });
		}
		const run = runs.find((r) => r.runId === runId);
		if (!run) return error(404, "not_found", "no such run");
		if (tail.length === 0) return json(run);
		const job = tail.length === 3 && tail[0] === "jobs" && tail[2] === "log"
			? run.jobs.find((j) => j.jobId === tail[1])
			: undefined;
		if (!job) return error(404, "not_found", "no such job");
		return json({
			runId,
			jobId: job.jobId,
			text: JOB_LOGS[`${runId}/${job.jobId}`] ?? "",
			truncated: false,
			live: job.state === "running" || job.state === "pending",
		});
	}
	const land = req.path === "/-/api/why" || req.path === "/-/api/blame" ||
		req.path === "/-/api/advances" || req.path.startsWith("/-/api/advances/");
	if (!land) return null;
	if (req.path === "/-/api/blame") {
		return error(501, "not_implemented", "why-blame is not available yet");
	}
	const repo = req.nodes.find((n) => n.path === q("repo"));
	if (q("repo") === "") return error(400, "invalid", "repo is required");
	if (!repo || repo.kind !== "repo") {
		return error(404, "not_found", `no repo at ${q("repo")}`);
	}
	const mine = repo.id === REPO_ID;
	if (req.path === "/-/api/why") {
		const sha = q("sha");
		const path = q("path");
		if ((sha === "") === (path === "")) {
			return error(400, "invalid", "give exactly one of sha and path");
		}
		const found = mine &&
			(sha !== "" ? WHY.commit.startsWith(sha) : WHY_PATHS.has(path));
		return found
			? json(WHY)
			: error(404, "not_found", "no landing answers this");
	}
	const batchId = req.path.slice("/-/api/advances/".length);
	if (req.path.startsWith("/-/api/advances/")) {
		const batch = mine ? BATCHES.find((b) => b.batchId === batchId) : undefined;
		return batch ? json(batch) : error(404, "not_found", `no batch ${batchId}`);
	}
	const { items, cursor } = page(
		mine ? ADVANCES : [],
		q("cursor"),
		q("limit"),
	);
	const body: AdvancesResponse = {
		advances: items,
		...(cursor ? { cursor } : {}),
	};
	return json(body);
};

/**
 * The mock extension's answer to an action, when it mirrors the real one
 * (else the server's generic toast): `tartan.work`'s `new-work` header
 * action navigates to the repo's Work tab.
 */
export const mockActionResult = (
	extId: string,
	action: unknown,
	ctx: SlotCtxHint,
): ActionResponse | null =>
	extId === "tartan.work" && action === "new-work" && ctx.node !== undefined
		? { v: 1, navigate: `/${ctx.node}/-/work` }
		: null;
