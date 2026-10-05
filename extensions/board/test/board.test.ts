// tartan.board: the Kanban projection across repos of the
// subtree, auto rules, a board rebuilt from backfill equal to the live one
// (any interleaving of repo streams, redeliveries included), the move action
// as the viewing user through work@1's work_update, and renders that
// show only readable repos.

import {
	type Actor,
	type Envelope,
	parseManifest,
	validateUi,
} from "@tartan/contract";
import {
	type CapsHandler,
	createTestHarness,
	rows,
} from "@tartan/ext-api/testing.ts";
import manifestJson from "../tartan.json" with { type: "json" };
import { extension, migrations } from "../src/index.ts";
import { deepStrictEqual, equal, ok } from "./assert.ts";

const GROUP = "01k6gggggggggggggggggggggg";
const R1 = "01k6rrrrrrrrrrrrrrrrrrrrr1";
const R2 = "01k6rrrrrrrrrrrrrrrrrrrrr2";
const USER = "u_01k6vvvvvvvvvvvvvvvvvvvvvv";
const AGENT = "a_01k6aaaaaaaaaaaaaaaaaaaaaa";
const viewer: Actor = { kind: "user", id: USER };
const sha = (c: string) => c.repeat(40);
const cid = (c: string) => c.repeat(32);

const manifest = (() => {
	const parsed = parseManifest(manifestJson);
	if (!parsed.ok) throw new Error(parsed.errors.join("; "));
	return parsed.manifest;
})();

const harness = (handlers: Record<string, CapsHandler> = {}) =>
	createTestHarness({
		module: extension,
		migrations,
		grants: manifest.permissions,
		install: {
			id: "i_01k6iiiiiiiiiiiiiiiiiiiiii",
			extId: manifest.id,
			version: manifest.version,
			node: { id: GROUP, path: "acme" },
			scopeKey: "node",
		},
		handlers: {
			"authz.check": () => true,
			"interfaces.call": () => ({}),
			...handlers,
		},
	});

/** Two repo streams: events with ULID-ordered ids, per-stream seq. */
const streams = () => {
	const out: Envelope[] = [];
	const seqs = new Map<string, number>();
	let clock = 0;
	const add = (repo: string, type: string, data: Record<string, unknown>) => {
		clock += 1;
		const seq = (seqs.get(repo) ?? 0) + 1;
		seqs.set(repo, seq);
		out.push({
			id: `01k6e${String(clock).padStart(21, "0")}`,
			seq,
			stream: `repo:${repo}`,
			type,
			v: 1,
			source: {
				kind: "installation",
				id: "i_01k6wwwwwwwwwwwwwwwwwwwwww",
				ext: "tartan.work@0.1.0",
			},
			actor: { kind: "agent", id: AGENT },
			node: repo,
			repo,
			depth: 1,
			shadow: false,
			at: 1_790_000_000_000 + clock,
			data,
		});
	};
	return { out, add };
};

/** The demo flow on two repos: one item lands, one is in review, one is new. */
const story = () => {
	const { out, add } = streams();
	const a = "acme/router#1";
	const b = "acme/platform/api#1";
	const c = "acme/router#2";
	const laneA = "ln_01k6000000000000000000000a";
	const laneB = "ln_01k6000000000000000000000b";
	add(R1, "work.created", { ref: a, kind: "intent", title: "Rate limiting" });
	add(R2, "work.created", { ref: b, kind: "issue", title: "Quotas" });
	add(R1, "work.claimed", { ref: a, principal: AGENT, laneId: laneA });
	add(R2, "work.claimed", { ref: b, principal: AGENT, laneId: laneB });
	add(R1, "changes.opened", { changeId: cid("z"), laneId: laneA, workRef: a });
	add(R2, "changes.opened", { changeId: cid("y"), laneId: laneB, workRef: b });
	add(R1, "work.created", { ref: c, kind: "issue", title: "Docs" });
	add(R1, "changes.submitted", {
		changeId: cid("z"),
		laneId: laneA,
		revision: 1,
		head: sha("1"),
		base: sha("0"),
		affected: ["api"],
		workRef: a,
	});
	add(R2, "changes.submitted", {
		changeId: cid("y"),
		laneId: laneB,
		revision: 1,
		head: sha("2"),
		base: sha("0"),
		affected: ["api"],
		workRef: b,
	});
	add(R1, "work.updated", { ref: a, state: "in_review", changed: ["state"] });
	add(R1, "queue.enqueued", { changeId: cid("z"), partition: "api" });
	add(R1, "queue.batched", {
		batchId: "lb_01k6bbbbbbbbbbbbbbbbbbbbbb",
		partition: "api",
		changes: [cid("z")],
	});
	add(R2, "changes.revised", {
		changeId: cid("y"),
		laneId: laneB,
		revision: 2,
		head: sha("3"),
		base: sha("0"),
		affected: ["api"],
		workRef: b,
	});
	add(R1, "changes.landed", {
		changeId: cid("z"),
		laneId: laneA,
		commit: sha("e"),
		advanceId: "adv_01k6bbbbbbbbbbbbbbbbbbbbbb_1",
		workRef: a,
	});
	add(R1, "work.done", { ref: a, changeId: cid("z"), commit: sha("e") });
	add(R2, "lane.lost", {
		laneId: laneB,
		owner: AGENT,
		base: sha("0"),
		mode: "branch",
	});
	return out;
};

const cardsOf = (h: ReturnType<typeof harness>) =>
	rows(
		h.storage,
		"SELECT ref, column_id, rank, title, badges_json, updated_at, repo_id, kind FROM cards ORDER BY ref",
	);
const linksOf = (h: ReturnType<typeof harness>) =>
	rows(h.storage, "SELECT link_key, ref FROM links ORDER BY link_key");

Deno.test("auto rules: create → claim → submit → batch → land moves the card to Done; badges follow", async () => {
	const h = harness();
	try {
		for (const ev of story()) await h.event(ev);
		const byRef = Object.fromEntries(
			cardsOf(h).map((c) => [c.ref, c]),
		) as Record<string, { column_id: string; badges_json: string }>;
		equal(byRef["acme/router#1"].column_id, "done");
		equal(byRef["acme/platform/api#1"].column_id, "review");
		deepStrictEqual(JSON.parse(byRef["acme/platform/api#1"].badges_json), [
			"issue",
			"r2",
			"lane lost",
		]);
		equal(byRef["acme/router#2"].column_id, "backlog");
		deepStrictEqual(JSON.parse(byRef["acme/router#1"].badges_json), [
			"intent",
			"r1",
		]);
	} finally {
		h.close();
	}
});

Deno.test("backfill: a board rebuilt from history equals the live board (other interleaving, redeliveries)", async () => {
	const events = story();
	const live = harness();
	const rebuilt = harness();
	try {
		// Live: one event at a time, as the drain delivers them, with renders between.
		for (const ev of events) {
			await live.event(ev);
			await live.render("board", {
				slot: "node.tab",
				node: GROUP,
				mode: "enforce",
				viewer,
			});
		}
		// Backfill: repo 2's stream drained first, then repo 1's; every event twice.
		const r2 = events.filter((e) => e.repo === R2);
		const r1 = events.filter((e) => e.repo === R1);
		for (const ev of [...r2, ...r1]) {
			await rebuilt.event(ev);
			await rebuilt.event(ev);
		}
		deepStrictEqual(cardsOf(rebuilt), cardsOf(live));
		deepStrictEqual(linksOf(rebuilt), linksOf(live));
		const a = await live.render("board", {
			slot: "node.tab",
			node: GROUP,
			mode: "enforce",
			viewer,
		});
		const b = await rebuilt.render("board", {
			slot: "node.tab",
			node: GROUP,
			mode: "enforce",
			viewer,
		});
		deepStrictEqual(a, b);
	} finally {
		live.close();
		rebuilt.close();
	}
});

Deno.test("move: work_update{ref, state} at the card's repo as the viewer; Landing and change cards do not move by hand", async () => {
	const h = harness();
	try {
		for (const ev of story()) await h.event(ev);
		const ctx = {
			slot: "node.tab" as const,
			node: GROUP,
			mode: "enforce" as const,
			viewer,
		};
		const out = await h.action(
			"move",
			{ card: "acme/router#2", from: "backlog", to: "progress" },
			ctx,
			{ actor: viewer },
		);
		equal(out.toast?.tone, "success");
		const call = h.recorder.calls.find((c) => c.method === "interfaces.call")!;
		deepStrictEqual(call.args, [
			"work@1",
			"work_update",
			{ ref: "acme/router#2", state: "claimed" },
			{ path: "acme/router" },
		]);
		// The card moves only when work.updated arrives.
		equal(
			cardsOf(h).find((c) => c.ref === "acme/router#2")!.column_id,
			"backlog",
		);
		const landing = await h.action(
			"move",
			{ card: "acme/router#2", from: "backlog", to: "landing" },
			ctx,
			{ actor: viewer },
		);
		equal(landing.toast?.tone, "warning");
		equal(
			h.recorder.calls.filter((c) => c.method === "interfaces.call").length,
			1,
		);
		// A change without a work item has its own card that follows the change.
		await h.event({
			...story()[0],
			id: "01k6f000000000000000000001",
			type: "changes.opened",
			data: {
				changeId: cid("x"),
				laneId: "ln_01k6000000000000000000000c",
				title: "Human fix",
			},
		});
		const changeCard = cardsOf(h).find((c) => c.ref === `change:${cid("x")}`)!;
		equal(changeCard.column_id, "progress");
		equal(changeCard.kind, "change");
		const fixed = await h.action(
			"move",
			{ card: `change:${cid("x")}`, from: "progress", to: "done" },
			ctx,
			{ actor: viewer },
		);
		equal(fixed.toast?.tone, "warning");
	} finally {
		h.close();
	}
});

Deno.test("render: valid board; only readable repos; repo tab filters its repo; anonymous sees nothing", async () => {
	const h = harness({
		"authz.check": (_p: string, node: { id: string }) => node.id === R1,
	});
	try {
		for (const ev of story()) await h.event(ev);
		const doc = await h.render("board", {
			slot: "node.tab",
			node: GROUP,
			mode: "enforce",
			viewer,
		});
		ok(validateUi(doc).ok, JSON.stringify(doc));
		const text = JSON.stringify(doc);
		ok(text.includes("Rate limiting"));
		ok(!text.includes("Quotas"), "repo 2 is not readable");
		ok(text.includes('"href":"/acme/router/-/work/1"'));
		ok(text.includes('"moveAction":{"id":"move"}'));
		const repoDoc = await h.render("repo-board", {
			slot: "repo.tab",
			node: R1,
			repo: R1,
			mode: "enforce",
			viewer,
		});
		ok(JSON.stringify(repoDoc).includes("Docs"));
		const anon = await h.render("board", {
			slot: "node.tab",
			node: GROUP,
			mode: "enforce",
		});
		ok(!JSON.stringify(anon).includes("Rate limiting"));
	} finally {
		h.close();
	}
});
