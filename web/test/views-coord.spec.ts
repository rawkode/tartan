// Lanes / Change Graph (WP19) mounted with the real router, API client and
// live store over the mock kernel: rendering from fixtures (agent, model,
// work title, footprint chips, push ticks, CI dot, radar badge, backend,
// `opening`), then from a live feed (`/-/live` frames through fake sockets),
// the lane page with its slots, and a windowed 1,000-lane swarm.

import { describe, expect, it } from "vitest";
import type { Envelope } from "@tartan/contract/events.ts";
import type { FetchLike } from "../src/api/http.ts";
import {
	EVENTS_HEAD,
	LANE_IDS,
	LANES,
	swarmLanes,
	WORK,
	WORK_TITLES,
} from "../src/api/mock/coord.ts";
import { createMockFetch } from "../src/api/mock/server.ts";
import { MOCK_NOW, REPO_ID } from "../src/api/mock/fixtures.ts";
import { fakeClock, fakeSockets } from "./support/fakes.ts";
import { mountApp } from "./support/app.ts";
import {
	findAll,
	flush,
	html,
	type TestElement,
	text,
} from "./support/renderer.ts";

const LANES_URL = "/acme/platform/router/-/lanes";

const rowsOf = (root: TestElement): TestElement[] =>
	findAll(
		root,
		(el) => el.tag === "li" && el.attrs["aria-posinset"] !== undefined,
	);

const rowFor = (root: TestElement, laneId: string): TestElement => {
	const row = rowsOf(root).find((r) =>
		findAll(r, (el) => el.tag === "a").some((a) =>
			(a.attrs["href"] ?? "").endsWith(`/-/lanes/${laneId}`)
		)
	);
	if (!row) throw new Error(`no row for ${laneId}`);
	return row;
};

const ticks = (row: TestElement): number =>
	findAll(row, (el) => el.tag === "rect" && el.attrs["class"] === "lane__tick")
		.length;

const label = (row: TestElement, cls: string): string =>
	findAll(row, (el) => (el.attrs["class"] ?? "").split(" ").includes(cls))[0]
		?.attrs["aria-label"] ?? "";

const envelope = (
	seq: number,
	type: string,
	data: Record<string, unknown>,
): Envelope => ({
	id: `01k6g${String(70_000 + seq).padStart(21, "0")}`,
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

const mountLanes = async (
	path = LANES_URL,
	options: { fetch?: FetchLike; lanes?: typeof LANES } = {},
) => {
	const live = fakeSockets();
	const app = await mountApp(path, {
		connect: live.connect,
		clock: fakeClock(MOCK_NOW),
		...(options.fetch ? { fetch: options.fetch } : {}),
		...(options.lanes ? { mock: { lanes: options.lanes } } : {}),
	});
	await flush();
	return { app, live };
};

describe("Lanes view from fixtures", () => {
	it("reads lanes, history and agents through the real routes", async () => {
		const { app } = await mountLanes();
		const paths = app.calls.map((c) => c.path);
		expect(paths).toContain(
			"/-/api/view?path=acme%2Fplatform%2Frouter&view=lanes",
		);
		expect(paths).toContain(
			"/-/api/lanes?repo=acme%2Fplatform%2Frouter&state=opening%2Copen%2Csubmitted%2Clanding&limit=200",
		);
		expect(paths).toContain(`/-/api/events?repo=${REPO_ID}&limit=1`);
		expect(
			paths.find((p) => p.startsWith(`/-/api/events?repo=${REPO_ID}&since=0`)),
		).toContain("types=lane.*%2Cpush.accepted");
		expect(paths).toContain("/-/api/agents");
		expect(app.calls.every((c) => c.method === "GET")).toBe(true);
	});

	it("draws a swimlane per lane with who, what, where and how", async () => {
		const { app } = await mountLanes();
		expect(rowsOf(app.root)).toHaveLength(LANES.length);
		const limits = rowFor(app.root, LANE_IDS.limits);
		const t = text(limits);
		expect(t).toContain("claude-1");
		expect(t).toContain("claude-code · claude-opus");
		expect(t).toContain(WORK_TITLES[WORK.limits]);
		expect(t).toContain("services/api");
		expect(t).toContain("packages/shared/src/config.ts");
		expect(t).toContain("submitted");
		expect(t).toContain("branch");
		expect(ticks(limits)).toBe(3);
		expect(label(limits, "ci-dot")).toBe("CI passed · 2 of 2 checks passed");
		expect(label(limits, "radar")).toContain("1 predicted conflict");
		expect(label(limits, "radar")).toContain("same file");
		expect(
			findAll(limits, (el) => el.tag === "a").map((a) => a.attrs["href"]),
		).toContain(
			"/acme/platform/router/-/changes/kqzvmxrstnpwylokqzvmxrstnpwylokq",
		);
		const web = rowFor(app.root, LANE_IDS.web);
		expect(text(web)).toContain("own repo");
		expect(text(web)).toContain("Own repository (import), opened in 2.1 s");
		expect(
			findAll(web, (el) => el.attrs["class"] === "lane__opening"),
		).toHaveLength(1);
		const seeding = rowFor(app.root, LANE_IDS.seeding);
		expect(text(seeding)).toContain("opening");
		expect(text(seeding)).toContain("agent …000209");
		expect(text(seeding)).toContain("Own repository, seeding by import");
		expect(label(seeding, "ci-dot")).toBe("No CI yet");
		expect(label(rowFor(app.root, LANE_IDS.router), "ci-dot")).toBe(
			"CI running",
		);
		// The summary counts the active lanes by backend.
		expect(text(app.root)).toContain("6 active lanes");
		expect(text(app.root)).toContain("2 own repo · 4 branch");
	});

	it("binds no style and no raw HTML (CSP)", async () => {
		const { app } = await mountLanes();
		expect(html(app.root)).not.toMatch(/\sstyle=/);
		expect(findAll(app.root, (el) => el.tag === "script")).toEqual([]);
		// Avatars only from the kernel's proxy.
		for (const img of findAll(app.root, (el) => el.tag === "img")) {
			expect(img.attrs["src"]).toMatch(/^\/-\/avatar\/[a-z]_/);
		}
	});

	it("shows an empty state for a repo without lanes", async () => {
		const { app } = await mountLanes(LANES_URL, { lanes: [] });
		const mockFetch = app.calls.length;
		expect(mockFetch).toBeGreaterThan(0);
		// History events still name the fixture lanes; they are fetched by id
		// and 404 here, so the list stays empty.
		await flush();
		expect(text(app.root)).toContain("No lanes yet");
	});
});

describe("Lanes view from the live feed", () => {
	it("adds push ticks, CI and radar as frames arrive, on one socket", async () => {
		const { app, live } = await mountLanes();
		expect(live.sockets).toHaveLength(1);
		const socket = live.sockets[0]!;
		expect(socket.path).toBe(`/-/live?repo=${REPO_ID}`);
		socket.open();
		socket.send({ t: "hello", repo: REPO_ID, head: EVENTS_HEAD });
		await flush();
		expect(text(app.root)).toContain("Live");
		const router = LANES.find((l) => l.id === LANE_IDS.router)!;
		socket.send({
			t: "events",
			head: EVENTS_HEAD + 3,
			events: [
				envelope(EVENTS_HEAD + 1, "push.accepted", {
					pushId: "live-1",
					target: router.id,
					ref: router.ref,
					before: "a".repeat(40),
					after: "b".repeat(40),
					via: "gateway",
				}),
				envelope(EVENTS_HEAD + 2, "run.completed", {
					runId: "run_1",
					state: "failed",
					subject: { kind: "lane", id: router.id },
				}),
				envelope(EVENTS_HEAD + 3, "conflicts.detected", {
					conflictId: "cf_live",
					a: router.id,
					b: "trunk",
					path: "services/api/src/router/index.ts",
					severity: "textual",
					suggestion: "rebase",
				}),
			],
		});
		await flush();
		const row = rowFor(app.root, LANE_IDS.router);
		expect(ticks(row)).toBe(3);
		// The API counted 2; the live push makes 3 (history is not counted twice).
		expect(label(row, "lane__track")).toContain("3 pushes");
		expect(label(row, "ci-dot")).toBe("CI failed");
		expect(label(row, "radar")).toContain("2 predicted conflicts");
		expect(label(row, "radar")).toContain("worst: textual conflict");
	});

	it("fetches a lane it hears about but has not read", async () => {
		const fresh = { ...LANES[1]!, id: "ln_01k6g000000000000000008888" };
		const mock = createMockFetch();
		const fetch: FetchLike = (input, init) =>
			input.startsWith(`/-/api/lanes/${fresh.id}`)
				? Promise.resolve(Response.json(fresh))
				: mock(input, init);
		const { app, live } = await mountLanes(LANES_URL, { fetch });
		const socket = live.sockets[0]!;
		socket.open();
		socket.send({
			t: "events",
			head: EVENTS_HEAD + 1,
			events: [
				envelope(EVENTS_HEAD + 1, "lane.opened", {
					laneId: fresh.id,
					owner: fresh.owner,
					base: fresh.base,
					mode: "branch",
				}),
			],
		});
		await flush();
		expect(app.calls.map((c) => c.path)).toContain(
			`/-/api/lanes/${fresh.id}?repo=acme%2Fplatform%2Frouter`,
		);
		expect(rowsOf(app.root)).toHaveLength(LANES.length + 1);
	});

	it("reloads everything after a gap frame", async () => {
		const { app, live } = await mountLanes();
		const lists = () =>
			app.calls.filter((c) => c.path.startsWith("/-/api/lanes?")).length;
		expect(lists()).toBe(1);
		const socket = live.sockets[0]!;
		socket.open();
		socket.send({ t: "gap", from: 1, to: 900 });
		await flush();
		expect(lists()).toBe(2);
		expect(rowsOf(app.root)).toHaveLength(LANES.length);
	});

	it("closes the socket when the view goes away", async () => {
		const { app, live } = await mountLanes();
		await app.router.push("/-/explore");
		await flush();
		expect(live.sockets[0]?.closed).toBe(true);
	});
});

describe("lane page", () => {
	it("shows the lane's facts and its lane.badge and lane.sidebar slots", async () => {
		const { app } = await mountLanes(`${LANES_URL}/${LANE_IDS.web}`);
		expect(app.calls.map((c) => c.path)).toContain(
			`/-/api/view?path=acme%2Fplatform%2Frouter&view=lanes%2F${LANE_IDS.web}`,
		);
		const detail = findAll(
			app.root,
			(el) => el.attrs["aria-labelledby"] === "lane-detail-title",
		)[0]!;
		expect(text(detail)).toContain(LANE_IDS.web);
		expect(text(detail)).toContain(
			"Its own repository, seeded by import in 2.1 s",
		);
		expect(text(detail)).toContain(
			`/acme/platform/router/-/lanes/${LANE_IDS.web}.git`,
		);
		expect(text(detail)).toContain(WORK_TITLES[WORK.web]);
		const slots = findAll(detail, (el) => el.attrs["data-slot"] !== undefined)
			.map((el) => el.attrs["data-slot"]);
		expect(slots).toEqual(["lane.badge", "lane.sidebar"]);
		expect(text(detail)).toContain("1 predicted conflict");
		// The selected row is marked.
		expect(rowFor(app.root, LANE_IDS.web).attrs["aria-current"]).toBe("true");
	});
});

describe("a 1,000-lane swarm", () => {
	it("pages the lanes API and renders only a window of rows", async () => {
		const { app } = await mountLanes(LANES_URL, { lanes: swarmLanes(1000) });
		const pages = app.calls.filter((c) => c.path.startsWith("/-/api/lanes?"));
		expect(pages).toHaveLength(5);
		expect(pages[1]?.path).toContain("cursor=ln_");
		const rows = rowsOf(app.root);
		expect(rows.length).toBeGreaterThan(5);
		expect(rows.length).toBeLessThan(40);
		expect(rows[0]?.attrs["aria-setsize"]).toBe("1000");
		expect(text(app.root)).toContain("1000 active lanes");
		// The rest of the list is a spacer, not elements.
		const pads = findAll(
			app.root,
			(el) => el.tag === "svg" && el.attrs["focusable"] === "false",
		);
		expect(Number(pads.at(-1)?.attrs["height"])).toBeGreaterThan(900 * 70);
	});
});
