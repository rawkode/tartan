// createKernelCaps (K10, K12, K16) against fake kernel ports. The subtree
// cases: cross-subtree `readFile`, `diffPaths`, `events.read`, `authz.check`,
// `notify.send` and `interfaces.call(at=…)` are each `denied("scope")`, and the
// forge stream is read filtered to the installation subtree.

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import {
	CAPS_METHODS,
	type CapsProps,
	createUlid,
	fromRpcError,
	type KernelCaps,
	type ManifestPermissions,
} from "@tartan/contract";
import type { LaneOpActor } from "@tartan/contract/kernel.ts";
import {
	type CapsLocal,
	createKernelCaps,
	patternCovered,
	refGranted,
} from "./caps.ts";
import { createTokenBucket } from "./rate.ts";
import {
	agentActor,
	createFakeKernel,
	type FakeKernel,
	inForce,
	INSTALLATION_ID,
	installationActor,
	LANE_ID,
	NODES,
	OTHER_INSTALLATION_ID,
	PRINCIPALS,
	SECRET_LANE_ID,
	userActor,
} from "../exthost/host/testing/fakes.ts";
import { helloManifest } from "../exthost/host/testing/hello.ts";

const GRANTS: ManifestPermissions = {
	...helloManifest().permissions,
	"interfaces.call": ["work@1", "queue@1"],
	"events.read": ["x.tartan.hello.*", "push.*", "node.*"],
};

const props = (overrides: Partial<CapsProps> = {}): CapsProps => ({
	inst: INSTALLATION_ID,
	extId: "tartan.hello",
	version: "0.1.0",
	scopeKey: `repo:${NODES.router.id}`,
	node: { id: NODES.acme.id, path: NODES.acme.path },
	repo: NODES.router.id,
	grants: GRANTS,
	backgroundRole: 20,
	actor: installationActor(),
	bounds: null,
	depth: 0,
	mode: "enforce",
	readOnly: false,
	...overrides,
});

type Built = {
	readonly caps: KernelCaps;
	readonly kernel: FakeKernel;
	readonly timers: Map<string, number>;
};

const build = (
	overrides: Partial<CapsProps> = {},
	localOverrides: Partial<CapsLocal> = {},
	kernel: FakeKernel = createFakeKernel(),
): Built => {
	const timers = new Map<string, number>();
	const local: CapsLocal = {
		clock: { now: () => 1_000 },
		ids: { ulid: createUlid({ now: () => 1_000 }) },
		provides: () => Promise.resolve(["queue@1"]),
		timers: {
			set: (key, at) => timers.set(key, at),
			clear: (key) => timers.delete(key),
		},
		...localOverrides,
	};
	return {
		caps: createKernelCaps(props(overrides), kernel.ports, local),
		kernel,
		timers,
	};
};

const code = async (p: Promise<unknown> | (() => unknown)): Promise<string> => {
	try {
		await (typeof p === "function" ? p() : p);
		return "ok";
	} catch (error) {
		const e = fromRpcError(error);
		return e.reason ? `${e.code}:${e.reason}` : e.code;
	}
};

const interactive = (actor = userActor(PRINCIPALS.dev)) => ({
	actor,
	bounds: { maxRole: 50 as const, scopes: null, nodeId: null, laneId: null },
});

const OUTSIDE = { id: NODES.secret.id };
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

Deno.test("every method of CAPS_METHOD_POLICY is implemented", () => {
	const { caps } = build();
	for (const method of CAPS_METHODS) {
		const [ns, name] = method.split(".");
		strictEqual(
			typeof (caps as unknown as Record<string, Record<string, unknown>>)[ns][
				name
			],
			"function",
			method,
		);
	}
});

Deno.test("every target outside the installation subtree is denied(scope)", async () => {
	const { caps, kernel } = build(interactive());
	strictEqual(
		await code(caps.repo.readFile(OUTSIDE, "main", "README.md")),
		"denied:scope",
	);
	strictEqual(
		await code(
			caps.repo.readFile({ path: "other/secret" }, "main", "README.md"),
		),
		"denied:scope",
	);
	ok(
		!kernel.called("node").some((c) =>
			JSON.stringify(c.args).includes("other/secret")
		),
		"an outside path is refused before any lookup",
	);
	strictEqual(
		await code(caps.repo.diffPaths({ repoId: NODES.secret.id }, SHA_A, SHA_B)),
		"denied:scope",
	);
	strictEqual(
		await code(caps.events.read(`repo:${NODES.secret.id}`, 0, ["push.*"])),
		"denied:scope",
	);
	strictEqual(
		await code(caps.authz.check(PRINCIPALS.dev, OUTSIDE, "read")),
		"denied:scope",
	);
	strictEqual(
		await code(
			caps.notify.send(PRINCIPALS.outsider, {
				kind: "message",
				severity: "info",
				text: "hello",
			}),
		),
		"denied:scope",
	);
	strictEqual(
		await code(
			caps.interfaces.call(
				"work@1",
				"work_get",
				{ ref: "acme/router#1" },
				OUTSIDE,
			),
		),
		"denied:scope",
	);
	strictEqual(
		await code(caps.lanes.get(SECRET_LANE_ID, { repo: OUTSIDE })),
		"denied:scope",
	);
	strictEqual(await code(caps.lanes.get(SECRET_LANE_ID)), "not_found");
	strictEqual(
		await code(
			caps.repo.diff(
				{ repoId: NODES.router.id, sha: SHA_A },
				{ repoId: NODES.secret.id, sha: SHA_B },
			),
		),
		"denied:scope",
	);
	strictEqual(kernel.called("probe.diffPaths").length, 0);
	strictEqual(kernel.called("deliverNotice").length, 0);
	strictEqual(kernel.called("callTool").length, 0);
});

Deno.test("the forge stream is read filtered to the installation subtree", async () => {
	const { caps, kernel } = build();
	await caps.events.read("forge", 0, ["node.*"]);
	const [call] = kernel.called("forgeEvents.read");
	deepStrictEqual(call.args[2], { limit: 100, subtreeNodeId: NODES.acme.id });
});

Deno.test("in a read-only context every effect is denied(read-only); reads work", async () => {
	const { caps, kernel } = build({ ...interactive(), readOnly: true });
	const denied = {
		emit: await code(caps.events.emit("x.tartan.hello.a", {})),
		notify: await code(
			caps.notify.send(PRINCIPALS.dev, {
				kind: "system",
				severity: "info",
				text: "x",
			}),
		),
		lanes: await code(
			caps.lanes.open({ repo: { id: NODES.router.id }, owner: PRINCIPALS.dev }),
		),
		land: await code(caps.land.submit({} as never)),
		timers: await code(caps.timers.set("t", 1)),
		notes: await code(
			caps.notes.contribute({ id: NODES.router.id }, "k".repeat(32), {}),
		),
		tool: await code(
			caps.interfaces.call("work@1", "work_claim", { ref: "acme/router#1" }),
		),
	};
	for (const [what, result] of Object.entries(denied)) {
		strictEqual(result, "denied:read-only", what);
	}
	deepStrictEqual(
		await caps.repo.info({ id: NODES.router.id }).then((i) => i.id),
		NODES.router.id,
	);
	strictEqual(kernel.called("events.append").length, 0);
});

Deno.test("shadow installations: lanes, land and notify are denied(shadow); emits are marked shadow", async () => {
	const { caps, kernel } = build({ mode: "shadow" });
	strictEqual(
		await code(
			caps.lanes.open({ repo: { id: NODES.router.id }, owner: PRINCIPALS.dev }),
		),
		"denied:shadow",
	);
	strictEqual(
		await code(
			caps.notify.send(PRINCIPALS.dev, {
				kind: "system",
				severity: "info",
				text: "x",
			}),
		),
		"denied:shadow",
	);
	await caps.events.emit("x.tartan.hello.a", {});
	strictEqual(kernel.appended[0].shadow, true);
});

Deno.test("grants: ungranted methods, patterns, refs, interfaces and queue@1", async () => {
	const built = build(interactive());
	const { caps } = built;
	strictEqual(await code(caps.runs.get("run_1")), "denied:grant");
	strictEqual(
		await code(caps.events.read(`repo:${NODES.router.id}`, 0, ["lane.*"])),
		"denied:grant",
	);
	strictEqual(
		await code(caps.events.read(`repo:${NODES.router.id}`, 0, ["*"])),
		"denied:grant",
	);
	strictEqual(
		await code(caps.interfaces.call("changes@1", "changes_get", {})),
		"denied:grant",
	);
	strictEqual(
		await code(caps.ai.json("TARTAN_JUDGE_MODEL", "p", {})),
		"denied:grant",
	);
	const request = {
		batchId: `lb_${"0".repeat(26)}`,
		repo: { id: NODES.router.id },
		ref: "refs/heads/release",
		batch: [{
			changeId: "k".repeat(32),
			laneId: LANE_ID,
			head: SHA_B,
			title: "t",
			message: "m",
			trailers: [],
		}],
		reason: { events: ["0".repeat(26)], summary: "s" },
		testPolicy: "checks" as const,
	};
	strictEqual(await code(caps.land.submit(request)), "denied:grant");
	const notQueue = build(interactive(), {
		provides: () => Promise.resolve([]),
	});
	strictEqual(
		await code(
			notQueue.caps.land.submit({ ...request, ref: "refs/heads/main" }),
		),
		"denied:grant",
	);
	const fine = await caps.land.submit({ ...request, ref: "refs/heads/main" });
	strictEqual(fine.batchId, request.batchId);
	// Another installation is the queue@1 provider in force at the repo
	// (this one was replaced or masked): refused, so it hands over.
	const { kernel } = built;
	kernel.providers.set(`queue@1@${NODES.acme.id}`, {
		installation: { id: "i_01k6ffffffffffffffffffffff" } as never,
		manifest: helloManifest(),
		depth: 0,
	});
	const refused = await caps.land.submit({
		...request,
		batchId: `lb_${"1".repeat(26)}`,
		ref: "refs/heads/main",
	}).catch((e: unknown) => fromRpcError(e));
	ok(
		"code" in refused && refused.code === "denied" &&
			/not the queue@1 provider in force/.test(refused.text),
		JSON.stringify(refused),
	);
	kernel.providers.set(`queue@1@${NODES.acme.id}`, {
		installation: { id: INSTALLATION_ID } as never,
		manifest: helloManifest(),
		depth: 0,
	});
	ok(
		(await caps.land.submit({
			...request,
			batchId: `lb_${"2".repeat(26)}`,
			ref: "refs/heads/main",
		})).batchId,
	);
});

Deno.test("K16: lanes open only for the interactive actor (or its on-behalf-of user)", async () => {
	const background = build();
	strictEqual(
		await code(
			background.caps.lanes.open({
				repo: { id: NODES.router.id },
				owner: PRINCIPALS.dev,
			}),
		),
		"denied:actor",
	);
	const agent = agentActor(PRINCIPALS.agent, PRINCIPALS.dev);
	const { caps, kernel } = build({
		actor: agent,
		bounds: {
			maxRole: 30,
			scopes: ["lanes", "mcp"],
			nodeId: null,
			laneId: null,
		},
	});
	strictEqual(
		await code(
			caps.lanes.open({
				repo: { id: NODES.router.id },
				owner: PRINCIPALS.maintainer,
			}),
		),
		"denied:actor",
	);
	await caps.lanes.open({
		repo: { id: NODES.router.id },
		owner: PRINCIPALS.agent,
	});
	const [call] = kernel.called("core.openLane");
	const input = call.args[1] as {
		owner: string;
		onBehalfOf?: string;
		actor: LaneOpActor;
	};
	strictEqual(input.owner, PRINCIPALS.agent);
	strictEqual(input.onBehalfOf, PRINCIPALS.dev);
	deepStrictEqual(input.actor, {
		kind: "agent",
		id: PRINCIPALS.agent,
		onBehalfOf: PRINCIPALS.dev,
		installation: INSTALLATION_ID,
		// The bounds RepoDO applies to K16's role.
		bounds: {
			maxRole: 30,
			scopes: ["lanes", "mcp"],
			nodeId: null,
			laneId: null,
		},
	});
});

Deno.test("acting principal: grant ∩ actor role and token scopes; a lane pin caps other lanes at Reporter", async () => {
	const reporter = build(interactive(userActor(PRINCIPALS.reporter)));
	strictEqual(
		await code(
			reporter.caps.lanes.open({
				repo: { id: NODES.router.id },
				owner: PRINCIPALS.reporter,
			}),
		),
		"denied:role",
	);
	const noLanesScope = build({
		actor: agentActor(PRINCIPALS.agent, PRINCIPALS.dev),
		bounds: {
			maxRole: 30,
			scopes: ["mcp", "repo:read"],
			nodeId: null,
			laneId: null,
		},
	});
	strictEqual(
		await code(
			noLanesScope.caps.lanes.open({
				repo: { id: NODES.router.id },
				owner: PRINCIPALS.agent,
			}),
		),
		"denied:scopes",
	);
	const pinned = build({
		actor: agentActor(PRINCIPALS.agent, PRINCIPALS.dev),
		bounds: {
			maxRole: 30,
			scopes: ["lanes"],
			nodeId: null,
			laneId: `ln_${"0".repeat(26)}`,
		},
		grants: { ...GRANTS, lanes: ["open", "close"] },
	});
	strictEqual(
		await code(pinned.caps.lanes.close(LANE_ID, "done")),
		"denied:role",
	);
	const tokenNode = build({
		actor: userActor(PRINCIPALS.dev),
		bounds: {
			maxRole: 50,
			scopes: null,
			nodeId: NODES.platform.id,
			laneId: null,
		},
	});
	strictEqual(
		await code(tokenNode.caps.repo.info({ id: NODES.router.id })),
		"denied:role",
	);
	const background = build();
	deepStrictEqual(
		(await background.caps.repo.info({ id: NODES.router.id })).id,
		NODES.router.id,
		"the installation reads at its background role",
	);
});

Deno.test("K10: emit only own and provided namespaces, depth ≤ 8, payload schemas, idempotency keys", async () => {
	const cause = "0".repeat(26);
	const { caps, kernel } = build({ causedBy: cause, depth: 3 });
	strictEqual(
		await code(caps.events.emit("x.other.thing", {})),
		"denied:namespace",
	);
	strictEqual(
		await code(caps.events.emit("work.created", {})),
		"denied:namespace",
	);
	strictEqual(
		await code(caps.events.emit("lane.opened", {})),
		"denied:namespace",
	);
	strictEqual(
		await code(caps.events.emit("queue.enqueued", { nope: 1 })),
		"invalid",
	);
	await caps.events.emit("queue.enqueued", {
		changeId: "k".repeat(32),
		partition: "p",
	});
	await caps.events.emit("x.tartan.hello.a", { n: 1 });
	await caps.events.emit("x.tartan.hello.a", { n: 2 });
	await caps.events.emit("x.tartan.hello.b", {}, { idemKey: "mine" });
	deepStrictEqual(kernel.appended.map((a) => a.idemKey), [
		`${INSTALLATION_ID}:${cause}:queue.enqueued:0`,
		`${INSTALLATION_ID}:${cause}:x.tartan.hello.a:0`,
		`${INSTALLATION_ID}:${cause}:x.tartan.hello.a:1`,
		`${INSTALLATION_ID}:mine`,
	]);
	strictEqual(kernel.appended[0].depth, 4);
	const deep = build({ causedBy: cause, depth: 8 });
	strictEqual(
		await code(deep.caps.events.emit("x.tartan.hello.a", {})),
		"denied:depth",
	);
	const nodeScoped = build({ repo: undefined });
	strictEqual(
		await code(nodeScoped.caps.events.emit("x.tartan.hello.a", {})),
		"invalid",
	);
});

Deno.test("interfaces.call resolves the provider, passes the chain and rejects cycles", async () => {
	const kernel = createFakeKernel();
	const work = inForce(
		helloManifest({ id: "tartan.work", provides: ["work@1"] }),
		{
			id: OTHER_INSTALLATION_ID,
		},
	);
	kernel.providers.set(`work@1@${NODES.platform.id}`, work);
	const queue = inForce(helloManifest(), { id: OTHER_INSTALLATION_ID });
	kernel.providers.set(`queue@1@${NODES.acme.id}`, queue);
	kernel.callTool = () => Promise.resolve({ partitions: [] });
	const { caps } = build({ backgroundRole: 30 }, {}, kernel);
	deepStrictEqual(
		await caps.interfaces.call("queue@1", "queue_status", {
			repo: "acme/router",
		}),
		{ partitions: [] },
	);
	const [call] = kernel.called("callTool");
	deepStrictEqual(call.args[0], {
		installationId: OTHER_INSTALLATION_ID,
		scope: { kind: "repo", repoId: NODES.router.id },
	});
	deepStrictEqual(call.args[5], [INSTALLATION_ID]);
	deepStrictEqual(call.args[4], {
		maxRole: 30,
		scopes: null,
		nodeId: NODES.acme.id,
		laneId: null,
	});
	const cyclic = build({ callChain: [OTHER_INSTALLATION_ID] }, {}, kernel);
	strictEqual(
		await code(
			cyclic.caps.interfaces.call("queue@1", "queue_status", {
				repo: "acme/router",
			}),
		),
		"conflict",
	);
	// Background calls act at background_role: work_create needs Developer.
	const reporterRole = build({ backgroundRole: 20 }, {}, kernel);
	strictEqual(
		await code(
			reporterRole.caps.interfaces.call("work@1", "work_create", {
				repo: "acme/router",
				kind: "issue",
				title: "t",
			}),
		),
		"denied:role",
	);
	strictEqual(
		await code(
			caps.interfaces.call("work@1", "work_get", { ref: "acme/router#1" }),
		),
		"not_found",
		"the work@1 provider is in force at acme/platform only",
	);
	kernel.callTool = () => Promise.resolve({ bogus: true });
	strictEqual(
		await code(
			caps.interfaces.call("queue@1", "queue_status", { repo: "acme/router" }),
		),
		"internal",
	);
	strictEqual(
		await code(caps.interfaces.call("work@1", "work_nope", {})),
		"invalid",
	);
});

Deno.test("runs.start takes CI graphs only, with the resolved repo as source", async () => {
	const { caps, kernel } = build({
		grants: { ...GRANTS, runs: ["start"] },
		...interactive(),
	});
	const graph = {
		repo: { id: NODES.router.id },
		kind: "ci" as const,
		source: { repoId: NODES.router.id, laneId: LANE_ID },
		sha: SHA_B,
		jobs: [{ id: "test", run: "npm test", needs: [] }],
		idemKey: "run-1",
	};
	strictEqual(
		await code(caps.runs.start({ ...graph, kind: "git" } as never)),
		"invalid",
	);
	strictEqual(
		await code(
			caps.runs.start({ ...graph, source: { repoId: NODES.platformApi.id } }),
		),
		"invalid",
	);
	strictEqual(
		await code(caps.runs.start({ ...graph, idemKey: "" })),
		"invalid",
	);
	await caps.runs.start(graph);
	const [call] = kernel.called("runs.start");
	const input = call.args[1] as { idemKey: string; requestedBy: string };
	strictEqual(input.idemKey, `${INSTALLATION_ID}:run-1`);
	strictEqual(input.requestedBy, PRINCIPALS.dev);
});

Deno.test("reads resolve refs through RepoDO (K15) and read by SHA from the source's repo", async () => {
	const kernel = createFakeKernel();
	kernel.files.set(
		`${NODES.router.id}:${"c".repeat(40)}:README.md`,
		new TextEncoder().encode("hello world"),
	);
	const { caps } = build(interactive(), {}, kernel);
	const bytes = await caps.repo.readFile(
		{ id: NODES.router.id },
		"main",
		"README.md",
		5,
	);
	strictEqual(new TextDecoder().decode(bytes!), "hello");
	deepStrictEqual(kernel.called("core.resolveRef")[0].args, [
		NODES.router.id,
		"main",
	]);
	strictEqual(
		await caps.repo.readFile({ id: NODES.router.id }, "nope", "README.md"),
		null,
	);
	const tree = await caps.repo.readTree({ id: NODES.router.id }, "main", "");
	deepStrictEqual(tree.map((e) => e.path), ["README.md"]);
	strictEqual(
		await code(caps.repo.readFile({ id: NODES.router.id }, "main", "../x")),
		"invalid",
	);
	strictEqual(
		await code(caps.repo.blame({ id: NODES.router.id }, SHA_A, "x")),
		"not_implemented",
	);
});

Deno.test("v0.2 lane surface: open returns at once, delegate and laneRange pass the actor and the lane", async () => {
	const { caps, kernel } = build({
		...interactive(),
		grants: { ...GRANTS, lanes: ["open", "delegate"] },
	});
	// openLane answers `opening` or `open`; caps never waits for a seed.
	const lane = await caps.lanes.open({
		repo: { id: NODES.router.id },
		owner: PRINCIPALS.dev,
	});
	strictEqual(lane.repoId, NODES.router.id);
	strictEqual(kernel.called("core.laneRange").length, 0);
	await caps.lanes.delegate(LANE_ID, { add: [PRINCIPALS.reporter] });
	const [delegate] = kernel.called("core.delegateLane");
	deepStrictEqual(delegate.args.slice(1, 4), [
		LANE_ID,
		[PRINCIPALS.reporter],
		[],
	]);
	strictEqual((delegate.args[4] as LaneOpActor).id, PRINCIPALS.dev);
	strictEqual(
		await code(caps.lanes.delegate(LANE_ID, { add: ["not-a-principal"] })),
		"invalid",
	);
	const range = await caps.repo.laneRange(LANE_ID);
	strictEqual(range.rangeBase, SHA_A);
	strictEqual(await code(caps.repo.laneRange(SECRET_LANE_ID)), "not_found");
	// A lane read goes to the lane's source (its repo resolves it, K15).
	await caps.repo.readTree({ id: NODES.router.id }, LANE_ID, "", {
		repoId: NODES.router.id,
		laneId: LANE_ID,
	});
	deepStrictEqual(kernel.called("reader").at(-1)?.args, [{
		repoId: NODES.router.id,
		laneId: LANE_ID,
	}]);
});

Deno.test("repo routing: id-keyed calls of a node-scoped installation must name the repo", async () => {
	const { caps } = build({ repo: undefined, ...interactive() });
	strictEqual(await code(caps.lanes.get(LANE_ID)), "invalid");
	strictEqual(
		(await caps.lanes.get(LANE_ID, { repo: { id: NODES.router.id } })).id,
		LANE_ID,
	);
});

Deno.test("principals.get never returns an email", async () => {
	const { caps } = build();
	const info = await caps.principals.get(PRINCIPALS.dev);
	deepStrictEqual(info, {
		id: PRINCIPALS.dev,
		kind: "user",
		handle: "dev",
		display: "Dev",
	});
});

Deno.test("notify.send: recipients with a role in the subtree; text sanitized; dedupe key namespaced", async () => {
	const { caps, kernel } = build();
	await caps.notify.send(PRINCIPALS.reporter, {
		kind: "message",
		severity: "warn",
		text: "hi \u001b[31mthere\u001b[0m",
		dedupeKey: "d",
	});
	const [n] = kernel.notices;
	strictEqual(n.principal, PRINCIPALS.reporter);
	strictEqual(n.notice.text, "hi [31mthere[0m");
	strictEqual(n.notice.dedupeKey, `${INSTALLATION_ID}:d`);
	strictEqual(n.notice.repoId, NODES.router.id);
	strictEqual(n.notice.source, INSTALLATION_ID);
});

Deno.test("a capability minted for a finished call is unavailable; the effects bucket limits the rate", async () => {
	let done = false;
	const { caps } = build({}, { expired: () => done });
	strictEqual(typeof caps.clock.now(), "number");
	done = true;
	strictEqual(await code(() => caps.clock.now()), "unavailable");
	let now = 0;
	const limited = build({}, {
		rate: createTokenBucket({ now: () => now }, 1, 1),
	});
	await limited.caps.timers.set("a", 1);
	strictEqual(await code(limited.caps.timers.set("b", 1)), "denied:rate");
	now += 1000;
	await limited.caps.timers.set("c", 1);
	deepStrictEqual([...limited.timers.keys()], ["a", "c"]);
});

Deno.test("notes.contribute caps the section at 8 KB", async () => {
	const { caps, kernel } = build();
	strictEqual(
		await code(
			caps.notes.contribute({ id: NODES.router.id }, "k".repeat(32), {
				s: "x".repeat(9000),
			}),
		),
		"invalid",
	);
	await caps.notes.contribute({ id: NODES.router.id }, "k".repeat(32), {
		s: "ok",
	});
	deepStrictEqual(kernel.called("land.contributeNote")[0].args.slice(1), [
		"k".repeat(32),
		"tartan.hello",
		{ s: "ok" },
	]);
});

Deno.test("pattern and ref grant helpers", () => {
	ok(patternCovered(["changes.*"], "changes.submitted"));
	ok(patternCovered(["changes.*"], "changes.*"));
	ok(!patternCovered(["changes.*"], "*"));
	ok(patternCovered(["*"], "*"));
	ok(!patternCovered(["changes.submitted"], "changes.*"));
	ok(refGranted(["refs/heads/main"], "refs/heads/main"));
	ok(refGranted(["refs/heads/release/*"], "refs/heads/release/1.0"));
	ok(!refGranted(["refs/heads/release/*"], "refs/heads/release/1/x"));
	ok(!refGranted(["refs/heads/main"], "refs/heads/mainline"));
});

Deno.test("repo.policy (ADR repo config): K12-confined, a trunk sha only, the caller's own repoPolicy keys", async () => {
	const { caps, kernel } = build({}, {
		repoPolicyKeys: () => Promise.resolve(["pipeline"]),
	});
	deepStrictEqual(
		await caps.repo.policy({ id: NODES.router.id }, SHA_A),
		{ state: "none" },
	);
	// RepoDO decides trunk membership (`policy-not-trunk`); the cap sends
	// the sha, the caller's extension id and only its own keys.
	deepStrictEqual(
		kernel.calls.find((c) => c.port === "repoconfig.policy")?.args,
		[NODES.router.id, SHA_A, "tartan.hello", ["pipeline"]],
	);
	strictEqual(await code(caps.repo.policy(OUTSIDE, SHA_A)), "denied:scope");
	// A ref name is never resolved here: trunk policy is read at a commit.
	strictEqual(
		await code(caps.repo.policy({ id: NODES.router.id }, "main")),
		"invalid",
	);
	// Without manifest repoPolicy keys, none are asked for.
	const bare = build();
	await bare.caps.repo.policy({ id: NODES.router.id }, SHA_B);
	deepStrictEqual(
		bare.kernel.calls.find((c) => c.port === "repoconfig.policy")?.args.at(-1),
		[],
	);
	// It is a repo read: an installation granted `repo: none` is refused.
	const ungranted = build({ grants: { ...GRANTS, repo: "none" } });
	ok(
		(await code(ungranted.caps.repo.policy({ id: NODES.router.id }, SHA_A)))
			.startsWith("denied"),
	);
	strictEqual(
		ungranted.kernel.calls.some((c) => c.port === "repoconfig.policy"),
		false,
	);
});

Deno.test("interfaces.provider: who provides an interface at a node, and whether it is the caller (a read, no grant)", async () => {
	const built = build(interactive());
	const { caps, kernel } = built;
	// None in force: null (no grant needed to ask).
	strictEqual(await caps.interfaces.provider("queue@1"), null);
	kernel.providers.set(`queue@1@${NODES.router.id}`, {
		installation: { id: INSTALLATION_ID, extId: "tartan.weave" } as never,
		manifest: helloManifest(),
		depth: 2,
	});
	deepStrictEqual(await caps.interfaces.provider("queue@1"), {
		installation: INSTALLATION_ID,
		extension: "tartan.weave",
		self: true,
	});
	kernel.providers.set(`queue@1@${NODES.router.id}`, {
		installation: {
			id: "i_01k6ffffffffffffffffffffff",
			extId: "tartan.fifo",
		} as never,
		manifest: helloManifest(),
		depth: 3,
	});
	deepStrictEqual(
		await caps.interfaces.provider("queue@1", { id: NODES.router.id }),
		{
			installation: "i_01k6ffffffffffffffffffffff",
			extension: "tartan.fifo",
			self: false,
		},
	);
	// Confined like every read (K12), and the interface id is checked.
	strictEqual(
		await code(caps.interfaces.provider("queue@1", OUTSIDE)),
		"denied:scope",
	);
	strictEqual(
		await code(caps.interfaces.provider("nope" as never)),
		"invalid",
	);
});
