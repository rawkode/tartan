// Observed ref transitions: the trigger backstop (`observePush`, one ref per
// `cf.artifacts.repo.pushed` event), reconciliation (`observeSync`) and the
// parked-observation path of K1 and K2 (K1, K2).
//
// A transition that matches a push row of another channel merges into it;
// one that matches a kernel write (any state) or an un-completed Advance is
// explained, and so is one that recorded attributed pushes account for (a
// chain from its `before` to its `after`, or on from its `after` to the
// current value: a stale `ls-refs` answer or a late trigger never moves a ref
// back); an unmatched change of a protected or kernel ref is parked and
// raises `ref.tampered` (landing paused) after the grace window; an
// unmatched change of a lane head, or of any ref of a lane's CURRENT lane
// repo, quarantines that lane only; anything else (a human branch or tag)
// is recorded with no pusher. Only a lane repo whose name equals the lane's
// current `repo_name` feeds K1/K2; other `l-*` names are orphans.

import { parseArtifactsName, ZERO_SHA } from "@tartan/contract";
import type {
	LaneRow,
	PendingObservationRow,
	PushRow,
	PushVia,
	TriggerObservation,
} from "@tartan/contract/kernel.ts";
import {
	type Core,
	emit,
	first,
	getMeta,
	inflightAdvance,
	isImporting,
	repoIdentity,
	rows,
	setMeta,
} from "./core.ts";
import { applyKernelWrite, matchKernelWrite } from "./ledger.ts";
import { laneByRepoName, laneRow } from "./lanes/rows.ts";
import type { Protection } from "./protection.ts";
import {
	CANONICAL,
	canonicalTarget,
	diffStateFor,
	indexSha,
	isKernelGuardedRef,
	isProtectedRef,
	laneRepoSide,
	pushChainTo,
	writeRef,
} from "./refs.ts";
import {
	addSeen,
	appendAccepted,
	applyTransition,
	insertPush,
	MERGE_WINDOW_MS,
	movesLaneHead,
	pushByRequest,
	type Transition,
} from "./transitions.ts";

/** K1 grace window before a parked observation is re-checked (≥ 2 min). */
export const OBSERVE_GRACE_MS = 2 * 60 * 1000;
/** How long handled trigger event ids are remembered. */
export const TRIGGER_SEEN_TTL_MS = 24 * 60 * 60 * 1000;

export type ObservationSource = "trigger" | "reconcile";

export type Observation = Transition & {
	readonly source: ObservationSource;
	/** Trigger event id, or a reconciliation id. */
	readonly requestId: string;
};

export type ObserveOutcome =
	| { readonly kind: "merged"; readonly pushId: string }
	| { readonly kind: "explained"; readonly pushId: string }
	| {
		readonly kind: "recorded";
		readonly pushId: string;
		readonly pending: boolean;
	}
	| { readonly kind: "parked"; readonly observationId: string }
	| { readonly kind: "ignored"; readonly why: string };

const scheduleObserve = (core: Core): void => {
	const next = first<{ at: number }>(
		core.sql,
		"SELECT MIN(recheck_at) AS at FROM pending_observations WHERE tampered_at IS NULL",
	)?.at ?? null;
	// Never at or before "now": the multiplexer deletes a row its handler
	// left unchanged, so a due row must move forward to stay armed.
	if (next === null) core.timers.cancel("observe");
	else core.timers.schedule("observe", Math.max(next, core.clock.now() + 1));
};

const sideClause = (obs: Transition): [string, SqlStorageValue[]] =>
	obs.side.repoName === null
		? ["repo_name IS NULL", []]
		: ["repo_name = ?", [obs.side.repoName]];

/**
 * Parks an unmatched observation and arms the `observe` timer. Deduplicated
 * per transition, including one already reported as tampered (awaiting an
 * Owner): reconciliation keeps seeing a K1 mismatch, because the index never
 * adopts an unexplained value, and must not raise it again every run.
 */
const park = (core: Core, obs: Observation, laneId: string | null): string => {
	const [clause, bindings] = sideClause(obs);
	const existing = first<{ id: string }>(
		core.sql,
		`SELECT id FROM pending_observations WHERE ref = ? AND before = ? AND after = ?
		 AND ${clause}`,
		obs.ref,
		obs.before,
		obs.after,
		...bindings,
	);
	if (existing !== null) return existing.id;
	const id = `ob_${core.ids.ulid()}`;
	const now = core.clock.now();
	core.sql.exec(
		`INSERT INTO pending_observations (id, target, repo_name, ref, before, after, source,
		   lane_id, observed_at, recheck_at, checks)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
		id,
		obs.target,
		obs.side.repoName,
		obs.ref,
		obs.before,
		obs.after,
		obs.source,
		laneId,
		now,
		now + OBSERVE_GRACE_MS,
	);
	scheduleObserve(core);
	return id;
};

/** A kernel write (any state) or an un-completed Advance that produced `after`. */
const explain = (core: Core, obs: Observation): PushRow | null => {
	const kw = matchKernelWrite(core, obs);
	if (kw !== null) {
		if (kw.state === "intent" || kw.state === "pushed") {
			core.sql.exec(
				"UPDATE kernel_writes SET state = 'observed', updated_at = ? WHERE id = ?",
				core.clock.now(),
				kw.id,
			);
		}
		const row = applyKernelWrite(core, kw);
		addSeen(core, row, {
			via: obs.source,
			id: obs.requestId,
			at: core.clock.now(),
		});
		return row;
	}
	if (obs.side.repoName === null) {
		const advance = inflightAdvance(core, obs.ref);
		if (advance !== null && advance.new_sha === obs.after) {
			const known = pushByRequest(
				core.sql,
				"kernel",
				`adv:${advance.id}`,
				obs.ref,
			);
			if (known !== null) {
				addSeen(core, known, {
					via: obs.source,
					id: obs.requestId,
					at: core.clock.now(),
				});
				return known;
			}
			const row = insertPush(core, {
				t: obs,
				via: "kernel",
				requestId: `adv:${advance.id}`,
				principal: null,
				diffState: "skipped",
				seen: [{ via: obs.source, id: obs.requestId, at: core.clock.now() }],
			});
			applyTransition(core, obs, row);
			appendAccepted(core, row);
			return row;
		}
	}
	return null;
};

/**
 * What the kernel holds for the ref `obs` moved: the index for a canonical
 * ref, `lanes.head_sha` for a lane repo's head ref; null when it keeps none
 * (other refs of a lane repo).
 */
const currentValue = (core: Core, obs: Observation): string | null => {
	if (obs.side.repoName === null) return indexSha(core.sql, obs.ref);
	const lane = obs.target === "repo" ? null : laneRow(core.sql, obs.target);
	return lane !== null && movesLaneHead(lane, obs)
		? lane.head_sha ?? ZERO_SHA
		: null;
};

/**
 * The cross-channel rule for observations with no exact push row: recorded
 * attributed pushes (gateway, swarm, kernel) account for `obs` when they
 * lead from its `before` to its `after` (an observer saw several pushes as
 * one transition, A→B→C seen as A→C), or from its `after` on to the value
 * the kernel holds now (a stale `ls-refs` answer, a late trigger: applying it
 * would move the ref back). The last row of that chain, or null.
 */
const explainedByPushLog = (core: Core, obs: Observation): PushRow | null => {
	const attributed = { attributedOnly: true } as const;
	const chain = pushChainTo(
		core,
		obs.side,
		obs.ref,
		obs.before,
		obs.after,
		attributed,
	);
	if (chain !== null) return chain;
	const current = currentValue(core, obs);
	if (current === null || current === obs.after) return null;
	return pushChainTo(core, obs.side, obs.ref, obs.after, current, attributed);
};

/**
 * A merged observation of the most recent recorded transition of its ref
 * whose state fell behind it: the index or lane head still holds its
 * `before`. Moves them to its `after`, the state its `push.accepted`
 * already announced; never when a later push moved the ref on.
 */
const repairBehind = (core: Core, obs: Observation, row: PushRow): void => {
	const [clause, bindings] = sideClause(obs);
	const latest = first<{ id: string }>(
		core.sql,
		`SELECT id FROM pushes WHERE ref = ? AND ${clause} ORDER BY at DESC, id DESC LIMIT 1`,
		obs.ref,
		...bindings,
	);
	if (latest?.id !== row.id) return;
	if (
		obs.side.repoName === null && indexSha(core.sql, obs.ref) === obs.before
	) {
		writeRef(core, obs.ref, obs.after, { pushId: row.id });
	}
	const lane = obs.target === "repo" ? null : laneRow(core.sql, obs.target);
	if (
		lane !== null && movesLaneHead(lane, obs) &&
		(lane.head_sha ?? ZERO_SHA) === obs.before
	) {
		core.sql.exec(
			"UPDATE lanes SET head_sha = ? WHERE id = ?",
			obs.after === ZERO_SHA ? null : obs.after,
			lane.id,
		);
	}
};

/**
 * An event of a `deleted` lane whose `after` is zeros or already in
 * that lane's push log arrived late; it never feeds K2.
 */
const isLateEventOfDeletedLane = (
	core: Core,
	lane: LaneRow,
	after: string,
): boolean =>
	lane.state === "deleted" &&
	(after === ZERO_SHA ||
		first<{ id: string }>(
				core.sql,
				"SELECT id FROM pushes WHERE target = ? AND after = ? LIMIT 1",
				lane.id,
				after,
			) !== null);

/** The lane whose storage `obs` touched (K2), or null for the canonical repo's own refs. */
const laneOf = (core: Core, obs: Observation): LaneRow | null => {
	if (obs.target === "repo") return null;
	const lane = laneRow(core.sql, obs.target);
	if (lane === null) return null;
	if (lane.mode === "repo") {
		return obs.side.repoName !== null && obs.side.repoName === lane.repo_name
			? lane
			: null;
	}
	return obs.side.repoName === null && movesLaneHead(lane, obs) ? lane : null;
};

/** One observation inside the caller's transaction. */
export const observeTransitionSync = (
	core: Core,
	obs: Observation,
	protectedPatterns: readonly string[],
): ObserveOutcome => {
	const now = core.clock.now();
	const [clause, bindings] = sideClause(obs);
	const merged = rows<PushRow>(
		core.sql,
		`SELECT * FROM pushes WHERE ref = ? AND before = ? AND after = ? AND at >= ? AND ${clause}
		 ORDER BY at, id`,
		obs.ref,
		obs.before,
		obs.after,
		now - MERGE_WINDOW_MS,
		...bindings,
	).find((row) =>
		row.via !== obs.source &&
		!(JSON.parse(row.seen_via_json) as { via: PushVia }[]).some((e) =>
			e.via === obs.source
		)
	);
	if (merged !== undefined) {
		addSeen(core, merged, { via: obs.source, id: obs.requestId, at: now });
		repairBehind(core, obs, merged);
		return { kind: "merged", pushId: merged.id };
	}
	const explained = explain(core, obs);
	if (explained !== null) return { kind: "explained", pushId: explained.id };
	const lane = laneOf(core, obs);
	if (lane !== null) {
		if (isLateEventOfDeletedLane(core, lane, obs.after)) {
			return { kind: "ignored", why: "late event of a deleted lane" };
		}
		const logged = explainedByPushLog(core, obs);
		if (logged !== null) return { kind: "explained", pushId: logged.id };
		return { kind: "parked", observationId: park(core, obs, lane.id) };
	}
	if (obs.side.repoName !== null) {
		return { kind: "ignored", why: "not a lane's current repo" };
	}
	const importing = isImporting(core.sql);
	const defaultBranch = getMeta(core.sql, "default_branch") ?? "main";
	const guarded = isKernelGuardedRef(obs.ref, obs.target) ||
		(!importing && isProtectedRef(obs.ref, defaultBranch, protectedPatterns));
	if (guarded) {
		const logged = explainedByPushLog(core, obs);
		if (logged !== null) return { kind: "explained", pushId: logged.id };
		return { kind: "parked", observationId: park(core, obs, null) };
	}
	const row = insertPush(core, {
		t: obs,
		via: obs.source,
		requestId: obs.requestId,
		principal: null,
		diffState: diffStateFor(obs.ref, obs.after, {
			laneHead: false,
			importing,
		}),
	});
	applyTransition(core, obs, row);
	appendAccepted(core, row);
	return {
		kind: "recorded",
		pushId: row.id,
		pending: row.diff_state === "pending",
	};
};

/** Maps one trigger event to an observation of this repo family. */
export const triggerObservation = (
	core: Core,
	event: TriggerObservation,
): Observation | { readonly ignored: string } => {
	const name = event.repoName.toLowerCase();
	const parsed = parseArtifactsName(name);
	if (parsed === null) return { ignored: "unparseable repo name" };
	const identity = repoIdentity(core.sql);
	if (parsed.repoUlid !== identity.repoId) return { ignored: "another repo" };
	const base = {
		ref: event.ref,
		before: event.before,
		after: event.after,
		source: "trigger" as const,
		requestId: event.eventId,
	};
	if (parsed.kind === "repo") {
		return {
			...base,
			side: CANONICAL,
			target: canonicalTarget(core.sql, event.ref),
		};
	}
	const lane = laneByRepoName(core.sql, name);
	if (lane === null) return { ignored: "orphan lane repo" };
	return { ...base, side: laneRepoSide(name), target: lane.id };
};

/** `observePush` inside its transaction: idempotent per trigger event id. */
export const observePushSync = (
	core: Core,
	event: TriggerObservation,
	protectedPatterns: readonly string[],
): ObserveOutcome => {
	const seen = first<{ event_id: string }>(
		core.sql,
		"SELECT event_id FROM trigger_seen WHERE event_id = ?",
		event.eventId,
	);
	if (seen !== null) return { kind: "ignored", why: "duplicate event" };
	core.sql.exec(
		"INSERT INTO trigger_seen (event_id, at) VALUES (?, ?)",
		event.eventId,
		core.clock.now(),
	);
	const obs = triggerObservation(core, event);
	if ("ignored" in obs) {
		core.ports.log("trigger observation ignored", {
			repoName: event.repoName.toLowerCase(),
			ref: event.ref,
			why: obs.ignored,
		});
		return { kind: "ignored", why: obs.ignored };
	}
	return observeTransitionSync(core, obs, protectedPatterns);
};

// ---------------------------------------------------------------------------
// The `observe` timer: K1 (pause landing) and K2 (quarantine one lane)
// ---------------------------------------------------------------------------

const transitionOf = (obs: PendingObservationRow): Observation => ({
	side: obs.repo_name === null ? CANONICAL : laneRepoSide(obs.repo_name),
	target: obs.target,
	ref: obs.ref,
	before: obs.before,
	after: obs.after,
	source: obs.source,
	requestId: obs.id,
});

/** Re-checks one parked observation; unmatched ⇒ `ref.tampered`. */
export const recheckSync = (core: Core, obs: PendingObservationRow): void => {
	const now = core.clock.now();
	const t = transitionOf(obs);
	const [clause, bindings] = sideClause(t);
	const pushed = first<PushRow>(
		core.sql,
		`SELECT * FROM pushes WHERE ref = ? AND before = ? AND after = ? AND at >= ? AND ${clause}
		 ORDER BY at LIMIT 1`,
		obs.ref,
		obs.before,
		obs.after,
		obs.observed_at - MERGE_WINDOW_MS,
		...bindings,
	);
	if (pushed !== null) {
		core.sql.exec("DELETE FROM pending_observations WHERE id = ?", obs.id);
		addSeen(core, pushed, { via: obs.source, id: obs.id, at: obs.observed_at });
		return;
	}
	if (explain(core, t) !== null || explainedByPushLog(core, t) !== null) {
		// A kernel write, or recorded pushes that reach (or moved past) it:
		// never a K1/K2 alarm, and never a write of an older value.
		core.sql.exec("DELETE FROM pending_observations WHERE id = ?", obs.id);
		return;
	}
	core.sql.exec(
		"UPDATE pending_observations SET tampered_at = ?, checks = checks + 1 WHERE id = ?",
		now,
		obs.id,
	);
	const lane = obs.lane_id === null ? null : laneRow(core.sql, obs.lane_id);
	if (obs.lane_id === null) {
		setMeta(core.sql, "landing_paused", "1");
		setMeta(core.sql, "drifted", "1");
	} else if (lane !== null) {
		core.sql.exec("UPDATE lanes SET quarantined = 1 WHERE id = ?", lane.id);
		if (movesLaneHead(lane, t)) {
			core.sql.exec(
				"UPDATE lanes SET head_sha = ? WHERE id = ?",
				obs.after === ZERO_SHA ? null : obs.after,
				lane.id,
			);
			if (lane.mode === "branch") writeRef(core, obs.ref, obs.after);
		}
	}
	emit(core, {
		type: "ref.tampered",
		...(obs.lane_id !== null
			? { subject: { kind: "lane", id: obs.lane_id } }
			: {}),
		data: {
			target: obs.target,
			ref: obs.ref,
			before: obs.before,
			after: obs.after,
			source: obs.source,
			parkedAt: obs.observed_at,
			...(obs.lane_id !== null ? { laneId: obs.lane_id } : {}),
		},
	});
};

export type Observer = {
	/** The `observe` timer handler. */
	onObserveTimer(): void;
	readonly protection: Protection;
};

export const createObserver = (
	core: Core,
	protection: Protection,
): Observer => ({
	protection,
	onObserveTimer: () => {
		const due = rows<PendingObservationRow>(
			core.sql,
			`SELECT * FROM pending_observations WHERE tampered_at IS NULL AND recheck_at <= ?
			 ORDER BY recheck_at, id LIMIT 100`,
			core.clock.now(),
		);
		for (const obs of due) {
			try {
				core.tx(() => recheckSync(core, obs));
			} catch (error) {
				core.ports.log("observation recheck failed", {
					id: obs.id,
					error: error instanceof Error ? error.message : String(error),
				});
				core.sql.exec(
					"UPDATE pending_observations SET recheck_at = ?, checks = checks + 1 WHERE id = ?",
					core.clock.now() + OBSERVE_GRACE_MS,
					obs.id,
				);
			}
		}
		scheduleObserve(core);
	},
});

/** Forgets handled trigger event ids older than a day (cron). */
export const pruneTriggerSeen = (core: Core): void => {
	core.sql.exec(
		"DELETE FROM trigger_seen WHERE at < ?",
		core.clock.now() - TRIGGER_SEEN_TTL_MS,
	);
};
