// The K1/K2 write-intent ledger `kernel_writes` (K1, K2). Every kernel git job
// registers its intent before it pushes and marks it after; an observed
// transition matches an intent on `(target, ref, new_sha)` in ANY state (a
// superseded or abandoned intent whose push landed still explains it). Marking
// an intent `pushed` or `observed` applies it to the index and the push log
// (via `kernel`).

import {
	conflict,
	invalid,
	isIdOf,
	isSha,
	isValidRefName,
	KERNEL_WRITE_PURPOSES,
	type KernelWritePurpose,
	type KernelWriteState,
	notFound,
	ZERO_SHA,
} from "@tartan/contract";
import type {
	KernelWriteIntent,
	KernelWriteRow,
	LaneRow,
	PushRow,
} from "@tartan/contract/kernel.ts";
import { type Core, first, inflightAdvance, rows, scalar } from "./core.ts";
import { laneRow } from "./lanes/rows.ts";
import { CANONICAL, diffStateFor, laneRepoSide } from "./refs.ts";
import {
	addSeen,
	appendAccepted,
	applyTransition,
	insertPush,
	mergeCandidate,
	pushByRequest,
	type Transition,
} from "./transitions.ts";

const KERNEL_WRITE_STATES: readonly KernelWriteState[] = [
	"intent",
	"pushed",
	"observed",
	"abandoned",
];

/** Purposes whose ref lives in a lane repo, never in the canonical repo. */
const LANE_REPO_ONLY: readonly KernelWritePurpose[] = [
	"lane-seed",
	"lane-delete",
];

/** Kernel writes that record no `push.accepted` (seeds and deletions of lanes). */
const SILENT: readonly KernelWritePurpose[] = [
	"lane-seed",
	"lane-delete",
	"lane-gc",
	"purge",
];

export const kernelWrite = (
	sql: SqlStorage,
	id: string,
): KernelWriteRow | null =>
	first<KernelWriteRow>(sql, "SELECT * FROM kernel_writes WHERE id = ?", id);

const validateIntent = (core: Core, intent: KernelWriteIntent): void => {
	if (!KERNEL_WRITE_PURPOSES.includes(intent.purpose)) {
		throw invalid(`unknown kernel write purpose: ${intent.purpose}`);
	}
	if (!["land", "job", "kernel"].includes(intent.ownerKind)) {
		throw invalid(`unknown kernel write owner kind: ${intent.ownerKind}`);
	}
	if (!isValidRefName(intent.ref)) throw invalid(`invalid ref: ${intent.ref}`);
	if (!isSha(intent.expectOld) || !isSha(intent.newSha)) {
		throw invalid("expectOld and newSha must be 40-char lowercase shas");
	}
	if (intent.ownerId.length === 0 || intent.ownerId.length > 200) {
		throw invalid("ownerId must be 1–200 chars");
	}
	if (intent.target !== "repo") {
		if (
			!isIdOf("lane", intent.target) ||
			laneRow(core.sql, intent.target) === null
		) {
			throw invalid(`unknown kernel write target: ${intent.target}`);
		}
	}
};

/**
 * Inserts the intent (before the write); a `supersedes` intent still
 * `intent` becomes `abandoned`. A `lane-sync` intent (the git half of
 * `syncLane` and `restackLane`) is refused while its lane is `landing`: the
 * K4/K16 freeze holds for a git job that passed its state check before
 * LandWorkflow froze the lane.
 */
export const registerKernelWriteSync = (
	core: Core,
	intent: KernelWriteIntent,
): KernelWriteRow => {
	validateIntent(core, intent);
	if (intent.purpose === "lane-sync" && intent.target !== "repo") {
		const lane = laneRow(core.sql, intent.target);
		if (lane?.state === "landing") {
			throw conflict(`lane ${lane.id} is landing: no sync or restack`, {
				code: "lane-landing",
				laneId: lane.id,
			});
		}
	}
	const id = `kw_${core.ids.ulid()}`;
	const now = core.clock.now();
	core.sql.exec(
		`INSERT INTO kernel_writes (id, target, ref, expect_old, new_sha, purpose, owner_kind, owner_id,
		   state, supersedes, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'intent', ?, ?, ?)`,
		id,
		intent.target,
		intent.ref,
		intent.expectOld,
		intent.newSha,
		intent.purpose,
		intent.ownerKind,
		intent.ownerId,
		intent.supersedes ?? null,
		now,
		now,
	);
	if (intent.supersedes !== undefined) {
		core.sql.exec(
			"UPDATE kernel_writes SET state = 'abandoned', updated_at = ? WHERE id = ? AND state = 'intent'",
			now,
			intent.supersedes,
		);
	}
	return kernelWrite(core.sql, id) as KernelWriteRow;
};

/** The repo an intent's ref lives in. */
const sideOfWrite = (core: Core, kw: KernelWriteRow) => {
	if (kw.target === "repo") return CANONICAL;
	const lane = laneRow(core.sql, kw.target);
	if (lane !== null && lane.mode === "repo" && lane.repo_name !== null) {
		return laneRepoSide(lane.repo_name);
	}
	if (LANE_REPO_ONLY.includes(kw.purpose) && lane?.repo_name) {
		return laneRepoSide(lane.repo_name);
	}
	return CANONICAL;
};

const transitionOf = (core: Core, kw: KernelWriteRow): Transition => ({
	side: sideOfWrite(core, kw),
	target: kw.target,
	ref: kw.ref,
	before: kw.expect_old,
	after: kw.new_sha,
});

const insertGenesis = (core: Core, kw: KernelWriteRow): void => {
	if (kw.purpose !== "genesis" || kw.new_sha === ZERO_SHA) return;
	const any = scalar(core.sql, "SELECT COUNT(*) AS n FROM trunk_commits");
	if (any === 0) {
		core.sql.exec(
			"INSERT OR IGNORE INTO trunk_commits (sha, seq, source) VALUES (?, 0, 'genesis')",
			kw.new_sha,
		);
	}
};

/**
 * Applies an intent to the index (canonical refs) or the lane head
 * (`lane-sync`), and upserts its push row via `kernel`, merging a trigger or
 * reconciliation row of the same transition. Idempotent.
 */
export const applyKernelWrite = (core: Core, kw: KernelWriteRow): PushRow => {
	const existing = pushByRequest(core.sql, "kernel", kw.id, kw.ref);
	if (existing !== null) return existing;
	const t = transitionOf(core, kw);
	const lane = kw.target === "repo" ? null : laneRow(core.sql, kw.target);
	// Only a kernel write that moves a lane head (`lane-sync`) gets a lane
	// range; trunk, notes, kernel refs, seeds and deletions are not diffed.
	const laneHead = lane !== null && kw.purpose === "lane-sync";
	const diffState = laneHead
		? diffStateFor(kw.ref, kw.new_sha, { laneHead, importing: false })
		: "skipped";
	const merged = mergeCandidate(core, t, "kernel");
	let row: PushRow;
	if (
		merged !== null && merged.kernel_write_id === null &&
		(merged.via === "trigger" || merged.via === "reconcile")
	) {
		core.sql.exec(
			`UPDATE pushes SET via = 'kernel', request_id = ?, kernel_write_id = ?, diff_state = ?
			 WHERE id = ?`,
			kw.id,
			kw.id,
			merged.diff_state === "done" ? "done" : diffState,
			merged.id,
		);
		addSeen(core, merged, {
			via: merged.via,
			id: merged.request_id,
			at: merged.at,
		});
		row = first<PushRow>(
			core.sql,
			"SELECT * FROM pushes WHERE id = ?",
			merged.id,
		) as PushRow;
	} else {
		row = insertPush(core, {
			t,
			via: "kernel",
			requestId: kw.id,
			principal: null,
			kernelWriteId: kw.id,
			diffState,
		});
	}
	if (!LANE_REPO_ONLY.includes(kw.purpose)) applyTransition(core, t, row);
	insertGenesis(core, kw);
	if (!SILENT.includes(kw.purpose)) appendAccepted(core, row);
	return row;
};

export const markKernelWriteSync = (
	core: Core,
	id: string,
	state: KernelWriteState,
): void => {
	if (!KERNEL_WRITE_STATES.includes(state)) {
		throw invalid(`unknown kernel write state: ${state}`);
	}
	const kw = kernelWrite(core.sql, id);
	if (kw === null) throw notFound(`unknown kernel write: ${id}`);
	// `observed` is final; `pushed` never goes back to `intent`.
	if (kw.state === "observed" && state !== "observed") return;
	if (kw.state === "pushed" && state === "intent") return;
	core.sql.exec(
		"UPDATE kernel_writes SET state = ?, updated_at = ? WHERE id = ?",
		state,
		core.clock.now(),
		id,
	);
	if (state === "pushed" || state === "observed") applyKernelWrite(core, kw);
};

/** `completeAdvance` (WP10): the index and a `via='kernel'` push row for this intent. */
export const applyKernelWriteSync = (core: Core, id: string): void => {
	const kw = kernelWrite(core.sql, id);
	if (kw === null) throw notFound(`unknown kernel write: ${id}`);
	applyKernelWrite(core, kw);
};

/** Lanes whose refs live in the canonical repo (`branch` backend). */
const BRANCH_LANE_IDS = "SELECT id FROM lanes WHERE mode = 'branch'";

/**
 * K1/K2 matching on `(target, ref, new_sha)` in ANY state: in the
 * canonical repo an intent of the repo or of a `branch` lane; in a lane
 * repo an intent targeting that lane.
 */
export const matchKernelWrite = (
	core: Core,
	t: Transition,
): KernelWriteRow | null => {
	if (t.side.repoName === null) {
		return first<KernelWriteRow>(
			core.sql,
			`SELECT * FROM kernel_writes WHERE ref = ? AND new_sha = ?
			 AND (target = 'repo' OR (target IN (${BRANCH_LANE_IDS})
			   AND purpose NOT IN ('lane-seed','lane-delete')))
			 ORDER BY created_at DESC LIMIT 1`,
			t.ref,
			t.after,
		);
	}
	return first<KernelWriteRow>(
		core.sql,
		`SELECT * FROM kernel_writes WHERE target = ? AND ref = ? AND new_sha = ?
		 ORDER BY created_at DESC LIMIT 1`,
		t.target,
		t.ref,
		t.after,
	);
};

/**
 * (WP10's fail-closed `lock-n`, the capability state's explained tips):
 * true only when an OPEN intent (`intent` or `pushed`) or an un-completed
 * Advance on `ref` of the canonical repo has exactly `new_sha = sha`.
 */
export const explainsSync = (core: Core, ref: string, sha: string): boolean => {
	const open = first<{ id: string }>(
		core.sql,
		`SELECT id FROM kernel_writes WHERE target = 'repo' AND ref = ? AND new_sha = ?
		 AND state IN ('intent','pushed') LIMIT 1`,
		ref,
		sha,
	);
	if (open !== null) return true;
	const advance = inflightAdvance(core, ref);
	return advance !== null && advance.new_sha === sha;
};

/** The open `lane-seed` intents of a lane (closing an `opening` lane abandons them). */
export const openSeedIntents = (core: Core, lane: LaneRow): KernelWriteRow[] =>
	rows<KernelWriteRow>(
		core.sql,
		`SELECT * FROM kernel_writes WHERE target = ? AND purpose = 'lane-seed'
		 AND state IN ('intent','pushed')`,
		lane.id,
	);
