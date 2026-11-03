// Live: the global event log on Cloudflare K2. Every committed forge and
// repo event is relayed, in
// `seq` order per Durable Object, into the stage's stream
// `tartan_<stage>_log`; the `workloads` consumer reads it and dispatches
// runs. The stage runs with `--k2` and the Secrets Store consume token, and
// with `--workload-transport k2`, so a run is dispatched from the log, with
// an inline backstop.
//
// - the relay: the forge's events reach the stream in order and the relay
//   catches up after new events (`GET /-/api/log/status`, the Owner);
// - a run dispatched from the log: pending, as this branch removed the CI
//   extension that requested a run for a submitted change;
// - the Owner's Global log tile on Settings, and nobody else reads the log;
// - no dead letters parked during the run;
// - the inline backstop with the bus paused needs the dev key: pending.

import { expect } from "e2e";
import type {
	LogDeadListResponse,
	LogStatusResponse,
} from "@tartan/contract/api.ts";
import type { ErrorCode } from "@tartan/contract/errors.ts";
import { sharedStore, test } from "../../support/fixtures.ts";
import { ok, pageApi, tokenApi } from "../../support/http.ts";
import { expectApiClean, watchApi } from "../../support/page.ts";
import { importModeRepo } from "../../support/repos.ts";
import { keyOf } from "../../support/shared.ts";
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

/** The Owner's (browser session's) view of the log. */
const statusOf = async (
	browser: Parameters<typeof pageApi>[0],
): Promise<LogStatusResponse> =>
	ok(
		"GET",
		"/-/api/log/status",
		await pageApi(browser).get<LogStatusResponse>("/-/api/log/status"),
	);

const T = {
	relay: "the forge's events are relayed to the K2 stream in sequence",
	dispatch:
		"a run is dispatched from the global log, with the transport recorded as k2",
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

	for (const title of [T.dispatch, T.runPage]) {
		test(title, {
			tags: ["runs", "pending"],
			skip:
				"pending: no extension on this branch requests a run (the CI extension was removed)",
		}, async () => {});
	}

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
