// tartan.ci behaviour (K13, K14): plan affected jobs from the policy at the
// change's base on trunk, reuse cached successes by input hash, start one CI
// run for the rest, track `run.*`/`job.*` into checks, and announce the result:
// `checks.completed` for changes and land candidates, `land.report` echoing
// `(attempt, candidateSha)` for `land.testing`.
//
// Every handler is idempotent (events are delivered at least once): a
// plan row is written before the run starts (`planned`), so a retried event
// resumes with the same `idemKey`; completion side effects run until the
// row is marked `notified`.

import {
	type Affected,
	CHANGES_EVENTS,
	type Check,
	type CiJobGraphInput,
	type Envelope,
	type ExtCtx,
	fromRpcError,
	type GitSource,
	invalid,
	isTartanError,
	type JobState,
	type ProjectGraph,
	type RepoRef,
	type RunStatus,
	TERMINAL_RUN_STATES,
} from "@tartan/contract";
import {
	affectedOn,
	globMatcher,
	inputHashes,
	jobsToRun,
	planJobs,
	type PlanTrigger,
} from "./pipeline/index.ts";
import { loadPolicy, type Policy, testCommandsOf } from "./policy.ts";
import {
	type CheckRow,
	type CheckState,
	createStore,
	type PlanDetail,
	type PlanRow,
	type PlanState,
	type StoredJob,
	type SubjectKind,
	TERMINAL_PLAN_STATES,
} from "./store.ts";

/** Runner image id, part of every input hash. */
export const DEFAULT_IMAGE = "tartan-runner";
/** Re-check a run this often when no `run.completed` arrived. */
export const POLL_MS = 2 * 60 * 1000;
/** Give up on a run that never finishes (the run's own hard max is 60 min). */
export const GIVE_UP_MS = 80 * 60 * 1000;

export type CiConfig = { readonly image: string };

export const ciConfigOf = (raw: unknown): CiConfig => {
	const image = (raw as { image?: unknown } | null)?.image;
	return {
		image: typeof image === "string" && image.length > 0 && image.length <= 200
			? image
			: DEFAULT_IMAGE,
	};
};

type Subject = { readonly kind: SubjectKind; readonly id: string };
export type CheckSubject = Check["subject"];

export type PlanRequest = {
	readonly subject: Subject;
	readonly repoId: string;
	/** The commit to test (lane head, candidate or pushed commit). */
	readonly sha: string;
	/** The base on trunk the change's paths are diffed from (K17). */
	readonly base: string;
	/**
	 * The trunk commit the pipeline and the project graph are read from
	 * (K13); the base when omitted. A change or push check reads them at the
	 * trunk tip, since its base is a merge base its owner controls; a land
	 * candidate reads them at its own base.
	 */
	readonly policyAt?: string;
	readonly source: GitSource;
	readonly trigger: PlanTrigger;
	readonly laneId?: string;
	readonly revision?: number;
	readonly attempt?: number;
	/** Extra affected projects to include (the kernel's own set for land). */
	readonly alsoAffected?: readonly string[];
	/** Changed paths when the caller already has them (push.diffed). */
	readonly paths?: {
		readonly paths: readonly string[];
		readonly truncated: boolean;
	};
	readonly detail?: PlanDetail;
	/** Re-run: ignore the cache and start a new generation. */
	readonly force?: boolean;
	/** Policy already loaded by the caller. */
	readonly policy?: Policy;
};

const JOB_TO_CHECK: Readonly<Record<JobState, CheckState>> = {
	pending: "pending",
	running: "running",
	success: "success",
	failure: "failure",
	skipped: "skipped",
	cancelled: "cancelled",
	cached: "cached",
};

/** A job left out of the run: `cached` with a cache hit, else `skipped` (a support job nothing needed). */
const notRunState = (j: StoredJob): CheckState =>
	j.cachedRun !== undefined ? "cached" : "skipped";

const isTerminalPlan = (s: PlanState): boolean =>
	TERMINAL_PLAN_STATES.includes(s);

/** checks@1 subjects are changes and land candidates; pushes stay internal. */
const checkSubject = (s: Subject): CheckSubject | null =>
	s.kind === "change" || s.kind === "land" ? { kind: s.kind, id: s.id } : null;

export const createCi = (x: ExtCtx) => {
	const store = createStore(x.sql);
	const now = () => x.caps.clock.now();
	const config = ciConfigOf(x.config);
	const repoRef = (repoId: string): RepoRef => ({ id: repoId });

	const emitUpdated = async (plan: PlanRow, check: CheckRow): Promise<void> => {
		const subject = checkSubject({
			kind: plan.subjectKind,
			id: plan.subjectId,
		});
		if (subject === null) return;
		await x.caps.events.emit("checks.updated", {
			subject,
			sha: plan.sha,
			context: check.context,
			state: check.state,
			...(check.runId ? { runId: check.runId } : {}),
			cached: check.cached,
		}, {
			subject,
			idemKey:
				`checks.updated:${plan.subjectKind}:${plan.subjectId}:${plan.sha}:g${plan.gen}:${
					check.jobId ?? check.context.slice(0, 40)
				}:${check.state}`,
		});
	};

	/** Changed paths base..sha in `source`, affected on the base graph (K13). */
	const affectedFor = async (
		req: PlanRequest,
		graph: ProjectGraph,
	): Promise<Affected> => {
		const diff = req.paths ?? await (async () => {
			const d = await x.caps.repo.diffPaths(req.source, req.base, req.sha);
			return {
				paths: d.paths.flatMap((p) =>
					p.oldPath ? [p.oldPath, p.path] : [p.path]
				),
				truncated: d.truncated,
			};
		})();
		const own: Affected = diff.truncated
			? { projects: graph.projects.map((p) => p.name).sort(), global: true }
			: affectedOn(graph, diff.paths);
		const extra = (req.alsoAffected ?? []).filter((p) =>
			graph.projects.some((q) => q.name === p)
		);
		return {
			...own,
			projects: [...new Set([...own.projects, ...extra])].sort(),
		};
	};

	/** Cancels older running plans of the same subject (a newer sha replaced them). */
	const cancelOthers = async (subject: Subject, sha: string): Promise<void> => {
		const others = x.sql.exec<{ run_id: string | null; sha: string }>(
			"SELECT run_id, sha FROM plans WHERE subject_kind = ? AND subject_id = ? AND sha <> ? AND state IN ('planned', 'running')",
			subject.kind,
			subject.id,
			sha,
		).toArray();
		for (const o of others) {
			const plan = store.plan(subject.kind, subject.id, o.sha);
			if (plan === null) continue;
			if (o.run_id) {
				try {
					await x.caps.runs.cancel(o.run_id);
				} catch (e) {
					x.log.warn("ci: cancel of a replaced run failed", {
						runId: o.run_id,
						error: String(e),
					});
				}
			}
			store.writePlan({
				...plan,
				state: "superseded",
				notified: true,
				finishedAt: now(),
			});
		}
	};

	/** Writes a plan that ends without a run (no jobs, all cached, or invalid). */
	const finishWithoutRun = async (
		req: PlanRequest,
		gen: number,
		state: "success" | "failure",
		checks: readonly { context: string; state: CheckState }[],
		detail: PlanDetail,
		jobs: readonly StoredJob[] = [],
	): Promise<void> => {
		const plan: PlanRow = {
			subjectKind: req.subject.kind,
			subjectId: req.subject.id,
			sha: req.sha,
			runId: null,
			jobs,
			state,
			createdAt: now(),
			base: req.base,
			laneId: req.laneId ?? null,
			attempt: req.attempt ?? null,
			revision: req.revision ?? null,
			gen,
			notified: false,
			detail: { ...req.detail, ...detail },
			finishedAt: now(),
		};
		store.tx(() => {
			store.clearChecks(plan.subjectKind, plan.subjectId, plan.sha);
			store.writePlan(plan);
			for (const c of checks) {
				const job = jobs.find((j) => j.context === c.context);
				store.writeCheck({
					subjectKind: plan.subjectKind,
					subjectId: plan.subjectId,
					sha: plan.sha,
					context: c.context,
					state: c.state,
					runId: job?.cachedRun ?? null,
					cached: c.state === "cached" || c.state === "skipped",
					project: job?.project ?? null,
					jobId: job?.id ?? null,
					updatedAt: now(),
				});
			}
		});
		await cancelOthers(req.subject, req.sha);
		await complete(plan);
	};

	const plan = async (req: PlanRequest): Promise<void> => {
		const existing = store.plan(req.subject.kind, req.subject.id, req.sha);
		// A superseded plan (a newer sha replaced it) is planned afresh when
		// its sha comes back; the cache makes that cheap. So is one that waited
		// for its base's Tartan config.
		if (
			existing && !req.force && existing.state !== "superseded" &&
			existing.state !== "waiting"
		) {
			if (existing.state === "planned") return await startRun(existing);
			if (
				req.subject.kind === "land" && req.attempt !== undefined &&
				existing.attempt !== req.attempt
			) {
				// A later attempt with the same candidate: the verdict carries over,
				// but `land.report` must echo the new attempt (K14).
				const next = { ...existing, attempt: req.attempt, notified: false };
				store.writePlan(next);
				if (isTerminalPlan(next.state)) await complete(next);
				return;
			}
			if (isTerminalPlan(existing.state) && !existing.notified) {
				await complete(existing);
			}
			return;
		}
		const gen = (existing?.gen ?? 0) + 1;
		const repo = repoRef(req.repoId);
		const policyAt = req.policyAt ?? req.base;
		const graph = req.policy?.graph ??
			await x.caps.repo.projectGraph(repo, policyAt);
		const affected = await affectedFor(req, graph);
		const policy = req.policy ?? await loadPolicy(x, repo, policyAt, {
			graph,
			only: new Set(affected.projects),
		});
		if (policy.mode === "pending") {
			// The base's Tartan config is still evaluating: the check waits and
			// the request is planned again once its trunk row resolves.
			const { policy: _drop, ...request } = req;
			store.tx(() => {
				store.writeConfigWait(
					req.subject.kind,
					req.subject.id,
					req.sha,
					request,
					now(),
				);
				store.writePlan({
					subjectKind: req.subject.kind,
					subjectId: req.subject.id,
					sha: req.sha,
					runId: null,
					jobs: [],
					state: "waiting",
					createdAt: now(),
					base: req.base,
					laneId: req.laneId ?? null,
					attempt: req.attempt ?? null,
					revision: req.revision ?? null,
					gen,
					notified: true,
					detail: {
						...req.detail,
						note: "waiting for the Tartan config at the base to evaluate",
					},
					finishedAt: null,
				});
				store.clearChecks(req.subject.kind, req.subject.id, req.sha);
				store.writeCheck({
					subjectKind: req.subject.kind,
					subjectId: req.subject.id,
					sha: req.sha,
					context: "pipeline",
					state: "pending",
					runId: null,
					cached: false,
					project: null,
					jobId: null,
					updatedAt: now(),
				});
			});
			return;
		}
		if (policy.mode !== "invalid") {
			store.writePolicy(policy.sha, policy.mode, testCommandsOf(policy), now());
		}
		const baseDetail: PlanDetail = {
			policy: policy.mode,
			image: config.image,
			...(policy.mode !== "invalid" && policy.lastGood !== undefined
				? { configNote: policy.lastGood }
				: {}),
		};
		if (policy.mode === "invalid") {
			return await finishWithoutRun(
				req,
				gen,
				"failure",
				[{ context: "pipeline", state: "failure" }],
				{ ...baseDetail, errors: policy.errors },
			);
		}
		if (req.trigger === "change" && policy.pipeline.lanes.ci === "none") {
			return await finishWithoutRun(req, gen, "success", [], {
				...baseDetail,
				note: "lane CI is off (lanes.ci: none)",
			});
		}
		const planned = planJobs(
			policy.pipeline,
			policy.graph,
			affected,
			req.trigger,
		);
		const affectedDetail = {
			affected: affected.projects,
			global: affected.global,
		};
		if (!planned.ok) {
			return await finishWithoutRun(
				req,
				gen,
				"failure",
				[{ context: "pipeline", state: "failure" }],
				{ ...baseDetail, ...affectedDetail, errors: [planned.error] },
			);
		}
		const jobs = planned.plan.jobs;
		if (jobs.length === 0) {
			return await finishWithoutRun(req, gen, "success", [], {
				...baseDetail,
				...affectedDetail,
				note: policy.mode === "zero" && policy.pipeline.jobs.length === 0
					? "no CI configured"
					: "no jobs for the affected projects",
			});
		}
		const hashes = await inputHashes(
			jobs,
			policy.graph,
			config.image,
			(path) => x.caps.repo.treeHash(repo, req.sha, path, req.source),
			(path) => x.caps.repo.readTree(repo, req.sha, path, req.source),
		);
		const hits = req.force
			? new Map<string, string>()
			: store.cacheHits([...hashes.values()]);
		const cached = new Set(
			jobs.filter((j) => hits.has(hashes.get(j.id)!)).map((j) => j.id),
		);
		const toRun = jobsToRun(jobs, cached);
		const stored: StoredJob[] = jobs.map((j) => {
			const inputHash = hashes.get(j.id)!;
			const hit = hits.get(inputHash);
			return {
				...j,
				inputHash,
				...(hit !== undefined && !toRun.has(j.id) ? { cachedRun: hit } : {}),
				runs: toRun.has(j.id),
			};
		});
		const detail: PlanDetail = {
			...req.detail,
			...baseDetail,
			...affectedDetail,
			...(req.force ? { note: "re-run (cache skipped)" } : {}),
		};
		if (toRun.size === 0) {
			return await finishWithoutRun(
				req,
				gen,
				"success",
				stored.map((j) => ({ context: j.context, state: notRunState(j) })),
				detail,
				stored,
			);
		}
		const row: PlanRow = {
			subjectKind: req.subject.kind,
			subjectId: req.subject.id,
			sha: req.sha,
			runId: null,
			jobs: stored,
			state: "planned",
			createdAt: now(),
			base: req.base,
			laneId: req.laneId ?? null,
			attempt: req.attempt ?? null,
			revision: req.revision ?? null,
			gen,
			notified: false,
			detail: { ...detail, timeoutMs: planned.plan.timeoutMs },
			finishedAt: null,
		};
		store.tx(() => {
			store.clearChecks(row.subjectKind, row.subjectId, row.sha);
			store.writePlan(row);
			for (const j of stored) {
				store.writeCheck({
					subjectKind: row.subjectKind,
					subjectId: row.subjectId,
					sha: row.sha,
					context: j.context,
					state: j.runs ? "pending" : notRunState(j),
					runId: j.runs ? null : j.cachedRun ?? null,
					cached: !j.runs,
					project: j.project ?? null,
					jobId: j.id,
					updatedAt: now(),
				});
			}
		});
		await cancelOthers(req.subject, req.sha);
		await startRun(row);
	};

	const startRun = async (row: PlanRow): Promise<void> => {
		const runSet = new Set(row.jobs.filter((j) => j.runs).map((j) => j.id));
		const repoId = repoIdOf(row);
		const timeoutMs = row.detail.timeoutMs;
		const graph: CiJobGraphInput & { idemKey: string } = {
			repo: repoRef(repoId),
			kind: "ci",
			subject: { kind: row.subjectKind, id: row.subjectId },
			source: row.laneId ? { repoId, laneId: row.laneId } : { repoId },
			sha: row.sha,
			jobs: row.jobs.filter((j) => j.runs).map((j) => ({
				id: j.id,
				...(j.project !== undefined ? { project: j.project } : {}),
				needs: j.needs.filter((n) => runSet.has(n)),
				...(j.cwd !== undefined ? { cwd: j.cwd } : {}),
				run: j.run,
				...(Object.keys(j.env).length > 0 ? { env: { ...j.env } } : {}),
				optional: j.optional,
				...(j.timeoutMs !== undefined ? { timeoutMs: j.timeoutMs } : {}),
				inputHash: j.inputHash,
			})),
			concurrencyGroup: `${row.subjectKind}:${row.subjectId}`,
			...(timeoutMs !== undefined ? { timeoutMs } : {}),
			image: row.detail.image ?? config.image,
			idemKey: `${row.subjectKind}:${row.subjectId}:${row.sha}:g${row.gen}`,
		};
		const { runId } = await x.caps.runs.start(graph);
		const running: PlanRow = { ...row, runId, state: "running" };
		store.tx(() => {
			store.writePlan(running);
			for (const c of store.checks(row.subjectKind, row.subjectId, row.sha)) {
				if (!c.cached) store.writeCheck({ ...c, runId, updatedAt: now() });
			}
		});
		await x.caps.timers.set(`poll:${runId}`, now() + POLL_MS);
		for (const c of store.checks(row.subjectKind, row.subjectId, row.sha)) {
			await emitUpdated(running, c);
		}
	};

	const repoIdOf = (row: PlanRow): string => {
		const id = row.detail.repoId;
		if (!id) throw invalid("ci: plan without a repo");
		return id;
	};

	/** The plan's verdict from the run's final job states. */
	const verdictOf = (
		row: PlanRow,
		run: RunStatus,
	): "success" | "failure" | "cancelled" | "superseded" => {
		if (run.state === "superseded") return "superseded";
		if (run.state === "cancelled") return "cancelled";
		if (run.state === "error") return "failure";
		const byId = new Map(run.jobs.map((j) => [j.jobId, j]));
		for (const job of row.jobs) {
			if (!job.runs || job.optional) continue;
			const state = byId.get(job.id)?.state;
			if (state !== "success" && state !== "cached") return "failure";
		}
		// Only optional jobs may have failed.
		return "success";
	};

	/** Applies a terminal run to its plan and announces the result. */
	const finalizeRun = async (row: PlanRow): Promise<boolean> => {
		if (row.runId === null) return false;
		if (isTerminalPlan(row.state)) {
			if (!row.notified) await complete(row);
			return true;
		}
		const run = await x.caps.runs.get(row.runId);
		if (!TERMINAL_RUN_STATES.includes(run.state)) return false;
		const verdict = verdictOf(row, run);
		const byId = new Map(run.jobs.map((j) => [j.jobId, j]));
		const done: PlanRow = {
			...row,
			state: verdict,
			finishedAt: now(),
			notified: verdict === "superseded",
		};
		store.tx(() => {
			for (const c of store.checks(row.subjectKind, row.subjectId, row.sha)) {
				if (c.cached || c.jobId === null) continue;
				const job = byId.get(c.jobId);
				const state: CheckState = job
					? JOB_TO_CHECK[job.state]
					: verdict === "superseded" || verdict === "cancelled"
					? "cancelled"
					: c.state;
				const final: CheckState = state === "pending" || state === "running"
					? "cancelled"
					: state;
				store.writeCheck({ ...c, state: final, updatedAt: now() });
			}
			for (const j of row.jobs) {
				if (j.runs && byId.get(j.id)?.state === "success") {
					store.remember(j.inputHash, j.id, j.project, row.runId!, now());
				}
			}
			store.writePlan(done);
		});
		await x.caps.timers.clear(`poll:${row.runId}`);
		if (verdict !== "superseded") await complete(done);
		return true;
	};

	/** Completion side effects (idempotent; repeated until `notified`). */
	const complete = async (row: PlanRow): Promise<void> => {
		if (row.state === "superseded") {
			// Replaced by a newer run of the subject: nothing to announce.
			store.writePlan({ ...row, notified: true });
			return;
		}
		const checks = store.checks(row.subjectKind, row.subjectId, row.sha);
		const contexts = checks.map((c) => ({
			context: c.context,
			state: c.state,
		}));
		const allCached = checks.length > 0 && checks.every((c) => c.cached);
		const state = row.state === "success"
			? "success"
			: row.state === "cancelled"
			? "cancelled"
			: "failure";
		const subject = checkSubject({ kind: row.subjectKind, id: row.subjectId });
		let detail = row.detail;
		if (subject !== null) {
			await x.caps.events.emit("checks.completed", {
				subject,
				sha: row.sha,
				state,
				contexts,
				cached: allCached,
			}, {
				subject,
				idemKey:
					`checks.completed:${row.subjectKind}:${row.subjectId}:${row.sha}:g${row.gen}:a${
						row.attempt ?? 0
					}`,
			});
		}
		if (row.subjectKind === "land" && row.attempt !== null) {
			const runIds = [
				...new Set([
					...(row.runId ? [row.runId] : []),
					...row.jobs.flatMap((j) => (j.cachedRun ? [j.cachedRun] : [])),
				]),
			].slice(0, 64);
			try {
				await x.caps.land.report(row.subjectId, {
					attempt: row.attempt,
					candidateSha: row.sha,
					state: state === "success" ? "success" : "failure",
					runIds,
					evidence: { contexts, cached: allCached, gen: row.gen },
				});
				detail = { ...detail, reported: "accepted" };
			} catch (e) {
				if (!isTartanError(e) || e.code !== "conflict") throw e;
				// K14: a stale attempt or a late duplicate; the kernel keeps the first.
				x.log.warn("ci: land.report rejected", {
					batchId: row.subjectId,
					attempt: row.attempt,
					error: e.message,
				});
				detail = { ...detail, reported: "rejected", reportError: e.message };
			}
		}
		if (row.subjectKind === "change" && state === "failure") {
			const failing = contexts.filter((c) => c.state === "failure").map((c) =>
				c.context
			);
			const recipients = [
				...new Set(
					[detail.author, detail.onBehalfOf].filter((p): p is string =>
						typeof p === "string"
					),
				),
			];
			for (const principal of recipients) {
				try {
					await x.caps.notify.send(principal, {
						repo: repoRef(repoIdOf(row)),
						...(row.laneId ? { laneId: row.laneId } : {}),
						kind: "ci",
						severity: "warn",
						text: `CI failed for change ${row.subjectId}${
							row.revision ? ` r${row.revision}` : ""
						}: ${failing.join(", ") || "see the run"}`,
						data: { changeId: row.subjectId, sha: row.sha, runId: row.runId },
						dedupeKey: `ci:${row.subjectId}:${row.sha}:g${row.gen}`,
					});
				} catch (e) {
					x.log.warn("ci: notify failed", { principal, error: String(e) });
				}
			}
		}
		store.writePlan({ ...row, detail, notified: true });
	};

	/**
	 * Where a change or push check reads its pipeline and project graph: the
	 * trunk tip, as review does, so a lane rooted
	 * on an older trunk commit cannot pick an older pipeline. The base stands
	 * in while trunk has no commit, or when the tip is not a recorded trunk
	 * commit (a move outside Tartan before it is acknowledged).
	 */
	const policyTip = async (repo: RepoRef, base: string): Promise<string> => {
		const tip = (await x.caps.repo.info(repo)).trunkSha;
		if (tip === null || tip === base) return base;
		try {
			await x.caps.repo.policy(repo, tip);
			return tip;
		} catch (error) {
			if (fromRpcError(error).reason === "policy-not-trunk") return base;
			throw error;
		}
	};

	// -- event handlers ----------------------------------------------------------

	const onChange = async (ev: Envelope): Promise<void> => {
		const schema = CHANGES_EVENTS[ev.type as "changes.submitted"];
		const parsed = schema.safeParse(ev.data);
		if (!parsed.success || ev.repo === undefined) {
			x.log.warn("ci: ignored a malformed change event", { id: ev.id });
			return;
		}
		const d = parsed.data;
		await plan({
			subject: { kind: "change", id: d.changeId },
			repoId: ev.repo,
			sha: d.head,
			base: d.base,
			policyAt: await policyTip(repoRef(ev.repo), d.base),
			source: { repoId: ev.repo, laneId: d.laneId },
			trigger: "change",
			laneId: d.laneId,
			revision: d.revision,
			detail: {
				repoId: ev.repo,
				author: ev.actor.id,
				...(ev.actor.onBehalfOf ? { onBehalfOf: ev.actor.onBehalfOf } : {}),
				...(d.workRef ? { workRef: d.workRef } : {}),
			},
		});
	};

	const onLandTesting = async (ev: Envelope): Promise<void> => {
		if (ev.source.kind !== "kernel" || ev.repo === undefined) return;
		const d = ev.data as {
			batchId: string;
			attempt: number;
			candidateSha: string;
			base: string;
			affected: string[];
		};
		await plan({
			subject: { kind: "land", id: d.batchId },
			repoId: ev.repo,
			sha: d.candidateSha,
			base: d.base,
			source: { repoId: ev.repo },
			trigger: "land",
			attempt: d.attempt,
			alsoAffected: d.affected,
			detail: { repoId: ev.repo },
		});
	};

	const onPushDiffed = async (ev: Envelope): Promise<void> => {
		if (ev.source.kind !== "kernel" || ev.repo === undefined) return;
		const d = ev.data as {
			pushId: string;
			target: string;
			ref: string;
			after: string;
			rangeBase: string;
			paths: string[];
			truncated: boolean;
		};
		if (d.target !== "repo" || !d.ref.startsWith("refs/heads/")) return;
		const branch = d.ref.slice("refs/heads/".length);
		const repo = repoRef(ev.repo);
		const policyAt = await policyTip(repo, d.rangeBase);
		const policy = await loadPolicy(x, repo, policyAt);
		if (policy.mode !== "pipeline") return;
		const { branches, jobs } = policy.pipeline.on.push;
		if (jobs.length === 0 || !branches.some((g) => globMatcher(g)(branch))) {
			return;
		}
		await plan({
			subject: { kind: "push", id: d.pushId },
			repoId: ev.repo,
			sha: d.after,
			base: d.rangeBase,
			policyAt,
			source: { repoId: ev.repo },
			trigger: "push",
			paths: { paths: d.paths, truncated: d.truncated },
			policy,
			detail: { repoId: ev.repo, ref: d.ref },
		});
	};

	/**
	 * `repo.config.resolved`: a trunk config row left `pending`, so plan
	 * again every request that waited for its base's config (a request whose
	 * base is still pending waits again).
	 */
	const onConfigResolved = async (ev: Envelope): Promise<void> => {
		if (ev.source.kind !== "kernel") return;
		for (const raw of store.takeConfigWaits()) {
			try {
				await plan(raw as PlanRequest);
			} catch (e) {
				x.log.warn("ci: a plan that waited for config failed", {
					error: String(e).slice(0, 200),
				});
			}
		}
	};

	const onRunEvent = async (ev: Envelope): Promise<void> => {
		if (ev.source.kind !== "kernel") return;
		const d = ev.data as { runId: string; jobId?: string; state: string };
		const row = store.planByRun(d.runId);
		if (row === null) return;
		if (ev.type === "run.completed") {
			await finalizeRun(row);
			return;
		}
		if (d.jobId === undefined || isTerminalPlan(row.state)) return;
		const check = store.checks(row.subjectKind, row.subjectId, row.sha).find((
			c,
		) => c.jobId === d.jobId);
		if (check === undefined || check.cached) return;
		const state: CheckState | undefined = ev.type === "job.started"
			? "running"
			: JOB_TO_CHECK[d.state as JobState];
		if (state === undefined || state === check.state) return;
		const next: CheckRow = { ...check, state, updatedAt: now() };
		store.writeCheck(next);
		if (state === "success") {
			const job = row.jobs.find((j) => j.id === d.jobId);
			if (job) {
				store.remember(job.inputHash, job.id, job.project, d.runId, now());
			}
		}
		await emitUpdated(row, next);
	};

	const onTimer = async (key: string): Promise<void> => {
		if (!key.startsWith("poll:")) return;
		const runId = key.slice(5);
		const row = store.planByRun(runId);
		if (row === null) return;
		if (await finalizeRun(row)) return;
		if (now() - row.createdAt > GIVE_UP_MS) {
			x.log.warn("ci: run never finished; marking it failed", { runId });
			const failed: PlanRow = { ...row, state: "failure", finishedAt: now() };
			store.writePlan(failed);
			await complete(failed);
			return;
		}
		await x.caps.timers.set(key, now() + POLL_MS);
	};

	// -- tools -------------------------------------------------------------------

	const subjectOf = (args: {
		changeId?: string;
		subject?: { kind: string; id: string };
	}): Subject => {
		if (args.changeId) return { kind: "change", id: args.changeId };
		if (
			args.subject && (args.subject.kind === "change" ||
				args.subject.kind === "land")
		) {
			return { kind: args.subject.kind, id: args.subject.id };
		}
		throw invalid("changeId or subject is required");
	};

	const checksOf = (subject: Subject, sha?: string) => {
		const row = sha
			? store.plan(subject.kind, subject.id, sha)
			: store.latestPlan(subject.kind, subject.id);
		if (row === null) return { plan: null, checks: [] };
		const cs = checkSubject(subject)!;
		return {
			plan: row,
			checks: store.checks(subject.kind, subject.id, row.sha).map((c) => ({
				subject: cs,
				sha: c.sha,
				context: c.context,
				state: c.state,
				...(c.runId ? { runId: c.runId } : {}),
				cached: c.cached,
				...(c.project ? { project: c.project } : {}),
			})),
		};
	};

	const rerun = async (subject: Subject): Promise<{ runId?: string }> => {
		if (subject.kind !== "change") {
			throw invalid(
				"only change checks can be re-run; a land candidate is retested by a new attempt",
			);
		}
		const row = store.latestPlan(subject.kind, subject.id);
		if (row === null || row.base === null) {
			throw invalid(`no checks for change ${subject.id} yet`);
		}
		const repoId = repoIdOf(row);
		await plan({
			subject,
			repoId,
			sha: row.sha,
			base: row.base,
			source: row.laneId ? { repoId, laneId: row.laneId } : { repoId },
			trigger: "change",
			...(row.laneId ? { laneId: row.laneId } : {}),
			...(row.revision !== null ? { revision: row.revision } : {}),
			detail: row.detail,
			force: true,
		});
		const after = store.plan(subject.kind, subject.id, row.sha);
		return after?.runId ? { runId: after.runId } : {};
	};

	return {
		store,
		plan,
		onChange,
		onLandTesting,
		onPushDiffed,
		onConfigResolved,
		onRunEvent,
		onTimer,
		subjectOf,
		checksOf,
		rerun,
	};
};
export type Ci = ReturnType<typeof createCi>;
