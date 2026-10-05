// tartan.changes: drafts on lane.opened (never lane.opening),
// submit with the lane range, revisions on push.diffed, the refusals
// (empty-lane, opening, quarantined, K16 for an agent's sourceRef), states
// from review/queue/land, changes.landed exactly once, threads and renders.

import { deepStrictEqual, equal, ok } from "./assert.ts";
import {
	CHANGES_TOOLS,
	ChangeSchema,
	fromRpcError,
	isChangeId,
	unavailable,
	validateUi,
} from "@tartan/contract";
import { formsIn, formSubmission } from "@tartan/ext-api/testing.ts";
import {
	AGENT,
	agentActor,
	createChangesHarness,
	diffed,
	event,
	LANE,
	lane,
	manifest,
	opened,
	otherActor,
	REPO,
	REPO_PATH,
	sha,
	toolCtx,
	TRUNK,
	USER,
	userActor,
	WORK_REF,
} from "./helpers.ts";

const reason = async (p: Promise<unknown>): Promise<string> => {
	try {
		await p;
	} catch (error) {
		const e = fromRpcError(error);
		return `${e.code}${e.reason ? `(${e.reason})` : ""}`;
	}
	return "ok";
};

type Change = {
	changeId: string;
	state: string;
	revisions: { n: number; head: string; base: string; affected: string[] }[];
};

const get = async (
	h: ReturnType<typeof createChangesHarness>,
	changeId: string,
) => await h.tool("changes_get", { changeId }, toolCtx(userActor)) as Change;

const submit = (
	h: ReturnType<typeof createChangesHarness>,
	actor = agentActor,
) =>
	h.tool("changes_submit", {
		laneId: LANE,
		title: "Token bucket rate limiting",
		summary: "Adds a token bucket in the API middleware",
	}, toolCtx(actor)) as Promise<{ changeId: string; revision: number }>;

Deno.test("lane.opened starts a draft (changes.opened); lane.opening does not; redelivery is a no-op", async () => {
	const h = createChangesHarness();
	try {
		const l = lane(LANE, AGENT);
		h.lanes.set(LANE, l);
		await h.event(event("lane.opening", {
			laneId: LANE,
			owner: AGENT,
			base: TRUNK,
			mode: "repo",
		}));
		deepStrictEqual(h.types(), []);
		const ev = opened(l);
		await h.event(ev);
		await h.event(ev);
		const emitted = h.emitted();
		equal(emitted.length, 1);
		equal(emitted[0].type, "changes.opened");
		const changeId = emitted[0].data.changeId as string;
		ok(isChangeId(changeId));
		equal(emitted[0].data.workRef, WORK_REF);
		const change = await get(h, changeId);
		ok(ChangeSchema.safeParse(change).success);
		equal(change.state, "draft");
		deepStrictEqual(change.revisions, []);
		equal((change as unknown as { author: string }).author, AGENT);
		equal((change as unknown as { onBehalfOf: string }).onBehalfOf, USER);
	} finally {
		h.close();
	}
});

Deno.test("submit: refused for an unpushed lane (empty-lane), an opening lane, a quarantined lane and a non-owner", async () => {
	const h = createChangesHarness();
	try {
		h.lanes.set(LANE, lane(LANE, AGENT));
		equal(await reason(submit(h)), "conflict(empty-lane)");
		h.lanes.set(LANE, lane(LANE, AGENT, { mode: "repo", state: "opening" }));
		equal(await reason(submit(h)), "conflict(lane-opening)");
		// A repo lane that opened but was never pushed (head = base).
		h.lanes.set(LANE, lane(LANE, AGENT, { mode: "repo", head: TRUNK }));
		equal(await reason(submit(h)), "conflict(empty-lane)");
		h.lanes.set(
			LANE,
			lane(LANE, AGENT, { quarantined: true, head: sha("b"), pushes: 1 }),
		);
		equal(await reason(submit(h)), "conflict(lane-quarantined)");
		h.lanes.set(
			LANE,
			lane(LANE, AGENT, { state: "landing", head: sha("b"), pushes: 1 }),
		);
		equal(await reason(submit(h)), "conflict(lane-landing)");
		h.lanes.set(LANE, lane(LANE, AGENT, { head: sha("b"), pushes: 1 }));
		equal(await reason(submit(h, otherActor)), "denied(lane-op)");
		deepStrictEqual(h.types(), []);
	} finally {
		h.close();
	}
});

Deno.test("a submit right after a push (phase 2 pending) records the pushed head and the range base; the late push.diffed adds nothing", async () => {
	const h = createChangesHarness();
	try {
		const l = lane(LANE, AGENT);
		h.lanes.set(LANE, l);
		await h.event(opened(l));
		const base = sha("c"); // the lane's merge base with trunk (K17), not its opening base
		h.push(LANE, sha("1"), base);
		const out = await submit(h);
		ok(CHANGES_TOOLS.changes_submit.output.safeParse(out).success);
		equal(out.revision, 1);
		const submitted = h.emitted().find((e) => e.type === "changes.submitted")!;
		deepStrictEqual(submitted.data, {
			changeId: out.changeId,
			laneId: LANE,
			revision: 1,
			head: sha("1"),
			base,
			affected: ["api"],
			workRef: WORK_REF,
		});
		ok(h.recorder.calls.some((c) => c.method === "repo.laneRange"));
		// Phase 2 of the same push arrives after the submit: no new revision.
		await h.event(diffed(LANE, sha("1"), base));
		let change = await get(h, out.changeId);
		equal(change.revisions.length, 1);
		equal(change.state, "submitted");
		// A repeated submit at the same head answers the same revision.
		deepStrictEqual(await submit(h), { changeId: out.changeId, revision: 1 });
		equal(h.types().filter((t) => t === "changes.submitted").length, 1);
		// The why note gets the changes section.
		const note = h.recorder.calls.find((c) => c.method === "notes.contribute")!;
		equal(note.args[1], out.changeId);
		change = await get(h, out.changeId);
		equal(change.revisions[0].base, base);
	} finally {
		h.close();
	}
});

Deno.test("a failed changes.submitted emit leaves the change unsubmitted, and the retry emits it with the same key", async () => {
	let failNext = true;
	const emits: { type: string; data: Record<string, unknown>; o?: unknown }[] =
		[];
	const h = createChangesHarness({
		"events.emit": (type: string, data: unknown, o?: unknown) => {
			if (type === "changes.submitted" && failNext) {
				failNext = false;
				throw unavailable("events.emit: RepoDO unavailable");
			}
			emits.push({ type, data: data as Record<string, unknown>, o });
			return `01k6f${String(emits.length).padStart(21, "0")}`;
		},
	});
	try {
		const l = lane(LANE, AGENT);
		h.lanes.set(LANE, l);
		await h.event(opened(l));
		h.push(LANE, sha("1"));
		const changeId = emits.find((e) => e.type === "changes.opened")!.data
			.changeId as string;
		equal(await reason(submit(h)), "unavailable");
		const before = await get(h, changeId);
		equal(before.revisions.length, 0, "no revision without the event");
		ok(before.state !== "submitted", before.state);
		// The retry is not answered from the store: it emits.
		deepStrictEqual(await submit(h), { changeId, revision: 1 });
		const submitted = emits.filter((e) => e.type === "changes.submitted");
		equal(submitted.length, 1);
		equal(
			(submitted[0].o as { idemKey?: string }).idemKey,
			`submitted:${changeId}:1`,
		);
		equal((await get(h, changeId)).state, "submitted");
	} finally {
		h.close();
	}
});

Deno.test("revisions on push.diffed: head = after, base = rangeBase; approval invalidated; a stale push is ignored", async () => {
	const h = createChangesHarness();
	try {
		const l = lane(LANE, AGENT);
		h.lanes.set(LANE, l);
		await h.event(opened(l));
		h.push(LANE, sha("1"));
		const { changeId } = await submit(h);
		await h.event(event("review.decided", {
			changeId,
			revision: 1,
			head: sha("1"),
			decision: "approve",
			route: "auto",
			decidedBy: { kind: "ext", id: "x_i_01k6rrrrrrrrrrrrrrrrrrrrrr" },
		}));
		equal((await get(h, changeId)).state, "approved");
		// A rebase onto a newer trunk: the range base moves.
		h.push(LANE, sha("2"), sha("d"));
		h.push(LANE, sha("3"), sha("d"));
		// Phase 2 of the older push (2) finishes after push 3 was recorded.
		await h.event(diffed(LANE, sha("2"), sha("d")));
		equal((await get(h, changeId)).revisions.length, 1);
		await h.event(diffed(LANE, sha("3"), sha("d")));
		const change = await get(h, changeId);
		deepStrictEqual(change.revisions.map((r) => [r.n, r.head, r.base]), [
			[1, sha("1"), TRUNK],
			[2, sha("3"), sha("d")],
		]);
		equal(change.state, "submitted");
		const revised = h.emitted().filter((e) => e.type === "changes.revised");
		equal(revised.length, 1);
		deepStrictEqual(revised[0].data, {
			changeId,
			laneId: LANE,
			revision: 2,
			head: sha("3"),
			base: sha("d"),
			affected: ["api"],
			workRef: WORK_REF,
		});
		// A stale review of revision 1 does not approve revision 2.
		await h.event(event("review.decided", {
			changeId,
			revision: 1,
			head: sha("1"),
			decision: "approve",
			route: "auto",
			decidedBy: { kind: "ext", id: "x_i_01k6rrrrrrrrrrrrrrrrrrrrrr" },
		}));
		equal((await get(h, changeId)).state, "submitted");
	} finally {
		h.close();
	}
});

Deno.test("states from review, queue and land; changes.landed{commit, advanceId} exactly once", async () => {
	const h = createChangesHarness();
	try {
		const l = lane(LANE, AGENT);
		h.lanes.set(LANE, l);
		await h.event(opened(l));
		h.push(LANE, sha("1"));
		const { changeId } = await submit(h);
		const states: string[] = [];
		const step = async (type: string, data: Record<string, unknown>) => {
			await h.event(event(type, data));
			states.push((await get(h, changeId)).state);
		};
		await step("review.decided", {
			changeId,
			revision: 1,
			head: sha("1"),
			decision: "approve",
			route: "auto",
			decidedBy: { kind: "ext", id: "x_i_01k6rrrrrrrrrrrrrrrrrrrrrr" },
		});
		await step("queue.enqueued", { changeId, partition: "api" });
		const batchId = "lb_01k6bbbbbbbbbbbbbbbbbbbbbb";
		await step("land.submitted", {
			batchId,
			attempt: 1,
			ref: "refs/heads/main",
			changes: [{ changeId, laneId: LANE, head: sha("1") }],
			reasonEvents: [],
			requestedBy: "i_01k6wwwwwwwwwwwwwwwwwwwwww",
			testPolicy: "checks",
		});
		await step("land.failed", { batchId, attempt: 1, reason: "tests" });
		await step("land.submitted", {
			batchId,
			attempt: 2,
			ref: "refs/heads/main",
			changes: [{ changeId, laneId: LANE, head: sha("1") }],
			reasonEvents: [],
			requestedBy: "i_01k6wwwwwwwwwwwwwwwwwwwwww",
			testPolicy: "checks",
		});
		const commit = sha("e");
		const advance = `adv_01k6bbbbbbbbbbbbbbbbbbbbbb_2`;
		await step("ref.advanced", {
			ref: "refs/heads/main",
			old: TRUNK,
			new: commit,
			advanceId: advance,
			changes: [{ changeId, laneId: LANE, commit }],
			reasonEvents: [],
			evidenceReused: false,
		});
		await step("land.completed", {
			batchId,
			attempt: 2,
			landed: [{ changeId, commit }],
			conflicted: [],
			vetoed: [],
		});
		deepStrictEqual(states, [
			"approved",
			"queued",
			"landing",
			"queued",
			"landing",
			"landed",
			"landed",
		]);
		const landed = h.emitted().filter((e) => e.type === "changes.landed");
		equal(landed.length, 1);
		deepStrictEqual(landed[0].data, {
			changeId,
			laneId: LANE,
			commit,
			advanceId: advance,
			workRef: WORK_REF,
		});
		const change = await get(h, changeId) as Change & { landedCommit: string };
		equal(change.landedCommit, commit);
		ok(h.recorder.notices.some((n) => n.principal === AGENT));
		// A landed change is final: a push.diffed or a closed lane changes nothing.
		await h.event(
			event("lane.closed", {
				laneId: LANE,
				owner: AGENT,
				base: TRUNK,
				mode: "branch",
			}),
		);
		equal((await get(h, changeId)).state, "landed");
	} finally {
		h.close();
	}
});

Deno.test("land.completed alone also lands the change (advance id from batch and attempt)", async () => {
	const h = createChangesHarness();
	try {
		const l = lane(LANE, AGENT);
		h.lanes.set(LANE, l);
		await h.event(opened(l));
		h.push(LANE, sha("1"));
		const { changeId } = await submit(h);
		await h.event(event("land.completed", {
			batchId: "lb_01k6bbbbbbbbbbbbbbbbbbbbbb",
			attempt: 1,
			landed: [{ changeId, commit: sha("e") }],
			conflicted: [],
			vetoed: [],
		}));
		const landed = h.emitted().find((e) => e.type === "changes.landed")!;
		equal(landed.data.advanceId, "adv_01k6bbbbbbbbbbbbbbbbbbbbbb_1");
	} finally {
		h.close();
	}
});

Deno.test("K16: an agent's changes_open {sourceRef} is refused; a user's adopts the branch", async () => {
	const h = createChangesHarness();
	try {
		equal(
			await reason(
				h.tool(
					"changes_open",
					{ repo: REPO_PATH, sourceRef: "feature/x" },
					toolCtx(agentActor),
				),
			),
			"denied(lane-op)",
		);
		equal(h.recorder.calls.filter((c) => c.method === "lanes.adopt").length, 0);
		const change = await h.tool("changes_open", {
			repo: REPO_PATH,
			sourceRef: "feature/x",
			title: "Human fix",
		}, toolCtx(userActor)) as Change & { sourceRef: string; title: string };
		ok(ChangeSchema.safeParse(change).success);
		const adopt = h.recorder.calls.find((c) => c.method === "lanes.adopt")!;
		deepStrictEqual(adopt.args[0], {
			repo: { id: REPO },
			ref: "refs/heads/feature/x",
			owner: USER,
		});
		equal(change.sourceRef, "refs/heads/feature/x");
		equal(change.state, "draft");
		equal(change.title, "Human fix");
		// The kernel's lane.opened of the adopted lane does not add a second change.
		await h.event(opened(h.lanes.get("ln_01k6000000000000000000000d")!));
		equal(h.types().filter((t) => t === "changes.opened").length, 1);
		equal(
			await reason(
				h.tool("changes_open", { repo: REPO_PATH }, toolCtx(userActor)),
			),
			"invalid",
		);
	} finally {
		h.close();
	}
});

Deno.test("abandon, lane.closed, list, comments, threads and renders", async () => {
	const h = createChangesHarness();
	try {
		const l = lane(LANE, AGENT);
		h.lanes.set(LANE, l);
		await h.event(opened(l));
		h.push(LANE, sha("1"));
		const { changeId } = await submit(h);
		const comment = await h.tool("changes_comment", {
			changeId,
			body: "Use a monotonic clock",
			path: "services/api/src/middleware/limit.ts",
			line: 42,
		}, toolCtx(userActor)) as { commentId: string };
		ok(comment.commentId);
		const commented = h.emitted().find((e) => e.type === "changes.commented")!;
		deepStrictEqual(commented.data, {
			changeId,
			commentId: comment.commentId,
			revision: 1,
			path: "services/api/src/middleware/limit.ts",
			line: 42,
		});
		const list = await h.tool(
			"changes_list",
			{ repo: REPO_PATH, mine: true },
			toolCtx(agentActor),
		) as {
			changes: Change[];
		};
		ok(CHANGES_TOOLS.changes_list.output.safeParse(list).success);
		equal(list.changes.length, 1);

		const base = {
			node: REPO,
			repo: REPO,
			mode: "enforce" as const,
			viewer: userActor,
		};
		const changeCtx = { ...base, entity: { kind: "change", id: changeId } };
		for (
			const [slot, ctx] of [
				["changes", { ...base, slot: "repo.tab" as const }],
				["overview", { ...changeCtx, slot: "change.panel" as const }],
				["diff", { ...changeCtx, slot: "change.tab" as const }],
				["revisions", { ...changeCtx, slot: "change.tab" as const }],
				["threads", { ...changeCtx, slot: "change.panel" as const }],
				["change", {
					...base,
					slot: "lane.sidebar" as const,
					entity: { kind: "lane", id: LANE },
				}],
			] as const
		) {
			const doc = await h.render(slot, ctx);
			ok(validateUi(doc).ok, `${slot}: ${JSON.stringify(doc)}`);
			ok(doc.root.t !== "error-chip", `${slot} rendered`);
		}
		const threads = await h.render("threads", {
			...changeCtx,
			slot: "change.panel",
		});
		ok(JSON.stringify(threads).includes("Use a monotonic clock"));
		// The Revisions tab shows the interdiff once there are two revisions.
		h.push(LANE, sha("2"));
		await h.event(diffed(LANE, sha("2")));
		const revisions = await h.render("revisions", {
			...changeCtx,
			slot: "change.tab",
			extra: { revision: 2 },
		});
		ok(JSON.stringify(revisions).includes("@@ -40,3 +40,9"));

		// The threads panel's form posts with the host's convention:
		// the field values at the top level and the action's `changeId`.
		const [commentForm] = formsIn(threads);
		ok(commentForm);
		const typed = formSubmission(commentForm, {
			body: "Typed in the form",
			path: "services/api/src/middleware/limit.ts",
			line: "7",
		});
		deepStrictEqual(typed, {
			action: "comment",
			payload: {
				body: "Typed in the form",
				path: "services/api/src/middleware/limit.ts",
				line: "7",
				changeId,
			},
		});
		equal(
			(await h.action(typed.action, typed.payload, changeCtx, {
				actor: userActor,
			})).toast?.text,
			"Comment added",
		);
		ok(
			JSON.stringify(
				await h.render("threads", { ...changeCtx, slot: "change.panel" }),
			).includes("Typed in the form"),
		);

		await h.action("resolve", { commentId: comment.commentId }, changeCtx, {
			actor: userActor,
		});
		const resolved = await h.render("threads", {
			...changeCtx,
			slot: "change.panel",
		});
		ok(JSON.stringify(resolved).includes("resolved"));

		// Another agent may not abandon; the author may.
		equal(
			await reason(
				h.tool("changes_abandon", { changeId }, toolCtx(otherActor)),
			),
			"denied(role)",
		);
		deepStrictEqual(
			await h.tool(
				"changes_abandon",
				{ changeId, reason: "superseded by #9" },
				toolCtx(agentActor),
			),
			{ ok: true },
		);
		equal((await get(h, changeId)).state, "abandoned");
		const abandoned = h.emitted().find((e) => e.type === "changes.abandoned")!;
		deepStrictEqual(abandoned.data, {
			changeId,
			laneId: LANE,
			reason: "superseded by #9",
		});
		// Submitting again revives it as a new revision.
		h.push(LANE, sha("4"));
		const again = await submit(h);
		equal(again.revision, 3);
		equal((await get(h, changeId)).state, "submitted");
		// A closed lane abandons the unlanded change.
		await h.event(
			event("lane.closed", {
				laneId: LANE,
				owner: AGENT,
				base: TRUNK,
				mode: "branch",
				reason: "owner closed",
			}),
		);
		equal((await get(h, changeId)).state, "abandoned");
	} finally {
		h.close();
	}
});

/** Every node of a tartan-ui document (depth first). */
const nodesOf = (value: unknown): Record<string, unknown>[] => {
	if (Array.isArray(value)) return value.flatMap(nodesOf);
	if (typeof value !== "object" || value === null) return [];
	const node = value as Record<string, unknown>;
	return [
		...(typeof node.t === "string" ? [node] : []),
		...Object.values(node).flatMap(nodesOf),
	];
};

type Button = {
	t: "button";
	text: string;
	action: { id: string; payload?: unknown };
};
const buttonsIn = (doc: unknown): Button[] =>
	nodesOf(doc).filter((n) => n.t === "button") as unknown as Button[];

Deno.test("the overview is a change.panel; it shows the change and abandons it from the UI", async () => {
	const h = createChangesHarness();
	try {
		const l = lane(LANE, AGENT);
		h.lanes.set(LANE, l);
		await h.event(opened(l));
		h.push(LANE, sha("1"));
		const { changeId } = await submit(h);
		const changeCtx = {
			node: REPO,
			repo: REPO,
			mode: "enforce" as const,
			viewer: userActor,
			entity: { kind: "change", id: changeId },
		};
		// The manifest renders the overview where the catalogue delivers a
		// change entity: change.panel, never repo.tab (whose context is [repo]).
		const slots = manifest.contributes?.slots ?? [];
		const overview = slots.find((c) => c.id === "overview");
		equal(overview?.slot, "change.panel");
		equal(overview?.dynamic, true);
		const threads = slots.find((c) => c.id === "threads");
		ok((overview?.order ?? 0) < (threads?.order ?? 0), "overview first");
		const doc = await h.render("overview", {
			...changeCtx,
			slot: "change.panel",
		});
		ok(validateUi(doc).ok, JSON.stringify(doc));
		const shown = nodesOf(doc);
		ok(
			shown.some((n) =>
				n.t === "heading" && n.text === "Token bucket rate limiting"
			),
			"title",
		);
		ok(
			shown.some((n) => n.t === "badge" && n.text === "submitted"),
			"state badge",
		);
		ok(JSON.stringify(doc).includes("Adds a token bucket"), "summary");
		const [abandon] = buttonsIn(doc).filter((b) => b.action.id === "abandon");
		ok(abandon, "Abandon button");
		deepStrictEqual(abandon.action.payload, { changeId });
		// Without a change entity it says so (it is never the list page).
		const none = await h.render("overview", {
			node: REPO,
			repo: REPO,
			mode: "enforce",
			viewer: userActor,
			slot: "change.panel",
		});
		ok(JSON.stringify(none).includes("No change selected"));
		// The Changes tab is always the list.
		const list = await h.render("changes", {
			node: REPO,
			repo: REPO,
			mode: "enforce",
			viewer: userActor,
			slot: "repo.tab",
		});
		ok(nodesOf(list).some((n) => n.t === "table"), "list page");

		// The button's action abandons the change as the viewer (on whose
		// behalf the agent works).
		equal(
			(await h.action(abandon.action.id, abandon.action.payload, changeCtx, {
				actor: userActor,
			})).toast?.text,
			"Change abandoned",
		);
		equal((await get(h, changeId)).state, "abandoned");
		const after = await h.render("overview", {
			...changeCtx,
			slot: "change.panel",
		});
		ok(nodesOf(after).some((n) => n.t === "badge" && n.text === "abandoned"));
		equal(buttonsIn(after).filter((b) => b.action.id === "abandon").length, 0);
	} finally {
		h.close();
	}
});

Deno.test("Classic wording: the Changes tab says pull requests", async () => {
	const base = {
		slot: "repo.tab" as const,
		node: REPO,
		repo: REPO,
		mode: "enforce" as const,
		viewer: userActor,
	};
	const classic = createChangesHarness({}, { config: { wording: "classic" } });
	try {
		const empty = JSON.stringify(await classic.render("changes", base));
		ok(empty.includes("No pull requests yet"), empty);
		const l = lane(LANE, AGENT);
		classic.lanes.set(LANE, l);
		await classic.event(opened(l));
		classic.push(LANE, sha("1"));
		await submit(classic);
		const list = await classic.render("changes", base);
		ok(validateUi(list).ok);
		const text = JSON.stringify(list);
		ok(text.includes('"Pull request"') && text.includes('"Issue"'), text);
	} finally {
		classic.close();
	}
	const plain = createChangesHarness();
	try {
		const empty = JSON.stringify(await plain.render("changes", base));
		ok(empty.includes("No changes yet"), empty);
	} finally {
		plain.close();
	}
});
