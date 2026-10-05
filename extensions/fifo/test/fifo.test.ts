// tartan.fifo M1: one change at a time, enqueued only on a
// user's approval; swapping the Weave for FIFO changes only the order and
// batching (parallelism), not what lands. Runs the real module and
// migrations against the fake land kernel.

import {
	type Actor,
	parseManifest,
	QUEUE_EVENTS,
	type ToolContext,
	validateUi,
} from "@tartan/contract";
import manifestJson from "../tartan.json" with { type: "json" };
import { extension, migrations, POLICY } from "../src/index.ts";
import { createQueueExtension } from "../src/engine.ts";
import { equal, ok, rejects } from "./assert.ts";
import {
	type ChangeModel,
	createKernel,
	type Kernel,
	MAINTAINER,
	REPO,
} from "./kernel.ts";

const parsed = parseManifest(manifestJson);
if (!parsed.ok) throw new Error(parsed.errors.join("; "));
const manifest = parsed.manifest;
const human: Actor = { kind: "user", id: MAINTAINER };

const queue = (module = extension): Kernel =>
	createKernel({
		module,
		migrations,
		grants: manifest.permissions,
		extId: manifest.id,
		config: manifest.config?.default,
		batchTable: "batches",
	});

const stateOf = (k: Kernel, c: ChangeModel): string | undefined =>
	k.entries().find((e) => e.change_id === c.changeId)?.state;
const toolCtx = (actorId: string): ToolContext => ({
	node: REPO,
	repo: REPO,
	scope: "acme/platform/router",
	actor: { kind: actorId.startsWith("u_") ? "user" : "agent", id: actorId },
	mode: "enforce",
});

/** Lands everything in flight until the queue is empty; returns the batches. */
const drain = async (k: Kernel): Promise<string[][]> => {
	await k.settle();
	while (k.inFlight().length > 0) {
		k.finish(k.inFlight()[0]);
		await k.settle();
	}
	return k.submits.map((s) => s.batch.map((c) => c.changeId));
};

Deno.test("the manifest asks for no queue@1 call: the provider check is a read", () => {
	const calls = manifest.permissions["interfaces.call"] ?? [];
	equal(calls.includes("queue@1"), false);
	equal([...calls].sort().join(","), "changes@1,work@1");
});

Deno.test("FIFO enqueues only on a user's approval and lands one change at a time", async () => {
	const k = queue();
	const [c1, c2, c3] = [1, 2, 3].map((n) => k.submitChange(n));
	k.approve(c1); // an automatic approval: not enough for FIFO
	await k.settle();
	equal(k.entries(), []);
	k.approve(c2, { by: human, route: "human" });
	k.approve(c1, { by: human, route: "human" });
	k.approve(c3, { by: human, route: "human" });
	const batches = await drain(k);
	equal(batches, [[c2.changeId], [c1.changeId], [c3.changeId]]);
	equal(k.submits[0].batch[0].trailers.at(-1), {
		key: "Tartan-Review",
		value: "human(@maint)",
	});
	ok(k.submits[0].reason.summary.startsWith("fifo batch 1"));
	equal([c1, c2, c3].map((c) => stateOf(k, c)), ["landed", "landed", "landed"]);
	equal(k.violations, []);
	equal(k.refusals, []);
	for (const e of k.emitted) {
		const schema = QUEUE_EVENTS[e.type as keyof typeof QUEUE_EVENTS];
		ok(schema?.safeParse(e.data).success, `${e.type} payload`);
	}
	k.close();
});

Deno.test("K9: FIFO requeues a config-hold batch and resubmits it, never ejecting it", async () => {
	const k = queue();
	const c = k.submitChange(1);
	k.approve(c, { by: human, route: "human" });
	await k.settle();
	for (let i = 0; i < 5; i += 1) {
		k.finish(k.submits[i].batchId, { failed: { reason: "config-hold" } });
		await k.settle();
		await k.fireTick();
		await k.settle();
		equal(k.submits.length, i + 2, `resubmitted after hold ${i + 1}`);
	}
	notEjected(k, c);
	k.finish(k.submits[5].batchId);
	await k.settle();
	equal(stateOf(k, c), "landed");
	k.close();
});

const notEjected = (k: Kernel, c: ChangeModel) => {
	equal(k.emittedOf("queue.ejected").length, 0);
	ok(stateOf(k, c) !== "ejected");
};

Deno.test("swapping weave for fifo changes order and batching only", async () => {
	const scenario = async (k: Kernel) => {
		const cs = [1, 2, 3, 4, 5].map((n) => k.submitChange(n));
		for (const n of [3, 1, 5, 2, 4]) {
			k.approve(cs[n - 1], { by: human, route: "human" });
		}
		const batches = await drain(k);
		const landed = k.emittedOf("queue.landed").map((e) => e.data.changeId);
		k.close();
		return { batches, landed, all: cs.map((c) => c.changeId) };
	};
	// The Weave's policy on the same engine (the FIFO copy of it) and tables.
	const weave = await scenario(
		queue(createQueueExtension({
			...POLICY,
			extId: "tartan.weave",
			label: "weave",
			maxBatch: 4,
			humanOnly: false,
		})),
	);
	const fifo = await scenario(queue());
	equal(new Set(weave.landed).size, 5);
	equal(
		[...weave.landed].sort(),
		[...fifo.landed].sort(),
		"the same changes land",
	);
	equal(weave.batches.map((b) => b.length), [4, 1], "weave batches");
	equal(fifo.batches.map((b) => b.length), [1, 1, 1, 1, 1], "fifo is serial");
	equal(fifo.landed, weave.landed, "both keep approval order");
});

Deno.test("FIFO: queue_enqueue needs a human approval; conflicts eject and notify; slots render", async () => {
	const k = queue();
	const [c1, c2] = [1, 2].map((n) => k.submitChange(n));
	k.approve(c1);
	await k.settle();
	await rejects(
		() =>
			k.harness.tool(
				"queue_enqueue",
				{ changeId: c1.changeId },
				toolCtx(c1.author),
			),
		/human approval/,
	);
	k.approve(c1, { by: human, route: "human" });
	k.approve(c2, { by: human, route: "human" });
	await k.settle();
	k.finish(k.submits[0].batchId, {
		conflicted: [{
			changeId: c1.changeId,
			paths: ["apps/web/src/app.ts"],
			conflictsWith: [],
		}],
	});
	await k.settle();
	equal(stateOf(k, c1), "ejected");
	equal(k.notices.map((n) => n.principal), [c1.author]);
	ok(String(k.notices[0].notice.text).includes("apps/web/src/app.ts"));
	equal(k.submits[1].batch.map((c) => c.changeId), [c2.changeId]);

	const ro = k.harness.ctx({ readOnly: true, actor: human });
	const ctx = { node: REPO, repo: REPO, mode: "enforce" as const };
	for (const slot of manifest.contributes?.slots ?? []) {
		const doc = await extension.render!(
			slot.id,
			{
				...ctx,
				slot: slot.slot as "repo.tab",
				entity: { kind: "change", id: c2.changeId },
			},
			{},
			ro,
		);
		ok(validateUi(doc).ok, `${slot.id} renders`);
	}
	const sections = await k.harness.context({
		repo: "acme/platform/router",
		repoId: REPO,
		laneId: c2.laneId,
		maxBytes: 1024,
		actor: { kind: "agent", id: c2.author },
	});
	equal(sections.map((s) => s.id), ["queue-health"]);
	k.close();
});
