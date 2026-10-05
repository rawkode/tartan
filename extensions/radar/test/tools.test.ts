// conflicts@1 tools (conflicts_check, conflicts_list, conflicts_ack): outputs
// match the contract's tool schemas; claim-time footprint overlaps on both
// backends; acknowledgement rules.

import { INTERFACES, isTartanError } from "@tartan/contract";
import { createTestHarness } from "@tartan/ext-api/testing.ts";
import {
	agentId,
	conflicts,
	createRadar,
	emitted,
	equal,
	laneOpened,
	notices,
	ok,
	pushed,
	putLane,
	rejects,
	sha,
	userId,
} from "./kit.ts";

const TOOLS = INTERFACES["conflicts@1"].tools;
const API = "services/api/src/middleware/limit.ts";
const REPO_ARG = "acme/platform/router";

const parsed = (name: keyof typeof TOOLS, out: unknown) => {
	const r = TOOLS[name].output.safeParse(out);
	ok(r.success, `${name} output: ${JSON.stringify(out)}`);
	return out;
};

type Check = {
	results: {
		target: string;
		lanes: {
			laneId: string;
			severity: string;
			suggestion: string;
			fetch: string;
			agent: string;
		}[];
		severity?: string;
		suggestion: string;
	}[];
};

Deno.test("conflicts_check at claim: footprint overlaps with a repo lane and a branch lane alike", async () => {
	const r = createRadar();
	const repoLane = putLane(r.world, {
		n: 1,
		mode: "repo",
		handle: "codex-2",
		footprint: { prefixes: ["services/api/src/middleware"] },
		entity: { kind: "work", id: "acme/platform/router#38" },
	});
	r.world.work.set("acme/platform/router#38", {
		title: "per-tenant quotas",
		why: "noisy tenants",
	});
	const branchLane = putLane(r.world, {
		n: 2,
		handle: "gemini",
		footprint: { projects: ["api"] },
	});
	await r.deliver(laneOpened(repoLane), laneOpened(branchLane));
	// The new lane (claimed now) is not projected yet: tartan.work calls
	// conflicts_check right after caps.lanes.open.
	const mine = putLane(r.world, { n: 3, mode: "repo", state: "opening" });
	const out = parsed(
		"conflicts_check",
		await r.tool("conflicts_check", {
			repo: REPO_ARG,
			laneId: mine.id,
			footprint: {
				projects: ["api"],
				prefixes: ["services/api/src/middleware/limit.ts"],
			},
		}, r.toolCtx(mine.owner)),
	) as Check;
	equal(
		out.results.map((
			x,
		) => [x.target, x.severity, x.lanes.map((l) => l.laneId)]),
		[
			["services/api/src/middleware/limit.ts", "declared", [repoLane.id]],
			["project:api", "declared", [branchLane.id]],
		],
	);
	const first = out.results[0].lanes[0];
	equal(first.agent, "codex-2");
	equal(first.suggestion, "coordinate");
	equal(
		first.fetch,
		`git fetch /acme/platform/router/-/lanes/${repoLane.id}.git main`,
	);
	equal(
		out.results[1].lanes[0].fetch,
		`git fetch origin refs/heads/lanes/${branchLane.id}`,
	);
	equal(out.results[0].suggestion, "coordinate");
	ok(
		r.q("SELECT * FROM lanes WHERE lane_id = ?", mine.id).length === 0,
		"read-only: nothing stored",
	);
});

Deno.test("conflicts_check on paths: shared file, same project, declared; own lane left out", async () => {
	const r = createRadar();
	const a = putLane(r.world, { n: 1 });
	const b = putLane(r.world, {
		n: 2,
		footprint: { prefixes: ["services/api"] },
	});
	const me = putLane(r.world, { n: 3 });
	await r.deliver(laneOpened(a), laneOpened(b), laneOpened(me));
	await r.deliver(pushed(r.world, a.id, { after: sha(10), paths: [API] }));
	await r.deliver(pushed(r.world, me.id, { after: sha(30), paths: [API] }));
	const out = parsed(
		"conflicts_check",
		await r.tool("conflicts_check", {
			repo: REPO_ARG,
			laneId: me.id,
			paths: [API, "services/api/src/other.ts", "docs/readme.md"],
		}, r.toolCtx(me.owner)),
	) as Check;
	equal(
		out.results.map((
			x,
		) => [
			x.target,
			x.severity ?? null,
			x.lanes.map((l) => [l.laneId, l.severity]),
		]),
		[
			[API, "same_file", [[a.id, "same_file"], [b.id, "declared"]]],
			["services/api/src/other.ts", "same_project", [[a.id, "same_project"], [
				b.id,
				"declared",
			]]],
			["docs/readme.md", null, []],
		],
	);
	equal(out.results[2].suggestion, "proceed");
	// With only a laneId: the lane's own touches and footprint.
	const own = await r.tool(
		"conflicts_check",
		{ repo: REPO_ARG, laneId: me.id },
		r.toolCtx(me.owner),
	) as Check;
	equal(own.results.map((x) => x.target), [API]);
});

Deno.test("conflicts_list: by repo and by lane, open by default; entities match the contract", async () => {
	const r = createRadar();
	const a = putLane(r.world, { n: 1 });
	const b = putLane(r.world, { n: 2 });
	const c = putLane(r.world, { n: 3 });
	await r.deliver(laneOpened(a), laneOpened(b), laneOpened(c));
	await r.deliver(pushed(r.world, a.id, { after: sha(10), paths: [API] }));
	await r.deliver(pushed(r.world, b.id, { after: sha(20), paths: [API] }));
	await r.deliver(
		pushed(r.world, c.id, { after: sha(30), paths: ["apps/web/x.ts"] }),
	);
	const all = parsed(
		"conflicts_list",
		await r.tool("conflicts_list", { repo: REPO_ARG }, r.toolCtx(a.owner)),
	) as {
		conflicts: { a: string; b: string; state: string }[];
	};
	equal(all.conflicts.length, 1);
	const ofC = await r.tool(
		"conflicts_list",
		{ repo: REPO_ARG, laneId: c.id },
		r.toolCtx(a.owner),
	) as { conflicts: unknown[] };
	equal(ofC.conflicts, []);
	await r.deliver(pushed(r.world, b.id, { after: sha(21), paths: ["x.md"] }));
	const cleared = parsed(
		"conflicts_list",
		await r.tool(
			"conflicts_list",
			{ repo: REPO_ARG, state: "cleared" },
			r.toolCtx(a.owner),
		),
	) as { conflicts: { avoided: boolean }[] };
	equal(cleared.conflicts.map((x) => x.avoided), [true]);
});

Deno.test("conflicts_ack: an owner acknowledges; the other owner is told; a stranger is refused; a Maintainer may", async () => {
	const r = createRadar();
	const a = putLane(r.world, { n: 1, handle: "claude-code" });
	const b = putLane(r.world, { n: 2, handle: "codex-2" });
	await r.deliver(laneOpened(a), laneOpened(b));
	await r.deliver(pushed(r.world, a.id, { after: sha(10), paths: [API] }));
	await r.deliver(pushed(r.world, b.id, { after: sha(20), paths: [API] }));
	const [row] = conflicts(r, "open");
	const before = notices(r).length;
	await rejects(
		r.tool(
			"conflicts_ack",
			{ conflictId: row.id, resolution: "ignore" },
			r.toolCtx(agentId(99)),
		),
		(e) => isTartanError(e) && e.code === "denied",
		"a stranger may not acknowledge",
	);
	const acked = parsed(
		"conflicts_ack",
		await r.tool("conflicts_ack", {
			conflictId: row.id,
			resolution: "stack",
			note: "I will rebase onto yours",
		}, r.toolCtx(b.owner)),
	) as { state: string; ack: { by: string; resolution: string } };
	equal([acked.state, acked.ack.by, acked.ack.resolution], [
		"acked",
		b.owner,
		"stack",
	]);
	const told = notices(r).slice(before);
	equal(told.map((n) => n.principal), [a.owner]);
	ok(
		told[0].notice.text.includes("codex-2 acknowledged same_file"),
		told[0].notice.text,
	);
	ok(told[0].notice.text.includes("I will rebase onto yours"));
	equal(emitted(r, "conflicts.acked").map((e) => e.data), [{
		conflictId: row.id,
		by: b.owner,
		resolution: "stack",
	}]);
	ok(
		INTERFACES["conflicts@1"].events["conflicts.acked"].safeParse(
			emitted(r, "conflicts.acked")[0].data,
		).success,
	);
	// An acked conflict is not announced again at the same severity.
	await r.deliver(pushed(r.world, a.id, { after: sha(11), paths: [API] }));
	equal(notices(r).length, before + 1);
	// A Maintainer, and the user an agent acts for, may acknowledge too.
	r.world.maintainers.add(userId(5));
	await r.tool("conflicts_ack", {
		conflictId: row.id,
		resolution: "coordinate",
	}, r.toolCtx(userId(5)));
	r.world.principals.set(a.owner, {
		handle: "claude-code",
		ownerUserId: userId(6),
	});
	await r.tool(
		"conflicts_ack",
		{ conflictId: row.id, resolution: "adapt" },
		r.toolCtx(userId(6)),
	);
	await rejects(
		r.tool(
			"conflicts_ack",
			{ conflictId: "cf_missing", resolution: "adapt" },
			r.toolCtx(a.owner),
		),
		(e) => isTartanError(e) && e.code === "not_found",
	);
});

Deno.test("an unknown tool is invalid", async () => {
	const r = createRadar();
	await rejects(
		r.tool("conflicts_nope", {}, r.toolCtx(agentId(1))),
		(e) => isTartanError(e) && e.code === "invalid",
	);
});

Deno.test("read-only tools never write (the host runs them read-only)", async () => {
	const r = createRadar();
	const a = putLane(r.world, { n: 1 });
	await r.deliver(laneOpened(a));
	const ro = r.ctx({ readOnly: true, actor: { kind: "agent", id: a.owner } });
	const { callTool } = await import("../src/tools.ts");
	await callTool(
		"conflicts_check",
		{ repo: REPO_ARG, laneId: a.id, paths: [API] },
		r.toolCtx(a.owner),
		ro,
	);
	await callTool("conflicts_list", { repo: REPO_ARG }, r.toolCtx(a.owner), ro);
	ok(true);
});

Deno.test("a configured https origin makes repo-lane fetch commands absolute", async () => {
	const { extension, migrations } = await import("../src/index.ts");
	const manifest =
		(await import("../tartan.json", { with: { type: "json" } })).default;
	const r = createRadar();
	const h = createTestHarness({
		module: extension,
		migrations,
		grants: manifest.permissions as never,
		install: {
			id: "i_01k60000000000000000000992",
			extId: "tartan.radar",
			scopeKey: r.ctx().install.scopeKey,
		},
		config: { origin: "https://code.example.com/" },
		handlers: {
			"lanes.get": ((id: string) => r.world.lanes.get(id)) as never,
			"lanes.list": (() => [...r.world.lanes.values()]) as never,
			"principals.get": ((id: string) => ({
				id,
				kind: "agent",
				handle: "x",
				display: "x",
			})) as never,
		},
	});
	const repoLane = putLane(r.world, {
		n: 1,
		mode: "repo",
		footprint: { prefixes: ["a"] },
	});
	await h.init();
	const out = await h.tool("conflicts_check", {
		repo: REPO_ARG,
		paths: ["a/b.ts"],
	}, r.toolCtx(agentId(9))) as Check;
	equal(
		out.results[0].lanes[0].fetch,
		`git fetch https://code.example.com/acme/platform/router/-/lanes/${repoLane.id}.git main`,
	);
});
