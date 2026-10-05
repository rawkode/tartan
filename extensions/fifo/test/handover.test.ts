// queue@1 provider hand-over (an Owner swaps the Weave for
// FIFO on a live repo). FIFO takes the repo over: it adopts what the stream
// says is approved by a person and not landed, tells the changes it declines,
// and an installation that no longer provides queue@1 releases its queue. Runs
// the real module and migrations against the fake land kernel.

import { type Actor, parseManifest, QUEUE_EVENTS } from "@tartan/contract";
import manifestJson from "../tartan.json" with { type: "json" };
import { extension, migrations } from "../src/index.ts";
import { ADOPT_MS, ADOPT_PAGES, ADOPT_RECHECK_MS } from "../src/engine.ts";
import { equal, ok } from "./assert.ts";
import {
	type ChangeModel,
	createKernel,
	type Kernel,
	MAINTAINER,
} from "./kernel.ts";

const parsed = parseManifest(manifestJson);
if (!parsed.ok) throw new Error(parsed.errors.join("; "));
const manifest = parsed.manifest;
const human: Actor = { kind: "user", id: MAINTAINER };

const fifo = (): Kernel =>
	createKernel({
		module: extension,
		migrations,
		grants: manifest.permissions,
		extId: manifest.id,
		config: manifest.config?.default,
		batchTable: "batches",
	});

const entryOf = (k: Kernel, c: ChangeModel) =>
	k.entries().find((e) => e.change_id === c.changeId);

const drain = async (k: Kernel): Promise<string[][]> => {
	await k.settle();
	while (k.inFlight().length > 0) {
		k.finish(k.inFlight()[0]);
		await k.settle();
	}
	return k.submits.map((s) => s.batch.map((c) => c.changeId));
};

const checkSchemas = (k: Kernel): void => {
	for (const e of k.emitted) {
		const schema = QUEUE_EVENTS[e.type as keyof typeof QUEUE_EVENTS];
		ok(schema?.safeParse(e.data).success, `${e.type} matches queue@1`);
	}
};

/**
 * The history a new FIFO finds on a repo the Weave ran (none of it was
 * delivered to FIFO): approved by a person and waiting (1), approved by the
 * by-exception review (2), approved and landed by the Weave (3), approved
 * then abandoned (4), approved and in the Weave's batch right now (5), and
 * approved at an older revision (6).
 */
const history = (k: Kernel) => {
	const quiet = { deliver: false };
	const cs = [1, 2, 3, 4, 5, 6].map((n) => k.submitChange(n, quiet));
	k.approve(cs[0], { by: human, route: "human", deliver: false });
	k.approve(cs[1], { deliver: false });
	k.approve(cs[2], { by: human, route: "human", deliver: false });
	k.append("changes.landed", {
		changeId: cs[2].changeId,
		commit: "c".repeat(40),
	}, quiet);
	k.lanes.get(cs[2].laneId)!.state = "landed";
	k.approve(cs[3], { by: human, route: "human", deliver: false });
	k.append("changes.abandoned", { changeId: cs[3].changeId }, quiet);
	k.lanes.get(cs[3].laneId)!.state = "open";
	k.approve(cs[4], { by: human, route: "human", deliver: false });
	k.lanes.get(cs[4].laneId)!.state = "landing";
	k.approve(cs[5], { by: human, route: "human", deliver: false });
	k.pushRevision(cs[5], quiet);
	equal(k.discard(), 0, "nothing was queued for delivery");
	return cs;
};

Deno.test("a new FIFO adopts approved, unlanded changes from the stream and lands them", async () => {
	const k = fifo();
	try {
		const cs = history(k);
		await k.adopt();
		// Adopted: only the person-approved change still submitted at its head.
		equal(entryOf(k, cs[0])?.state, "waiting");
		equal(entryOf(k, cs[0])?.reason, "adopted");
		equal(k.emittedOf("queue.enqueued").map((e) => e.data.changeId), [
			cs[0].changeId,
		]);
		ok(
			k.emittedOf("queue.enqueued")[0].idemKey?.startsWith("adopted:"),
			"the adoption's own idempotency key",
		);
		// The by-exception approval is declined, and the change is told once.
		const told = k.emittedOf("queue.ejected");
		equal(told.map((e) => [e.data.changeId, e.data.reason]), [
			[cs[1].changeId, "withdrawn"],
		]);
		ok(String(told[0].data.message).includes("a person approved"));
		// Landed, abandoned or a stale head: no entry waits for them, and
		// nothing is said about them. The one in the Weave's batch waits,
		// unannounced and never batched here, until that batch is over.
		equal(entryOf(k, cs[2])?.state, "landed");
		equal(entryOf(k, cs[3])?.state, "withdrawn");
		equal(
			[entryOf(k, cs[4])?.state, entryOf(k, cs[4])?.reason],
			["waiting", "adopting"],
		);
		equal(entryOf(k, cs[5])?.reason, "stale");
		// The adopted change lands, alone, with its approval in the K4 chain.
		const batches = await drain(k);
		equal(batches, [[cs[0].changeId]]);
		equal(k.violations, []);
		equal(k.refusals, []);
		// A second adoption run reads nothing new and says nothing; it looks
		// again soon while the Weave's batch holds cs[4].
		const before = k.emitted.length;
		await k.adopt();
		equal(k.emitted.length, before);
		equal(k.adoptAt(), k.clock.now + ADOPT_RECHECK_MS, "rechecks soon");
		// The Weave's batch landed cs[4]: it settles quietly here.
		k.append("changes.landed", {
			changeId: cs[4].changeId,
			commit: "e".repeat(40),
		}, { deliver: false });
		k.lanes.get(cs[4].laneId)!.state = "landed";
		await k.adopt();
		equal(entryOf(k, cs[4])?.state, "landed");
		equal(k.emitted.length, before);
		ok((k.adoptAt() ?? 0) >= k.clock.now + ADOPT_MS - 1, "re-armed");
		checkSchemas(k);
	} finally {
		k.close();
	}
});

Deno.test("a change the old provider's batch was landing is queued here when that batch fails", async () => {
	const k = fifo();
	try {
		// The Weave's batch holds the approved change C when the Owner swaps
		// queue@1 to FIFO; FIFO's adoption reads C's approval.
		const c = k.submitChange(1, { deliver: false });
		k.approve(c, { by: human, route: "human", deliver: false });
		k.lanes.get(c.laneId)!.state = "landing";
		k.discard();
		await k.adopt();
		equal([entryOf(k, c)?.state, entryOf(k, c)?.reason], [
			"waiting",
			"adopting",
		]);
		equal(k.emittedOf("queue.enqueued"), [], "not announced while landing");
		await k.settle();
		equal(k.submits, [], "never batched while another batch lands it");
		// The Weave's batch fails (conflict or tests): the lane is submitted
		// again, and the Weave, no longer the provider, releases it silently.
		k.lanes.get(c.laneId)!.state = "submitted";
		equal(k.adoptAt(), k.clock.now + ADOPT_RECHECK_MS);
		await k.adopt();
		equal(entryOf(k, c)?.reason, "adopted");
		equal(k.emittedOf("queue.enqueued").map((e) => e.data.changeId), [
			c.changeId,
		]);
		const batches = await drain(k);
		equal(batches, [[c.changeId]], "the approved change lands here");
		equal(k.violations, []);
		checkSchemas(k);
	} finally {
		k.close();
	}
});

Deno.test("adopted entries are not batched before the replay has read the whole stream", async () => {
	const k = fifo();
	try {
		const c = k.submitChange(1, { deliver: false });
		k.approve(c, { by: human, route: "human", deliver: false });
		// Noise after the approval: more than one adoption run can read.
		for (let i = 0; i < ADOPT_PAGES * 100 + 5; i += 1) {
			k.append("changes.abandoned", { changeId: `ch_noise${i}` }, {
				deliver: false,
			});
		}
		k.discard();
		await k.adopt();
		equal(entryOf(k, c)?.reason, "adopting");
		equal(k.adoptAt(), k.clock.now, "the replay continues at once");
		// A live approval meanwhile is queued, but the train does not take the
		// adopted change until the replay settles.
		const live = k.submitChange(2);
		k.approve(live, { by: human, route: "human" });
		await k.settle();
		equal(k.submits.map((s) => s.batch.map((x) => x.changeId)), [[
			live.changeId,
		]]);
		k.finish(k.inFlight()[0]);
		await k.settle();
		await k.adopt();
		equal(entryOf(k, c)?.reason, "adopted");
		const batches = await drain(k);
		equal(batches, [[live.changeId], [c.changeId]]);
		equal(k.violations, []);
	} finally {
		k.close();
	}
});

Deno.test("an installation that no longer provides queue@1 releases its queue quietly", async () => {
	const k = fifo();
	try {
		const [c1, c2] = [1, 2].map((n) => k.submitChange(n));
		k.approve(c1, { by: human, route: "human" });
		k.approve(c2, { by: human, route: "human" });
		await k.settle();
		equal(k.inFlight().length, 1, "c1 is landing");
		// The Owner swaps the repo's queue@1 to another installation.
		k.state.provider = "other";
		const emitted = k.emitted.length;
		k.finish(k.inFlight()[0]);
		await k.settle();
		// c1's batch finished; c2 was released, not landed, and nothing said.
		equal(entryOf(k, c1)?.state, "landed");
		equal(entryOf(k, c2)?.state, "withdrawn");
		equal(entryOf(k, c2)?.reason, "provider-changed");
		equal(k.submits.length, 1);
		equal(
			k.emitted.slice(emitted).map((e) => e.type),
			["queue.landed"],
		);
		// While another installation provides queue@1, the adoption keeps its
		// cursor: approvals made meanwhile are adopted once it provides again.
		const c3 = k.submitChange(3, { deliver: false });
		k.approve(c3, { by: human, route: "human", deliver: false });
		k.discard();
		await k.adopt();
		equal(entryOf(k, c3), undefined);
		k.state.provider = "self";
		await k.adopt();
		// c2 (released) and c3 are adopted again: both still submitted.
		equal(entryOf(k, c3)?.state, "waiting");
		const batches = await drain(k);
		equal(batches.slice(1).flat().sort(), [c2.changeId, c3.changeId].sort());
		equal(k.violations, []);
	} finally {
		k.close();
	}
});

Deno.test("the kernel's not-the-provider refusal of land.submit releases the queue too", async () => {
	const k = fifo();
	try {
		const [c1, c2] = [1, 2].map((n) => k.submitChange(n));
		// The swap lands between the probe and the submit: caps refuses.
		k.faults.push("not-provider");
		k.approve(c1, { by: human, route: "human" });
		k.approve(c2, { by: human, route: "human" });
		await k.settle();
		equal(k.refusals, ["land.submit: not the queue@1 provider in force"]);
		equal(entryOf(k, c1)?.reason, "provider-changed");
		equal(entryOf(k, c2)?.reason, "provider-changed");
		equal(k.inFlight().length, 0);
		// No pause: a refusal of this kind is a hand-over, not K1.
		equal(k.emittedOf("queue.paused"), []);
		equal(k.tickAt(), undefined, "the train stopped");
	} finally {
		k.close();
	}
});

Deno.test("with the kernel's provider check, a released Weave never lands after the swap", async () => {
	const k = fifo();
	try {
		k.state.kernelChecksProvider = true;
		const c = k.submitChange(1);
		k.approve(c, { by: human, route: "human" });
		k.state.provider = "none";
		await k.settle();
		equal(k.submits, []);
		equal(entryOf(k, c)?.reason, "provider-changed");
	} finally {
		k.close();
	}
});
