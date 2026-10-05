// Repository config's hardening rules (trunk-only answers, resource-limit
// retries, holds, the switch, pruning, timers and fences), on the same
// harness as registry-work.test.ts: the REAL ForgeDO registry, in-memory git
// and a fake evaluator.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	type CueJobInput,
	cuePreviewSandboxName,
	type Envelope,
	type EvalResponse,
	type Manifest,
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
import { normalizeCueErrors } from "./issues.ts";
import { TRUNK_ROWS_KEPT } from "./module.ts";
import { formatValue, policyPlan } from "./plan.ts";

const LANES = Array.from(
	{ length: 20 },
	(_, i) => `ln_01k6${String.fromCharCode(97 + i).repeat(22)}`,
);

const WEAVE2 = cueFile('extensions: "tartan.weave": settings: batch: 2');
const WEAVE3 = cueFile('extensions: "tartan.weave": settings: batch: 3');
const BROKEN = cueFile('extensions: "tartan.weave": settings: batch: 12');
const HEAVY = cueFile('extensions: "tartan.weave": settings: batch: 1');

const weave = (batch: number) => ({
	extensions: { "tartan.weave": { settings: { batch } } },
});

const RESOLVED: Record<string, unknown> = {
	[WEAVE2]: weave(2),
	[WEAVE3]: weave(3),
	[HEAVY]: weave(1),
};

const evaluate = (job: CueJobInput): EvalResponse => {
	const text = job.request.files["tartan.cue"];
	if (text === undefined) return okEnvelope({});
	const resolved = RESOLVED[text];
	return resolved === undefined
		? errorEnvelope("BUILD_VALUE", "invalid value 12 (out of bound <=4)")
		: okEnvelope(resolved);
};

const setup = async (
	options: { enabled?: boolean; budgetMs?: number } = {},
) => {
	const h = await createRepoConfigHarness(options);
	h.control.evaluate = evaluate;
	return h;
};
type H = Awaited<ReturnType<typeof setup>>;

let laneNo = 0;
/** A signed policy-touching Advance of `tartan.cue` = `text`; returns the trunk commit. */
const land = async (h: H, text: string, extra: Record<string, string> = {}) => {
	const lane = LANES[laneNo++ % LANES.length];
	const files = { "tartan.cue": text, ...extra };
	const headSha = h.addLane(lane, files);
	await h.facade.signOff(lane, {
		head: headSha,
		policyDigest: h.canonical.policyDigest(headSha),
	}, MAINT);
	const sha = h.trunk(files);
	h.internal.onAdvanceSync({
		sha,
		changes: [{
			changeId: `${laneNo}`.padStart(32, "k"),
			laneId: lane,
			head: headSha,
			commit: sha,
			paths: ["tartan.cue"],
			capped: false,
		}],
	});
	return sha;
};

const settle = async (h: H) => {
	for (let i = 0; i < 6; i++) {
		await h.runTimers();
		if ((await h.deliver()) === 0) break;
	}
	await h.runTimers();
};

const weaveBatch = async (h: H) => {
	const inForce = (await h.registry.inForce(h.repoId)).find((i) =>
		i.installation.extId === "tartan.weave"
	)!;
	const here = await h.registry.installationAt(
		inForce.installation.id,
		h.repoId,
	);
	return (here!.config as Record<string, unknown>).batch;
};

const trunkJobs = (h: H) => h.jobs.filter((j) => j.sandbox === "cue:trunk");

const pushDiffed = (h: H, laneId: string, after: string, paths: string[]) =>
	h.internal.observeSync(
		{
			type: "push.diffed",
			data: { target: laneId, after, paths, truncated: false },
			actor: { kind: "agent", id: AGENT },
		} as unknown as Envelope,
	);

/** Fails the test instead of hanging when `work` never settles. */
const within = async <T>(ms: number, work: Promise<T>): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`did not settle within ${ms} ms`)),
					ms,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
};

// ---------------------------------------------------------------------------
// Trunk never takes a preview sandbox's answer for its own
// ---------------------------------------------------------------------------

Deno.test("a cached preview ok for the trunk key still dispatches on cue:trunk; the applied result is the trunk sandbox's", async () => {
	const h = await setup();
	h.addLane(LANES[19], { "tartan.cue": WEAVE2 });
	await h.facade.preview(LANES[19], AGENT);
	await h.runTimers();
	const preview = h.jobs.splice(0)[0];
	equal(preview.sandbox, cuePreviewSandboxName(0));
	// A compromised preview sandbox forges an answer for the same input key.
	await h.facade.cueResult(
		preview.job.request.inputKey,
		okEnvelope(weave(3)),
		"preview",
	);
	equal(
		(await h.facade.evaluation(preview.job.request.inputKey))?.origin,
		"preview",
	);
	await land(h, WEAVE2);
	await h.runTimers();
	equal(trunkJobs(h).length, 1, "trunk dispatched its own evaluation");
	equal(trunkJobs(h)[0].job.request.inputKey, preview.job.request.inputKey);
	equal(h.head()!.status, "pending", "nothing applied from the preview");
	ok(h.internal.holdSync().held);
	await settle(h);
	equal(h.head()!.status, "current");
	equal(await weaveBatch(h), 2, "the trunk sandbox's answer is applied");
	equal(
		(await h.facade.evaluation(preview.job.request.inputKey))?.origin,
		"trunk",
	);
});

// ---------------------------------------------------------------------------
// A trunk TIMEOUT or LIMIT is final only after two trunk runs, and
// Re-evaluate runs it again
// ---------------------------------------------------------------------------

Deno.test("a trunk TIMEOUT is re-run once before it fails, and Re-evaluate retries it after the environment recovers", async () => {
	const h = await setup();
	h.control.evaluate = (job) =>
		job.request.files["tartan.cue"] === HEAVY
			? errorEnvelope("TIMEOUT", "evaluation stopped after 10 s (SIGKILL)")
			: evaluate(job);
	let dispatched = 0;
	const count = () => (dispatched += trunkJobs(h).length);
	await land(h, HEAVY);
	for (let i = 0; i < 6; i++) {
		await h.runTimers();
		count();
		if ((await h.deliver()) === 0) break;
	}
	equal(dispatched, 2, "the first TIMEOUT is run again on cue:trunk");
	equal(h.head()!.status, "failed");
	// The instance was cold or contended: the next run succeeds.
	h.control.evaluate = evaluate;
	await h.facade.reevaluate(MAINT);
	await settle(h);
	equal(h.head()!.status, "current");
	equal(await weaveBatch(h), 1);
});

// ---------------------------------------------------------------------------
// Re-evaluate never drops a running trunk job's result
// ---------------------------------------------------------------------------

Deno.test("Re-evaluate keeps a running trunk job: its answer resolves the work, with no second dispatch", async () => {
	const h = await setup();
	await land(h, WEAVE2);
	await h.runTimers();
	equal(trunkJobs(h).length, 1, "the Advance's evaluation is running");
	await h.facade.reevaluate(MAINT);
	await h.runTimers();
	equal(trunkJobs(h).length, 1, "no second dispatch: the running job answers");
	await h.deliver();
	await h.runTimers();
	equal(h.head()!.status, "current");
	equal(await weaveBatch(h), 2);
});

// ---------------------------------------------------------------------------
// A trunk result clears an outage recorded by earlier work
// ---------------------------------------------------------------------------

Deno.test("a cached trunk answer clears the outage backoff, so a held Advance resolves at once", async () => {
	const h = await setup();
	await land(h, WEAVE2);
	await h.runTimers();
	equal(trunkJobs(h).length, 1);
	// Earlier work (a registry round) recorded an outage meanwhile.
	h.storage.sql.exec(
		"UPDATE config_head SET unavailable_until = ?, eval_attempts = 4",
		h.now() + 30 * 60_000,
	);
	await h.deliver();
	await h.runTimers();
	equal(h.head()!.unavailable_until, null);
	equal(h.head()!.status, "current", "not held until the backoff ends");
	equal(h.internal.holdSync().held, false);
});

// ---------------------------------------------------------------------------
// Timer handlers bound their ForgeDO calls
// ---------------------------------------------------------------------------

Deno.test("a ForgeDO check that never answers ends the eval pass within its budget; the pass is rescheduled", async () => {
	const h = await setup({ budgetMs: 50 });
	await land(h, WEAVE2);
	await h.runTimers();
	await h.deliver();
	h.control.checkHang = true;
	// The external path asks ForgeDO for a dry-run check.
	h.storage.sql.exec("UPDATE config_head SET status = 'needs-apply'");
	await within(2_000, h.runTimers(3));
	ok(h.scheduled.has("eval"), "the eval pass is rescheduled");
	h.control.checkHang = false;
	h.advance(2_000);
	await within(2_000, settle(h));
});

Deno.test("a fenced apply that never answers ends the apply pass within its budget and retries", async () => {
	const h = await setup({ budgetMs: 50 });
	h.control.applyHang = true;
	await land(h, WEAVE2);
	await h.runTimers();
	await h.deliver();
	await within(2_000, h.runTimers(3));
	ok(h.scheduled.has("apply"), "the apply is retried");
	equal(h.head()!.status, "pending");
	h.control.applyHang = false;
	h.advance(2_000);
	await within(2_000, settle(h));
	equal(h.head()!.status, "current");
	equal(await weaveBatch(h), 2);
});

// ---------------------------------------------------------------------------
// A later write never pushes out a sooner wake
// ---------------------------------------------------------------------------

Deno.test("a waiting preview's retry never pushes out the requeue of the previews still queued", async () => {
	const h = await setup();
	// An earlier preview was unavailable: its retry is due in about 30 s.
	h.control.mode = "unavailable";
	h.addLane(LANES[0], { "tartan.cue": WEAVE3 });
	await h.facade.preview(LANES[0], AGENT);
	await h.module.onTimer("previews");
	equal((await h.facade.previewOf(LANES[0]))?.status, "unavailable");
	h.control.mode = "accept";
	h.advance(1_000);
	// Seven lanes push root .cue edits: five run in the pass, two wait.
	for (let i = 1; i <= 7; i++) {
		h.addLane(LANES[i], { "tartan.cue": cueFile(`// lane ${i}`) });
		await h.facade.preview(LANES[i], AGENT);
	}
	h.scheduled.delete("previews");
	await h.module.onTimer("previews");
	const next = h.scheduled.get("previews");
	ok(
		next !== undefined && next <= h.now() + 1_000,
		`next pass at +${
			(next ?? 0) - h.now()
		} ms, not at the waiting preview's retry`,
	);
});

// ---------------------------------------------------------------------------
// A poke during a pass keeps registry work due; the fence is reserved
// ---------------------------------------------------------------------------

Deno.test("a registry poke that arrives during an eval pass is not lost when the pass ends", async () => {
	const h = await setup();
	await land(h, BROKEN);
	await settle(h);
	equal(h.head()!.status, "failed");
	// The same files land again: a trunk cache hit (BUILD_VALUE). While the
	// pass reads the tree, an Owner's approval moves the epoch.
	let poked = false;
	h.control.afterSchema = async (epoch) => {
		if (poked) return;
		poked = true;
		await h.facade.registryChanged(epoch + 1);
	};
	await land(h, BROKEN, { "README.md": "again\n" });
	await h.module.onTimer("eval");
	ok(poked);
	equal(h.head()!.registry_due, 1, "the poke still has registry work due");
});

Deno.test("registry work reserves its fence position when it writes its intent, apart from an Advance that arrived meanwhile", async () => {
	const h = await setup();
	await land(h, WEAVE2);
	await settle(h);
	// An Owner approves a package elsewhere: the epoch moves, this repo's
	// schema text does not, so registry work re-applies from the cache.
	await h.registry.publish(OWNER, {
		schema: 1,
		id: "acme.other",
		name: "other",
		version: "1.0.0",
		api: "tartan:ext@0.1.0",
		runtime: "js",
		entry: { js: "index.js" },
		storage: { scope: "repo" },
		permissions: { repo: "read" },
	} as unknown as Manifest, {
		sha256: "c".repeat(64),
		r2Prefix: "ext/acme.other/1.0.0",
	});
	const elsewhere = h.forge.tree.add("elsewhere", "group");
	await h.registry.requestConfigApproval(
		OWNER,
		elsewhere.id,
		"acme.other",
		{ version: "1.0.0" },
	);
	// During registry work's schema read, a signed Advance lands.
	let landed = false;
	h.control.afterSchema = async () => {
		if (landed) return;
		landed = true;
		await land(h, WEAVE3);
	};
	await h.facade.registryChanged(
		(await h.registry.repoConfigSchema(h.repoId)).epoch,
	);
	await h.module.onTimer("eval");
	ok(landed);
	// Whatever that pass wrote is applied before the Advance's evaluation.
	await h.module.onTimer("apply");
	await settle(h);
	equal(h.head()!.status, "current");
	equal(await weaveBatch(h), 3, "the Advance's config, never rolled back");
	const answers = h.storage.sql.exec<{ answer_json: string | null }>(
		"SELECT answer_json FROM config_apply_intents",
	).toArray().map((r) => JSON.parse(r.answer_json ?? "{}"));
	ok(
		answers.every((a) => a.reason !== "fence-conflict"),
		"no two works shared one fence position",
	);
});

// ---------------------------------------------------------------------------
// Pruning never removes the last good row
// ---------------------------------------------------------------------------

Deno.test("more than 50 failed config landings keep the last good config as last good, never no config", async () => {
	const h = await setup();
	await land(h, WEAVE2);
	await settle(h);
	equal(h.head()!.status, "current");
	for (let i = 0; i <= TRUNK_ROWS_KEPT; i++) {
		await land(h, BROKEN, { "env.cue": `package cuenv\n// ${i}\n` });
		await settle(h);
	}
	equal(h.head()!.status, "failed");
	const tip = h.refs.get("refs/heads/main")!;
	const answer = await h.facade.policy(tip, "tartan.weave", ["batch"]);
	equal(answer.state, "ok");
	if (answer.state !== "ok") return;
	equal(answer.exact, false);
	ok(answer.failed !== undefined);
	const at = h.internal.policyAtSync(h.seqOf(tip)!);
	ok(at.state === "ok");
	deepStrictEqual(at.state === "ok" ? at.resolved : null, weave(2));
});

// ---------------------------------------------------------------------------
// One lane-paths row per lane, none while the switch is off
// ---------------------------------------------------------------------------

Deno.test("config_lane_paths keeps only each lane's newest head, and records nothing while the switch is off", async () => {
	const h = await setup();
	const lane = LANES[3];
	const shas = ["1", "2", "3"].map((c) => c.repeat(40));
	for (const sha of shas) pushDiffed(h, lane, sha, ["README.md"]);
	const rows = () =>
		h.storage.sql.exec<{ head: string }>(
			"SELECT head FROM config_lane_paths",
		).toArray().map((r) => r.head);
	deepStrictEqual(rows(), [shas[2]]);
	equal(h.internal.policyTouchSync(lane, shas[2]), "clean");
	const off = await setup({ enabled: false });
	pushDiffed(off, lane, shas[0], ["tartan.cue"]);
	equal(
		off.storage.sql.exec<{ n: number }>(
			"SELECT COUNT(*) AS n FROM config_lane_paths",
		).toArray()[0].n,
		0,
	);
});

// ---------------------------------------------------------------------------
// Keep-last-good covers one generation of ForgeDO's
// gate-missing hold; a later gate loss holds again
// ---------------------------------------------------------------------------

const TWO_GATES = cueFile(
	'extensions: "acme.no-secrets": settings: {}\nextensions: "acme.lint": {}',
);

Deno.test("two consecutive gate losses under one keep-last-good: the second loss holds again", async () => {
	const h = await setup();
	await h.registry.publish(OWNER, {
		schema: 1,
		id: "acme.lint",
		name: "lint",
		version: "1.0.0",
		api: "tartan:ext@0.1.0",
		runtime: "js",
		entry: { js: "index.js" },
		storage: { scope: "repo" },
		permissions: { repo: "read" },
		gates: [{ point: "ref.advance" }],
	} as unknown as Manifest, {
		sha256: "e".repeat(64),
		r2Prefix: "ext/acme.lint/1.0.0",
	});
	const rawkode = h.forge.tree.node("rawkode").id;
	equal(
		(await h.registry.requestConfigApproval(OWNER, rawkode, "acme.lint", {
			version: "1.0.0",
		})).state,
		"approved",
	);
	RESOLVED[TWO_GATES] = {
		extensions: {
			"acme.no-secrets": {
				enabled: true,
				mode: "enforce",
				settings: { severity: "hunk", allow: [] },
			},
			"acme.lint": { enabled: true, mode: "enforce", settings: {} },
		},
	};
	await land(h, TWO_GATES);
	await settle(h);
	equal(h.head()!.status, "current");
	const forgeHold = () => h.registry.landContext(h.repoId);
	// The first gate loses its approval: lands hold.
	await h.registry.revokeConfigApproval(OWNER, rawkode, "acme.no-secrets");
	const first = await forgeHold();
	equal(first.configHold, "gate-missing");
	ok(h.internal.holdSync(first.configHold, first.configHoldId).held);
	// The Owner accepts that loss.
	await h.facade.override("keep-last-good", OWNER);
	equal(
		h.internal.holdSync(first.configHold, first.configHoldId).held,
		false,
	);
	// The second gate loses its approval too: a new loss, held again.
	await h.registry.revokeConfigApproval(OWNER, rawkode, "acme.lint");
	const second = await forgeHold();
	equal(second.configHold, "gate-missing");
	ok((second.configHoldId ?? 0) > (first.configHoldId ?? 0));
	deepStrictEqual(
		h.internal.holdSync(second.configHold, second.configHoldId),
		{ held: true, reason: "gate-missing" },
	);
});

// ---------------------------------------------------------------------------
// K9: a long hold notifies the repo's Owners, once
// ---------------------------------------------------------------------------

Deno.test("K9: a hold that lasts 15 minutes is told to the repo's Owners once", async () => {
	const h = await setup();
	h.control.mode = "unavailable";
	await land(h, WEAVE2);
	await h.runTimers();
	ok(h.internal.holdSync().held, "held while the evaluator is unavailable");
	h.advance(10 * 60_000);
	h.internal.holdSync();
	await h.module.onTimer("notice");
	equal(h.notices.length, 0, "not yet");
	h.advance(6 * 60_000);
	h.internal.holdSync();
	ok(h.scheduled.has("notice"), "a notice is due");
	await h.module.onTimer("notice");
	equal(h.notices.length, 1);
	equal(h.notices[0].principal, OWNER);
	ok(h.notices[0].text.includes("held for 16 min"), h.notices[0].text);
	h.advance(60_000);
	h.internal.holdSync();
	await h.module.onTimer("notice");
	equal(h.notices.length, 1, "once per hold");
});

// ---------------------------------------------------------------------------
// Turning the switch on (again)
// ---------------------------------------------------------------------------

const OWNERS = cueFile(
	'extensions: "tartan.review": settings: owners: rules: [{paths: ["services/api/**"], sensitivity: 2, owners: ["@platform"]}]',
);
const OWNERS_RESOLVED = {
	extensions: {
		"tartan.review": {
			settings: {
				owners: {
					rules: [{
						paths: ["services/api/**"],
						sensitivity: 2,
						owners: ["@platform"],
					}],
				},
			},
		},
	},
};
const PIPE = (name: string) =>
	cueFile(
		`extensions: "tartan.ci": settings: pipeline: jobs: ${name}: run: "echo ${name}"`,
	);
const pipeResolved = (name: string) => ({
	extensions: {
		"tartan.ci": {
			settings: { pipeline: { jobs: { [name]: { run: `echo ${name}` } } } },
		},
	},
});
RESOLVED[OWNERS] = OWNERS_RESOLVED;
RESOLVED[PIPE("a")] = pipeResolved("a");
RESOLVED[PIPE("b")] = pipeResolved("b");

Deno.test("trunk config seeded while the switch was off reads pending once it is on, never none; it is policy only after a Maintainer applies it", async () => {
	const h = await setup({ enabled: false });
	// The demo seed: trunk has root *.cue files while the switch is off.
	const tip = h.trunk({ "tartan.cue": OWNERS, "README.md": "demo\n" });
	equal(h.internal.policyAtSync(h.seqOf(tip)!).state, "none", "off: none");
	h.setEnabled(true);
	const read = () =>
		h.facade.policy(tip, "tartan.review", ["owners"]) as Promise<
			{ state: string; exact?: boolean; values?: Record<string, unknown> }
		>;
	equal((await read()).state, "pending", "on: the tip's config is evaluating");
	await settle(h);
	// Evaluated, but nobody signed it: not policy yet (review routes every
	// change to a person; CI plans zero-config).
	const unsigned = await read();
	equal(unsigned.state, "ok");
	equal(unsigned.exact, false);
	deepStrictEqual(unsigned.values, {});
	equal(h.head()!.status, "needs-apply");
	// A Maintainer applies trunk's config: it is policy.
	await h.facade.apply(tip, MAINT);
	await settle(h);
	const applied = await read();
	equal(applied.state, "ok");
	equal(applied.exact, true);
	deepStrictEqual(applied.values, {
		owners: OWNERS_RESOLVED.extensions["tartan.review"].settings.owners,
	});
});

Deno.test("after the switch was off while an unsigned change replaced the pipeline, the old config never reads as exact", async () => {
	const h = await setup();
	await land(h, PIPE("a"));
	await settle(h);
	equal(h.head()!.status, "current");
	h.setEnabled(false);
	h.internal.holdSync(); // the switch is seen off
	// An unsigned change replaces the pipeline while the switch is off.
	const tip = h.trunk({ "tartan.cue": PIPE("b") });
	h.internal.onAdvanceSync({
		sha: tip,
		changes: [{
			changeId: "u".repeat(32),
			laneId: LANES[18],
			head: tip,
			commit: tip,
			paths: ["tartan.cue"],
			capped: false,
		}],
	});
	h.setEnabled(true);
	const read = () =>
		h.facade.policy(tip, "tartan.ci", ["pipeline"]) as Promise<
			{ state: string; exact?: boolean; values?: Record<string, unknown> }
		>;
	equal((await read()).state, "pending", "never the old pipeline as exact");
	await settle(h);
	const after = await read();
	equal(after.exact, false, "the unsigned pipeline is not policy yet");
	deepStrictEqual(after.values, {});
});

Deno.test("a repo with no root .cue files reads no config once its first evaluation after the switch-on ran", async () => {
	const h = await setup({ enabled: false });
	const tip = h.trunk({ "README.md": "plain\n" });
	h.setEnabled(true);
	// The first touch after the switch went on: the tip is read once.
	equal(h.internal.policyAtSync(h.seqOf(tip)!).state, "pending");
	await settle(h);
	equal(h.internal.policyAtSync(h.seqOf(tip)!).state, "none");
	equal(h.head()!.status, "unconfigured");
	equal(h.head()!.boot_seq, null);
});

// ---------------------------------------------------------------------------
// A signed Advance during
// needs-apply holds and applies
// ---------------------------------------------------------------------------

const NS_TEXT = cueFile('extensions: "acme.no-secrets": settings: {}');
RESOLVED[NS_TEXT] = {
	extensions: {
		"acme.no-secrets": {
			enabled: true,
			mode: "enforce",
			settings: { severity: "hunk", allow: [] },
		},
	},
};

Deno.test("a signed config Advance during needs-apply holds lands and installs the gate a person approved", async () => {
	const h = await setup();
	await land(h, WEAVE2);
	await settle(h);
	// Someone moves trunk outside Tartan; an Owner acknowledges: needs-apply.
	h.trunk({ "tartan.cue": WEAVE3 });
	h.internal.observeSync(
		{
			type: "ref.reconciled",
			data: { ref: "refs/heads/main", matched: false },
			actor: { kind: "system", id: "sys_kernel" },
		} as unknown as Envelope,
	);
	await settle(h);
	equal(h.head()!.status, "needs-apply");
	// A Maintainer signs off a change that installs acme.no-secrets (enforce).
	await land(h, NS_TEXT);
	ok(h.internal.holdSync().held, "lands wait for the signed config");
	await settle(h);
	equal(h.head()!.status, "current");
	ok(
		(await h.registry.inForce(h.repoId)).some((i) =>
			i.installation.extId === "acme.no-secrets"
		),
		"the gate the person approved is installed",
	);
});

// ---------------------------------------------------------------------------
// Bidi, format and zero-width characters are visible on
// the sign-off surfaces
// ---------------------------------------------------------------------------

Deno.test("issue text and plan values show bidi and zero-width characters as escapes", () => {
	const rlo = "‮";
	const issues = normalizeCueErrors(
		`extensions.x: conflicting values "rm -rf ${rlo}fdsa"\n    ./tartan.cue:3:1\n`,
	);
	ok(!issues[0].msg.includes(rlo), issues[0].msg);
	ok(issues[0].msg.includes("\\u202e"));
	ok(formatValue(`echo ok${rlo} ;rm -rf /`).includes("\\u202e"));
	ok(!formatValue("a​b").includes("​"));
	const lines = policyPlan({
		before: {},
		after: {
			extensions: {
				"tartan.ci": {
					settings: {
						pipeline: { jobs: { [`test${rlo}`]: { run: "x" } } },
					},
				},
			},
		},
		policyKeys: new Map([["tartan.ci", ["pipeline"]]]),
	});
	ok(lines.length > 0);
	for (const line of lines) {
		ok(!line.text.includes(rlo), line.text);
	}
});

// ---------------------------------------------------------------------------
// A deep evaluator queue is not an outage
// ---------------------------------------------------------------------------

Deno.test("the watchdog deadline grows with the jobs queued ahead", async () => {
	const h = await setup();
	h.control.ahead = 12;
	await land(h, WEAVE2);
	await h.runTimers();
	const job = h.storage.sql.exec<{ deadline_at: number }>(
		"SELECT deadline_at FROM config_jobs WHERE family = 'trunk'",
	).toArray()[0];
	ok(job !== undefined);
	ok(
		job.deadline_at - h.now() >= 30_000 + 12 * 2_000,
		`deadline in ${job.deadline_at - h.now()} ms`,
	);
});
