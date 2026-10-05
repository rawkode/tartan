// Two-phase push recording (K3, K17):
// - phase 1, `recordPush`: I/O-free; merges by the cross-channel rule, CASes the index and the
//   lane head (a miss reconciles afterwards instead of throwing), renews the
//   lease, clears a K2 quarantine ⇒ slim `push.accepted` per ref;
// - phase 2, `recordDiff`: the lane range `rangeBase..after` from WP8's
//   RepoProbe ⇒ `push.diffed`; `lanes.base_sha` follows a non-truncated
//   range; `commit_firsts` records first pushers. The `diff` timer re-runs
//   phase 2 for rows still `pending` after `DIFF_BACKSTOP_MS`, and
//   `laneRange` runs or awaits it for a lane's head.

import {
	diffKey,
	invalid,
	isIdOf,
	isPrincipalId,
	isSha,
	isValidRefName,
	type LaneRange,
	notFound,
	PUSH_COMMITS_MAX,
	PUSH_PATHS_MAX,
	truncateChars,
} from "@tartan/contract";
import type {
	DiffResult,
	LaneRow,
	PushCommand,
	PushReport,
	PushRow,
	PushVia,
	RecordPushResult,
} from "@tartan/contract/kernel.ts";
import { DIFF_BACKSTOP_MS } from "../../constants.ts";
import {
	actorOf,
	type Core,
	emit,
	errorText,
	first,
	isImporting,
	repoIdentity,
	rows,
} from "./core.ts";
import { laneRow } from "./lanes/rows.ts";
import {
	CANONICAL,
	canonicalTarget,
	diffStateFor,
	laneRepoSide,
} from "./refs.ts";
import {
	addSeen,
	appendAccepted,
	applyTransition,
	ATTRIBUTING,
	insertPush,
	mergeCandidate,
	movesLaneHead,
	pushByRequest,
	pushRow,
	type Transition,
} from "./transitions.ts";

const RECORDABLE_VIA: readonly PushVia[] = ["gateway", "swarm", "kernel"];

/** What phase 1 leaves for after its transaction (reconciliation of CAS misses). */
export type RecordPushOutcome = RecordPushResult & {
	readonly missedRefs: readonly string[];
	readonly missedLanes: readonly string[];
	readonly pending: boolean;
};

const validateReport = (report: PushReport): void => {
	if (!RECORDABLE_VIA.includes(report.via)) {
		throw invalid(`recordPush does not take via=${report.via}`);
	}
	if (
		typeof report.requestId !== "string" || report.requestId.length === 0 ||
		report.requestId.length > 200
	) {
		throw invalid("requestId must be 1–200 chars");
	}
	if (report.principal !== null && !isPrincipalId(report.principal)) {
		throw invalid(`invalid principal: ${report.principal}`);
	}
	if (report.onBehalfOf !== undefined && !isPrincipalId(report.onBehalfOf)) {
		throw invalid(`invalid onBehalfOf: ${report.onBehalfOf}`);
	}
	if (report.target !== "repo" && !isIdOf("lane", report.target)) {
		throw invalid(`invalid target: ${report.target}`);
	}
	if (report.refs.length === 0 || report.refs.length > 1000) {
		throw invalid("a push records 1–1000 refs");
	}
	for (const r of report.refs) {
		if (!isValidRefName(r.ref)) throw invalid(`invalid ref: ${r.ref}`);
		if (!isSha(r.before) || !isSha(r.after)) {
			throw invalid(`invalid shas for ${r.ref}`);
		}
	}
};

export const releasePushLease = (core: Core, requestId: string): void => {
	core.sql.exec("DELETE FROM push_leases WHERE request_id = ?", requestId);
};

/** Fixes the attribution of `commit_firsts` rows a trigger-only phase 2 left unattributed. */
const attributeFirsts = (core: Core, row: PushRow): void => {
	if (row.principal_id === null) return;
	core.sql.exec(
		"UPDATE commit_firsts SET principal_id = ? WHERE push_id = ? AND principal_id IS NULL",
		row.principal_id,
		row.id,
	);
};

/** Phase 1 for one report, inside the caller's transaction. */
export const recordPushSync = (
	core: Core,
	report: PushReport,
): RecordPushOutcome => {
	validateReport(report);
	repoIdentity(core.sql);
	const importing = isImporting(core.sql);
	const reportLane: LaneRow | null = report.target === "repo"
		? null
		: laneRow(core.sql, report.target);
	if (report.target !== "repo" && reportLane === null) {
		throw notFound(`unknown lane: ${report.target}`);
	}
	const attributedTo = ATTRIBUTING.includes(report.via)
		? report.principal
		: null;
	const pushIds: string[] = [];
	const eventIds: string[] = [];
	const missedRefs: string[] = [];
	const missedLanes: string[] = [];
	let pending = false;

	for (const update of report.refs) {
		const side = reportLane !== null && reportLane.mode === "repo"
			? laneRepoSide(report.repoName ?? reportLane.repo_name ?? "")
			: CANONICAL;
		const target = reportLane?.id ?? canonicalTarget(core.sql, update.ref);
		const t: Transition = {
			side,
			target,
			ref: update.ref,
			before: update.before,
			after: update.after,
		};
		const replay = pushByRequest(
			core.sql,
			report.via,
			report.requestId,
			update.ref,
		);
		if (replay !== null) {
			pushIds.push(replay.id);
			eventIds.push(appendAccepted(core, replay).id);
			continue;
		}
		const candidate = mergeCandidate(core, t, report.via);
		let row: PushRow;
		if (
			candidate !== null &&
			(candidate.via === "trigger" || candidate.via === "reconcile")
		) {
			// A trigger or reconciliation saw this transition first: the
			// gateway's attribution wins.
			core.sql.exec(
				`UPDATE pushes SET via = ?, request_id = ?, principal_id = ?, on_behalf_of = ?,
				   token_id = ?, bytes = ? WHERE id = ?`,
				report.via,
				report.requestId,
				report.principal,
				report.onBehalfOf ?? null,
				report.tokenId ?? null,
				report.bytes ?? null,
				candidate.id,
			);
			addSeen(core, candidate, {
				via: candidate.via,
				id: candidate.request_id,
				at: candidate.at,
			});
			row = pushRow(core.sql, candidate.id) as PushRow;
			attributeFirsts(core, row);
			const applied = applyTransition(core, t, row, { attributedTo });
			if (applied.lane === "missed") missedLanes.push(target);
		} else if (candidate !== null) {
			addSeen(core, candidate, {
				via: report.via,
				id: report.requestId,
				at: core.clock.now(),
			});
			row = candidate;
		} else {
			const laneHead = target !== "repo" &&
				(() => {
					const lane = laneRow(core.sql, target);
					return lane !== null && movesLaneHead(lane, t);
				})();
			row = insertPush(core, {
				t,
				via: report.via,
				requestId: report.requestId,
				principal: report.principal,
				onBehalfOf: report.onBehalfOf ?? null,
				tokenId: report.tokenId ?? null,
				bytes: report.bytes ?? null,
				diffState: diffStateFor(update.ref, update.after, {
					laneHead,
					importing,
				}),
			});
			// A trigger that saw this transition first parked it; the gateway
			// record explains it (K1/K2 never fire on the owner's own push).
			const parked = rows<{ id: string; source: PushVia; observed_at: number }>(
				core.sql,
				`SELECT id, source, observed_at FROM pending_observations
				 WHERE ref = ? AND before = ? AND after = ? AND tampered_at IS NULL
				 AND ${side.repoName === null ? "repo_name IS NULL" : "repo_name = ?"}`,
				update.ref,
				update.before,
				update.after,
				...(side.repoName === null ? [] : [side.repoName]),
			);
			for (const obs of parked) {
				core.sql.exec("DELETE FROM pending_observations WHERE id = ?", obs.id);
				addSeen(core, row, {
					via: obs.source,
					id: obs.id,
					at: obs.observed_at,
				});
			}
			row = pushRow(core.sql, row.id) as PushRow;
			const applied = applyTransition(core, t, row, { attributedTo });
			if (applied.ref === "missed") missedRefs.push(update.ref);
			if (applied.lane === "missed") missedLanes.push(target);
		}
		pushIds.push(row.id);
		eventIds.push(appendAccepted(core, row).id);
		if (row.diff_state === "pending") pending = true;
	}
	releasePushLease(core, report.requestId);
	return {
		pushIds,
		eventIds,
		events: core.modules.events.getSync(eventIds),
		reconciled: missedRefs,
		missedRefs,
		missedLanes,
		pending,
	};
};

/** ⇒ `push.rejected`; releases the request's push lease. */
export const recordRejectionSync = (
	core: Core,
	rejection: {
		principal: string;
		tokenId?: string;
		target: "repo" | string;
		commands: readonly PushCommand[];
		reason: string;
		requestId?: string;
	},
): void => {
	if (!isPrincipalId(rejection.principal)) {
		throw invalid(`invalid principal: ${rejection.principal}`);
	}
	if (rejection.target !== "repo" && !isIdOf("lane", rejection.target)) {
		throw invalid(`invalid target: ${rejection.target}`);
	}
	const refs = rejection.commands
		.map((command) => command.ref)
		.filter((ref) =>
			typeof ref === "string" && ref.startsWith("refs/") && ref.length >= 5 &&
			ref.length <= 1024
		);
	emit(core, {
		type: "push.rejected",
		actor: actorOf(rejection.principal),
		...(rejection.target !== "repo"
			? { subject: { kind: "lane", id: rejection.target } }
			: {}),
		data: {
			target: rejection.target,
			refs,
			reason: truncateChars(rejection.reason, 500),
		},
	});
	if (rejection.requestId !== undefined) {
		releasePushLease(core, rejection.requestId);
	}
};

const validateDiff = (result: DiffResult): void => {
	if (!isSha(result.rangeBase)) throw invalid("rangeBase must be a sha");
	if (typeof result.diffKey !== "string" || result.diffKey.length > 512) {
		throw invalid("diffKey must be ≤ 512 chars");
	}
	for (const commit of result.commits) {
		if (!isSha(commit.sha)) throw invalid(`invalid commit sha: ${commit.sha}`);
	}
};

/**
 * Phase 2 (idempotent per push id): range, `lanes.base_sha` for a
 * non-truncated range of the lane's current head (K17), `commit_firsts`
 * ⇒ `push.diffed`.
 */
export const recordDiffSync = (
	core: Core,
	pushId: string,
	result: DiffResult,
): void => {
	const row = pushRow(core.sql, pushId);
	if (row === null) throw notFound(`unknown push: ${pushId}`);
	if (row.diff_state === "done") return;
	validateDiff(result);
	core.sql.exec(
		`UPDATE pushes SET range_base = ?, range_truncated = ?, diff_key = ?, diff_state = 'done'
		 WHERE id = ?`,
		result.rangeBase,
		result.rangeTruncated ? 1 : 0,
		result.diffKey,
		pushId,
	);
	if (row.target !== "repo" && !result.rangeTruncated) {
		core.sql.exec(
			"UPDATE lanes SET base_sha = ? WHERE id = ? AND head_sha = ?",
			result.rangeBase,
			row.target,
			row.after,
		);
	}
	const now = core.clock.now();
	const commits = result.commits.slice(0, PUSH_COMMITS_MAX);
	for (const commit of commits) {
		core.sql.exec(
			"INSERT OR IGNORE INTO commit_firsts (sha, principal_id, push_id, at) VALUES (?, ?, ?, ?)",
			commit.sha,
			row.principal_id,
			row.id,
			now,
		);
	}
	const firsts = new Map(
		commits.map((commit) => [
			commit.sha,
			first<{ principal_id: string | null }>(
				core.sql,
				"SELECT principal_id FROM commit_firsts WHERE sha = ?",
				commit.sha,
			)?.principal_id ?? null,
		]),
	);
	emit(core, {
		type: "push.diffed",
		actor: actorOf(row.principal_id, row.on_behalf_of),
		...(row.target !== "repo"
			? { subject: { kind: "lane", id: row.target } }
			: {}),
		data: {
			pushId: row.id,
			target: row.target,
			ref: row.ref,
			after: row.after,
			rangeBase: result.rangeBase,
			rangeTruncated: result.rangeTruncated,
			commits: commits.map((commit) => ({
				sha: commit.sha,
				subject: truncateChars(commit.subject, 500),
				trailers: commit.trailers.map((t) => ({ key: t.key, value: t.value })),
				firstPushedBy: firsts.get(commit.sha) ?? null,
			})),
			paths: result.paths.slice(0, PUSH_PATHS_MAX),
			truncated: result.truncated || result.paths.length > PUSH_PATHS_MAX,
			diffKey: result.diffKey,
		},
		idemKey: `core:push:${row.id}:push.diffed`,
	});
};

/** Pending rows the `diff` timer completes per run. */
const DIFF_BATCH = 10;
/** Back-off of the `diff` timer after a failed phase 2. */
const DIFF_RETRY_MS = 5 * 60 * 1000;
/** A pending phase 2 older than this is marked `skipped`. */
export const DIFF_GIVE_UP_MS = 24 * 60 * 60 * 1000;

export type Pushes = {
	/** Phase 2 for one row: RepoProbe's lane diff, then `recordDiff`; deduplicated per push id. */
	runPhase2(pushId: string): Promise<void>;
	laneRange(laneId: string): Promise<LaneRange>;
	/** The `diff` timer: completes phase 2 for rows still pending (backstop). Never throws. */
	onDiffTimer(): Promise<void>;
};

export const createPushes = (core: Core): Pushes => {
	const inflight = new Map<string, Promise<void>>();

	const phase2 = async (pushId: string): Promise<void> => {
		const row = pushRow(core.sql, pushId);
		if (row === null || row.diff_state !== "pending") return;
		const { repoId } = repoIdentity(core.sql);
		const source = row.target === "repo"
			? { repoId }
			: { repoId, laneId: row.target };
		const result = await core.ports.probe().laneDiff(source, row.after);
		core.tx(() => recordDiffSync(core, pushId, result));
	};

	const runPhase2 = (pushId: string): Promise<void> => {
		const running = inflight.get(pushId);
		if (running !== undefined) return running;
		const started = phase2(pushId).finally(() => inflight.delete(pushId));
		inflight.set(pushId, started);
		return started;
	};

	const emptyRange = (repoId: string, base: string): LaneRange => ({
		head: base,
		rangeBase: base,
		rangeTruncated: false,
		diffKey: diffKey(repoId, base, base),
	});

	const laneRange = async (laneId: string): Promise<LaneRange> => {
		const lane = laneRow(core.sql, laneId);
		if (lane === null) throw notFound(`unknown lane: ${laneId}`);
		const { repoId } = repoIdentity(core.sql);
		const head = lane.head_sha ?? lane.base_sha;
		const latest = (): PushRow | null =>
			first<PushRow>(
				core.sql,
				"SELECT * FROM pushes WHERE target = ? AND after = ? ORDER BY at DESC, id DESC LIMIT 1",
				laneId,
				head,
			);
		let row = latest();
		if (row?.diff_state === "pending") {
			await runPhase2(row.id);
			row = latest();
		}
		if (
			row !== null && row.diff_state === "done" && row.range_base !== null &&
			row.diff_key !== null
		) {
			return {
				head,
				rangeBase: row.range_base,
				rangeTruncated: row.range_truncated === 1,
				diffKey: row.diff_key,
			};
		}
		if (head === lane.base_sha) return emptyRange(repoId, head);
		// The head moved without a diffed push row (a reconciled or seeded
		// head): compute the range without recording it.
		const result = await core.ports.probe().laneDiff(
			{ repoId, laneId },
			head,
		);
		return {
			head,
			rangeBase: result.rangeBase,
			rangeTruncated: result.rangeTruncated,
			diffKey: result.diffKey,
		};
	};

	const onDiffTimer = async (): Promise<void> => {
		const now = core.clock.now();
		// A row whose phase 2 has failed for a day is given up (its range
		// can still be computed on demand by `laneRange`).
		const abandoned = rows<{ id: string }>(
			core.sql,
			`UPDATE pushes SET diff_state = 'skipped'
			 WHERE diff_state = 'pending' AND at <= ? RETURNING id`,
			now - DIFF_GIVE_UP_MS,
		);
		if (abandoned.length > 0) {
			core.ports.log("phase 2 given up", {
				pushIds: abandoned.map((r) => r.id),
			});
		}
		const due = rows<{ id: string }>(
			core.sql,
			`SELECT id FROM pushes WHERE diff_state = 'pending' AND at <= ?
			 ORDER BY at, id LIMIT ?`,
			now - DIFF_BACKSTOP_MS,
			DIFF_BATCH,
		);
		let failed = false;
		for (const { id } of due) {
			try {
				await runPhase2(id);
			} catch (error) {
				failed = true;
				core.ports.log("phase 2 failed", {
					pushId: id,
					error: errorText(error),
				});
			}
		}
		const oldest = first<{ at: number }>(
			core.sql,
			"SELECT at FROM pushes WHERE diff_state = 'pending' ORDER BY at LIMIT 1",
		);
		if (oldest !== null) {
			const next = failed
				? core.clock.now() + DIFF_RETRY_MS
				: Math.max(oldest.at + DIFF_BACKSTOP_MS, core.clock.now() + 1000);
			core.timers.schedule("diff", next);
		}
	};

	return { runPhase2, laneRange, onDiffTimer };
};
