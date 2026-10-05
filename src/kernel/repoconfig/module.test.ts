// The RepoDO `repoconfig` state machine (ADR repo config, "Testing") on
// the node:sqlite fake,
// against the REAL registry for schema, check and the fenced apply, with a
// fake evaluator (the test delivers each job's envelope through
// `cueResult`). Tartan config is the root package `tartan` (`tartan.cue`
// here; cuenv's `env.cue` beside it in some tests).

import {
	deepStrictEqual,
	equal,
	match,
	notEqual,
	ok,
	rejects,
} from "node:assert/strict";
import {
	type CueJobInput,
	cuePreviewSandboxName,
	type Envelope,
	type EvalResponse,
	FORGE_BINDING_FILE,
	fromRpcError,
} from "@tartan/contract";
import { cueFile } from "./testing/git.ts";
import {
	AGENT,
	createRepoConfigHarness,
	errorEnvelope,
	MAINT,
	okEnvelope,
	OWNER,
} from "./testing/harness.ts";

const LANE = "ln_01k6aaaaaaaaaaaaaaaaaaaaaa";
const LANE2 = "ln_01k6bbbbbbbbbbbbbbbbbbbbbb";

const WEAVE2 = cueFile('extensions: "tartan.weave": settings: batch: 2');
const WEAVE3 = cueFile('extensions: "tartan.weave": settings: batch: 3');
const BROKEN = cueFile('extensions: "tartan.weave": settings: batch: 12');
const PIPE_A = cueFile('extensions: "tartan.ci": settings: pipeline: "a"');
const PIPE_B = cueFile('extensions: "tartan.ci": settings: pipeline: "b"');
const SHAPE = cueFile("pipeline: jobs: {}");
const ENV = "package cuenv\n\nenv: A: 1\n";

const PIPELINE = (name: string) => ({
	jobs: { [name]: { run: `echo ${name}` } },
});

const RESOLVED: Record<string, unknown> = {
	[WEAVE2]: { extensions: { "tartan.weave": { settings: { batch: 2 } } } },
	[WEAVE3]: { extensions: { "tartan.weave": { settings: { batch: 3 } } } },
	[PIPE_A]: {
		projects: { api: { root: "services/api" } },
		extensions: {
			"tartan.ci": { settings: { pipeline: PIPELINE("a") } },
			"tartan.review": {
				settings: { owners: { rules: [{ paths: ["a/**"], sensitivity: 1 }] } },
			},
		},
	},
	[PIPE_B]: {
		extensions: { "tartan.ci": { settings: { pipeline: PIPELINE("b") } } },
	},
	[SHAPE]: { pipeline: { jobs: {} } },
};

/** The fake evaluator: the resolved JSON of a known `tartan.cue`, `{}` without one, else a CUE error. */
const evaluateKnown = (job: CueJobInput): EvalResponse => {
	const text = job.request.files["tartan.cue"];
	if (text === undefined) return okEnvelope({});
	const resolved = RESOLVED[text];
	return resolved === undefined
		? errorEnvelope("BUILD_VALUE", "invalid value 12 (out of bound <=4)")
		: okEnvelope(resolved);
};

const types = (events: Envelope[]) => events.map((e) => e.type);

const setup = async (options: { budgetMs?: number } = {}) => {
	const h = await createRepoConfigHarness(options);
	h.control.evaluate = evaluateKnown;
	return h;
};
type H = Awaited<ReturnType<typeof setup>>;

/** A signed policy-touching Advance of `files` (lane `lane`); returns the trunk commit. */
const landFiles = async (
	h: H,
	files: Record<string, string>,
	lane = LANE,
	paths = ["tartan.cue", "src/app.ts"],
) => {
	const headSha = h.addLane(lane, files);
	await h.facade.signOff(lane, {
		head: headSha,
		policyDigest: h.canonical.policyDigest(headSha),
	}, MAINT);
	const sha = h.trunk(files);
	h.internal.onAdvanceSync({
		sha,
		changes: [{
			changeId: "k".repeat(32),
			laneId: lane,
			head: headSha,
			commit: sha,
			paths,
			capped: false,
		}],
	});
	return { sha, headSha };
};

const landConfig = (h: H, text: string, lane = LANE) =>
	landFiles(h, { "tartan.cue": text, "src/app.ts": "x" }, lane);

/** Lands, evaluates and applies. */
const settle = async (h: H) => {
	await h.runTimers();
	await h.deliver();
	await h.runTimers();
};

const weaveBatch = async (h: H) => {
	const inForce = await h.registry.inForce(h.repoId);
	const weave = inForce.find((i) => i.installation.extId === "tartan.weave")!;
	const here = await h.registry.installationAt(weave.installation.id, h.repoId);
	return (here!.config as Record<string, unknown>).batch;
};

const rowAt = (h: H, sha: string) =>
	h.trunkRows().find((r) => r.sha === sha) ?? null;

// ---------------------------------------------------------------------------
// K13.1 decisions in the Advance
// ---------------------------------------------------------------------------

Deno.test("an Advance without root *.cue paths changes no state, writes no trunk row and schedules nothing", async () => {
	const h = await setup();
	const sha = h.trunk({ "src/app.ts": "1", "services/x.cue": "package x\n" });
	h.internal.onAdvanceSync({
		sha,
		changes: [{
			changeId: "k".repeat(32),
			laneId: LANE,
			head: sha,
			commit: sha,
			paths: ["src/app.ts", "services/x.cue", ".tartan/pipeline.yaml"],
			capped: false,
		}],
	});
	equal(h.head()!.status, "unconfigured");
	equal(h.head()!.hold, 0);
	equal(h.scheduled.has("eval"), false);
	equal(h.internal.holdSync().held, false);
	deepStrictEqual(types(h.events), []);
	deepStrictEqual(h.trunkRows(), []);
});

Deno.test("a capped or unknown path list counts as touched: pending, held, a pending trunk row at the commit's seq", async () => {
	for (
		const change of [{ paths: null, capped: true }, {
			paths: Array.from({ length: 5000 }, (_, i) => `f${i}`),
			capped: true,
		}]
	) {
		const h = await setup();
		const sha = h.trunk({ "src/app.ts": "1" });
		h.internal.onAdvanceSync({
			sha,
			changes: [{
				changeId: "k".repeat(32),
				laneId: LANE,
				head: sha,
				commit: sha,
				...change,
			}],
		});
		equal(h.head()!.status, "pending");
		deepStrictEqual(h.internal.holdSync(), { held: true, reason: "pending" });
		deepStrictEqual(types(h.events), ["repo.config.evaluating"]);
		ok(h.scheduled.has("eval"));
		deepStrictEqual(
			h.trunkRows().map((r) => [r.trunk_seq, r.sha, r.status]),
			[[h.seqOf(sha), sha, "pending"]],
		);
		// No config on trunk and nothing applied: unconfigured, released, row `none`.
		await h.runTimers();
		equal(h.head()!.status, "unconfigured");
		equal(h.internal.holdSync().held, false);
		equal(rowAt(h, sha)?.status, "none");
		ok(types(h.events).includes("repo.config.resolved"));
	}
});

Deno.test("the loop: evaluate on cue:trunk with the root files and ~tartan.cue, apply fenced, current; the signer is the audit principal", async () => {
	const h = await setup();
	const { sha } = await landFiles(h, {
		"tartan.cue": WEAVE2,
		"env.cue": ENV,
		"src/app.ts": "x",
	});
	equal(h.head()!.status, "pending");
	ok(h.internal.holdSync().held);
	await h.runTimers();
	equal(h.jobs.length, 1);
	equal(h.jobs[0].sandbox, "cue:trunk");
	equal(h.jobs[0].job.class, "trunk");
	deepStrictEqual(h.jobs[0].job.sink, { kind: "repo", repoId: h.repoId });
	const files = h.jobs[0].job.request.files;
	ok(files[FORGE_BINDING_FILE]);
	ok(files["cue.mod/pkg/tartan.dev/ext/ext.cue"]);
	equal(files["tartan.cue"], WEAVE2);
	equal(files["env.cue"], ENV, "another package's root file is sent too");
	ok(!Object.hasOwn(files, "cue.mod/module.cue"), "the job writes its own");
	ok(!Object.keys(files).some((p) => p.startsWith("src/")));
	ok(h.internal.holdSync().held, "still held while evaluating");
	equal(rowAt(h, sha)?.status, "pending");
	await h.deliver();
	await h.runTimers();
	equal(h.head()!.status, "current");
	equal(h.internal.holdSync().held, false);
	equal(await weaveBatch(h), 2);
	equal(rowAt(h, sha)?.status, "ok");
	const applied = h.events.find((e) => e.type === "repo.config.applied")!;
	deepStrictEqual((applied.data as { principals: string[] }).principals, [
		MAINT,
	]);
	ok(types(h.events).includes("repo.config.evaluated"));
	const state = await h.facade.state();
	deepStrictEqual(state.appliedBy, [MAINT]);
	equal(state.cueVersion, "v0.17.1");
	deepStrictEqual(state.rootFiles.map((f) => f.name), [
		"env.cue",
		"tartan.cue",
	]);
	equal(state.legacyDir, false);
	ok(
		h.forge.events.audits.some((a) =>
			a.action === "repo-config.apply" && a.principal === MAINT
		),
	);
	// The same root files at a new trunk commit (a capped list): current
	// again, zero evaluations.
	const again = h.trunk({
		"tartan.cue": WEAVE2,
		"env.cue": ENV,
		"README.md": "x\n",
	});
	h.internal.onAdvanceSync({
		sha: again,
		changes: [{
			changeId: "m".repeat(32),
			laneId: LANE2,
			head: again,
			commit: again,
			paths: null,
			capped: true,
		}],
	});
	equal(h.head()!.status, "pending");
	await h.runTimers();
	equal(h.jobs.length, 0);
	equal(h.head()!.status, "current");
	equal(rowAt(h, again)?.status, "ok");
	equal(rowAt(h, again)?.input_key, rowAt(h, sha)?.input_key);
});

Deno.test("an edit to another package's root file (cuenv's env.cue): a new key, one evaluation, a no-op apply", async () => {
	const h = await setup();
	await landFiles(h, { "tartan.cue": WEAVE2, "env.cue": ENV });
	await settle(h);
	const key = h.head()!.applied_key;
	const applied = types(h.events).filter((t) => t === "repo.config.applied")
		.length;
	await landFiles(
		h,
		{ "tartan.cue": WEAVE2, "env.cue": `${ENV}env: B: 2\n` },
		LANE2,
		["env.cue"],
	);
	await h.runTimers();
	equal(h.jobs.length, 1, "one evaluation");
	await h.deliver();
	await h.runTimers();
	equal(h.head()!.status, "current");
	notEqual(h.head()!.applied_key, key);
	equal(await weaveBatch(h), 2);
	// No installation changed: no new `repo.config.applied` with changes.
	const last = h.events.filter((e) => e.type === "repo.config.applied").pop()!;
	const d = last.data as Record<string, number>;
	equal(d.installed + d.updated + d.removed + d.overlays, 0);
	ok(
		types(h.events).filter((t) => t === "repo.config.applied").length >=
			applied,
	);
});

Deno.test("failed keeps the last-good set without holding; the trunk row is error and repo policy reads last good", async () => {
	const h = await setup();
	const { sha: good } = await landConfig(h, PIPE_A);
	await settle(h);
	equal(rowAt(h, good)?.status, "ok");
	const { sha: bad } = await landConfig(h, BROKEN, LANE2);
	await settle(h);
	equal(h.head()!.status, "failed");
	equal(h.internal.holdSync().held, false);
	const state = await h.facade.state();
	equal(state.failure?.code, "BUILD_VALUE");
	equal(state.failure?.issues[0].pos[0], "tartan.cue:3:1");
	ok(types(h.events).includes("repo.config.failed"));
	equal(rowAt(h, bad)?.status, "error");
	const at = h.internal.policyAtSync(h.seqOf(bad)!);
	ok(at.state === "ok" && !at.exact && at.sha === good);
	ok(at.state === "ok" && at.failed?.sha === bad);
	const answer = await h.facade.policy(bad, "tartan.ci", ["pipeline"]);
	ok(answer.state === "ok" && !answer.exact);
	deepStrictEqual(
		answer.state === "ok" ? answer.values : null,
		{ pipeline: PIPELINE("a") },
	);
	equal(state.policy.exact, false);
	deepStrictEqual(state.policy.pipeline, PIPELINE("a"));
});

Deno.test("an unavailable evaluator stays pending and held; keep-last-good releases it, audited, and repo policy reads last good", async () => {
	const h = await setup();
	const { sha: first } = await landConfig(h, PIPE_A);
	await settle(h);
	h.control.mode = "unavailable";
	const { sha } = await landConfig(h, PIPE_B, LANE2);
	await h.runTimers();
	equal(h.head()!.status, "pending");
	ok(h.internal.holdSync().held);
	ok(
		(h.head()!.unavailable_until as number) > h.now(),
		"a background round is scheduled",
	);
	equal(h.scheduled.get("eval"), h.head()!.unavailable_until);
	// Repo policy at the pending commit: pending (CI waits).
	deepStrictEqual(await h.facade.policy(sha, "tartan.ci", ["pipeline"]), {
		state: "pending",
	});
	// No retry storm: nothing runs before the round.
	await h.runTimers();
	equal(h.jobs.length, 1);
	await h.facade.override("keep-last-good", OWNER);
	equal(h.internal.holdSync().held, false);
	equal(h.head()!.status, "pending", "still pending, no longer held");
	ok(types(h.events).includes("repo.config.overridden"));
	const kept = await h.facade.policy(sha, "tartan.ci", ["pipeline"]);
	ok(kept.state === "ok" && !kept.exact && kept.configSha === first);
	// The outage ends: the next round resolves it.
	h.control.mode = "accept";
	h.advance(60 * 60 * 1000);
	await settle(h);
	equal(h.head()!.status, "current");
	equal(h.head()!.override_by, null);
	const exact = await h.facade.policy(sha, "tartan.ci", ["pipeline"]);
	ok(exact.state === "ok" && exact.exact);
	deepStrictEqual(
		exact.state === "ok" ? exact.values : null,
		{ pipeline: PIPELINE("b") },
	);
});

Deno.test("two racing trunk heads: the older result only fills the cache", async () => {
	const h = await setup();
	await landConfig(h, WEAVE2);
	await h.runTimers();
	equal(h.jobs.length, 1);
	const older = h.jobs.splice(0)[0];
	await landConfig(h, WEAVE3, LANE2);
	await h.runTimers();
	equal(h.jobs.length, 1);
	// The newer result first, then the older one.
	await h.deliver();
	await h.facade.cueResult(
		older.job.request.inputKey,
		h.control.evaluate(older.job),
	);
	await h.runTimers();
	equal(h.head()!.status, "current");
	equal(await weaveBatch(h), 3);
	ok(
		await h.facade.evaluation(older.job.request.inputKey),
		"the older key is cached",
	);
	equal(h.head()!.applied_key !== older.job.request.inputKey, true);
});

Deno.test("stale re-evaluates in the background without holding and never rewrites a trunk row; a lost gate holds", async () => {
	const h = await setup();
	const { sha } = await landConfig(h, WEAVE2);
	await settle(h);
	const row = { ...rowAt(h, sha)! };
	const epoch = h.head()!.applied_epoch as number;
	await h.facade.registryChanged(epoch + 1);
	equal(h.head()!.status, "stale");
	equal(h.internal.holdSync().held, false);
	await h.runTimers();
	equal(
		h.jobs.length,
		0,
		"the same files and schema: a cache hit, no evaluation",
	);
	equal(h.head()!.status, "current");
	deepStrictEqual(rowAt(h, sha), row, "the trunk row is never rewritten");
	// A gate-bearing row whose approval goes away holds lands until re-apply.
	const ns = cueFile('extensions: "acme.no-secrets": settings: {}');
	RESOLVED[ns] = {
		extensions: {
			"acme.no-secrets": {
				enabled: true,
				mode: "enforce",
				settings: { severity: "hunk", allow: [] },
			},
		},
	};
	const { sha: nsSha } = await landConfig(
		h,
		ns,
		"ln_01k6cccccccccccccccccccccc",
	);
	await settle(h);
	equal(h.head()!.status, "current");
	await h.registry.revokeConfigApproval(
		OWNER,
		h.forge.tree.node("rawkode").id,
		"acme.no-secrets",
	);
	equal(
		(await h.registry.repoConfigState(h.repoId))?.holdReason,
		"gate-missing",
	);
	const nsRow = { ...rowAt(h, nsSha)! };
	await h.facade.registryChanged(
		await h.registry.repoConfigSchema(h.repoId).then((s) => s.epoch),
	);
	await h.runTimers();
	deepStrictEqual(h.internal.holdSync(), {
		held: true,
		reason: "gate-missing",
	});
	await h.deliver();
	await h.runTimers();
	equal(
		h.head()!.status,
		"failed",
		"the config names an unapproved extension now",
	);
	equal((await h.facade.state()).failure?.code, "unapproved");
	deepStrictEqual(
		rowAt(h, nsSha),
		nsRow,
		"an installation denial leaves the row",
	);
});

Deno.test("a shape denial makes the trunk row error (repo policy falls back); an installation denial leaves it ok", async () => {
	const h = await setup();
	const { sha: good } = await landConfig(h, PIPE_A);
	await settle(h);
	const { sha } = await landConfig(h, SHAPE, LANE2);
	await settle(h);
	equal(h.head()!.status, "failed");
	equal((await h.facade.state()).failure?.code, "shape");
	equal(rowAt(h, sha)?.status, "error");
	equal(rowAt(h, sha)?.code, "shape");
	const at = await h.facade.policy(sha, "tartan.ci", ["pipeline"]);
	ok(at.state === "ok" && !at.exact && at.configSha === good);
	match(at.state === "ok" ? at.failed!.message : "", /extensions: "tartan.ci"/);
});

Deno.test("removal applies only on positive evidence and a signed landing", async () => {
	const h = await setup();
	await landConfig(h, WEAVE2);
	await settle(h);
	equal(await weaveBatch(h), 2);
	// Unsigned removal (the land checks were off): needs-apply, nothing
	// removed; repo policy reads "no config" at once.
	const unsigned = h.trunk({ "src/app.ts": "2" });
	h.internal.onAdvanceSync({
		sha: unsigned,
		changes: [{
			changeId: "n".repeat(32),
			laneId: LANE2,
			head: unsigned,
			commit: unsigned,
			paths: ["tartan.cue"],
			capped: false,
		}],
	});
	await h.runTimers();
	equal(h.head()!.status, "needs-apply");
	equal(await weaveBatch(h), 2);
	equal(rowAt(h, unsigned)?.status, "none");
	deepStrictEqual((await h.facade.state()).plan.map((l) => l.text), [
		"remove overlay tartan.weave (inherited from /rawkode)",
	]);
	// A signed removal applies (a root with only another package: `{}`).
	const h2 = await setup();
	await landConfig(h2, WEAVE2);
	await settle(h2);
	const files = { "env.cue": ENV, "src/app.ts": "2" };
	const laneHead = h2.addLane(LANE2, files);
	await h2.facade.signOff(LANE2, {
		head: laneHead,
		policyDigest: h2.canonical.policyDigest(laneHead),
	}, MAINT);
	const signed = h2.trunk(files);
	h2.internal.onAdvanceSync({
		sha: signed,
		changes: [{
			changeId: "n".repeat(32),
			laneId: LANE2,
			head: laneHead,
			commit: signed,
			paths: ["tartan.cue", "env.cue"],
			capped: false,
		}],
	});
	await settle(h2);
	equal(h2.head()!.status, "current");
	equal(await weaveBatch(h2), 4);
	equal(rowAt(h2, signed)?.status, "none");
	const applied = h2.events.filter((e) => e.type === "repo.config.applied")
		.pop()!;
	equal((applied.data as { removal?: boolean }).removal, true);
	deepStrictEqual(await h2.facade.policy(signed, "tartan.ci", ["pipeline"]), {
		state: "none",
	});
});

Deno.test("injected null and [] reads leave the head, the rows and the installations untouched", async () => {
	const h = await setup();
	await landConfig(h, WEAVE2);
	await settle(h);
	const before = { ...h.head()! };
	const sha = h.trunk({ "src/app.ts": "3" });
	h.internal.onAdvanceSync({
		sha,
		changes: [{
			changeId: "p".repeat(32),
			laneId: LANE2,
			head: sha,
			commit: sha,
			paths: null,
			capped: true,
		}],
	});
	const root = (await h.canonical.reads.readCommit(sha))!.treeHash;
	for (const inject of ["null-commit", "empty-root", "null-root"] as const) {
		h.canonical.faults.nullCommits.clear();
		h.canonical.faults.emptyTrees.clear();
		h.canonical.faults.nullTrees.clear();
		if (inject === "null-commit") h.canonical.faults.nullCommits.add(sha);
		if (inject === "empty-root") h.canonical.faults.emptyTrees.add(root);
		if (inject === "null-root") h.canonical.faults.nullTrees.add(root);
		h.advance(10 * 60 * 1000);
		await h.runTimers();
		equal(h.head()!.status, "pending", inject);
		equal(h.head()!.applied_key, before.applied_key, inject);
		equal(h.jobs.length, 0, inject);
		equal(await weaveBatch(h), 2, inject);
		equal(rowAt(h, sha)?.status, "pending", inject);
	}
	h.canonical.faults.nullCommits.clear();
	h.canonical.faults.emptyTrees.clear();
	h.canonical.faults.nullTrees.clear();
	h.advance(10 * 60 * 1000);
	await h.runTimers();
	// Positive evidence of no config, but the landing was not signed: needs-apply.
	equal(h.head()!.status, "needs-apply");
	equal(await weaveBatch(h), 2);
});

Deno.test("trunk moves outside the Advance resolve a trunk row at once and give needs-apply; an explicit apply names the Maintainer", async () => {
	for (
		const type of [
			"repo.imported",
			"repo.created",
			"ref.acknowledged",
			"ref.reconciled",
		]
	) {
		const h = await setup();
		const sha = h.trunk({ "tartan.cue": WEAVE2 });
		const data = type === "ref.acknowledged"
			? { refs: ["refs/heads/main"] }
			: type === "ref.reconciled"
			? {
				ref: "refs/heads/main",
				indexSha: sha,
				remoteSha: sha,
				matched: false,
			}
			: {};
		h.internal.observeSync(
			{
				type,
				data,
				actor: { kind: "system", id: "sys_kernel" },
			} as unknown as Envelope,
		);
		await h.runTimers();
		equal(h.jobs[0]?.job.class, "external", type);
		await h.deliver();
		await h.runTimers();
		equal(h.head()!.status, "needs-apply", type);
		// The SPA's Apply button applies `trunkSha`: an external move must
		// name it (e2e: an imported repo showed no Apply button).
		equal((await h.facade.state()).trunkSha, sha, `${type}: trunkSha`);
		equal(h.internal.holdSync().held, false, type);
		equal(rowAt(h, sha)?.status, "ok", `${type}: read as policy at once`);
		deepStrictEqual((await h.facade.state()).plan.map((l) => l.text), [
			"overlay tartan.weave (inherited from /rawkode): batch 4 → 2",
		]);
		equal(await weaveBatch(h), 4, `${type}: nothing applied`);
		ok(types(h.events).includes("repo.config.needs-apply"), type);
		await rejects(
			h.facade.apply("f".repeat(40), MAINT),
			(e: unknown) => fromRpcError(e).code === "conflict",
		);
		await h.facade.apply(sha, MAINT);
		await h.runTimers();
		equal(h.head()!.status, "current", type);
		equal(await weaveBatch(h), 2);
		const applied = h.events.filter((e) => e.type === "repo.config.applied")
			.pop()!;
		deepStrictEqual((applied.data as { principals: string[] }).principals, [
			MAINT,
		]);
		equal((applied.data as { explicit?: boolean }).explicit, true);
	}
});

Deno.test("an apply evaluated after a non-policy Advance keeps the newer trunkSha", async () => {
	const h = await setup();
	const x = h.trunk({ "tartan.cue": WEAVE2 });
	h.internal.observeSync(
		{
			type: "repo.imported",
			data: {},
			actor: { kind: "system", id: "sys_kernel" },
		} as unknown as Envelope,
	);
	await h.runTimers();
	await h.deliver();
	await h.runTimers();
	equal(h.head()!.status, "needs-apply");
	equal((await h.facade.state()).trunkSha, x);
	await h.facade.apply(x, MAINT);
	// Before the apply's evaluation runs, the Weave lands a change that
	// touches no policy: trunk moves to y.
	const y = h.trunk({ "tartan.cue": WEAVE2, "src/app.ts": "1" }, [x]);
	h.internal.onAdvanceSync({
		sha: y,
		changes: [{
			changeId: "k".repeat(32),
			laneId: LANE,
			head: y,
			commit: y,
			paths: ["src/app.ts"],
			capped: false,
		}],
	});
	equal((await h.facade.state()).trunkSha, y);
	await settle(h);
	equal(h.head()!.status, "current");
	equal(await weaveBatch(h), 2, "the apply still applied");
	equal(
		(await h.facade.state()).trunkSha,
		y,
		"the apply's evaluation did not move trunkSha back to x",
	);
});

Deno.test("an apply for a repo archived meanwhile ends refused, not retried on every pass", async () => {
	const h = await setup();
	const x = h.trunk({ "tartan.cue": WEAVE2 });
	h.internal.observeSync(
		{
			type: "repo.imported",
			data: {},
			actor: { kind: "system", id: "sys_kernel" },
		} as unknown as Envelope,
	);
	await h.runTimers();
	await h.deliver();
	await h.runTimers();
	equal(h.head()!.status, "needs-apply");
	await h.facade.apply(x, MAINT);
	h.forge.db.db.prepare("UPDATE nodes SET archived_at = 1 WHERE id = ?").run(
		h.repoId,
	);
	await settle(h);
	await h.runTimers();
	const intents = h.storage.sql.exec<{ state: string; answer_json: string }>(
		"SELECT state, answer_json FROM config_apply_intents",
	).toArray();
	ok(intents.length > 0);
	ok(intents.every((i) => i.state !== "pending"), "no intent keeps retrying");
	ok(intents.some((i) => i.answer_json?.includes("archived")));
	equal(await weaveBatch(h), 4, "nothing applied to the archived repo");
});

Deno.test("retirement (ADR repo config): a trunk with only .tartan/pipeline.yaml and owners.yaml has no config and shows the migration hint", async () => {
	const h = await setup();
	const sha = h.trunk({
		"README.md": "# api\n",
		".tartan/pipeline.yaml": "version: 1\njobs:\n  test:\n    run: pnpm test\n",
		".tartan/owners.yaml":
			"version: 1\nrules:\n  - paths: [services/api/**]\n    sensitivity: 2\n",
	});
	h.internal.observeSync(
		{
			type: "repo.created",
			data: {},
			actor: { kind: "system", id: "sys_kernel" },
		} as unknown as Envelope,
	);
	await h.runTimers();
	equal(h.jobs.length, 0, "nothing under .tartan/ is evaluated");
	const state = await h.facade.state();
	equal(state.status, "unconfigured");
	equal(state.legacyDir, true);
	deepStrictEqual(state.rootFiles, []);
	equal(h.trunkRows().length, 0);
	// CI and review read no repo policy here: zero-config, no owners rules.
	deepStrictEqual(await h.facade.policy(sha, "tartan.ci", ["pipeline"]), {
		state: "none",
	});
	deepStrictEqual(await h.facade.policy(sha, "tartan.review", ["owners"]), {
		state: "none",
	});
	equal(h.internal.holdSync().held, false);
});

Deno.test("a trunk move whose root *.cue digest equals the newest row's changes nothing", async () => {
	const h = await setup();
	const { sha } = await landConfig(h, WEAVE2);
	await settle(h);
	const rows = h.trunkRows().length;
	h.trunk({ "tartan.cue": WEAVE2, "src/app.ts": "x", "README.md": "y" });
	h.internal.observeSync(
		{
			type: "ref.reconciled",
			data: { ref: "refs/heads/main", matched: false },
			actor: { kind: "system", id: "sys_kernel" },
		} as unknown as Envelope,
	);
	await h.runTimers();
	equal(h.jobs.length, 0);
	equal(h.trunkRows().length, rows);
	equal(h.head()!.status, "current");
	equal(rowAt(h, sha)?.status, "ok");
});

Deno.test("a preview's TIMEOUT never answers for trunk; a sha256 mismatch forces a re-evaluation", async () => {
	const h = await setup();
	const files = { "tartan.cue": WEAVE2 };
	h.addLane(LANE, files);
	const preview = await h.facade.preview(LANE, AGENT);
	equal(preview.status, "evaluating");
	await h.runTimers();
	equal(h.jobs.length, 1);
	equal(h.jobs[0].sandbox, cuePreviewSandboxName(0));
	equal(h.jobs[0].job.class, "preview");
	equal(h.jobs[0].job.principal, AGENT);
	h.control.evaluate = () => errorEnvelope("TIMEOUT", "stopped after 10 s");
	await h.deliver();
	await h.runTimers();
	equal((await h.facade.previewOf(LANE))?.status, "error");
	const key = (await h.facade.previewOf(LANE))!.inputKey!;
	equal((await h.facade.evaluation(key))?.origin, "preview");
	// Trunk with the same files re-runs on cue:trunk.
	h.control.evaluate = evaluateKnown;
	const sha = h.trunk(files);
	h.internal.onAdvanceSync({
		sha,
		changes: [{
			changeId: "q".repeat(32),
			laneId: LANE,
			head: sha,
			commit: sha,
			paths: null,
			capped: true,
		}],
	});
	await h.runTimers();
	equal(h.jobs.length, 1);
	equal(h.jobs[0].sandbox, "cue:trunk");
	equal(
		h.jobs[0].job.request.inputKey,
		key,
		"the same key, re-evaluated at trunk",
	);
	await h.deliver();
	await h.runTimers();
	equal(h.head()!.status, "current");
	// A cached trunk entry whose sha256 does not match the canonical bytes is dropped.
	h.storage.sql.exec(
		"UPDATE config_evals SET files_json = ? WHERE input_key = ?",
		JSON.stringify([["tartan.cue", "x", "0".repeat(64)]]),
		key,
	);
	h.storage.sql.exec("UPDATE config_head SET applied_epoch = -1");
	await h.facade.registryChanged(99);
	await h.runTimers();
	equal(h.jobs.length, 1, "re-evaluated");
});

Deno.test("previews never change config_head, the trunk rows or the installations (K13); the plan shows repo policy against trunk", async () => {
	const h = await setup();
	await landConfig(h, PIPE_A);
	await settle(h);
	const rows = JSON.stringify(h.trunkRows());
	h.addLane(LANE2, { "tartan.cue": PIPE_B, "env.cue": ENV });
	const before = { ...h.head()! };
	await h.facade.preview(LANE2, AGENT);
	await h.runTimers();
	await h.deliver();
	await h.runTimers();
	const preview = await h.facade.previewOf(LANE2);
	equal(preview?.status, "ok");
	deepStrictEqual(preview?.plan.map((l) => l.text), [
		"pipeline (tartan.ci): - job a, + job b",
		"owners (tartan.review): removed",
		"projects: - api",
	]);
	ok(typeof preview?.policyDigest === "string");
	deepStrictEqual(
		{ ...h.head()!, updated_at: 0, cue_version: null },
		{ ...before, updated_at: 0, cue_version: null },
	);
	equal(JSON.stringify(h.trunkRows()), rows);
	ok(types(h.events).includes("repo.config.previewed"));
	ok(h.notices.some((n) => n.principal === AGENT && /preview/.test(n.text)));
	equal((await h.facade.previewByKey(preview!.inputKey!))?.laneId, LANE2);
	// The lane head is never read as policy.
	const lane = h.lanes.get(LANE2)!.head_sha!;
	await rejects(
		h.facade.policy(lane, "tartan.ci", ["pipeline"]),
		(e: unknown) => {
			const err = fromRpcError(e);
			return err.code === "denied" && /policy-not-trunk/.test(err.text);
		},
	);
	// A push.diffed touching a root *.cue file queues the preview by itself.
	const head3 = h.addLane("ln_01k6dddddddddddddddddddddd", {
		"tartan.cue": WEAVE3,
	});
	h.internal.observeSync({
		type: "push.diffed",
		data: {
			target: "ln_01k6dddddddddddddddddddddd",
			after: head3,
			paths: ["tartan.cue"],
			truncated: false,
			rangeTruncated: false,
		},
		actor: { kind: "agent", id: AGENT },
	} as unknown as Envelope);
	equal(
		h.internal.policyTouchSync("ln_01k6dddddddddddddddddddddd", head3),
		"touched",
	);
	equal(
		(await h.facade.previewOf("ln_01k6dddddddddddddddddddddd"))?.status,
		"evaluating",
	);
	// A subdirectory .cue file or a retired .tartan/ path is not policy.
	h.internal.observeSync({
		type: "push.diffed",
		data: {
			target: LANE,
			after: "e".repeat(40),
			paths: ["services/api/x.cue", ".tartan/pipeline.yaml"],
			truncated: false,
			rangeTruncated: false,
		},
		actor: { kind: "agent", id: AGENT },
	} as unknown as Envelope);
	equal(h.internal.policyTouchSync(LANE, "e".repeat(40)), "clean");
	await rejects(
		h.facade.preview("ln_01k6zzzzzzzzzzzzzzzzzzzzzz", AGENT),
		(e: unknown) => fromRpcError(e).code === "not_found",
	);
});

// ---------------------------------------------------------------------------
// Repo policy reads
// ---------------------------------------------------------------------------

Deno.test("policyAt: exact, none, pending, last good after an error, expired past the kept history", async () => {
	const h = await setup();
	const before = h.trunk({ "src/app.ts": "0" });
	deepStrictEqual(h.internal.policyAtSync(h.seqOf(before)!), { state: "none" });
	const { sha: a } = await landConfig(h, PIPE_A);
	await settle(h);
	const at = h.internal.policyAtSync(h.seqOf(a)!);
	ok(at.state === "ok" && at.exact && at.sha === a);
	// A later trunk commit that touched no root *.cue reads the same row.
	const later = h.trunk({ "tartan.cue": PIPE_A, "src/app.ts": "later" });
	const atLater = h.internal.policyAtSync(h.seqOf(later)!);
	ok(atLater.state === "ok" && atLater.sha === a);
	// Only the caller's keys.
	deepStrictEqual(
		await h.facade.policy(later, "tartan.review", ["owners"]),
		{
			state: "ok",
			configSha: a,
			inputKey: rowAt(h, a)!.input_key as string,
			exact: true,
			values: { owners: { rules: [{ paths: ["a/**"], sensitivity: 1 }] } },
		},
	);
	const other = await h.facade.policy(later, "acme.other", ["pipeline"]);
	ok(other.state === "ok" && Object.keys(other.values).length === 0);
	// Keys the caller did not declare are never returned.
	const narrow = await h.facade.policy(later, "tartan.ci", []);
	ok(narrow.state === "ok" && Object.keys(narrow.values).length === 0);
	// Expired: more than the kept rows of history.
	const h2 = await setup();
	const old = h2.trunk({ "src/app.ts": "old" });
	for (let i = 0; i < 52; i++) {
		const text = cueFile(
			`extensions: "tartan.weave": settings: batch: ${(i % 4) + 1}\n// ${i}`,
		);
		RESOLVED[text] = {
			extensions: { "tartan.weave": { settings: { batch: (i % 4) + 1 } } },
		};
		await landConfig(h2, text, `ln_01k6${String(i).padStart(22, "e")}`);
		await settle(h2);
	}
	equal(h2.trunkRows().length, 50);
	deepStrictEqual(await h2.facade.policy(old, "tartan.ci", ["pipeline"]), {
		state: "expired",
	});
});

Deno.test("projectConfig: the configured projects at a trunk commit; needsBase off trunk; provisional while pending", async () => {
	const h = await setup();
	const none = h.trunk({ "src/app.ts": "0" });
	deepStrictEqual(await h.facade.projectConfig(none), {
		key: "none",
		projects: null,
		global: [],
		provisional: false,
	});
	// Never configured: a lane head needs no walk.
	deepStrictEqual(await h.facade.projectConfig("e".repeat(40)), {
		key: "none",
		projects: null,
		global: [],
		provisional: false,
	});
	const { sha } = await landConfig(h, PIPE_A);
	await settle(h);
	const cfg = await h.facade.projectConfig(sha);
	ok(!("needsBase" in cfg));
	if (!("needsBase" in cfg)) {
		equal(cfg.key, rowAt(h, sha)!.input_key);
		deepStrictEqual(cfg.projects, { api: { root: "services/api" } });
		equal(cfg.provisional, false);
	}
	deepStrictEqual(await h.facade.projectConfig("e".repeat(40)), {
		needsBase: true,
	});
	h.control.mode = "unavailable";
	const { sha: pending } = await landConfig(h, PIPE_B, LANE2);
	await h.runTimers();
	const provisional = await h.facade.projectConfig(pending);
	ok(!("needsBase" in provisional) && provisional.provisional);
	if (!("needsBase" in provisional)) {
		equal(provisional.key, `provisional:${rowAt(h, sha)!.input_key}`);
		deepStrictEqual(provisional.projects, { api: { root: "services/api" } });
	}
});

// ---------------------------------------------------------------------------
// Sign-offs (K13.3) and timers
// ---------------------------------------------------------------------------

Deno.test("sign-off: a person's act, bound to the head and its root *.cue digest, revocable", async () => {
	const h = await setup();
	const headSha = h.addLane(LANE, { "tartan.cue": WEAVE2, "env.cue": ENV });
	const digest = h.canonical.policyDigest(headSha);
	ok(digest !== null);
	const code = async (p: Promise<unknown>) => {
		try {
			await p;
			return "ok";
		} catch (e) {
			const err = fromRpcError(e);
			return `${err.code}: ${err.text}`;
		}
	};
	match(
		await code(
			h.facade.signOff(LANE, { head: headSha, policyDigest: digest }, AGENT),
		),
		/^invalid/,
	);
	match(
		await code(
			h.facade.signOff(
				LANE,
				{ head: "e".repeat(40), policyDigest: digest },
				MAINT,
			),
		),
		/^conflict: head-moved/,
	);
	match(
		await code(
			h.facade.signOff(LANE, { head: headSha, policyDigest: null }, MAINT),
		),
		/^conflict: policy-digest/,
	);
	match(
		await code(
			h.facade.signOff(
				LANE,
				{ head: headSha, policyDigest: "0".repeat(64) },
				MAINT,
			),
		),
		/^conflict: policy-digest/,
	);
	const s = await h.facade.signOff(
		LANE,
		{ head: headSha, policyDigest: digest },
		MAINT,
	);
	equal(s.signedBy, MAINT);
	equal(s.policyDigest, digest);
	const approved = h.events.find((e) => e.type === "repo.policy.approved")!;
	deepStrictEqual(approved.actor, { kind: "user", id: MAINT });
	equal((approved.data as { policyDigest: string }).policyDigest, digest);
	deepStrictEqual(h.internal.signoffSync(LANE, headSha), {
		eventId: approved.id,
		signedBy: MAINT,
		policyDigest: digest,
	});
	equal(
		h.internal.signoffSync(LANE, "e".repeat(40)),
		null,
		"another head does not count",
	);
	// Signing twice is idempotent.
	equal(
		(await h.facade.signOff(
			LANE,
			{ head: headSha, policyDigest: digest },
			MAINT,
		)).eventId,
		approved.id,
	);
	await h.facade.revokeSignOff(LANE, headSha, MAINT);
	equal(h.internal.signoffSync(LANE, headSha), null);
	ok(types(h.events).includes("repo.policy.revoked"));
	// A head with no root *.cue file signs with a null digest.
	const plain = h.addLane(LANE2, { "src/app.ts": "x" });
	equal(
		(await h.facade.signOff(LANE2, { head: plain, policyDigest: null }, MAINT))
			.policyDigest,
		null,
	);
});

Deno.test("timers never await an evaluation: a hung sandbox and hung reads return within the budget", async () => {
	const h = await setup({ budgetMs: 50 });
	h.control.mode = "hang";
	await landConfig(h, WEAVE2);
	let started = Date.now();
	await h.runTimers(1);
	ok(Date.now() - started < 1000, "the eval handler returned");
	ok(h.scheduled.has("eval"), "and rescheduled itself");
	h.control.readsHang = true;
	h.advance(5_000);
	started = Date.now();
	await h.runTimers(1);
	ok(Date.now() - started < 1000);
	equal(h.head()!.status, "pending");
});
