// The Change Graph model (WP19): folding lanes and repo events into
// swimlanes, the shared time axis and list windowing. Pure; no DOM.

import { describe, expect, it } from "vitest";
import type { LaneDto } from "@tartan/contract/api.ts";
import type { Envelope } from "@tartan/contract/events.ts";
import * as contractInterfaces from "@tartan/contract/interfaces.ts";
import * as contractLanes from "@tartan/contract/lanes.ts";
import {
	CHANGE_ID_2,
	EVENTS,
	LANE_IDS,
	LANES,
	swarmLanes,
	WORK,
	WORK_TITLES,
} from "../src/api/mock/coord.ts";
import { CHANGE_ID, MOCK_NOW } from "../src/api/mock/fixtures.ts";
import {
	ACTIVE_STATES,
	type AgentInfo,
	AXIS_WIDTH,
	axisX,
	CONFLICT_SEVERITIES,
	emptyGraph,
	foldEvents,
	type GraphState,
	LANE_EVENT_TRANSITIONS,
	laneRows,
	principalLabel,
	timeAxis,
	windowRange,
	withLanes,
} from "../src/views/coord/lanes/model.ts";

let seq = 10_000;
const ev = (
	type: string,
	data: Record<string, unknown>,
	extra: Partial<Envelope> = {},
): Envelope => {
	seq += 1;
	return {
		id: `01k6g${String(seq).padStart(21, "0")}`,
		seq,
		stream: "repo:01k6g000000000000000000040",
		type,
		v: 1,
		source: { kind: "kernel" },
		actor: { kind: "system", id: "sys_kernel" },
		node: "01k6g000000000000000000040",
		depth: 0,
		shadow: false,
		at: MOCK_NOW,
		data,
		...extra,
	} as Envelope;
};

const lane = (id: string): LaneDto => LANES.find((l) => l.id === id)!;
const seeded = (): GraphState =>
	foldEvents(withLanes(emptyGraph(), LANES), EVENTS);
const rowOf = (
	g: GraphState,
	id: string,
	agents = new Map<string, AgentInfo>(),
) => laneRows(g, agents).find((r) => r.lane.id === id)!;

describe("contract copies", () => {
	it("LANE_EVENT_TRANSITIONS and the severities match the contract", () => {
		expect(LANE_EVENT_TRANSITIONS).toEqual(
			contractLanes.LANE_EVENT_TRANSITIONS,
		);
		expect([...CONFLICT_SEVERITIES]).toEqual([
			...contractInterfaces.CONFLICT_SEVERITIES,
		]);
		expect(ACTIVE_STATES.every((s) => contractLanes.LANE_STATES.includes(s)))
			.toBe(true);
	});
});

describe("folding the fixture log", () => {
	it("gives each lane its work title, footprint chips and push ticks", () => {
		const g = seeded();
		const limits = rowOf(g, LANE_IDS.limits);
		expect(limits.workRef).toBe(WORK.limits);
		expect(limits.workTitle).toBe(WORK_TITLES[WORK.limits]);
		expect(limits.chips).toEqual([
			"services/api",
			"services/api/src/limits",
			"packages/shared/src/config.ts",
		]);
		expect(limits.pushes).toHaveLength(3);
		expect(limits.changeId).toBe(CHANGE_ID);
	});

	it("derives the CI dot from checks (by change) and runs (by lane)", () => {
		const g = seeded();
		expect(rowOf(g, LANE_IDS.limits).ci).toEqual({
			state: "success",
			label: "CI passed · 2 of 2 checks passed",
		});
		expect(rowOf(g, LANE_IDS.docs).ci?.state).toBe("success");
		expect(rowOf(g, LANE_IDS.router).ci).toEqual({
			state: "running",
			label: "CI running",
		});
		expect(rowOf(g, LANE_IDS.web).ci).toBeNull();
	});

	it("counts open conflicts per lane with the worst severity", () => {
		const g = seeded();
		const radar = rowOf(g, LANE_IDS.limits).radar;
		expect(radar).toEqual({
			open: 1,
			worst: "same_file",
			with: [LANE_IDS.router],
			paths: ["packages/shared/src/config.ts"],
		});
		expect(rowOf(g, LANE_IDS.router).radar.with).toEqual([LANE_IDS.limits]);
		expect(rowOf(g, LANE_IDS.web).radar.open).toBe(0);
	});

	it("keeps both backends and the opening lane", () => {
		const g = seeded();
		expect(rowOf(g, LANE_IDS.web).lane).toMatchObject({
			mode: "repo",
			seed: "import",
			seedMs: 2140,
			state: "open",
		});
		expect(rowOf(g, LANE_IDS.seeding).lane.state).toBe("opening");
		expect(rowOf(g, LANE_IDS.router).lane.mode).toBe("branch");
	});

	it("moves a submitted lane to landing on land.submitted", () => {
		const g = seeded();
		expect(rowOf(g, LANE_IDS.docs).lane.state).toBe("landing");
		expect(g.changeLane.get(CHANGE_ID_2)).toBe(LANE_IDS.docs);
	});
});

describe("live events", () => {
	it("adds a push tick, the head and the count", () => {
		const g0 = seeded();
		const before = rowOf(g0, LANE_IDS.router);
		const g1 = foldEvents(g0, [
			ev("push.accepted", {
				pushId: "p",
				target: LANE_IDS.router,
				ref: lane(LANE_IDS.router).ref,
				before: "a".repeat(40),
				after: "b".repeat(40),
				via: "gateway",
			}, { at: MOCK_NOW + 1000 }),
		]);
		const after = rowOf(g1, LANE_IDS.router);
		expect(after.pushes).toHaveLength(before.pushes.length + 1);
		expect(after.lane.pushes).toBe(before.lane.pushes + 1);
		expect(after.lane.head).toBe("b".repeat(40));
		expect(after.lane.lastPushAt).toBe(MOCK_NOW + 1000);
		// Trunk pushes are not lane ticks.
		const g2 = foldEvents(g1, [
			ev("push.accepted", {
				pushId: "q",
				target: "repo",
				ref: "refs/heads/main",
				before: "a".repeat(40),
				after: "c".repeat(40),
				via: "kernel",
			}),
		]);
		expect(g2.pushes).toEqual(g1.pushes);
	});

	it("is idempotent for replayed seqs and ignores shadow events", () => {
		const g0 = seeded();
		const push = ev("push.accepted", {
			pushId: "p",
			target: LANE_IDS.web,
			ref: "refs/heads/main",
			before: "a".repeat(40),
			after: "d".repeat(40),
			via: "gateway",
		});
		const once = foldEvents(g0, [push]);
		const twice = foldEvents(once, [push]);
		expect(rowOf(twice, LANE_IDS.web).pushes).toEqual(
			rowOf(once, LANE_IDS.web).pushes,
		);
		const shadow = foldEvents(once, [
			ev("conflicts.detected", {
				conflictId: "cf_shadow",
				a: LANE_IDS.web,
				b: "trunk",
				path: "x",
				severity: "textual",
				suggestion: "rebase",
			}, { shadow: true }),
		]);
		expect(rowOf(shadow, LANE_IDS.web).radar.open).toBe(0);
	});

	it("shows opening → open with the seed time", () => {
		const g = foldEvents(seeded(), [
			ev("lane.opened", {
				laneId: LANE_IDS.seeding,
				owner: lane(LANE_IDS.seeding).owner,
				base: lane(LANE_IDS.seeding).base,
				mode: "repo",
				seed: "import",
				seedMs: 1830,
			}),
		]);
		expect(rowOf(g, LANE_IDS.seeding).lane).toMatchObject({
			state: "open",
			seedMs: 1830,
		});
	});

	it("records a fallback to the branch backend and a seed failure", () => {
		const g = foldEvents(seeded(), [
			ev("lane.seed_failed", {
				laneId: LANE_IDS.seeding,
				seed: "import",
				code: "import-timeout",
				attempt: 1,
				next: "branch",
				platformFault: true,
			}),
			ev("lane.opened", {
				laneId: LANE_IDS.seeding,
				owner: lane(LANE_IDS.seeding).owner,
				base: lane(LANE_IDS.seeding).base,
				mode: "branch",
			}),
		]);
		const row = rowOf(g, LANE_IDS.seeding);
		expect(row.lane.mode).toBe("branch");
		expect(row.seedFailure).toEqual({ code: "import-timeout", next: "branch" });
		// Its ref and remote changed with the backend: the view re-reads it.
		expect(g.unknownLanes.has(LANE_IDS.seeding)).toBe(true);
	});

	it("applies the change-driven lane transitions and land outcomes", () => {
		let g = seeded();
		g = foldEvents(g, [
			ev("changes.submitted", {
				changeId: "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
				laneId: LANE_IDS.router,
				revision: 1,
				head: "e".repeat(40),
				base: "a".repeat(40),
				affected: [],
			}),
		]);
		expect(rowOf(g, LANE_IDS.router).lane.state).toBe("submitted");
		g = foldEvents(g, [
			ev("changes.abandoned", { changeId: "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk" }),
		]);
		expect(rowOf(g, LANE_IDS.router).lane.state).toBe("open");
		g = foldEvents(g, [
			ev("land.completed", {
				batchId: "lb_1",
				attempt: 1,
				landed: [{ changeId: CHANGE_ID_2, commit: "f".repeat(40) }],
				conflicted: [],
				vetoed: [],
			}),
		]);
		const docs = laneRows(g, new Map()).find((r) =>
			r.lane.id === LANE_IDS.docs
		)!;
		expect(docs.lane.state).toBe("landed");
		expect(docs.active).toBe(false);
	});

	it("clears and escalates radar conflicts", () => {
		let g = seeded();
		const id = [...g.conflicts.keys()][0]!;
		g = foldEvents(g, [
			ev("conflicts.escalated", {
				conflictId: id,
				from: "same_file",
				to: "textual",
			}),
		]);
		expect(rowOf(g, LANE_IDS.limits).radar.worst).toBe("textual");
		g = foldEvents(g, [
			ev("conflicts.cleared", { conflictId: id, avoided: true }),
		]);
		expect(rowOf(g, LANE_IDS.limits).radar.open).toBe(0);
	});

	it("aggregates checks: a failure wins, a new sha starts over", () => {
		let g = seeded();
		g = foldEvents(g, [
			ev("checks.updated", {
				subject: { kind: "change", id: CHANGE_ID },
				sha: "1".repeat(40),
				context: "web:test",
				state: "running",
			}),
		]);
		expect(rowOf(g, LANE_IDS.limits).ci).toEqual({
			state: "running",
			label: "CI running · 0 of 1 checks passed",
		});
		g = foldEvents(g, [
			ev("checks.updated", {
				subject: { kind: "change", id: CHANGE_ID },
				sha: "1".repeat(40),
				context: "api:test",
				state: "failure",
			}),
		]);
		expect(rowOf(g, LANE_IDS.limits).ci?.state).toBe("failure");
	});

	it("reports lanes it does not know so the view can fetch them", () => {
		const fresh = "ln_01k6g000000000000000009999";
		const g = foldEvents(seeded(), [
			ev("lane.opened", {
				laneId: fresh,
				owner: "a_01k6g000000000000000000201",
				base: "a".repeat(40),
				mode: "branch",
			}),
		]);
		expect([...g.unknownLanes]).toEqual([fresh]);
		const known = withLanes(g, [{ ...lane(LANE_IDS.router), id: fresh }]);
		expect(known.unknownLanes.size).toBe(0);
	});
});

describe("rows", () => {
	it("puts active lanes first, newest activity first, and names agents", () => {
		const agents = new Map<string, AgentInfo>([[
			lane(LANE_IDS.limits).owner,
			{
				handle: "claude-1",
				display: "Claude",
				tool: "claude-code",
				model: "opus",
			},
		]]);
		const rows = laneRows(seeded(), agents);
		expect(rows.map((r) => r.lane.id)).toEqual([
			LANE_IDS.seeding,
			LANE_IDS.human,
			LANE_IDS.limits,
			LANE_IDS.router,
			LANE_IDS.web,
			LANE_IDS.docs,
		]);
		expect(rows.find((r) => r.lane.id === LANE_IDS.limits)?.agent?.model)
			.toBe("opus");
		expect(rows.find((r) => r.lane.id === LANE_IDS.router)?.agent).toBeNull();
	});

	it("labels principals without an agent record", () => {
		expect(principalLabel("a_01k6g000000000000000000209")).toBe(
			"agent …000209",
		);
		expect(principalLabel("u_01k6g000000000000000000001")).toBe(
			"user …000001",
		);
		expect(principalLabel("sys_kernel")).toBe("Tartan");
	});
});

describe("axis and windowing", () => {
	it("spans the oldest lane to now, between 30 minutes and a day", () => {
		const rows = laneRows(seeded(), new Map());
		const axis = timeAxis(rows, MOCK_NOW);
		expect(axis.to).toBe(MOCK_NOW);
		expect(axis.from).toBe(MOCK_NOW - 75 * 60_000);
		expect(timeAxis([], MOCK_NOW).from).toBe(MOCK_NOW - 30 * 60_000);
		expect(axisX(axis.from, axis)).toBe(0);
		expect(axisX(axis.to, axis)).toBe(AXIS_WIDTH);
		expect(axisX(axis.from - 1e9, axis)).toBe(0);
		expect(axisX((axis.from + axis.to) / 2, axis)).toBe(AXIS_WIDTH / 2);
	});

	it("renders only the rows near the viewport", () => {
		expect(windowRange(1000, 80, 0, 800)).toEqual({ start: 0, end: 19 });
		expect(windowRange(1000, 80, 40_000, 800)).toEqual({
			start: 492,
			end: 519,
		});
		expect(windowRange(1000, 80, 1e9, 800)).toEqual({ start: 991, end: 1000 });
		expect(windowRange(0, 80, 0, 800)).toEqual({ start: 0, end: 0 });
		expect(windowRange(5, 80, 0, 800)).toEqual({ start: 0, end: 5 });
	});

	it("folds a 1,000-lane swarm quickly", () => {
		const lanes = swarmLanes(1000);
		const pushes = lanes.map((l, i) =>
			ev("push.accepted", {
				pushId: `s${i}`,
				target: l.id,
				ref: l.ref,
				before: "a".repeat(40),
				after: "b".repeat(40),
				via: "swarm",
			})
		);
		const started = performance.now();
		const g = foldEvents(withLanes(emptyGraph(), lanes), pushes);
		const rows = laneRows(g, new Map());
		expect(rows).toHaveLength(1000);
		expect(performance.now() - started).toBeLessThan(2000);
	});
});

describe("simulated agents (swarm, WP20)", () => {
	it("marks a lane simulated from an event flagged sim, or its agent's sim model", () => {
		const router = lane(LANE_IDS.router);
		const web = lane(LANE_IDS.web);
		let state = withLanes(emptyGraph(), [router, web]);
		state = foldEvents(state, [
			ev("push.accepted", {
				pushId: "p_sim",
				target: router.id,
				ref: router.ref,
				before: "a".repeat(40),
				after: "b".repeat(40),
				via: "swarm",
			}, { sim: true }),
			ev("lane.synced", { laneId: web.id }),
		]);
		const plain = laneRows(state, new Map());
		expect(plain.find((r) => r.lane.id === router.id)?.sim).toBe(true);
		expect(plain.find((r) => r.lane.id === web.id)?.sim).toBe(false);
		const agents = new Map<string, AgentInfo>([[web.owner, {
			handle: "sim-7",
			display: "sim-7",
			tool: "other",
			model: "sim",
		}]]);
		expect(laneRows(state, agents).find((r) => r.lane.id === web.id)?.sim)
			.toBe(true);
	});
});
