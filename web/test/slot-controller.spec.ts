// Slot hosts: render, refreshOn through the
// live store (≤ 1/s per slot), refreshMs, actions and their results.

import { describe, expect, it } from "vitest";
import type {
	ActionResponse,
	SlotInstanceDto,
	SlotRenderResponse,
} from "@tartan/contract/api.ts";
import type { SlotCtxHint } from "../src/api/client.ts";
import { ApiError } from "../src/api/http.ts";
import { createLiveStore } from "../src/live/store.ts";
import { createSlotController } from "../src/slots/controller.ts";
import { createSlotRegistry } from "../src/slots/registry.ts";
import { envelope, fakeClock, fakeSockets } from "./support/fakes.ts";

const REPO = "01k6g000000000000000000040";

const INSTANCE: SlotInstanceDto = {
	installationId: "i_01k6g000000000000000000504",
	ext: "tartan.ci",
	slot: "change.panel",
	id: "checks",
	order: 0,
	refreshOn: ["checks.*"],
	cache: "viewer",
};

const CTX: SlotCtxHint = {
	node: "acme/platform/router",
	entity: { kind: "change", id: "zkqv" },
};

const doc = (
	text: string,
	extra: Partial<SlotRenderResponse> = {},
): SlotRenderResponse => ({
	v: 1,
	root: { t: "text", text },
	...extra,
});

const setup = (options: {
	render?: () => Promise<SlotRenderResponse>;
	action?: () => Promise<ActionResponse>;
	confirm?: boolean;
	instance?: SlotInstanceDto;
} = {}) => {
	const clock = fakeClock();
	const { connect, sockets } = fakeSockets();
	const live = createLiveStore({ connect, scheduler: clock });
	const renders: {
		inst: string;
		slotId: string;
		ctx: SlotCtxHint;
	}[] = [];
	const actions: { slotId: string; body: unknown }[] = [];
	let n = 0;
	const toasts: unknown[] = [];
	const navigations: string[] = [];
	const refreshed: string[][] = [];
	const confirms: string[] = [];
	const page = { ctx: CTX, repoId: REPO as string | undefined };
	const controller = createSlotController({
		api: {
			slots: {
				render: (inst, slotId, ctx) => {
					renders.push({ inst, slotId, ctx });
					return options.render
						? options.render()
						: Promise.resolve(doc(`render ${++n}`));
				},
				action: (_inst, slotId, body) => {
					actions.push({ slotId, body });
					return options.action ? options.action() : Promise.resolve({ v: 1 });
				},
			},
		},
		live,
		scheduler: clock,
		instance: options.instance ?? INSTANCE,
		ctx: () => page.ctx,
		repoId: () => page.repoId,
		navigate: (p) => navigations.push(p),
		toast: (t) => toasts.push(t),
		refreshSlots: (ids) => refreshed.push([...ids]),
		confirm: (text) => {
			confirms.push(text);
			return options.confirm ?? true;
		},
	});
	return {
		page,
		clock,
		sockets,
		controller,
		renders,
		actions,
		toasts,
		navigations,
		refreshed,
		confirms,
	};
};

const settle = async () => {
	for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

describe("slot controller", () => {
	it("renders on start with the instance, contribution id and ctx hints", async () => {
		const t = setup();
		t.controller.start();
		await settle();
		expect(t.renders).toEqual([{
			inst: INSTANCE.installationId,
			slotId: "checks",
			ctx: CTX,
		}]);
		expect(t.controller.state.doc).toEqual(doc("render 1"));
	});

	it("refreshes on matching live events, throttled to one per second", async () => {
		const t = setup();
		t.controller.start();
		await settle();
		const socket = t.sockets[0]!;
		expect(socket.path).toContain(`repo=${REPO}`);
		socket.send({ t: "events", head: 1, events: [envelope("radar.updated")] });
		await settle();
		expect(t.renders).toHaveLength(1); // not in refreshOn
		socket.send({ t: "events", head: 2, events: [envelope("checks.updated")] });
		socket.send({ t: "events", head: 3, events: [envelope("checks.updated")] });
		socket.send({ t: "events", head: 4, events: [envelope("checks.done")] });
		await settle();
		expect(t.renders).toHaveLength(1); // inside the 1 s window since the first render
		await t.clock.advance(1000);
		expect(t.renders).toHaveLength(2); // one trailing refresh for the burst
		await t.clock.advance(5000);
		expect(t.renders).toHaveLength(2);
	});

	it("subscribes to the document's refreshOn too, and polls refreshMs (≥ 5 s)", async () => {
		const t = setup({
			render: () =>
				Promise.resolve(doc("x", { refreshOn: ["queue.*"], refreshMs: 1000 })),
		});
		t.controller.start();
		await settle();
		t.sockets[0]!.send({
			t: "events",
			head: 1,
			events: [envelope("queue.moved")],
		});
		await t.clock.advance(1000);
		expect(t.renders).toHaveLength(2);
		await t.clock.advance(4999);
		expect(t.renders).toHaveLength(2);
		await t.clock.advance(1);
		expect(t.renders).toHaveLength(3);
	});

	it("subscribes from the render's cursor: an event between the render and the hello still refreshes (e2e comment gap)", async () => {
		// The work item panel: no instance refreshOn, so the socket opens only
		// after the first render names `work.*`.
		let n = 0;
		const t = setup({
			instance: { ...INSTANCE, ext: "tartan.work", id: "item", refreshOn: [] },
			render: () =>
				Promise.resolve(
					doc(`render ${++n}`, { refreshOn: ["work.*"], cursor: 3 + n }),
				),
		});
		t.controller.start();
		await settle();
		expect(t.renders).toHaveLength(1);
		const socket = t.sockets[0]!;
		expect(socket.path).toBe(`/-/live?repo=${REPO}&since=4`);
		// The comment (seq 5) was appended before the socket connected.
		socket.open();
		socket.send({ t: "hello", repo: REPO, head: 5 });
		socket.send({
			t: "events",
			head: 5,
			events: [envelope("work.commented")],
		});
		await t.clock.advance(1000);
		await settle();
		expect(t.renders).toHaveLength(2);
		expect(t.controller.state.doc?.cursor).toBe(5);
	});

	it("resyncs when the socket opened before the render and its hello is past the cursor", async () => {
		let n = 0;
		const t = setup({
			render: () => Promise.resolve(doc(`render ${++n}`, { cursor: 2 })),
		});
		t.controller.start();
		// Subscribed at start (instance refreshOn), without a cursor yet.
		expect(t.sockets[0]!.path).toBe(`/-/live?repo=${REPO}`);
		await settle();
		t.sockets[0]!.open();
		// Seqs 3..5 happened after the render read its cursor, before the hello.
		t.sockets[0]!.send({ t: "hello", repo: REPO, head: 5 });
		await settle();
		await t.clock.advance(1000);
		await settle();
		expect(t.renders).toHaveLength(2);
		expect(t.sockets).toHaveLength(1);
	});

	it("re-renders on a live gap (resync)", async () => {
		const t = setup();
		t.controller.start();
		await settle();
		await t.clock.advance(1000);
		t.sockets[0]!.send({ t: "gap", from: 1, to: 700 });
		await settle();
		expect(t.renders).toHaveLength(2);
	});

	it("runs actions with the action's payload and ctx, and applies the result", async () => {
		const t = setup({
			action: () =>
				Promise.resolve({
					v: 1,
					render: { v: 1, root: { t: "text", text: "after" } },
					toast: { tone: "success", text: "Re-run queued" },
					navigate: "/acme/platform/router/-/runs",
					refresh: ["summary", "queue"],
				}),
		});
		t.controller.start();
		await settle();
		await t.controller.runAction({ id: "ci.rerun", payload: { job: 1 } });
		expect(t.actions).toEqual([{
			slotId: "checks",
			body: {
				action: "ci.rerun",
				payload: { job: 1 },
				ctx: CTX,
			},
		}]);
		expect(t.controller.state.doc).toEqual(doc("after"));
		expect(t.toasts).toEqual([{ tone: "success", text: "Re-run queued" }]);
		expect(t.navigations).toEqual(["/acme/platform/router/-/runs"]);
		expect(t.refreshed).toEqual([["summary", "queue"]]);
	});

	it("passes form payloads instead of the action's own payload", async () => {
		const t = setup();
		t.controller.start();
		await t.controller.runAction({ id: "work.create", payload: { a: 1 } }, {
			title: "x",
			a: 1,
		});
		expect((t.actions[0]!.body as { payload: unknown }).payload).toEqual({
			title: "x",
			a: 1,
		});
	});

	it("asks for confirmation and does nothing when declined", async () => {
		const t = setup({ confirm: false });
		t.controller.start();
		await t.controller.runAction({
			id: "lane.archive",
			confirm: "Archive this lane?",
		});
		expect(t.confirms).toEqual(["Archive this lane?"]);
		expect(t.actions).toEqual([]);
	});

	it("never navigates off-origin, whatever the result says", async () => {
		for (
			const navigate of [
				"//evil.example",
				"/\\evil.example",
				"https://evil.example",
				"javascript:alert(1)",
			]
		) {
			const t = setup({ action: () => Promise.resolve({ v: 1, navigate }) });
			t.controller.start();
			await t.controller.runAction({ id: "a" });
			expect(t.navigations).toEqual([]);
		}
	});

	it("shows a danger toast when the action fails, and is not left busy", async () => {
		const t = setup({
			action: () => Promise.reject(new ApiError(403, "denied", "Not allowed")),
		});
		t.controller.start();
		await t.controller.runAction({ id: "a" });
		expect(t.toasts).toEqual([{ tone: "danger", text: "Not allowed" }]);
		expect(t.controller.state.busy).toBe(false);
	});

	it("shows render errors and recovers on the next refresh", async () => {
		let fail = true;
		const t = setup({
			render: () =>
				fail
					? Promise.reject(new ApiError(500, "internal", "boom"))
					: Promise.resolve(doc("ok")),
		});
		t.controller.start();
		await settle();
		expect(t.controller.state.error).toBe("boom");
		fail = false;
		await t.clock.advance(1000);
		t.controller.refresh();
		await settle();
		expect(t.controller.state.error).toBeNull();
		expect(t.controller.state.doc).toEqual(doc("ok"));
	});

	it("drops a render that finishes after the controller stopped", async () => {
		let resolve: (d: SlotRenderResponse) => void = () => {};
		const t = setup({ render: () => new Promise((r) => (resolve = r)) });
		t.controller.start();
		t.controller.stop();
		resolve(doc("late"));
		await settle();
		expect(t.controller.state.doc).toBeNull();
		expect(t.sockets[0]!.closed).toBe(true);
	});

	it("re-renders with the new hint when the page's ctx changes, dropping the old render", async () => {
		const pending: ((d: SlotRenderResponse) => void)[] = [];
		const t = setup({ render: () => new Promise((r) => pending.push(r)) });
		t.controller.start();
		await settle();
		expect(t.renders.map((r) => r.ctx)).toEqual([CTX]);
		// Navigate to change B while A's render is still in flight.
		const b: SlotCtxHint = {
			node: "acme/platform/router",
			entity: { kind: "change", id: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" },
		};
		t.page.ctx = b;
		t.controller.reload();
		await settle();
		expect(t.renders.map((r) => r.ctx)).toEqual([CTX, b]);
		// A's late answer is ignored; B's is shown.
		pending[0]!(doc("change A"));
		await settle();
		expect(t.controller.state.doc).toBeNull();
		pending[1]!(doc("change B"));
		await settle();
		expect(t.controller.state.doc).toEqual(doc("change B"));
		// Actions carry the new hint.
		await t.controller.runAction({ id: "comment", payload: { body: "x" } });
		expect((t.actions[0]!.body as { ctx: unknown }).ctx).toEqual(b);
	});

	it("drops an action's render that answers after the ctx changed, but keeps its toast", async () => {
		let answer: (r: ActionResponse) => void = () => {};
		const t = setup({ action: () => new Promise((r) => (answer = r)) });
		t.controller.start();
		await settle();
		const running = t.controller.runAction({ id: "comment" });
		t.page.ctx = { node: "acme/platform/router" };
		t.controller.reload();
		await settle();
		answer({
			v: 1,
			render: { v: 1, root: { t: "text", text: "for the old ctx" } },
			toast: { tone: "success", text: "Comment added" },
		});
		await running;
		await settle();
		expect(t.controller.state.doc).toEqual(doc("render 2"));
		expect(t.toasts).toEqual([{ tone: "success", text: "Comment added" }]);
	});

	it("re-subscribes the live feed when the repo changes", async () => {
		const t = setup();
		t.controller.start();
		await settle();
		const other = "01k6g000000000000000000041";
		t.page.repoId = other;
		t.controller.reload();
		await settle();
		expect(t.sockets.some((s) => s.path.includes(`repo=${other}`))).toBe(true);
	});
});

describe("slot registry", () => {
	it("refreshes registered slots by contribution id", () => {
		const registry = createSlotRegistry();
		const hits: string[] = [];
		const off = registry.register("summary", () => hits.push("summary"));
		registry.register("queue", () => hits.push("queue"));
		registry.refresh(["summary", "queue", "summary", "missing"]);
		expect(hits).toEqual(["summary", "queue"]);
		off();
		registry.refresh(["summary"]);
		expect(hits).toEqual(["summary", "queue"]);
	});
});
