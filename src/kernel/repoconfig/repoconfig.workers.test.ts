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
// Covers the module's migrations beside the other RepoDO modules. The
// apply, preview, sign-off and timer cases installed tartan.weave and
// tartan.ci from the real ForgeDO registry; the spike removed those
// packages, so they went with them.

import { runInDurableObject } from "cloudflare:test";
import {
	CUE_EVAL_CONTRACT,
	CUE_EVALUATOR_ID,
	type CueJobInput,
	type CueSubmitResult,
	type EvalResponse,
} from "@tartan/contract";
import type { ModuleDeps, RepoInternals } from "@tartan/contract/kernel.ts";
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
});
