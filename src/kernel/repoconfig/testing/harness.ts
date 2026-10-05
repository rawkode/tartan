// Test-only (Deno): the RepoDO `repoconfig` module on the node:sqlite fake,
// wired to the REAL ForgeDO registry (WP7a's module with repo config, on its
// own fake database) for schema, check, fenced apply and state, to in-memory
// git repos for reads, and to a fake `cueSubmit` whose envelopes the test
// decides (a fake evaluator). `trunk(files)` moves trunk and records the
// commit in `trunk_commits` (WP5a's table, which the module reads) at the
// next seq. Never imported by runtime code.

import {
	CUE_EVAL_CONTRACT,
	CUE_EVALUATOR_ID,
	type CueJobInput,
	type CueSubmitResult,
	type Envelope,
	type EvalResponse,
	type Manifest,
	repoArtifactsName,
} from "@tartan/contract";
import type {
	LaneRow,
	ModuleDeps,
	RepoInternals,
	TimerHandler,
} from "@tartan/contract/kernel.ts";
import { settingsCue as ciSettings } from "../../../../extensions/ci/src/settings-cue.ts";
import { settingsCue as reviewSettings } from "../../../../extensions/review/src/settings-cue.ts";
import { settingsCue as weaveSettings } from "../../../../extensions/weave/src/settings-cue.ts";
import type { Env } from "../../../env.ts";
import { createRegistry } from "../../exthost/registry/module.ts";
import { REGISTRY_MIGRATIONS } from "../../exthost/registry/schema.ts";
import {
	bundled,
	manifest,
	registryFixture,
} from "../../exthost/registry/test/fakes.ts";
import { createFakeStorage } from "../../repo/testing/sqlite.ts";
import { createRepoConfig } from "../module.ts";
import type { RepoConfigModulePorts } from "../ports.ts";
import { REPO_CONFIG_MIGRATIONS } from "../schema.ts";
import { NO_SECRETS_SETTINGS } from "./corpus.ts";
import { createTestRepo, type TestRepo } from "./git.ts";

export const OWNER = "u_01k6ffffffffffffffffffffff";
export const MAINT = "u_01k6mmmmmmmmmmmmmmmmmmmmmm";
export const AGENT = "a_01k6eeeeeeeeeeeeeeeeeeeeee";

const WEAVE = {
	...bundled(manifest("tartan.weave", {
		provides: ["queue@1"],
		permissions: { land: ["refs/heads/main"] },
		config: {
			default: { batch: 4, debounceMs: 2000 },
			cue: "config/settings.cue",
			repoOverridable: ["batch", "debounceMs"],
		},
	})),
	settingsCue: weaveSettings,
};

const CI = {
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

const REVIEW = {
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

export const okEnvelope = (value: unknown): EvalResponse => ({
	version: CUE_EVAL_CONTRACT,
	evaluator: CUE_EVALUATOR_ID,
	cueVersion: "v0.17.1",
	ok: value,
	issues: [],
});

export const errorEnvelope = (
	code: "BUILD_VALUE" | "TIMEOUT" | "EVALUATOR_UNAVAILABLE" | "LIMIT_EXCEEDED",
	message = "x: conflicting values",
): EvalResponse => ({
	version: CUE_EVAL_CONTRACT,
	evaluator: CUE_EVALUATOR_ID,
	cueVersion: code === "EVALUATOR_UNAVAILABLE" ? null : "v0.17.1",
	error: { code, message },
	issues: code === "BUILD_VALUE"
		? [{ path: "x", msg: message, pos: ["tartan.cue:3:1"] }]
		: [],
});

export type SubmitMode = "accept" | "unavailable" | "hang";

export type Harness = ReturnType<typeof createRepoConfigHarness> extends
	Promise<infer H> ? H : never;

export const createRepoConfigHarness = async (
	options: {
		readonly budgetMs?: number;
		/** `TARTAN_REPO_CONFIG` (default on); `switch` reads it on every call. */
		readonly enabled?: boolean;
	} = {},
) => {
	const toggle = { on: options.enabled ?? true };
	// ForgeDO: the real registry.
	const forge = registryFixture(REGISTRY_MIGRATIONS, OWNER);
	forge.tree.add("rawkode", "group");
	forge.tree.add("rawkode/platform", "group");
	const repoNode = forge.tree.add("rawkode/platform/api", "repo");
	forge.tree.grant("rawkode", MAINT, 40);
	const registryJobs: CueJobInput[] = [];
	const registry = createRegistry(forge.deps, {
		builtins: () => [WEAVE, CI, REVIEW],
		repoConfigPorts: () => ({
			submit: (job) => {
				registryJobs.push(job);
				return Promise.resolve({
					accepted: true,
					jobId: "cj_r",
					warm: true,
					ahead: 0,
					joined: false,
				});
			},
			poke: () => Promise.resolve(),
			waitUntil: () => {},
			log: () => {},
		}),
	});
	registry.registerBuiltinsSync([WEAVE, CI, REVIEW]);
	const r = registry.facade;
	const publish = async (m: Record<string, unknown>, configCue?: string) =>
		await r.publish(OWNER, m as unknown as Manifest, {
			sha256: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
			r2Prefix: `ext/${m.id}/${m.version}`,
			...(configCue === undefined ? {} : { configCue }),
		});
	await publish({
		schema: 1,
		id: "acme.no-secrets",
		name: "no secrets",
		version: "0.2.0",
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
	}, NO_SECRETS_SETTINGS);
	const approval = await r.requestConfigApproval(
		OWNER,
		forge.tree.node("rawkode").id,
		"acme.no-secrets",
		{ version: "0.2.0" },
	);
	await r.selfCheckResult(
		approval.id,
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
	const weave = await r.install(OWNER, {
		extId: "tartan.weave",
		version: "0.1.0",
		node: "rawkode",
		mode: "enforce",
	});
	await r.setRepoOverrides(OWNER, weave.id, true);
	// tartan.ci and tartan.review in force above the repo: repo policy.
	await r.install(OWNER, {
		extId: "tartan.ci",
		version: "0.1.0",
		node: "rawkode",
		mode: "enforce",
	});
	await r.install(OWNER, {
		extId: "tartan.review",
		version: "0.1.0",
		node: "rawkode",
		mode: "enforce",
	});

	// RepoDO: the module under test.
	const repoId = repoNode.id;
	const storage = createFakeStorage();
	storage.db.exec(
		"CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
	);
	storage.db.exec(
		`CREATE TABLE IF NOT EXISTS trunk_commits (sha TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE,
  source TEXT NOT NULL)`,
	);
	for (const m of REPO_CONFIG_MIGRATIONS) storage.db.exec(m.sql);
	let now = 1_000_000;
	const clock = { now: () => now };
	const scheduled = new Map<string, number>();
	// The WP0 timers API upserts (the last write wins), as src/do/timers.ts.
	const timers = {
		schedule: (key: string, at: number) => {
			scheduled.set(key, at);
		},
		cancel: (key: string) => void scheduled.delete(key),
		get: (key: string) => scheduled.get(key) ?? null,
	};
	const canonical = createTestRepo();
	const laneRepos = new Map<string, TestRepo>();
	const lanes = new Map<string, LaneRow>();
	const refs = new Map<string, string>();
	const events: Envelope[] = [];
	let seq = 0;
	const meta: Record<string, string> = {
		repo_id: repoId,
		node_id: repoId,
		artifacts_name: repoArtifactsName(repoId),
		default_branch: "main",
	};
	const core = {
		metaSync: (k: string) => meta[k] ?? null,
		laneSync: (id: string) => lanes.get(id) ?? null,
		refSync: (ref: string) => {
			const sha = refs.get(ref);
			return sha === undefined ? null : { ref, sha } as never;
		},
	};
	const eventsInternal = {
		appendSync: (input: Record<string, unknown>) => {
			seq += 1;
			const envelope = {
				...input,
				id: `0${seq.toString().padStart(25, "0")}`,
				seq,
				at: now,
			} as unknown as Envelope;
			events.push(envelope);
			module.internal.observeSync(envelope);
			return { id: envelope.id, seq, hash: "h", created: true };
		},
	};
	const jobs: { sandbox: string; job: CueJobInput }[] = [];
	const control: {
		mode: SubmitMode;
		readsHang: boolean;
		/** ForgeDO's dry-run check or fenced apply never answers (a slow ForgeDO). */
		checkHang: boolean;
		applyHang: boolean;
		/** Runs after ForgeDO answered a schema read, before the module sees it. */
		afterSchema?: (epoch: number) => void | Promise<void>;
		/** Jobs queued ahead of an accepted submit. */
		ahead: number;
		evaluate: (job: CueJobInput) => EvalResponse;
	} = {
		mode: "accept",
		readsHang: false,
		checkHang: false,
		applyHang: false,
		ahead: 0,
		evaluate: () => okEnvelope({ extensions: {} }),
	};
	const notices: { principal: string; text: string }[] = [];
	const ports: RepoConfigModulePorts = {
		reads: (name) => {
			if (control.readsHang) return new Promise(() => {});
			const repo = name === meta.artifacts_name
				? canonical
				: laneRepos.get(name);
			if (repo === undefined) {
				return Promise.reject(new Error(`no repo ${name}`));
			}
			return Promise.resolve({ ...repo.reads, close: () => {} });
		},
		schema: async (id, options) => {
			const schema = await r.repoConfigSchema(id, options);
			await control.afterSchema?.(schema.epoch);
			return schema;
		},
		check: (id, resolved) =>
			control.checkHang
				? new Promise(() => {})
				: r.checkRepoConfig(id, resolved),
		apply: (id, input) =>
			control.applyHang ? new Promise(() => {}) : r.applyRepoConfig(id, input),
		forgeState: (id) => r.repoConfigState(id),
		submit: (sandbox, job): Promise<CueSubmitResult> => {
			jobs.push({ sandbox, job });
			if (control.mode === "unavailable") {
				return Promise.resolve({
					accepted: false,
					reason: "unavailable",
					message: "containers are not enabled",
				});
			}
			if (control.mode === "hang") return new Promise(() => {});
			return Promise.resolve({
				accepted: true,
				jobId: `cj_${jobs.length}`,
				warm: true,
				ahead: control.ahead,
				joined: false,
			});
		},
		notify: (principal, notice) => {
			notices.push({ principal, text: notice.text });
			return Promise.resolve();
		},
		owners: () => Promise.resolve([OWNER]),
		log: () => {},
	};
	const deps = {
		sql: storage.sql,
		storage: storage as unknown as DurableObjectStorage,
		ctx: { waitUntil: () => {} } as unknown as DurableObjectState,
		env: {
			get TARTAN_REPO_CONFIG() {
				return toggle.on ? "on" : "off";
			},
		} as unknown as Env,
		modules: {
			core,
			events: eventsInternal,
		} as unknown as RepoInternals,
		timers,
		clock,
		ids: { ulid: () => crypto.randomUUID() },
	} as unknown as ModuleDeps<Env, RepoInternals>;
	const module = createRepoConfig(deps, {
		ports: () => ports,
		...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
	});
	const onTimer = module.onTimer as TimerHandler;
	// The switch is on from the repo's start (no trunk yet): no transition
	// later. Tests of the transition start the harness off.
	if (toggle.on) module.internal.enabledSync();

	/** Runs every due timer (in key order) until none is due. */
	const runTimers = async (max = 20): Promise<string[]> => {
		const ran: string[] = [];
		for (let i = 0; i < max; i++) {
			const due = [...scheduled.entries()].filter(([, at]) => at <= now)
				.map(([k]) => k);
			if (due.length === 0) break;
			for (const key of due) {
				scheduled.delete(key);
				await onTimer(key);
				ran.push(key);
			}
		}
		return ran;
	};

	/** Delivers every submitted job's envelope (the fake evaluator). */
	const deliver = async (
		filter: (j: { sandbox: string; job: CueJobInput }) => boolean = () => true,
	): Promise<number> => {
		const all = jobs.splice(0);
		const pending = all.filter(filter);
		// Jobs the filter holds back stay submitted (delivered later).
		jobs.push(...all.filter((j) => !filter(j)));
		for (const j of pending) {
			// The answering sandbox's role travels with the result.
			await module.facade.cueResult(
				j.job.request.inputKey,
				control.evaluate(j.job),
				j.sandbox === "cue:trunk" ? "trunk" : "preview",
			);
		}
		return pending.length;
	};

	const advance = (ms: number) => {
		now += ms;
	};

	/** Moves trunk to a commit of `files` (the canonical repo), at the next trunk seq. */
	const trunk = (files: Record<string, string>, parents: string[] = []) => {
		const sha = canonical.commit(files, parents);
		refs.set("refs/heads/main", sha);
		storage.sql.exec(
			`INSERT OR IGNORE INTO trunk_commits (sha, seq, source)
			 VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM trunk_commits), 'advance')`,
			sha,
		);
		return sha;
	};

	/** The `trunk_commits.seq` of a commit, or null. */
	const seqOf = (sha: string): number | null =>
		(storage.sql.exec<{ seq: number }>(
			"SELECT seq FROM trunk_commits WHERE sha = ?",
			sha,
		).toArray()[0]?.seq ?? null) as number | null;

	/** The trunk config history, newest first. */
	const trunkRows = () =>
		storage.sql.exec<Record<string, SqlStorageValue>>(
			"SELECT * FROM config_trunk ORDER BY trunk_seq DESC",
		).toArray();

	const addLane = (
		id: string,
		files: Record<string, string>,
		owner = AGENT,
	): string => {
		const sha = canonical.commit(files);
		lanes.set(id, {
			id,
			mode: "branch",
			repo_name: null,
			owner_principal: owner,
			head_sha: sha,
			base_sha: sha,
		} as unknown as LaneRow);
		return sha;
	};

	const head = () =>
		storage.sql.exec<Record<string, SqlStorageValue>>(
			"SELECT * FROM config_head WHERE id = 1",
		).toArray()[0] ?? null;

	return {
		forge,
		registry: r,
		registryJobs,
		repoId,
		module,
		facade: module.facade,
		internal: module.internal,
		storage,
		events,
		jobs,
		control,
		notices,
		scheduled,
		canonical,
		laneRepos,
		lanes,
		refs,
		runTimers,
		deliver,
		advance,
		trunk,
		seqOf,
		trunkRows,
		addLane,
		head,
		now: () => now,
		/** Turns `TARTAN_REPO_CONFIG` on or off (a redeploy). */
		setEnabled: (on: boolean) => {
			toggle.on = on;
		},
	};
};
