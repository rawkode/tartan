// The RepoDO `repoconfig` state machine after registry changes, trunk moves
// and overrides (ADR repo config, "Cache and state" and "Applying
// results"), on the same harness as module.test.ts: the REAL registry for
// schema, check and the fenced apply, and a fake evaluator that knows the
// test's `tartan.cue` texts. Here the evaluator can depend on the schema:
// `acme.other` evaluates only once the schema offers it (an Owner approved
// it), as CUE's closedness would decide.

import { deepStrictEqual, equal, notEqual, ok } from "node:assert/strict";
import {
	type CueJobInput,
	cuePreviewSandboxName,
	type Envelope,
	type EvalResponse,
	type Manifest,
} from "@tartan/contract";
import { NO_SECRETS_SETTINGS } from "./testing/corpus.ts";
import { cueFile } from "./testing/git.ts";
import {
	AGENT,
	createRepoConfigHarness,
	errorEnvelope,
	MAINT,
	okEnvelope,
	OWNER,
} from "./testing/harness.ts";

const LANES = Array.from(
	{ length: 8 },
	(_, i) => `ln_01k6${String.fromCharCode(97 + i).repeat(22)}`,
);

const WEAVE2 = cueFile('extensions: "tartan.weave": settings: batch: 2');
const WEAVE3 = cueFile('extensions: "tartan.weave": settings: batch: 3');
const BROKEN = cueFile('extensions: "tartan.weave": settings: batch: 12');
const PIPE_A = cueFile('extensions: "tartan.ci": settings: pipeline: "a"');
const PIPE_B = cueFile('extensions: "tartan.ci": settings: pipeline: "b"');
const OTHER = cueFile('extensions: "acme.other": {}');
const NS = cueFile('extensions: "acme.no-secrets": settings: {}');

const PIPELINE = (name: string) => ({
	jobs: { [name]: { run: `echo ${name}` } },
});

const RESOLVED: Record<string, unknown> = {
	[WEAVE2]: { extensions: { "tartan.weave": { settings: { batch: 2 } } } },
	[WEAVE3]: { extensions: { "tartan.weave": { settings: { batch: 3 } } } },
	[PIPE_A]: {
		extensions: { "tartan.ci": { settings: { pipeline: PIPELINE("a") } } },
	},
	[PIPE_B]: {
		extensions: { "tartan.ci": { settings: { pipeline: PIPELINE("b") } } },
	},
	[NS]: {
		extensions: {
			"acme.no-secrets": {
				enabled: true,
				mode: "enforce",
				settings: { severity: "hunk", allow: [] },
			},
		},
	},
};

/** The fake evaluator; `acme.other` is a field only once the schema has it. */
const evaluate = (job: CueJobInput): EvalResponse => {
	const text = job.request.files["tartan.cue"];
	if (text === undefined) return okEnvelope({});
	if (text === OTHER) {
		const ext = job.request.files["cue.mod/pkg/tartan.dev/ext/ext.cue"] ?? "";
		return ext.includes('"acme.other"')
			? okEnvelope({
				extensions: {
					"acme.other": { enabled: true, mode: "enforce", settings: {} },
				},
			})
			: errorEnvelope(
				"BUILD_VALUE",
				'extensions."acme.other": field not allowed',
			);
	}
	const resolved = RESOLVED[text];
	return resolved === undefined
		? errorEnvelope("BUILD_VALUE", "invalid value 12 (out of bound <=4)")
		: okEnvelope(resolved);
};

const setup = async () => {
	const h = await createRepoConfigHarness();
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

/** Runs timers and delivers every job until nothing is left. */
const settle = async (h: H) => {
	for (let i = 0; i < 5; i++) {
		await h.runTimers();
		if ((await h.deliver()) === 0) break;
	}
	await h.runTimers();
};

const observe = (h: H, type: string, data: Record<string, unknown> = {}) =>
	h.internal.observeSync(
		{
			type,
			data,
			actor: { kind: "system", id: "sys_kernel" },
		} as unknown as Envelope,
	);

const reconciled = (h: H) =>
	observe(h, "ref.reconciled", { ref: "refs/heads/main", matched: false });

const rowAt = (h: H, sha: string) =>
	h.trunkRows().find((r) => r.sha === sha) ?? null;

const inForce = async (h: H, extId: string) =>
	(await h.registry.inForce(h.repoId)).find((i) =>
		i.installation.extId === extId
	);

const weaveBatch = async (h: H) => {
	const weave = (await inForce(h, "tartan.weave"))!;
	const here = await h.registry.installationAt(weave.installation.id, h.repoId);
	return (here!.config as Record<string, unknown>).batch;
};

const publishOther = async (h: H) =>
	await h.registry.publish(
		OWNER,
		{
			schema: 1,
			id: "acme.other",
			name: "other",
			version: "1.0.0",
			api: "tartan:ext@0.1.0",
			runtime: "js",
			entry: { js: "index.js" },
			storage: { scope: "repo" },
			permissions: { repo: "read" },
		} as unknown as Manifest,
		{ sha256: "c".repeat(64), r2Prefix: "ext/acme.other/1.0.0" },
	);

/** An Owner approves acme.other at /rawkode; returns the new epoch. */
const approveOther = async (h: H): Promise<number> => {
	const req = await h.registry.requestConfigApproval(
		OWNER,
		h.forge.tree.node("rawkode").id,
		"acme.other",
		{ version: "1.0.0" },
	);
	equal(req.state, "approved");
	return (await h.registry.repoConfigSchema(h.repoId)).epoch;
};

const dirtyRepos = (h: H): string[] =>
	h.forge.db.sql.exec<{ node_id: string }>(
		"SELECT node_id FROM repo_config_dirty",
	).toArray().map((r) => r.node_id);

const forgeHold = async (h: H) =>
	(await h.registry.landContext(h.repoId)).configHold;

// ---------------------------------------------------------------------------
// Registry work evaluates trunk's config, not the applied one
// ---------------------------------------------------------------------------

Deno.test("registry work: a trunk config that needed an approval applies once the Owner approves it, and its error row resolves", async () => {
	const h = await setup();
	await land(h, WEAVE2);
	await settle(h);
	equal(h.head()!.status, "current");
	await publishOther(h);
	const c2 = await land(h, OTHER);
	await settle(h);
	equal(h.head()!.status, "failed");
	equal(rowAt(h, c2)?.status, "error");
	const before = await h.facade.policy(c2, "tartan.ci", ["pipeline"]);
	ok(before.state === "ok" && !before.exact);
	const epoch = await approveOther(h);
	ok(dirtyRepos(h).includes(h.repoId), "the repo is poked");
	await h.facade.registryChanged(epoch);
	await settle(h);
	equal(h.head()!.status, "current");
	equal(
		h.head()!.applied_sha,
		c2,
		"trunk's config is applied, not the old one",
	);
	ok(await inForce(h, "acme.other"), "acme.other is installed");
	equal(
		rowAt(h, c2)?.status,
		"ok",
		"the error row resolves under the new schema",
	);
	const after = await h.facade.policy(c2, "tartan.ci", ["pipeline"]);
	ok(
		after.state === "ok" && after.exact,
		"repo policy at trunk is exact again",
	);
	equal(h.head()!.failure_json, null);
});

Deno.test("registry work: a first config that never applied is poked (the watch set) and applies after the approval", async () => {
	const h = await setup();
	await publishOther(h);
	const c1 = await land(h, OTHER);
	await settle(h);
	equal(h.head()!.status, "failed");
	equal(h.head()!.applied_key, null);
	const epoch = await approveOther(h);
	ok(
		dirtyRepos(h).includes(h.repoId),
		"a repo with nothing applied is poked too",
	);
	await h.facade.registryChanged(epoch);
	await settle(h);
	equal(h.head()!.status, "current");
	equal(h.head()!.applied_sha, c1);
	equal(rowAt(h, c1)?.status, "ok");
});

Deno.test("registry work during needs-apply re-applies the applied config and keeps needs-apply with its plan", async () => {
	const h = await setup();
	await land(h, WEAVE2);
	await settle(h);
	h.trunk({ "tartan.cue": WEAVE3 });
	reconciled(h);
	await settle(h);
	equal(h.head()!.status, "needs-apply");
	const plan = (await h.facade.state()).plan.map((l) => l.text);
	deepStrictEqual(plan, [
		"overlay tartan.weave (inherited from /rawkode): batch 2 → 3",
	]);
	await publishOther(h);
	const epoch = await approveOther(h);
	await h.facade.registryChanged(epoch);
	await settle(h);
	const state = await h.facade.state();
	equal(state.status, "needs-apply", "the external config is not dropped");
	deepStrictEqual(state.plan.map((l) => l.text), plan);
	equal(
		state.appliedEpoch,
		epoch,
		"the applied config re-applied at the new epoch",
	);
	equal(await weaveBatch(h), 2);
});

Deno.test("registry work: a trunk config that does not evaluate stays failed after a same-epoch poke and a re-evaluate", async () => {
	const h = await setup();
	await land(h, WEAVE2);
	await settle(h);
	const bad = await land(h, BROKEN);
	await settle(h);
	equal(h.head()!.status, "failed");
	const epoch = h.head()!.applied_epoch as number;
	await h.facade.registryChanged(epoch);
	await settle(h);
	equal(h.head()!.status, "failed");
	equal((await h.facade.state()).failure?.code, "BUILD_VALUE");
	await h.facade.reevaluate(MAINT);
	await settle(h);
	equal(h.head()!.status, "failed");
	equal((await h.facade.state()).failure?.code, "BUILD_VALUE");
	equal(rowAt(h, bad)?.status, "error");
	equal(await weaveBatch(h), 2, "the last good set stays");
});

Deno.test("registry work takes a fresh fence position: a changed key at the same epoch applies once, with no loop", async () => {
	const h = await setup();
	const c1 = await land(h, WEAVE2);
	await settle(h);
	const key = rowAt(h, c1)!.input_key as string;
	// The stored key differs from the one computed now at the same epoch
	// (an evaluator id change, a schema text change, a restored DO).
	const fake = "f".repeat(64);
	h.forge.db.sql.exec("UPDATE repo_config_state SET applied_key = ?", fake);
	h.storage.sql.exec("UPDATE config_head SET applied_key = ?", fake);
	await h.facade.reevaluate(MAINT);
	const ran = await h.runTimers(100);
	ok(ran.length < 20, `terminates (${ran.length} timer runs)`);
	equal(h.head()!.status, "current");
	equal(h.head()!.applied_key, key);
	equal((await h.registry.repoConfigState(h.repoId))?.appliedKey, key);
	const intents = h.storage.sql.exec<{ n: number }>(
		"SELECT COUNT(*) AS n FROM config_apply_intents",
	).toArray()[0].n;
	ok(intents <= 3, `${intents} apply intents`);
});

// ---------------------------------------------------------------------------
// The trunk config history
// ---------------------------------------------------------------------------

Deno.test("policyAt: a base between the pruned rows and the oldest kept one reads expired, never none", async () => {
	const h = await setup();
	const after: string[] = [];
	for (let i = 0; i < 52; i++) {
		const text = cueFile(
			`extensions: "tartan.weave": settings: batch: ${(i % 4) + 1}\n// ${i}`,
		);
		RESOLVED[text] = {
			extensions: { "tartan.weave": { settings: { batch: (i % 4) + 1 } } },
		};
		await land(h, text);
		await settle(h);
		// A commit after each landing that touched no root *.cue file.
		after.push(h.trunk({ "tartan.cue": text, "src/app.ts": `${i}` }));
	}
	equal(h.trunkRows().length, 50);
	deepStrictEqual(h.internal.policyAtSync(h.seqOf(after[0])!), {
		state: "expired",
	});
	deepStrictEqual(
		h.internal.policyAtSync(h.seqOf(after[1])!),
		{ state: "expired" },
		"the second row was pruned too",
	);
	const kept = h.internal.policyAtSync(h.seqOf(after[2])!);
	ok(kept.state === "ok" && kept.exact);
});

Deno.test("a pending row superseded by a later Advance still resolves (history work), so its bases stop reading pending", async () => {
	const h = await setup();
	await land(h, PIPE_A);
	await settle(h);
	h.control.mode = "unavailable";
	const b = await land(h, PIPE_B);
	await h.runTimers();
	equal(rowAt(h, b)?.status, "pending");
	await h.facade.override("keep-last-good", OWNER);
	const c = await land(h, WEAVE2);
	h.control.mode = "accept";
	h.advance(60 * 60 * 1000);
	await settle(h);
	equal(h.head()!.status, "current");
	equal(rowAt(h, c)?.status, "ok");
	equal(rowAt(h, b)?.status, "ok", "the older row resolved");
	const at = await h.facade.policy(b, "tartan.ci", ["pipeline"]);
	ok(at.state === "ok" && at.exact);
	deepStrictEqual(at.state === "ok" ? at.values : null, {
		pipeline: PIPELINE("b"),
	});
	equal(await weaveBatch(h), 2);
});

Deno.test("an import opens the imported tip's row pending at once; readers wait instead of reading no config", async () => {
	const h = await setup();
	const tip = h.trunk({ "tartan.cue": PIPE_A });
	observe(h, "repo.imported");
	deepStrictEqual(await h.facade.policy(tip, "tartan.ci", ["pipeline"]), {
		state: "pending",
	});
	await settle(h);
	const at = await h.facade.policy(tip, "tartan.ci", ["pipeline"]);
	ok(at.state === "ok" && at.exact);
	equal(h.head()!.status, "needs-apply");
});

Deno.test("an external move back to the applied config clears needs-apply and its plan", async () => {
	const h = await setup();
	await land(h, WEAVE2);
	await settle(h);
	h.trunk({ "tartan.cue": WEAVE3 });
	reconciled(h);
	await settle(h);
	equal(h.head()!.status, "needs-apply");
	h.trunk({ "tartan.cue": WEAVE2, "README.md": "back\n" });
	reconciled(h);
	await settle(h);
	const state = await h.facade.state();
	equal(state.status, "current");
	deepStrictEqual(state.plan, []);
	equal(state.failure, undefined);
});

// ---------------------------------------------------------------------------
// Jobs: trunk and preview families never answer for each other
// ---------------------------------------------------------------------------

Deno.test("trunk never joins a preview job of the same key: it dispatches on cue:trunk and resolves", async () => {
	const h = await setup();
	h.addLane(LANES[7], { "tartan.cue": WEAVE2 });
	await h.facade.preview(LANES[7], AGENT);
	await h.runTimers();
	deepStrictEqual(h.jobs.map((j) => j.sandbox), [cuePreviewSandboxName(0)]);
	await land(h, WEAVE2);
	await h.runTimers();
	ok(
		h.jobs.some((j) => j.sandbox === "cue:trunk"),
		"trunk dispatched its own job",
	);
	// Only trunk's job answers; the preview stays in flight.
	await h.deliver((j) => j.sandbox === "cue:trunk");
	await h.runTimers();
	equal(h.head()!.status, "current");
	equal(h.internal.holdSync().held, false);
	const key = h.head()!.applied_key as string;
	equal((await h.facade.evaluation(key))?.origin, "trunk");
	// The preview is answered by the cache too.
	equal((await h.facade.previewOf(LANES[7]))?.status, "ok");
});

Deno.test("a preview's answer never overwrites a trunk result, and a stray preview answer resolves no trunk job", async () => {
	const h = await setup();
	h.addLane(LANES[6], { "tartan.cue": WEAVE2 });
	await h.facade.preview(LANES[6], AGENT);
	await h.runTimers();
	const previewJob = h.jobs.splice(0)[0];
	equal(previewJob.sandbox, cuePreviewSandboxName(0));
	await land(h, WEAVE2);
	await h.runTimers();
	const trunkJob = h.jobs.splice(0)[0];
	equal(trunkJob.sandbox, "cue:trunk");
	const key = trunkJob.job.request.inputKey;
	equal(previewJob.job.request.inputKey, key, "the same input key");
	// The preview sandbox answers TIMEOUT first: trunk stays pending, held.
	await h.facade.cueResult(
		key,
		errorEnvelope("TIMEOUT", "stopped after 10 s"),
		"preview",
	);
	await h.runTimers();
	equal(h.head()!.status, "pending");
	ok(h.internal.holdSync().held);
	// Trunk's own answer resolves it.
	await h.facade.cueResult(key, evaluate(trunkJob.job), "trunk");
	await h.runTimers();
	equal(h.head()!.status, "current");
	// A late preview TIMEOUT never downgrades the trunk entry.
	await h.facade.cueResult(
		key,
		errorEnvelope("TIMEOUT", "stopped after 10 s"),
		"preview",
	);
	const cached = await h.facade.evaluation(key);
	equal(cached?.origin, "trunk");
	equal(cached?.status, "ok");
});

Deno.test("an unavailable preview is queued again with backoff and then evaluates", async () => {
	const h = await setup();
	h.addLane(LANES[5], { "tartan.cue": WEAVE3 });
	h.control.mode = "unavailable";
	await h.facade.preview(LANES[5], AGENT);
	await h.runTimers();
	equal((await h.facade.previewOf(LANES[5]))?.status, "unavailable");
	ok(h.scheduled.has("previews"), "a retry is scheduled");
	h.control.mode = "accept";
	h.advance(31_000);
	await settle(h);
	equal((await h.facade.previewOf(LANES[5]))?.status, "ok");
	ok(
		types(h.events).filter((t) => t === "repo.config.previewed").length >= 2,
		"each outcome is announced",
	);
});

const types = (events: Envelope[]) => events.map((e) => e.type);

// ---------------------------------------------------------------------------
// The hold: ForgeDO read fresh, and keep-last-good scoped to what it covered
// ---------------------------------------------------------------------------

Deno.test("holdSync uses ForgeDO's hold as just read, not the last evaluation's copy", async () => {
	const h = await setup();
	deepStrictEqual(h.internal.holdSync(), { held: false });
	deepStrictEqual(h.internal.holdSync("gate-missing"), {
		held: true,
		reason: "gate-missing",
	});
	deepStrictEqual(h.internal.holdSync(), {
		held: true,
		reason: "gate-missing",
	}, "the fresh value is recorded");
	deepStrictEqual(h.internal.holdSync(null), { held: false });
});

Deno.test("keep-last-good covers only the holds present when it was set; it ends with them; it is the escape from a lost gate", async () => {
	const h = await setup();
	await land(h, NS);
	await settle(h);
	equal(h.head()!.status, "current");
	ok(await inForce(h, "acme.no-secrets"));
	// An override of a pending resolution that then fails is cleared.
	h.control.mode = "unavailable";
	await land(h, BROKEN, { "env.cue": "package cuenv\n" });
	await h.runTimers();
	ok(h.internal.holdSync().held);
	await h.facade.override("keep-last-good", OWNER);
	equal((await h.facade.state()).keptLastGoodBy, OWNER);
	h.control.mode = "accept";
	h.advance(60 * 60 * 1000);
	await settle(h);
	equal(h.head()!.status, "failed");
	equal((await h.facade.state()).keptLastGoodBy, undefined, "cleared");
	// A later gate-missing hold is not masked by it.
	await h.registry.revokeConfigApproval(
		OWNER,
		h.forge.tree.node("rawkode").id,
		"acme.no-secrets",
	);
	equal(await forgeHold(h), "gate-missing");
	deepStrictEqual(h.internal.holdSync(await forgeHold(h)), {
		held: true,
		reason: "gate-missing",
	});
	// The re-apply is denied (the approval is gone): the Owner's escape.
	await h.facade.registryChanged(
		(await h.registry.repoConfigSchema(h.repoId)).epoch,
	);
	await settle(h);
	ok(h.internal.holdSync(await forgeHold(h)).held, "still held");
	await h.facade.override("keep-last-good", OWNER);
	deepStrictEqual(h.internal.holdSync(await forgeHold(h)), { held: false });
	// The fix lands (no acme.no-secrets entry); ForgeDO clears its hold and
	// the override ends with it.
	await land(h, WEAVE2);
	equal(h.internal.holdSync().reason, "pending");
	await settle(h);
	equal(h.head()!.status, "current");
	equal(await forgeHold(h), null);
	deepStrictEqual(h.internal.holdSync(await forgeHold(h)), { held: false });
	equal((await h.facade.state()).keptLastGoodBy, undefined);
});

// ---------------------------------------------------------------------------
// Audit principals of a registry re-apply
// ---------------------------------------------------------------------------

Deno.test("a re-apply after an approval version change names the Owner as installer and actor; the signer stays a principal", async () => {
	const h = await setup();
	await land(h, NS);
	await settle(h);
	equal((await inForce(h, "acme.no-secrets"))?.installation.installedBy, MAINT);
	await h.registry.publish(
		OWNER,
		{
			schema: 1,
			id: "acme.no-secrets",
			name: "no secrets",
			version: "0.3.0",
			api: "tartan:ext@0.1.0",
			runtime: "js",
			entry: { js: "index.js" },
			storage: { scope: "repo" },
			permissions: { repo: "read" },
			gates: [{ point: "ref.advance" }],
			config: {
				default: { severity: "hunk", allow: [] },
				cue: "config/settings.cue",
			},
		} as unknown as Manifest,
		{
			sha256: "d".repeat(64),
			r2Prefix: "ext/acme.no-secrets/0.3.0",
			configCue: NO_SECRETS_SETTINGS,
		},
	);
	const req = await h.registry.requestConfigApproval(
		OWNER,
		h.forge.tree.node("rawkode").id,
		"acme.no-secrets",
		{ version: "0.3.0" },
	);
	await h.registry.selfCheckResult(
		req.id,
		okEnvelope({
			extensions: {
				"acme.no-secrets": {
					enabled: true,
					mode: "enforce",
					settings: { severity: "hunk", allow: [] },
				},
			},
		}),
	);
	equal(await inForce(h, "acme.no-secrets"), undefined, "0.2.0 dropped");
	const events = h.forge.events.events.length;
	await h.facade.registryChanged(
		(await h.registry.repoConfigSchema(h.repoId)).epoch,
	);
	await settle(h);
	const row = (await inForce(h, "acme.no-secrets"))!;
	equal(row.installation.version, "0.3.0");
	equal(row.installation.installedBy, OWNER);
	const installed = h.forge.events.events.slice(events).find((e) =>
		e.type === "extension.installed"
	)!;
	equal(installed.actor.id, OWNER);
	const audit = h.forge.events.audits.filter((a) =>
		a.action === "repo-config.apply"
	).pop()!;
	equal(audit.principal, OWNER);
	deepStrictEqual(
		(audit.data as { principals: string[] }).principals,
		[OWNER, MAINT],
	);
	notEqual(h.head()!.status, "failed");
});
