// Repository config in CUE, end to end. Every root `*.cue` file of
// package `tartan` configures the repo: the pipeline (`tartan.ci`), the
// owners rules (`tartan.review`) and the projects. The CUE suite's repo
// (`CUE_FIXTURE`) splits them across `tartan.cue`, `ci.cue` and `review.cue`,
// with another tool's `env.cue` (package cuenv) beside them.
//
// One flow per instance, in stages shared by the tests (support/shared.ts):
//
//   repo     the Owner's PAT imports the fixture; trunk's config evaluates
//            and a Maintainer (the Owner, in the browser) applies it when
//            it needs an apply;
//   ci       agent A changes src/: its CI run is the pipeline's jobs, and
//            review leaves it to the review provider (no owners rule);
//   docs     agent B changes docs/: the owners rule routes it to a person;
//   policy   agent A changes ci.cue (a new job): the lane's preview plans it,
//            the change needs a sign-off (K13.3), and trunk's pipeline does
//            not have the job yet;
//   signed   the Owner signs the policy change off on the change page's Repo
//            config card and approves it; it lands, and only then does
//            trunk's pipeline carry the new job;
//   revoked  agent B changes ci.cue again; the Owner signs off, revokes, and
//            approves: the land is refused for the missing sign-off;
//   invalid  agent A's lane breaks package tartan: the preview reports the
//            error with its file and line; trunk keeps its config.
//
// Not here, with reasons: the boot row of a repo that existed before the
// switch (needs a redeploy that turns repo config on) and the 30-minute
// config-hold failure (K9).

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { type App, expect, type Screen } from "e2e";
import type { Browser } from "@e2e-dev/web";
import type {
	Change,
	LaneHandle,
	Review,
} from "@tartan/contract/interfaces.ts";
import type {
	EventsResponse,
	RunDto,
	RunsResponse,
} from "@tartan/contract/api.ts";
import type {
	RepoConfigPreviewDto,
	RepoConfigStateDto,
} from "@tartan/contract/repoconfig.ts";
import type { DeniedReason } from "@tartan/contract/errors.ts";
import { type AgentName, scriptedAgent } from "../../support/agent.ts";
import { sharedStore, test } from "../../support/fixtures.ts";
import {
	CUE_FIXTURE,
	CUE_JOBS,
	CUE_OWNED,
	CUE_PROJECT,
	CUE_ROOT_FILES,
	cueCi,
} from "../../support/fixture-repo.ts";
import { ok, pageApi, query, tokenApi } from "../../support/http.ts";
import {
	APPROVE_LABEL,
	assessedReview,
	REVIEW_PANEL,
} from "../../support/loop.ts";
import { PACK_GROUP } from "../../support/names.ts";
import { expectApiClean, watchApi } from "../../support/page.ts";
import { fixtureRepo } from "../../support/repos.ts";
import { keyOf, sharedDirOf } from "../../support/shared.ts";
import { type Stage, tokensOf } from "../../support/stage.ts";

const CURRENT: RepoConfigStateDto["status"] = "current";
const NEEDS_APPLY: RepoConfigStateDto["status"] = "needs-apply";
const PREVIEW_OK: RepoConfigPreviewDto["status"] = "ok";
const PREVIEW_ERROR: RepoConfigPreviewDto["status"] = "error";
const PREVIEW_EVALUATING: RepoConfigPreviewDto["status"] = "evaluating";
const HUMAN: Review["route"] = "human";
const APPROVE: NonNullable<Review["decision"]> = "approve";
const LANDED: Change["state"] = "landed";
const RUN_SUCCESS: RunDto["state"] = "success";
const MIN = 60_000;
/** The K13.3 refusal (`DENIED_REASONS`), named by `land.vetoed.code` and `queue.ejected.code`. */
const POLICY_SIGNOFF: DeniedReason = "policy-signoff";
/** The job the policy change adds, and the one the revoked change would. */
const EXTRA_JOB = "e2e-extra";
const REVOKED_JOB = "e2e-revoked";
/** The line of the broken `tartan.cue` holding the type error. */
const BROKEN_LINE = 4;
const CARD = 'section[data-kernel="repo-config"]';

type Ui = {
	readonly app: App;
	readonly screen: Screen;
	readonly browser: Browser;
};

type RepoOutcome = {
	readonly path: string;
	readonly id: string;
	readonly status: string;
	readonly applied: boolean;
	readonly rootFiles: readonly string[];
	readonly jobs: readonly string[];
	readonly ownerPaths: readonly string[];
	readonly projects: readonly string[];
};
type Submitted = {
	readonly laneId: string;
	readonly head: string;
	readonly changeId: string;
};

const owner = (stage: Stage) =>
	tokenApi(stage.origin, tokensOf(stage).ownerPat);
const configAt = (repoId: string) =>
	`/-/api/repos/${encodeURIComponent(repoId)}/config`;

const stateOf = async (stage: Stage, repoId: string) =>
	ok(
		"GET",
		"/-/api/repos/<id>/config",
		await owner(stage).get<RepoConfigStateDto>(configAt(repoId)),
	);

const jobsOf = (s: RepoConfigStateDto): string[] =>
	Object.keys(
		((s.policy.pipeline ?? {}) as { jobs?: Record<string, unknown> }).jobs ??
			{},
	).sort();

/** Agent `name` opens a lane, writes `files`, pushes and submits. */
const pushAndSubmit = async (
	stage: Stage,
	repo: { readonly path: string },
	name: AgentName,
	label: string,
	files: Readonly<Record<string, string>>,
): Promise<Submitted> => {
	const agent = scriptedAgent(stage, PACK_GROUP.swarm, name);
	const { lane: first } = await agent.mcp.call<{ lane: LaneHandle }>(
		"lanes_open",
		{ repo: repo.path, purpose: `cue config: ${label}` },
	);
	const lane = await agent.awaitOpen(repo.path, first);
	const clone = await agent.clone(
		path.join(sharedDirOf(tmpdir(), stage.runId), `scratch-cue-${label}`),
		`${stage.origin}/${repo.path}.git`,
	);
	await agent.runLane(lane.git.start, clone);
	for (const [file, text] of Object.entries(files)) {
		const target = path.join(clone, ...file.split("/"));
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, text);
	}
	const head = await agent.commit(clone, `cue config: ${label}`);
	await agent.runLane(lane.git.push, clone);
	const { changeId } = await agent.mcp.call<{ changeId: string }>(
		"changes_submit",
		{
			repo: repo.path,
			laneId: lane.id,
			title: `cue config ${label} (${stage.runId})`,
			summary: `The ${label} change.`,
		},
	);
	return { laneId: lane.id, head, changeId };
};

/** A lane's config preview once it is no longer evaluating. */
const previewOf = async (
	stage: Stage,
	repoId: string,
	laneId: string,
): Promise<RepoConfigPreviewDto> => {
	const at = `/-/api/repos/${encodeURIComponent(repoId)}/lanes/${
		encodeURIComponent(laneId)
	}/config`;
	let preview: RepoConfigPreviewDto | null = null;
	await expect.poll(async () => {
		const reply = await owner(stage).get<RepoConfigPreviewDto>(at);
		preview = reply.status === 200 ? reply.body : null;
		return preview !== null && preview.status !== PREVIEW_EVALUATING;
	}, {
		timeout: 4 * MIN,
		interval: 3_000,
		message: "the lane's config preview",
	}).toBe(true);
	return preview!;
};

const review = (stage: Stage, repoPath: string, changeId: string) =>
	scriptedAgent(stage, PACK_GROUP.swarm, "A").mcp.call<Review>("review_get", {
		repo: repoPath,
		changeId,
	});

const assessed = (
	stage: Stage,
	repoPath: string,
	changeId: string,
	timeout = 15 * MIN,
): Promise<Review> =>
	assessedReview(() => review(stage, repoPath, changeId), timeout);

const changeState = async (stage: Stage, repoPath: string, changeId: string) =>
	(await scriptedAgent(stage, PACK_GROUP.swarm, "A").mcp.call<Change>(
		"changes_get",
		{ repo: repoPath, changeId },
	)).state;

const repoEvents = async (stage: Stage, repoId: string, types: string) =>
	ok(
		"GET",
		"/-/api/events",
		await owner(stage).get<EventsResponse>(
			`/-/api/events?${query({ repo: repoId, types, limit: "500" })}`,
		),
	).events;

/** The Owner approves a change routed to a person, on its change page. */
const approveInUi = async (
	ui: Ui,
	stage: Stage,
	repoPath: string,
	changeId: string,
): Promise<void> => {
	expect(
		(await assessed(stage, repoPath, changeId)).route,
		"review routed the change to a person (after CI)",
	).toBe(HUMAN);
	await ui.app.open(`/${repoPath}/-/changes/${changeId}`);
	const approve = ui.browser.locator(REVIEW_PANEL).getByRole(
		"button",
		APPROVE_LABEL,
	);
	await expect(approve).toBeVisible({ timeout: 30_000 });
	await approve.tap();
	await expect.poll(
		async () => (await review(stage, repoPath, changeId)).decision,
		{ timeout: 60_000, message: "the approval" },
	).toBe(APPROVE);
};

const flowOf = (stage: Stage, index: number) => {
	const store = sharedStore();
	const key = (s: string) => `cue-${index}-${s}`;

	const repo = (ui: Ui): Promise<RepoOutcome> =>
		store.once(key("repo"), async (): Promise<RepoOutcome> => {
			const r = await fixtureRepo(
				stage,
				"swarm",
				index === 0 ? "cue" : `cue-${index}`,
				CUE_FIXTURE,
			);
			let state: RepoConfigStateDto | null = null;
			await expect.poll(async () => {
				state = await stateOf(stage, r.id);
				if (!state.enabled) return "disabled";
				return state.status === CURRENT || state.status === NEEDS_APPLY
					? "evaluated"
					: state.status;
			}, {
				timeout: 5 * MIN,
				interval: 3_000,
				message: "trunk's package tartan to evaluate",
			}).toMatch(/^(?:evaluated|disabled)$/);
			let applied = false;
			if (state!.enabled && state!.status === NEEDS_APPLY) {
				await ui.app.open(`/${r.path}/-/settings/extensions`);
				const reply = await pageApi(ui.browser).send(
					"POST",
					`${configAt(r.id)}/apply`,
					{ sha: state!.trunkSha },
				);
				if (reply.status >= 300) throw new Error(`apply: HTTP ${reply.status}`);
				applied = true;
				await expect.poll(async () => (await stateOf(stage, r.id)).status, {
					timeout: 4 * MIN,
					message: "the apply",
				}).toBe(CURRENT);
				state = await stateOf(stage, r.id);
			}
			const s = state!;
			const owners = s.policy.owners as
				| { rules?: { paths?: string[] }[] }
				| undefined;
			return {
				path: r.path,
				id: r.id,
				status: s.enabled ? s.status : "disabled",
				applied,
				rootFiles: s.rootFiles.map((f) => f.name).sort(),
				jobs: jobsOf(s),
				ownerPaths: (owners?.rules ?? []).flatMap((x) => x.paths ?? []),
				projects: Object.keys(
					(s.policy.projects ?? {}) as Record<string, unknown>,
				).sort(),
			};
		});

	const ci = (ui: Ui) =>
		store.once(key("ci"), async () => {
			const r = await repo(ui);
			const sub = await pushAndSubmit(stage, r, "A", `src-${index}`, {
				"src/app.ts": `export const app = "e2e ${stage.runId}";\n`,
			});
			let run: RunDto | undefined;
			await expect.poll(async () => {
				const runs = ok(
					"GET",
					"/-/api/runs/<repoId>",
					await owner(stage).get<RunsResponse>(
						`/-/api/runs/${encodeURIComponent(r.id)}`,
					),
				).runs;
				run = runs.find((x) =>
					x.subject?.id === sub.changeId && x.state === RUN_SUCCESS
				);
				return run !== undefined;
			}, {
				timeout: 15 * MIN,
				interval: 5_000,
				message: "the change's CI run to succeed",
			}).toBe(true);
			const decided = await assessed(stage, r.path, sub.changeId, 5 * MIN);
			return {
				...sub,
				jobs: run!.jobs.map((j) => j.jobId).sort(),
				route: decided.route,
			};
		});

	const docs = (ui: Ui) =>
		store.once(key("docs"), async () => {
			const r = await repo(ui);
			const sub = await pushAndSubmit(stage, r, "B", `docs-${index}`, {
				"docs/guide.md": `# Guide\n\nHow the e2e app works (${stage.runId}).\n`,
			});
			const decided = await assessed(stage, r.path, sub.changeId);
			return { ...sub, route: decided.route, factors: decided.factors };
		});

	const policy = (ui: Ui) =>
		store.once(key("policy"), async () => {
			const r = await repo(ui);
			await ci(ui);
			const sub = await pushAndSubmit(stage, r, "A", `policy-${index}`, {
				"ci.cue": cueCi([...CUE_JOBS, EXTRA_JOB]),
			});
			const preview = await previewOf(stage, r.id, sub.laneId);
			const trunk = await stateOf(stage, r.id);
			return {
				...sub,
				previewStatus: preview.status,
				policyTouched: preview.policyTouched,
				plan: preview.plan.map((l) => l.text),
				signedOff: preview.signoff !== undefined,
				trunkJobsBefore: jobsOf(trunk),
			};
		});

	const signed = (ui: Ui) =>
		store.once(key("signed"), async () => {
			const r = await repo(ui);
			const p = await policy(ui);
			// The Owner signs the policy change off on its change page.
			await ui.app.open(`/${r.path}/-/changes/${p.changeId}`);
			const card = ui.browser.locator(CARD);
			await expect(card).toBeVisible({ timeout: 30_000 });
			await card.getByRole("button", "Approve policy change").tap();
			await expect(card).toContainText("approved", { timeout: 30_000 });
			const preview = await previewOf(stage, r.id, p.laneId);
			await approveInUi(ui, stage, r.path, p.changeId);
			await expect.poll(() => changeState(stage, r.path, p.changeId), {
				timeout: 20 * MIN,
				interval: 5_000,
				message: "the signed-off policy change to land",
			}).toBe(LANDED);
			let after: string[] = [];
			await expect.poll(async () => {
				const s = await stateOf(stage, r.id);
				after = jobsOf(s);
				return s.status === CURRENT && after.includes(EXTRA_JOB);
			}, {
				timeout: 6 * MIN,
				interval: 3_000,
				message: "trunk's pipeline to carry the new job after the land",
			}).toBe(true);
			return {
				signoffHead: preview.signoff?.head ?? null,
				signedBy: preview.signoff?.signedBy ?? null,
				head: p.head,
				trunkJobsAfter: after,
			};
		});

	const revoked = (ui: Ui) =>
		store.once(key("revoked"), async () => {
			const r = await repo(ui);
			await signed(ui);
			const sub = await pushAndSubmit(stage, r, "B", `revoked-${index}`, {
				"ci.cue": cueCi([...CUE_JOBS, EXTRA_JOB, REVOKED_JOB]),
			});
			await previewOf(stage, r.id, sub.laneId);
			await ui.app.open(`/${r.path}/-/changes/${sub.changeId}`);
			const card = ui.browser.locator(CARD);
			await expect(card).toBeVisible({ timeout: 30_000 });
			await card.getByRole("button", "Approve policy change").tap();
			await expect(card).toContainText("approved", { timeout: 30_000 });
			await card.getByRole("button", "Revoke sign-off").tap();
			await expect(card).toContainText("sign-off pending", {
				timeout: 30_000,
			});
			await approveInUi(ui, stage, r.path, sub.changeId);
			// The K13.3 check refuses it either at land.submit (the queue ejects
			// the change: queue.ejected with code policy-signoff) or, for a
			// revocation after the submit, at the K5 lock (land.vetoed with code
			// policy-signoff). Either way the event names the refusal, so an
			// ejection for anything else (CI, a conflict) is not taken for it.
			let code = "";
			await expect.poll(async () => {
				const refused = (await repoEvents(
					stage,
					r.id,
					"land.vetoed,queue.ejected",
				)).filter((e) =>
					(e.data as { changeId?: string }).changeId === sub.changeId
				);
				const veto = refused.find((e) => e.type === "land.vetoed");
				const ejected = refused.find((e) => e.type === "queue.ejected");
				code = veto !== undefined
					? `land.vetoed:${(veto.data as { code?: string }).code ?? "?"}`
					: ejected !== undefined
					? `queue.ejected:${
						(ejected.data as { code?: string; reason?: string }).code ??
							(ejected.data as { reason?: string }).reason ?? "?"
					}`
					: "";
				return code !== "";
			}, {
				timeout: 20 * MIN,
				interval: 5_000,
				message: "the land to be refused for the missing sign-off",
			}).toBe(true);
			const types = (await repoEvents(
				stage,
				r.id,
				"repo.policy.approved,repo.policy.revoked",
			)).filter((e) => (e.data as { laneId?: string }).laneId === sub.laneId)
				.map((e) => e.type);
			return {
				changeId: sub.changeId,
				code,
				state: await changeState(stage, r.path, sub.changeId),
				events: types,
				trunkJobs: jobsOf(await stateOf(stage, r.id)),
			};
		});

	const invalid = (ui: Ui) =>
		store.once(key("invalid"), async () => {
			const r = await repo(ui);
			const sub = await pushAndSubmit(stage, r, "A", `invalid-${index}`, {
				"tartan.cue": [
					"package tartan",
					"",
					"// A project root must be a string.",
					`projects: ${CUE_PROJECT}: root: 42`,
					"",
				].join("\n"),
			});
			const preview = await previewOf(stage, r.id, sub.laneId);
			const trunk = await stateOf(stage, r.id);
			return {
				...sub,
				previewStatus: preview.status,
				positions: preview.issues.flatMap((i) => i.pos),
				trunkStatus: trunk.status,
				trunkProjects: Object.keys(
					(trunk.policy.projects ?? {}) as Record<string, unknown>,
				),
			};
		});

	return { repo, ci, docs, policy, signed, revoked, invalid };
};

const flowFor = async (stage: Stage, title: string) =>
	flowOf(stage, await sharedStore().claimIndex(`claim-cue-${keyOf(title)}`));

const skipUnlessConfig = (stage: Stage) => {
	test.skip(
		!stage.containers,
		"the CUE evaluator and CI run in containers (the stage was deployed with --no-containers)",
	);
	test.skip(
		!stage.switches.repoConfig,
		"repository config is off on this stage (stage up deploys with --repo-config)",
	);
};

const T = {
	settings:
		"trunk's package tartan is evaluated: the settings page shows the state, the root files and the repo policy",
	ci: "CI is planned from the tartan.ci pipeline in the config",
	owners: "review owners from tartan.review route a docs change to a person",
	preview:
		"a lane that changes package tartan is previewed with its plan and needs a sign-off (K13.3)",
	signed:
		"a signed-off policy change lands, and trunk's pipeline changes only after the land (K13)",
	revoked:
		"a revoked sign-off ejects the policy change at land time; trunk keeps its pipeline",
	invalid:
		"an invalid package tartan in a lane shows its error with file and line; trunk keeps its config",
} as const;

test.describe("repository config in CUE", {
	tags: ["cue-config", "m2", "containers", "regression", "owner"],
	session: "owner",
}, () => {
	test(T.settings, { tags: ["ui", "smoke"], timeout: 10 * MIN }, async ({
		app,
		screen,
		browser,
		stage,
	}) => {
		skipUnlessConfig(stage);
		await app.open("/");
		const flow = await flowFor(stage, T.settings);
		const r = await flow.repo({ app, screen, browser });
		expect([CURRENT, NEEDS_APPLY]).toContain(r.status);
		expect(r.rootFiles).toEqual([...CUE_ROOT_FILES]);
		expect(r.jobs).toEqual([...CUE_JOBS].sort());
		expect(r.ownerPaths).toEqual([CUE_OWNED]);
		expect(r.projects).toEqual([CUE_PROJECT]);
		// UI: Repository settings → Extensions.
		await app.open(`/${r.path}/-/settings/extensions`);
		await watchApi(browser);
		await expect(
			browser.locator('section[aria-labelledby="config-state"] [data-status]'),
		).toHaveText(CURRENT, { timeout: 20_000 });
		const state = screen.getByRole("region", "State");
		for (const file of CUE_ROOT_FILES) {
			await expect(state.getByRole("link", file)).toBeVisible();
		}
		const policy = screen.getByRole("region", "Repo policy");
		for (const job of CUE_JOBS) await expect(policy).toContainText(job);
		await expect(policy).toContainText(CUE_OWNED);
		await expect(policy).toContainText(CUE_PROJECT);
		await expectApiClean(browser);
	});

	test(T.ci, { tags: ["agent", "runs"], timeout: 20 * MIN }, async ({
		app,
		screen,
		browser,
		stage,
	}) => {
		skipUnlessConfig(stage);
		await app.open("/");
		const flow = await flowFor(stage, T.ci);
		const c = await flow.ci({ app, screen, browser });
		for (const job of CUE_JOBS) {
			expect(
				c.jobs.some((j) =>
					j === job || j.endsWith(`/${job}`) || j.startsWith(`${job}`)
				),
				`a job ${job} in ${c.jobs.join(", ")}`,
			).toBe(true);
		}
		// No owners rule covers src/: review did not route it to a person.
		expect(c.route).not.toBe(HUMAN);
	});

	test(T.owners, { tags: ["agent", "review"], timeout: 20 * MIN }, async ({
		app,
		screen,
		browser,
		stage,
	}) => {
		skipUnlessConfig(stage);
		await app.open("/");
		const flow = await flowFor(stage, T.owners);
		const d = await flow.docs({ app, screen, browser });
		expect(d.route).toBe(HUMAN);
		const r = await flow.repo({ app, screen, browser });
		await app.open(`/${r.path}/-/changes/${d.changeId}`);
		await expect(
			browser.locator(REVIEW_PANEL).getByRole("button", APPROVE_LABEL),
		).toBeVisible({ timeout: 30_000 });
	});

	test(T.preview, { tags: ["agent", "k13", "ui"], timeout: 30 * MIN }, async ({
		app,
		screen,
		browser,
		stage,
	}) => {
		skipUnlessConfig(stage);
		await app.open("/");
		const flow = await flowFor(stage, T.preview);
		const p = await flow.policy({ app, screen, browser });
		expect(p.previewStatus).toBe(PREVIEW_OK);
		expect(p.policyTouched).toBe(true);
		expect(p.plan.join("\n")).toContain(EXTRA_JOB);
		expect(p.signedOff, "no sign-off yet").toBe(false);
		expect(p.trunkJobsBefore, "trunk has not changed yet").not.toContain(
			EXTRA_JOB,
		);
		// UI: the change page's Repo config card.
		const r = await flow.repo({ app, screen, browser });
		await app.open(`/${r.path}/-/changes/${p.changeId}`);
		const card = browser.locator(CARD);
		await expect(card).toContainText("human (K13)", { timeout: 30_000 });
		await expect(card).toContainText(EXTRA_JOB);
	});

	test(
		T.signed,
		{ tags: ["agent", "k13", "ui", "land"], timeout: 45 * MIN },
		async ({
			app,
			screen,
			browser,
			stage,
		}) => {
			skipUnlessConfig(stage);
			await app.open("/");
			const flow = await flowFor(stage, T.signed);
			const s = await flow.signed({ app, screen, browser });
			expect(s.signoffHead, "the sign-off is bound to the change head").toBe(
				s.head,
			);
			expect(s.signedBy).not.toBeNull();
			expect(s.trunkJobsAfter).toContain(EXTRA_JOB);
		},
	);

	test(
		T.revoked,
		{ tags: ["agent", "k13", "ui", "land"], timeout: 75 * MIN },
		async ({
			app,
			screen,
			browser,
			stage,
		}) => {
			skipUnlessConfig(stage);
			await app.open("/");
			const flow = await flowFor(stage, T.revoked);
			const v = await flow.revoked({ app, screen, browser });
			expect([
				`land.vetoed:${POLICY_SIGNOFF}`,
				`queue.ejected:${POLICY_SIGNOFF}`,
			]).toContain(v.code);
			expect(v.state).not.toBe(LANDED);
			expect(v.events).toEqual(
				expect.arrayContaining(["repo.policy.approved", "repo.policy.revoked"]),
			);
			expect(v.trunkJobs).not.toContain(REVOKED_JOB);
		},
	);

	test(T.invalid, { tags: ["agent", "k9"], timeout: 20 * MIN }, async ({
		app,
		screen,
		browser,
		stage,
	}) => {
		skipUnlessConfig(stage);
		await app.open("/");
		const flow = await flowFor(stage, T.invalid);
		const i = await flow.invalid({ app, screen, browser });
		expect(i.previewStatus).toBe(PREVIEW_ERROR);
		expect(
			i.positions.some((p) => p.startsWith(`tartan.cue:${BROKEN_LINE}:`)),
			`an issue at tartan.cue:${BROKEN_LINE} (got ${i.positions.join(", ")})`,
		).toBe(true);
		expect(i.trunkStatus, "trunk keeps its config").toBe(CURRENT);
		expect(i.trunkProjects).toEqual([CUE_PROJECT]);
		// UI: the card lists the error with its position.
		const r = await flow.repo({ app, screen, browser });
		await app.open(`/${r.path}/-/changes/${i.changeId}`);
		await expect(browser.locator(`${CARD} ul[aria-label="CUE errors"]`))
			.toContainText(`tartan.cue:${BROKEN_LINE}`, { timeout: 30_000 });
	});

	test(
		"the boot row of a repo that predates the switch, then needs-apply and an apply",
		{
			tags: ["pending"],
			skip:
				"pending: needs a redeploy that turns repo config on under existing repos (a forge that switches it on later); the M1 loop's step 1 covers needs-apply and the apply",
		},
		async () => {},
	);

	test(
		"a batch held over 30 minutes returns to its queue with config-hold (K9)",
		{
			tags: ["pending"],
			skip:
				"pending: a 30-minute hold per run is too long for the e2e tier; the land workflow's tests cover config-hold",
		},
		async () => {},
	);
});
