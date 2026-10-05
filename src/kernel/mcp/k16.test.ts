// K16 over MCP (WP11): the lane tools are thin callers of WP5a's K16-checked
// RepoDO core, here the real `core` module on its Deno harness (branch backend,
// M1). Agent A's lanes, agent B's lanes and A's delegate C; every denial is
// `denied("lane-op")` from RepoDO itself (⇒ `lane.denied`), never a host-side
// pre-check.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	type ActorBounds,
	type LaneHandle,
	LaneHandleSchema,
	ROLE,
	type ToolContext,
	ZERO_SHA,
} from "@tartan/contract";
import { createHarness, sha, TRUNK } from "../repo/testing/harness.ts";
import { ORIGIN } from "./testing/fakes.ts";
import {
	createMcpFixture,
	handleOf,
	trailerOf,
	valueOf,
} from "./testing/fixture.ts";

const setup = async () => {
	const h = await createHarness();
	const fx = createMcpFixture({ repoIds: { router: h.repoId } });
	fx.forge.setRepo(h.repoId, { core: h.facade });
	const gemini = fx.forge.addPrincipal({
		kind: "agent",
		handle: "gemini-1",
		owner: fx.owner,
	}).id;
	for (const p of [fx.claude, fx.codex, gemini]) {
		h.tree.roles.set(p, ROLE.developer);
	}
	h.tree.roles.set(fx.owner, ROLE.owner);
	const at = "rawkode/platform/router";
	return {
		h,
		fx,
		gemini,
		a: await fx.open(fx.claude, at),
		b: await fx.open(fx.codex, at),
		c: await fx.open(gemini, at),
	};
};

const deniedLaneOp = (result: { structuredContent: Record<string, unknown> }) =>
	result.structuredContent.error === "denied" &&
	result.structuredContent.reason === "lane-op";

Deno.test("lanes_open over MCP opens a branch lane whose handle carries the branch-lane commands on the canonical origin", async () => {
	const { h, fx, a } = await setup();
	const result = await fx.call(a, "lanes_open", {
		repo: "rawkode/platform/router",
		purpose: "fix the router",
		footprint: { projects: [], prefixes: ["src/router/"] },
	});
	equal(result.isError, undefined, result.content[0].text);
	const handle: LaneHandle = LaneHandleSchema.parse(handleOf(result));
	equal(handle.mode, "branch");
	equal(handle.state, "open");
	equal(handle.remote, `${ORIGIN}/acme/shop.git`);
	equal(handle.ref, `refs/heads/lanes/${handle.id}`);
	equal(
		handle.git?.start,
		`git fetch origin && git switch -c lanes/${handle.id} ${TRUNK}`,
	);
	equal(
		handle.git?.push,
		`git push -u origin HEAD:refs/heads/lanes/${handle.id}`,
	);
	equal(trailerOf(result).lane?.mode, "branch");
	const lane = await h.facade.getLane(handle.id);
	equal(lane?.owner, fx.claude);
	equal(lane?.onBehalfOf, fx.owner, "the agent works for its owner user");
	deepStrictEqual(lane?.footprint.prefixes, ["src/router/"]);
});

Deno.test("K16 over MCP: B's close, sync, restack and delegate of A's lane are denied lane-op by RepoDO", async () => {
	const { h, fx, a, b } = await setup();
	const laneA = handleOf(
		await fx.call(a, "lanes_open", {
			repo: "rawkode/platform/router",
			purpose: "a",
		}),
	);
	const laneB = handleOf(
		await fx.call(b, "lanes_open", {
			repo: "rawkode/platform/router",
			purpose: "b",
		}),
	);
	const attempts: [string, string, Record<string, unknown>][] = [
		["close", "lanes_close", { laneId: laneA.id, reason: "mine now" }],
		["sync", "lanes_sync", { laneId: laneA.id }],
		["restack", "lanes_sync", { laneId: laneA.id, onto: laneB.id }],
		["delegate", "lanes_delegate", { laneId: laneA.id, add: ["codex-1"] }],
	];
	for (const [op, tool, args] of attempts) {
		const result = await fx.call(b, tool, args);
		ok(deniedLaneOp(result), `${op}: ${result.content[0].text}`);
		ok(result.content.length >= 1);
	}
	deepStrictEqual(
		h.events.ofType("lane.denied").map((e) => (e.data as { op: string }).op),
		["close", "sync", "restack", "delegate"],
	);
	equal(h.gitJobs.calls.length, 0, "no git job ran");
	equal((await h.facade.getLane(laneA.id))?.state, "open");
});

Deno.test("restack of A's lane onto B's is allowed only for A's owner; a delegate may sync but not restack", async () => {
	const { h, fx, a, b, c } = await setup();
	const laneA = handleOf(
		await fx.call(a, "lanes_open", {
			repo: "rawkode/platform/router",
			purpose: "a",
		}),
	);
	const laneB = handleOf(
		await fx.call(b, "lanes_open", {
			repo: "rawkode/platform/router",
			purpose: "b",
		}),
	);
	await h.facade.recordPush({
		target: laneB.id,
		refs: [{ ref: laneB.ref, before: ZERO_SHA, after: sha(20) }],
		principal: fx.codex,
		via: "gateway",
		requestId: "push-b",
	});
	const delegated = await fx.call(a, "lanes_delegate", {
		laneId: laneA.id,
		add: ["gemini-1"],
	});
	equal(delegated.isError, undefined, delegated.content[0].text);
	const own = await fx.call(a, "lanes_sync", {
		laneId: laneA.id,
		onto: laneB.id,
	});
	equal(own.isError, undefined, own.content[0].text);
	equal(valueOf(own).ok, true);
	const delegateSync = await fx.call(c, "lanes_sync", { laneId: laneA.id });
	equal(delegateSync.isError, undefined, delegateSync.content[0].text);
	const delegateRestack = await fx.call(c, "lanes_sync", {
		laneId: laneA.id,
		onto: laneB.id,
	});
	ok(deniedLaneOp(delegateRestack), delegateRestack.content[0].text);
	// B's lane onto anything: denied for A.
	const other = await fx.call(a, "lanes_sync", {
		laneId: laneB.id,
		onto: laneA.id,
	});
	ok(deniedLaneOp(other), other.content[0].text);
	deepStrictEqual(h.gitJobs.calls.map((c) => c.method), ["restack", "sync"]);
});

Deno.test("a non-owner's lanes_delegate is denied; the owner's close works", async () => {
	const { fx, a, c } = await setup();
	const laneA = handleOf(
		await fx.call(a, "lanes_open", {
			repo: "rawkode/platform/router",
			purpose: "a",
		}),
	);
	await fx.call(a, "lanes_delegate", { laneId: laneA.id, add: ["gemini-1"] });
	const byDelegate = await fx.call(c, "lanes_delegate", {
		laneId: laneA.id,
		add: ["codex-1"],
	});
	ok(deniedLaneOp(byDelegate), byDelegate.content[0].text);
	const closed = await fx.call(a, "lanes_close", {
		laneId: laneA.id,
		reason: "done",
	});
	equal(closed.isError, undefined, closed.content[0].text);
	equal(valueOf<{ lane: { state: string } }>(closed).lane.state, "closed");
	equal(trailerOf(closed).lane?.state, "closed");
});

Deno.test("changes_open {sourceRef} on another principal's branch is denied lane-op (the provider passes the host's actor to adoptLane)", async () => {
	const { h, fx, a } = await setup();
	await h.facade.recordPush({
		target: "repo",
		refs: [{ ref: "refs/heads/feat", before: ZERO_SHA, after: sha(30) }],
		principal: fx.owner,
		via: "gateway",
		requestId: "feat-1",
	});
	// A stand-in for tartan.changes: caps would build the LaneOpActor from
	// the context and bounds the host sent; here it does so directly.
	fx.forge.onTool(
		"tartan.changes",
		"changes_open",
		async (args, ctx: ToolContext, bounds: ActorBounds) => {
			const lane = await h.facade.adoptLane({
				ref: (args as { sourceRef: string }).sourceRef,
				owner: ctx.actor.id,
				actor: { ...ctx.actor, bounds },
			});
			return { changeId: "x", lane };
		},
	);
	const result = await fx.call(a, "changes_open", {
		repo: "rawkode/platform/router",
		sourceRef: "refs/heads/feat",
		title: "take over",
	});
	ok(deniedLaneOp(result), result.content[0].text);
	equal(h.events.ofType("lane.denied").length, 1);
});
