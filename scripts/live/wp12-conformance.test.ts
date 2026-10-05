// WP12 on WP7b's extension host: tartan.board passes the js conformance run of
// the WP7b harness. The real host (`createExtensionHost`, its drain, cursors,
// `_seen` dedupe, render validation and cache, action and tool checks) runs
// over WP7b's in-memory fakes, for the builtin runtime and for the isolated
// in-process runtime that stands in for the M2 js facet (breaker, write-ahead
// markers).
//
// Board: backfill from 0 across two repo streams equals the live board; a
// rewound cursor redelivers nothing; renders validate; a move runs
// `work_update` as the viewer. Work and changes: their tool results pass the
// host's interface-schema checks (input and output of work@1 / changes@1).

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	type ActorBounds,
	type Envelope,
	type Manifest,
	parseManifest,
	SESSION_BOUNDS,
} from "@tartan/contract";
import {
	agentActor,
	inForce,
	INSTALLATION_ID,
	NODES,
	PRINCIPALS,
	userActor,
} from "../../src/kernel/exthost/host/testing/fakes.ts";
import {
	createTestHost,
	query,
	repoScopeName,
	type TestHost,
} from "../../src/kernel/exthost/host/testing/memory.ts";
import * as board from "../../extensions/board/src/index.ts";
import boardJson from "../../extensions/board/tartan.json" with {
	type: "json",
};
import * as changes from "../../extensions/changes/src/index.ts";
import changesJson from "../../extensions/changes/tartan.json" with {
	type: "json",
};
import * as work from "../../extensions/work/src/index.ts";
import workJson from "../../extensions/work/tartan.json" with { type: "json" };

const manifestOf = (raw: unknown): Manifest => {
	const parsed = parseManifest(raw);
	if (!parsed.ok) throw new Error(parsed.errors.join("; "));
	return parsed.manifest;
};
const boardManifest = manifestOf(boardJson);
const workManifest = manifestOf(workJson);
const changesManifest = manifestOf(changesJson);

const RUNTIMES = [
	{ label: "builtin", isolated: false },
	{ label: "isolated (js path)", isolated: true },
] as const;

const R1 = NODES.router;
const R2 = NODES.platformApi;
const cid = (c: string) => c.repeat(32);
const sha = (c: string) => c.repeat(40);
const workSource = {
	kind: "installation" as const,
	id: "i_01k6000000000000000000000w",
	ext: "tartan.work@0.1.0",
};

type Step = { repo: string; type: string; data: Record<string, unknown> };

const STORY: readonly Step[] = [
	{
		repo: R1.id,
		type: "work.created",
		data: { ref: "acme/router#1", kind: "intent", title: "Rate limiting" },
	},
	{
		repo: R2.id,
		type: "work.created",
		data: { ref: "acme/platform/api#1", kind: "issue", title: "Quotas" },
	},
	{
		repo: R1.id,
		type: "work.claimed",
		data: {
			ref: "acme/router#1",
			principal: PRINCIPALS.agent,
			laneId: "ln_01k6000000000000000000000a",
		},
	},
	{
		repo: R1.id,
		type: "changes.opened",
		data: {
			changeId: cid("z"),
			laneId: "ln_01k6000000000000000000000a",
			workRef: "acme/router#1",
		},
	},
	{
		repo: R2.id,
		type: "work.claimed",
		data: {
			ref: "acme/platform/api#1",
			principal: PRINCIPALS.agent,
			laneId: "ln_01k6000000000000000000000b",
		},
	},
	{
		repo: R1.id,
		type: "changes.submitted",
		data: {
			changeId: cid("z"),
			laneId: "ln_01k6000000000000000000000a",
			revision: 1,
			head: sha("1"),
			base: sha("0"),
			affected: [],
			workRef: "acme/router#1",
		},
	},
	{
		repo: R1.id,
		type: "queue.batched",
		data: {
			batchId: "lb_01k6bbbbbbbbbbbbbbbbbbbbbb",
			partition: "api",
			changes: [cid("z")],
		},
	},
	{
		repo: R2.id,
		type: "lane.lost",
		data: {
			laneId: "ln_01k6000000000000000000000b",
			owner: PRINCIPALS.agent,
			base: sha("0"),
			mode: "branch",
		},
	},
	{
		repo: R1.id,
		type: "changes.landed",
		data: {
			changeId: cid("z"),
			laneId: "ln_01k6000000000000000000000a",
			commit: sha("e"),
			advanceId: "adv_01k6bbbbbbbbbbbbbbbbbbbbbb_1",
			workRef: "acme/router#1",
		},
	},
	{
		repo: R1.id,
		type: "work.done",
		data: { ref: "acme/router#1", changeId: cid("z"), commit: sha("e") },
	},
];

const boardHost = (isolated: boolean): Promise<TestHost> =>
	createTestHost({
		manifest: boardManifest,
		migrations: board.migrations,
		module: () => board.extension,
		isolated,
		name: `ext:${INSTALLATION_ID}:node`,
	});

const add = (t: TestHost, step: Step, at: number): Envelope =>
	t.kernel.addEvent(step.repo, {
		type: step.type,
		data: step.data,
		source: workSource,
		at,
		// Ids sort by time, as ULIDs do (the board ranks cards by them).
		id: `01k6e${String(at).padStart(21, "0")}`,
	});

const pokeAll = async (t: TestHost) => {
	for (const repo of [R1.id, R2.id]) {
		await t.host.poke({ stream: `repo:${repo}`, head: t.kernel.head(repo) });
	}
};

const cards = (t: TestHost) =>
	query(
		t,
		"SELECT ref, column_id, rank, title, badges_json, updated_at, repo_id, kind FROM cards ORDER BY ref",
	);

const viewer = {
	actor: userActor(PRINCIPALS.dev),
	role: 30,
	kind: "user" as const,
};
const boardCtx = {
	slot: "node.tab" as const,
	node: NODES.acme.id,
	mode: "enforce" as const,
	viewer: viewer.actor,
};

for (const runtime of RUNTIMES) {
	Deno.test(`conformance (${runtime.label}): tartan.board backfills from 0 across repos and equals the live board`, async () => {
		const live = await boardHost(runtime.isolated);
		const rebuilt = await boardHost(runtime.isolated);
		try {
			// Live: a poke after every append, as RepoDO's append path does.
			let at = 1_000;
			for (const step of STORY) {
				add(live, step, ++at);
				await pokeAll(live);
			}
			// Installed afterwards with backfill "all": the history is drained from seq 0.
			at = 1_000;
			for (const step of STORY) add(rebuilt, step, ++at);
			await pokeAll(rebuilt);
			deepStrictEqual(cards(rebuilt), cards(live));
			equal(
				(cards(live).find((c) => c.ref === "acme/router#1") as {
					column_id: string;
				}).column_id,
				"done",
			);
			// Dedupe: a rewound cursor and repeated pokes change nothing.
			const before = cards(rebuilt);
			rebuilt.storage.sql.exec("UPDATE _cursors SET seq = 0");
			await pokeAll(rebuilt);
			await pokeAll(rebuilt);
			deepStrictEqual(cards(rebuilt), before);
			// Through the host: validated, cached per viewer, no error chip.
			const doc = await live.host.render("board", boardCtx, viewer);
			ok(doc.root.t !== "error-chip", JSON.stringify(doc));
			const text = JSON.stringify(doc);
			ok(text.includes("Rate limiting") && text.includes("Quotas"));
			deepStrictEqual(
				await rebuilt.host.render("board", boardCtx, viewer),
				doc,
			);
			// A Reporter of acme/router only does not see acme/platform/api's card.
			const reporter = {
				actor: userActor(PRINCIPALS.reporter),
				role: 20,
				kind: "user" as const,
			};
			const limited = JSON.stringify(
				await live.host.render("repo-board", {
					slot: "repo.tab",
					node: R1.id,
					repo: R1.id,
					mode: "enforce",
					viewer: reporter.actor,
				}, reporter),
			);
			ok(limited.includes("Rate limiting") && !limited.includes("Quotas"));
		} finally {
			live.close();
			rebuilt.close();
		}
	});

	Deno.test(`conformance (${runtime.label}): a board move runs work_update as the viewer`, async () => {
		const t = await boardHost(runtime.isolated);
		try {
			t.kernel.providers.set(
				`work@1@${NODES.acme.id}`,
				inForce(workManifest, {
					id: "i_01k6000000000000000000000w",
					storageScope: "repo",
				}),
			);
			const seen: unknown[] = [];
			t.kernel.callTool = (target, name, args, ctx) => {
				seen.push({ target, name, args, actor: ctx.actor, repo: ctx.repo });
				// The provider's answer (a WorkItem), validated by caps against work@1.
				return Promise.resolve({
					ref: "acme/router#1",
					kind: "intent",
					title: "Rate limiting",
					why: "",
					acceptance: [],
					footprint: { projects: [], prefixes: [] },
					state: "in_review",
					claims: [],
					labels: [],
					priority: 2,
				});
			};
			add(t, STORY[0], 1_001);
			await pokeAll(t);
			const out = await t.host.action(
				"board",
				"move",
				{ card: "acme/router#1", from: "backlog", to: "review" },
				boardCtx,
				viewer.actor,
				SESSION_BOUNDS,
			);
			equal(out.toast?.tone, "success");
			deepStrictEqual(seen, [{
				target: {
					installationId: "i_01k6000000000000000000000w",
					scope: { kind: "repo", repoId: R1.id },
				},
				name: "work_update",
				args: { ref: "acme/router#1", state: "in_review" },
				actor: viewer.actor,
				repo: R1.id,
			}]);
		} finally {
			t.close();
		}
	});

	Deno.test(`conformance (${runtime.label}): work@1 and changes@1 results pass the host's interface checks`, async () => {
		const bounds: ActorBounds = {
			maxRole: 30,
			scopes: null,
			nodeId: null,
			laneId: null,
		};
		const workHost = await createTestHost({
			manifest: workManifest,
			migrations: work.migrations,
			module: () => work.extension,
			isolated: runtime.isolated,
			name: repoScopeName(),
		});
		const changesHost = await createTestHost({
			manifest: changesManifest,
			migrations: changes.migrations,
			module: () => changes.extension,
			isolated: runtime.isolated,
			name: repoScopeName(),
			kernel: workHost.kernel,
		});
		try {
			const toolCtx = (
				actor = agentActor(PRINCIPALS.agent, PRINCIPALS.dev),
			) => ({
				node: R1.id,
				repo: R1.id,
				scope: R1.path,
				actor,
				mode: "enforce" as const,
			});
			const created = await workHost.host.callTool(
				"work_create",
				{
					repo: R1.path,
					kind: "intent",
					title: "Rate limiting",
				},
				toolCtx(userActor(PRINCIPALS.dev)),
				SESSION_BOUNDS,
			) as { ref: string };
			equal(created.ref, "acme/router#1");
			const claim = await workHost.host.callTool(
				"work_claim",
				{
					ref: created.ref,
					footprint: { projects: ["api"], prefixes: [] },
				},
				toolCtx(),
				bounds,
			) as { lane: { id: string; state: string }; overlaps: unknown[] };
			equal(claim.lane.state, "open");
			// The fake RepoDO's openLane does not keep the lane; record it as WP5a would.
			workHost.kernel.lanes.set(claim.lane.id, {
				id: claim.lane.id,
				repoId: R1.id,
				kind: "lane",
				mode: "branch",
				ref: `refs/heads/lanes/${claim.lane.id}`,
				branch: `lanes/${claim.lane.id}`,
				owner: PRINCIPALS.agent,
				delegates: [],
				footprint: { projects: ["api"], prefixes: [] },
				base: sha("a"),
				head: sha("b"),
				state: "open",
				quarantined: false,
				leaseExpiresAt: 0,
				pushes: 1,
				createdAt: 0,
				remote: `/${R1.path}.git`,
			});
			deepStrictEqual(claim.overlaps, []);
			const types = workHost.kernel.appended.map((a) => a.type);
			deepStrictEqual(types, ["work.created", "work.claimed"]);
			// The fake lane (head ≠ base, one push) is submittable at once.
			const submitted = await changesHost.host.callTool(
				"changes_submit",
				{
					laneId: claim.lane.id,
					title: "Token bucket",
					summary: "Adds a limiter",
				},
				toolCtx(),
				bounds,
			) as { changeId: string; revision: number };
			equal(submitted.revision, 1);
			const got = await changesHost.host.callTool(
				"changes_get",
				{
					changeId: submitted.changeId,
				},
				toolCtx(),
				bounds,
			) as { state: string };
			equal(got.state, "submitted");
			ok(workHost.kernel.appended.some((a) => a.type === "changes.submitted"));
			// K16 at the provider: an agent never adopts a branch.
			let refused = "";
			try {
				await changesHost.host.callTool(
					"changes_open",
					{
						repo: R1.path,
						sourceRef: "feature/x",
					},
					toolCtx(),
					bounds,
				);
			} catch (error) {
				refused = String(error);
			}
			ok(refused.includes("lane-op"), refused);
		} finally {
			workHost.close();
			changesHost.close();
		}
	});
}
