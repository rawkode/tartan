// Repository config in the registry (ADR repo config, "Testing"; on the
// node:sqlite fakes): every denial on
// input CUE accepts, approvals and the per-package self-check, the binding
// rule, overlays and repo policy and their isolation, the kernel fields
// (projects, global), the fenced apply, revalidation and the dirty outbox.

import { deepStrictEqual, equal, match, ok, rejects } from "node:assert/strict";
import {
	CUE_EVAL_CONTRACT,
	CUE_EVALUATOR_ID,
	type CueJobInput,
	type EvalResponse,
	fromRpcError,
	type Manifest,
	type RepoConfigApplyInput,
	type RepoConfigDenialCode,
} from "@tartan/contract";
import { settingsCue as ciSettings } from "../../../../../extensions/ci/src/settings-cue.ts";
import { settingsCue as reviewSettings } from "../../../../../extensions/review/src/settings-cue.ts";
import { settingsCue as weaveSettings } from "../../../../../extensions/weave/src/settings-cue.ts";
import { NO_SECRETS_SETTINGS } from "../../../repoconfig/testing/corpus.ts";
import { createRegistry } from "../module.ts";
import { resolve } from "../resolve.ts";
import { REGISTRY_MIGRATIONS } from "../schema.ts";
import { bundled, manifest, registryFixture } from "../test/fakes.ts";
import type { RepoConfigPorts } from "./registry.ts";
import { generateSchema } from "./schemagen.ts";

const OWNER = "u_01k6ffffffffffffffffffffff";
const MAINT = "u_01k6mmmmmmmmmmmmmmmmmmmmmm";
const AGENT = "a_01k6eeeeeeeeeeeeeeeeeeeeee";
const SHA = (n: number) => n.toString(16).padStart(40, "a");
const KEY = (n: number) => n.toString(16).padStart(64, "b");

const WEAVE = bundled(
	manifest("tartan.weave", {
		provides: ["queue@1"],
		permissions: { land: ["refs/heads/main"] },
		subscribe: [{ event: "changes.submitted" }],
		config: {
			default: { batch: 4, debounceMs: 2000 },
			cue: "config/settings.cue",
			repoOverridable: ["batch", "debounceMs"],
		},
	}),
);
const WEAVE_PKG = { ...WEAVE, settingsCue: weaveSettings };
const REVIEW_PKG = {
	...bundled(manifest("tartan.review", {
		provides: ["review@1"],
		gates: [{ point: "ref.advance", default: "veto" }],
		config: {
			default: { mode: "by-exception", autoThreshold: 0.35 },
			cue: "config/settings.cue",
			repoPolicy: ["owners"],
		},
	})),
	settingsCue: reviewSettings,
};
const CI_PKG = {
	...bundled(manifest("tartan.ci", {
		provides: ["checks@1"],
		config: {
			default: { image: "tartan-runner" },
			cue: "config/settings.cue",
			repoPolicy: ["pipeline"],
		},
	})),
	settingsCue: ciSettings,
};
const PKGS = [
	WEAVE_PKG,
	REVIEW_PKG,
	bundled(manifest("tartan.fifo", {
		provides: ["queue@1"],
		permissions: { land: ["refs/heads/main"] },
	})),
	CI_PKG,
	bundled(manifest("tartan.work", { provides: ["work@1"] })),
	bundled(manifest("tartan.pack.swarm", {
		kind: "pack",
		storage: { scope: "node" },
		members: [{ id: "tartan.work", version: "0.1.0" }],
	})),
];

const thirdParty = (
	id: string,
	version: string,
	extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
	schema: 1,
	id,
	name: id,
	version,
	api: "tartan:ext@0.1.0",
	runtime: "js",
	entry: { js: "index.js" },
	storage: { scope: "repo" },
	permissions: { repo: "read" },
	...extra,
});

const NO_SECRETS = (version: string, permissions = { repo: "read" }) =>
	thirdParty("acme.no-secrets", version, {
		permissions,
		gates: [{ point: "ref.advance" }],
		config: {
			default: { severity: "hunk", allow: [] },
			cue: "config/settings.cue",
		},
	});

type Setup = ReturnType<typeof setup>;

const setup = () => {
	const fx = registryFixture(REGISTRY_MIGRATIONS, OWNER);
	fx.tree.add("rawkode", "group");
	fx.tree.add("rawkode/platform", "group");
	fx.tree.add("rawkode/platform/api", "repo");
	fx.tree.add("rawkode/platform/web", "repo");
	fx.tree.add("other", "group");
	fx.tree.grant("rawkode", MAINT, 40);
	const jobs: CueJobInput[] = [];
	const pokes: { repo: string; epoch: number }[] = [];
	const ports: RepoConfigPorts = {
		submit: (job) => {
			jobs.push(job);
			return Promise.resolve({
				accepted: true,
				jobId: `cj_${jobs.length}`,
				warm: true,
				ahead: 0,
				joined: false,
			});
		},
		poke: (repo, epoch) => {
			pokes.push({ repo, epoch });
			return Promise.resolve();
		},
		waitUntil: () => {},
		log: () => {},
	};
	const r = createRegistry(fx.deps, {
		builtins: () => PKGS,
		repoConfigPorts: () => ports,
	});
	r.registerBuiltinsSync(PKGS);
	const publish = (m: Record<string, unknown>, configCue?: string) =>
		r.facade.publish(OWNER, m as unknown as Manifest, {
			sha256: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
			r2Prefix: `ext/${m.id}/${m.version}`,
			...(configCue === undefined ? {} : { configCue }),
		});
	const repo = fx.tree.node("rawkode/platform/api").id;
	const web = fx.tree.node("rawkode/platform/web").id;
	const root = fx.tree.node("rawkode").id;
	return { fx, r, f: r.facade, jobs, pokes, publish, repo, web, root };
};

const okEnvelope = (value: unknown): EvalResponse => ({
	version: CUE_EVAL_CONTRACT,
	evaluator: CUE_EVALUATOR_ID,
	cueVersion: "v0.17.1",
	ok: value,
	issues: [],
});

/** Approves `extId@version` at `node` through the self-check. */
const approve = async (
	s: Setup,
	nodePath: string,
	extId: string,
	version: string,
	defaults: unknown,
) => {
	const req = await s.f.requestConfigApproval(
		OWNER,
		s.fx.tree.node(nodePath).id,
		extId,
		{ version },
	);
	// A version without a config.cue, or one that already passed its
	// self-check (bundled packages are checked at registration), approves at once.
	if (req.state === "approved") return req;
	equal(req.state, "checking");
	const job = s.jobs[s.jobs.length - 1];
	equal(job.class, "selfcheck");
	deepStrictEqual(job.sink, { kind: "approval", requestId: req.id });
	ok(job.request.files["selfcheck.cue"].includes(`"${extId}": {}`));
	const done = await s.f.selfCheckResult(
		req.id,
		okEnvelope({
			extensions: {
				[extId]: { enabled: true, mode: "enforce", settings: defaults },
			},
		}),
	);
	equal(done.state, "approved", done.message);
	return done;
};

const applyInput = (
	s: Setup,
	resolved: unknown,
	over: Partial<RepoConfigApplyInput> = {},
): RepoConfigApplyInput => {
	const schema = s.r.repoConfig.schemaSync(s.repo);
	return {
		trunkSeq: 1,
		epoch: schema.epoch,
		sha: SHA(1),
		inputKey: KEY(1),
		schemaKey: schema.schemaKey,
		resolved,
		principals: [MAINT],
		provenance: {
			firstSha: SHA(1),
			evaluator: CUE_EVALUATOR_ID,
			cueVersion: "v0.17.1",
		},
		...over,
	};
};

const codes = async (
	s: Setup,
	resolved: unknown,
): Promise<RepoConfigDenialCode[]> =>
	(await s.f.checkRepoConfig(s.repo, resolved)).denials.map((d) => d.code);

const rejectsWith = async (
	work: Promise<unknown>,
	code: string,
	re?: RegExp,
) => {
	await rejects(work, (e: unknown) => {
		const err = fromRpcError(e);
		equal(err.code, code, err.message);
		if (re) match(err.message, re);
		return true;
	});
};

// ---------------------------------------------------------------------------
// Approvals and the self-check
// ---------------------------------------------------------------------------

Deno.test("approvals: Owner only, providers and packs refused, a failing self-check refused", async () => {
	const s = setup();
	await s.publish(NO_SECRETS("0.2.0"), NO_SECRETS_SETTINGS);
	await rejectsWith(
		s.f.requestConfigApproval(MAINT, s.root, "acme.no-secrets", {
			version: "0.2.0",
		}),
		"denied",
	);
	await rejectsWith(
		s.f.requestConfigApproval(AGENT, s.root, "acme.no-secrets", {
			version: "0.2.0",
		}),
		"denied",
	);
	await rejectsWith(
		s.f.requestConfigApproval(OWNER, s.root, "tartan.fifo", {
			version: "0.1.0",
		}),
		"invalid",
		/providers stay manual/,
	);
	await rejectsWith(
		s.f.requestConfigApproval(OWNER, s.root, "tartan.pack.swarm", {
			version: "0.1.0",
		}),
		"invalid",
		/pack/,
	);
	const req = await s.f.requestConfigApproval(
		OWNER,
		s.root,
		"acme.no-secrets",
		{
			version: "0.2.0",
		},
	);
	const wrong = await s.f.selfCheckResult(
		req.id,
		okEnvelope({
			extensions: {
				"acme.no-secrets": {
					enabled: true,
					mode: "enforce",
					settings: { severity: "path", allow: [] },
				},
			},
		}),
	);
	equal(wrong.state, "refused");
	match(wrong.message!, /do not equal config.default/);
	equal((await s.f.configApprovals(s.repo)).approvals.length, 0);
	// An evaluator outage leaves the request checking, with a message.
	const again = await s.f.requestConfigApproval(
		OWNER,
		s.root,
		"acme.no-secrets",
		{
			version: "0.2.0",
		},
	);
	const down = await s.f.selfCheckResult(again.id, {
		version: CUE_EVAL_CONTRACT,
		evaluator: CUE_EVALUATOR_ID,
		cueVersion: null,
		error: { code: "EVALUATOR_UNAVAILABLE", message: "no container" },
		issues: [],
	});
	equal(down.state, "checking");
	match(down.message!, /did not run/);
	await approve(s, "rawkode", "acme.no-secrets", "0.2.0", {
		severity: "hunk",
		allow: [],
	});
	const listed = await s.f.configApprovals(s.repo);
	deepStrictEqual(
		listed.approvals.map((a) => [a.extId, a.version, a.nodePath, a.approvedBy]),
		[["acme.no-secrets", "0.2.0", "rawkode", OWNER]],
	);
	ok(s.fx.events.audits.some((a) => a.action === "repo-config.approve"));
});

// ---------------------------------------------------------------------------
// The schema the registry offers
// ---------------------------------------------------------------------------

Deno.test("schema: approved own installs, opted-in overlays and repo policy of installations in force; nothing else", async () => {
	const s = setup();
	await s.publish(NO_SECRETS("0.2.0"), NO_SECRETS_SETTINGS);
	await s.publish(thirdParty("acme.labels", "1.0.0"));
	const weave = await s.f.install(OWNER, {
		extId: "tartan.weave",
		version: "0.1.0",
		node: "rawkode",
		mode: "enforce",
	});
	await s.f.install(OWNER, {
		extId: "tartan.review",
		version: "0.1.0",
		node: "rawkode",
		mode: "enforce",
	});
	let schema = await s.f.repoConfigSchema(s.repo);
	// tartan.review (a provider with a gate) is in force: its repo policy only.
	deepStrictEqual(
		schema.entries.map((e) => [e.kind, e.extId, e.repoPolicy]),
		[["in-force", "tartan.review", ["owners"]]],
	);
	await approve(s, "rawkode", "acme.no-secrets", "0.2.0", {
		severity: "hunk",
		allow: [],
	});
	await approve(s, "rawkode/platform", "acme.labels", "1.0.0", {});
	await s.f.setRepoOverrides(OWNER, weave.id, true);
	schema = await s.f.repoConfigSchema(s.repo);
	deepStrictEqual(
		schema.entries.map((e) => [e.kind, e.extId]),
		[
			["install", "acme.labels"],
			["install", "acme.no-secrets"],
			["in-force", "tartan.review"],
			["in-force", "tartan.weave"],
		],
	);
	const ext = schema.files["cue.mod/pkg/tartan.dev/ext/ext.cue"];
	ok(ext.includes('"acme.labels"?: #Own & {settings: close({})}'));
	ok(
		ext.includes(
			'"acme.no-secrets"?: #Own & {settings: x_acme_no_secrets.#Settings}',
		),
	);
	ok(ext.includes("batch?: x_tartan_weave.#Settings.batch"));
	ok(ext.includes("x_tartan_review.#Policy"));
	ok(!ext.includes('"tartan.review"?: #Own'));
	ok(!ext.includes("tartan.fifo"));
	equal(
		schema.files["~tartan.cue"],
		'package tartan\n\nimport "tartan.dev/ext"\n\n// Generated by the forge: binds this repository\'s package tartan to its\n// schema. Unknown extensions or settings keys are positioned errors.\nextensions?: ext.#Extensions\nprojects?: [string]: ext.#Project\nglobal?: [...string]\n',
	);
	ok(!Object.hasOwn(schema.files, "cue.mod/module.cue"));
	equal(
		schema.files["cue.mod/pkg/tartan.dev/ext/x/acme_no_secrets/settings.cue"],
		NO_SECRETS_SETTINGS,
	);
	// The approval of acme.labels at /rawkode/platform binds neither /other nor ... above it.
	const other = s.fx.tree.add("other/repo", "repo").id;
	deepStrictEqual((await s.f.repoConfigSchema(other)).entries, []);
	// Only an Owner turns repo overrides on, and only where it means something.
	await rejectsWith(s.f.setRepoOverrides(MAINT, weave.id, true), "denied");
	const review = (await s.f.inForce(s.repo)).find((i) =>
		i.installation.extId === "tartan.review"
	)!;
	await rejectsWith(
		s.f.setRepoOverrides(OWNER, review.installation.id, true),
		"invalid",
		/no repo-overridable/,
	);
});

// ---------------------------------------------------------------------------
// Denials on input CUE accepts
// ---------------------------------------------------------------------------

Deno.test("checks: every rule denies on its own input, writing nothing", async () => {
	const s = setup();
	await s.publish(NO_SECRETS("0.2.0"), NO_SECRETS_SETTINGS);
	await s.publish(thirdParty("acme.labels", "1.0.0"));
	await s.publish(thirdParty("acme.notifier", "1.0.0", {
		config: {
			default: { notify: "", mirrors: [] },
			targets: ["notify", "mirrors.repo"],
		},
	}));
	await s.f.install(OWNER, {
		extId: "tartan.review",
		version: "0.1.0",
		node: "rawkode",
		mode: "enforce",
	});
	await s.f.install(OWNER, {
		extId: "tartan.fifo",
		version: "0.1.0",
		node: "rawkode",
		mode: "enforce",
		locked: true,
	});
	await s.f.install(OWNER, {
		extId: "tartan.weave",
		version: "0.1.0",
		node: "other",
		mode: "enforce",
	});
	const weaveHere = await s.f.install(OWNER, {
		extId: "tartan.weave",
		version: "0.1.0",
		node: "rawkode/platform",
		mode: "enforce",
	}).catch(() => null);
	equal(weaveHere, null, "fifo is locked for queue@1 at /rawkode");
	await approve(s, "rawkode", "acme.no-secrets", "0.2.0", {
		severity: "hunk",
		allow: [],
	});
	await approve(s, "rawkode", "acme.notifier", "1.0.0", {
		notify: "",
		mirrors: [],
	});
	const x = (extId: string, entry: unknown) => ({
		extensions: { [extId]: entry },
	});

	deepStrictEqual(await codes(s, x("acme.labels", {})), ["unapproved"]);
	deepStrictEqual(await codes(s, x("tartan.weave", { settings: {} })), [
		"provider_floor",
	]);
	deepStrictEqual(await codes(s, x("tartan.ci", {})), ["provider_floor"]);
	deepStrictEqual(await codes(s, x("tartan.pack.swarm", {})), ["pack"]);
	// K8: the inherited gate of tartan.review cannot be shadowed or disabled.
	deepStrictEqual(await codes(s, x("tartan.review", { mode: "shadow" })), [
		"locked_gate",
	]);
	deepStrictEqual(await codes(s, x("tartan.review", { enabled: false })), [
		"locked_gate",
	]);
	// Repo policy is allowed for an inherited provider with a gate; its other
	// settings are not.
	deepStrictEqual(await codes(s, x("tartan.review", { settings: {} })), []);
	deepStrictEqual(
		await codes(
			s,
			x("tartan.review", { settings: { owners: { rules: [] } } }),
		),
		[],
	);
	deepStrictEqual(
		await codes(s, x("tartan.review", { settings: { autoThreshold: 0 } })),
		["policy_key"],
	);
	// The locked queue@1 provider at /rawkode.
	deepStrictEqual(await codes(s, x("tartan.fifo", { enabled: false })), [
		"locked_provider",
	]);
	// K12: a settings target outside the repository.
	deepStrictEqual(
		await codes(s, x("acme.notifier", { settings: { notify: "other" } })),
		["scope"],
	);
	deepStrictEqual(
		await codes(
			s,
			x("acme.notifier", { settings: { notify: "rawkode/platform/api" } }),
		),
		[],
	);
	// A target nested in an array is checked element by element, and
	// a value must be a node path.
	deepStrictEqual(
		await codes(
			s,
			x("acme.notifier", {
				settings: {
					mirrors: [{ repo: "rawkode/platform/api" }, { repo: "other/x" }],
				},
			}),
		),
		["scope"],
	);
	deepStrictEqual(
		await codes(
			s,
			x("acme.notifier", {
				settings: { notify: "rawkode/platform/api/../../../other" },
			}),
		),
		["scope"],
	);
	deepStrictEqual(
		await codes(
			s,
			x("acme.notifier", {
				settings: { mirrors: [{ repo: "rawkode/platform/api" }] },
			}),
		),
		[],
	);
	// Shadow is for gates only.
	deepStrictEqual(
		await codes(
			s,
			x("acme.notifier", { mode: "shadow", settings: { notify: "" } }),
		),
		["invalid"],
	);
	deepStrictEqual(
		await codes(s, x("acme.no-secrets", { mode: "shadow", settings: {} })),
		[],
	);
	// Strict envelope: nothing but enabled, mode and settings, nothing but extensions.
	for (
		const smuggled of ["locked", "grants", "node", "version", "backgroundRole"]
	) {
		deepStrictEqual(
			await codes(s, x("acme.no-secrets", { [smuggled]: true })),
			["shape"],
			smuggled,
		);
	}
	deepStrictEqual(await codes(s, { extensions: {}, grants: {} }), ["shape"]);
	deepStrictEqual(await codes(s, { pipeline: { jobs: {} } }), ["shape"]);
	deepStrictEqual(await codes(s, { extensions: { "Not An Id": {} } }), [
		"shape",
	]);
	deepStrictEqual(await codes(s, x("acme.no-secrets", { mode: "disabled" })), [
		"shape",
	]);
	// Size and depth caps.
	deepStrictEqual(
		await codes(
			s,
			x("acme.no-secrets", { settings: { allow: ["x".repeat(300 * 1024)] } }),
		),
		["too_large"],
	);
	let deep: unknown = 1;
	for (let i = 0; i < 40; i++) deep = { d: deep };
	deepStrictEqual(
		await codes(s, x("acme.no-secrets", { settings: { deep } })),
		["too_large"],
	);
	// Same node: a manual installation of the same extension at the repo.
	await s.f.install(OWNER, {
		extId: "acme.notifier",
		version: "1.0.0",
		node: "rawkode/platform/api",
		mode: "enforce",
	});
	deepStrictEqual(
		await codes(s, x("acme.notifier", { settings: { notify: "" } })),
		["conflict"],
	);
	// A denial writes nothing.
	const before = s.fx.events.events.length;
	const denied = await s.f.applyRepoConfig(
		s.repo,
		applyInput(s, x("acme.labels", {})),
	);
	equal(denied.kind, "denied");
	equal(s.fx.events.events.length, before);
	equal(await s.f.repoConfigState(s.repo), null);
});

Deno.test("overlay keys: only repoOverridable keys, only with the Owner's opt-in", async () => {
	const s = setup();
	const weave = await s.f.install(OWNER, {
		extId: "tartan.weave",
		version: "0.1.0",
		node: "rawkode",
		mode: "enforce",
	});
	const x = (entry: unknown) => ({ extensions: { "tartan.weave": entry } });
	deepStrictEqual(await codes(s, x({ settings: { batch: 2 } })), ["inherited"]);
	await s.f.setRepoOverrides(OWNER, weave.id, true);
	deepStrictEqual(await codes(s, x({ settings: { batch: 2 } })), []);
	deepStrictEqual(await codes(s, x({ settings: { resolver: "x" } })), [
		"overlay_key",
	]);
	deepStrictEqual(await codes(s, x({ enabled: false })), ["inherited"]);
	deepStrictEqual(await codes(s, x({ mode: "shadow" })), ["inherited"]);
	const plan = await s.f.checkRepoConfig(s.repo, x({ settings: { batch: 2 } }));
	deepStrictEqual(plan.plan.map((l) => l.text), [
		"overlay tartan.weave (inherited from /rawkode): batch 4 → 2",
	]);
});

// ---------------------------------------------------------------------------
// Apply, the fence and the plan
// ---------------------------------------------------------------------------

Deno.test("apply: installs, configures, removes and overlays all or nothing, with events and one audit row", async () => {
	const s = setup();
	await s.publish(NO_SECRETS("0.2.0"), NO_SECRETS_SETTINGS);
	const weave = await s.f.install(OWNER, {
		extId: "tartan.weave",
		version: "0.1.0",
		node: "rawkode",
		mode: "enforce",
	});
	await s.f.setRepoOverrides(OWNER, weave.id, true);
	await approve(s, "rawkode", "acme.no-secrets", "0.2.0", {
		severity: "hunk",
		allow: [],
	});
	const resolved = {
		extensions: {
			"tartan.weave": { settings: { batch: 2 } },
			"acme.no-secrets": {
				enabled: true,
				mode: "enforce",
				settings: { severity: "hunk", allow: ["services/api/fixtures/**"] },
			},
		},
	};
	const plan = await s.f.checkRepoConfig(s.repo, resolved);
	deepStrictEqual(plan.plan.map((l) => l.text), [
		"install acme.no-secrets 0.2.0 (enforce)",
		"overlay tartan.weave (inherited from /rawkode): batch 4 → 2",
	]);
	const audits = s.fx.events.audits.length;
	const answer = await s.f.applyRepoConfig(s.repo, applyInput(s, resolved));
	equal(answer.kind, "applied");
	if (answer.kind !== "applied") return;
	deepStrictEqual(answer.changes, {
		installed: 1,
		updated: 0,
		removed: 0,
		overlays: 1,
	});
	equal(answer.state.appliedKey, KEY(1));
	equal(s.fx.events.audits.length, audits + 1);
	const audit = s.fx.events.audits[s.fx.events.audits.length - 1];
	equal(audit.action, "repo-config.apply");
	equal(audit.principal, MAINT);
	const installed = s.fx.events.events.filter((e) =>
		e.type === "extension.installed"
	).pop()!;
	const data = installed.data as Record<string, unknown>;
	equal(data.source, "repo-config");
	equal(data.sha, SHA(1));
	equal(data.inputKey, KEY(1));
	equal(data.trunkSeq, 1);
	const inForce = await s.f.inForce(s.repo);
	const row = inForce.find((i) => i.installation.extId === "acme.no-secrets")!;
	equal(row.installation.source, "repo-config");
	equal(row.installation.sourceSha, SHA(1));
	equal(row.installation.installedBy, MAINT);
	deepStrictEqual(row.installation.config, {
		severity: "hunk",
		allow: ["services/api/fixtures/**"],
	});
	// The plan of the same config is now empty; a second config configures.
	deepStrictEqual((await s.f.checkRepoConfig(s.repo, resolved)).plan, []);
	const next = {
		extensions: {
			"acme.no-secrets": {
				enabled: true,
				mode: "shadow",
				settings: { severity: "path", allow: [] },
			},
		},
	};
	deepStrictEqual(
		(await s.f.checkRepoConfig(s.repo, next)).plan.map((l) => l.text),
		[
			'configure acme.no-secrets: mode "enforce" → "shadow", allow ["services/api/fixtures/**"] → [], severity "hunk" → "path"',
			"remove overlay tartan.weave (inherited from /rawkode)",
		],
	);
	const second = await s.f.applyRepoConfig(
		s.repo,
		applyInput(s, next, { trunkSeq: 2, inputKey: KEY(2), sha: SHA(2) }),
	);
	equal(second.kind, "applied");
	equal(
		await s.f.installationAt(weave.id, s.repo).then((d) =>
			(d!.config as Record<string, unknown>).batch
		),
		4,
	);
	// Removal: an empty config uninstalls the repo's rows.
	const removal = await s.f.applyRepoConfig(
		s.repo,
		applyInput(s, { extensions: {} }, {
			trunkSeq: 3,
			inputKey: KEY(3),
			sha: SHA(3),
			removal: true,
		}),
	);
	equal(removal.kind, "applied");
	ok(
		!(await s.f.inForce(s.repo)).some((i) =>
			i.installation.source === "repo-config"
		),
	);
});

Deno.test("fence: an older apply delivered last is refused; equal is a no-op; a moved schema is refused", async () => {
	const s = setup();
	await s.publish(thirdParty("acme.labels", "1.0.0"));
	await approve(s, "rawkode", "acme.labels", "1.0.0", {});
	const a = {
		extensions: {
			"acme.labels": { enabled: true, mode: "enforce", settings: {} },
		},
	};
	const b = {
		extensions: {
			"acme.labels": { enabled: false, mode: "enforce", settings: {} },
		},
	};
	const applyB = await s.f.applyRepoConfig(
		s.repo,
		applyInput(s, b, { trunkSeq: 5, inputKey: KEY(5), sha: SHA(5) }),
	);
	equal(applyB.kind, "applied");
	const older = await s.f.applyRepoConfig(
		s.repo,
		applyInput(s, a, { trunkSeq: 4, inputKey: KEY(4), sha: SHA(4) }),
	);
	equal(older.kind, "refused");
	if (older.kind === "refused") {
		equal(older.reason, "older");
		equal(older.state?.appliedKey, KEY(5));
	}
	equal(
		(await s.f.inForce(s.repo)).some((i) =>
			i.installation.extId === "acme.labels"
		),
		false,
		"B (disabled) stays",
	);
	const events = s.fx.events.events.length;
	const audits = s.fx.events.audits.length;
	const same = await s.f.applyRepoConfig(
		s.repo,
		applyInput(s, b, { trunkSeq: 5, inputKey: KEY(5), sha: SHA(5) }),
	);
	equal(same.kind, "noop");
	equal(s.fx.events.events.length, events);
	equal(s.fx.events.audits.length, audits);
	const conflicting = await s.f.applyRepoConfig(
		s.repo,
		applyInput(s, a, { trunkSeq: 5, inputKey: KEY(9), sha: SHA(5) }),
	);
	ok(conflicting.kind === "refused" && conflicting.reason === "fence-conflict");
	const stale = await s.f.applyRepoConfig(
		s.repo,
		applyInput(s, a, { trunkSeq: 6, inputKey: KEY(6), epoch: 0 }),
	);
	ok(stale.kind === "refused" && stale.reason === "schema-changed");
	const wrongSchema = await s.f.applyRepoConfig(
		s.repo,
		applyInput(s, a, { trunkSeq: 6, inputKey: KEY(6), schemaKey: KEY(7) }),
	);
	ok(wrongSchema.kind === "refused" && wrongSchema.reason === "schema-changed");
});

// ---------------------------------------------------------------------------
// The binding rule
// ---------------------------------------------------------------------------

Deno.test("binding: revoke, a version change and a widened builtin each leave no unapproved row in force; a lost gate holds", async () => {
	const s = setup();
	await s.publish(NO_SECRETS("0.2.0"), NO_SECRETS_SETTINGS);
	await s.publish(NO_SECRETS("0.3.0"), NO_SECRETS_SETTINGS);
	await approve(s, "rawkode", "acme.no-secrets", "0.2.0", {
		severity: "hunk",
		allow: [],
	});
	const resolved = {
		extensions: {
			"acme.no-secrets": {
				enabled: true,
				mode: "enforce",
				settings: { severity: "hunk", allow: [] },
			},
		},
	};
	equal(
		(await s.f.applyRepoConfig(s.repo, applyInput(s, resolved))).kind,
		"applied",
	);
	const inForce = async () =>
		(await s.f.inForce(s.repo)).filter((i) =>
			i.installation.extId === "acme.no-secrets"
		);
	equal((await inForce()).length, 1);
	// A version change at the approval drops the 0.2.0 row at once.
	await approve(s, "rawkode", "acme.no-secrets", "0.3.0", {
		severity: "hunk",
		allow: [],
	});
	equal((await inForce()).length, 0);
	equal((await s.f.repoConfigState(s.repo))?.holdReason, "gate-missing");
	ok(s.pokes.length === 0, "pokes go out from the timer");
	await s.r.repoConfig.drainDirty();
	ok(s.pokes.some((p) => p.repo === s.repo));
	// Re-apply installs 0.3.0 and clears the hold.
	const again = await s.f.applyRepoConfig(
		s.repo,
		applyInput(s, resolved, { trunkSeq: 2, inputKey: KEY(2) }),
	);
	equal(again.kind, "applied");
	equal((await inForce())[0].installation.version, "0.3.0");
	equal((await s.f.repoConfigState(s.repo))?.holdReason, null);
	// Revoke.
	await s.f.revokeConfigApproval(OWNER, s.root, "acme.no-secrets");
	equal((await inForce()).length, 0);
	equal((await s.f.repoConfigState(s.repo))?.holdReason, "gate-missing");
	ok(s.fx.events.audits.some((a) => a.action === "repo-config.revoke"));
});

Deno.test("binding: grants come from the approval snapshot; a builtin that widens its permissions needs re-approval", async () => {
	const s = setup();
	const lint = bundled(manifest("tartan.lint", {
		permissions: { repo: "read" },
		config: { default: {}, cue: "config/settings.cue" },
	}));
	const LINT = { ...lint, settingsCue: "package settings\n\n#Settings: {}\n" };
	s.r.registerBuiltinsSync([LINT]);
	await approve(s, "rawkode", "tartan.lint", "0.1.0", {});
	const resolved = {
		extensions: {
			"tartan.lint": { enabled: true, mode: "enforce", settings: {} },
		},
	};
	equal(
		(await s.f.applyRepoConfig(s.repo, applyInput(s, resolved))).kind,
		"applied",
	);
	const row = async () =>
		(await s.f.inForce(s.repo)).find((i) =>
			i.installation.extId === "tartan.lint"
		);
	deepStrictEqual((await row())?.installation.grants, { repo: "read" });
	// Same permissions, new content: still bound (the sha moves in place).
	s.r.registerBuiltinsSync([{
		...LINT,
		protocol: undefined,
		migrations: [{ n: 1, name: "x", sql: "SELECT 1" }],
	}]);
	ok(await row(), "same permissions keep binding");
	// Widened permissions: the approval needs re-approval; the row drops out.
	const widened = bundled(manifest("tartan.lint", {
		permissions: { repo: "read", notify: true },
		config: { default: {}, cue: "config/settings.cue" },
	}));
	s.r.registerBuiltinsSync([{ ...widened, settingsCue: LINT.settingsCue }]);
	equal(await row(), undefined);
	const approvals = (await s.f.configApprovals(s.repo)).approvals;
	equal(approvals[0].needsReapproval, true);
	deepStrictEqual(await codes(s, resolved), ["unapproved"]);
});

Deno.test("binding: an Owner's disabled survives reconcile; a manual install above repo-config rows is refused", async () => {
	const s = setup();
	await s.publish(thirdParty("acme.labels", "1.0.0"));
	await approve(s, "rawkode", "acme.labels", "1.0.0", {});
	const resolved = {
		extensions: {
			"acme.labels": { enabled: true, mode: "enforce", settings: {} },
		},
	};
	await s.f.applyRepoConfig(s.repo, applyInput(s, resolved));
	const row = (await s.f.inForce(s.repo)).find((i) =>
		i.installation.extId === "acme.labels"
	)!;
	await rejectsWith(
		s.f.setMode(MAINT, row.installation.id, "disabled"),
		"denied",
	);
	await s.f.setMode(OWNER, row.installation.id, "disabled");
	const re = await s.f.applyRepoConfig(
		s.repo,
		applyInput(s, {
			extensions: {
				"acme.labels": { enabled: true, mode: "enforce", settings: { a: 1 } },
			},
		}, {
			trunkSeq: 2,
			inputKey: KEY(2),
		}),
	);
	equal(re.kind, "applied");
	const after = await s.f.installation(row.installation.id);
	equal(after?.mode, "disabled");
	equal(after?.ownerDisabled, true);
	await rejectsWith(
		s.f.install(OWNER, {
			extId: "acme.labels",
			version: "1.0.0",
			node: "rawkode",
			mode: "enforce",
		}),
		"conflict",
		/rawkode\/platform\/api/,
	);
});

// ---------------------------------------------------------------------------
// Overlay isolation
// ---------------------------------------------------------------------------

Deno.test("binding: a move or an archive (WP3 revalidates in its transaction) leaves no unbound row or overlay", async () => {
	const s = setup();
	await s.publish(thirdParty("acme.labels", "1.0.0"));
	await approve(s, "rawkode/platform", "acme.labels", "1.0.0", {});
	const weave = await s.f.install(OWNER, {
		extId: "tartan.weave",
		version: "0.1.0",
		node: "rawkode",
		mode: "enforce",
	});
	await s.f.setRepoOverrides(OWNER, weave.id, true);
	const resolved = {
		extensions: {
			"acme.labels": { enabled: true, mode: "enforce", settings: {} },
			"tartan.weave": { settings: { batch: 2 } },
		},
	};
	const inputFor = (repo: string, n: number): RepoConfigApplyInput => {
		const schema = s.r.repoConfig.schemaSync(repo);
		return {
			...applyInput(s, resolved, { trunkSeq: n, inputKey: KEY(n) }),
			epoch: schema.epoch,
			schemaKey: schema.schemaKey,
		};
	};
	equal(
		(await s.f.applyRepoConfig(s.repo, inputFor(s.repo, 1))).kind,
		"applied",
	);
	equal((await s.f.applyRepoConfig(s.web, inputFor(s.web, 1))).kind, "applied");
	const labels = async (repo: string) =>
		(await s.f.inForce(repo)).filter((i) =>
			i.installation.extId === "acme.labels"
		).length;
	const overlays = (repo: string) =>
		(s.fx.db.db.prepare(
			"SELECT COUNT(*) AS n FROM repo_config_overlays WHERE repo_node_id = ?",
		).get(repo) as { n: number }).n;
	equal(await labels(s.repo), 1);
	equal(overlays(s.repo), 1);
	const epoch = s.r.repoConfig.epochSync();
	// Move api from /rawkode/platform to /other: the approval at
	// /rawkode/platform and Weave at /rawkode are no longer above it.
	const other = s.fx.tree.node("other");
	s.fx.db.db.prepare(
		"UPDATE nodes SET path = 'other/api', parent_id = ?, depth = 1 WHERE id = ?",
	).run(other.id, s.repo);
	equal(s.r.internal.revalidateRepoConfigSync(OWNER, s.repo), 2);
	equal(await labels(s.repo), 0);
	equal(overlays(s.repo), 0);
	ok(s.r.repoConfig.epochSync() > epoch, "the schema epoch moves");
	ok(
		s.fx.events.events.some((e) =>
			e.type === "extension.uninstalled" && e.node === s.repo
		),
	);
	// Archive /rawkode/platform: its approval binds nothing below it.
	equal(await labels(s.web), 1);
	s.fx.db.db.prepare("UPDATE nodes SET archived_at = 1 WHERE path = ?").run(
		"rawkode/platform",
	);
	equal(s.r.internal.revalidateRepoConfigSync(OWNER, s.root), 1);
	equal(await labels(s.web), 0);
	// The overlay of an installation still above the repo stays.
	equal(overlays(s.web), 1);
});

Deno.test("overlay isolation: resolution is unchanged; only that repo's ExtensionDO sees the merged config", async () => {
	const s = setup();
	const weave = await s.f.install(OWNER, {
		extId: "tartan.weave",
		version: "0.1.0",
		node: "rawkode",
		mode: "enforce",
		config: { debounceMs: 500 },
	});
	await s.f.install(OWNER, {
		extId: "tartan.review",
		version: "0.1.0",
		node: "rawkode",
		mode: "enforce",
	});
	await s.f.setRepoOverrides(OWNER, weave.id, true);
	const shape = (list: Awaited<ReturnType<typeof s.f.inForce>>) => {
		const r = resolve(list);
		return {
			providers: [...r.providers.entries()].map((
				[k, v],
			) => [k, v.installation.id]),
			gates: r.gates.map((g) => g.installation.id),
			effective: r.effective.map((e) => e.installation.id),
			subscriptions: r.effective.flatMap((e) => e.manifest.subscribe ?? []).map(
				(x) => x.event,
			),
		};
	};
	const before = shape(await s.f.inForce(s.repo));
	const answer = await s.f.applyRepoConfig(
		s.repo,
		applyInput(s, {
			extensions: { "tartan.weave": { settings: { batch: 2 } } },
		}),
	);
	equal(answer.kind, "applied");
	deepStrictEqual(shape(await s.f.inForce(s.repo)), before);
	const here = await s.f.installationAt(weave.id, s.repo);
	deepStrictEqual(here?.config, { batch: 2, debounceMs: 500 });
	const there = await s.f.installationAt(weave.id, s.web);
	deepStrictEqual(there?.config, { batch: 4, debounceMs: 500 });
	deepStrictEqual((await s.f.installation(weave.id))?.config, {
		batch: 4,
		debounceMs: 500,
	});
	// Turning the opt-in off drops the overlay.
	await s.f.setRepoOverrides(OWNER, weave.id, false);
	deepStrictEqual((await s.f.installationAt(weave.id, s.repo))?.config, {
		batch: 4,
		debounceMs: 500,
	});
	const effective = await s.f.repoConfigEffective(s.repo);
	const w = effective.effective.find((e) => e.extId === "tartan.weave")!;
	equal(w.source, "inherited");
	deepStrictEqual(w.overridable, []);
});

// ---------------------------------------------------------------------------
// Repo policy and the kernel fields (ADR repo config)
// ---------------------------------------------------------------------------

Deno.test("repo policy: tartan.ci's pipeline and tartan.review's owners are allowed, install nothing and change nothing in resolution", async () => {
	const s = setup();
	await s.f.install(OWNER, {
		extId: "tartan.ci",
		version: "0.1.0",
		node: "rawkode",
		mode: "enforce",
	});
	await s.f.install(OWNER, {
		extId: "tartan.review",
		version: "0.1.0",
		node: "rawkode",
		mode: "enforce",
	});
	const resolved = {
		projects: { api: { root: "services/api", deps: [] } },
		global: ["package.json", "!pnpm-lock.yaml"],
		extensions: {
			"tartan.ci": {
				settings: { pipeline: { jobs: { test: { run: "pnpm test" } } } },
			},
			"tartan.review": {
				settings: {
					owners: { rules: [{ paths: ["services/api/**"], sensitivity: 2 }] },
				},
			},
		},
	};
	const check = await s.f.checkRepoConfig(s.repo, resolved);
	deepStrictEqual(check.denials, []);
	deepStrictEqual(check.plan, []);
	const before = resolve(await s.f.inForce(s.repo));
	const events = s.fx.events.events.length;
	const answer = await s.f.applyRepoConfig(s.repo, applyInput(s, resolved));
	equal(answer.kind, "applied");
	if (answer.kind === "applied") {
		deepStrictEqual(answer.changes, {
			installed: 0,
			updated: 0,
			removed: 0,
			overlays: 0,
		});
	}
	const after = resolve(await s.f.inForce(s.repo));
	deepStrictEqual(
		after.effective.map((e) => [e.installation.id, e.installation.config]),
		before.effective.map((e) => [e.installation.id, e.installation.config]),
	);
	equal(
		s.fx.events.events.slice(events).filter((e) =>
			e.type.startsWith("extension.")
		).length,
		0,
	);
	// tartan.ci's installation settings are not repo policy.
	deepStrictEqual(
		await codes(s, {
			extensions: { "tartan.ci": { settings: { image: "x" } } },
		}),
		["policy_key"],
	);
	// Mode on an in-force provider: inherited (K8 is the gate case).
	deepStrictEqual(
		await codes(s, { extensions: { "tartan.ci": { mode: "shadow" } } }),
		["inherited"],
	);
	// Not installed anywhere above: a provider is never an own install.
	const fresh = setup();
	deepStrictEqual(
		await codes(fresh, {
			extensions: { "tartan.ci": { settings: { pipeline: {} } } },
		}),
		["provider_floor"],
	);
});

Deno.test("repo policy: a manual install at the repo itself takes repo policy, and nothing else (conflict)", async () => {
	const s = setup();
	await s.f.install(OWNER, {
		extId: "tartan.ci",
		version: "0.1.0",
		node: "rawkode/platform/api",
		mode: "enforce",
	});
	deepStrictEqual(
		await codes(s, {
			extensions: { "tartan.ci": { settings: { pipeline: { jobs: {} } } } },
		}),
		[],
	);
	deepStrictEqual(
		await codes(s, { extensions: { "tartan.ci": { enabled: false } } }),
		["conflict"],
	);
	const schema = await s.f.repoConfigSchema(s.repo);
	deepStrictEqual(
		schema.entries.map((e) => [e.kind, e.extId, e.repoPolicy]),
		[["in-force", "tartan.ci", ["pipeline"]]],
	);
});

Deno.test("kernel fields: projects and global are strict and repo-relative", async () => {
	const s = setup();
	deepStrictEqual(
		await codes(s, {
			projects: { api: { root: "services/api", sensitive: true } },
			global: ["package.json", "!pnpm-lock.yaml"],
		}),
		[],
	);
	const bad: [unknown, string][] = [
		[{ projects: { api: { root: "../outside" } } }, 'projects."api".root'],
		[{ projects: { api: { root: "/abs" } } }, 'projects."api".root'],
		[{ projects: { api: { root: "a", extra: 1 } } }, 'projects."api".extra'],
		[{ projects: { "a b": { root: "a" } } }, 'projects."a b"'],
		[
			{ projects: { api: { root: "a", sensitive: "yes" } } },
			'projects."api".sensitive',
		],
		[{ projects: [] }, "projects"],
		[{ global: ["../x"] }, "global.0"],
		[{ global: "package.json" }, "global"],
	];
	for (const [resolved, path] of bad) {
		const answer = await s.f.checkRepoConfig(s.repo, resolved);
		deepStrictEqual(
			answer.denials.map((d) => [d.code, d.path]),
			[["shape", path]],
			JSON.stringify(resolved),
		);
	}
	const many = Object.fromEntries(
		Array.from({ length: 501 }, (_, i) => [`p${i}`, { root: `p/${i}` }]),
	);
	deepStrictEqual(await codes(s, { projects: many }), ["shape"]);
});

Deno.test("own install: repo-policy keys of an own install are read at a base, never installed", async () => {
	const s = setup();
	await s.publish(
		thirdParty("acme.policy", "1.0.0", {
			config: {
				default: { level: 1 },
				cue: "config/settings.cue",
				repoPolicy: ["rules"],
			},
		}),
		"package settings\n\n#Settings: {level: int | *1}\n#Policy: {rules?: [...string]}\n",
	);
	await approve(s, "rawkode", "acme.policy", "1.0.0", { level: 1 });
	const resolved = {
		extensions: {
			"acme.policy": {
				enabled: true,
				mode: "enforce",
				settings: { level: 2, rules: ["a"] },
			},
		},
	};
	const answer = await s.f.applyRepoConfig(s.repo, applyInput(s, resolved));
	equal(answer.kind, "applied");
	const row = (await s.f.inForce(s.repo)).find((i) =>
		i.installation.extId === "acme.policy"
	)!;
	deepStrictEqual(row.installation.config, { level: 2 });
	const schema = await s.f.repoConfigSchema(s.repo);
	ok(
		schema.files["cue.mod/pkg/tartan.dev/ext/ext.cue"].includes(
			'"acme.policy"?: #Own & {settings: {x_acme_policy.#Settings, x_acme_policy.#Policy}}',
		),
	);
});

Deno.test("self-check per package version: a checked version approves at once; an unchecked one in force is checked lazily; builtins are checked", async () => {
	const s = setup();
	await s.publish(thirdParty("acme.labels", "1.0.0"));
	// No config.cue: nothing to check, approval commits at once.
	const labels = await s.f.requestConfigApproval(OWNER, s.root, "acme.labels", {
		version: "1.0.0",
	});
	equal(labels.state, "approved");
	equal(s.jobs.length, 0);
	await s.publish(NO_SECRETS("0.2.0"), NO_SECRETS_SETTINGS);
	await approve(s, "rawkode", "acme.no-secrets", "0.2.0", {
		severity: "hunk",
		allow: [],
	});
	// A second approval of the same version elsewhere needs no new check.
	const jobs = s.jobs.length;
	const again = await s.f.requestConfigApproval(
		OWNER,
		s.fx.tree.node("rawkode/platform").id,
		"acme.no-secrets",
		{ version: "0.2.0" },
	);
	equal(again.state, "approved");
	equal(s.jobs.length, jobs);
	// A third-party package with repo policy, installed manually above the
	// repo: absent from the schema until its self-check passes.
	await s.publish(
		thirdParty("acme.lint", "1.0.0", {
			config: {
				default: {},
				cue: "config/settings.cue",
				repoPolicy: ["rules"],
			},
		}),
		"package settings\n\n#Settings: {}\n#Policy: {rules?: [...string]}\n",
	);
	await s.f.install(OWNER, {
		extId: "acme.lint",
		version: "1.0.0",
		node: "rawkode",
		mode: "enforce",
	});
	const unchecked = await s.f.repoConfigSchema(s.repo);
	ok(!unchecked.entries.some((e) => e.extId === "acme.lint"));
	deepStrictEqual(
		s.r.repoConfig.uncheckedSync(s.repo).map((p) => p.extId),
		["acme.lint"],
	);
	equal(await s.r.repoConfig.ensureChecks(s.repo), 1);
	equal(await s.r.repoConfig.ensureChecks(s.repo), 0, "deduplicated");
	const job = s.jobs[s.jobs.length - 1];
	equal(job.class, "selfcheck");
	const requestId = (job.sink as { requestId: string }).requestId;
	const epoch = s.r.repoConfig.epochSync();
	await s.f.selfCheckResult(
		requestId,
		okEnvelope({
			extensions: {
				"acme.lint": { enabled: true, mode: "enforce", settings: {} },
			},
		}),
	);
	ok(
		s.r.repoConfig.epochSync() > epoch,
		"the package joins the schema: a new epoch",
	);
	const checked = await s.f.repoConfigSchema(s.repo);
	deepStrictEqual(
		checked.entries.filter((e) => e.extId === "acme.lint").map((e) => [
			e.kind,
			e.repoPolicy,
		]),
		[["in-force", ["rules"]]],
	);
	// Bundled packages with a config.cue are checked at registration.
	deepStrictEqual(s.r.repoConfig.uncheckedSync(s.repo), []);
});

// ---------------------------------------------------------------------------
// The Owner's kill switch, schema names, the watch set, evaluator upgrades
// ---------------------------------------------------------------------------

Deno.test("binding: the Owner's disabled survives removing and re-adding the entry and a version change", async () => {
	const s = setup();
	await s.publish(thirdParty("acme.labels", "1.0.0"));
	await s.publish(thirdParty("acme.labels", "1.1.0"));
	await approve(s, "rawkode", "acme.labels", "1.0.0", {});
	const entry = {
		extensions: {
			"acme.labels": { enabled: true, mode: "enforce", settings: {} },
		},
	};
	let seq = 1;
	const apply = async (resolved: unknown) =>
		await s.f.applyRepoConfig(
			s.repo,
			applyInput(s, resolved, { trunkSeq: seq, inputKey: KEY(seq++) }),
		);
	/** The repo-config row at the repo (in force or disabled). */
	const labels = async () => {
		const row = s.fx.db.sql.exec<{ id: string }>(
			"SELECT id FROM installations WHERE node_id = ? AND ext_id = 'acme.labels'",
			s.repo,
		).toArray()[0];
		return row === undefined
			? undefined
			: { installation: (await s.f.installation(row.id))! };
	};
	equal((await apply(entry)).kind, "applied");
	await s.f.setMode(OWNER, (await labels())!.installation.id, "disabled");
	// A Maintainer-signed config without the entry, then with it again.
	equal((await apply({})).kind, "applied");
	equal(await labels(), undefined);
	const back = await apply(entry);
	equal(back.kind, "applied");
	equal((await labels())?.installation.mode, "disabled");
	equal((await labels())?.installation.ownerDisabled, true);
	ok(
		!(await s.f.inForce(s.repo)).some((i) =>
			i.installation.extId === "acme.labels"
		),
		"not in force",
	);
	const plan = (await s.f.checkRepoConfig(s.repo, entry)).plan;
	ok(plan.every((l) => l.op !== "install"), JSON.stringify(plan));
	// An Owner re-approves another version: the re-install comes back disabled.
	await approve(s, "rawkode", "acme.labels", "1.1.0", {});
	equal(await labels(), undefined, "1.0.0 dropped by the version change");
	equal((await apply(entry)).kind, "applied");
	equal((await labels())?.installation.version, "1.1.0");
	equal((await labels())?.installation.mode, "disabled");
	// Only an Owner clears it.
	await s.f.setMode(OWNER, (await labels())!.installation.id, "enforce");
	equal((await apply({})).kind, "applied");
	equal((await apply(entry)).kind, "applied");
	equal((await labels())?.installation.mode, "enforce");
});

Deno.test("schema names: publish refuses an id whose sid another id has; a pair that exists anyway never fails the schema", async () => {
	const s = setup();
	await s.publish(thirdParty("acme.no-secrets", "1.0.0"));
	await rejectsWith(
		s.publish(thirdParty("acme.no.secrets", "1.0.0")),
		"conflict",
		/acme_no_secrets/,
	);
	const generated = generateSchema({
		installs: [
			{
				extId: "acme.no.secrets",
				version: "1.0.0",
				settingsCue: null,
				approvalNode: s.root,
				hasGates: false,
				repoPolicy: [],
			},
			{
				extId: "acme.no-secrets",
				version: "1.0.0",
				settingsCue: null,
				approvalNode: s.root,
				hasGates: false,
				repoPolicy: [],
			},
		],
		inForce: [],
	});
	deepStrictEqual(generated.entries.map((e) => e.extId), ["acme.no-secrets"]);
});

Deno.test("watch set: a repo whose RepoDO evaluated trunk config is poked after a registry change with nothing applied", async () => {
	const s = setup();
	await s.f.repoConfigSchema(s.web);
	await s.f.repoConfigSchema(s.repo, { watch: true });
	await s.publish(thirdParty("acme.labels", "1.0.0"));
	await approve(s, "rawkode", "acme.labels", "1.0.0", {});
	await s.r.repoConfig.drainDirty();
	deepStrictEqual(s.pokes.map((p) => p.repo), [s.repo]);
});

Deno.test("switch-on: the first deploy with repository config on moves the epoch once, so watched repos are poked", () => {
	const s = setup();
	const env = s.fx.deps.env as unknown as Record<string, string>;
	const epoch = s.r.repoConfig.epochSync();
	s.r.registerBuiltinsSync(PKGS);
	equal(s.r.repoConfig.epochSync(), epoch, "off: no change");
	env.TARTAN_REPO_CONFIG = "on";
	s.r.registerBuiltinsSync(PKGS);
	equal(s.r.repoConfig.epochSync(), epoch + 1, "switched on: one bump");
	s.r.registerBuiltinsSync(PKGS);
	equal(s.r.repoConfig.epochSync(), epoch + 1, "still on: no change");
	env.TARTAN_REPO_CONFIG = "off";
	s.r.registerBuiltinsSync(PKGS);
	env.TARTAN_REPO_CONFIG = "on";
	s.r.registerBuiltinsSync(PKGS);
	equal(s.r.repoConfig.epochSync(), epoch + 2, "on again: one more bump");
});

Deno.test("evaluator upgrade: a published package's self-check is redone on the new evaluator before it rejoins schemas", async () => {
	const s = setup();
	await s.publish(
		thirdParty("acme.lint", "1.0.0", {
			config: {
				default: {},
				cue: "config/settings.cue",
				repoPolicy: ["rules"],
			},
		}),
		"package settings\n\n#Settings: {}\n#Policy: {rules?: [...string]}\n",
	);
	await s.f.install(OWNER, {
		extId: "acme.lint",
		version: "1.0.0",
		node: "rawkode",
		mode: "enforce",
	});
	equal(await s.r.repoConfig.ensureChecks(s.repo), 1);
	const pass = async () => {
		const job = s.jobs[s.jobs.length - 1];
		await s.f.selfCheckResult(
			(job.sink as { requestId: string }).requestId,
			okEnvelope({
				extensions: {
					"acme.lint": { enabled: true, mode: "enforce", settings: {} },
				},
			}),
		);
	};
	await pass();
	const inSchema = async () =>
		(await s.f.repoConfigSchema(s.repo)).entries.some((e) =>
			e.extId === "acme.lint"
		);
	ok(await inSchema(), "checked on this evaluator");
	// A deploy upgrades CUE (a new evaluator id).
	s.fx.db.sql.exec(
		"UPDATE meta SET v = 'cue@v0.16.0/cli+job@1+rules@1' WHERE k = 'config_evaluator'",
	);
	s.r.registerBuiltinsSync(PKGS);
	ok(!(await inSchema()), "absent until it passes on the new evaluator");
	deepStrictEqual(
		s.r.repoConfig.uncheckedSync(s.repo).map((p) => p.extId),
		["acme.lint"],
	);
	s.fx.now += 11 * 60_000;
	equal(await s.r.repoConfig.ensureChecks(s.repo), 1);
	await pass();
	ok(await inSchema());
	// Bundled packages keep their check.
	deepStrictEqual(s.r.repoConfig.uncheckedSync(s.repo), []);
});

Deno.test("repo policy: a gate's repo policy below its ancestor install needs the Owner's opt-in; the bundled CI and review do not", async () => {
	const s = setup();
	await s.publish(
		thirdParty("acme.secrets", "1.0.0", {
			gates: [{ point: "ref.advance" }],
			config: {
				default: {},
				cue: "config/settings.cue",
				repoPolicy: ["allow"],
			},
		}),
		"package settings\n\n#Settings: {}\n#Policy: {allow?: [...string]}\n",
	);
	const gate = await s.f.install(OWNER, {
		extId: "acme.secrets",
		version: "1.0.0",
		node: "rawkode",
		mode: "enforce",
	});
	const resolved = {
		extensions: { "acme.secrets": { settings: { allow: ["**"] } } },
	};
	const denied = await s.f.checkRepoConfig(s.repo, resolved);
	deepStrictEqual(denied.denials.map((d) => d.code), ["policy_key"]);
	ok(denied.denials[0].message.includes("repo overrides"));
	await s.f.setRepoOverrides(OWNER, gate.id, true);
	deepStrictEqual(
		(await s.f.checkRepoConfig(s.repo, resolved)).denials,
		[],
		"the Owner opted in",
	);
	// The bundled review (a review@1 provider with gates) keeps its owners policy.
	await s.f.install(OWNER, {
		extId: "tartan.review",
		version: "0.1.0",
		node: "rawkode",
		mode: "enforce",
	});
	const review = await s.f.checkRepoConfig(s.repo, {
		extensions: {
			"tartan.review": { settings: { owners: { rules: [] } } },
		},
	});
	deepStrictEqual(review.denials, []);
});

Deno.test("evaluator upgrade: a deploy with another evaluator id moves the epoch once", () => {
	const s = setup();
	const epoch = s.r.repoConfig.epochSync();
	s.r.registerBuiltinsSync(PKGS);
	equal(s.r.repoConfig.epochSync(), epoch, "the same evaluator: no change");
	s.fx.db.sql.exec(
		"UPDATE meta SET v = 'cue@v0.17.0/cli+job@1+rules@1' WHERE k = 'config_evaluator'",
	);
	s.r.registerBuiltinsSync(PKGS);
	equal(s.r.repoConfig.epochSync(), epoch + 1);
	equal(s.r.repoConfig.epochBySync(), "sys_kernel");
});
