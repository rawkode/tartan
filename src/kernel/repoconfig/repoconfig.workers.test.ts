/// <reference types="@cloudflare/vitest-pool-workers/types" />
// Repository config in workerd (vitest project `repo`; ADR repo config,
// "Testing"). A RepoDO host on real Durable Object SQLite with
// every RepoDO module, reading real git objects from the pool's fake
// Artifacts and calling the REAL ForgeDO registry over RPC for the schema,
// the dry-run check and the fenced apply. Only `cueSubmit` is replaced: the
// pool's TartanSandbox has no container, so the test plays the evaluator
// and delivers each envelope through the `cueResult` sink, as the sandbox
// does. The host's alarms are driven by hand with a fixed clock, so the
// RepoDO instance's own alarm never runs these timers.
//
// Covers: the trunk loop (an Advance in its own transaction, the K13.1
// hold, the fenced apply, repo policy at a trunk commit), a trunk move
// outside the Advance (`needs-apply`, an explicit apply), previews never
// applying (K13), the kernel sign-off bound to a head and its root `*.cue`
// digest with its event in the same transaction, migrations, and timers
// that never await an evaluation.

import { runInDurableObject } from "cloudflare:test";
import {
	CUE_EVAL_CONTRACT,
	CUE_EVALUATOR_ID,
	type CueJobInput,
	type CueSubmitResult,
	type EvalResponse,
	FORGE_DO_NAME,
	fromRpcError,
	type Lane,
	repoArtifactsName,
	type RepoConfigPreviewDto,
	ulid,
} from "@tartan/contract";
import type {
	ModuleDeps,
	RegistryFacade,
	RepoInternals,
	RepoStore,
} from "@tartan/contract/kernel.ts";
import { afterAll, describe, expect, it } from "vitest";
import {
	settleBackground,
	testEnv as env,
	uniqueName,
} from "../../../test/env.ts";
import type { Env } from "../../env.ts";
import { createDoHost } from "../../do/host.ts";
import { REPO_COMMON, REPO_MODULES } from "../../do/repo.ts";
import { createRepoConfigModule } from "./module.ts";
import { envRepoConfigPorts, type RepoConfigModulePorts } from "./ports.ts";

const OWNER = "u_01k6ffffffffffffffffffffff";
const AGENT = "a_01k6eeeeeeeeeeeeeeeeeeeeee";

/** The pool fake's test-only RPC (never called by product code). */
type FakeArtifactsRpc = RepoStore & {
	seed(
		name: string,
		options: { files: Record<string, string> },
	): Promise<{ head: string | null }>;
	commit(
		name: string,
		ref: string,
		changes: Record<string, string | null>,
		message: string,
	): Promise<string>;
};
const artifacts = env.ARTIFACTS as unknown as FakeArtifactsRpc;

const registry = () =>
	// Typed through the contract facade (the RPC stub types are too deep).
	env.FORGE.getByName(FORGE_DO_NAME).registry() as unknown as RegistryFacade;

const weaveCue = (batch: number) =>
	`package tartan\n\nextensions: "tartan.weave": settings: batch: ${batch}\n`;
const CI_CUE =
	'package tartan\n\nextensions: "tartan.ci": settings: pipeline: jobs: test: run: "pnpm test"\n';
const CUENV = 'package cuenv\n\nenv: NODE_ENV: "test"\n';

const PIPELINE = { jobs: { test: { run: "pnpm test" } } };
const resolvedFor = (batch: number) => ({
	extensions: {
		"tartan.weave": { settings: { batch } },
		"tartan.ci": { settings: { pipeline: PIPELINE } },
	},
});

const okEnvelope = (value: unknown): EvalResponse => ({
	version: CUE_EVAL_CONTRACT,
	evaluator: CUE_EVALUATOR_ID,
	cueVersion: "v0.17.1",
	ok: value,
	issues: [],
});

/**
 * The forge side, in the real singleton ForgeDO: a root group owned by
 * OWNER with Weave (repo overrides on), tartan.ci and tartan.review in
 * force, and a repo node below it (inserted the way WP3 writes one: the
 * pool cannot run the genesis push), with its Artifacts repo seeded with
 * real git objects.
 */
const world = async (files: Record<string, string>) => {
	const forge = env.FORGE.getByName(FORGE_DO_NAME);
	const root = await forge.tree().createRoot({
		kind: "group",
		slug: `rc-${ulid().slice(-10)}`,
		owner: OWNER,
	});
	const weave = await registry().install(OWNER, {
		extId: "tartan.weave",
		version: "0.1.0",
		node: root.path,
		mode: "enforce",
	});
	await registry().setRepoOverrides(OWNER, weave.id, true);
	for (const extId of ["tartan.ci", "tartan.review"]) {
		await registry().install(OWNER, {
			extId,
			version: "0.1.0",
			node: root.path,
			mode: "enforce",
		});
	}
	const repoId = ulid();
	const path = `${root.path}/api`;
	await runInDurableObject(forge, (_instance, state) => {
		state.storage.sql.exec(
			`INSERT INTO nodes (id, parent_id, kind, slug, path, depth, artifacts_name, default_branch, created_by, created_at)
			 VALUES (?, ?, 'repo', 'api', ?, 1, ?, 'main', ?, ?)`,
			repoId,
			root.id,
			path,
			repoArtifactsName(repoId),
			OWNER,
			Date.now(),
		);
	});
	const seeded = await artifacts.seed(repoArtifactsName(repoId), { files });
	return { root, weave, repoId, path, trunk: seeded.head as string };
};

type SubmitMode = "accept" | "hang";

/**
 * A RepoDO host on `state`'s SQLite: every RepoDO module, repoconfig with
 * the Worker's ports except `cueSubmit`. Alarm calls are no-ops (the test
 * runs due timers with `run()`), and the clock only moves when told.
 */
const repoHost = async (
	state: DurableObjectState,
	options: { readonly budgetMs?: number } = {},
) => {
	let now = Date.now();
	const jobs: { sandbox: string; job: CueJobInput }[] = [];
	const control: { mode: SubmitMode } = { mode: "accept" };
	const noAlarms = new Proxy(state.storage, {
		get: (target, prop) => {
			if (prop === "setAlarm" || prop === "deleteAlarm") {
				return () => Promise.resolve();
			}
			if (prop === "getAlarm") return () => Promise.resolve(null);
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const ctx = new Proxy(state, {
		get: (target, prop) => {
			if (prop === "storage") return noAlarms;
			if (prop === "blockConcurrencyWhile") {
				return <T>(fn: () => Promise<T>) => fn();
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const ticks: number[] = [];
	const host = createDoHost({
		kind: "repo-test",
		ctx,
		env,
		clock: { now: () => now },
		log: () => {},
		modules: {
			...REPO_MODULES,
			repoconfig: createRepoConfigModule({
				...(options.budgetMs === undefined
					? {}
					: { budgetMs: options.budgetMs }),
				ports: (deps: ModuleDeps<Env, RepoInternals>) => ({
					...envRepoConfigPorts(deps.env),
					log: () => {},
					submit: (
						sandbox: string,
						job: CueJobInput,
					): Promise<CueSubmitResult> => {
						jobs.push({ sandbox, job });
						if (control.mode === "hang") return new Promise(() => {});
						return Promise.resolve({
							accepted: true,
							jobId: `cj_${jobs.length}`,
							warm: true,
							ahead: 0,
							joined: false,
						});
					},
				} satisfies RepoConfigModulePorts),
			}),
			// A co-due timer of another module (the timers test).
			tick: {
				name: "tick",
				range: [900, 909] as const,
				migrations: [],
				create: () => ({
					facade: {},
					internal: {},
					onTimer: () => {
						ticks.push(now);
						return Promise.resolve();
					},
				}),
			},
		},
		common: REPO_COMMON,
	});
	await host.ready;
	const sql = state.storage.sql;
	/** Runs every due timer until none is due. */
	const run = async (rounds = 12): Promise<void> => {
		for (let i = 0; i < rounds; i++) {
			const due = sql.exec<{ n: number }>(
				"SELECT COUNT(*) AS n FROM _timers WHERE at <= ?",
				now,
			).one().n;
			if (due === 0) return;
			await host.alarm();
		}
	};
	/** Plays the evaluator: answers every recorded job with `answer(job)`. */
	const deliver = async (answer: (job: CueJobInput) => unknown) => {
		const pending = jobs.splice(0);
		for (const { job } of pending) {
			await host.facade("repoconfig").cueResult(
				job.request.inputKey,
				okEnvelope(answer(job)),
			);
		}
		return pending;
	};
	const head = () =>
		sql.exec<Record<string, SqlStorageValue>>(
			"SELECT * FROM config_head WHERE id = 1",
		).toArray()[0] ?? null;
	const trunkRows = () =>
		sql.exec<Record<string, SqlStorageValue>>(
			"SELECT trunk_seq, sha, status, input_key FROM config_trunk ORDER BY trunk_seq",
		).toArray();
	return {
		host,
		sql,
		jobs,
		control,
		ticks,
		run,
		deliver,
		head,
		trunkRows,
		advance: (ms: number) => {
			now += ms;
		},
		/** The host's clock (timers are due against it, not `Date.now()`). */
		now: () => now,
		config: host.facade("repoconfig"),
		internal: host.internal("repoconfig"),
		core: host.facade("core"),
		land: host.facade("land"),
	};
};

/** Inits the RepoDO at the seeded trunk (seq 0 in `trunk_commits`). */
const initRepo = async (
	r: Awaited<ReturnType<typeof repoHost>>,
	w: Awaited<ReturnType<typeof world>>,
) => {
	await r.core.init({
		repoId: w.repoId,
		nodeId: w.repoId,
		path: w.path,
		defaultBranch: "main",
		refs: { "refs/heads/main": w.trunk },
	});
	r.sql.exec(
		"INSERT OR IGNORE INTO trunk_commits (sha, seq, source) VALUES (?, 0, 'genesis')",
		w.trunk,
	);
};

/** A trunk Advance as WP10's `completeAdvanceSync` records it, `fail` rolls it back. */
const advanceTrunk = (
	state: DurableObjectState,
	r: Awaited<ReturnType<typeof repoHost>>,
	input: { sha: string; seq: number; paths: string[]; fail?: boolean },
) =>
	state.storage.transactionSync(() => {
		r.sql.exec(
			"INSERT INTO trunk_commits (sha, seq, source) VALUES (?, ?, 'advance')",
			input.sha,
			input.seq,
		);
		r.sql.exec(
			"UPDATE refs SET sha = ? WHERE ref = 'refs/heads/main'",
			input.sha,
		);
		r.internal.onAdvanceSync({
			sha: input.sha,
			changes: [{
				changeId: "c".repeat(32),
				laneId: `ln_${ulid()}`,
				head: input.sha,
				commit: input.sha,
				paths: input.paths,
				capped: false,
			}],
		});
		if (input.fail) throw new Error("the Advance failed after the hook");
	});

afterAll(() => settleBackground());

describe("repository config in a RepoDO over the real ForgeDO registry", () => {
	it("migrates 400–429 beside the other RepoDO modules", async () => {
		await runInDurableObject(
			env.REPO.getByName(uniqueName("rc-migrate")),
			async (_instance, state) => {
				const r = await repoHost(state);
				const applied = r.sql.exec<{ n: number }>(
					"SELECT n FROM _migrations WHERE n BETWEEN 400 AND 429 ORDER BY n",
				).toArray().map((x) => x.n);
				expect(applied.length).toBeGreaterThan(0);
				const tables = r.sql.exec<{ name: string }>(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'config_%' OR name = 'policy_signoffs' ORDER BY name",
				).toArray().map((x) => x.name);
				expect(tables).toEqual(expect.arrayContaining([
					"config_apply_intents",
					"config_evals",
					"config_head",
					"config_jobs",
					"config_previews",
					"config_trunk",
					"policy_signoffs",
				]));
			},
		);
	});

	it("a trunk move outside the Advance resolves repo policy at once and needs an explicit apply; an Advance holds, evaluates and applies fenced", async () => {
		const w = await world({
			"README.md": "# api\n",
			"tartan.cue": weaveCue(2),
			"ci.cue": CI_CUE,
			"env.cue": CUENV,
		});
		await runInDurableObject(
			env.REPO.getByName(uniqueName("rc-loop")),
			async (_instance, state) => {
				const r = await repoHost(state);
				await initRepo(r, w);
				// `repo.created` (with config at its trunk) evaluates as a trunk
				// move outside the Advance: on cue:trunk, every root *.cue file and
				// the forge's binding file, never the repo's cue.mod.
				await r.run();
				expect(r.jobs).toHaveLength(1);
				const first = r.jobs[0]!;
				expect(first.sandbox).toBe("cue:trunk");
				expect(first.job.class).toBe("external");
				const sent = Object.keys(first.job.request.files);
				expect(sent).toEqual(expect.arrayContaining([
					"tartan.cue",
					"ci.cue",
					"env.cue",
					"~tartan.cue",
				]));
				expect(sent.some((f) => f === "README.md")).toBe(false);
				await r.deliver(() => resolvedFor(2));
				await r.run();
				let state1 = await r.config.state();
				expect(state1.status).toBe("needs-apply");
				expect(state1.held).toBe(false);
				// Repo policy reads the resolved row at once (as the YAML files were).
				const policy = await r.config.policy(w.trunk, "tartan.ci", [
					"pipeline",
				]);
				expect(policy).toMatchObject({
					state: "ok",
					exact: true,
					values: { pipeline: PIPELINE },
				});
				// Installations wait for a Maintainer's explicit apply.
				expect(
					(await registry().installationAt(w.weave.id, w.repoId))?.config,
				).toMatchObject({ batch: 4 });
				await r.config.apply(w.trunk, OWNER);
				await r.run();
				expect(r.jobs).toHaveLength(0); // a cache hit (sha256-checked)
				state1 = await r.config.state();
				expect(state1.status).toBe("current");
				expect(state1.appliedSha).toBe(w.trunk);
				expect(state1.appliedBy).toEqual([OWNER]);
				expect(
					(await registry().installationAt(w.weave.id, w.repoId))?.config,
				).toMatchObject({ batch: 2 });

				// An Advance that lands a root *.cue change: the trunk row and the
				// hold are written in the Advance's own transaction.
				const t2 = await artifacts.commit(
					repoArtifactsName(w.repoId),
					"refs/heads/main",
					{ "tartan.cue": weaveCue(3) },
					"batch 3",
				);
				expect(() =>
					advanceTrunk(state, r, {
						sha: t2,
						seq: 1,
						paths: ["tartan.cue"],
						fail: true,
					})
				).toThrow("the Advance failed after the hook");
				expect(r.trunkRows().map((row) => row.sha)).toEqual([w.trunk]);
				expect(await r.land.configHold()).toEqual({ held: false });
				advanceTrunk(state, r, { sha: t2, seq: 1, paths: ["tartan.cue"] });
				expect(r.trunkRows().at(-1)).toMatchObject({
					sha: t2,
					status: "pending",
				});
				expect(await r.land.configHold()).toEqual({
					held: true,
					reason: "pending",
				});
				expect(
					r.sql.exec(
						"SELECT COUNT(*) AS n FROM events WHERE type = 'repo.config.evaluating'",
					).one().n,
				).toBeGreaterThan(0);
				await r.run();
				expect(r.jobs.map((j) => j.job.class)).toEqual(["trunk"]);
				await r.deliver(() => resolvedFor(3));
				await r.run();
				expect((await r.config.state()).status).toBe("current");
				expect(await r.land.configHold()).toEqual({ held: false });
				expect(r.trunkRows().at(-1)).toMatchObject({ sha: t2, status: "ok" });
				expect(
					(await registry().installationAt(w.weave.id, w.repoId))?.config,
				).toMatchObject({ batch: 3 });
				// The forge keeps the newest fence: an older apply is refused.
				const schema = await registry().repoConfigSchema(w.repoId);
				const older = await registry().applyRepoConfig(w.repoId, {
					trunkSeq: 1,
					epoch: schema.epoch,
					sha: w.trunk,
					inputKey: "0".repeat(64),
					schemaKey: schema.schemaKey,
					resolved: resolvedFor(1),
					principals: [OWNER],
					provenance: {
						firstSha: w.trunk,
						evaluator: CUE_EVALUATOR_ID,
						cueVersion: "v0.17.1",
					},
				});
				expect(older.kind).toBe("refused");
				expect(
					(await registry().installationAt(w.weave.id, w.repoId))?.config,
				).toMatchObject({ batch: 3 });
				// A lane head is never repo policy (K13).
				await expect(
					r.config.policy("f".repeat(40), "tartan.ci", ["pipeline"]),
				).rejects.toSatisfy((e: unknown) =>
					/policy-not-trunk/.test(fromRpcError(e).text)
				);
			},
		);
	});

	it("a preview never applies and never reads as policy; the sign-off binds the head and its root *.cue digest, with its event", async () => {
		const w = await world({
			"README.md": "# api\n",
			"tartan.cue": weaveCue(2),
			"env.cue": CUENV,
		});
		await runInDurableObject(
			env.REPO.getByName(uniqueName("rc-preview")),
			async (_instance, state) => {
				const r = await repoHost(state);
				await initRepo(r, w);
				await r.run();
				await r.deliver(() => resolvedFor(2));
				await r.run();
				await r.config.apply(w.trunk, OWNER);
				await r.run();
				expect((await r.config.state()).status).toBe("current");
				const before = {
					head: r.head(),
					trunk: r.trunkRows(),
					weave: (await registry().installationAt(w.weave.id, w.repoId))
						?.config,
				};
				// An agent's branch lane edits tartan.cue; the push's phase 2
				// (`push.diffed`) touches a root *.cue path and queues a preview.
				const lane = await r.core.openLane({
					owner: AGENT,
					actor: { kind: "agent", id: AGENT },
				}) as unknown as Lane;
				const laneHead = await artifacts.commit(
					repoArtifactsName(w.repoId),
					lane.ref,
					{ "tartan.cue": weaveCue(1) },
					"batch 1",
				);
				const pushed = await r.core.recordPush({
					target: "repo",
					refs: [{
						ref: lane.ref,
						before: "0".repeat(40),
						after: laneHead,
					}],
					principal: AGENT,
					via: "gateway",
					requestId: `req_${ulid()}`,
				}) as unknown as { readonly pushIds: readonly string[] };
				await r.core.recordDiff(pushed.pushIds[0]!, {
					rangeBase: w.trunk,
					rangeTruncated: false,
					diffKey: `diffs/${w.repoId}/${w.trunk}..${laneHead}.json`,
					commits: [],
					paths: ["tartan.cue"],
					truncated: false,
				});
				await r.run();
				expect(r.jobs.map((j) => [j.sandbox, j.job.class])).toEqual([
					["cue:preview:0", "preview"],
				]);
				await r.deliver(() => resolvedFor(1));
				await r.run();
				const preview = await r.config.previewOf(lane.id) as
					| RepoConfigPreviewDto
					| null;
				expect(preview?.status).toBe("ok");
				expect(preview?.head).toBe(laneHead);
				expect(preview?.plan.map((l) => l.text)).toEqual([
					expect.stringMatching(/^overlay tartan\.weave .*: batch 2 → 1$/),
				]);
				// Nothing about trunk or the installations moved (K13).
				expect(r.head()).toEqual(before.head);
				expect(r.trunkRows()).toEqual(before.trunk);
				expect(
					(await registry().installationAt(w.weave.id, w.repoId))?.config,
				).toEqual(before.weave);
				await expect(
					r.config.policy(laneHead, "tartan.weave", ["batch"]),
				).rejects.toSatisfy((e: unknown) =>
					/policy-not-trunk/.test(fromRpcError(e).text)
				);
				// A sign-off names the head and the digest the person saw.
				const stale = await r.config.signOff(lane.id, {
					head: laneHead,
					policyDigest: "0".repeat(64),
				}, OWNER).catch((e: unknown) => fromRpcError(e));
				expect(stale).toMatchObject({ code: "conflict" });
				const signed = await r.config.signOff(lane.id, {
					head: laneHead,
					policyDigest: preview!.policyDigest ?? null,
				}, OWNER);
				expect(signed).toMatchObject({
					laneId: lane.id,
					head: laneHead,
					signedBy: OWNER,
				});
				const event = r.sql.exec<
					{ id: string; type: string; actor_id: string }
				>(
					"SELECT id, type, actor_id FROM events WHERE type = 'repo.policy.approved'",
				).toArray();
				expect(event).toHaveLength(1);
				expect(event[0]!.id).toBe(signed.eventId);
				expect(event[0]!.actor_id).toBe(OWNER);
				expect(r.internal.signoffSync(lane.id, laneHead)?.signedBy).toBe(
					OWNER,
				);
				await r.config.revokeSignOff(lane.id, laneHead, OWNER);
				expect(r.internal.signoffSync(lane.id, laneHead)).toBeNull();
			},
		);
	});

	it("timers never await an evaluation: a hung cueSubmit returns within the budget and a co-due timer still runs", async () => {
		const w = await world({ "tartan.cue": weaveCue(2) });
		await runInDurableObject(
			env.REPO.getByName(uniqueName("rc-timers")),
			async (_instance, state) => {
				const r = await repoHost(state, { budgetMs: 150 });
				r.control.mode = "hang";
				await initRepo(r, w);
				r.host.timers.schedule("tick", "k5", r.now() - 1);
				const started = performance.now();
				await r.host.alarm();
				const elapsed = performance.now() - started;
				expect(r.jobs).toHaveLength(1);
				expect(r.ticks).toHaveLength(1);
				// Reads, the schema and the submit each have the 150 ms budget.
				expect(elapsed).toBeLessThan(2_000);
				// The pool's real TartanSandbox answers at once without a
				// container (the Deno tests cover the queue itself).
				const answer = await env.SANDBOX.getByName("cue:trunk").cueSubmit(
					r.jobs[0]!.job,
				);
				expect(answer).toMatchObject({
					accepted: false,
					reason: "unavailable",
				});
			},
		);
	});
});
