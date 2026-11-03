// Repository config in CUE, end to end. Every root `*.cue` file of
// package `tartan` configures the repo; with no extension installed, that is
// the kernel's own part (the projects). The CUE suite's repo (`CUE_FIXTURE`)
// holds a `tartan.cue`, with another tool's `env.cue` (package cuenv) beside
// it.
//
// One flow per instance, in stages shared by the tests (support/shared.ts):
//
//   repo     the Owner's PAT imports the fixture; trunk's config evaluates
//            and a Maintainer (the Owner, in the browser) applies it when
//            it needs an apply;
//   policy   agent A's lane adds a project to tartan.cue: the lane's preview
//            evaluates it, marks it as touching repo policy (K13.3) with no
//            sign-off, and trunk's projects do not change;
//   invalid  agent B's lane breaks package tartan: the preview reports the
//            error with its file and line; trunk keeps its config.
//
// Not here, with reasons: the sign-off and land of a policy change (this
// branch removed the change and queue extensions that submit and land a
// lane), the boot row of a repo that existed before the switch (needs a
// redeploy that turns repo config on) and the 30-minute config-hold failure
// (K9).

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { type App, expect, type Screen } from "e2e";
import type { Browser } from "@e2e-dev/web";
import type { LaneHandle } from "@tartan/contract/interfaces.ts";
import type {
	RepoConfigPreviewDto,
	RepoConfigStateDto,
} from "@tartan/contract/repoconfig.ts";
import { type AgentName, scriptedAgent } from "../../support/agent.ts";
import { sharedStore, test } from "../../support/fixtures.ts";
import {
	CUE_FIXTURE,
	CUE_PROJECT,
	CUE_ROOT_FILES,
	tartanCue,
} from "../../support/fixture-repo.ts";
import { ok, pageApi, tokenApi } from "../../support/http.ts";
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
const MIN = 60_000;
/** The project the policy change adds. */
const EXTRA_PROJECT = "docs";
/** The line of the broken `tartan.cue` holding the type error. */
const BROKEN_LINE = 4;

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
	readonly projects: readonly string[];
};
type Pushed = {
	readonly laneId: string;
	readonly head: string;
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

const projectsOf = (s: RepoConfigStateDto): string[] =>
	Object.keys((s.policy.projects ?? {}) as Record<string, unknown>).sort();

/** Agent `name` opens a lane, writes `files` and pushes. */
const pushToLane = async (
	stage: Stage,
	repo: { readonly path: string },
	name: AgentName,
	label: string,
	files: Readonly<Record<string, string>>,
): Promise<Pushed> => {
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
	return { laneId: lane.id, head };
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
			return {
				path: r.path,
				id: r.id,
				status: s.enabled ? s.status : "disabled",
				applied,
				rootFiles: s.rootFiles.map((f) => f.name).sort(),
				projects: projectsOf(s),
			};
		});

	const policy = (ui: Ui) =>
		store.once(key("policy"), async () => {
			const r = await repo(ui);
			const sub = await pushToLane(stage, r, "A", `policy-${index}`, {
				"tartan.cue": tartanCue("Two projects: the app and its docs.", {
					[CUE_PROJECT]: "src",
					[EXTRA_PROJECT]: "docs",
				}),
			});
			const preview = await previewOf(stage, r.id, sub.laneId);
			const trunk = await stateOf(stage, r.id);
			return {
				...sub,
				previewStatus: preview.status,
				policyTouched: preview.policyTouched,
				signedOff: preview.signoff !== undefined,
				trunkProjects: projectsOf(trunk),
			};
		});

	const invalid = (ui: Ui) =>
		store.once(key("invalid"), async () => {
			const r = await repo(ui);
			const sub = await pushToLane(stage, r, "B", `invalid-${index}`, {
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
				trunkProjects: projectsOf(trunk),
			};
		});

	return { repo, policy, invalid };
};

const flowFor = async (stage: Stage, title: string) =>
	flowOf(stage, await sharedStore().claimIndex(`claim-cue-${keyOf(title)}`));

const skipUnlessConfig = (stage: Stage) => {
	test.skip(
		!stage.containers,
		"the CUE evaluator runs in containers (the stage was deployed with --no-containers)",
	);
	test.skip(
		!stage.switches.repoConfig,
		"repository config is off on this stage (stage up deploys with --repo-config)",
	);
};

const T = {
	settings:
		"trunk's package tartan is evaluated: the settings page shows the state, the root files and the repo policy",
	preview:
		"a lane that changes package tartan is previewed, touches repo policy and has no sign-off yet (K13.3)",
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
		await expect(policy).toContainText(CUE_PROJECT);
		await expectApiClean(browser);
	});

	test(T.preview, { tags: ["agent", "k13"], timeout: 20 * MIN }, async ({
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
		expect(p.signedOff, "no sign-off yet").toBe(false);
		expect(p.trunkProjects, "trunk has not changed").toEqual([CUE_PROJECT]);
	});

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
	});

	test(
		"a signed-off policy change lands, and a revoked sign-off is refused at land time (K13)",
		{
			tags: ["pending"],
			skip:
				"pending: landing a lane needs a change and a queue provider, and this branch has no extension that provides them",
		},
		async () => {},
	);

	test(
		"the boot row of a repo that predates the switch, then needs-apply and an apply",
		{
			tags: ["pending"],
			skip:
				"pending: needs a redeploy that turns repo config on under existing repos (a forge that switches it on later)",
		},
		async () => {},
	);
});
