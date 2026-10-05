// Runs/logs live tail (WP19) over the mock kernel with a fake clock and
// fake `/-/live` sockets: a live job log is re-read every 2 s while
// following and not while paused; the run is re-read when one of its own
// `run.*`/`job.*` events arrives (at most once a second), never for another
// run's; a finished job's log is read once.

import { describe, expect, it } from "vitest";
import type { Envelope } from "@tartan/contract/events.ts";
import { MOCK_NOW, REPO_ID } from "../src/api/mock/fixtures.ts";
import { RUN_IDS } from "../src/api/mock/land.ts";
import { isRunEvent, LOG_POLL_MS } from "../src/views/coord/runs/useRunTail.ts";
import { mountApp } from "./support/app.ts";
import { fakeClock, fakeSockets } from "./support/fakes.ts";
import { byAttr, click, flush, text } from "./support/renderer.ts";

const REPO = "/acme/platform/router";

const envelope = (
	seq: number,
	type: string,
	data: Record<string, unknown>,
): Envelope => ({
	id: `01k6g${String(80_000 + seq).padStart(21, "0")}`,
	seq,
	stream: `repo:${REPO_ID}`,
	type,
	v: 1,
	source: { kind: "kernel" },
	actor: { kind: "system", id: "sys_kernel" },
	node: REPO_ID,
	repo: REPO_ID,
	depth: 0,
	shadow: false,
	at: MOCK_NOW + 1000,
	data,
});

const mountRun = async (path: string) => {
	const live = fakeSockets();
	const clock = fakeClock(MOCK_NOW);
	const app = await mountApp(path, { connect: live.connect, clock });
	await flush();
	return { app, live, clock };
};

const count = (
	app: Awaited<ReturnType<typeof mountApp>>,
	path: string,
): number => app.calls.filter((c) => c.path === path).length;

const logPath = (runId: string, jobId: string) =>
	`/-/api/runs/${REPO_ID}/${runId}/jobs/${jobId}/log`;
const runPath = (runId: string) => `/-/api/runs/${REPO_ID}/${runId}`;

describe("live tail of a running job", () => {
	it("re-reads a live log every 2 s while following, not while paused", async () => {
		const { app, clock } = await mountRun(
			`${REPO}/-/runs/${RUN_IDS.running}/jobs/test-api`,
		);
		const log = logPath(RUN_IDS.running, "test-api");
		expect(count(app, log)).toBe(1);
		await clock.advance(LOG_POLL_MS);
		await flush();
		expect(count(app, log)).toBe(2);
		await clock.advance(LOG_POLL_MS);
		await flush();
		expect(count(app, log)).toBe(3);
		const follow = byAttr(app.root, "data-follow")[0]!;
		expect(text(follow)).toBe("Following");
		click(follow);
		await flush();
		expect(text(byAttr(app.root, "data-follow")[0]!)).toBe("Paused");
		await clock.advance(LOG_POLL_MS * 3);
		await flush();
		expect(count(app, log)).toBe(3);
		click(byAttr(app.root, "data-follow")[0]!);
		await flush();
		await clock.advance(LOG_POLL_MS);
		await flush();
		expect(count(app, log)).toBe(4);
	});

	it("re-reads the run when its own events arrive, at most once a second", async () => {
		const { app, live, clock } = await mountRun(
			`${REPO}/-/runs/${RUN_IDS.running}`,
		);
		expect(live.sockets).toHaveLength(1);
		const socket = live.sockets[0]!;
		expect(socket.path).toBe(`/-/live?repo=${REPO_ID}`);
		socket.open();
		socket.send({ t: "hello", repo: REPO_ID, head: 100 });
		await flush();
		const run = runPath(RUN_IDS.running);
		const before = count(app, run);
		socket.send({
			t: "events",
			head: 102,
			events: [
				envelope(101, "job.completed", {
					runId: RUN_IDS.running,
					jobId: "test-api",
					state: "success",
				}),
				envelope(102, "run.completed", {
					runId: RUN_IDS.running,
					state: "success",
				}),
			],
		});
		await flush();
		await clock.advance(1000);
		await flush();
		expect(count(app, run)).toBe(before + 1);
		socket.send({
			t: "events",
			head: 103,
			events: [
				envelope(103, "run.completed", {
					runId: RUN_IDS.failed,
					state: "failure",
				}),
			],
		});
		await flush();
		await clock.advance(2000);
		await flush();
		expect(count(app, run)).toBe(before + 1);
	});

	it("reads a finished job's log once", async () => {
		const { app, clock } = await mountRun(
			`${REPO}/-/runs/${RUN_IDS.failed}/jobs/test-web`,
		);
		await clock.advance(LOG_POLL_MS * 5);
		await flush();
		expect(count(app, logPath(RUN_IDS.failed, "test-web"))).toBe(1);
		expect(byAttr(app.root, "data-follow")).toEqual([]);
	});

	it("isRunEvent matches run and job events of that run only", () => {
		const ev = (type: string, runId: unknown) =>
			envelope(1, type, { runId } as Record<string, unknown>);
		expect(isRunEvent(ev("run.started", "r1"), "r1")).toBe(true);
		expect(isRunEvent(ev("job.completed", "r1"), "r1")).toBe(true);
		expect(isRunEvent(ev("job.completed", "r2"), "r1")).toBe(false);
		expect(isRunEvent(ev("push.accepted", "r1"), "r1")).toBe(false);
		expect(isRunEvent(ev("run.started", 5), "r1")).toBe(false);
	});
});
