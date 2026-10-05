// Harness for the tartan.ci + tartan.review flow tests: both builtins run
// through `@tartan/ext-api/testing`'s host-like harness (migrations, guarded
// SQL, read-only renders, caps policy from the real manifests) with
// `caps.repo.*` answered by a WP8-backed repo world, `caps.runs.*` and
// `caps.land.report` recorded, and events piped between the two.

import {
	conflict,
	type Envelope,
	type JobState,
	parseManifest,
	type RunState,
	type RunStatus,
	unavailable,
} from "@tartan/contract";
import { createTestHarness, type Harness } from "@tartan/ext-api/testing.ts";
import { makeEvent } from "@tartan/testkit";
import ciManifestRaw from "../../../extensions/ci/tartan.json" with {
	type: "json",
};
import reviewManifestRaw from "../../../extensions/review/tartan.json" with {
	type: "json",
};
import * as ciModule from "../../../extensions/ci/src/index.ts";
import * as reviewModule from "../../../extensions/review/src/index.ts";
import { createWorld, type World } from "./repo.ts";

const ulidLike = (c: string): string => `01k6${c.repeat(22)}`;

export const REPO = ulidLike("r");
export const REPO_PATH = "acme/platform/router";
export const AGENT = `a_${ulidLike("a")}`;
export const AGENT_2 = `a_${ulidLike("d")}`;
export const USER = `u_${ulidLike("v")}`;
export const OTHER_USER = `u_${ulidLike("w")}`;
export const CI_INST = `i_${ulidLike("c")}`;
export const REVIEW_INST = `i_${ulidLike("e")}`;
export const lane = (c: string): string => `ln_${ulidLike(c)}`;
export const batch = (c: string): string => `lb_${ulidLike(c)}`;
export const change = (c: string): string => c.repeat(32);

const manifestOf = (raw: unknown) => {
	const parsed = parseManifest(raw);
	if (!parsed.ok) throw new Error(parsed.errors.join("; "));
	return parsed.manifest;
};
export const CI_MANIFEST = manifestOf(ciManifestRaw);
export const REVIEW_MANIFEST = manifestOf(reviewManifestRaw);

export type StartedRun = {
	readonly runId: string;
	readonly graph: {
		readonly sha: string;
		readonly source: { repoId: string; laneId?: string };
		readonly subject?: { kind: string; id: string };
		readonly concurrencyGroup?: string;
		readonly idemKey: string;
		readonly image?: string;
		readonly jobs: readonly {
			id: string;
			run: string;
			cwd?: string;
			needs: string[];
			inputHash?: string;
			project?: string;
		}[];
	};
};

export type FlowOptions = {
	readonly reviewConfig?: Record<string, unknown>;
	readonly reviewMode?: "enforce" | "shadow";
	/** `land.report` answers `conflict` (a stale attempt, K14). */
	readonly rejectReports?: boolean;
	/** Principals `authz.check(…, "approve")` allows. */
	readonly approvers?: readonly string[];
	/** The first n `runs.start` calls fail (`unavailable`). */
	readonly failStarts?: number;
};

export const createFlow = (options: FlowOptions = {}) => {
	const world: World = createWorld();
	const starts: StartedRun[] = [];
	const runs = new Map<string, RunStatus>();
	const cancels: string[] = [];
	const reports: { batchId: string; verdict: Record<string, unknown> }[] = [];
	const notes: { changeId: string; section: unknown }[] = [];
	const approvers = new Set(options.approvers ?? [USER]);
	let failing = options.failStarts ?? 0;
	let trunkSha: string | null = null;
	const repoInfo = () => ({
		id: REPO,
		nodeId: REPO,
		path: REPO_PATH,
		defaultBranch: "main",
		visibility: "private",
		trunkSha,
		landingPaused: false,
	});

	const ci: Harness = createTestHarness({
		module: ciModule.extension,
		migrations: ciModule.migrations,
		grants: CI_MANIFEST.permissions,
		config: CI_MANIFEST.config?.default,
		install: {
			id: CI_INST,
			extId: "tartan.ci",
			version: "0.1.0",
			node: { id: REPO, path: REPO_PATH },
			scopeKey: `repo:${REPO}`,
			mode: "enforce",
		},
		handlers: {
			...world.handlers,
			"repo.policy": world.policyHandler("tartan.ci", ["pipeline"]),
			"repo.info": () => repoInfo(),
			"runs.start": (g: StartedRun["graph"]) => {
				if (failing > 0) {
					failing--;
					throw unavailable("runs.start: RUNS.create failed");
				}
				const runId = `run-${starts.length + 1}`;
				starts.push({ runId, graph: g });
				return { runId };
			},
			"runs.get": (runId: string) => {
				const run = runs.get(runId);
				if (run) return run;
				const started = starts.find((s) => s.runId === runId);
				if (!started) throw new Error(`no run ${runId}`);
				return statusOf(started, "running", {});
			},
			"runs.cancel": (runId: string) => {
				cancels.push(runId);
			},
			"land.report": (batchId: string, verdict: Record<string, unknown>) => {
				reports.push({ batchId, verdict });
				if (options.rejectReports) {
					throw conflict("land.report rejected: stale");
				}
			},
		},
	});

	const review: Harness = createTestHarness({
		module: reviewModule.extension,
		migrations: reviewModule.migrations,
		grants: REVIEW_MANIFEST.permissions,
		config: { ...REVIEW_MANIFEST.config?.default, ...options.reviewConfig },
		install: {
			id: REVIEW_INST,
			extId: "tartan.review",
			version: "0.1.0",
			node: { id: REPO, path: REPO_PATH },
			scopeKey: `repo:${REPO}`,
			mode: options.reviewMode ?? "enforce",
		},
		handlers: {
			...world.handlers,
			"repo.policy": world.policyHandler("tartan.review", ["owners"]),
			"repo.info": () => repoInfo(),
			"authz.check": (principal: string, _node: unknown, perm: string) =>
				perm === "approve" && approvers.has(principal),
			"notes.contribute": (_r: unknown, changeId: string, section: unknown) => {
				notes.push({ changeId, section });
			},
		},
	});

	const statusOf = (
		started: StartedRun,
		state: RunState,
		jobStates: Readonly<Record<string, JobState>>,
	): RunStatus => ({
		runId: started.runId,
		repoId: REPO,
		kind: "ci",
		state,
		sha: started.graph.sha,
		requestedBy: `x_${CI_INST}`,
		createdAt: 0,
		jobs: started.graph.jobs.map((j) => ({
			jobId: j.id,
			state: jobStates[j.id] ?? (state === "running" ? "running" : "success"),
		})),
	});

	const delivered = { ci: 0, review: 0 };

	/** Feeds every event either extension emitted since the last pipe to the other. */
	const pipe = async (): Promise<void> => {
		const fromCi = ci.recorder.emitted.slice(delivered.ci);
		delivered.ci = ci.recorder.emitted.length;
		for (const e of fromCi) {
			if (e.type === "checks.completed") {
				await review.event(
					makeEvent(e.type, e.data, {
						source: {
							kind: "installation",
							id: CI_INST,
							ext: "tartan.ci@0.1.0",
						},
						actor: { kind: "ext", id: `x_${CI_INST}` },
					}),
				);
			}
		}
		delivered.review = review.recorder.emitted.length;
	};

	const submit = async (o: {
		changeId: string;
		laneId: string;
		revision?: number;
		head: string;
		base: string;
		actor?: string;
		type?: "changes.submitted" | "changes.revised";
	}): Promise<Envelope> => {
		const ev = makeEvent(o.type ?? "changes.submitted", {
			changeId: o.changeId,
			laneId: o.laneId,
			revision: o.revision ?? 1,
			head: o.head,
			base: o.base,
			affected: [],
		}, {
			source: {
				kind: "installation",
				id: `i_${ulidLike("g")}`,
				ext: "tartan.changes@0.1.0",
			},
			actor: { kind: "agent", id: o.actor ?? AGENT, onBehalfOf: USER },
		});
		await ci.event(ev);
		await review.event(ev);
		await pipe();
		return ev;
	};

	/** Finishes a started run with job states (default success) and delivers `run.completed`. */
	const finish = async (
		runId: string,
		jobStates: Readonly<Record<string, JobState>> = {},
		state: RunState = Object.values(jobStates).some((s) => s === "failure")
			? "failure"
			: "success",
	): Promise<void> => {
		const started = starts.find((s) => s.runId === runId);
		if (!started) throw new Error(`no run ${runId}`);
		runs.set(runId, statusOf(started, state, jobStates));
		await ci.event(makeEvent("run.completed", { runId, state }));
		await pipe();
	};

	const landTesting = async (o: {
		batchId: string;
		attempt: number;
		candidateSha: string;
		base: string;
		affected?: string[];
	}): Promise<void> => {
		await ci.event(
			makeEvent("land.testing", {
				batchId: o.batchId,
				attempt: o.attempt,
				candidateSha: o.candidateSha,
				base: o.base,
				affected: o.affected ?? [],
			}),
		);
		await pipe();
	};

	const emitted = (h: Harness, type: string) =>
		h.recorder.emitted.filter((e) => e.type === type);
	const calls = (h: Harness, method: string) =>
		h.recorder.calls.filter((c) => c.method === method);

	return {
		world,
		ci,
		review,
		/** `caps.repo.info().trunkSha` (null: trunk has no commit). */
		setTrunk: (sha: string | null) => {
			trunkSha = sha;
		},
		starts,
		runs,
		cancels,
		reports,
		notes,
		submit,
		finish,
		landTesting,
		pipe,
		emitted,
		calls,
		statusOf,
	};
};
export type Flow = ReturnType<typeof createFlow>;
