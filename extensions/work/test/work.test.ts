// tartan.work: work@1 tools, claims with footprints and the
// lane handle, conflicts_check overlaps, the event handlers (submitted,
// abandoned, landed, lane lost), work_update, the claim context and
// context@1, migration 3 over an older database, renders and actions.

import { deepStrictEqual, equal, ok, rejects, strictEqual } from "./assert.ts";
import {
	fromRpcError,
	validateActionResult,
	validateUi,
	WORK_TOOLS,
	WorkItemSchema,
} from "@tartan/contract";
import {
	createMemoryStorage,
	formsIn,
	formSubmission,
} from "@tartan/ext-api/testing.ts";
import {
	AGENT,
	agent2Actor,
	agentActor,
	BASE,
	createWorkHarness,
	event,
	HEAD,
	lane,
	REPO,
	REPO_PATH,
	toolCtx,
	userActor,
} from "./helpers.ts";
import { migrations } from "../src/migrations.ts";

type Claim = {
	lane: Record<string, unknown> & { id: string; git?: { push: string } };
	work: { ref: string; state: string; claims: { state: string }[] };
	overlaps: { laneId: string; paths: string[]; severity: string }[];
	context: { sections: { id: string; md: string }[] };
};

const reason = async (p: Promise<unknown>): Promise<string> => {
	try {
		await p;
	} catch (error) {
		const e = fromRpcError(error);
		return `${e.code}${e.reason ? `(${e.reason})` : ""}`;
	}
	return "ok";
};

const create = (
	h: ReturnType<typeof createWorkHarness>,
	title = "Rate limiting",
) =>
	h.tool("work_create", {
		repo: REPO_PATH,
		kind: "intent",
		title,
		why: "Protect the API from bursts",
		acceptance: ["429 above 100 rps"],
		footprint: { projects: ["api"], prefixes: ["services/api/src/middleware"] },
	}, toolCtx(userActor)) as Promise<{ ref: string }>;

Deno.test("work_create/get/list: items with refs, work.created, valid entities", async () => {
	const h = createWorkHarness();
	try {
		const a = await create(h);
		const b = await create(h, "Per-tenant quotas");
		equal(a.ref, `${REPO_PATH}#1`);
		equal(b.ref, `${REPO_PATH}#2`);
		ok(WorkItemSchema.safeParse(a).success);
		deepStrictEqual(h.types(), ["work.created", "work.created"]);
		const got = await h.tool("work_get", { ref: a.ref }, toolCtx(userActor));
		ok(WORK_TOOLS.work_get.output.safeParse(got).success);
		const page = await h.tool("work_list", {
			repo: REPO_PATH,
			limit: 1,
		}, toolCtx(userActor)) as { items: { ref: string }[]; cursor?: string };
		ok(WORK_TOOLS.work_list.output.safeParse(page).success);
		deepStrictEqual(page.items.map((i) => i.ref), [a.ref]);
		const next = await h.tool("work_list", {
			repo: REPO_PATH,
			cursor: page.cursor,
		}, toolCtx(userActor)) as { items: { ref: string }[] };
		deepStrictEqual(next.items.map((i) => i.ref), [b.ref]);
		equal(
			await reason(
				h.tool("work_get", { ref: "acme/other#1" }, toolCtx(userActor)),
			),
			"not_found",
		);
		equal(
			await reason(
				h.tool("work_list", { repo: "acme/other" }, toolCtx(userActor)),
			),
			"not_found",
		);
	} finally {
		h.close();
	}
});

Deno.test("work_claim: opens the claimant's lane with the footprint, returns handle, overlaps and context", async () => {
	const other = "ln_01k6zzzzzzzzzzzzzzzzzzzzzz";
	const h = createWorkHarness({
		"interfaces.call": (iface: string, tool: string, args: unknown) => {
			equal(iface, "conflicts@1");
			equal(tool, "conflicts_check");
			const a = args as { repo: string; laneId: string; footprint: unknown };
			equal(a.repo, REPO_PATH);
			deepStrictEqual(a.footprint, {
				projects: ["api"],
				prefixes: ["services/api/src/middleware"],
			});
			return {
				results: [
					{
						target: "api",
						lanes: [{ laneId: other, agent: "codex-2", work: "#2" }],
						severity: "declared",
						suggestion: "coordinate",
					},
					{
						target: "services/api/src/middleware",
						lanes: [
							{ laneId: other, agent: "codex-2" },
							{ laneId: a.laneId, agent: "me" },
						],
						severity: "same_file",
						suggestion: "rebase",
					},
				],
			};
		},
	});
	try {
		const { ref } = await create(h);
		const out = await h.tool("work_claim", {
			ref,
			plan: "token bucket in middleware",
		}, toolCtx(agentActor)) as Claim;
		ok(WORK_TOOLS.work_claim.output.safeParse(out).success);
		const opened = h.recorder.calls.filter((c) => c.method === "lanes.open");
		equal(opened.length, 1);
		const o = opened[0].args[0] as Record<string, unknown>;
		equal(o.owner, AGENT);
		deepStrictEqual(o.entity, { kind: "work", id: ref });
		deepStrictEqual(o.repo, { id: REPO });
		// The branch backend's handle carries its own commands.
		equal(out.lane.mode, "branch");
		equal(out.lane.ref, `refs/heads/lanes/${out.lane.id}`);
		equal(
			out.lane.git?.push,
			`git push -u origin HEAD:refs/heads/lanes/${out.lane.id}`,
		);
		equal(out.work.state, "claimed");
		deepStrictEqual(out.overlaps, [{
			laneId: other,
			agent: "codex-2",
			work: "#2",
			paths: ["api", "services/api/src/middleware"],
			severity: "same_file",
			suggestion: "rebase",
		}]);
		ok(out.context.sections[0].md.includes("Protect the API from bursts"));
		const claimed = h.emitted().find((e) => e.type === "work.claimed")!;
		deepStrictEqual(claimed.data, {
			ref,
			principal: AGENT,
			laneId: out.lane.id,
			footprint: {
				projects: ["api"],
				prefixes: ["services/api/src/middleware"],
			},
		});

		// A repeated claim by the same agent returns the same lane.
		const again = await h.tool(
			"work_claim",
			{ ref },
			toolCtx(agentActor),
		) as Claim;
		equal(again.lane.id, out.lane.id);
		equal(h.recorder.calls.filter((c) => c.method === "lanes.open").length, 1);
		// Another agent is refused while the item is claimed.
		equal(
			await reason(h.tool("work_claim", { ref }, toolCtx(agent2Actor))),
			"conflict",
		);
		// K12: a background actor never claims.
		equal(
			await reason(
				h.tool(
					"work_claim",
					{ ref },
					toolCtx({ kind: "ext", id: "x_i_01k6iiiiiiiiiiiiiiiiiiiiii" }),
				),
			),
			"denied(actor)",
		);
	} finally {
		h.close();
	}
});

Deno.test("work_claim: a repo lane still opening has no git commands; a lane closed while opening is a conflict", async () => {
	let state: "opening" | "closed" = "opening";
	const h = createWorkHarness({
		"lanes.open": (o: { owner: string }) =>
			lane("ln_01k6oooooooooooooooooooooo", o.owner, { mode: "repo", state }),
	});
	try {
		const { ref } = await create(h);
		const out = await h.tool(
			"work_claim",
			{ ref },
			toolCtx(agentActor),
		) as Claim;
		equal(out.lane.state, "opening");
		equal(out.lane.ref, "refs/heads/main");
		equal(
			out.lane.remote,
			`/${REPO_PATH}/-/lanes/ln_01k6oooooooooooooooooooooo.git`,
		);
		strictEqual(out.lane.git, undefined);
		state = "closed";
		const { ref: ref2 } = await create(h, "second");
		equal(
			await reason(h.tool("work_claim", { ref: ref2 }, toolCtx(agent2Actor))),
			"conflict",
		);
	} finally {
		h.close();
	}
});

Deno.test("work_claim: no conflicts@1 provider leaves the claim without overlaps", async () => {
	const h = createWorkHarness({
		"interfaces.call": () => {
			throw new Error("not_found: no conflicts@1 provider in force");
		},
	});
	try {
		const { ref } = await create(h);
		const out = await h.tool(
			"work_claim",
			{ ref },
			toolCtx(agentActor),
		) as Claim;
		deepStrictEqual(out.overlaps, []);
	} finally {
		h.close();
	}
});

Deno.test("events: submitted → in_review (+ note), abandoned → claimed, landed → work.done; redelivery is a no-op", async () => {
	const h = createWorkHarness();
	try {
		const { ref } = await create(h);
		const out = await h.tool(
			"work_claim",
			{ ref, plan: "p" },
			toolCtx(agentActor),
		) as Claim;
		const changeId = "z".repeat(32);
		const submitted = event("changes.submitted", {
			changeId,
			laneId: out.lane.id,
			revision: 1,
			head: HEAD,
			base: BASE,
			affected: ["api"],
			workRef: ref,
		});
		await h.event(submitted);
		await h.event(submitted);
		let item = await h.tool(
			"work_get",
			{ ref },
			toolCtx(userActor),
		) as Claim["work"];
		equal(item.state, "in_review");
		equal(item.claims[0].state, "submitted");
		const notes = h.recorder.calls.filter((c) =>
			c.method === "notes.contribute"
		);
		ok(notes.length >= 1);
		equal(notes[0].args[1], changeId);
		equal((notes[0].args[2] as { ref: string; plan: string }).plan, "p");

		await h.event(
			event("changes.abandoned", { changeId, laneId: out.lane.id }),
		);
		item = await h.tool(
			"work_get",
			{ ref },
			toolCtx(userActor),
		) as Claim["work"];
		equal(item.state, "claimed");
		await h.event(submitted);
		const landed = event("changes.landed", {
			changeId,
			laneId: out.lane.id,
			commit: "c".repeat(40),
			advanceId: "adv_01k6aaaaaaaaaaaaaaaaaaaaaa_1",
			workRef: ref,
		});
		await h.event(landed);
		await h.event(landed);
		item = await h.tool(
			"work_get",
			{ ref },
			toolCtx(userActor),
		) as Claim["work"];
		equal(item.state, "done");
		equal(item.claims[0].state, "landed");
		const types = h.types();
		equal(types.filter((t) => t === "work.done").length, 1);
		deepStrictEqual(
			h.emitted().filter((e) => e.type === "work.updated").map((e) =>
				e.data.state
			),
			["in_review", "claimed", "in_review"],
		);
		const done = h.emitted().find((e) => e.type === "work.done")!;
		deepStrictEqual(done.data, { ref, changeId, commit: "c".repeat(40) });
		// A landed item cannot be claimed again.
		equal(
			await reason(h.tool("work_claim", { ref }, toolCtx(agent2Actor))),
			"conflict",
		);
		// The intent annotation finds the item by its landed commit.
		const doc = await h.render("intent", {
			slot: "blame.annotation",
			node: REPO,
			repo: REPO,
			ref: "c".repeat(40),
			mode: "enforce",
		});
		ok(JSON.stringify(doc).includes("Rate limiting"));
	} finally {
		h.close();
	}
});

Deno.test("events: a lost or closed lane releases the claim and reopens the item", async () => {
	const h = createWorkHarness();
	try {
		const { ref } = await create(h);
		const out = await h.tool(
			"work_claim",
			{ ref },
			toolCtx(agentActor),
		) as Claim;
		await h.event(event("lane.lost", {
			laneId: out.lane.id,
			owner: AGENT,
			base: BASE,
			mode: "branch",
		}));
		const item = await h.tool(
			"work_get",
			{ ref },
			toolCtx(userActor),
		) as Claim["work"];
		equal(item.state, "open");
		equal(item.claims[0].state, "lease_lost");
		ok(h.types().includes("work.released"));
		// Someone else can claim it now.
		const next = await h.tool(
			"work_claim",
			{ ref },
			toolCtx(agent2Actor),
		) as Claim;
		ok(next.lane.id !== out.lane.id);
	} finally {
		h.close();
	}
});

Deno.test("work_release: releases the claim, closes the lane; refused while the change is submitted", async () => {
	const h = createWorkHarness();
	try {
		const { ref } = await create(h);
		const out = await h.tool(
			"work_claim",
			{ ref },
			toolCtx(agentActor),
		) as Claim;
		await h.event(event("changes.submitted", {
			changeId: "y".repeat(32),
			laneId: out.lane.id,
			revision: 1,
			head: HEAD,
			base: BASE,
			affected: [],
		}));
		equal(
			await reason(h.tool("work_release", { ref }, toolCtx(agentActor))),
			"conflict",
		);
		await h.event(event("changes.abandoned", { changeId: "y".repeat(32) }));
		deepStrictEqual(
			await h.tool(
				"work_release",
				{ ref, reason: "stuck" },
				toolCtx(agentActor),
			),
			{ ok: true },
		);
		const closes = h.recorder.calls.filter((c) => c.method === "lanes.close");
		equal(closes[0].args[0], out.lane.id);
		const item = await h.tool(
			"work_get",
			{ ref },
			toolCtx(userActor),
		) as Claim["work"];
		equal(item.state, "open");
		equal(
			await reason(h.tool("work_release", { ref }, toolCtx(agentActor))),
			"not_found",
		);
	} finally {
		h.close();
	}
});

Deno.test("work_update: state, priority and labels with work.updated{changed}; a no-op emits nothing", async () => {
	const h = createWorkHarness();
	try {
		const { ref } = await create(h);
		const out = await h.tool("work_update", {
			ref,
			state: "in_review",
			priority: 1,
		}, toolCtx(userActor)) as { state: string; priority: number };
		equal(out.state, "in_review");
		equal(out.priority, 1);
		const updated = h.emitted().filter((e) => e.type === "work.updated");
		deepStrictEqual(updated.map((e) => e.data), [{
			ref,
			state: "in_review",
			priority: 1,
			changed: ["state", "priority"],
		}]);
		await h.tool(
			"work_update",
			{ ref, state: "in_review" },
			toolCtx(userActor),
		);
		equal(h.emitted().filter((e) => e.type === "work.updated").length, 1);
	} finally {
		h.close();
	}
});

Deno.test("the claim context and context@1 carry the work item section", async () => {
	const h = createWorkHarness();
	try {
		const { ref } = await create(h);
		const claim = await h.tool(
			"work_claim",
			{ ref },
			toolCtx(agentActor),
		) as Claim;
		deepStrictEqual(claim.context.sections.map((s) => s.id), ["work-item"]);
		const sections = await h.context({
			repo: REPO_PATH,
			repoId: REPO,
			laneId: claim.lane.id,
			maxBytes: 4096,
			actor: agentActor,
		});
		deepStrictEqual(sections.map((s) => s.id), ["work-item"]);
		ok(sections[0].md.includes(ref));
		const small = await h.context({
			repo: REPO_PATH,
			repoId: REPO,
			work: ref,
			maxBytes: 120,
			actor: agentActor,
		});
		ok(small.every((s) => new TextEncoder().encode(s.md).length <= 120));
	} finally {
		h.close();
	}
});

Deno.test("migration 3 drops the tournament columns and table and releases decided claims", () => {
	const storage = createMemoryStorage();
	const db = storage.db;
	try {
		db.exec(migrations[0].sql);
		db.exec(migrations[1].sql);
		db.exec(
			`INSERT INTO items (id, number, kind, title, mode, k, state, created_by, created_at, updated_at)
			 VALUES ('i1', 1, 'intent', 't', 'tournament', 2, 'claimed', 'u', 1, 1)`,
		);
		db.exec(
			`INSERT INTO items_fts (rowid, title, why) SELECT rowid, title, why FROM items`,
		);
		db.exec(
			`INSERT INTO claims (item_id, lane_id, principal_id, candidate, state, claimed_at, ended_at) VALUES
			 ('i1', 'ln_a', 'a_1', 1, 'won', 1, 2), ('i1', 'ln_b', 'a_2', 2, 'lost', 1, NULL),
			 ('i1', 'ln_c', 'a_3', NULL, 'active', 1, NULL)`,
		);
		db.exec(
			"INSERT INTO knowledge (id, item_id, kind, summary, at) VALUES ('k1', 'i1', 'rejected_approach', 's', 1)",
		);
		equal(migrations[2].n, 3);
		db.exec(migrations[2].sql);
		const columns = (table: string) =>
			(db.prepare(`SELECT name FROM pragma_table_info('${table}')`)
				.all() as { name: string }[]).map((c) => c.name);
		ok(!columns("items").includes("mode") && !columns("items").includes("k"));
		ok(!columns("claims").includes("candidate"));
		equal(
			db.prepare(
				"SELECT count(*) AS n FROM sqlite_master WHERE name = 'knowledge'",
			).get()?.n,
			0,
		);
		deepStrictEqual(
			db.prepare(
				"SELECT lane_id, state, ended_at FROM claims ORDER BY lane_id",
			).all().map((r) => ({ ...r })),
			[
				{ lane_id: "ln_a", state: "released", ended_at: 2 },
				{ lane_id: "ln_b", state: "released", ended_at: 1 },
				{ lane_id: "ln_c", state: "active", ended_at: null },
			],
		);
		equal(
			db.prepare("SELECT title FROM items_fts WHERE items_fts MATCH 't'")
				.get()?.title,
			"t",
		);
	} finally {
		storage.close();
	}
});

Deno.test("renders are valid tartan-ui@1; create and comment actions run as the viewer", async () => {
	const h = createWorkHarness();
	try {
		const ctx = {
			slot: "repo.tab" as const,
			node: REPO,
			repo: REPO,
			mode: "enforce" as const,
			viewer: userActor,
		};
		const empty = await h.render("work", ctx);
		ok(validateUi(empty).ok);
		const created = await h.action(
			"create",
			{
				title: "Add caching",
				kind: "issue",
				why: "slow",
				acceptance: "fast\n\ncached",
			},
			ctx,
			{ actor: userActor },
		);
		equal(created.navigate, `/${REPO_PATH}/-/work/1`);
		const list = await h.render("work", ctx);
		ok(validateUi(list).ok);
		ok(JSON.stringify(list).includes("Add caching"));
		const panelCtx = {
			slot: "work.panel" as const,
			node: REPO,
			repo: REPO,
			entity: { kind: "work", id: "1" },
			mode: "enforce" as const,
			viewer: userActor,
		};
		await h.action(
			"comment",
			{ ref: `${REPO_PATH}#1`, body: "LGTM" },
			panelCtx,
			{ actor: userActor },
		);
		const panel = await h.render("item", panelCtx);
		ok(validateUi(panel).ok, JSON.stringify(panel));
		ok(JSON.stringify(panel).includes("LGTM"));
		ok(h.types().includes("work.commented"));
		const tab = await h.render("work", {
			...ctx,
			entity: { kind: "work", id: `${REPO_PATH}#1` },
		});
		ok(JSON.stringify(tab).includes("LGTM"));
		await rejects(h.action("create", { title: "" }, ctx, { actor: userActor }));
	} finally {
		h.close();
	}
});

Deno.test("the rendered forms submit with the host's payload convention", async () => {
	const h = createWorkHarness();
	try {
		const tabCtx = {
			slot: "repo.tab" as const,
			node: REPO,
			repo: REPO,
			mode: "enforce" as const,
			viewer: userActor,
		};
		// The Work tab's create form: field values at the top level, no `values`.
		const [createForm] = formsIn(await h.render("work", tabCtx));
		ok(createForm);
		const create = formSubmission(createForm, {
			title: "Typed in the form",
			why: "because",
		});
		equal(create.action, "create");
		ok(!("values" in create.payload));
		const created = await h.action(create.action, create.payload, tabCtx, {
			actor: userActor,
		});
		equal(created.navigate, `/${REPO_PATH}/-/work/1`);
		// The item panel's comment form: the action's `ref` and the `body` field.
		const panelCtx = {
			slot: "work.panel" as const,
			node: REPO,
			repo: REPO,
			entity: { kind: "work", id: "1" },
			mode: "enforce" as const,
			viewer: userActor,
		};
		const [commentForm] = formsIn(await h.render("item", panelCtx));
		ok(commentForm);
		const comment = formSubmission(commentForm, { body: "From the form" });
		deepStrictEqual(comment, {
			action: "comment",
			payload: { body: "From the form", ref: `${REPO_PATH}#1` },
		});
		const commented = await h.action(
			comment.action,
			comment.payload,
			panelCtx,
			{ actor: userActor },
		);
		equal(commented.toast?.text, "Comment added");
		// The action itself re-renders the item with the comment (the panel
		// does not wait on the live feed, e2e), as a valid tartan-ui@1 doc.
		ok(commented.render, "the comment action returns a render");
		ok(validateUi(commented.render).ok, JSON.stringify(commented.render));
		ok(JSON.stringify(commented.render).includes("From the form"));
		deepStrictEqual(commented.render, await h.render("item", panelCtx));
		ok(validateActionResult(commented).ok);
	} finally {
		h.close();
	}
});

Deno.test("Classic wording: the Work tab says issues", async () => {
	const ctx = {
		slot: "repo.tab" as const,
		node: REPO,
		repo: REPO,
		mode: "enforce" as const,
		viewer: userActor,
	};
	const classic = createWorkHarness({}, { config: { wording: "classic" } });
	try {
		const doc = await classic.render("work", ctx);
		ok(validateUi(doc).ok);
		const text = JSON.stringify(doc);
		ok(text.includes("No issues yet") && text.includes("New issue"), text);
	} finally {
		classic.close();
	}
	const plain = createWorkHarness();
	try {
		const text = JSON.stringify(await plain.render("work", ctx));
		ok(text.includes("No work items yet") && text.includes("New work item"));
	} finally {
		plain.close();
	}
});
