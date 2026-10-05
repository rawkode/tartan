// The Advance's RepoDO half (K1, K5, K14): the
// K5 lock (`beginAdvance`, idempotent per batch and
// attempt, fail-closed base), sub-step bookkeeping with the K1 intents of
// every push registered in the same transaction (`markAdvanceStep`),
// `completeAdvance` (index, push log, `trunk_commits`, landings, lanes,
// `ref.advanced`), release, and the `k5` sweeper.
//
// Intents of an advance are owned by it (`owner_kind = 'land'`, `owner_id`
// = the advance id). A new intent for a ref the advance already has an
// intent for supersedes it (each notes retry and each repair push
// registers its own); the same transition registered again is a no-op (a
// retried Workflow step).

import {
	ADVANCE_LEASE_MS,
	advanceId as advanceIdOf,
	type AdvanceStep,
	changeRef,
	conflict,
	invalid,
	isSha,
	type KernelWritePurpose,
	ROLE,
	ZERO_SHA,
} from "@tartan/contract";
import type {
	AdvanceRow,
	KernelWriteIntent,
	KernelWriteRow,
	LandingRow,
	RepoLandInternal,
} from "@tartan/contract/kernel.ts";
import type { Batches } from "./batches.ts";
import {
	COMPOSED_PATHS_MAX,
	composedTouches,
	KERNEL_EJECTION_INST,
} from "./policy.ts";
import {
	advanceRow,
	armCandidateSweep,
	changeRows,
	emit,
	errorText,
	first,
	indexSha,
	type LandCtx,
	parseJson,
	releaseLanes,
	requireAdvance,
	requireAttempt,
	requireBatch,
	rows,
	TERMINAL_INSTANCE,
} from "./ctx.ts";

export const STEP_ORDER: readonly AdvanceStep[] = [
	"locked",
	"restacked",
	"trunk-pushed",
	"notes-pushed",
	"refs-pushed",
];
const stepIndex = (step: AdvanceStep): number => STEP_ORDER.indexOf(step);

const STEP_MARKS: Partial<Record<AdvanceStep, KernelWritePurpose>> = {
	"trunk-pushed": "trunk",
	"notes-pushed": "notes",
	"refs-pushed": "change-ref",
};

const ADVANCE_PURPOSES: readonly KernelWritePurpose[] = [
	"trunk",
	"notes",
	"change-ref",
];

/** How soon the sweeper looks again at a lease whose owner still runs. */
export const K5_RECHECK_MS = 30_000;

export const createAdvances = (ctx: LandCtx, batches: Batches) => {
	const now = () => ctx.clock.now();

	const inflight = (ref: string): AdvanceRow | null =>
		first<AdvanceRow>(
			ctx.sql,
			"SELECT * FROM advances WHERE ref = ? AND state IN ('locked','pushing')",
			ref,
		);

	const scheduleK5 = (): void => {
		const next = first<{ at: number | null }>(
			ctx.sql,
			"SELECT MIN(lease_until) AS at FROM advances WHERE state IN ('locked','pushing')",
		)?.at ?? null;
		if (next === null) ctx.timers.cancel("k5");
		else ctx.timers.schedule("k5", Math.max(next, now() + 1000));
	};

	const intentsOf = (advanceId: string): KernelWriteRow[] =>
		rows<KernelWriteRow>(
			ctx.sql,
			`SELECT * FROM kernel_writes WHERE owner_kind = 'land' AND owner_id = ?
			 ORDER BY created_at, id`,
			advanceId,
		);

	/** The latest intent of the advance per (purpose, ref). */
	const latestIntents = (advanceId: string): Map<string, KernelWriteRow> => {
		const latest = new Map<string, KernelWriteRow>();
		for (const kw of intentsOf(advanceId)) {
			latest.set(`${kw.purpose}\0${kw.ref}`, kw);
		}
		return latest;
	};

	const registerIntents = (
		adv: AdvanceRow,
		intents: readonly KernelWriteIntent[],
	): void => {
		const latest = latestIntents(adv.id);
		for (const intent of intents) {
			if (!ADVANCE_PURPOSES.includes(intent.purpose)) {
				throw invalid(
					`an advance registers trunk, notes and change-ref writes only`,
				);
			}
			if (intent.target !== "repo") {
				throw invalid("advance writes target the canonical repo");
			}
			if (intent.purpose === "trunk" && intent.ref !== adv.ref) {
				throw invalid(`the trunk intent must name ${adv.ref}`);
			}
			const prev = latest.get(`${intent.purpose}\0${intent.ref}`);
			if (
				prev !== undefined && prev.expect_old === intent.expectOld &&
				prev.new_sha === intent.newSha
			) {
				continue;
			}
			const row = ctx.core.registerKernelWriteSync({
				target: "repo",
				ref: intent.ref,
				expectOld: intent.expectOld,
				newSha: intent.newSha,
				purpose: intent.purpose,
				ownerKind: "land",
				ownerId: adv.id,
				...(prev !== undefined && prev.state === "intent"
					? { supersedes: prev.id }
					: {}),
			});
			latest.set(`${intent.purpose}\0${intent.ref}`, row);
		}
	};

	const markPurposePushed = (adv: AdvanceRow, purpose: KernelWritePurpose) => {
		for (const kw of latestIntents(adv.id).values()) {
			if (kw.purpose === purpose && kw.state === "intent") {
				ctx.core.markKernelWriteSync(kw.id, "pushed");
			}
		}
	};

	// -----------------------------------------------------------------------
	// lock-n
	// -----------------------------------------------------------------------

	type BeginResult =
		| { advanceId: string; expectOld: string }
		| { wait: true }
		| { ejected: string[] }
		| { failed: string };

	/** The batch's pending changes that touch a policy path (paths from compose). */
	const policyChanges = (batchId: string) =>
		changeRows(ctx, batchId).filter((c) =>
			c.outcome === "pending" &&
			composedTouches(
				c.paths_json === null
					? undefined
					: parseJson<string[]>(c.paths_json, []),
			)
		);

	const beginAdvance = async (
		batchId: string,
		attempt: number,
		instanceId: string,
		options: { expectOld?: string } = {},
	): Promise<
		{ advanceId: string; expectOld: string } | { wait: true } | {
			ejected: string[];
		}
	> => {
		const id = advanceIdOf(batchId, attempt);
		const known = advanceRow(ctx, id);
		if (known !== null) return { advanceId: id, expectOld: known.expect_old };
		const batch = requireBatch(ctx, batchId);
		requireAttempt(batch, attempt);
		if (typeof instanceId !== "string" || instanceId !== batch.instance_id) {
			throw invalid("the lock is held by the batch's own instance");
		}
		if (options.expectOld !== undefined && !isSha(options.expectOld)) {
			throw invalid("expectOld must be a sha (zeros when the ref is absent)");
		}
		const remote = options.expectOld !== undefined
			? (options.expectOld === ZERO_SHA ? null : options.expectOld)
			: await ctx.ports.remoteRef(batch.ref);
		// K13.3 at the lock: the sign-off the kernel pinned
		// at submit must still stand, by a signer who is still Maintainer+,
		// when the Advance takes the K5 lock; a revocation or a demotion during
		// the gates, the tests or a K13.1 hold ejects the change.
		const rc = ctx.repoconfig !== null && ctx.repoconfig.enabledSync()
			? ctx.repoconfig
			: null;
		const demoted = new Set<string>();
		if (rc !== null) {
			const nodeId = ctx.core.metaSync("node_id") ??
				ctx.core.metaSync("repo_id") ?? "";
			for (const c of policyChanges(batchId)) {
				const signoff = rc.signoffSync(c.lane_id, c.head);
				if (signoff === null) continue; // refused in the transaction
				const role = ctx.ports.roleOf === undefined
					? 0
					: await ctx.ports.roleOf(signoff.signedBy, nodeId);
				if (role < ROLE.maintainer) demoted.add(c.change_id);
			}
		}
		const outcome = ctx.tx((): BeginResult => {
			const again = advanceRow(ctx, id);
			if (again !== null) return { advanceId: id, expectOld: again.expect_old };
			const current = requireBatch(ctx, batchId);
			requireAttempt(current, attempt);
			if (!["gating", "testing"].includes(current.state)) {
				throw conflict(`batch ${batchId} is ${current.state}: nothing to lock`);
			}
			if (rc !== null) {
				const pinned = new Set(
					parseJson<{ events?: string[] }>(current.reason_json, {}).events ??
						[],
				);
				const ejected: string[] = [];
				for (const c of policyChanges(batchId)) {
					const signoff = rc.signoffSync(c.lane_id, c.head);
					const why = signoff === null
						? "the policy sign-off of this head was revoked"
						: !pinned.has(signoff.eventId)
						? "the policy sign-off was replaced after the batch was submitted"
						: demoted.has(c.change_id)
						? `${signoff.signedBy}, who signed off the policy change, is no longer a Maintainer here`
						: null;
					if (why === null) continue;
					ctx.sql.exec(
						"UPDATE land_changes SET outcome = 'vetoed', attempt = ? WHERE batch_id = ? AND change_id = ?",
						attempt,
						batchId,
						c.change_id,
					);
					emit(ctx, {
						type: "land.vetoed",
						idemKey: `land:${batchId}:${attempt}:ejected:${c.change_id}`,
						subject: { kind: "land", id: batchId },
						data: {
							batchId,
							attempt,
							changeId: c.change_id,
							inst: KERNEL_EJECTION_INST,
							ext: "kernel",
							message: `policy-signoff: ${why} (K13.3)`.slice(0, 2000),
							code: "policy-signoff",
						},
					});
					releaseLanes(ctx, [c]);
					ejected.push(c.change_id);
				}
				if (ejected.length > 0) return { ejected };
			}
			if (current.candidate_sha === null) {
				throw conflict(`batch ${batchId} has no candidate`);
			}
			if (current.test_policy === "checks") {
				const passed = first<{ n: number }>(
					ctx.sql,
					`SELECT 1 AS n FROM land_verdicts WHERE batch_id = ? AND attempt = ?
					 AND candidate_sha = ? AND state = 'success'`,
					batchId,
					attempt,
					current.candidate_sha,
				);
				if (passed === null) {
					throw conflict(
						`batch ${batchId}: no passing verdict for this candidate`,
					);
				}
			}
			const held = inflight(current.ref);
			if (held !== null) return { wait: true };
			const index = indexSha(ctx, current.ref);
			if (remote !== index) {
				// The remote is adopted only when the ledger explains it.
				const explained = remote !== null &&
					ctx.core.explainsSync(current.ref, remote);
				ctx.core.observeSync({
					target: "repo",
					repoName: null,
					ref: current.ref,
					before: index ?? ZERO_SHA,
					after: remote ?? ZERO_SHA,
				});
				if (!explained || indexSha(ctx, current.ref) !== remote) {
					ctx.core.setLandingPausedSync(true);
					batches.endBatch(current, "failed", {
						reason: "trunk-unexplained",
						message: `${current.ref} is ${remote ?? "absent"} upstream, ${
							index ?? "absent"
						} in the index`,
					});
					return { failed: remote ?? "absent" };
				}
			}
			const expectOld = indexSha(ctx, current.ref);
			if (expectOld === null) throw conflict("trunk has no commit");
			const gates = changeRows(ctx, batchId)
				.filter((c) => c.outcome === "pending")
				.map((c) => ({
					changeId: c.change_id,
					gates: parseJson(c.gates_json, []),
				}));
			const head = ctx.events.headSync();
			const at = now();
			ctx.sql.exec(
				`INSERT INTO advances (id, batch_id, attempt, ref, expect_old, new_sha, owner_instance,
				   lease_until, step, state, evidence_reused, gate_results_json, chain_seq, chain_head,
				   created_at, finished_at)
				 VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'locked', 'locked', 0, ?, ?, ?, ?, NULL)`,
				id,
				batchId,
				attempt,
				current.ref,
				expectOld,
				instanceId,
				at + ADVANCE_LEASE_MS,
				JSON.stringify(gates),
				head.seq,
				head.hash,
				at,
			);
			ctx.sql.exec(
				"UPDATE land_batches SET state = 'advancing' WHERE id = ?",
				batchId,
			);
			scheduleK5();
			return { advanceId: id, expectOld };
		});
		if ("failed" in outcome) {
			throw conflict(
				`trunk-unexplained: ${batch.ref} upstream (${outcome.failed}) is not explained by the ledger; landing is paused`,
				{ code: "trunk-unexplained" },
			);
		}
		return outcome;
	};

	// -----------------------------------------------------------------------
	// Sub-steps
	// -----------------------------------------------------------------------

	const markAdvanceStep = (
		advanceId: string,
		step: AdvanceStep,
		update: {
			newSha?: string;
			evidenceReused?: boolean;
			intents?: readonly KernelWriteIntent[];
		} = {},
	): void => {
		if (!STEP_ORDER.includes(step)) throw invalid(`unknown step: ${step}`);
		if (update.newSha !== undefined && !isSha(update.newSha)) {
			throw invalid("newSha must be a sha");
		}
		ctx.tx(() => {
			const adv = requireAdvance(ctx, advanceId);
			if (adv.state !== "locked" && adv.state !== "pushing") {
				throw conflict(
					`advance-${adv.state}: advance ${advanceId} is ${adv.state}`,
					{
						code: `advance-${adv.state}`,
					},
				);
			}
			let current = adv;
			if (step === "restacked" && current.new_sha === null) {
				if (update.newSha === undefined) {
					throw invalid("restacked needs newSha");
				}
				ctx.sql.exec(
					`UPDATE advances SET new_sha = ?, state = 'pushing', evidence_reused = ? WHERE id = ?`,
					update.newSha,
					update.evidenceReused ? 1 : 0,
					advanceId,
				);
				current = requireAdvance(ctx, advanceId);
			} else if (
				update.newSha !== undefined && current.new_sha !== update.newSha
			) {
				throw conflict(
					`advance ${advanceId} already restacked to ${current.new_sha}`,
				);
			}
			if (stepIndex(step) > stepIndex("locked") && current.new_sha === null) {
				throw conflict(`advance ${advanceId} has not restacked`);
			}
			if (update.intents !== undefined && update.intents.length > 0) {
				registerIntents(current, update.intents);
			}
			if (stepIndex(step) > stepIndex(current.step)) {
				ctx.sql.exec(
					"UPDATE advances SET step = ? WHERE id = ?",
					step,
					advanceId,
				);
			}
			const purpose = STEP_MARKS[step];
			if (purpose !== undefined) markPurposePushed(current, purpose);
			ctx.sql.exec(
				"UPDATE advances SET lease_until = ? WHERE id = ?",
				now() + ADVANCE_LEASE_MS,
				advanceId,
			);
			scheduleK5();
		});
	};

	// -----------------------------------------------------------------------
	// complete-n
	// -----------------------------------------------------------------------

	/** `trunk_commits.seq` of a landed commit (WP5a's table, read-only). */
	const trunkSeqOf = (sha: string): number => {
		const row = first<{ seq: number }>(
			ctx.sql,
			"SELECT seq FROM trunk_commits WHERE sha = ?",
			sha,
		);
		if (row === null) throw conflict(`${sha} is not on trunk`);
		return row.seq;
	};

	/** Completes an advance; returns the lanes it moved to `landed`. */
	const completeAdvanceSync = (advanceId: string): string[] =>
		ctx.tx(() => {
			const adv = requireAdvance(ctx, advanceId);
			if (adv.state === "done") return [];
			if (adv.state !== "locked" && adv.state !== "pushing") {
				throw conflict(
					`advance-${adv.state}: advance ${advanceId} is ${adv.state}`,
				);
			}
			if (adv.new_sha === null) {
				throw conflict(`advance ${advanceId} has not restacked`);
			}
			const newSha = adv.new_sha;
			const index = indexSha(ctx, adv.ref);
			if (index !== adv.expect_old && index !== newSha) {
				throw conflict(
					`trunk-unexplained: ${adv.ref} is ${index ?? "absent"} in the index`,
				);
			}
			const trunkIntent = [...latestIntents(adv.id).values()].find((kw) =>
				kw.purpose === "trunk"
			);
			if (trunkIntent === undefined) {
				throw conflict(`advance ${advanceId} registered no trunk write`);
			}
			if (trunkIntent.state === "intent" || trunkIntent.state === "abandoned") {
				ctx.core.markKernelWriteSync(trunkIntent.id, "pushed");
			} else {
				ctx.core.applyKernelWriteSync(trunkIntent.id);
			}
			const batch = requireBatch(ctx, adv.batch_id);
			const all = changeRows(ctx, batch.id);
			const landed = all.filter((c) =>
				c.outcome === "pending" && c.commit_sha !== null &&
				c.attempt === adv.attempt
			);
			ctx.core.recordLandingSync({
				trunkCommits: landed.map((c) => c.commit_sha as string),
				landedLaneIds: landed.map((c) => c.lane_id),
			});
			const at = now();
			const moved: string[] = [];
			for (const change of landed) {
				const commit = change.commit_sha as string;
				ctx.sql.exec(
					`INSERT OR IGNORE INTO landings (commit_sha, advance_id, change_id, lane_id, lane_head,
					   trunk_seq, paths_json, projects_json, at) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?)`,
					commit,
					adv.id,
					change.change_id,
					change.lane_id,
					change.head,
					trunkSeqOf(commit),
					change.paths_json ?? "[]",
					at,
				);
				ctx.sql.exec(
					"UPDATE land_changes SET outcome = 'landed' WHERE batch_id = ? AND change_id = ?",
					batch.id,
					change.change_id,
				);
				const lane = ctx.core.laneSync(change.lane_id);
				if (lane?.state === "landing") {
					// A lane whose head moved under the freeze (only a
					// foreign write, which K2 quarantines) is reopened, never
					// closed, so nothing it carries is dropped.
					const same = lane.head_sha === change.head;
					ctx.core.setLaneStateSync(lane.id, same ? "landed" : "open");
					if (same) moved.push(lane.id);
				}
			}
			// K13.1: a landed policy path (a root `*.cue` file, or an unknown or
			// capped path list) makes repository config pending and holds this
			// repo's lands.
			ctx.repoconfig?.onAdvanceSync({
				sha: newSha,
				changes: landed.map((c) => {
					const paths = c.paths_json === null
						? null
						: parseJson<string[] | null>(c.paths_json, null);
					return {
						changeId: c.change_id,
						laneId: c.lane_id,
						head: c.head,
						commit: c.commit_sha as string,
						paths,
						capped: paths === null || paths.length >= COMPOSED_PATHS_MAX,
					};
				}),
			});
			ctx.sql.exec(
				`UPDATE advances SET state = 'done', finished_at = ?, lease_until = ? WHERE id = ?`,
				at,
				at,
				adv.id,
			);
			const result = {
				landed: landed.map((c) => ({
					changeId: c.change_id,
					commit: c.commit_sha as string,
				})),
				conflicted: all.filter((c) => c.outcome === "conflicted").map((c) =>
					c.change_id
				),
				vetoed: all.filter((c) => c.outcome === "vetoed").map((c) =>
					c.change_id
				),
			};
			ctx.sql.exec(
				`UPDATE land_batches SET state = 'landed', finished_at = ?, result_json = ? WHERE id = ?`,
				at,
				JSON.stringify(result),
				batch.id,
			);
			armCandidateSweep(ctx, at);
			const reason = parseJson<{ events: string[] }>(batch.reason_json, {
				events: [],
			});
			emit(ctx, {
				type: "ref.advanced",
				idemKey: `land:${adv.id}:advanced`,
				subject: { kind: "land", id: batch.id },
				data: {
					ref: adv.ref,
					old: adv.expect_old,
					new: newSha,
					advanceId: adv.id,
					changes: landed.map((c) => ({
						changeId: c.change_id,
						laneId: c.lane_id,
						commit: c.commit_sha as string,
					})),
					reasonEvents: [...new Set(reason.events)],
					evidenceReused: adv.evidence_reused === 1,
				},
			});
			emit(ctx, {
				type: "land.completed",
				idemKey: `land:${batch.id}:${adv.attempt}:completed`,
				subject: { kind: "land", id: batch.id },
				data: { batchId: batch.id, attempt: adv.attempt, ...result },
			});
			scheduleK5();
			return moved;
		});

	const closeLanded = (laneIds: readonly string[]): Promise<void> =>
		Promise.all(
			laneIds.map((laneId) =>
				ctx.ports.closeLane(laneId, "landed").catch((error) =>
					ctx.ports.log("closing a landed lane failed", {
						laneId,
						error: errorText(error),
					})
				)
			),
		).then(() => undefined);

	const completeAdvance = (advanceId: string): void => {
		completeAdvanceSync(advanceId);
	};

	// -----------------------------------------------------------------------
	// Release (stale, abandoned)
	// -----------------------------------------------------------------------

	const releaseSync = (adv: AdvanceRow, reason: string): void => {
		const stale = reason === "stale" || reason.startsWith("stale ");
		const actual = stale ? reason.slice("stale ".length).trim() : "";
		const at = now();
		ctx.sql.exec(
			"UPDATE advances SET state = ?, finished_at = ? WHERE id = ?",
			stale ? "stale" : "released",
			at,
			adv.id,
		);
		for (const kw of intentsOf(adv.id)) {
			if (kw.state === "intent") {
				ctx.core.markKernelWriteSync(kw.id, "abandoned");
			}
		}
		if (stale) {
			emit(ctx, {
				type: "advance.stale",
				idemKey: `land:${adv.id}:stale`,
				subject: { kind: "land", id: adv.batch_id },
				data: {
					batchId: adv.batch_id,
					attempt: adv.attempt,
					expectOld: adv.expect_old,
					actual: isSha(actual) ? actual : null,
				},
			});
		} else {
			emit(ctx, {
				type: "advance.released",
				idemKey: `land:${adv.id}:released`,
				subject: { kind: "land", id: adv.batch_id },
				data: {
					advanceId: adv.id,
					batchId: adv.batch_id,
					reason: reason.slice(0, 500),
				},
			});
		}
		scheduleK5();
	};

	/** `reason` is `stale <actual sha>` (or `stale`) for `advance.stale`, else free text. */
	const releaseAdvance = (advanceId: string, reason: string): void => {
		ctx.tx(() => {
			const adv = requireAdvance(ctx, advanceId);
			if (adv.state !== "locked" && adv.state !== "pushing") return;
			if (adv.step !== "locked" && adv.step !== "restacked") {
				const remoteMoved = indexSha(ctx, adv.ref) === adv.new_sha;
				if (remoteMoved) {
					throw conflict(
						`advance ${advanceId} pushed trunk: it completes, it is not released`,
					);
				}
			}
			releaseSync(adv, String(reason));
		});
	};

	// -----------------------------------------------------------------------
	// The `k5` sweeper
	// -----------------------------------------------------------------------

	const sweep = async (): Promise<{
		completed: string[];
		released: string[];
		failed: string[];
		waiting: string[];
	}> => {
		const due = rows<AdvanceRow>(
			ctx.sql,
			`SELECT * FROM advances WHERE state IN ('locked','pushing') AND lease_until <= ?
			 ORDER BY lease_until LIMIT 20`,
			now(),
		);
		const out = {
			completed: [] as string[],
			released: [] as string[],
			failed: [] as string[],
			waiting: [] as string[],
		};
		for (const adv of due) {
			let state: string;
			try {
				state = await ctx.ports.instanceStatus(adv.owner_instance);
			} catch (error) {
				ctx.ports.log("k5: instance status failed", {
					advanceId: adv.id,
					error: errorText(error),
				});
				out.waiting.push(adv.id);
				continue;
			}
			if (!TERMINAL_INSTANCE.has(state)) {
				out.waiting.push(adv.id);
				continue;
			}
			let remote: string | null;
			try {
				remote = await ctx.ports.remoteRef(adv.ref);
			} catch (error) {
				ctx.ports.log("k5: remote read failed", {
					advanceId: adv.id,
					error: errorText(error),
				});
				out.waiting.push(adv.id);
				continue;
			}
			const current = advanceRow(ctx, adv.id);
			if (current === null || !["locked", "pushing"].includes(current.state)) {
				continue;
			}
			if (current.new_sha !== null && remote === current.new_sha) {
				const lanes = completeAdvanceSync(current.id);
				out.completed.push(current.id);
				const repoId = ctx.core.metaSync("repo_id") ?? "";
				ctx.ports.waitUntil(
					ctx.ports.gitJobs().repair(repoId, current.id).catch((error) =>
						ctx.ports.log("k5: repair failed", {
							advanceId: current.id,
							error: errorText(error),
						})
					),
				);
				ctx.ports.waitUntil(closeLanded(lanes));
				continue;
			}
			if (remote === current.expect_old) {
				ctx.tx(() => {
					const again = requireAdvance(ctx, current.id);
					if (!["locked", "pushing"].includes(again.state)) return;
					releaseSync(again, "abandoned: the owner instance ended");
					const batch = requireBatch(ctx, again.batch_id);
					if (batch.state === "advancing") {
						batches.endBatch(batch, "failed", { reason: "abandoned" });
					}
				});
				out.released.push(current.id);
				continue;
			}
			// Anything else is the K1 path: never adopted, landing paused.
			ctx.tx(() => {
				const again = requireAdvance(ctx, current.id);
				if (!["locked", "pushing"].includes(again.state)) return;
				ctx.core.observeSync({
					target: "repo",
					repoName: null,
					ref: again.ref,
					before: indexSha(ctx, again.ref) ?? ZERO_SHA,
					after: remote ?? ZERO_SHA,
				});
				ctx.core.setLandingPausedSync(true);
				ctx.sql.exec(
					"UPDATE advances SET state = 'failed', finished_at = ? WHERE id = ?",
					now(),
					again.id,
				);
				const batch = requireBatch(ctx, again.batch_id);
				if (batch.state === "advancing") {
					batches.endBatch(batch, "failed", {
						reason: "trunk-unexplained",
						message: `${again.ref} is ${remote ?? "absent"} upstream`,
					});
				}
				scheduleK5();
			});
			out.failed.push(current.id);
		}
		if (out.waiting.length > 0) {
			ctx.timers.schedule("k5", now() + K5_RECHECK_MS);
		} else {
			ctx.tx(() => scheduleK5());
		}
		return out;
	};

	// -----------------------------------------------------------------------
	// Internal (sync, for sibling modules)
	// -----------------------------------------------------------------------

	const internal: RepoLandInternal = {
		inflightAdvanceSync: (ref) => inflight(ref),
		advanceSync: (id) => advanceRow(ctx, id),
		landingsSinceSync: (trunkSeq) =>
			rows<LandingRow>(
				ctx.sql,
				"SELECT * FROM landings WHERE trunk_seq > ? ORDER BY trunk_seq LIMIT 1000",
				trunkSeq,
			),
		landingByLaneSync: (laneId) =>
			first<LandingRow>(
				ctx.sql,
				"SELECT * FROM landings WHERE lane_id = ? ORDER BY trunk_seq DESC LIMIT 1",
				laneId,
			),
	};

	/** The change ref every landed change of an advance should have upstream. */
	const changeRefsOf = (advanceId: string): { ref: string; head: string }[] =>
		rows<{ change_id: string; lane_head: string }>(
			ctx.sql,
			"SELECT change_id, lane_head FROM landings WHERE advance_id = ? ORDER BY trunk_seq",
			advanceId,
		).map((l) => ({ ref: changeRef(l.change_id), head: l.lane_head }));

	return {
		beginAdvance,
		markAdvanceStep,
		completeAdvance,
		completeAdvanceSync,
		closeLanded,
		releaseAdvance,
		sweep,
		internal,
		intentsOf,
		changeRefsOf,
		registerIntents,
	};
};

export type Advances = ReturnType<typeof createAdvances>;
