// Live: the global event log on Cloudflare K2. Every committed forge and
// repo event is relayed, in
// `seq` order per Durable Object, into the stage's stream
// `tartan_<stage>_log`; the `workloads` consumer reads it and dispatches CI
// runs. The stage runs with `--k2` and the Secrets Store consume token, and
// with `--workload-transport k2`, so a push's CI run is dispatched from the
// log, with an inline backstop.
//
// - the relay: the forge's events reach the stream in order and the relay
//   catches up after new events (`GET /-/api/log/status`, the Owner);
// - a lane push's CI run is requested through the log and dispatched by the
//   K2 consumer, and the run says so (API and the Run page);
// - the Owner's Global log tile on Settings, and nobody else reads the log;
// - no dead letters parked during the run;
// - the inline backstop with the bus paused needs the dev key: pending.

import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect } from "e2e";
import type { LaneHandle } from "@tartan/contract/interfaces.ts";
import type {
	LogDeadListResponse,
	LogStatusResponse,
	RunDto,
	RunsResponse,
} from "@tartan/contract/api.ts";
import type { ErrorCode } from "@tartan/contract/errors.ts";
import { scriptedAgent } from "../../support/agent.ts";
import { sharedStore, test } from "../../support/fixtures.ts";
import { ok, pageApi, tokenApi } from "../../support/http.ts";
import { PACK_GROUP } from "../../support/names.ts";
import { expectApiClean, watchApi } from "../../support/page.ts";
import { fixtureRepo, importModeRepo } from "../../support/repos.ts";
import { keyOf, sharedDirOf } from "../../support/shared.ts";
import { type Stage, tokensOf } from "../../support/stage.ts";

const K2 = "k2";
const OK = "ok";
const DENIED: ErrorCode = "denied";
const MIN = 60_000;

/** The start of the run's minute: `r<yyyymmddhhmm><hex>` (UTC), less a minute. */
const runStartedAt = (runId: string): number => {
	const m = /^r(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(runId);
	if (m === null) throw new Error(`not a run id: ${runId}`);
	const [, y, mo, d, h, mi] = m.map(Number);
	return Date.UTC(y, mo - 1, d, h, mi) - MIN;
};

/** `tartan_<stage>_log` (`logStreamName`). */
const streamOf = (stage: string): string =>
	`tartan_${stage.replaceAll("-", "_")}_log`;

const skipUnlessK2 = (stage: Stage) =>
	test.skip(
		!stage.switches.k2,
		"the stage has no global log: deploy it with `stage up --k2 --k2-token-store … --k2-token-secret …`",
	);

const skipUnlessK2Dispatch = (stage: Stage) =>
	test.skip(
		stage.switches.workloadTransport !== K2 || !stage.switches.k2Token,
		"runs dispatch inline on this stage: deploy it with `--workload-transport k2` and the consume token",
	);

/** The Owner's (browser session's) view of the log. */
const statusOf = async (
	browser: Parameters<typeof pageApi>[0],
): Promise<LogStatusResponse> =>
	ok(
		"GET",
		"/-/api/log/status",
		await pageApi(browser).get<LogStatusResponse>("/-/api/log/status"),
	);

type Dispatched = {
	readonly repo: { readonly path: string; readonly id: string };
	readonly changeId: string;
	readonly runId: string;
	readonly transport: string;
	readonly via: string | null;
	readonly lagMs: number | null;
};

/**
 * One lane push and submit on a Swarm repo whose package tartan runs CI on
 * submit, and the run it starts, once it has been dispatched.
 */
const dispatchedOf = (stage: Stage, index: number): Promise<Dispatched> =>
	sharedStore().once(`k2-${index}-dispatch`, async (): Promise<Dispatched> => {
		const repo = await fixtureRepo(
			stage,
			"swarm",
			index === 0 ? "k2" : `k2-${index}`,
		);
		const agent = scriptedAgent(stage, PACK_GROUP.swarm, "A");
		const { lane: first } = await agent.mcp.call<{ lane: LaneHandle }>(
			"lanes_open",
			{ repo: repo.path, purpose: "global log: a run dispatched from K2" },
		);
		const lane = await agent.awaitOpen(repo.path, first);
		const dir = path.join(
			sharedDirOf(tmpdir(), stage.runId),
			`scratch-k2-${index}`,
		);
		const clone = await agent.clone(dir, repo.remote);
		await agent.runLane(lane.git.start, clone);
		await writeFile(path.join(clone, "k2.txt"), `${stage.runId}\n`);
		await agent.commit(clone, "global log: one file");
		await agent.runLane(lane.git.push, clone);
		const { changeId } = await agent.mcp.call<{ changeId: string }>(
			"changes_submit",
			{
				repo: repo.path,
				laneId: lane.id,
				title: `global log ${stage.runId}/${index}`,
				summary: "One file; its CI run is dispatched from the global log.",
			},
		);
		const owner = tokenApi(stage.origin, tokensOf(stage).ownerPat);
		let run: RunDto | undefined;
		await expect.poll(async () => {
			const runs = ok(
				"GET",
				"/-/api/runs/<repoId>",
				await owner.get<RunsResponse>(
					`/-/api/runs/${encodeURIComponent(repo.id)}`,
				),
			);
			run = runs.runs.find((r) => r.subject?.id === changeId);
			return run?.via !== undefined;
		}, {
			timeout: 5 * MIN,
			interval: 2_000,
			message: "the change's CI run to be created and dispatched",
		}).toBe(true);
		return {
			repo: { path: repo.path, id: repo.id },
			changeId,
			runId: run!.runId,
			transport: run!.transport ?? "",
			via: run!.via ?? null,
			lagMs: run!.dispatchedAt === undefined
				? null
				: run!.dispatchedAt - run!.createdAt,
		};
	});

const dispatchedFor = async (stage: Stage, title: string) =>
	dispatchedOf(
		stage,
		await sharedStore().claimIndex(`claim-k2-${keyOf(title)}`),
	);

const T = {
	relay: "the forge's events are relayed to the K2 stream in sequence",
	dispatch:
		"a lane push's CI run is dispatched from the global log, with the transport recorded as k2",
	runPage: "the Run page says the run came through the global log",
	tile:
		"the Owner's Global log tile shows the stream, the relay and dispatches",
	dead: "the global log parks no dead letter during the run",
	refused: "only the forge Owner reads the global log",
	backstop: "with the bus paused, a run is dispatched by the inline backstop",
} as const;

test.describe("the global log on K2", {
	tags: ["k2", "m2", "regression", "owner"],
	session: "owner",
}, () => {
	test(T.relay, { tags: ["smoke"], timeout: 5 * MIN }, async ({
		app,
		browser,
		stage,
	}) => {
		skipUnlessK2(stage);
		await app.open("/-/settings");
		const before = await statusOf(browser);
		expect(before.health).toBe(OK);
		expect(before.stream).toEqual({
			configured: true,
			name: streamOf("dev-e2e"),
		});
		const relay = before.relay.forge;
		expect(relay, "the forge's relay reports").not.toBeNull();
		expect(relay!.state).toBe(OK);
		expect(relay!.relayedSeq).toBeLessThanOrEqual(relay!.head);
		// New forge events (a repo node is created): the relay follows them in
		// order and catches up.
		const index = await sharedStore().claimIndex(
			`claim-k2-${keyOf(T.relay)}`,
		);
		await importModeRepo(
			stage,
			"swarm",
			index === 0 ? "k2-relay" : `k2-relay-${index}`,
		);
		const seen: number[] = [relay!.relayedSeq];
		await expect.poll(async () => {
			const now = (await statusOf(browser)).relay.forge!;
			seen.push(now.relayedSeq);
			return now.head > relay!.head && now.relayedSeq === now.head &&
				now.epoch === relay!.epoch;
		}, {
			timeout: 2 * MIN,
			interval: 2_000,
			message: "the relay to catch up with the new forge events",
		}).toBe(true);
		// In sequence: the relayed position never goes back.
		expect(seen).toEqual([...seen].sort((a, b) => a - b));
		const after = (await statusOf(browser)).relay.forge!;
		expect(after.sentRecords).toBeGreaterThan(relay!.sentRecords);
	});

	test(
		T.dispatch,
		{ tags: ["containers", "agent", "runs"], timeout: 10 * MIN },
		async ({
			app,
			browser,
			stage,
		}) => {
			skipUnlessK2(stage);
			skipUnlessK2Dispatch(stage);
			test.skip(!stage.containers, "CI runs need containers");
			await app.open("/-/settings");
			const before = await statusOf(browser);
			const d = await dispatchedFor(stage, T.dispatch);
			expect(d.transport, "the run's recorded transport").toBe(K2);
			expect(d.via, "dispatched by the K2 consumer, not the backstop").toBe(K2);
			expect(d.lagMs, "creation to dispatch").not.toBeNull();
			// The consumer counted it: K2 dispatches in the last hour went up.
			const after = await statusOf(browser);
			expect(after.transport).toBe(K2);
			expect(after.consumer?.consume).toBe(OK);
			expect(after.lastHour.k2).toBeGreaterThanOrEqual(1);
			expect(after.consumer!.records).toBeGreaterThanOrEqual(
				before.consumer?.records ?? 0,
			);
		},
	);

	test(T.runPage, { tags: ["containers", "runs"], timeout: 10 * MIN }, async ({
		app,
		browser,
		stage,
	}) => {
		skipUnlessK2(stage);
		skipUnlessK2Dispatch(stage);
		test.skip(!stage.containers, "CI runs need containers");
		const d = await dispatchedFor(stage, T.runPage);
		await app.open(`/${d.repo.path}/-/runs/${d.runId}`);
		await watchApi(browser);
		const fact = browser.locator(`dd[data-transport="${K2}"]`);
		await expect(fact).toHaveText(
			"Requested through the global log (K2); dispatched by the K2 consumer",
		);
		await expectApiClean(browser);
	});

	test(T.tile, { tags: ["ui"], timeout: 5 * MIN }, async ({
		app,
		browser,
		screen,
		stage,
	}) => {
		skipUnlessK2(stage);
		await app.open("/-/settings");
		await watchApi(browser);
		const tile = screen.getByRole("region", "Global log");
		await expect(tile.getByRole("heading", "Global log")).toBeVisible();
		await expect(browser.locator('[data-tile="global-log"] [data-status]'))
			.toHaveText(OK);
		await expect(tile).toContainText(streamOf("dev-e2e"));
		await expect(
			browser.locator('[data-tile="global-log"] [data-part="relay"]'),
		)
			.toContainText("forge events relayed");
		if (stage.switches.workloadTransport === K2) {
			await expect(
				browser.locator(`[data-tile="global-log"] dd[data-transport="${K2}"]`),
			).toContainText("dispatched from the global log (K2)");
		}
		await expect(
			browser.locator('[data-tile="global-log"] [data-part="dispatched"]'),
		).toContainText("via K2");
		await expectApiClean(browser);
	});

	test(T.dead, { tags: ["ui"], timeout: 5 * MIN }, async ({
		app,
		browser,
		stage,
	}) => {
		skipUnlessK2(stage);
		test.skip(
			!stage.switches.k2Token,
			"no consumer on this stage (no consume token): nothing can be parked",
		);
		await app.open("/-/settings");
		const dead = ok(
			"GET",
			"/-/api/log/dead",
			await pageApi(browser).get<LogDeadListResponse>("/-/api/log/dead"),
		);
		// The parked records are forge-wide and outlive a run: this run must
		// park none (a record of an earlier run is listed, not failed on).
		const since = runStartedAt(stage.runId);
		expect(
			dead.dead.filter((d) => d.at >= since),
			"records parked during this run",
		).toEqual([]);
		const consumer = (await statusOf(browser)).consumer;
		expect(consumer?.dead, "the consumer counts what the list shows")
			.toBeGreaterThanOrEqual(dead.dead.length);
		if (dead.dead.length === 0) {
			await expect(
				browser.locator('[data-tile="global-log"] [data-part="dead-empty"]'),
			).toHaveText("No dead letters.");
		} else {
			await expect(
				browser.locator(
					'[data-tile="global-log"] ul[aria-label="Dead letters"] li',
				),
			).toHaveCount(dead.dead.length);
		}
	});

	test(T.backstop, {
		tags: ["pending"],
		skip:
			"pending: pausing the bus needs the dev key (`/-/dev/k2`, TARTAN_SECRET), which the e2e harness never holds; the backstop is covered by the bus and runs workerd tests",
	}, async () => {});
});

test.describe("the global log is the forge Owner's", {
	tags: ["k2", "m2", "regression", "reporter"],
	session: "reporter",
}, () => {
	test(T.refused, { tags: ["security"], timeout: 2 * MIN }, async ({
		app,
		browser,
		stage,
	}) => {
		skipUnlessK2(stage);
		await app.open("/");
		for (const at of ["/-/api/log/status", "/-/api/log/dead"]) {
			const reply = await pageApi(browser).get(at);
			expect(reply.status, `${at} as a Reporter`).toBe(403);
			expect(reply.error?.code).toBe(DENIED);
		}
		// An agent token (not forge-wide) is refused too.
		const agent = tokenApi(stage.origin, tokensOf(stage).developerAgent);
		expect((await agent.get("/-/api/log/status")).status).toBe(403);
	});
});
