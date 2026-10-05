// `RepoCoreInternal` (contract do/repo.ts): the synchronous in-DO API sibling
// modules call inside their own `transactionSync` (WP6's `appendSync`, WP10's
// land steps, WP5b's seeder and reconciliation). None of these opens a
// transaction itself.

import {
	conflict,
	type Envelope,
	invalid,
	isIdOf,
	isLaneEventType,
	type LaneState,
	laneStateAfter,
	notFound,
	tartanError,
} from "@tartan/contract";
import type { LaneRow, RepoCoreInternal } from "@tartan/contract/kernel.ts";
import { type Core, first, getMeta, setMeta } from "./core.ts";
import {
	applyKernelWriteSync,
	explainsSync,
	markKernelWriteSync,
	registerKernelWriteSync,
} from "./ledger.ts";
import { laneRow } from "./lanes/rows.ts";
import { observeTransitionSync } from "./observe.ts";
import type { Protection } from "./protection.ts";
import { CANONICAL, getRef, laneRepoSide } from "./refs.ts";
import { recordLandingSync } from "./trunk.ts";

/**
 * The land transitions WP10 owns: into the `landing`
 * freeze, out of it on every non-landing outcome, `landed`, or back to
 * `open` when the landed head differs from the lane's (a foreign write).
 */
const LAND_TRANSITIONS: Readonly<
	Partial<Record<LaneState, readonly LaneState[]>>
> = {
	submitted: ["landing"],
	landing: ["submitted", "landed", "open"],
};

export const setLaneStateSync = (
	core: Core,
	laneId: string,
	state: LaneState,
): void => {
	const lane = laneRow(core.sql, laneId);
	if (lane === null) throw notFound(`unknown lane: ${laneId}`);
	if (lane.state === state) return;
	if (!(LAND_TRANSITIONS[lane.state] ?? []).includes(state)) {
		throw conflict(`lane ${laneId} cannot move ${lane.state} → ${state}`, {
			code: `lane-${lane.state}`,
		});
	}
	if (state === "landing" && lane.quarantined === 1) {
		throw conflict(`lane ${laneId} is quarantined`, {
			code: "lane-quarantined",
		});
	}
	if (state === "landing" && laneGitJobInFlight(core, laneId)) {
		// A sync or restack registered its intent before the freeze: landing
		// would bind a head that job is about to move (K4).
		// The reason travels in the message, so a caller across Workers RPC
		// (the queue provider's land.submit) can retry it as transient.
		throw tartanError(
			"conflict",
			`lane ${laneId} has a sync or restack in flight`,
			{ reason: "lane-git-job", details: { code: "lane-git-job" } },
		);
	}
	core.sql.exec("UPDATE lanes SET state = ? WHERE id = ?", state, laneId);
};

/** How long an unmarked `lane-sync` intent counts as a running git job. */
export const LANE_GIT_JOB_WINDOW_MS = 15 * 60 * 1000;

/** An open `lane-sync` intent of the lane registered within the window. */
const laneGitJobInFlight = (core: Core, laneId: string): boolean =>
	first<{ id: string }>(
		core.sql,
		`SELECT id FROM kernel_writes WHERE target = ? AND purpose = 'lane-sync'
		 AND state = 'intent' AND created_at > ? LIMIT 1`,
		laneId,
		core.clock.now() - LANE_GIT_JOB_WINDOW_MS,
	) !== null;

/**
 * The lane-transition rule: `changes.submitted` moves `open` → `submitted` and
 * records the lane's change id; `changes.abandoned` / `changes.superseded` move
 * `submitted` → `open` (found by `laneId`, else by the recorded change id). A
 * shadow event never moves a lane. K2: a quarantined lane refuses
 * `changes.submitted` (the append rolls back).
 */
export const applyLaneEventSync = (core: Core, event: Envelope): void => {
	if (event.shadow || !isLaneEventType(event.type)) return;
	const data = (event.data ?? {}) as { laneId?: unknown; changeId?: unknown };
	const laneId = typeof data.laneId === "string" ? data.laneId : null;
	const changeId = typeof data.changeId === "string" ? data.changeId : null;
	const lane = laneId !== null
		? laneRow(core.sql, laneId)
		: changeId !== null
		? first<LaneRow>(
			core.sql,
			"SELECT * FROM lanes WHERE change_id = ? ORDER BY created_at DESC LIMIT 1",
			changeId,
		)
		: null;
	if (lane === null) return;
	if (event.type === "changes.submitted") {
		if (lane.quarantined === 1) {
			throw conflict(`lane ${lane.id} is quarantined`, {
				code: "lane-quarantined",
			});
		}
		if (changeId !== null) {
			core.sql.exec(
				"UPDATE lanes SET change_id = ? WHERE id = ?",
				changeId,
				lane.id,
			);
		}
	}
	const next = laneStateAfter(lane.state, event.type);
	if (next !== null) {
		core.sql.exec("UPDATE lanes SET state = ? WHERE id = ?", next, lane.id);
	}
};

export const createCoreInternal = (
	core: Core,
	protection: Protection,
): RepoCoreInternal => {
	let simulated: boolean | null = null;
	return {
		metaSync: (key) => getMeta(core.sql, key),
		simulatedSync: () => simulated ??= getMeta(core.sql, "sim") === "1",
		markSimulatedSync: () => {
			setMeta(core.sql, "sim", "1");
			simulated = true;
		},
		refSync: (ref) => getRef(core.sql, ref),
		laneSync: (laneId) => laneRow(core.sql, laneId),
		registerKernelWriteSync: (intent) => registerKernelWriteSync(core, intent),
		markKernelWriteSync: (id, state) => markKernelWriteSync(core, id, state),
		applyKernelWriteSync: (id) => applyKernelWriteSync(core, id),
		setLandingPausedSync: (paused) =>
			setMeta(core.sql, "landing_paused", paused ? "1" : "0"),
		setLaneStateSync: (laneId, state) => setLaneStateSync(core, laneId, state),
		applyLaneEventSync: (event) => applyLaneEventSync(core, event),
		explainsSync: (ref, sha) => explainsSync(core, ref, sha),
		observeSync: (observation) => {
			if (
				observation.target !== "repo" && !isIdOf("lane", observation.target)
			) {
				throw invalid(`invalid target: ${observation.target}`);
			}
			if (observation.repoName !== null) {
				// Only the lane's CURRENT repo feeds K2.
				const lane = laneRow(core.sql, observation.target);
				if (lane === null || lane.repo_name !== observation.repoName) return;
			}
			observeTransitionSync(core, {
				side: observation.repoName === null
					? CANONICAL
					: laneRepoSide(observation.repoName),
				target: observation.target,
				ref: observation.ref,
				before: observation.before,
				after: observation.after,
				source: "reconcile",
				requestId: `rc_${core.ids.ulid()}`,
			}, protection.patterns());
		},
		recordLandingSync: (input) => recordLandingSync(core, input),
	};
};
