// tartan.review acceptance (K4, K13): by-exception routing with policy from
// trunk, forced human routes (policy files, weakened tests), the human-required
// gate that only counts a user's approval of the landed head, the deterministic
// seeded split, the track record and radar factors, slots and context.

import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import {
	type ExtCtx,
	type RefAdvanceGateInput,
	validateUi,
} from "@tartan/contract";
import { makeEvent } from "@tartan/testkit";
import * as reviewModule from "../../../extensions/review/src/index.ts";
import {
	AGENT,
	AGENT_2,
	change,
	createFlow,
	type Flow,
	lane,
	OTHER_USER,
	REPO,
	REVIEW_INST,
	USER,
} from "./flow.ts";
import {
	DEMO_GLOBAL,
	DEMO_PIPELINE,
	DEMO_PROJECTS,
	PNPM_REPO,
	tartanCue,
	withFiles,
	without,
} from "./repo.ts";

/** Owners rules (`tartan.review`'s repo policy) with the api rule at `sensitivity`. */
const owners = (sensitivity = 3, extra: unknown[] = []) => ({
	rules: [
		{
			paths: ["services/api/**"],
			sensitivity,
			owners: [USER, "@platform"],
		},
		{ paths: ["apps/web/src/checkout/**"], sensitivity: 2 },
		...extra,
	],
});
/** The demo repo's package tartan with owners rules; no project is marked sensitive. */
const tartanWith = (o: unknown) =>
	tartanCue({
		pipeline: DEMO_PIPELINE,
		projects: {
			...DEMO_PROJECTS,
			api: { root: "services/api", deps: ["shared"], owners: ["@platform"] },
		},
		global: DEMO_GLOBAL,
		owners: o,
	});
const BASE_FILES = withFiles(PNPM_REPO, { "tartan.cue": tartanWith(owners()) });

type Decided = {
	changeId: string;
	revision: number;
	head: string;
	decision: string;
	route: string;
	risk?: number;
	decidedBy: { kind: string; id: string };
	evidence?: { reasons?: string[]; factors?: Record<string, number> };
};
type Requested = {
	changeId: string;
	head: string;
	attentionSet: string[];
	risk?: number;
	factors?: Record<string, number>;
};

/** Submits a change, finishes its CI with `jobStates`, and pipes checks to review. */
const submitAndTest = async (
	f: Flow,
	o: {
		c: string;
		l: string;
		head: string;
		base: string;
		revision?: number;
		actor?: string;
		fail?: boolean;
	},
) => {
	const before = f.starts.length;
	await f.submit({
		changeId: o.c,
		laneId: o.l,
		head: o.head,
		base: o.base,
		revision: o.revision ?? 1,
		type: (o.revision ?? 1) > 1 ? "changes.revised" : "changes.submitted",
		...(o.actor ? { actor: o.actor } : {}),
	});
	if (f.starts.length > before) {
		const run = f.starts.at(-1)!;
		const failing = o.fail
			? Object.fromEntries(
				run.graph.jobs.filter((j) => j.id.startsWith("test-")).map((
					j,
				) => [j.id, "failure" as const]),
			)
			: {};
		await f.finish(run.runId, failing);
	}
};

const decided = (f: Flow) =>
	f.emitted(f.review, "review.decided").map((e) => e.data as Decided);
const requested = (f: Flow) =>
	f.emitted(f.review, "review.requested").map((e) => e.data as Requested);

const toolCtx = (actor: { kind: "user" | "agent" | "ext"; id: string }) => ({
	node: REPO,
	repo: REPO,
	scope: "acme/platform/router",
	actor,
	mode: "enforce" as const,
});

Deno.test("review: a small change in one project is approved automatically, bound to its head", async () => {
	const f = createFlow();
	const base = f.world.commit(BASE_FILES);
	const head = f.world.commit(withFiles(BASE_FILES, {
		"apps/web/src/main.ts": "import 'shared'; // copy\n",
	}));
	const C = change("k");
	await submitAndTest(f, { c: C, l: lane("1"), head, base });
	const [d] = decided(f);
	equal(d.decision, "approve");
	equal(d.route, "auto");
	deepStrictEqual([d.changeId, d.revision, d.head], [C, 1, head]);
	deepStrictEqual(d.decidedBy, { kind: "ext", id: `x_${REVIEW_INST}` });
	ok((d.risk ?? 1) < 0.35, String(d.risk));
	equal(requested(f).length, 0);
	equal(f.notes.length, 1);
	deepStrictEqual((f.notes[0].section as { route: string }).route, "auto");
	// Owners rules are read at the base here: this flow has no trunk tip (K13).
	const reads = f.calls(f.review, "repo.policy");
	ok(reads.length > 0);
	ok(reads.every((c) => c.args[1] === base));
});

Deno.test("review: owners rules added on trunk after the lane's base still route the change to a human", async () => {
	// The sensitive factor alone (3/12) clears 0.3, not the default 0.35.
	const f = createFlow({ reviewConfig: { autoThreshold: 0.3 } });
	// The lane is rooted on an old trunk commit, before the rule.
	const old = f.world.commit(BASE_FILES);
	const tip = f.world.commit(withFiles(BASE_FILES, {
		"tartan.cue": tartanWith(
			owners(3, [{
				paths: ["apps/web/src/**"],
				sensitivity: 3,
				owners: [USER],
			}]),
		),
	}));
	f.setTrunk(tip);
	const head = f.world.commit(withFiles(BASE_FILES, {
		"apps/web/src/main.ts": "import 'shared'; // copy\n",
	}));
	await submitAndTest(f, { c: change("k"), l: lane("1"), head, base: old });
	equal(decided(f).length, 0, "no automatic approval");
	const [r] = requested(f);
	equal(r.factors?.sensitive, 1, "the rule from the trunk tip applies");
	ok(
		f.calls(f.review, "repo.policy").every((c) => c.args[1] === tip),
		"owners rules are read at the trunk tip",
	);
});

Deno.test("review: a change lowering its own owners sensitivity in package tartan goes to a human", async () => {
	const f = createFlow();
	const base = f.world.commit(BASE_FILES);
	const head = f.world.commit(withFiles(BASE_FILES, {
		"tartan.cue": tartanWith(owners(0)),
		"services/api/src/middleware/limit.ts": "export const limit = 1000;\n",
	}));
	await submitAndTest(f, { c: change("k"), l: lane("1"), head, base });
	equal(decided(f).length, 0);
	const [r] = requested(f);
	deepStrictEqual(r.attentionSet, [USER]);
	equal(
		r.factors?.sensitive,
		1,
		"sensitivity from the base rules, not the lane's",
	);
	const review = await f.review.tool(
		"review_get",
		{ changeId: change("k") },
		toolCtx({ kind: "user", id: USER }),
	) as {
		route: string;
		evidence: { forced: string[]; policyFiles: string[] };
	};
	equal(review.route, "human");
	ok(review.evidence.forced.includes("policy-file"));
	deepStrictEqual(review.evidence.policyFiles, ["tartan.cue"]);
	deepStrictEqual(f.review.recorder.notices.map((n) => n.principal), [USER]);
});

Deno.test("review: deleting a test file raises the weakened-tests factor and routes to a human", async () => {
	const f = createFlow();
	const base = f.world.commit(BASE_FILES);
	const head = f.world.commit(
		without(BASE_FILES, "services/api/test/limit.test.ts"),
	);
	await submitAndTest(f, { c: change("k"), l: lane("1"), head, base });
	const [r] = requested(f);
	equal(r.factors?.weakenedTests, 1);
	const review = await f.review.tool(
		"review_get",
		{ changeId: change("k") },
		toolCtx({ kind: "user", id: USER }),
	) as {
		evidence: { forced: string[]; weakened: { deletedTests: string[] } };
	};
	ok(review.evidence.forced.includes("weakened-tests"));
	deepStrictEqual(review.evidence.weakened.deletedTests, [
		"services/api/test/limit.test.ts",
	]);
});

Deno.test("review: an edited test script is a policy-file change; a dependency bump is not", async () => {
	const f = createFlow();
	const base = f.world.commit(BASE_FILES);
	const script = f.world.commit(withFiles(BASE_FILES, {
		"apps/web/package.json": JSON.stringify({
			name: "web",
			dependencies: { shared: "workspace:^" },
			scripts: { test: "true" },
		}),
	}));
	await submitAndTest(f, { c: change("k"), l: lane("1"), head: script, base });
	equal(requested(f).length, 1);
	const bump = f.world.commit(withFiles(BASE_FILES, {
		"apps/web/package.json": JSON.stringify({
			name: "web",
			dependencies: { shared: "workspace:^", zod: "4.0.0" },
			scripts: { test: "vitest run" },
		}),
	}));
	await submitAndTest(f, { c: change("m"), l: lane("2"), head: bump, base });
	const review = await f.review.tool(
		"review_get",
		{ changeId: change("m") },
		toolCtx({ kind: "user", id: USER }),
	) as {
		evidence: { forced: string[]; policyFiles: string[] };
	};
	deepStrictEqual(review.evidence.policyFiles, []);
	ok(!review.evidence.forced.includes("policy-file"));
});

Deno.test("review: failing checks get request_changes and the author is told", async () => {
	const f = createFlow();
	const base = f.world.commit(BASE_FILES);
	const head = f.world.commit(withFiles(BASE_FILES, {
		"apps/web/src/main.ts": "import 'shared'; // broken\n",
	}));
	await submitAndTest(f, {
		c: change("k"),
		l: lane("1"),
		head,
		base,
		fail: true,
	});
	const [d] = decided(f);
	equal(d.decision, "request_changes");
	equal(d.head, head);
	ok(f.review.recorder.notices.some((n) => n.principal === AGENT));
	equal(f.notes.length, 0);

	// A flaky failure: re-run green on the same head is judged again.
	const ctx = {
		node: REPO,
		repo: REPO,
		scope: "acme",
		actor: { kind: "agent" as const, id: AGENT },
		mode: "enforce" as const,
	};
	await f.ci.tool("checks_rerun", { repo: REPO, changeId: change("k") }, ctx);
	await f.finish(f.starts.at(-1)!.runId);
	const again = decided(f);
	equal(again.length, 2);
	deepStrictEqual(
		[again[1].decision, again[1].route, again[1].head],
		["approve", "auto", head],
	);
	// A redelivered green checks.completed does not decide twice.
	await f.review.event(makeEvent("checks.completed", {
		subject: { kind: "change", id: change("k") },
		sha: head,
		state: "success",
		contexts: [],
		cached: false,
	}));
	equal(decided(f).length, 2);
});

Deno.test("review: human-required mode gates the advance on a user's approval of exactly the head", async () => {
	const f = createFlow({
		reviewConfig: { mode: "human-required" },
		approvers: [USER],
	});
	const base = f.world.commit(BASE_FILES);
	const r1 = f.world.commit(withFiles(BASE_FILES, {
		"apps/web/src/main.ts": "import 'shared'; // r1\n",
	}));
	const C = change("k");
	await submitAndTest(f, { c: C, l: lane("1"), head: r1, base });
	equal(decided(f).length, 0, "no automatic approval");
	equal(requested(f).length, 1);
	const gateInput = (head: string): RefAdvanceGateInput => ({
		point: "ref.advance",
		repo: REPO,
		ref: "refs/heads/main",
		base,
		head,
		changeId: C,
		changedPaths: [],
		addedLines: [],
		truncated: false,
		workRefs: [],
		actor: { kind: "system", id: "sys_kernel" },
	});
	equal((await f.review.gate("ref.advance", gateInput(r1))).decision, "veto");

	// Agents, extensions and roleless users cannot decide.
	await rejects(
		f.review.tool(
			"review_decide",
			{ changeId: C, decision: "approve" },
			toolCtx({ kind: "agent", id: AGENT }),
		),
		/only a user/,
	);
	await rejects(
		reviewModule.extension.onAction!("approve", { changeId: C }, {
			node: REPO,
			repo: REPO,
			mode: "enforce",
		}, f.review.ctx()),
		/user or agent actor/,
	);
	await rejects(
		f.review.tool(
			"review_decide",
			{ changeId: C, decision: "approve" },
			toolCtx({ kind: "user", id: OTHER_USER }),
		),
		/Maintainer/,
	);
	equal((await f.review.gate("ref.advance", gateInput(r1))).decision, "veto");

	const out = await f.review.tool("review_decide", {
		changeId: C,
		decision: "approve",
		revision: 1,
	}, toolCtx({ kind: "user", id: USER })) as {
		decision: string;
		decidedBy: { kind: string; id: string };
	};
	equal(out.decision, "approve");
	deepStrictEqual(out.decidedBy, { kind: "user", id: USER });
	const [d] = decided(f);
	deepStrictEqual([d.route, d.head, d.decidedBy.kind], ["human", r1, "user"]);
	equal((await f.review.gate("ref.advance", gateInput(r1))).decision, "allow");
	// LandWorkflow sends the composed squash commit as `head` and the
	// approved lane head as `laneHead`; the approval of the lane head counts.
	const squash = "5".repeat(40);
	equal(
		(await f.review.gate("ref.advance", {
			...gateInput(squash),
			laneHead: r1,
		})).decision,
		"allow",
	);
	equal(
		(await f.review.gate("ref.advance", {
			...gateInput(squash),
			laneHead: "6".repeat(40),
		})).decision,
		"veto",
	);
	const other = f.world.commit(
		withFiles(BASE_FILES, { "apps/web/src/main.ts": "x\n" }),
	);
	equal(
		(await f.review.gate("ref.advance", gateInput(other))).decision,
		"veto",
	);

	// A new revision needs a new approval; deciding the old one is refused.
	const r2 = f.world.commit(withFiles(BASE_FILES, {
		"apps/web/src/main.ts": "import 'shared'; // r2\n",
	}));
	await submitAndTest(f, { c: C, l: lane("1"), head: r2, base, revision: 2 });
	equal((await f.review.gate("ref.advance", gateInput(r2))).decision, "veto");
	await rejects(
		f.review.tool("review_decide", {
			changeId: C,
			decision: "approve",
			revision: 1,
		}, toolCtx({ kind: "user", id: USER })),
		/not the latest/,
	);
});

Deno.test("review: the human-required gate ignores an extension's approval", async () => {
	const f = createFlow();
	const base = f.world.commit(BASE_FILES);
	const head = f.world.commit(withFiles(BASE_FILES, {
		"apps/web/src/main.ts": "import 'shared'; // auto\n",
	}));
	const C = change("k");
	await submitAndTest(f, { c: C, l: lane("1"), head, base });
	equal(decided(f)[0].route, "auto", "by-exception auto approval stored");
	// The same installation switched to human-required: the auto approval does not count.
	const x: ExtCtx = { ...f.review.ctx(), config: { mode: "human-required" } };
	const decision = await reviewModule.extension.gate!("ref.advance", {
		point: "ref.advance",
		repo: REPO,
		ref: "refs/heads/main",
		base,
		head,
		changeId: C,
		changedPaths: [],
		addedLines: [],
		truncated: false,
		workRefs: [],
		actor: { kind: "system", id: "sys_kernel" },
		review: {
			route: "auto",
			decision: "approve",
			decidedBy: { kind: "ext", id: `x_${REVIEW_INST}` },
		},
	}, x);
	equal(decision.decision, "veto");
	// In by-exception mode the gate allows (approvals travel as review.decided).
	equal(
		(await f.review.gate("ref.advance", {
			point: "ref.advance",
			repo: REPO,
			ref: "refs/heads/main",
			base,
			head,
			changeId: C,
			changedPaths: [],
			addedLines: [],
			truncated: false,
			workRefs: [],
			actor: { kind: "system", id: "sys_kernel" },
		})).decision,
		"allow",
	);
});

/** The demo seed: 41 changes, 38 routine, 3 that need a human. */
const seed = (base: Record<string, string>) => {
	const changes: { files: Record<string, string>; why: string }[] = [];
	for (let i = 0; i < 38; i++) {
		const target = i % 2 === 0
			? `apps/web/src/feature${i}.ts`
			: `packages/shared/src/util${i}.ts`;
		changes.push({
			files: { ...base, [target]: `export const v${i} = ${i};\n` },
			why: "routine",
		});
	}
	changes.push({
		files: {
			...base,
			"tartan.cue": tartanWith(owners(1)),
		},
		why: "policy",
	});
	const { ["services/api/test/limit.test.ts"]: _gone, ...noTest } = base;
	changes.push({ files: noTest, why: "weakened" });
	changes.push({
		files: {
			...base,
			"services/api/src/middleware/limit.ts":
				Array.from({ length: 450 }, (_, n) => `export const l${n} = ${n};`)
					.join("\n") + "\n",
			"packages/shared/src/index.ts": "export const x = 2;\n",
		},
		why: "risky",
	});
	return changes;
};

const runSeed = async () => {
	const f = createFlow();
	const files = BASE_FILES as Record<string, string>;
	const base = f.world.commit(files);
	const routes: string[] = [];
	const letters = "klmnopqrstuvwxyz";
	for (const [i, c] of seed(files).entries()) {
		const head = f.world.commit(c.files);
		const id = `${letters[i % 16]}${letters[Math.floor(i / 16)]}`.repeat(16);
		await submitAndTest(f, {
			c: id,
			l: lane(String(i % 8)),
			head,
			base,
			actor: i % 3 === 0 ? AGENT_2 : AGENT,
		});
		const r = await f.review.tool(
			"review_get",
			{ changeId: id },
			toolCtx({ kind: "user", id: USER }),
		) as {
			route: string;
			risk: number;
		};
		routes.push(`${c.why}:${r.route}:${r.risk}`);
	}
	return {
		routes,
		auto: decided(f).filter((d) => d.route === "auto").length,
		human: requested(f).length,
	};
};

Deno.test("review: the seeded scenario routes deterministically (38 auto / 3 human)", async () => {
	const a = await runSeed();
	const b = await runSeed();
	deepStrictEqual(a, b);
	equal(a.auto, 38, a.routes.join("\n"));
	equal(a.human, 3, a.routes.join("\n"));
	deepStrictEqual(
		a.routes.filter((r) => r.split(":")[1] === "human").map((r) =>
			r.split(":")[0]
		),
		["policy", "weakened", "risky"],
	);
});

Deno.test("review: shadow mode records shadow reviews without notices, notes or attention", async () => {
	const f = createFlow({ reviewMode: "shadow" });
	const base = f.world.commit(BASE_FILES);
	const head = f.world.commit(withFiles(BASE_FILES, {
		"tartan.cue": tartanWith(owners(0)),
	}));
	await submitAndTest(f, { c: change("k"), l: lane("1"), head, base });
	equal(requested(f).length, 1);
	equal(f.review.recorder.notices.length, 0);
	equal(f.notes.length, 0);
	const rows = f.review.storage.sql.exec<{ shadow: number }>(
		"SELECT shadow FROM reviews",
	).toArray();
	deepStrictEqual(rows.map((r) => r.shadow), [1]);
	equal(
		f.review.storage.sql.exec("SELECT * FROM attention").toArray().length,
		0,
	);
});

Deno.test("review: radar conflicts and the track record feed the risk; events count once", async () => {
	const f = createFlow({ reviewConfig: { autoThreshold: 0.2 } });
	const base = f.world.commit(BASE_FILES);
	const L = lane("1");
	await f.review.event(makeEvent("conflicts.detected", {
		conflictId: "cf1",
		a: L,
		b: lane("2"),
		path: "apps/web/src/main.ts",
		severity: "textual",
		suggestion: "coordinate",
	}));
	const head = f.world.commit(
		withFiles(BASE_FILES, {
			"apps/web/src/main.ts": "import 'shared'; // c\n",
		}),
	);
	await submitAndTest(f, { c: change("k"), l: L, head, base });
	const [r] = requested(f);
	equal(r.factors?.radar, 1);
	await f.review.event(
		makeEvent("conflicts.cleared", { conflictId: "cf1", avoided: true }),
	);

	const ejected = makeEvent("queue.ejected", {
		changeId: change("k"),
		reason: "conflict",
	});
	await f.review.event(ejected);
	await f.review.event(ejected);
	const track = f.review.storage.sql.exec<{ ejected: number }>(
		"SELECT ejected FROM track WHERE principal_id = ?",
		AGENT,
	).toArray();
	deepStrictEqual(track.map((t) => t.ejected), [1]);

	const head2 = f.world.commit(
		withFiles(BASE_FILES, {
			"apps/web/src/main.ts": "import 'shared'; // d\n",
		}),
	);
	await submitAndTest(f, { c: change("m"), l: lane("3"), head: head2, base });
	const review = await f.review.tool(
		"review_get",
		{ changeId: change("m") },
		toolCtx({ kind: "user", id: USER }),
	) as {
		factors: Record<string, number>;
	};
	equal(review.factors.radar, 0);
	ok(review.factors.trackRecord > 0);

	await f.review.event(makeEvent("ref.advanced", {
		ref: "refs/heads/main",
		old: base,
		new: head2,
		advanceId: "adv_1",
		changes: [{ changeId: change("m"), laneId: lane("3"), commit: head2 }],
		reasonEvents: [],
		evidenceReused: false,
	}));
	const landed = f.review.storage.sql.exec<{ landed: number }>(
		"SELECT landed FROM track WHERE principal_id = ?",
		AGENT,
	).toArray();
	deepStrictEqual(landed.map((t) => t.landed), [1]);
});

Deno.test("review: stale checks are ignored; a revision clears the attention set", async () => {
	const f = createFlow();
	const base = f.world.commit(BASE_FILES);
	const r1 = f.world.commit(withFiles(BASE_FILES, {
		"tartan.cue": tartanWith(owners(2)),
	}));
	const C = change("k");
	await submitAndTest(f, { c: C, l: lane("1"), head: r1, base });
	equal(
		f.review.storage.sql.exec("SELECT * FROM attention").toArray().length,
		1,
	);
	const r2 = f.world.commit(
		withFiles(BASE_FILES, {
			"apps/web/src/main.ts": "import 'shared'; // 2\n",
		}),
	);
	await f.submit({
		changeId: C,
		laneId: lane("1"),
		head: r2,
		base,
		revision: 2,
		type: "changes.revised",
	});
	equal(
		f.review.storage.sql.exec("SELECT * FROM attention").toArray().length,
		0,
	);
	// checks.completed for r1's head arrives late: ignored.
	await f.review.event(makeEvent("checks.completed", {
		subject: { kind: "change", id: C },
		sha: r1,
		state: "success",
		contexts: [],
		cached: false,
	}));
	equal(decided(f).length, 0);
	equal(requested(f).length, 1);
});

Deno.test("review: slots render valid tartan-ui; actions decide as the viewer; context lists rules", async () => {
	const f = createFlow();
	const base = f.world.commit(BASE_FILES);
	const head = f.world.commit(withFiles(BASE_FILES, {
		"tartan.cue": tartanWith(owners(2)),
	}));
	const C = change("k");
	await submitAndTest(f, { c: C, l: lane("1"), head, base });
	const x = f.review.ctx({ readOnly: true, actor: { kind: "user", id: USER } });
	for (
		const [slot, ctx] of [
			["evidence", {
				slot: "change.panel",
				node: REPO,
				repo: REPO,
				entity: { kind: "change", id: C },
				mode: "enforce",
			}],
			["evidence", {
				slot: "change.panel",
				node: REPO,
				repo: REPO,
				entity: { kind: "change", id: change("z") },
				mode: "enforce",
			}],
			["attention", {
				slot: "home.section",
				node: REPO,
				viewer: { kind: "user", id: USER },
				mode: "enforce",
			}],
			["attention", {
				slot: "home.section",
				node: REPO,
				viewer: { kind: "user", id: OTHER_USER },
				mode: "enforce",
			}],
		] as const
	) {
		const doc = await reviewModule.extension.render!(slot, ctx, {}, x);
		const checked = validateUi(doc);
		ok(checked.ok, `${slot}: ${checked.ok ? "" : checked.errors.join("; ")}`);
	}
	const home = JSON.stringify(
		await reviewModule.extension.render!(
			"attention",
			{
				slot: "home.section",
				node: REPO,
				viewer: { kind: "user", id: USER },
				mode: "enforce",
			},
			{},
			x,
		),
	);
	ok(home.includes("1 for you"), home);
	const result = await f.review.action(
		"approve",
		{ changeId: C, revision: 1 },
		{
			slot: "change.panel",
			node: REPO,
			repo: REPO,
			entity: { kind: "change", id: C },
			mode: "enforce",
		},
		{ actor: { kind: "user", id: USER } },
	);
	equal(result.toast?.text, "Approved");
	equal(decided(f).at(-1)?.route, "human");
	const queue = await f.review.tool(
		"review_queue",
		{ repo: REPO },
		toolCtx({ kind: "user", id: USER }),
	) as { reviews: unknown[] };
	equal(queue.reviews.length, 0);
	const sections = await f.review.context({
		repo: "acme/platform/router",
		repoId: REPO,
		paths: ["services/api/src/middleware/limit.ts"],
		maxBytes: 2048,
		actor: { kind: "agent", id: AGENT },
	});
	equal(sections[0].id, "review-rules");
	ok(
		sections[0].md.includes("`services/api/**`: sensitivity 3/3"),
		sections[0].md,
	);
});

// ---------------------------------------------------------------------------
// Owners as repo policy (ADR repo config)
// ---------------------------------------------------------------------------

Deno.test("review: Tartan config on trunk that does not evaluate routes every change to a human (owners-invalid)", async () => {
	const f = createFlow();
	const base = f.world.commit(BASE_FILES);
	// Review reads owners at the trunk tip, whose config does not evaluate.
	const tip = f.world.commit(withFiles(BASE_FILES, { "README.md": "tip\n" }));
	f.setTrunk(tip);
	f.world.policyOverrides.set(tip, {
		state: "ok",
		configSha: base,
		exact: false,
		values: { owners: owners() },
		failed: { sha: tip, message: "invalid value", issues: [] },
	});
	const head = f.world.commit(withFiles(BASE_FILES, {
		"apps/web/src/main.ts": "import 'shared'; // copy\n",
	}));
	await submitAndTest(f, { c: change("k"), l: lane("1"), head, base });
	equal(
		decided(f).length,
		0,
		"nothing is low risk while the policy cannot be read",
	);
	const review = await f.review.tool(
		"review_get",
		{ changeId: change("k") },
		toolCtx({ kind: "user", id: USER }),
	) as { route: string; evidence: { forced: string[] } };
	equal(review.route, "human");
	ok(review.evidence.forced.includes("owners-invalid"));
});

Deno.test("review: trunk config still evaluating routes to a human (config-pending); repo.config.resolved judges again", async () => {
	const f = createFlow();
	const base = f.world.commit(BASE_FILES);
	// The trunk tip's config is still evaluating for review (CI, which also
	// reads the tip, has its answer).
	const tip = f.world.commit(withFiles(BASE_FILES, { "README.md": "tip\n" }));
	f.setTrunk(tip);
	f.world.policyOverridesFor.set(
		"tartan.review",
		new Map([[tip, { state: "pending" }]]),
	);
	const head = f.world.commit(withFiles(BASE_FILES, {
		"apps/web/src/main.ts": "import 'shared'; // copy\n",
	}));
	await submitAndTest(f, { c: change("k"), l: lane("1"), head, base });
	equal(decided(f).length, 0);
	const pending = await f.review.tool(
		"review_get",
		{ changeId: change("k") },
		toolCtx({ kind: "user", id: USER }),
	) as { route: string; evidence: { forced: string[] } };
	equal(pending.route, "human");
	ok(pending.evidence.forced.includes("config-pending"));
	// The row resolves: the change is judged again and approved automatically.
	f.world.policyOverridesFor.delete("tartan.review");
	await f.review.event(
		makeEvent("repo.config.resolved", {
			trunkSeq: 2,
			sha: tip,
			status: "ok",
		}),
	);
	const [d] = decided(f);
	equal(d?.decision, "approve");
	equal(d?.route, "auto");
});
