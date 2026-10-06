// Live: lanes are per-agent Artifacts repositories created with `import()`,
// with branch lanes as the fallback. The stage runs with `--lane-mode
// import`, so every lane an
// agent opens is a `repo` lane reached through its lane remote
// `/<repo>/-/lanes/<laneId>.git`.
//
// One shared setup per instance (support/shared.ts): a Swarm repo where
// agents A and B each open a lane and push it once through its lane remote
// with stock git. Every check is its own test over that setup:
//
// - the lane is its own repository, seeded by import() (API, MCP and UI);
// - its remote clones, pushes, force-pushes and leases with stock git, and a
//   lane push never touches the canonical repository (the upstream scope);
// - the lane-remote table, each row by its `ng` reason and the ref it did not
//   move (L0–L5, another agent, anonymous and member reads);
// - the Owner's self-test through the real capability route, and forged,
//   expired and malformed capability URLs answered with a uniform 404;
// - two lane repositories landing through one Advance (multi-repo compose),
//   and a push while a lane lands (L2);
// - the Owner's branch override: the next lane is a branch lane, and
//   clearing it returns to import().
//
// The stage must run repo lanes (`stage up --lane-mode import`); on any other
// stage every test skips with the reason.

import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect } from "e2e";
import type { Change, LaneHandle } from "@tartan/contract/interfaces.ts";
import type {
	AdvancesResponse,
	InstallationsResponse,
	LandBatchDto,
	LaneSelfTestResult,
} from "@tartan/contract/api.ts";
import type { LaneMode } from "@tartan/contract/lanes.ts";
import type { RepoConfigStateDto } from "@tartan/contract/repoconfig.ts";
import type { RefPolicyReason } from "@tartan/contract/security.ts";
import { type AgentName, scriptedAgent } from "../../support/agent.ts";
import { sharedStore, test } from "../../support/fixtures.ts";
import {
	COMPOSE_FIXTURE,
	FIXTURE_HEAD,
	FIXTURE_SHAS,
} from "../../support/fixture-repo.ts";
import { refusedWith } from "../../support/gateway.ts";
import { gitHttp, ok, pageApi, query } from "../../support/http.ts";
import {
	anonymousAdvertisement,
	BRANCH_BACKEND,
	BRANCH_MODE,
	gitClone,
	IMPORT_SEED,
	LANE_MAIN,
	laneHttpPath,
	laneOf,
	laneRemotePath,
	laneSettingsOf,
	lanesOf,
	ngReason,
	ownerApi,
	receivePackBody,
	REPO_BACKEND,
	repoLanesByDefault,
	setLaneMode,
} from "../../support/lanes.ts";
import { PACK_GROUP } from "../../support/names.ts";
import {
	expectApiClean,
	fetchMatching,
	trackFetches,
	watchApi,
} from "../../support/page.ts";
import { fixtureRepo } from "../../support/repos.ts";
import { keyOf, sharedDirOf } from "../../support/shared.ts";
import { type Stage, tokensOf } from "../../support/stage.ts";

// `ng` reasons, checked against the contract by `deno task check`.
const R = {
	reservedParent: "reserved-parent",
	caseCollision: "case-collision",
	notYours: "not-your-lane",
	closed: "lane-closed",
	landing: "lane-landing",
	mainOnly: "lane-main-only",
	close: "use-lanes-close",
	stale: "stale-old",
	agentsLanes: "agents-lanes-only",
} as const satisfies Readonly<Record<string, RefPolicyReason>>;
const LANDED: Change["state"] = "landed";
const EJECTED: Change["state"] = "ejected";
const LANDING_LANE = "landing";
const CURRENT: RepoConfigStateDto["status"] = "current";
const NEEDS_APPLY: RepoConfigStateDto["status"] = "needs-apply";
const FAILED: RepoConfigStateDto["status"] = "failed";
const MIN = 60_000;

const skipUnlessRepoLanes = (stage: Stage) =>
	test.skip(
		!repoLanesByDefault(stage),
		"the stage runs branch lanes: deploy it with `stage up --lane-mode import`",
	);

type LaneRef = {
	readonly id: string;
	readonly remote: string;
	readonly base: string;
	readonly head: string;
};
type Setup = {
	readonly repo: {
		readonly path: string;
		readonly id: string;
		readonly remote: string;
	};
	readonly lanes: Readonly<Record<AgentName, LaneRef>>;
};

const agentToken = (stage: Stage, name: AgentName) =>
	name === "A"
		? tokensOf(stage).developerAgent
		: tokensOf(stage).developerAgentB;

const scratchOf = (stage: Stage, label: string) =>
	path.join(sharedDirOf(tmpdir(), stage.runId), `scratch-${label}`);

/**
 * Agent `name` opens a lane on `repoPath`, waits until it is open, starts it
 * from the lane remote in a clone of the canonical repo, commits one file
 * and pushes it with the handle's own commands.
 */
const openAndPush = async (
	stage: Stage,
	repo: { readonly path: string; readonly remote: string },
	name: AgentName,
	workdir: string,
	label: string,
): Promise<LaneRef> => {
	const agent = scriptedAgent(stage, PACK_GROUP.swarm, name);
	const { lane: first } = await agent.mcp.call<{ lane: LaneHandle }>(
		"lanes_open",
		{ repo: repo.path, purpose: `repo lanes: ${label}` },
	);
	const lane = await agent.awaitOpen(repo.path, first);
	const clone = await agent.clone(path.join(workdir, label), repo.remote);
	await agent.runLane(lane.git.start, clone);
	await writeFile(path.join(clone, `${label}.txt`), `${label}\n`);
	const head = await agent.commit(clone, `repo lanes: ${label}`);
	await agent.runLane(lane.git.push, clone);
	return { id: lane.id, remote: lane.remote, base: lane.base, head };
};

/** One shared setup per instance: A and B each open a lane and push it once. */
const setupOf = (stage: Stage, index: number): Promise<Setup> =>
	sharedStore().once(`lanes-${index}-setup`, async (): Promise<Setup> => {
		const suite = index === 0 ? "lanes" : `lanes-${index}`;
		const repo = await fixtureRepo(stage, "swarm", suite);
		const scratch = scratchOf(stage, suite);
		const lanes = {} as Record<AgentName, LaneRef>;
		for (const name of ["A", "B"] as const) {
			lanes[name] = await openAndPush(
				stage,
				repo,
				name,
				scratch,
				`lane-${name}`,
			);
		}
		return {
			repo: { path: repo.path, id: repo.id, remote: repo.remote },
			lanes,
		};
	});

const setupFor = async (stage: Stage, title: string): Promise<Setup> =>
	setupOf(stage, await sharedStore().claimIndex(`claim-lanes-${keyOf(title)}`));

const T = {
	ownRepo:
		"an agent's lane is its own Artifacts repository, created with import()",
	stockGit:
		"the lane remote clones, pushes, force-pushes and leases with stock git",
	upstream:
		"a lane push never reaches the canonical repository (the upstream scope)",
	agentsLanes:
		"an agent with repo lanes only cannot push the canonical repository",
	l0: "L0: a reserved parent or a case variant of main on a lane remote",
	l1: "L1: a push to a closed lane's remote is lane-closed",
	l3stale: "L3: a stale old on a lane remote is stale-old",
	l3other: "L3: another agent's push to a lane remote is not-your-lane",
	l4: "L4: deleting main of a lane remote is use-lanes-close",
	l5: "L5: any other ref of a lane remote is lane-main-only",
	views:
		"lane remotes have no public view; members read them, only the owner writes",
	selftest:
		"the Owner's lane self-test seeds a lane repo through the real capability route",
	forged:
		"forged, expired and malformed capability URLs get the same plain 404",
	fallback:
		"the Owner's branch override gives the next lane a branch lane; clearing it returns to import()",
} as const;

test.describe("repo lanes: per-agent Artifacts repositories", {
	tags: ["lanes", "m2", "m2-lanes", "git", "regression"],
	session: "developer",
}, () => {
	test(
		T.ownRepo,
		{ tags: ["agent", "mcp", "smoke"], timeout: 300_000 },
		async ({
			app,
			browser,
			stage,
		}) => {
			skipUnlessRepoLanes(stage);
			const s = await setupFor(stage, T.ownRepo);
			// API: each lane is a `repo` lane seeded by import(), with its own
			// remote and `refs/heads/main` at the pushed head.
			const lanes = await lanesOf(stage, s.repo.path);
			for (const name of ["A", "B"] as const) {
				const mine = s.lanes[name];
				const lane = lanes.find((l) => l.id === mine.id);
				expect(lane, `lane ${name} is listed`).toBeDefined();
				expect(lane!.mode).toBe(REPO_BACKEND);
				expect(lane!.seed).toBe(IMPORT_SEED);
				expect(lane!.seedMs, "the seed took a measured time").toBeGreaterThan(
					0,
				);
				expect(lane!.ref).toBe(LANE_MAIN);
				expect(lane!.remote).toBe(laneRemotePath(s.repo.path, mine.id));
				expect(lane!.base).toBe(FIXTURE_HEAD);
				expect(lane!.head).toBe(mine.head);
				expect(mine.remote).toBe(
					`${stage.origin}${laneRemotePath(s.repo.path, mine.id)}`,
				);
			}
			expect(
				lanes.find((l) => l.id === s.lanes.A.id)!.owner,
				"A and B own their own lanes",
			).not.toBe(lanes.find((l) => l.id === s.lanes.B.id)!.owner);
			// MCP: the handle an agent works from names the lane remote.
			const a = scriptedAgent(stage, PACK_GROUP.swarm, "A");
			const { lane: handle } = await a.mcp.call<{ lane: LaneHandle }>(
				"lanes_get",
				{ repo: s.repo.path, laneId: s.lanes.A.id },
			);
			expect(handle.mode).toBe(REPO_BACKEND);
			expect(handle.remote).toBe(s.lanes.A.remote);
			expect(handle.git?.push).toBe(
				`git push ${s.lanes.A.remote} HEAD:${LANE_MAIN}`,
			);
			// UI: the lane page says it is its own repository seeded by import().
			await app.open(`/${s.repo.path}/-/lanes/${s.lanes.A.id}`);
			await watchApi(browser);
			const detail = browser.locator(
				'section[aria-labelledby="lane-detail-title"]',
			);
			await expect(browser.locator("#lane-detail-title")).toHaveText(
				s.lanes.A.id,
			);
			await expect(detail).toContainText(
				`Its own repository, seeded by ${IMPORT_SEED}`,
			);
			await expect(
				browser.locator('section[aria-labelledby="lane-detail-title"] dd code')
					.filter({ hasText: "/-/lanes/" }),
			).toHaveText(laneRemotePath(s.repo.path, s.lanes.A.id));
			await expectApiClean(browser);
		},
	);

	test(T.stockGit, { tags: ["agent"], timeout: 300_000 }, async ({
		stage,
		workdir,
	}) => {
		skipUnlessRepoLanes(stage);
		const s = await setupFor(stage, T.stockGit);
		// A lane of its own, so the shared lanes never move.
		const lane = await openAndPush(stage, s.repo, "A", workdir, "stock");
		const c = await gitClone(
			stage,
			workdir,
			agentToken(stage, "A"),
			lane.remote,
			"lane",
		);
		// A clone of the lane remote is the lane: main at its head, nothing else.
		expect((await c.runOk(["rev-parse", "HEAD"])).trim()).toBe(lane.head);
		const refs = (await c.runOk(["ls-remote", "origin"])).split("\n")
			.filter((l) => l !== "").map((l) => l.split("\t")[1]);
		expect(refs.filter((r) => r !== "HEAD")).toEqual([LANE_MAIN]);
		// A fast-forward.
		const ff = await c.commit("ff");
		await c.runOk(["push", "-q", "origin", `HEAD:${LANE_MAIN}`]);
		expect(await c.remoteHead(LANE_MAIN)).toBe(ff);
		// A forced rewrite.
		await c.runOk(["reset", "-q", "--hard", "HEAD~1"]);
		const forced = await c.commit("forced");
		await c.runOk(["push", "-q", "--force", "origin", `HEAD:${LANE_MAIN}`]);
		expect(await c.remoteHead(LANE_MAIN)).toBe(forced);
		// --force-with-lease naming the current head.
		await c.runOk(["reset", "-q", "--hard", "HEAD~1"]);
		const leased = await c.commit("leased");
		await c.runOk([
			"push",
			"-q",
			`--force-with-lease=${LANE_MAIN}:${forced}`,
			"origin",
			`HEAD:${LANE_MAIN}`,
		]);
		expect(await c.remoteHead(LANE_MAIN)).toBe(leased);
		// The kernel recorded every push as the lane's head.
		await expect.poll(
			async () => (await laneOf(stage, s.repo.path, lane.id)).head,
			{ timeout: 30_000, message: "the lane's recorded head" },
		).toBe(leased);
	});

	test(T.upstream, { tags: ["agent"], timeout: 300_000 }, async ({
		stage,
		workdir,
	}) => {
		skipUnlessRepoLanes(stage);
		const s = await setupFor(stage, T.upstream);
		// The canonical repository is untouched by both lanes' pushes: trunk
		// is the fixture's, no lane ref exists there, and no canonical ref
		// names a lane's head.
		const o = await gitClone(
			stage,
			workdir,
			tokensOf(stage).ownerPat,
			s.repo.remote,
			"canonical",
		);
		expect(await o.remoteHead("refs/heads/main")).toBe(FIXTURE_HEAD);
		const listed = (await o.runOk(["ls-remote", "origin"])).split("\n")
			.filter((l) => l !== "");
		for (const name of ["A", "B"] as const) {
			expect(listed.filter((l) => l.includes(s.lanes[name].id))).toEqual([]);
			expect(listed.filter((l) => l.startsWith(s.lanes[name].head)))
				.toEqual([]);
		}
		// Advisory: the canonical remote does not serve A's lane head when a
		// member asks for it by SHA. That alone does not prove the object is
		// absent (a server may refuse an unadvertised want); the refs above
		// are the proof that nothing on the canonical remote names it.
		const fetched = await o.run([
			"-c",
			"protocol.version=2",
			"fetch",
			"-q",
			"origin",
			s.lanes.A.head,
		]);
		expect(fetched.code, "the canonical remote serves no lane head").not
			.toBe(0);
	});

	test(T.agentsLanes, { tags: ["agent"], timeout: 300_000 }, async ({
		stage,
		workdir,
	}) => {
		skipUnlessRepoLanes(stage);
		const s = await setupFor(stage, T.agentsLanes);
		// The canonical write precheck: an agent whose only lanes are
		// repo lanes has no write path to the canonical repo at all.
		const c = await gitClone(
			stage,
			workdir,
			agentToken(stage, "A"),
			s.repo.remote,
			"canonical",
		);
		await c.commit("canonical");
		const ref = "refs/heads/lanes-agent-branch";
		const pushed = await c.run(["push", "origin", `HEAD:${ref}`]);
		expect(pushed.code).not.toBe(0);
		expect(
			refusedWith(pushed.stdout + pushed.stderr, ref, R.agentsLanes),
			pushed.stderr,
		).toBe(true);
		expect(await c.remoteHead(ref)).toBeNull();
	});

	for (
		const [title, ref, reason] of [
			[T.l0, "refs/heads/lanes", R.reservedParent],
			[T.l0, "refs/heads/Main", R.caseCollision],
			[T.l5, "refs/heads/feature", R.mainOnly],
			[T.l5, "refs/tags/lane-tag", R.mainOnly],
			[T.l5, "refs/notes/lane", R.mainOnly],
		] as const
	) {
		test(`${title} (${ref})`, { tags: ["agent"], timeout: 300_000 }, async ({
			stage,
			workdir,
		}) => {
			skipUnlessRepoLanes(stage);
			const s = await setupFor(stage, `${title} (${ref})`);
			const lane = s.lanes.A;
			const c = await gitClone(
				stage,
				workdir,
				agentToken(stage, "A"),
				lane.remote,
				"lane",
			);
			await c.commit("refused");
			const pushed = await c.run(["push", "origin", `HEAD:${ref}`]);
			expect(pushed.code, "the push fails").not.toBe(0);
			expect(
				refusedWith(pushed.stdout + pushed.stderr, ref, reason),
				`${ref} refused with ${reason}:\n${pushed.stderr}`,
			).toBe(true);
			expect(await c.remoteHead(ref), `${ref} was not created`).toBeNull();
			expect(await c.remoteHead(LANE_MAIN), "main did not move").toBe(
				lane.head,
			);
		});
	}

	test(T.l1, { tags: ["agent"], timeout: 300_000 }, async ({
		stage,
		workdir,
	}) => {
		skipUnlessRepoLanes(stage);
		const s = await setupFor(stage, T.l1);
		const lane = await openAndPush(stage, s.repo, "B", workdir, "closing");
		const c = await gitClone(
			stage,
			workdir,
			agentToken(stage, "B"),
			lane.remote,
			"lane",
		);
		const b = scriptedAgent(stage, PACK_GROUP.swarm, "B");
		await b.mcp.call("lanes_close", {
			repo: s.repo.path,
			laneId: lane.id,
			reason: "repo lanes: L1",
		});
		await c.commit("after-close");
		const pushed = await c.run(["push", "origin", `HEAD:${LANE_MAIN}`]);
		expect(pushed.code).not.toBe(0);
		expect(
			refusedWith(pushed.stdout + pushed.stderr, LANE_MAIN, R.closed),
			`refused with ${R.closed}:\n${pushed.stderr}`,
		).toBe(true);
		expect((await laneOf(stage, s.repo.path, lane.id)).head).toBe(lane.head);
	});

	test(T.l3stale, { tags: ["agent", "stale-old"], timeout: 300_000 }, async ({
		stage,
	}) => {
		skipUnlessRepoLanes(stage);
		const s = await setupFor(stage, T.l3stale);
		const lane = s.lanes.A;
		// A command whose old is the lane's base, not its head: the gateway
		// refuses it before anything is forwarded (stock git cannot send a
		// stale old: it reads the advertisement first).
		const answer = await gitHttp(
			stage.origin,
			agentToken(stage, "A"),
			laneHttpPath(s.repo.path, lane.id),
			{
				kind: "post",
				service: "git-receive-pack",
				body: receivePackBody({
					old: lane.base,
					new: FIXTURE_SHAS[0],
					ref: LANE_MAIN,
				}),
			},
		);
		expect(ngReason(answer.text, LANE_MAIN), `HTTP ${answer.status}`).toBe(
			R.stale,
		);
		expect(answer.text).not.toMatch(/\bok refs\/heads\/main\b/);
		expect((await laneOf(stage, s.repo.path, lane.id)).head).toBe(lane.head);
	});

	test(T.l3other, { tags: ["agent"], timeout: 300_000 }, async ({
		stage,
		workdir,
	}) => {
		skipUnlessRepoLanes(stage);
		const s = await setupFor(stage, T.l3other);
		const lane = s.lanes.A;
		// B reads A's lane (a member), and its push to A's remote is refused.
		const c = await gitClone(
			stage,
			workdir,
			agentToken(stage, "B"),
			lane.remote,
			"other",
		);
		expect((await c.runOk(["rev-parse", "HEAD"])).trim()).toBe(lane.head);
		await c.commit("not-mine");
		const pushed = await c.run(["push", "origin", `HEAD:${LANE_MAIN}`]);
		expect(pushed.code).not.toBe(0);
		expect(
			refusedWith(pushed.stdout + pushed.stderr, LANE_MAIN, R.notYours),
			`refused with ${R.notYours}:\n${pushed.stderr}`,
		).toBe(true);
		expect((await laneOf(stage, s.repo.path, lane.id)).head).toBe(lane.head);
	});

	test(T.l4, { tags: ["agent"], timeout: 300_000 }, async ({
		stage,
		workdir,
	}) => {
		skipUnlessRepoLanes(stage);
		const s = await setupFor(stage, T.l4);
		const lane = s.lanes.B;
		const c = await gitClone(
			stage,
			workdir,
			agentToken(stage, "B"),
			lane.remote,
			"lane",
		);
		const pushed = await c.run(["push", "origin", `:${LANE_MAIN}`]);
		expect(pushed.code).not.toBe(0);
		expect(
			refusedWith(pushed.stdout + pushed.stderr, LANE_MAIN, R.close),
			`deletion refused with ${R.close}:\n${pushed.stderr}`,
		).toBe(true);
		expect(await c.remoteHead(LANE_MAIN)).toBe(lane.head);
	});

	test(
		T.views,
		{ tags: ["agent", "reporter", "anonymous"], timeout: 300_000 },
		async ({
			stage,
			workdir,
		}) => {
			skipUnlessRepoLanes(stage);
			const s = await setupFor(stage, T.views);
			const lane = s.lanes.A;
			const at = laneHttpPath(s.repo.path, lane.id);
			// Anonymous: 401 on both services, whatever the repo's visibility.
			for (const service of ["git-upload-pack", "git-receive-pack"] as const) {
				const anon = await anonymousAdvertisement(stage.origin, at, service);
				expect(anon.status, `anonymous ${service}`).toBe(401);
			}
			// A Reporter (member view) reads the lane…
			const r = await gitClone(
				stage,
				workdir,
				tokensOf(stage).reporterPat,
				lane.remote,
				"reporter",
			);
			expect((await r.runOk(["rev-parse", "HEAD"])).trim()).toBe(lane.head);
			// …but cannot ask to write it (receive-pack needs a Developer).
			const reporterWrite = await gitHttp(
				stage.origin,
				tokensOf(stage).reporterPat,
				at,
				{ kind: "advertisement", service: "git-receive-pack" },
			);
			expect(reporterWrite.status, "a Reporter's receive-pack").toBe(403);
			// Another agent (a Developer) gets the empty receive-pack
			// advertisement: no lane-repo write token is minted for anyone but the
			// lane's owner or a delegate.
			const adv = await gitHttp(stage.origin, agentToken(stage, "B"), at, {
				kind: "advertisement",
				service: "git-receive-pack",
			});
			expect(adv.status).toBe(200);
			expect(adv.text).not.toContain(lane.head);
			// The owner's own receive-pack advertisement names its head.
			const own = await gitHttp(stage.origin, agentToken(stage, "A"), at, {
				kind: "advertisement",
				service: "git-receive-pack",
			});
			expect(own.status).toBe(200);
			expect(own.text).toContain(lane.head);
		},
	);

	test("a lane-pinned token on another lane's remote", {
		tags: ["pending"],
		skip:
			"pending: no route mints a lane-pinned token yet (tokens.lane_id is always null); the gateway's policy tests cover the rule",
	}, async () => {});
});

test.describe("repo lanes: the capability route and the Owner's switches", {
	tags: ["lanes", "m2", "m2-lanes", "regression", "owner"],
	session: "owner",
}, () => {
	test(T.selftest, { tags: ["smoke"], timeout: 300_000 }, async ({
		app,
		browser,
		screen,
		stage,
	}) => {
		skipUnlessRepoLanes(stage);
		// Through the Settings page, signed in as the forge Owner: the
		// self-test opens a scratch lane repo with import() from a
		// capability URL on the canonical origin, behind the real middleware.
		await app.open("/-/settings");
		await watchApi(browser);
		await trackFetches(browser);
		const started = Date.now();
		await screen.getByRole("button", "Run the self-test").tap();
		const post = await fetchMatching(
			browser,
			(f) => f.method === "POST" && f.path === "/-/api/admin/selftest/lanes",
			{ timeout: 120_000, message: "the self-test's POST to answer" },
		);
		expect(post.status).toBe(200);
		await expect(browser.locator(".selftest--ok")).toContainText(
			`Per-agent lane repos work (seeded with ${IMPORT_SEED}`,
			{ timeout: 30_000 },
		);
		// The stored result reads back: this run's, passed, seeded by import().
		const last = ok(
			"GET",
			"/-/api/admin/selftest/lanes",
			await pageApi(browser).get<{ last?: LaneSelfTestResult | null }>(
				"/-/api/admin/selftest/lanes",
			),
		).last;
		expect(last?.ok, `self-test code ${last?.code ?? "none"}`).toBe(true);
		expect(last?.seed).toBe(IMPORT_SEED);
		expect(last?.at ?? 0).toBeGreaterThanOrEqual(started - 60_000);
		await expectApiClean(browser);
	});

	test(T.forged, { tags: ["capability"], timeout: 120_000 }, async ({
		stage,
	}) => {
		skipUnlessRepoLanes(stage);
		const s = await setupFor(stage, T.forged);
		const now = Math.floor(Date.now() / 1000);
		const hex = (n: number) =>
			[...crypto.getRandomValues(new Uint8Array(n))].map((b) =>
				b.toString(16).padStart(2, "0")
			).join("");
		const cap = (exp: number, op: string, lane = s.lanes.A.id) =>
			`/-/cap/v1/${exp}/${lane}/${hex(16)}/${hex(32)}/${s.repo.id}.git/${op}`;
		const probes = [
			// A real lane and repo with a fresh expiry and a forged MAC.
			cap(now + 60, "info/refs?service=git-upload-pack"),
			cap(now + 60, "git-upload-pack"),
			// An expired one.
			cap(now - 60, "info/refs?service=git-upload-pack"),
			// receive-pack is never served there.
			cap(now + 60, "git-receive-pack"),
			// A malformed lane id.
			cap(now + 60, "info/refs?service=git-upload-pack", "LN_NOT_A_LANE"),
		];
		const statuses: number[] = [];
		const send = (probe: string) =>
			fetch(`${stage.origin}${probe}`, {
				method: probe.endsWith("info/refs?service=git-upload-pack")
					? "GET"
					: "POST",
				redirect: "manual",
				signal: AbortSignal.timeout(30_000),
			});
		for (const probe of probes) {
			const r = await send(probe);
			const body = await r.text();
			// 404 with no detail; 429 once this address's failure bucket is
			// full (20 a minute), never anything that reveals more.
			expect([404, 429], `${probe.split("/").slice(0, 4).join("/")}…`)
				.toContain(r.status);
			expect(body).toBe("");
			statuses.push(r.status);
		}
		// The plain 404 itself is what this proves. If this address's failure
		// bucket was already full (parallel repeats), wait it out once.
		if (!statuses.includes(404)) {
			await new Promise((resolve) => setTimeout(resolve, 61_000));
			const again = await send(probes[0]);
			expect(await again.text()).toBe("");
			statuses.push(again.status);
		}
		expect(statuses, `statuses ${statuses.join(", ")}`).toContain(404);
	});

	test(T.fallback, { tags: ["lane-settings"], timeout: 600_000 }, async ({
		stage,
		workdir,
	}) => {
		skipUnlessRepoLanes(stage);
		const index = await sharedStore().claimIndex(
			`claim-lanes-${keyOf(T.fallback)}`,
		);
		const repo = await fixtureRepo(
			stage,
			"swarm",
			index === 0 ? "lanes-fallback" : `lanes-fallback-${index}`,
		);
		// The Owner keeps this repo on branch lanes (the fallback backend).
		const set = await setLaneMode(stage, repo.id, BRANCH_MODE);
		expect(set.laneMode).toBe(BRANCH_MODE);
		expect(set.effectiveMode).toBe(BRANCH_MODE);
		const branch = await openAndPush(stage, repo, "A", workdir, "branch");
		const b = await laneOf(stage, repo.path, branch.id);
		expect(b.mode).toBe(BRANCH_BACKEND);
		expect(b.seed).toBeUndefined();
		expect(b.ref).toBe(`refs/heads/lanes/${branch.id}`);
		expect(b.remote).toBe(`/${repo.path}.git`);
		// Clearing the override returns new lanes to the forge default.
		const cleared = await setLaneMode(stage, repo.id, null);
		expect(cleared.effectiveMode).not.toBe(BRANCH_MODE);
		expect((await laneSettingsOf(stage, repo.id)).laneMode).toBe(
			stage.switches.laneMode as LaneMode,
		);
		const back = await openAndPush(stage, repo, "A", workdir, "import");
		const r = await laneOf(stage, repo.path, back.id);
		expect(r.mode).toBe(REPO_BACKEND);
		expect(r.seed).toBe(IMPORT_SEED);
		// The branch lane is untouched by the switch.
		expect((await laneOf(stage, repo.path, branch.id)).mode).toBe(
			BRANCH_BACKEND,
		);
	});

	test("the seeder falls back to branch lanes when import() is refused", {
		tags: ["pending"],
		skip:
			"pending: no dev tool makes import() refuse on a live forge; the seeder's fallback to branch lanes and its breaker are covered by the repo-backend tests",
	}, async () => {});
});

// ---------------------------------------------------------------------------
// Landing: two lane repositories in one Advance, and a push while landing
// ---------------------------------------------------------------------------

type Compose = {
	readonly repo: { readonly path: string; readonly id: string };
	readonly lanes: Readonly<Record<AgentName, LaneRef>>;
	readonly changes: Readonly<Record<AgentName, string>>;
};

/** The Swarm group's Weave installation (the queue@1 provider in force). */
const weaveAt = async (
	browser: Parameters<typeof pageApi>[0],
	node: string,
): Promise<string> => {
	const at = `/-/api/installations?${query({ node })}`;
	const list = ok(
		"GET",
		"/-/api/installations",
		await pageApi(browser).get<InstallationsResponse>(at),
	);
	const weave = list.installations.find((i) =>
		i.installation.extId === "tartan.weave"
	);
	if (weave === undefined) {
		throw new Error(`no tartan.weave in force at ${node}`);
	}
	return weave.installation.id;
};

/**
 * A repo whose package tartan overlays the Swarm group's Weave with a long
 * debounce, so the first approved change waits for the second and both land
 * through one Advance composed from two lane repositories.
 */
const composeOf = (
	stage: Stage,
	index: number,
	browser: Parameters<typeof pageApi>[0],
): Promise<Compose> =>
	sharedStore().once(`lanes-${index}-compose`, async (): Promise<Compose> => {
		const page = pageApi(browser);
		// The Owner lets repositories overlay the group's Weave settings.
		const weave = await weaveAt(browser, PACK_GROUP.swarm);
		const opt = `/-/api/installations/${
			encodeURIComponent(weave)
		}/repo-overrides`;
		const on = await page.send("PUT", opt, { on: true });
		if (on.status >= 300) {
			throw new Error(`repo overrides on the Weave: HTTP ${on.status}`);
		}
		const suite = index === 0 ? "lanes-compose" : `lanes-compose-${index}`;
		const repo = await fixtureRepo(stage, "swarm", suite, COMPOSE_FIXTURE);
		// Trunk's config (the overlay) evaluated; a Maintainer applies it.
		const at = `/-/api/repos/${encodeURIComponent(repo.id)}/config`;
		let state: RepoConfigStateDto | null = null;
		await expect.poll(async () => {
			state = ok("GET", at, await ownerApi(stage).get<RepoConfigStateDto>(at));
			if (state.status === FAILED) {
				throw new Error(
					`the compose repo's package tartan failed: ${
						state.failure?.code ?? "?"
					}`,
				);
			}
			return state.status === CURRENT || state.status === NEEDS_APPLY;
		}, { timeout: 4 * MIN, message: "trunk's config to evaluate" }).toBe(true);
		if (state!.status === NEEDS_APPLY) {
			const applied = await page.send("POST", `${at}/apply`, {
				sha: state!.trunkSha,
			});
			if (applied.status >= 300) {
				throw new Error(`apply: HTTP ${applied.status}`);
			}
			await expect.poll(
				async () =>
					ok("GET", at, await ownerApi(stage).get<RepoConfigStateDto>(at))
						.status,
				{ timeout: 4 * MIN, message: "the apply" },
			).toBe(
				CURRENT,
			);
		}
		const scratch = scratchOf(stage, suite);
		const lanes = {} as Record<AgentName, LaneRef>;
		const changes = {} as Record<AgentName, string>;
		for (const name of ["A", "B"] as const) {
			lanes[name] = await openAndPush(
				stage,
				repo,
				name,
				scratch,
				`compose-${name}`,
			);
		}
		for (const name of ["A", "B"] as const) {
			const agent = scriptedAgent(stage, PACK_GROUP.swarm, name);
			const submitted = await agent.mcp.call<{ changeId: string }>(
				"changes_submit",
				{
					repo: repo.path,
					laneId: lanes[name].id,
					title: `compose ${name} (${stage.runId}/${index})`,
					summary: `One file from lane ${name}.`,
				},
			);
			changes[name] = submitted.changeId;
		}
		return { repo: { path: repo.path, id: repo.id }, lanes, changes };
	});

test.describe("repo lanes: landing", {
	tags: ["lanes", "m2", "m2-lanes", "containers", "land", "regression"],
	session: "owner",
}, () => {
	test(
		"two agents' lane repositories land on trunk through one Advance (multi-repo compose)",
		{ tags: ["agent", "owner"], timeout: 30 * MIN },
		async ({ app, browser, stage }) => {
			skipUnlessRepoLanes(stage);
			test.skip(
				!stage.containers,
				"landing needs CI and the Advance, which run in containers",
			);
			await app.open("/-/settings");
			const index = await sharedStore().claimIndex(
				`claim-lanes-compose-${stage.runId}`,
			);
			const c = await composeOf(stage, index, browser);
			const a = scriptedAgent(stage, PACK_GROUP.swarm, "A");
			const landed = {} as Record<AgentName, string>;
			for (const name of ["A", "B"] as const) {
				await expect.poll(async () => {
					const change = await a.mcp.call<Change>("changes_get", {
						repo: c.repo.path,
						changeId: c.changes[name],
					});
					if (change.state === EJECTED) {
						throw new Error(`change ${name} was ejected`);
					}
					if (change.state === LANDED) landed[name] = change.landedCommit!;
					return change.state;
				}, {
					timeout: 25 * MIN,
					interval: 5_000,
					message: `change ${name} to land`,
				}).toBe(LANDED);
			}
			// One land batch holds both changes, from both lane repositories.
			const advances = ok(
				"GET",
				"/-/api/advances",
				await ownerApi(stage).get<AdvancesResponse>(
					`/-/api/advances?${query({ repo: c.repo.path, limit: "20" })}`,
				),
			);
			const batches: LandBatchDto[] = [];
			for (const advance of advances.advances) {
				batches.push(ok(
					"GET",
					"/-/api/advances/<batchId>",
					await ownerApi(stage).get<LandBatchDto>(
						`/-/api/advances/${encodeURIComponent(advance.batchId)}?${
							query({ repo: c.repo.path })
						}`,
					),
				));
			}
			const both = batches.find((b) =>
				[c.lanes.A.id, c.lanes.B.id].every((id) =>
					b.changes.some((ch) => ch.laneId === id && ch.outcome === "landed")
				)
			);
			expect(
				both,
				`one batch landed both lanes (batches: ${
					batches.map((b) =>
						`${b.batchId.slice(0, 10)}:${
							b.changes.map((ch) => `${ch.laneId.slice(-6)}=${ch.outcome}`)
								.join("+")
						}`
					).join(", ")
				})`,
			).toBeDefined();
			// Trunk carries both lanes' files.
			for (const name of ["A", "B"] as const) {
				const tree = await ownerApi(stage).get<{ entries: { name: string }[] }>(
					`/-/api/tree?${query({ repo: c.repo.path, ref: "main", path: "" })}`,
				);
				expect(
					ok("GET", "/-/api/tree", tree).entries.map((e) => e.name),
				).toContain(`compose-${name}.txt`);
				expect(landed[name]).toMatch(/^[0-9a-f]{40}$/);
			}
		},
	);

	test(
		"L2: a push to a lane remote while its lane lands is lane-landing",
		{ tags: ["agent"], timeout: 20 * MIN },
		async ({ stage, workdir }) => {
			skipUnlessRepoLanes(stage);
			test.skip(
				!stage.containers,
				"landing needs CI and the Advance, which run in containers",
			);
			const index = await sharedStore().claimIndex(
				`claim-lanes-landing-${stage.runId}`,
			);
			const repo = await fixtureRepo(
				stage,
				"swarm",
				index === 0 ? "lanes-landing" : `lanes-landing-${index}`,
			);
			const lane = await openAndPush(stage, repo, "A", workdir, "landing");
			const c = await gitClone(
				stage,
				workdir,
				agentToken(stage, "A"),
				lane.remote,
				"lane",
			);
			const agent = scriptedAgent(stage, PACK_GROUP.swarm, "A");
			await agent.mcp.call("changes_submit", {
				repo: repo.path,
				laneId: lane.id,
				title: `repo lanes L2 ${stage.runId}`,
				summary: "A one-line file.",
			});
			await expect.poll(async () => {
				const state = (await laneOf(stage, repo.path, lane.id)).state;
				if (state === "landed" || state === "closed") {
					throw new Error(
						`the lane went ${state} before a push could hit the landing window`,
					);
				}
				return state;
			}, {
				timeout: 15 * MIN,
				interval: 500,
				message: "the lane never started landing",
			}).toBe(LANDING_LANE);
			await c.commit("late");
			const pushed = await c.run(["push", "origin", `HEAD:${LANE_MAIN}`]);
			expect(pushed.code).not.toBe(0);
			expect(
				refusedWith(pushed.stdout + pushed.stderr, LANE_MAIN, R.landing),
				`refused with ${R.landing}:\n${pushed.stderr}`,
			).toBe(true);
		},
	);
});
