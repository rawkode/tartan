// tartan.weave M1: enqueue on approve, serial batches of ≤ 4
// through `land.submit` with a stored batch id and a K4 reason chain,
// ejection with the notify-author floor, withdraw, pause, slots and context.
// Runs the real module and migrations against the fake land kernel.

import {
	type Envelope,
	parseManifest,
	QUEUE_EVENTS,
	QUEUE_TOOLS,
	type ToolContext,
	validateUi,
} from "@tartan/contract";
import manifestJson from "../tartan.json" with { type: "json" };
import { extension, migrations } from "../src/index.ts";
import { PAUSE_RETRY_MS, WATCH_MS } from "../src/engine.ts";
import { equal, ok, rejects } from "./assert.ts";
import {
	type ChangeModel,
	createKernel,
	type Kernel,
	MAINTAINER,
	REPO,
	STRANGER,
} from "./kernel.ts";

const parsed = parseManifest(manifestJson);
if (!parsed.ok) throw new Error(parsed.errors.join("; "));
const manifest = parsed.manifest;

const train = (
	o: {
		config?: Record<string, unknown>;
		mode?: "enforce" | "shadow";
		defaultBranch?: string;
		installNode?: { id: string; path: string };
	} = {},
): Kernel =>
	createKernel({
		module: extension,
		migrations,
		grants: manifest.permissions,
		extId: manifest.id,
		config: { ...manifest.config?.default, ...o.config },
		mode: o.mode,
		batchTable: "batches",
		...(o.defaultBranch ? { defaultBranch: o.defaultBranch } : {}),
		...(o.installNode ? { installNode: o.installNode } : {}),
	});

const ids = (cs: readonly ChangeModel[]): string[] => cs.map((c) => c.changeId);
const submittedEventOf = (k: Kernel, c: ChangeModel): Envelope =>
	k.log.find((e) =>
		e.type === "changes.submitted" &&
		(e.data as { changeId: string }).changeId === c.changeId
	)!;
const stateOf = (k: Kernel, c: ChangeModel): string | undefined =>
	k.entries().find((e) => e.change_id === c.changeId)?.state;
const toolCtx = (actorId: string): ToolContext => ({
	node: REPO,
	repo: REPO,
	scope: "acme/platform/router",
	actor: { kind: actorId.startsWith("u_") ? "user" : "agent", id: actorId },
	mode: "enforce",
});
/** Every queue event the Weave emitted matches its queue@1 schema (K10). */
const checkQueueEvents = (k: Kernel): void => {
	for (const e of k.emitted) {
		const schema = QUEUE_EVENTS[e.type as keyof typeof QUEUE_EVENTS];
		ok(schema, `unexpected event type ${e.type}`);
		ok(schema.safeParse(e.data).success, `${e.type} payload invalid`);
	}
};

Deno.test("the manifest asks for no queue@1 call: the provider check is a read", () => {
	const calls = manifest.permissions["interfaces.call"] ?? [];
	equal(calls.includes("queue@1"), false);
	equal([...calls].sort().join(","), "changes@1,work@1");
});

Deno.test("enqueue on approve: serial batches of at most 4, each with a K4 chain and the approved heads", async () => {
	const k = train();
	const cs = [1, 2, 3, 4, 5, 6].map((n) => k.submitChange(n));
	const approvals = cs.map((c) => k.approve(c));
	await k.settle();

	equal(k.emittedOf("queue.enqueued").map((e) => e.data.changeId), ids(cs));
	equal(k.submits.length, 1, "one batch in flight (serial)");
	const first = k.submits[0];
	equal(ids(cs.slice(0, 4)), first.batch.map((c) => c.changeId));
	equal(first.batch.map((c) => c.head), cs.slice(0, 4).map((c) => c.head));
	equal(first.ref, "refs/heads/main");
	equal(first.testPolicy, "checks");
	ok(first.batchId.startsWith("lb_"));
	ok(first.reason.summary.startsWith("weave batch 1"));
	for (const [i, c] of cs.slice(0, 4).entries()) {
		ok(first.reason.events.includes(submittedEventOf(k, c).id), "submitted");
		ok(first.reason.events.includes(approvals[i].id), "approval");
		const lc = first.batch[i];
		equal(lc.title, `Change ${c.n}`);
		equal(lc.message, `Summary of change ${c.n}`);
		equal(lc.trailers, [
			{ key: "Tartan-Change", value: c.changeId },
			{ key: "Tartan-Work", value: c.workRef },
			{ key: "Tartan-Review", value: "auto(0.12)" },
		]);
	}
	const queueIds = new Set(k.emitted.map((e) => e.id));
	ok(
		first.reason.events.every((id) => !queueIds.has(id)),
		"queue events never stand in for K4",
	);
	equal(k.violations, []);
	equal(k.refusals, []);

	// Nothing else is submitted while the batch is in flight.
	await k.settle();
	equal(k.submits.length, 1);
	equal(
		k.entries().map((e) => e.state),
		["landing", "landing", "landing", "landing", "waiting", "waiting"],
	);

	k.finish(first.batchId);
	await k.settle();
	equal(k.submits.length, 2);
	equal(k.submits[1].batch.map((c) => c.changeId), ids(cs.slice(4)));
	ok(k.submits[1].reason.summary.startsWith("weave batch 2"));
	k.finish(k.submits[1].batchId);
	await k.settle();

	equal(k.emittedOf("queue.landed").map((e) => e.data.changeId), ids(cs));
	ok(
		k.emittedOf("queue.landed").every((e) => typeof e.data.commit === "string"),
	);
	equal(k.entries().map((e) => e.state), cs.map(() => "landed"));
	equal(k.inFlight(), []);
	equal(k.emittedOf("queue.batched").length, 2);
	checkQueueEvents(k);
	k.close();
});

Deno.test("config batch is clamped to 1..4", async () => {
	for (const [batch, sizes] of [[10, [4, 1]], [1, [1, 1, 1, 1, 1]]] as const) {
		const k = train({ config: { batch } });
		const cs = [1, 2, 3, 4, 5].map((n) => k.submitChange(n));
		cs.forEach((c) => k.approve(c));
		await k.settle();
		while (k.inFlight().length > 0) {
			k.finish(k.inFlight()[0]);
			await k.settle();
		}
		equal(k.submits.map((s) => s.batch.length), sizes, `batch ${batch}`);
		k.close();
	}
});

Deno.test("a tick retried after a lost response resubmits the same stored batch and creates no second batch", async () => {
	for (const fault of ["lost-silent", "unavailable", "lane-git-job"] as const) {
		const k = train();
		const cs = [1, 2].map((n) => k.submitChange(n));
		cs.forEach((c) => k.approve(c));
		k.faults.push(fault);
		await k.settle();
		equal(k.submits.length, 2, `${fault}: retried once`);
		equal(k.submits[0], k.submits[1], `${fault}: identical request`);
		equal(k.batches.size, 1, `${fault}: one batch`);
		equal(
			k.emittedOf("queue.batched").length,
			1,
			`${fault}: one queue.batched`,
		);
		equal(k.entries().map((e) => e.state), ["landing", "landing"]);
		equal(k.violations, [], `${fault}: stored before submit`);
		k.finish(k.submits[0].batchId);
		await k.settle();
		equal(k.entries().map((e) => e.state), ["landed", "landed"]);
		k.close();
	}
});

Deno.test("a lost answer confirmed by land.submitted is not resubmitted", async () => {
	const k = train();
	const c = k.submitChange(1);
	k.approve(c);
	k.faults.push("lost");
	await k.settle();
	equal(k.submits.length, 1);
	equal(k.entries().map((e) => e.state), ["landing"]);
	k.close();
});

Deno.test("changes.revised withdraws a waiting entry; it lands later at the newly approved head", async () => {
	const k = train();
	const [c1, c2] = [1, 2].map((n) => k.submitChange(n));
	k.approve(c1);
	k.approve(c2);
	const oldHead = c1.head;
	k.pushRevision(c1);
	await k.settle();
	const ejected = k.emittedOf("queue.ejected");
	equal(ejected.map((e) => [e.data.changeId, e.data.reason]), [
		[c1.changeId, "stale"],
	]);
	equal(k.submits[0].batch.map((c) => c.changeId), [c2.changeId]);

	k.approve(c1); // review approves revision 2
	k.finish(k.submits[0].batchId);
	await k.settle();
	const second = k.submits[1];
	equal(second.batch.map((c) => [c.changeId, c.head]), [[
		c1.changeId,
		c1.head,
	]]);
	ok(c1.head !== oldHead);
	const revised = k.log.find((e) => e.type === "changes.revised")!;
	ok(
		second.reason.events.includes(revised.id),
		"the landed revision is in the chain",
	);
	k.finish(second.batchId);
	await k.settle();
	equal(stateOf(k, c1), "landed");
	equal(k.refusals, []);
	k.close();
});

Deno.test("a lane pushed after approval is not landed at its old head (head-moved drops it)", async () => {
	const k = train();
	const [c1, c2, c3] = [1, 2, 3].map((n) => k.submitChange(n));
	[c1, c2, c3].forEach((c) => k.approve(c));
	const oldHead = c2.head;
	// The push happened, its changes.revised is not delivered yet.
	k.pushRevision(c2, { deliver: false });
	await k.settle();

	ok(k.refusals.some((r) => /head-moved|moved/.test(r)), "refused head-moved");
	equal(k.batches.size, 1);
	const created = [...k.batches.values()][0].request;
	equal(created.batch.map((c) => c.changeId), [c1.changeId, c3.changeId]);
	ok(
		k.submits.every((s) =>
			!s.batch.some((c) => c.changeId === c2.changeId && c.head !== oldHead) &&
			(k.batches.get(s.batchId)?.request.batch ?? []).every((c) =>
				c.changeId !== c2.changeId
			)
		),
		"c2 never landed at its old head",
	);
	equal(stateOf(k, c2), "withdrawn");
	equal(
		k.emittedOf("queue.ejected").map((e) => [e.data.changeId, e.data.reason]),
		[[c2.changeId, "stale"]],
	);

	// The revision arrives, review approves it, and it lands at the new head.
	k.release(k.log.find((e) => e.type === "changes.revised")!);
	k.approve(c2);
	k.finish(created.batchId);
	await k.settle();
	const last = k.submits[k.submits.length - 1];
	equal(last.batch.map((c) => [c.changeId, c.head]), [[c2.changeId, c2.head]]);
	k.close();
});

Deno.test("conflict ejects the change and notifies its author with both intents, the other diff and the regions", async () => {
	const k = train();
	const cs = [1, 2, 3].map((n) => k.submitChange(n));
	cs.forEach((c) => k.approve(c));
	await k.settle();
	const batchId = k.submits[0].batchId;
	const [c1, c2, c3] = cs;
	k.finish(batchId, {
		conflicted: [{
			changeId: c2.changeId,
			paths: ["services/api/src/middleware/limit.ts"],
			conflictsWith: [c1.changeId],
		}],
	});
	await k.settle();

	equal(stateOf(k, c1), "landed");
	equal(stateOf(k, c2), "ejected");
	equal(stateOf(k, c3), "landed");
	const ej = k.emittedOf("queue.ejected");
	equal(ej.length, 1);
	equal(ej[0].data, {
		changeId: c2.changeId,
		reason: "conflict",
		paths: ["services/api/src/middleware/limit.ts"],
		conflictsWith: [c1.changeId],
	});
	equal(k.notices.length, 1);
	const { principal, notice } = k.notices[0];
	equal(principal, c2.author);
	equal(notice.kind, "eject");
	equal(notice.laneId, c2.laneId);
	const text = String(notice.text);
	ok(text.includes("intent 2") && text.includes("intent 1"), text);
	ok(text.includes("services/api/src/middleware/limit.ts"), text);
	ok(text.includes(c1.changeId), text);
	const data = notice.data as {
		intents: { mine: { title: string }; theirs: { title: string }[] };
		others: { changeId: string; paths: string[] }[];
		regions: { path: string }[];
		conflictsWith: string[];
	};
	equal(data.intents.mine.title, "intent 2");
	equal(data.intents.theirs.map((i) => i.title), ["intent 1"]);
	equal(data.others[0].changeId, c1.changeId);
	equal(data.others[0].paths, c1.paths);
	equal(data.regions.map((r) => r.path), [
		"services/api/src/middleware/limit.ts",
	]);

	// An ejected conflict needs a new revision: re-enqueueing the same head is refused.
	await rejects(
		() =>
			k.harness.tool(
				"queue_enqueue",
				{ changeId: c2.changeId },
				toolCtx(c2.author),
			),
		/new revision/,
	);
	k.pushRevision(c2);
	k.approve(c2);
	await k.settle();
	equal(k.submits[1].batch.map((c) => [c.changeId, c.head]), [[
		c2.changeId,
		c2.head,
	]]);
	checkQueueEvents(k);
	k.close();
});

Deno.test("veto ejects and notifies the author with the gate message", async () => {
	const k = train();
	const [c1, c2] = [1, 2].map((n) => k.submitChange(n));
	k.approve(c1);
	k.approve(c2);
	await k.settle();
	k.finish(k.submits[0].batchId, {
		vetoed: [{ changeId: c1.changeId, message: "secret found in config.ts" }],
	});
	await k.settle();
	equal(stateOf(k, c1), "ejected");
	equal(stateOf(k, c2), "landed");
	equal(k.emittedOf("queue.ejected").map((e) => e.data.reason), ["veto"]);
	equal(k.notices.length, 1);
	ok(String(k.notices[0].notice.text).includes("secret found in config.ts"));
	k.close();
});

Deno.test("a failing batch retries each change alone; only the culprit is ejected", async () => {
	const k = train();
	const [c1, c2] = [1, 2].map((n) => k.submitChange(n));
	k.approve(c1);
	k.approve(c2);
	await k.settle();
	k.finish(k.submits[0].batchId, {
		failed: { reason: "tests", failing: ["api:test"] },
	});
	await k.settle();
	equal(k.submits[1].batch.map((c) => c.changeId), [c1.changeId], "c1 alone");
	k.finish(k.submits[1].batchId);
	await k.settle();
	equal(k.submits[2].batch.map((c) => c.changeId), [c2.changeId], "c2 alone");
	k.finish(k.submits[2].batchId, {
		failed: { reason: "tests", failing: ["api:test"] },
	});
	await k.settle();
	equal(stateOf(k, c1), "landed");
	equal(stateOf(k, c2), "ejected");
	equal(
		k.emittedOf("queue.ejected").map((e) => [e.data.changeId, e.data.reason]),
		[
			[c2.changeId, "failure"],
		],
	);
	equal(k.notices.map((n) => n.principal), [c2.author]);
	ok(String(k.notices[0].notice.text).includes("api:test"));
	equal(k.inFlight(), []);
	k.close();
});

Deno.test("non-test failures requeue the batch; an entry requeued too often is ejected", async () => {
	const k = train();
	const c = k.submitChange(1);
	k.approve(c);
	await k.settle();
	for (let i = 0; i < 3; i += 1) {
		k.finish(k.submits[i].batchId, { failed: { reason: "stale" } });
		await k.settle();
		equal(k.submits.length, i + 2, `requeue ${i + 1}`);
	}
	k.finish(k.submits[3].batchId, { failed: { reason: "abandoned" } });
	await k.settle();
	equal(k.submits.length, 4);
	equal(stateOf(k, c), "ejected");
	k.close();
});

Deno.test("K9: a batch the repository-config hold returned (config-hold) is requeued and resubmitted, never ejected", async () => {
	const k = train();
	const c = k.submitChange(1);
	k.approve(c);
	await k.settle();
	for (let i = 0; i < 5; i += 1) {
		k.finish(k.submits[i].batchId, { failed: { reason: "config-hold" } });
		await k.settle();
		await k.fireTick();
		await k.settle();
		equal(k.submits.length, i + 2, `resubmitted after hold ${i + 1}`);
		equal(stateOf(k, c), "landing");
	}
	equal(k.emittedOf("queue.ejected").length, 0, "a delay, never an ejection");
	k.finish(k.submits[5].batchId);
	await k.settle();
	equal(stateOf(k, c), "landed");
	k.close();
});

Deno.test("queue_withdraw: a waiting entry leaves at once; a batched one only when its batch ends", async () => {
	const k = train();
	const [c1, c2, c3] = [1, 2, 3].map((n) => k.submitChange(n));
	k.approve(c1);
	// Before the debounced tick: c1 is waiting.
	await k.deliver();
	await rejects(
		() =>
			k.harness.tool(
				"queue_withdraw",
				{ changeId: c1.changeId },
				toolCtx(STRANGER),
			),
		/author or a Maintainer/,
	);
	const out = await k.harness.tool(
		"queue_withdraw",
		{ changeId: c1.changeId, reason: "not ready" },
		toolCtx(c1.author),
	);
	ok(QUEUE_TOOLS.queue_withdraw.output.safeParse(out).success);
	equal(stateOf(k, c1), "withdrawn");
	equal(k.emittedOf("queue.ejected").map((e) => e.data.reason), ["withdrawn"]);
	await k.settle();
	equal(k.submits.length, 0, "a withdrawn entry is never submitted");

	k.approve(c2);
	k.approve(c3);
	await k.settle();
	equal(k.submits[0].batch.map((c) => c.changeId), [c2.changeId, c3.changeId]);
	// A Maintainer withdraws c2 while it is landing: it stays until the batch ends.
	await k.harness.tool(
		"queue_withdraw",
		{ changeId: c2.changeId },
		toolCtx(MAINTAINER),
	);
	equal(stateOf(k, c2), "landing");
	k.finish(k.submits[0].batchId, { failed: { reason: "error" } });
	await k.settle();
	equal(stateOf(k, c2), "withdrawn");
	equal(k.submits[1].batch.map((c) => c.changeId), [c3.changeId]);
	k.close();
});

Deno.test("only the author or a Maintainer+ undoes a withdrawal; another Developer's queue_enqueue is denied", async () => {
	const k = train();
	const [c1, c2] = [1, 2].map((n) => k.submitChange(n));
	k.approve(c1);
	await k.deliver();
	await k.harness.tool(
		"queue_withdraw",
		{ changeId: c1.changeId, reason: "found a problem" },
		toolCtx(c1.author),
	);
	equal(stateOf(k, c1), "withdrawn");
	// Another agent (a Developer) cannot put it back under the author's name.
	await rejects(
		() =>
			k.harness.tool(
				"queue_enqueue",
				{ changeId: c1.changeId },
				toolCtx(STRANGER),
			),
		/author or a Maintainer/,
	);
	equal(stateOf(k, c1), "withdrawn");
	await k.settle();
	equal(k.submits.length, 0, "the withdrawn change is not landed");
	// The author can.
	const back = await k.harness.tool(
		"queue_enqueue",
		{ changeId: c1.changeId },
		toolCtx(c1.author),
	);
	equal((back as { state: string }).state, "waiting");
	// A pending withdrawal of a batched change: the same rule.
	k.approve(c2);
	await k.settle();
	equal(k.submits[0].batch.map((c) => c.changeId), [
		c1.changeId,
		c2.changeId,
	]);
	await k.harness.tool(
		"queue_withdraw",
		{ changeId: c2.changeId },
		toolCtx(c2.author),
	);
	await rejects(
		() =>
			k.harness.tool(
				"queue_enqueue",
				{ changeId: c2.changeId },
				toolCtx(STRANGER),
			),
		/author or a Maintainer/,
	);
	k.close();
});

Deno.test("a repo whose default branch is not main lands on its default branch", async () => {
	const k = train({ defaultBranch: "master" });
	const c = k.submitChange(1);
	k.approve(c);
	await k.settle();
	equal(k.submits.length, 1);
	equal(k.submits[0].ref, "refs/heads/master");
	equal(k.refusals.length, 0, k.refusals.join("; "));
	k.finish(k.submits[0].batchId);
	await k.settle();
	equal(stateOf(k, c), "landed");
	k.close();
});

Deno.test("a batched change whose withdrawal is pending still lands if its batch lands", async () => {
	const k = train();
	const c = k.submitChange(1);
	k.approve(c);
	await k.settle();
	await k.harness.tool(
		"queue_withdraw",
		{ changeId: c.changeId },
		toolCtx(c.author),
	);
	k.finish(k.submits[0].batchId);
	await k.settle();
	equal(stateOf(k, c), "landed");
	k.close();
});

Deno.test("landing paused (K1): queue.paused once, the minted batch waits and resubmits unchanged", async () => {
	const k = train();
	const c = k.submitChange(1);
	k.approve(c);
	k.state.landingPaused = true;
	await k.settle();
	equal(k.emittedOf("queue.paused").length, 1);
	equal(k.batches.size, 0);
	const at = k.tickAt();
	ok(at !== undefined && at >= k.clock.now + PAUSE_RETRY_MS - 10);
	await k.fireTick();
	equal(k.emittedOf("queue.paused").length, 1, "one queue.paused per pause");
	k.state.landingPaused = false;
	await k.fireTick();
	equal(k.batches.size, 1);
	ok(
		k.submits.every((s) => s.batchId === k.submits[0].batchId),
		"same batch id",
	);
	const status = await k.harness.tool("queue_status", {
		repo: "acme/platform/router",
	}, toolCtx(c.author));
	equal((status as { paused: boolean }).paused, false);
	k.close();
});

Deno.test("refusals: a quarantined lane is ejected and the rest proceed; an unexplained refusal retries alone, then ejects", async () => {
	const k = train();
	const [c1, c2] = [1, 2].map((n) => k.submitChange(n));
	k.approve(c1);
	k.approve(c2);
	k.lanes.get(c1.laneId)!.quarantined = true;
	await k.settle();
	equal(stateOf(k, c1), "ejected");
	equal(k.batches.size, 1);
	equal([...k.batches.values()][0].request.batch.map((c) => c.changeId), [
		c2.changeId,
	]);
	k.close();

	const j = train();
	const [d1, d2] = [1, 2].map((n) => j.submitChange(n));
	const bad = j.approve(d1);
	j.approve(d2);
	// The approval of d1 vanishes from the log: K4 fails without a lane culprit.
	j.log.splice(j.log.indexOf(bad), 1);
	await j.settle();
	equal(stateOf(j, d1), "ejected");
	equal(stateOf(j, d2), "landing");
	equal(j.submits.map((s) => s.batch.map((c) => c.changeId)), [
		[d1.changeId, d2.changeId],
		[d1.changeId],
		[d2.changeId],
	]);
	ok(String(j.notices[0].notice.text).includes("refused"));
	j.close();
});

Deno.test("K13.3 at land.submit: a policy change without its sign-off is ejected, the train goes on; two policy changes land one at a time", async () => {
	const k = train();
	const [c1, c2] = [1, 2].map((n) => k.submitChange(n));
	k.state.policy.set(c1.changeId, false);
	k.approve(c1);
	k.approve(c2);
	await k.settle();
	equal(stateOf(k, c1), "ejected");
	equal(stateOf(k, c2), "landing");
	equal(k.emittedOf("queue.paused").length, 0, "the train is not paused");
	const ejected = k.emittedOf("queue.ejected").find((e) =>
		e.data.changeId === c1.changeId
	);
	ok(ejected !== undefined, "queue.ejected for the unsigned change");
	equal(ejected.data.reason, "veto");
	equal(ejected.data.code, "policy-signoff", "the ejection names the refusal");
	ok(
		k.notices.some((n) => String(n.notice.text).includes("policy-signoff")),
		"the author is told why",
	);
	equal(k.submits.map((s) => s.batch.map((c) => c.changeId)), [
		[c1.changeId, c2.changeId],
		[c2.changeId],
	]);
	checkQueueEvents(k);
	k.close();

	// Two signed-off policy changes in one batch: each is retried alone.
	const j = train();
	const [d1, d2] = [1, 2].map((n) => j.submitChange(n));
	j.state.policy.set(d1.changeId, true);
	j.state.policy.set(d2.changeId, true);
	j.approve(d1);
	j.approve(d2);
	await j.settle();
	equal(j.emittedOf("queue.paused").length, 0);
	equal(j.submits.map((s) => s.batch.map((c) => c.changeId)), [
		[d1.changeId, d2.changeId],
		[d1.changeId],
	]);
	equal(stateOf(j, d1), "landing");
	equal(stateOf(j, d2), "waiting");
	j.close();
});

Deno.test("K13.3 at land.submit: a change whose diff is not known yet (policy-unknown) is retried with backoff, never ejected, and lands once its diff is known", async () => {
	const k = train();
	const [c1, c2] = [1, 2].map((n) => k.submitChange(n));
	k.state.policyUnknown.add(c1.changeId);
	k.approve(c1);
	k.approve(c2);
	// Within the first backoffs (5 s, 10 s, 20 s, …) the batch is resubmitted
	// as is: no ejection, no pause.
	await k.settle(60_000);
	ok(k.submits.length >= 2, `retried (${k.submits.length} submits)`);
	ok(
		k.submits.every((sub) =>
			sub.batch.map((c) => c.changeId).join() ===
				[c1.changeId, c2.changeId].join()
		),
		"the same stored batch",
	);
	equal(k.emittedOf("queue.ejected").length, 0, "nothing is ejected");
	equal(k.emittedOf("queue.paused").length, 0, "the train is not paused");
	equal(k.entries().map((e) => e.state), ["batched", "batched"]);
	// Phase 2 arrives: the diff is known and touches no policy path.
	k.state.policyUnknown.delete(c1.changeId);
	// The next backoff is due within this horizon; the 5-minute watchdog is not.
	await k.settle(200_000);
	equal(k.entries().map((e) => e.state), ["landing", "landing"]);
	equal(k.emittedOf("queue.ejected").length, 0);
	k.finish(k.inFlight()[0]);
	await k.settle();
	equal(k.entries().map((e) => e.state), ["landed", "landed"]);
	checkQueueEvents(k);
	k.close();
});

Deno.test("watchdog: a lost land.completed is recovered from land.status", async () => {
	const k = train();
	const [c1, c2] = [1, 2].map((n) => k.submitChange(n));
	k.approve(c1);
	await k.settle();
	k.approve(c2);
	await k.settle();
	k.finish(k.submits[0].batchId, { silent: true });
	await k.settle();
	equal(stateOf(k, c1), "landing", "no event delivered");
	const at = k.tickAt();
	ok(at !== undefined && at <= k.clock.now + WATCH_MS);
	await k.fireTick();
	equal(stateOf(k, c1), "landed");
	equal(k.emittedOf("queue.landed").length, 1);
	await k.settle();
	equal(k.submits[1].batch.map((c) => c.changeId), [c2.changeId]);
	k.close();
});

Deno.test("approvals: shadow, stale and late ones; a change submitted before the Weave saw it", async () => {
	const k = train();
	const c1 = k.submitChange(1);
	k.approve(c1, { shadow: true });
	await k.settle();
	equal(k.entries(), [], "shadow approvals never enqueue");

	k.pushRevision(c1);
	k.approve(c1, { head: c1.head }); // revision 2
	k.append("review.decided", {
		changeId: c1.changeId,
		revision: 1,
		head: "0".repeat(39) + "1",
		decision: "approve",
		route: "auto",
		decidedBy: { kind: "ext", id: "x_i_01k6vvvvvvvvvvvvvvvvvvvvvv" },
	});
	await k.settle();
	equal(
		k.submits.map((s) => s.batch.map((c) => c.head)),
		[[c1.head]],
		"older revision ignored",
	);
	k.close();

	// Installed late: changes.submitted was never delivered, so the Weave
	// finds it in the repo stream (events.read) for the K4 chain.
	// 150 other submits first: the scan must page past caps' 100-event page.
	const late = train();
	for (let n = 10; n < 160; n += 1) late.submitChange(n, { deliver: false });
	const c = late.submitChange(7, { deliver: false });
	late.approve(c);
	await late.settle();
	equal(late.submits.length, 1);
	ok(late.submits[0].reason.events.includes(submittedEventOf(late, c).id));
	equal(late.refusals, []);
	late.close();
});

Deno.test("abandoned while waiting is withdrawn; shadow installations never submit", async () => {
	const k = train();
	const c = k.submitChange(1);
	k.approve(c);
	k.append("changes.abandoned", { changeId: c.changeId, laneId: c.laneId });
	await k.settle();
	equal(stateOf(k, c), "withdrawn");
	equal(k.submits.length, 0);
	k.close();

	const s = train({ mode: "shadow" });
	const d = s.submitChange(1);
	s.approve(d);
	await s.settle();
	equal(s.submits.length, 0);
	s.close();
});

Deno.test("queue_status and queue_enqueue (the K12 precondition)", async () => {
	const k = train();
	const [c1, c2, c3] = [1, 2, 3].map((n) =>
		k.submitChange(n, {
			affected: n === 3 ? [] : ["api", "shared"],
		})
	);
	k.approve(c1);
	await k.settle();
	k.approve(c2);
	k.approve(c3);
	await k.deliver();
	const status = await k.harness.tool("queue_status", {
		repo: "acme/platform/router",
	}, toolCtx(MAINTAINER));
	ok(QUEUE_TOOLS.queue_status.output.safeParse(status).success);
	const st = status as {
		partitions: {
			key: string;
			entries: { changeId: string; position: number; state: string }[];
		}[];
	};
	equal(
		st.partitions.map((
			p,
		) => [p.key, p.entries.map((e) => [e.changeId, e.state, e.position])]),
		[
			["api,shared", [[c1.changeId, "landing", 0], [
				c2.changeId,
				"waiting",
				1,
			]]],
			["*", [[c3.changeId, "waiting", 2]]],
		],
	);

	// Background caller without an approval: denied (K12); with one: allowed.
	const bg = k.harness.ctx();
	const c4 = k.submitChange(4);
	await k.deliver();
	await rejects(
		() =>
			extension.callTool!(
				"queue_enqueue",
				{ changeId: c4.changeId },
				toolCtx(MAINTAINER),
				bg,
			),
		/actor/,
	);
	await k.harness.tool(
		"queue_withdraw",
		{ changeId: c2.changeId },
		toolCtx(c2.author),
	);
	const back = await extension.callTool!(
		"queue_enqueue",
		{ changeId: c2.changeId },
		toolCtx(MAINTAINER),
		bg,
	);
	ok(QUEUE_TOOLS.queue_enqueue.output.safeParse(back).success);
	equal((back as { state: string }).state, "waiting");
	await rejects(
		() =>
			k.harness.tool(
				"queue_enqueue",
				{ changeId: "not-a-change" },
				toolCtx(MAINTAINER),
			),
		/invalid/,
	);
	k.close();
});

Deno.test("slots: the Weave tab, the change sidebar position, the HUD metric and the withdraw action", async () => {
	const k = train();
	const [c1, c2] = [1, 2].map((n) => k.submitChange(n));
	k.approve(c1);
	await k.settle();
	k.approve(c2);
	await k.deliver();
	const ro = k.harness.ctx({
		readOnly: true,
		actor: { kind: "user", id: MAINTAINER },
	});
	const ctx = { node: REPO, repo: REPO, mode: "enforce" as const };
	const tab = await extension.render!(
		"weave",
		{ ...ctx, slot: "repo.tab" },
		{},
		ro,
	);
	ok(validateUi(tab).ok, "tab is valid tartan-ui@1");
	const tabText = JSON.stringify(tab);
	ok(tabText.includes(c1.changeId) && tabText.includes(c2.changeId));
	ok(tabText.includes("Withdraw"));
	const side = await extension.render!(
		"position",
		{
			...ctx,
			slot: "change.sidebar",
			entity: { kind: "change", id: c2.changeId },
		},
		{},
		ro,
	);
	ok(validateUi(side).ok);
	ok(JSON.stringify(side).includes("waiting"));
	const none = await extension.render!(
		"position",
		{
			...ctx,
			slot: "change.sidebar",
			entity: { kind: "change", id: "k".repeat(32) },
		},
		{},
		ro,
	);
	ok(validateUi(none).ok);
	k.finish(k.submits[0].batchId);
	await k.deliver();
	const hud = await extension.render!(
		"landed-per-hour",
		{ ...ctx, slot: "hud.metric" },
		{},
		ro,
	);
	ok(validateUi(hud).ok);
	ok(JSON.stringify(hud).includes('"value":1'));

	const done = await k.harness.action(
		"withdraw",
		{ changeId: c2.changeId },
		{ ...ctx, slot: "repo.tab", viewer: { kind: "agent", id: c2.author } },
		{ actor: { kind: "agent", id: c2.author } },
	);
	equal(done.toast?.tone, "success");
	equal(stateOf(k, c2), "withdrawn");
	k.close();
});

Deno.test("context: weave-health tells a lane where its change stands", async () => {
	const k = train();
	const [c1, c2] = [1, 2].map((n) => k.submitChange(n));
	k.approve(c1);
	await k.settle();
	k.approve(c2);
	await k.deliver();
	const sections = await k.harness.context({
		repo: "acme/platform/router",
		repoId: REPO,
		laneId: c2.laneId,
		maxBytes: 1024,
		actor: { kind: "agent", id: c2.author },
	});
	equal(sections.length, 1);
	equal(sections[0].id, "weave-health");
	ok(
		sections[0].md.includes(`${c2.changeId} is waiting at position 1`),
		sections[0].md,
	);
	ok(sections[0].md.includes("2 change(s)"));
	k.close();
});

Deno.test("a later request_changes of the approved head withdraws the waiting entry", async () => {
	const k = train();
	const [c1, c2] = [1, 2].map((n) => k.submitChange(n));
	k.approve(c1);
	k.approve(c2);
	k.append("review.decided", {
		changeId: c1.changeId,
		revision: 1,
		head: c1.head,
		decision: "request_changes",
		route: "human",
		decidedBy: { kind: "user", id: MAINTAINER },
	});
	await k.settle();
	equal(stateOf(k, c1), "withdrawn");
	equal(k.submits.map((s) => s.batch.map((c) => c.changeId)), [[c2.changeId]]);
	k.close();
});

Deno.test("an installation on a group lands each repo's queue in that repo (its instance's repo scope)", async () => {
	// e2e: the Swarm pack is installed on a group; every tick asked caps for
	// the group as a repo ("repo is not a repo") and nothing ever landed.
	const k = train({
		installNode: { id: "01k6grp0000000000000000000", path: "acme/platform" },
	});
	const cs = [1, 2].map((n) => k.submitChange(n));
	cs.forEach((c) => k.approve(c));
	await k.settle();
	equal(k.refusals, []);
	equal(k.violations, []);
	equal(k.submits.length, 1);
	equal(k.submits[0].repo, { id: REPO });
	k.finish(k.submits[0].batchId);
	await k.settle();
	equal(k.entries().map((e) => e.state), ["landed", "landed"]);
	k.close();
});
