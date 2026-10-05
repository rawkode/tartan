// queue@1 provider hand-over for the Weave: a
// Weave that takes a repo over (installed nearer, re-enabled, or swapped
// back) adopts every approved, unlanded change, the by-exception review's
// included; one replaced on the repo releases its queue and does not land.

import { parseManifest } from "@tartan/contract";
import manifestJson from "../tartan.json" with { type: "json" };
import { extension, migrations } from "../src/index.ts";
import { ADOPT_PAGES, ADOPT_RECHECK_MS, SETTLE_MAX } from "../src/engine.ts";
import { equal, ok } from "./assert.ts";
import { createKernel, type Kernel, REPO } from "./kernel.ts";

const parsed = parseManifest(manifestJson);
if (!parsed.ok) throw new Error(parsed.errors.join("; "));
const manifest = parsed.manifest;

const weave = (): Kernel =>
	createKernel({
		module: extension,
		migrations,
		grants: manifest.permissions,
		extId: manifest.id,
		config: manifest.config?.default,
		batchTable: "batches",
	});

Deno.test("a Weave taking a repo over adopts automatic approvals too, and batches them", async () => {
	const k = weave();
	try {
		const quiet = { deliver: false };
		const cs = [1, 2, 3].map((n) => k.submitChange(n, quiet));
		for (const c of cs) k.approve(c, quiet);
		k.discard();
		await k.adopt();
		equal(
			k.emittedOf("queue.enqueued").map((e) => e.data.changeId),
			cs.map((c) => c.changeId),
		);
		equal(k.emittedOf("queue.ejected"), []);
		await k.settle();
		equal(k.submits.map((s) => s.batch.length), [3], "one batch of three");
		equal(k.violations, []);
	} finally {
		k.close();
	}
});

Deno.test("installed on a group (as a pack does), the Weave lands into the repo it serves", async () => {
	const k = createKernel({
		module: extension,
		migrations,
		grants: manifest.permissions,
		extId: manifest.id,
		config: manifest.config?.default,
		batchTable: "batches",
		installNode: { id: "01k6gggggggggggggggggggggg", path: "acme/platform" },
	});
	try {
		const c = k.submitChange(1);
		k.approve(c);
		await k.settle();
		equal(k.submits.map((s) => s.repo), [{ id: REPO }]);
		equal(k.violations, []);
	} finally {
		k.close();
	}
});

Deno.test("the replay never rewrites what the live path queued", async () => {
	const k = weave();
	try {
		const c = k.submitChange(1);
		// approve, request changes, approve again: all delivered live.
		k.approve(c);
		k.append("review.decided", {
			changeId: c.changeId,
			revision: c.revision,
			head: c.head,
			decision: "request_changes",
			route: "human",
			decidedBy: { kind: "user", id: "u_01k6vvvvvvvvvvvvvvvvvvvvv1" },
		});
		const again = k.approve(c);
		await k.deliver();
		const before = k.emittedOf("queue.enqueued").length;
		await k.adopt();
		const entry = k.entries().find((e) => e.change_id === c.changeId);
		equal([entry?.state, entry?.reason], ["waiting", null]);
		equal(k.emittedOf("queue.enqueued").length, before, "no second enqueue");
		ok(
			!k.emitted.some((e) => e.idemKey?.startsWith("adopted:")),
			"nothing was adopted",
		);
		await k.settle();
		equal(k.submits.length, 1);
		ok(k.submits[0].reason.events.includes(again.id), "the live approval");
	} finally {
		k.close();
	}
});

Deno.test("an approval the replay read before its live delivery is announced once", async () => {
	for (const order of ["delivery-first", "settle-first"] as const) {
		const k = weave();
		try {
			const c = k.submitChange(1);
			await k.deliver();
			const approval = k.approve(c, { deliver: false });
			if (order === "delivery-first") {
				// The replay has not reached the end of the stream yet.
				for (let i = 0; i < ADOPT_PAGES * 100 + 5; i += 1) {
					k.append("changes.abandoned", { changeId: `ch_noise${i}` }, {
						deliver: false,
					});
				}
				k.discard();
			}
			await k.adopt();
			k.release(approval);
			await k.deliver();
			if (order === "delivery-first") await k.adopt();
			const enqueued = k.emittedOf("queue.enqueued").filter((e) =>
				e.data.changeId === c.changeId
			);
			equal(enqueued.length, 1, `${order}: one queue.enqueued`);
			equal(enqueued[0].idemKey, `adopted:${approval.id}`, order);
			await k.settle();
			equal(k.submits.length, 1, order);
		} finally {
			k.close();
		}
	}
});

Deno.test("when the kernel cannot say who provides queue@1, the train waits", async () => {
	const k = weave();
	try {
		k.state.provider = "unknown";
		const c = k.submitChange(1);
		k.approve(c);
		await k.settle();
		equal(k.submits, [], "no landing as a possibly replaced queue");
		equal(k.entries().map((e) => e.state), ["waiting"]);
		ok((k.tickAt() ?? 0) > k.clock.now, "it tries again later");
		k.state.provider = "self";
		await k.fireTick();
		await k.settle();
		equal(k.submits.length, 1);
	} finally {
		k.close();
	}
});

Deno.test("a change another batch is landing leaves this queue without an ejection", async () => {
	const k = weave();
	try {
		const c = k.submitChange(1);
		// After a swap back: the other queue's batch holds the lane.
		k.lanes.get(c.laneId)!.state = "landing";
		k.approve(c);
		await k.settle();
		equal(k.submits.length, 1, "submitted once, refused");
		const entry = k.entries().find((e) => e.change_id === c.changeId);
		equal([entry?.state, entry?.reason], ["waiting", "adopting"]);
		equal(k.emittedOf("queue.ejected"), [], "no ejection");
		equal(k.notices, [], "the author is not told it failed");
		// That batch fails: the recheck queues the change here.
		k.lanes.get(c.laneId)!.state = "submitted";
		equal(k.adoptAt(), k.clock.now + ADOPT_RECHECK_MS);
		await k.adopt();
		await k.settle();
		equal(k.submits.length, 2, "submitted again, here");
		equal(k.violations, []);
	} finally {
		k.close();
	}
});

Deno.test("ref.advanced of a change waiting here (landed by another queue) settles it quietly", async () => {
	const k = weave();
	try {
		const c = k.submitChange(1);
		k.approve(c);
		await k.deliver();
		equal(k.entries().map((e) => e.state), ["waiting"]);
		k.append("ref.advanced", {
			ref: "refs/heads/main",
			old: k.state.trunk,
			new: "d".repeat(40),
			advanceId: "adv_elsewhere_1",
			changes: [{ changeId: c.changeId, commit: "d".repeat(40) }],
		});
		await k.deliver();
		equal(k.entries().map((e) => e.state), ["landed"]);
		equal(k.emittedOf("queue.landed"), []);
		await k.settle();
		equal(k.submits, []);
	} finally {
		k.close();
	}
});

Deno.test("adoption settles a large backlog in bounded runs", async () => {
	const k = weave();
	try {
		const quiet = { deliver: false };
		const cs = Array.from(
			{ length: SETTLE_MAX + 5 },
			(_, i) => k.submitChange(i + 1, quiet),
		);
		for (const c of cs) k.approve(c, quiet);
		k.discard();
		await k.adopt();
		equal(k.emittedOf("queue.enqueued").length, SETTLE_MAX);
		equal(k.adoptAt(), k.clock.now, "continues at once");
		await k.adopt();
		equal(k.emittedOf("queue.enqueued").length, cs.length);
		ok((k.adoptAt() ?? 0) > k.clock.now, "then every ADOPT_MS");
	} finally {
		k.close();
	}
});

Deno.test("a Weave replaced on its repo forms no batch and keeps quiet", async () => {
	const k = weave();
	try {
		k.state.provider = "other";
		const c = k.submitChange(1);
		k.approve(c);
		await k.settle();
		equal(k.submits, []);
		equal(
			k.entries().map((e) => [e.state, e.reason]),
			[["withdrawn", "provider-changed"]],
		);
		// Only the approval's own queue.enqueued was said (before the batch).
		equal(k.emittedOf("queue.batched"), []);
		ok(k.emittedOf("queue.ejected").length === 0);
	} finally {
		k.close();
	}
});
