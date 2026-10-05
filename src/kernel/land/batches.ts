// Land batches (K4, K14): submit (idempotent on the caller-minted batch id, K4
// reason chain, the head binding and the landing freeze, intent first then the
// Workflow instance), the per-attempt bookkeeping LandWorkflow calls (compose
// plan, compose, gates, state, the next attempt) and attempt-bound verdicts.

import {
	advanceId,
	candidateRef,
	conflict,
	denied,
	invalid,
	isChangeId,
	isSha,
	type LandBatchState,
	type LandChange,
	landInstanceId,
	type LandReason,
	LandRequestSchema,
	type LandStatus,
	type LandVerdict,
	LandVerdictSchema,
	MAX_LAND_ATTEMPTS,
	unavailable,
	verdictEventType,
	ZERO_SHA,
} from "@tartan/contract";
import type {
	KernelWriteRow,
	LandBatchDetail,
	LandVerdictRow,
} from "@tartan/contract/kernel.ts";
import {
	armCandidateSweep,
	batchRow,
	changeRows,
	emit,
	errorText,
	first,
	indexSha,
	isTerminal,
	type LandBatchRow,
	type LandCtx,
	parseJson,
	type PrincipalInfo,
	releaseLanes,
	repoIds,
	requireAttempt,
	requireBatch,
	rows,
	TERMINAL_INSTANCE,
} from "./ctx.ts";
import { reasonChainIssues } from "./k4.ts";
import {
	checkPolicyAtSubmit,
	composeEjectionsSync,
	KERNEL_EJECTION_INST,
	pinPolicySignoffsSync,
} from "./policy.ts";
import {
	agentTrailer,
	coAuthorTrailer,
	composeSquashMessage,
	gerritChangeId,
} from "./trailers.ts";
import type {
	BatchStateResult,
	ComposedChange,
	ComposePlan,
	ComposeRange,
	GatedChange,
	LandChangeRow,
} from "./types.ts";

/** How long the `outbox` timer waits before it retries a Workflow create. */
export const OUTBOX_RETRY_MS = 30_000;
/** How often the `outbox` timer checks the instances of live batches. */
export const WATCHDOG_MS = 10 * 60_000;
/** A batch younger than this is never judged abandoned (its instance may be starting). */
export const WATCHDOG_GRACE_MS = 2 * 60_000;
/** Live batches the watchdog checks per run, oldest first. */
const WATCHDOG_BATCH = 50;

const TERMINAL_SQL = "('landed','conflicted','vetoed','failed','cancelled')";
/** A note section is at most this many bytes. */
export const NOTE_SECTION_MAX_BYTES = 8 * 1024;

const encoder = new TextEncoder();

const sha256Hex = async (text: string): Promise<string> =>
	[
		...new Uint8Array(
			await crypto.subtle.digest("SHA-256", encoder.encode(text)),
		),
	].map((b) => b.toString(16).padStart(2, "0")).join("");

/** What makes two submits of one batch id the same request. */
const requestHashOf = (
	request: ReturnType<typeof LandRequestSchema.parse>,
): Promise<string> =>
	sha256Hex(JSON.stringify({
		ref: request.ref,
		batch: request.batch,
		reason: request.reason,
		testPolicy: request.testPolicy,
		partitionKey: request.partitionKey ?? null,
	}));

const STATES_AFTER: Readonly<
	Record<LandBatchState, readonly LandBatchState[]>
> = {
	composing: ["gating"],
	gating: ["testing", "advancing"],
	testing: ["advancing"],
	advancing: [],
	stale: ["composing"],
	landed: [],
	conflicted: [],
	vetoed: [],
	failed: [],
	cancelled: [],
};

const FAIL_REASON: Partial<
	Record<LandBatchState, "conflicted" | "vetoed" | "error">
> = {
	conflicted: "conflicted",
	vetoed: "vetoed",
	failed: "error",
	cancelled: "error",
};

export const createBatches = (ctx: LandCtx) => {
	const now = () => ctx.clock.now();

	// -----------------------------------------------------------------------
	// Workflow instances (the row first, the instance after)
	// -----------------------------------------------------------------------

	/** Live batches whose instance exists (the watchdog's work). */
	const liveCreated = (): number =>
		first<{ n: number }>(
			ctx.sql,
			`SELECT COUNT(*) AS n FROM land_batches
			 WHERE instance_created = 1 AND state NOT IN ${TERMINAL_SQL}`,
		)?.n ?? 0;

	/** The `outbox` timer fires no later than `at` (an earlier one is kept). */
	const outboxNoLaterThan = (at: number): void => {
		const current = ctx.timers.get("outbox");
		if (current === null || at < current) ctx.timers.schedule("outbox", at);
	};

	const markCreated = (batchId: string): void => {
		ctx.sql.exec(
			"UPDATE land_batches SET instance_created = 1 WHERE id = ?",
			batchId,
		);
		// The watchdog looks at this batch's instance from now on.
		outboxNoLaterThan(now() + WATCHDOG_MS);
	};

	const holdsAdvance = (batchId: string): boolean =>
		first<{ n: number }>(
			ctx.sql,
			`SELECT 1 AS n FROM advances WHERE batch_id = ? AND state IN ('locked','pushing')`,
			batchId,
		) !== null;

	/**
	 * The batch watchdog: a live batch whose
	 * LandWorkflow instance ended (errored, terminated, complete or missing)
	 * without ending it is ended `failed` with reason `abandoned`, which
	 * releases its lanes and emits `land.failed` (the queue requeues). A
	 * batch holding an in-flight advance is the K5 sweeper's.
	 */
	const watchdog = async (): Promise<{ abandoned: string[] }> => {
		const live = rows<LandBatchRow>(
			ctx.sql,
			`SELECT * FROM land_batches
			 WHERE instance_created = 1 AND state NOT IN ${TERMINAL_SQL} AND created_at <= ?
			 ORDER BY created_at LIMIT ?`,
			now() - WATCHDOG_GRACE_MS,
			WATCHDOG_BATCH,
		);
		const abandoned: string[] = [];
		for (const batch of live) {
			if (holdsAdvance(batch.id)) continue;
			let status: string;
			try {
				status = await ctx.ports.instanceStatus(batch.instance_id);
			} catch (error) {
				ctx.ports.log("watchdog: instance status failed", {
					batchId: batch.id,
					error: errorText(error),
				});
				continue;
			}
			if (!TERMINAL_INSTANCE.has(status)) continue;
			const ended = ctx.tx(() => {
				const again = batchRow(ctx, batch.id);
				if (
					again === null || isTerminal(again.state) || holdsAdvance(batch.id)
				) {
					return false;
				}
				endBatch(again, "failed", {
					reason: "abandoned",
					message: `the LandWorkflow instance is ${status}`,
				});
				return true;
			});
			if (ended) abandoned.push(batch.id);
		}
		return { abandoned };
	};

	const createInstance = async (batch: LandBatchRow): Promise<boolean> => {
		try {
			await ctx.ports.createInstance(batch.instance_id, {
				repoId: repoIds(ctx).repoId,
				batchId: batch.id,
			});
			markCreated(batch.id);
			return true;
		} catch (error) {
			ctx.ports.log("land instance create failed", {
				batchId: batch.id,
				error: errorText(error),
			});
			ctx.timers.schedule("outbox", now() + OUTBOX_RETRY_MS);
			return false;
		}
	};

	/**
	 * The `outbox` timer: create every instance still missing, then the
	 * watchdog. It reschedules itself while instances are missing (30 s) or
	 * live batches remain (10 min).
	 */
	const sweepOutbox = async (): Promise<
		{ created: number; left: number; abandoned: string[] }
	> => {
		const pending = rows<LandBatchRow>(
			ctx.sql,
			`SELECT * FROM land_batches WHERE instance_created = 0
			 ORDER BY created_at LIMIT 50`,
		);
		let created = 0;
		for (const batch of pending) {
			if (isTerminal(batch.state)) {
				markCreated(batch.id);
				continue;
			}
			if (await createInstance(batch)) created++;
		}
		const { abandoned } = await watchdog();
		const left = first<{ n: number }>(
			ctx.sql,
			"SELECT COUNT(*) AS n FROM land_batches WHERE instance_created = 0",
		)?.n ?? 0;
		if (left > 0) ctx.timers.schedule("outbox", now() + OUTBOX_RETRY_MS);
		else if (liveCreated() > 0) {
			ctx.timers.schedule("outbox", now() + WATCHDOG_MS);
		}
		return { created, left, abandoned };
	};

	// -----------------------------------------------------------------------
	// submit
	// -----------------------------------------------------------------------

	const gateBatchHad = (batchId: string, changeId: string, head: string) =>
		first<{ n: number }>(
			ctx.sql,
			`SELECT 1 AS n FROM land_changes WHERE batch_id = ? AND change_id = ? AND head = ?`,
			batchId,
			changeId,
			head,
		) !== null;

	const validateLanes = (changes: readonly LandChange[]): void => {
		for (const change of changes) {
			const lane = ctx.core.laneSync(change.laneId);
			if (lane === null) throw invalid(`unknown lane: ${change.laneId}`);
			if (lane.quarantined === 1) {
				throw conflict(`lane-quarantined: lane ${lane.id} is quarantined`, {
					code: "lane-quarantined",
					laneId: lane.id,
				});
			}
			if (lane.state !== "submitted") {
				throw conflict(
					`lane-${lane.state}: lane ${lane.id} is ${lane.state}, not submitted`,
					{ code: `lane-${lane.state}`, laneId: lane.id },
				);
			}
			if (lane.head_sha !== change.head) {
				throw conflict(
					`head-moved: lane ${lane.id} is at ${
						lane.head_sha ?? "nothing"
					}, not ${change.head}`,
					{ code: "head-moved", laneId: lane.id },
				);
			}
			if (lane.change_id !== null && lane.change_id !== change.changeId) {
				throw conflict(
					`change-mismatch: lane ${lane.id} carries change ${lane.change_id}`,
					{ code: "change-mismatch", laneId: lane.id },
				);
			}
		}
	};

	const submit = async (
		input: unknown,
		requestedBy: string,
	): Promise<{ batchId: string; created: boolean }> => {
		const parsed = LandRequestSchema.safeParse(input);
		if (!parsed.success) {
			throw invalid(
				`invalid land request: ${
					parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)
						.slice(0, 3).join("; ")
				}`,
			);
		}
		const request = parsed.data;
		if (typeof requestedBy !== "string" || requestedBy.length === 0) {
			throw invalid("requestedBy is required");
		}
		const ids = repoIds(ctx);
		if ("id" in request.repo && request.repo.id !== ids.repoId) {
			throw invalid("the request names another repo");
		}
		if (request.ref !== ids.trunkRef) {
			throw invalid(`only ${ids.trunkRef} lands (the default branch)`);
		}
		const changeIds = request.batch.map((c) => c.changeId);
		const laneIds = request.batch.map((c) => c.laneId);
		if (new Set(changeIds).size !== changeIds.length) {
			throw invalid("a change is listed twice");
		}
		if (new Set(laneIds).size !== laneIds.length) {
			throw invalid("a lane is listed twice");
		}
		const hash = await requestHashOf(request);
		const known = batchRow(ctx, request.batchId);
		if (known !== null) {
			if (known.request_hash !== hash) {
				throw conflict(
					`batch-exists: batch ${request.batchId} exists with other content`,
					{ code: "batch-exists" },
				);
			}
			if (known.instance_created === 0) await createInstance(known);
			return { batchId: known.id, created: false };
		}
		let provider: string | null | undefined;
		try {
			provider = await ctx.ports.reviewProvider(ids.nodeId);
		} catch (error) {
			ctx.ports.log("review provider lookup failed", {
				error: errorText(error),
			});
			throw unavailable("the registry cannot name the review provider");
		}
		// K13.2/K13.3 (WP23): a policy-touching change needs its kernel sign-off.
		const policy = await checkPolicyAtSubmit(ctx, request.batch, ids.nodeId);
		const instanceId = landInstanceId(ids.repoId, request.batchId);
		const outcome = ctx.tx(() => {
			const again = batchRow(ctx, request.batchId);
			if (again !== null) return { row: again, created: false };
			if (ctx.core.metaSync("import_state") === "importing") {
				throw conflict("importing: the repo is importing", {
					code: "importing",
				});
			}
			if (ctx.core.metaSync("landing_paused") === "1") {
				throw denied(
					"landing-paused",
					"landing is paused until an Owner acknowledges a tampered ref",
				);
			}
			const base = indexSha(ctx, ids.trunkRef);
			if (base === null) throw conflict("trunk has no commit yet");
			validateLanes(request.batch);
			const reasonIds = [...new Set(request.reason.events)];
			const found = ctx.events.getSync(reasonIds);
			const issues = reasonChainIssues({
				changes: request.batch,
				ids: reasonIds,
				found,
				reviewProvider: provider,
				gateBatchHad,
			});
			if (issues.length > 0) {
				throw invalid(
					`reason-chain: ${issues.map((i) => i.message).join("; ")}`,
					{ code: "reason-chain", issues },
				);
			}
			// The kernel pins the sign-off into the reason chain itself (K4).
			const signoffs = pinPolicySignoffsSync(ctx, policy);
			const chain = [...new Set([...reasonIds, ...signoffs])];
			ctx.events.pinSync(chain);
			for (const change of request.batch) {
				ctx.core.setLaneStateSync(change.laneId, "landing");
			}
			const at = now();
			ctx.sql.exec(
				`INSERT INTO land_batches (id, instance_id, ref, instance_created, requested_by,
				   partition_key, base_sha, attempt, candidate_sha, changes_json, reason_json,
				   affected_json, test_policy, state, result_json, request_hash, created_at, finished_at)
				 VALUES (?, ?, ?, 0, ?, ?, ?, 1, NULL, ?, ?, NULL, ?, 'composing', NULL, ?, ?, NULL)`,
				request.batchId,
				instanceId,
				request.ref,
				requestedBy,
				request.partitionKey ?? null,
				base,
				JSON.stringify(request.batch),
				JSON.stringify({ ...request.reason, events: chain }),
				request.testPolicy,
				hash,
				at,
			);
			request.batch.forEach((change, position) => {
				ctx.sql.exec(
					`INSERT INTO land_changes (batch_id, change_id, lane_id, position, head, outcome)
					 VALUES (?, ?, ?, ?, ?, 'pending')`,
					request.batchId,
					change.changeId,
					change.laneId,
					position,
					change.head,
				);
			});
			emit(ctx, {
				type: "land.submitted",
				idemKey: `land:${request.batchId}:submitted`,
				subject: { kind: "land", id: request.batchId },
				data: {
					batchId: request.batchId,
					attempt: 1,
					ref: request.ref,
					changes: request.batch.map((c) => ({
						changeId: c.changeId,
						laneId: c.laneId,
						head: c.head,
					})),
					reasonEvents: chain,
					requestedBy,
					testPolicy: request.testPolicy,
					...(request.partitionKey !== undefined
						? { partitionKey: request.partitionKey }
						: {}),
				},
			});
			return {
				row: batchRow(ctx, request.batchId) as LandBatchRow,
				created: true,
			};
		});
		if (outcome.row.instance_created === 0) await createInstance(outcome.row);
		return { batchId: request.batchId, created: outcome.created };
	};

	// -----------------------------------------------------------------------
	// Reads
	// -----------------------------------------------------------------------

	const statusOf = (batch: LandBatchRow): LandStatus => {
		const changes = changeRows(ctx, batch.id);
		const advance = first<{ id: string }>(
			ctx.sql,
			"SELECT id FROM advances WHERE batch_id = ? ORDER BY attempt DESC LIMIT 1",
			batch.id,
		);
		return {
			batchId: batch.id,
			repoId: repoIds(ctx).repoId,
			ref: batch.ref,
			state: batch.state,
			attempt: batch.attempt,
			...(batch.candidate_sha !== null
				? { candidateSha: batch.candidate_sha }
				: {}),
			baseSha: batch.base_sha,
			changes: changes.map((c) => ({
				changeId: c.change_id,
				laneId: c.lane_id,
				outcome: c.outcome,
				...(c.commit_sha !== null && c.outcome !== "conflicted"
					? { commit: c.commit_sha }
					: {}),
			})),
			...(advance !== null ? { advanceId: advance.id } : {}),
			...(batch.result_json !== null
				? { result: parseJson(batch.result_json, null) }
				: {}),
			createdAt: batch.created_at,
			...(batch.finished_at !== null ? { finishedAt: batch.finished_at } : {}),
		};
	};

	const status = (batchId: string): LandStatus | null => {
		const batch = batchRow(ctx, String(batchId));
		return batch === null ? null : statusOf(batch);
	};

	const detail = (batchId: string): LandBatchDetail | null => {
		const batch = batchRow(ctx, String(batchId));
		if (batch === null) return null;
		return {
			status: statusOf(batch),
			changes: parseJson<LandChange[]>(batch.changes_json, []),
			reason: parseJson<LandReason>(batch.reason_json, {
				events: [],
				summary: "",
			}),
			testPolicy: batch.test_policy,
			...(batch.partition_key !== null
				? { partitionKey: batch.partition_key }
				: {}),
			requestedBy: batch.requested_by,
		};
	};

	// -----------------------------------------------------------------------
	// compose-n
	// -----------------------------------------------------------------------

	const lookup = async (id: string | null): Promise<PrincipalInfo | null> => {
		if (id === null) return null;
		try {
			return await ctx.ports.principal(id);
		} catch (error) {
			ctx.ports.log("principal lookup failed", {
				principal: id,
				error: errorText(error),
			});
			return null;
		}
	};

	const asTrailerPrincipal = (id: string, info: PrincipalInfo | null) =>
		info ?? {
			id,
			kind: id.startsWith("u_")
				? "user" as const
				: id.startsWith("a_")
				? "agent" as const
				: "system" as const,
			handle: id,
			display: id,
			email: null,
			agentTool: null,
			agentModel: null,
		};

	/** First pushers of `shas` from `commit_firsts` (WP5a's table, read-only). */
	const firstPushersOf = (
		shas: readonly string[],
	): { principal: string; commits: number }[] =>
		shas.length === 0 ? [] : rows<{ principal: string; commits: number }>(
			ctx.sql,
			`SELECT principal_id AS principal, COUNT(*) AS commits FROM commit_firsts
			 WHERE principal_id IS NOT NULL AND sha IN (SELECT value FROM json_each(?))
			 GROUP BY principal_id ORDER BY MIN(at), principal_id`,
			JSON.stringify(shas.filter((s) => isSha(s))),
		);

	const composePlan = async (
		batchId: string,
		attempt: number,
		ranges: readonly ComposeRange[],
	): Promise<ComposePlan> => {
		const batch = requireBatch(ctx, batchId);
		requireAttempt(batch, attempt);
		if (batch.state !== "composing") {
			throw conflict(`batch ${batchId} is ${batch.state}, not composing`);
		}
		const requested = parseJson<LandChange[]>(batch.changes_json, []);
		const pending = changeRows(ctx, batchId).filter((c) =>
			c.outcome === "pending"
		);
		const byChange = new Map(ranges.map((r) => [r.changeId, r]));
		let host = "tartan.invalid";
		try {
			host = (await ctx.ports.canonicalHost()) || host;
		} catch (error) {
			ctx.ports.log("canonical host unknown", { error: errorText(error) });
		}
		const advance = advanceId(batchId, attempt);
		const planned: ComposePlan["changes"][number][] = [];
		const provenance = new Map<string, string>();
		for (const change of pending) {
			const lane = ctx.core.laneSync(change.lane_id);
			if (lane === null) throw conflict(`lane ${change.lane_id} is gone`);
			const req = requested.find((r) => r.changeId === change.change_id);
			if (req === undefined) throw conflict(`change ${change.change_id} lost`);
			const range = byChange.get(change.change_id) ??
				{ changeId: change.change_id, commits: [], truncated: true };
			const owner = asTrailerPrincipal(
				lane.owner_principal,
				await lookup(lane.owner_principal),
			);
			const onBehalf = lane.on_behalf_of === null ? null : asTrailerPrincipal(
				lane.on_behalf_of,
				await lookup(lane.on_behalf_of),
			);
			const others = firstPushersOf(range.commits).filter((p) =>
				p.principal !== lane.owner_principal
			);
			const coAuthors = [];
			for (const p of others) {
				coAuthors.push(
					asTrailerPrincipal(p.principal, await lookup(p.principal)),
				);
			}
			const message = composeSquashMessage({
				title: req.title,
				summary: req.message,
				kernel: {
					changeId: await gerritChangeId(change.change_id),
					...(owner.kind === "agent" ? { agent: agentTrailer(owner) } : {}),
					...(onBehalf !== null ? { onBehalfOf: onBehalf.handle } : {}),
					advance,
					coAuthoredBy: coAuthors.map((p) => coAuthorTrailer(p, host)),
				},
				provider: req.trailers,
			});
			const email = owner.kind === "user" && owner.email !== null
				? owner.email
				: `${owner.kind === "user" ? "user" : "agent"}+${owner.id}@${
					owner.kind === "user" ? "users" : "agents"
				}.${host}`;
			planned.push({
				changeId: change.change_id,
				laneId: change.lane_id,
				head: change.head,
				message,
				author: { name: owner.display || owner.handle, email },
			});
			provenance.set(
				change.change_id,
				JSON.stringify({
					firstPushers: others,
					provenance: range.truncated ? "partial" : "complete",
				}),
			);
		}
		ctx.tx(() => {
			for (const [changeId, json] of provenance) {
				ctx.sql.exec(
					"UPDATE land_changes SET provenance_json = ? WHERE batch_id = ? AND change_id = ?",
					json,
					batchId,
					changeId,
				);
			}
		});
		return {
			date: Math.floor(batch.created_at / 1000),
			committer: { name: "Tartan", email: `tartan@${host}` },
			changes: planned,
		};
	};

	const latestCandidateIntent = (
		batch: LandBatchRow,
	): KernelWriteRow | null =>
		first<KernelWriteRow>(
			ctx.sql,
			`SELECT * FROM kernel_writes WHERE target = 'repo' AND ref = ? AND purpose = 'candidate'
			 AND owner_id = ? ORDER BY created_at DESC LIMIT 1`,
			candidateRef(batch.id),
			batch.instance_id,
		);

	const recordCompose = (
		batchId: string,
		attempt: number,
		candidateSha: string,
		perChange: readonly ComposedChange[],
	): void => {
		if (!isSha(candidateSha)) throw invalid("candidateSha must be a sha");
		ctx.tx(() => {
			const batch = requireBatch(ctx, batchId);
			requireAttempt(batch, attempt);
			if (batch.state !== "composing") {
				if (batch.candidate_sha === candidateSha) return;
				throw conflict(`batch ${batchId} is ${batch.state}, not composing`);
			}
			const changes = changeRows(ctx, batchId);
			// K13.2 (WP23): the composed paths are authoritative.
			const ejections = composeEjectionsSync(
				ctx,
				changes.filter((c) => c.outcome === "pending").map((c) => ({
					changeId: c.change_id,
					laneId: c.lane_id,
					head: c.head,
				})),
				perChange,
			);
			for (const item of perChange) {
				const row = changes.find((c) => c.change_id === item.changeId);
				if (row === undefined) {
					throw invalid(`change ${item.changeId} is not in the batch`);
				}
				if (row.outcome !== "pending") continue;
				const ejection = ejections.get(item.changeId);
				if (ejection !== undefined) {
					ctx.sql.exec(
						`UPDATE land_changes SET outcome = 'vetoed', attempt = ?, commit_sha = NULL,
						   paths_json = ? WHERE batch_id = ? AND change_id = ?`,
						attempt,
						JSON.stringify((item.paths ?? []).slice(0, 5000)),
						batchId,
						item.changeId,
					);
					emit(ctx, {
						type: "land.vetoed",
						idemKey: `land:${batchId}:${attempt}:ejected:${item.changeId}`,
						subject: { kind: "land", id: batchId },
						data: {
							batchId,
							attempt,
							changeId: item.changeId,
							inst: KERNEL_EJECTION_INST,
							ext: "kernel",
							message: `${ejection.code}: ${ejection.message}`.slice(0, 2000),
							code: ejection.code,
						},
					});
					releaseLanes(ctx, [row]);
					continue;
				}
				if (item.commit !== undefined) {
					if (!isSha(item.commit)) throw invalid("commit must be a sha");
					ctx.sql.exec(
						`UPDATE land_changes SET attempt = ?, commit_sha = ?, paths_json = ?, conflict_json = NULL
						 WHERE batch_id = ? AND change_id = ?`,
						attempt,
						item.commit,
						JSON.stringify((item.paths ?? []).slice(0, 5000)),
						batchId,
						item.changeId,
					);
					continue;
				}
				if (item.conflict === undefined) {
					throw invalid(`change ${item.changeId}: commit or conflict`);
				}
				const paths = [...item.conflict.paths].slice(0, 1000);
				ctx.sql.exec(
					`UPDATE land_changes SET outcome = 'conflicted', attempt = ?, commit_sha = NULL,
					   conflict_json = ? WHERE batch_id = ? AND change_id = ?`,
					attempt,
					JSON.stringify(item.conflict),
					batchId,
					item.changeId,
				);
				emit(ctx, {
					type: "land.conflicted",
					idemKey: `land:${batchId}:${attempt}:conflicted:${item.changeId}`,
					subject: { kind: "land", id: batchId },
					data: {
						batchId,
						attempt,
						changeId: item.changeId,
						paths,
						...(item.conflict.regions
							? {
								regions: item.conflict.regions.slice(0, 50).map((r) => ({
									path: r.path,
									regions: r.regions.slice(0, 50),
								})),
							}
							: {}),
						conflictsWith: [...(item.conflict.conflictsWith ?? [])],
					},
				});
				releaseLanes(ctx, [row]);
			}
			const ref = candidateRef(batchId);
			const base = batch.base_sha;
			const previous = indexSha(ctx, ref) ?? ZERO_SHA;
			const latest = latestCandidateIntent(batch);
			if (
				candidateSha !== base && candidateSha !== previous &&
				latest?.new_sha !== candidateSha
			) {
				ctx.core.registerKernelWriteSync({
					target: "repo",
					ref,
					expectOld: previous,
					newSha: candidateSha,
					purpose: "candidate",
					ownerKind: "land",
					ownerId: batch.instance_id,
					...(latest !== null && latest.state === "intent"
						? { supersedes: latest.id }
						: {}),
				});
			}
			ctx.sql.exec(
				"UPDATE land_batches SET candidate_sha = ? WHERE id = ?",
				candidateSha,
				batchId,
			);
		});
	};

	// -----------------------------------------------------------------------
	// gate-n
	// -----------------------------------------------------------------------

	const parseGated = (decisions: readonly unknown[]): GatedChange[] =>
		decisions.map((d) => {
			const g = d as GatedChange;
			if (
				typeof g !== "object" || g === null || typeof g.changeId !== "string" ||
				!Array.isArray(g.effective)
			) {
				throw invalid("a gate decision is {changeId, effective, blocked}");
			}
			return g;
		});

	const recordGates = (
		batchId: string,
		attempt: number,
		decisions: readonly unknown[],
	): void => {
		const gated = parseGated(decisions);
		ctx.tx(() => {
			const batch = requireBatch(ctx, batchId);
			requireAttempt(batch, attempt);
			const changes = changeRows(ctx, batchId);
			for (const change of gated) {
				const row = changes.find((c) => c.change_id === change.changeId);
				if (row === undefined || row.outcome !== "pending") continue;
				for (const e of change.effective) {
					emit(ctx, {
						type: "gate.decided",
						idemKey:
							`land:${batchId}:${attempt}:gate:${change.changeId}:${e.installation}`,
						subject: { kind: "land", id: batchId },
						data: {
							point: "ref.advance",
							inst: e.installation,
							ext: e.ext,
							decision: e.decision,
							mode: e.mode,
							message: e.message.slice(0, 2000),
							batchId,
							changeId: change.changeId,
							truncated: change.truncated,
							basis: e.basis,
						},
					});
				}
				ctx.sql.exec(
					"UPDATE land_changes SET gates_json = ? WHERE batch_id = ? AND change_id = ?",
					JSON.stringify(change.effective.map((e) => ({
						ext: e.ext,
						decision: e.decision,
						mode: e.mode,
						...(e.message ? { message: e.message.slice(0, 2000) } : {}),
					}))),
					batchId,
					change.changeId,
				);
				if (!change.blocked) continue;
				const veto = change.effective.find((e) =>
					e.mode === "enforce" && e.decision === "veto"
				);
				ctx.sql.exec(
					"UPDATE land_changes SET outcome = 'vetoed' WHERE batch_id = ? AND change_id = ?",
					batchId,
					change.changeId,
				);
				emit(ctx, {
					type: "land.vetoed",
					idemKey: `land:${batchId}:${attempt}:vetoed:${change.changeId}`,
					subject: { kind: "land", id: batchId },
					data: {
						batchId,
						attempt,
						changeId: change.changeId,
						inst: veto?.installation ?? "i_00000000000000000000000000",
						...(veto ? { ext: veto.ext } : {}),
						message: (veto?.message ?? "vetoed").slice(0, 2000),
					},
				});
				releaseLanes(ctx, [row]);
			}
		});
	};

	// -----------------------------------------------------------------------
	// States and attempts
	// -----------------------------------------------------------------------

	/** Ends a batch that will not land (lanes back to `submitted`). */
	const endBatch = (
		batch: LandBatchRow,
		state: Exclude<LandBatchState, "landed">,
		result: BatchStateResult | undefined,
	): void => {
		const pending = changeRows(ctx, batch.id).filter((c) =>
			c.outcome === "pending"
		);
		releaseLanes(ctx, pending);
		const reason = result !== undefined && "reason" in result
			? result.reason
			: (FAIL_REASON[state] ?? "error");
		const at = ctx.clock.now();
		ctx.sql.exec(
			`UPDATE land_batches SET state = ?, finished_at = ?, result_json = ? WHERE id = ?`,
			state,
			at,
			JSON.stringify(result ?? { reason }),
			batch.id,
		);
		armCandidateSweep(ctx, at);
		// A held lock that pushed nothing is released with the batch.
		ctx.sql.exec(
			`UPDATE advances SET state = 'released', finished_at = ?
			 WHERE batch_id = ? AND state = 'locked' AND step = 'locked'`,
			at,
			batch.id,
		);
		emit(ctx, {
			type: "land.failed",
			idemKey: `land:${batch.id}:${batch.attempt}:failed`,
			subject: { kind: "land", id: batch.id },
			data: {
				batchId: batch.id,
				attempt: batch.attempt,
				reason,
				...(result !== undefined && "failing" in result && result.failing
					? { failing: [...result.failing].slice(0, 64) }
					: {}),
				...(result !== undefined && "message" in result && result.message
					? { message: result.message.slice(0, 2000) }
					: {}),
			},
		});
	};

	const setBatchState = (
		batchId: string,
		state: LandBatchState,
		result?: unknown,
	): void => {
		ctx.tx(() => {
			const batch = requireBatch(ctx, batchId);
			if (batch.state === state) return;
			if (isTerminal(batch.state)) {
				throw conflict(`batch-ended: batch ${batchId} is ${batch.state}`);
			}
			if (state === "landed") {
				throw invalid("a batch lands only through completeAdvance");
			}
			if (isTerminal(state)) {
				endBatch(
					batch,
					state as Exclude<LandBatchState, "landed">,
					result as BatchStateResult | undefined,
				);
				return;
			}
			if (!STATES_AFTER[batch.state].includes(state)) {
				throw conflict(
					`batch ${batchId} cannot move ${batch.state} → ${state}`,
				);
			}
			if (state === "gating") {
				// The workflow moves on only after the candidate push succeeded.
				const intent = latestCandidateIntent(batch);
				if (
					intent !== null && intent.state === "intent" &&
					intent.new_sha === batch.candidate_sha
				) {
					ctx.core.markKernelWriteSync(intent.id, "pushed");
				}
			}
			if (state === "testing") {
				const affected = result !== undefined &&
						typeof result === "object" && result !== null &&
						"affected" in result && Array.isArray(result.affected)
					? (result.affected as unknown[]).filter((p): p is string =>
						typeof p === "string"
					).slice(0, 2000)
					: ["*"];
				ctx.sql.exec(
					"UPDATE land_batches SET affected_json = ? WHERE id = ?",
					JSON.stringify(affected),
					batchId,
				);
				if (batch.candidate_sha === null) {
					throw conflict(`batch ${batchId} has no candidate`);
				}
				emit(ctx, {
					type: "land.testing",
					idemKey: `land:${batchId}:${batch.attempt}:testing`,
					subject: { kind: "land", id: batchId },
					data: {
						batchId,
						attempt: batch.attempt,
						candidateSha: batch.candidate_sha,
						base: batch.base_sha,
						affected,
					},
				});
			}
			ctx.sql.exec(
				"UPDATE land_batches SET state = ? WHERE id = ?",
				state,
				batchId,
			);
		});
	};

	const nextAttempt = (
		batchId: string,
		reason: "stale" | "vetoed",
	): { attempt: number } | { exhausted: true } =>
		ctx.tx(() => {
			const batch = requireBatch(ctx, batchId);
			if (isTerminal(batch.state)) {
				throw conflict(`batch-ended: batch ${batchId} is ${batch.state}`);
			}
			const pending = changeRows(ctx, batchId).filter((c) =>
				c.outcome === "pending"
			);
			if (pending.length === 0) {
				endBatch(batch, reason === "vetoed" ? "vetoed" : "failed", {
					reason,
				});
				return { exhausted: true as const };
			}
			if (batch.attempt >= MAX_LAND_ATTEMPTS) {
				endBatch(batch, "failed", { reason });
				return { exhausted: true as const };
			}
			const next = batch.attempt + 1;
			const trunk = indexSha(ctx, batch.ref) ?? batch.base_sha;
			ctx.sql.exec(
				`UPDATE land_batches SET attempt = ?, candidate_sha = NULL, base_sha = ?, state = 'composing'
				 WHERE id = ?`,
				next,
				trunk,
				batchId,
			);
			ctx.sql.exec(
				`UPDATE land_changes SET commit_sha = NULL, paths_json = NULL
				 WHERE batch_id = ? AND outcome = 'pending'`,
				batchId,
			);
			return { attempt: next };
		});

	// -----------------------------------------------------------------------
	// Verdicts (K14)
	// -----------------------------------------------------------------------

	const report = async (
		batchId: string,
		verdict: LandVerdict,
		reportedBy: string,
	): Promise<{ accepted: boolean; reason?: string }> => {
		const parsed = LandVerdictSchema.safeParse(verdict);
		if (!parsed.success) throw invalid("invalid verdict");
		const v = parsed.data;
		const outcome = ctx.tx((): { accepted: boolean; reason?: string } => {
			const batch = batchRow(ctx, String(batchId));
			if (batch === null) return { accepted: false, reason: "unknown-batch" };
			if (isTerminal(batch.state)) {
				return { accepted: false, reason: "batch-ended" };
			}
			if (v.attempt !== batch.attempt) {
				return { accepted: false, reason: "stale-attempt" };
			}
			if (batch.candidate_sha !== v.candidateSha) {
				return { accepted: false, reason: "wrong-candidate" };
			}
			if (batch.state !== "testing") {
				return { accepted: false, reason: "not-testing" };
			}
			const existing = first<LandVerdictRow>(
				ctx.sql,
				"SELECT * FROM land_verdicts WHERE batch_id = ? AND attempt = ?",
				batch.id,
				v.attempt,
			);
			if (existing !== null) return { accepted: false, reason: "duplicate" };
			let evidence: string | null = null;
			try {
				evidence = v.evidence === undefined
					? null
					: JSON.stringify(v.evidence).slice(0, 16 * 1024);
			} catch {
				evidence = null;
			}
			ctx.sql.exec(
				`INSERT INTO land_verdicts (batch_id, attempt, candidate_sha, state, run_ids_json,
				   evidence_json, reported_by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				batch.id,
				v.attempt,
				v.candidateSha,
				v.state,
				JSON.stringify(v.runIds),
				evidence,
				String(reportedBy),
				ctx.clock.now(),
			);
			return { accepted: true };
		});
		if (outcome.accepted) {
			const batch = requireBatch(ctx, batchId);
			try {
				await ctx.ports.sendEvent(
					batch.instance_id,
					verdictEventType(v.attempt),
					{
						attempt: v.attempt,
						candidateSha: v.candidateSha,
						state: v.state,
						runIds: v.runIds,
					},
				);
			} catch (error) {
				// The workflow's poll steps read land_verdicts (K14 poll fallback).
				ctx.ports.log("verdict sendEvent failed", {
					batchId,
					error: errorText(error),
				});
			}
		}
		return outcome;
	};

	const verdict = (
		batchId: string,
		attempt: number,
		candidateSha: string,
	): LandVerdictRow | null =>
		first<LandVerdictRow>(
			ctx.sql,
			`SELECT * FROM land_verdicts WHERE batch_id = ? AND attempt = ? AND candidate_sha = ?`,
			String(batchId),
			Number(attempt),
			String(candidateSha),
		);

	// -----------------------------------------------------------------------
	// Note sections
	// -----------------------------------------------------------------------

	const contributeNote = (
		changeId: string,
		extId: string,
		section: unknown,
	): void => {
		if (!isChangeId(changeId)) throw invalid(`not a change id: ${changeId}`);
		if (
			typeof extId !== "string" || !/^[a-z0-9][a-z0-9.-]{0,127}$/.test(extId)
		) {
			throw invalid(`invalid extension id: ${extId}`);
		}
		let json: string;
		try {
			json = JSON.stringify(section ?? null);
		} catch {
			throw invalid("section: not JSON");
		}
		if (encoder.encode(json).length > NOTE_SECTION_MAX_BYTES) {
			throw invalid(`section: at most ${NOTE_SECTION_MAX_BYTES} bytes`);
		}
		ctx.sql.exec(
			`INSERT INTO note_sections (change_id, ext_id, section_json, at) VALUES (?, ?, ?, ?)
			 ON CONFLICT (change_id, ext_id) DO UPDATE SET section_json = excluded.section_json, at = excluded.at`,
			changeId,
			extId,
			json,
			ctx.clock.now(),
		);
	};

	/** Marks batches whose candidate ref is gone (deleted, or never pushed). */
	const markCandidatesSwept = (batchIds: readonly string[]): void => {
		for (const id of batchIds) {
			ctx.sql.exec(
				"UPDATE land_batches SET candidate_swept = 1 WHERE id = ?",
				id,
			);
		}
	};

	/**
	 * Candidate refs of batches that ended before `olderThan` and were not
	 * swept yet, oldest first, at most `limit` (the 24 h cleanup). A batch
	 * with no candidate ref left is marked swept here, so each sweep moves
	 * past it.
	 */
	const staleCandidates = (
		olderThan: number,
		limit = 50,
	): { batchId: string; ref: string; sha: string }[] =>
		ctx.tx(() => {
			const out: { batchId: string; ref: string; sha: string }[] = [];
			const gone: string[] = [];
			for (
				const { id } of rows<{ id: string }>(
					ctx.sql,
					`SELECT id FROM land_batches
					 WHERE finished_at IS NOT NULL AND finished_at < ? AND candidate_swept = 0
					 ORDER BY finished_at, id LIMIT ?`,
					olderThan,
					limit,
				)
			) {
				const ref = candidateRef(id);
				const sha = indexSha(ctx, ref);
				if (sha === null) gone.push(id);
				else out.push({ batchId: id, ref, sha });
			}
			markCandidatesSwept(gone);
			return out;
		});

	/** When the oldest unswept ended batch ended; null when none is left. */
	const oldestUnswept = (): number | null =>
		first<{ at: number | null }>(
			ctx.sql,
			`SELECT MIN(finished_at) AS at FROM land_batches
			 WHERE finished_at IS NOT NULL AND candidate_swept = 0`,
		)?.at ?? null;

	return {
		submit,
		status,
		detail,
		composePlan,
		recordCompose,
		recordGates,
		setBatchState,
		nextAttempt,
		report,
		verdict,
		contributeNote,
		sweepOutbox,
		staleCandidates,
		markCandidatesSwept,
		oldestUnswept,
		endBatch,
		statusOf,
	};
};

export type Batches = ReturnType<typeof createBatches>;

export type { LandChangeRow };
