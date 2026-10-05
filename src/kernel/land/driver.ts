// LandWorkflow's body (K1, K4, K5, K14), written
// against a minimal step interface so it runs
// under the Workflows engine and under a fake in Deno tests. Per attempt n:
//
//   compose-n     fetch trunk and each lane head by SHA into the mirror
//                 (a `branch` lane from the canonical repo, a `repo` lane
//                 from its own lane repo with a read token scoped to it),
//                 list each lane range, get the squash messages from RepoDO,
//                 `merge-tree` + `commit-tree` per change (conflicts are
//                 recorded with their regions and skipped), record the
//                 candidate (its K1 intent in the same transaction) and push
//                 `refs/tartan/candidates/<batch>`
//   gate-n        every `ref.advance` gate in force per surviving change;
//                 a veto drops the change and starts attempt n+1
//   config-hold-n-i / config-wait-n-i
//                 K13.1 (repository config, WP23): while a policy change of
//                 this repo resolves, sleep (outside the K5 lock, no attempt
//                 used); the hold delays a land and never vetoes it. Past
//                 `CONFIG_HOLD_MAX_MS` the batch ends `failed` with reason
//                 `config-hold`: its lanes are released, its changes return
//                 to their queue unchanged and never count toward ejection
//                 (K9), and the queue submits them again later
//   test-n        `land.testing`, then `verdict-n` (`waitForEvent`) with the
//                 `poll-n-i` fallback, bound to (attempt, candidate) (K14)
//   lock-n        K5 (`k5-wait-n-i` while another batch holds the ref) with
//                 the fail-closed base check
//   restack-n     M1: trunk must still be the composed base, else
//                 `advance.stale` and attempt n+1 (K6's restack is M2); the
//                 why notes are built and every push's intent registered
//   push-trunk-n  `= new` skip, `= expect_old` push with lease, else stale;
//                 upstream failures are retryable step errors
//   push-notes-n  rebase-and-retry when the notes tip moved
//   push-refs-n   `refs/tartan/changes/<id>`: ref-only from the Worker for
//                 `branch` lanes; from the mirror WITH objects for `repo`
//                 lanes (their heads live only in their lane repos), after
//                 re-fetching a missing head by SHA from its lane repo
//   complete-n    `completeAdvance`, then the landed lanes are closed
//
// Every step first reads persisted RepoDO state or the remote, so a re-run
// after a crash, an eviction or a redeploy repeats no side effect. Step
// outputs are small and token-free; tokens are minted inside a step and
// revoked before it returns (K11).

import {
	type Actor,
	batchUlidOf,
	candidateRef,
	changeRef,
	conflict,
	fromRpcError,
	GATE_INPUT_LIMITS,
	K5_WAIT_MAX_MS,
	type LandBatchState,
	landStepName,
	MAX_LAND_ATTEMPTS,
	NOTES_REF,
	type RefAdvanceGateInput,
	TERMINAL_BATCH_STATES,
	unavailable,
	VERDICT_POLL_MS,
	verdictEventType,
	workRefs,
	ZERO_SHA,
} from "@tartan/contract";
import {
	type ExtDispatch,
	KERNEL_LANE_ACTOR,
	type KernelWriteIntent,
	type LaneFetchSpec,
	type RepoCoreFacade,
	type RepoProbeApi,
} from "@tartan/contract/kernel.ts";
import type { StepConfig, StepLike } from "../runs/driver.ts";
import type { LandGit } from "./git.ts";
import { KERNEL_GIT_IDENTITY } from "./gitjobs.ts";
import { type LaneRepoAccess, withLaneRepoCred } from "./lanerepos.ts";
import { encodeNote } from "./notes.ts";
import { composedTouches } from "./policy.ts";
import { buildNotesOn, type NotesPlan, pushNotes } from "./notesflow.ts";
import { type LandFacade, RANGE_LIST_MAX } from "./types.ts";
import type { CanonicalAccess } from "./upstream.ts";

export type { StepLike };

/** How long the K14 wait lasts in all (`VERDICT_TIMEOUT`). */
export const VERDICT_WAIT_MS = 60 * 60 * 1000;
/** K5 waits back off from 2 s to 30 s. */
export const K5_WAIT_MIN_MS = 2_000;
export const K5_WAIT_STEP_MAX_MS = 30_000;
/**
 * K13.1 waits back off from 5 s to 5 min. A batch held for 30 min returns to
 * its queue (`config-hold`): its lanes are not frozen for longer, and its
 * queue submits it again once the hold may have lifted (K9).
 */
export const CONFIG_HOLD_MIN_MS = 5_000;
export const CONFIG_HOLD_STEP_MAX_MS = 5 * 60_000;
export const CONFIG_HOLD_MAX_MS = 30 * 60_000;

const RPC_STEP: StepConfig = {
	retries: { limit: 5, delay: 1_000, backoff: "exponential" },
	timeout: 60_000,
};
const GIT_STEP: StepConfig = {
	retries: { limit: 5, delay: 5_000, backoff: "exponential" },
	timeout: 10 * 60_000,
};
const PUSH_STEP: StepConfig = {
	retries: { limit: 8, delay: 5_000, backoff: "exponential" },
	timeout: 5 * 60_000,
};

export type LandServices = {
	readonly land:
		& Pick<
			LandFacade,
			| "batch"
			| "status"
			| "composePlan"
			| "recordCompose"
			| "recordGates"
			| "setBatchState"
			| "nextAttempt"
			| "verdict"
			| "beginAdvance"
			| "markAdvanceStep"
			| "completeAdvance"
			| "releaseAdvance"
			| "whyNote"
		>
		& Partial<Pick<LandFacade, "configHold">>;
	readonly core: Pick<
		RepoCoreFacade,
		"laneFetchSpecs" | "closeLane" | "getLane"
	>;
	readonly canonical: CanonicalAccess;
	/** Lane repos of this repo (`repo`-backend lanes): one scoped token per use. */
	readonly laneRepos: LaneRepoAccess;
	/** The `git:<repoId>` sandbox's executor (a fresh one per step). */
	git(): LandGit;
	probe(): Pick<RepoProbeApi, "affected" | "addedLines" | "diffPaths">;
	readonly gates: Pick<ExtDispatch, "gates">;
	log(message: string, data: Record<string, unknown>): void;
};

export type DriveInput = {
	readonly repoId: string;
	readonly batchId: string;
	readonly instanceId: string;
	readonly waitMode: "event" | "poll";
};

export type DriveResult = {
	readonly state: LandBatchState;
	readonly attempt: number;
	readonly landed?: readonly { changeId: string; commit: string }[];
	readonly reason?: string;
};

type Composed = {
	readonly kind: "composed";
	readonly base: string;
	readonly candidate: string;
	readonly landed: readonly {
		readonly changeId: string;
		readonly laneId: string;
		readonly head: string;
		readonly commit: string;
		readonly parent: string;
	}[];
	readonly conflicted: readonly string[];
	readonly date: number;
};

type ComposeOutcome =
	| Composed
	| { readonly kind: "ended"; readonly state: LandBatchState }
	| { readonly kind: "jump"; readonly attempt: number };

type Locked = {
	readonly kind: "locked";
	readonly advanceId: string;
	readonly expectOld: string;
};

type Restacked = {
	readonly kind: "restacked";
	readonly newSha: string;
	readonly notesBase: string;
	readonly notesTip: string;
	/** `laneId` is absent in step outputs persisted before multi-repo compose. */
	readonly changeRefs: readonly {
		ref: string;
		head: string;
		laneId?: string;
	}[];
};

const TERMINAL: ReadonlySet<LandBatchState> = new Set(TERMINAL_BATCH_STATES);

const isConflictCode = (error: unknown, code: string): boolean => {
	const e = fromRpcError(error);
	return e.code === "conflict" && e.text.startsWith(`${code}:`);
};

/** Tokens minted for one exec's use, revoked right after. */
const withCred = async <T>(
	canonical: CanonicalAccess,
	scope: "read" | "write",
	use: (cred: { remote: string; token: string }) => Promise<T>,
): Promise<T> => {
	const t = await canonical.token(scope);
	try {
		return await use({ remote: t.remote, token: t.token });
	} finally {
		await t.revoke();
	}
};

export const driveLand = async (
	step: StepLike,
	svc: LandServices,
	input: DriveInput,
): Promise<DriveResult> => {
	const { batchId } = input;
	const work = workRefs(batchId);
	const notesWorkRef = `refs/notes/tartan-work/${batchUlidOf(batchId)}`;

	const loaded = await step.do("load", RPC_STEP, async () => {
		const detail = await svc.land.batch(batchId);
		if (detail === null) return null;
		return {
			state: detail.status.state,
			attempt: detail.status.attempt,
			ref: detail.status.ref,
			testPolicy: detail.testPolicy,
		};
	});
	if (loaded === null) {
		return { state: "failed", attempt: 0, reason: "unknown batch" };
	}
	if (TERMINAL.has(loaded.state)) {
		return { state: loaded.state, attempt: loaded.attempt };
	}
	const ref = loaded.ref;

	// ---------------------------------------------------------------------
	// compose-n
	// ---------------------------------------------------------------------

	const lockedFetch = async (
		git: LandGit,
		specs: readonly { sha: string; ref: string }[],
	): Promise<void> => {
		const missing: { sha: string; ref: string }[] = [];
		for (const s of specs) if (!(await git.has(s.sha))) missing.push(s);
		if (missing.length === 0) return;
		await withCred(svc.canonical, "read", (cred) => git.fetch(cred, missing));
	};

	/** Each missing head by SHA from its lane repo, one scoped token per repo. */
	const fetchFromLaneRepos = async (
		git: LandGit,
		specs: readonly { name: string; sha: string; ref: string }[],
	): Promise<void> => {
		const byRepo = new Map<string, { sha: string; ref: string }[]>();
		for (const s of specs) {
			if (await git.has(s.sha)) continue;
			byRepo.set(s.name, [...(byRepo.get(s.name) ?? []), {
				sha: s.sha,
				ref: s.ref,
			}]);
		}
		for (const [name, missing] of byRepo) {
			await withLaneRepoCred(
				svc.laneRepos,
				name,
				"read",
				(cred) => git.fetch(cred, missing),
			);
		}
	};

	/** The lane repo of each `repo`-backend lane among `laneIds`. */
	const laneRepoNames = async (
		laneIds: readonly string[],
	): Promise<Map<string, string>> => {
		const unique = [...new Set(laneIds)];
		const found = new Map<string, string>();
		if (unique.length === 0) return found;
		const specs = await svc.core.laneFetchSpecs(unique);
		const pairs: [string, LaneFetchSpec | undefined][] =
			specs.length === unique.length
				? unique.map((laneId, i) => [laneId, specs[i]])
				// An unknown lane was skipped: ask one by one, so none is misattributed.
				: await Promise.all(
					unique.map(async (
						laneId,
					): Promise<[string, LaneFetchSpec | undefined]> => [
						laneId,
						(await svc.core.laneFetchSpecs([laneId]))[0],
					]),
				);
		for (const [laneId, spec] of pairs) {
			if (
				spec !== undefined && spec.token.artifactsName !== svc.canonical.name
			) {
				found.set(laneId, spec.token.artifactsName);
			}
		}
		return found;
	};

	const composeStep = async (attempt: number): Promise<ComposeOutcome> => {
		const detail = await svc.land.batch(batchId);
		if (detail === null) throw conflict(`batch ${batchId} vanished`);
		const st = detail.status;
		if (TERMINAL.has(st.state)) return { kind: "ended", state: st.state };
		if (st.attempt !== attempt) return { kind: "jump", attempt: st.attempt };
		const heads = new Map(detail.changes.map((c) => [c.changeId, c.head]));
		if (st.state !== "composing") {
			// A re-run after recordCompose and the candidate push committed.
			if (st.candidateSha === undefined) {
				throw conflict(`batch ${batchId} is ${st.state} without a candidate`);
			}
			const landed = [];
			let parent = st.baseSha;
			for (const c of st.changes) {
				if (c.outcome !== "pending" || c.commit === undefined) continue;
				landed.push({
					changeId: c.changeId,
					laneId: c.laneId,
					head: heads.get(c.changeId) as string,
					commit: c.commit,
					parent,
				});
				parent = c.commit;
			}
			return {
				kind: "composed",
				base: st.baseSha,
				candidate: st.candidateSha,
				landed,
				conflicted: st.changes.filter((c) => c.outcome === "conflicted").map((
					c,
				) => c.changeId),
				date: Math.floor(st.createdAt / 1000),
			};
		}
		const pending = st.changes.filter((c) => c.outcome === "pending");
		const base = st.baseSha;
		const git = svc.git();
		await git.ensureMirror();
		const specs: LaneFetchSpec[] = await svc.core.laneFetchSpecs(
			pending.map((c) => c.laneId),
		);
		if (specs.length !== pending.length) {
			throw conflict(`batch ${batchId}: a lane of the batch is unknown`);
		}
		// Trunk and `branch`-lane heads come from the canonical repo; each
		// `repo`-lane head from its own lane repo, with a read token scoped
		// to that one repo (a token for one lane repo never reads another).
		const fromCanonical: { sha: string; ref: string }[] = [
			{ sha: base, ref: work.trunk },
		];
		const fromLaneRepos: { name: string; sha: string; ref: string }[] = [];
		pending.forEach((c, i) => {
			const sha = heads.get(c.changeId) as string;
			const spec = specs[i];
			if (spec.token.artifactsName === svc.canonical.name) {
				fromCanonical.push({ sha, ref: work.lane(i) });
			} else {
				fromLaneRepos.push({
					name: spec.token.artifactsName,
					sha,
					ref: work.lane(i),
				});
			}
		});
		await lockedFetch(git, fromCanonical);
		await fetchFromLaneRepos(git, fromLaneRepos);
		const ranges = [];
		for (const c of pending) {
			const commits = await git.revList(
				heads.get(c.changeId) as string,
				base,
				RANGE_LIST_MAX + 1,
			);
			ranges.push({
				changeId: c.changeId,
				commits: commits.slice(0, RANGE_LIST_MAX),
				truncated: commits.length > RANGE_LIST_MAX,
			});
		}
		const plan = await svc.land.composePlan(batchId, attempt, ranges);
		let tip = base;
		const landed: Composed["landed"][number][] = [];
		const conflicted: string[] = [];
		const perChange = [];
		for (const change of plan.changes) {
			const merged = await git.mergeTree(tip, change.head);
			if (merged.clean) {
				const commit = await git.commitTree({
					tree: merged.tree,
					parent: tip,
					message: change.message,
					author: change.author,
					committer: plan.committer,
					date: plan.date,
				});
				const paths = await git.diffPaths(tip, commit);
				// K13.2: the candidate's root `*.cue` digest of a policy change.
				const policyDigest =
					composedTouches(paths) && git.policyDigest !== undefined
						? await git.policyDigest(commit)
						: undefined;
				landed.push({
					changeId: change.changeId,
					laneId: change.laneId,
					head: change.head,
					commit,
					parent: tip,
				});
				perChange.push({
					changeId: change.changeId,
					commit,
					paths,
					...(policyDigest === undefined ? {} : { policyDigest }),
				});
				tip = commit;
			} else {
				const regions = await git.conflictRegions(merged.tree, merged.paths);
				conflicted.push(change.changeId);
				perChange.push({
					changeId: change.changeId,
					conflict: {
						paths: [...merged.paths],
						regions,
						conflictsWith: landed.map((l) => l.changeId),
					},
				});
			}
		}
		await svc.land.recordCompose(batchId, attempt, tip, perChange);
		if (landed.length > 0) {
			const cand = candidateRef(batchId);
			const remote = await svc.canonical.refValue(cand);
			if (remote !== tip) {
				const pushed = await withCred(
					svc.canonical,
					"write",
					(cred) =>
						git.push(cred, [{
							src: tip,
							dst: cand,
							expect: remote ?? ZERO_SHA,
						}]),
				);
				const status = pushed.refs.find((r) => r.ref === cand);
				if (status?.kind !== "ok" && status?.kind !== "uptodate") {
					throw unavailable(
						`candidate push refused: ${status?.reason ?? "no status"}`,
					);
				}
			}
			await svc.land.setBatchState(batchId, "gating");
		}
		return {
			kind: "composed",
			base,
			candidate: tip,
			landed,
			conflicted,
			date: plan.date,
		};
	};

	// ---------------------------------------------------------------------
	// gate-n
	// ---------------------------------------------------------------------

	const actorOf = async (laneId: string): Promise<Actor> => {
		const lane = await svc.core.getLane(laneId);
		if (lane === null) return { kind: "system", id: "sys_kernel" };
		const kind = lane.owner.startsWith("u_") ? "user" : "agent";
		return lane.onBehalfOf
			? { kind, id: lane.owner, onBehalfOf: lane.onBehalfOf }
			: { kind, id: lane.owner };
	};

	const gateStep = async (
		attempt: number,
		composed: Composed,
	): Promise<{ vetoed: string[] }> => {
		const decisions = [];
		for (const change of composed.landed) {
			const source = { repoId: input.repoId };
			let lines: {
				lines: RefAdvanceGateInput["addedLines"];
				truncated: boolean;
			};
			let paths: readonly string[];
			try {
				const [added, diff] = await Promise.all([
					svc.probe().addedLines(source, change.parent, change.commit, {
						lines: GATE_INPUT_LIMITS.addedLines,
						bytes: GATE_INPUT_LIMITS.addedBytes,
					}),
					svc.probe().diffPaths(source, change.parent, change.commit),
				]);
				lines = { lines: added.lines, truncated: added.truncated };
				paths = diff.paths.map((p) => p.path);
				if (diff.truncated) lines = { ...lines, truncated: true };
			} catch (error) {
				svc.log("gate inputs unavailable; gates see a truncated input", {
					changeId: change.changeId,
					error: fromRpcError(error).message,
				});
				lines = { lines: [], truncated: true };
				paths = [];
			}
			const gateInput: RefAdvanceGateInput = {
				point: "ref.advance",
				repo: input.repoId,
				ref,
				base: change.parent,
				head: change.commit,
				laneHead: change.head,
				changeId: change.changeId,
				changedPaths: paths,
				addedLines: lines.lines,
				truncated: lines.truncated,
				workRefs: [],
				actor: await actorOf(change.laneId),
			};
			try {
				const result = await svc.gates.gates("ref.advance", gateInput, {
					nodeId: input.repoId,
					repoId: input.repoId,
				});
				decisions.push({
					changeId: change.changeId,
					truncated: lines.truncated,
					effective: result.effective,
					blocked: result.blocked,
				});
			} catch (error) {
				// No installation exists until WP7b's registry seam has its tree
				// (an M0 stub answers not_implemented): no gates in force.
				if (fromRpcError(error).code !== "not_implemented") throw error;
				decisions.push({
					changeId: change.changeId,
					truncated: lines.truncated,
					effective: [],
					blocked: false,
				});
			}
		}
		await svc.land.recordGates(batchId, attempt, decisions);
		// The outcome is the persisted one, never these fresh answers: a re-run
		// of this step whose gates answer differently (a probe back, a timeout
		// allowing) must not land a change the first run vetoed, since
		// `recordGates` never reopens it (K8).
		const status = await svc.land.status(batchId);
		const composedIds = new Set(composed.landed.map((c) => c.changeId));
		const persisted = (status?.changes ?? []).filter((c) =>
			composedIds.has(c.changeId) && c.outcome === "vetoed"
		).map((c) => c.changeId);
		return {
			vetoed: status === null
				? decisions.filter((d) => d.blocked).map((d) => d.changeId)
				: persisted,
		};
	};

	// ---------------------------------------------------------------------
	// test-n
	// ---------------------------------------------------------------------

	const testStep = async (composed: Composed): Promise<void> => {
		let affected: string[] = ["*"];
		try {
			const a = await svc.probe().affected(
				input.repoId,
				composed.base,
				composed.candidate,
			);
			affected = a.global ? ["*"] : [...a.projects];
		} catch (error) {
			svc.log("affected unavailable; testing everything", {
				error: fromRpcError(error).message,
			});
		}
		await svc.land.setBatchState(batchId, "testing", { affected });
	};

	const waitVerdict = async (
		attempt: number,
		candidate: string,
	): Promise<"success" | "failure" | "timeout" | "ended"> => {
		const iterations = Math.ceil(VERDICT_WAIT_MS / VERDICT_POLL_MS);
		for (let i = 0; i < iterations; i++) {
			if (input.waitMode === "event") {
				try {
					const event = await step.waitForEvent<
						{ attempt?: number; candidateSha?: string; state?: string }
					>(`verdict-${attempt}-${i}`, {
						type: verdictEventType(attempt),
						timeout: VERDICT_POLL_MS,
					});
					const p = event.payload ?? {};
					if (
						p.attempt === attempt && p.candidateSha === candidate &&
						(p.state === "success" || p.state === "failure")
					) {
						return p.state;
					}
				} catch {
					// Timed out: the poll below is the safety net (K14).
				}
			} else {
				await step.sleep(`verdict-sleep-${attempt}-${i}`, VERDICT_POLL_MS);
			}
			const polled = await step.do(
				landStepName("poll", attempt, i),
				RPC_STEP,
				async () => {
					const v = await svc.land.verdict(batchId, attempt, candidate);
					if (v !== null) return v.state;
					const st = await svc.land.status(batchId);
					return st === null || TERMINAL.has(st.state) ? "ended" : null;
				},
			);
			if (polled !== null) return polled;
		}
		return "timeout";
	};

	// ---------------------------------------------------------------------
	// lock-n
	// ---------------------------------------------------------------------

	const lockStep = async (
		attempt: number,
	): Promise<
		Locked | { kind: "wait" } | { kind: "failed" } | { kind: "ejected" }
	> => {
		const remote = await svc.canonical.refValue(ref);
		try {
			const r = await svc.land.beginAdvance(
				batchId,
				attempt,
				input.instanceId,
				{
					expectOld: remote ?? ZERO_SHA,
				},
			);
			if ("wait" in r) return { kind: "wait" };
			if ("ejected" in r) return { kind: "ejected" };
			return { kind: "locked", advanceId: r.advanceId, expectOld: r.expectOld };
		} catch (error) {
			if (isConflictCode(error, "trunk-unexplained")) return { kind: "failed" };
			throw error;
		}
	};

	// ---------------------------------------------------------------------
	// restack-n and the pushes
	// ---------------------------------------------------------------------

	const notesPlan = async (
		advanceId: string,
		composed: Composed,
	): Promise<NotesPlan> => {
		const notes = [];
		for (const change of composed.landed) {
			const note = await svc.land.whyNote(advanceId, change.changeId);
			notes.push({ commit: change.commit, text: encodeNote(note) });
		}
		return {
			workRef: notesWorkRef,
			notes,
			identity: KERNEL_GIT_IDENTITY,
			date: composed.date,
		};
	};

	const ensureObjects = async (git: LandGit, sha: string): Promise<void> => {
		if (await git.has(sha)) return;
		await withCred(
			svc.canonical,
			"read",
			(cred) => git.fetch(cred, [{ sha, ref: work.tip }]),
		);
	};

	const restackStep = async (
		lock: Locked,
		composed: Composed,
	): Promise<Restacked | { kind: "stale" }> => {
		if (lock.expectOld !== composed.base) {
			// Trunk moved since compose: K6's disjoint restack is M2, so the
			// batch is recomposed and re-tested on the new trunk.
			await svc.land.releaseAdvance(lock.advanceId, `stale ${lock.expectOld}`);
			return { kind: "stale" };
		}
		const newSha = composed.candidate;
		const git = svc.git();
		await git.ensureMirror();
		await ensureObjects(git, newSha);
		const plan = await notesPlan(lock.advanceId, composed);
		const notesBase = (await svc.canonical.refValue(NOTES_REF)) ?? ZERO_SHA;
		const notesTip = await buildNotesOn(
			{
				git,
				readCred: () => svc.canonical.token("read"),
			},
			plan,
			notesBase,
		);
		const refs = composed.landed.map((c) => ({
			ref: changeRef(c.changeId),
			head: c.head,
			laneId: c.laneId,
		}));
		const current = new Map(
			(await svc.canonical.lsRefs(refs.map((r) => r.ref))).map((r) => [
				r.ref,
				r.sha,
			]),
		);
		const own = { target: "repo", ownerKind: "land", ownerId: lock.advanceId };
		const intents: KernelWriteIntent[] = [
			{
				...own,
				ref,
				expectOld: lock.expectOld,
				newSha,
				purpose: "trunk",
			} as KernelWriteIntent,
			{
				...own,
				ref: NOTES_REF,
				expectOld: notesBase,
				newSha: notesTip,
				purpose: "notes",
			} as KernelWriteIntent,
			...refs.filter((r) => current.get(r.ref) !== r.head).map((r) =>
				({
					...own,
					ref: r.ref,
					expectOld: current.get(r.ref) ?? ZERO_SHA,
					newSha: r.head,
					purpose: "change-ref",
				}) as KernelWriteIntent
			),
		];
		await svc.land.markAdvanceStep(lock.advanceId, "restacked", {
			newSha,
			evidenceReused: false,
			intents,
		});
		return { kind: "restacked", newSha, notesBase, notesTip, changeRefs: refs };
	};

	const pushTrunkStep = async (
		lock: Locked,
		restacked: Restacked,
	): Promise<{ kind: "pushed" } | { kind: "stale" }> => {
		const stale = async (actual: string | null) => {
			await svc.land.releaseAdvance(
				lock.advanceId,
				`stale ${actual ?? ZERO_SHA}`,
			);
			return { kind: "stale" as const };
		};
		const remote = await svc.canonical.refValue(ref);
		if (remote === restacked.newSha) {
			await svc.land.markAdvanceStep(lock.advanceId, "trunk-pushed");
			return { kind: "pushed" };
		}
		if (remote !== lock.expectOld) return await stale(remote);
		const git = svc.git();
		await git.ensureMirror();
		await ensureObjects(git, restacked.newSha);
		const pushed = await withCred(
			svc.canonical,
			"write",
			(cred) =>
				git.push(cred, [{
					src: restacked.newSha,
					dst: ref,
					expect: lock.expectOld,
				}]),
		);
		const status = pushed.refs.find((r) => r.ref === ref);
		if (status?.kind !== "ok" && status?.kind !== "uptodate") {
			const after = await svc.canonical.refValue(ref);
			if (after === restacked.newSha) {
				// Landed although the report said otherwise (a lost response).
			} else if (after === lock.expectOld) {
				// An upstream lock, 5xx, timeout or a lease that still
				// shows expect_old is retried, never `advance.stale`.
				throw unavailable(
					`trunk push did not land (${
						status?.reason ?? "no status"
					}); retrying`,
				);
			} else {
				return await stale(after);
			}
		}
		await svc.land.markAdvanceStep(lock.advanceId, "trunk-pushed");
		return { kind: "pushed" };
	};

	const pushNotesStep = async (
		lock: Locked,
		composed: Composed,
		restacked: Restacked,
	): Promise<void> => {
		const git = svc.git();
		await git.ensureMirror();
		const plan = await notesPlan(lock.advanceId, composed);
		await pushNotes(
			{
				git,
				remoteTip: () => svc.canonical.refValue(NOTES_REF),
				readCred: () => svc.canonical.token("read"),
				writeCred: () => svc.canonical.token("write"),
				register: (base, tip) =>
					svc.land.markAdvanceStep(lock.advanceId, "trunk-pushed", {
						intents: [{
							target: "repo",
							ref: NOTES_REF,
							expectOld: base,
							newSha: tip,
							purpose: "notes",
							ownerKind: "land",
							ownerId: lock.advanceId,
						}],
					}),
			},
			plan,
			{ base: restacked.notesBase, tip: restacked.notesTip },
		);
		await svc.land.markAdvanceStep(lock.advanceId, "notes-pushed");
	};

	const pushRefsStep = async (
		lock: Locked,
		restacked: Restacked,
	): Promise<void> => {
		const refs = restacked.changeRefs;
		if (refs.length > 0) {
			const current = new Map(
				(await svc.canonical.lsRefs(refs.map((r) => r.ref))).map((r) => [
					r.ref,
					r.sha,
				]),
			);
			const todo = refs.filter((r) => current.get(r.ref) !== r.head);
			if (todo.length > 0) {
				// The same transition as registered at restack, or a fresh one
				// superseding it when the ref moved since.
				await svc.land.markAdvanceStep(lock.advanceId, "notes-pushed", {
					intents: todo.map((r) => ({
						target: "repo",
						ref: r.ref,
						expectOld: current.get(r.ref) ?? ZERO_SHA,
						newSha: r.head,
						purpose: "change-ref" as const,
						ownerKind: "land" as const,
						ownerId: lock.advanceId,
					})),
				});
				// `branch` lanes: the heads are in the canonical repo, so the
				// write is ref-only. `repo` lanes: the heads live in their lane
				// repos, so they are pushed from the mirror with their objects
				// (a restarted container's mirror re-fetches them by SHA first).
				const laneRepoOf = await laneRepoNames(
					todo.flatMap((r) => r.laneId === undefined ? [] : [r.laneId]),
				);
				const inLaneRepo = (r: { laneId?: string }) =>
					r.laneId !== undefined && laneRepoOf.has(r.laneId);
				const refOnly = todo.filter((r) => !inLaneRepo(r));
				const withObjects = todo.filter(inLaneRepo);
				if (refOnly.length > 0) {
					const statuses = await svc.canonical.pushRefs(
						refOnly.map((r) => ({
							ref: r.ref,
							old: current.get(r.ref) ?? ZERO_SHA,
							new: r.head,
						})),
					);
					if (statuses.some((s) => !s.ok)) {
						throw unavailable(
							`change refs refused: ${
								statuses.filter((s) => !s.ok).map((s) => `${s.ref} ${s.reason}`)
									.join(", ")
							}`,
						);
					}
				}
				if (withObjects.length > 0) {
					const git = svc.git();
					await git.ensureMirror();
					await fetchFromLaneRepos(
						git,
						withObjects.map((r, i) => ({
							name: laneRepoOf.get(r.laneId as string) as string,
							sha: r.head,
							ref: `${work.tip}-change-${i}`,
						})),
					);
					const pushed = await withCred(
						svc.canonical,
						"write",
						(cred) =>
							git.push(
								cred,
								withObjects.map((r) => ({
									src: r.head,
									dst: r.ref,
									expect: current.get(r.ref) ?? ZERO_SHA,
								})),
							),
					);
					const refused = withObjects.filter((r) => {
						const status = pushed.refs.find((p) => p.ref === r.ref);
						return status?.kind !== "ok" && status?.kind !== "uptodate";
					});
					if (refused.length > 0) {
						throw unavailable(
							`change refs refused: ${refused.map((r) => r.ref).join(", ")}`,
						);
					}
				}
			}
		}
		await svc.land.markAdvanceStep(lock.advanceId, "refs-pushed");
	};

	const completeStep = async (
		lock: Locked,
		composed: Composed,
	): Promise<DriveResult> => {
		await svc.land.completeAdvance(lock.advanceId);
		const st = await svc.land.status(batchId);
		for (const c of st?.changes ?? []) {
			if (c.outcome !== "landed") continue;
			try {
				// Only a lane that completeAdvance moved to `landed`: one whose
				// head moved under the freeze was reopened instead.
				const lane = await svc.core.getLane(c.laneId);
				if (lane?.state !== "landed") continue;
				await svc.core.closeLane(c.laneId, "landed", KERNEL_LANE_ACTOR);
			} catch (error) {
				svc.log("closing a landed lane failed", {
					laneId: c.laneId,
					error: fromRpcError(error).message,
				});
			}
		}
		try {
			const git = svc.git();
			await git.cleanup(`refs/tartan-work/${batchUlidOf(batchId)}/`);
		} catch {
			// Work refs are scratch space in the mirror.
		}
		return {
			state: "landed",
			attempt: st?.attempt ?? 0,
			landed: composed.landed.map((c) => ({
				changeId: c.changeId,
				commit: c.commit,
			})),
		};
	};

	// ---------------------------------------------------------------------
	// The attempts
	// ---------------------------------------------------------------------

	const end = async (
		attempt: number,
		state: Exclude<LandBatchState, "landed">,
		result: { reason: string; message?: string; failing?: string[] },
	): Promise<DriveResult> => {
		await step.do(`end-${attempt}`, RPC_STEP, async () => {
			const st = await svc.land.status(batchId);
			if (st !== null && !TERMINAL.has(st.state)) {
				await svc.land.setBatchState(batchId, state, result);
			}
			return null;
		});
		return { state, attempt, reason: result.reason };
	};

	const next = async (
		attempt: number,
		reason: "stale" | "vetoed",
	): Promise<number | DriveResult> => {
		const n = await step.do(`next-${attempt}`, RPC_STEP, async () => {
			const st = await svc.land.status(batchId);
			if (st !== null && st.attempt > attempt) return { attempt: st.attempt };
			return await svc.land.nextAttempt(batchId, reason);
		});
		if ("exhausted" in n) {
			const st = await step.do(
				`ended-${attempt}`,
				RPC_STEP,
				async () => (await svc.land.status(batchId))?.state ?? "failed",
			);
			return { state: st, attempt, reason };
		}
		return n.attempt;
	};

	/** The K13.1 hold checks and waits of one attempt (iteration-named steps). */
	type HoldState = { i: number; waited: number };

	/**
	 * K13.1: waits while repository config of this repo resolves (RepoDO's
	 * pending resolution, or ForgeDO's gate-missing hold). Returns whether it
	 * waited, or a result when the hold outlived `CONFIG_HOLD_MAX_MS`: the
	 * batch ends with reason `config-hold`, a delay that returns the changes
	 * to their queue, never a veto (K9). Each check and sleep is its own
	 * step, named by a counter that runs across every wait of the attempt.
	 */
	const configHold = async (
		attempt: number,
		state: HoldState,
	): Promise<boolean | DriveResult> => {
		const check = svc.land.configHold;
		if (check === undefined) return false;
		let slept = false;
		for (;;) {
			const i = state.i++;
			const hold = await step.do(
				landStepName("config-hold", attempt, i),
				RPC_STEP,
				async () => await check(),
			);
			if (!hold.held) return slept;
			const delay = Math.min(
				CONFIG_HOLD_STEP_MAX_MS,
				CONFIG_HOLD_MIN_MS * 2 ** Math.min(i, 16),
			);
			if (state.waited + delay > CONFIG_HOLD_MAX_MS) {
				return await end(attempt, "failed", {
					reason: "config-hold",
					message: `repository config held this land for ${
						Math.round(CONFIG_HOLD_MAX_MS / 60_000)
					} min (${
						hold.reason ?? "pending"
					}); the changes are back in their queue and land once the hold lifts`,
				});
			}
			state.waited += delay;
			slept = true;
			await step.sleep(landStepName("config-wait", attempt, i), delay);
		}
	};

	/**
	 * The gates of an attempt, worked out only from resolved repository
	 * config (K13.1): the hold is waited out BEFORE the gate step, so gates
	 * come from the installations the resolved trunk config gives; a hold
	 * that began while the gates ran (a registry change that dropped a gate)
	 * is waited out and the gates run again.
	 */
	const gatesResolved = async (
		attempt: number,
		composed: Composed,
		hold: HoldState,
		gate: { pass: number },
	): Promise<{ vetoed: string[] } | DriveResult> => {
		for (;;) {
			const before = await configHold(attempt, hold);
			if (typeof before !== "boolean") return before;
			const pass = gate.pass++;
			const gated = await step.do(
				pass === 0
					? landStepName("gate", attempt)
					: landStepName("gate", attempt, pass),
				RPC_STEP,
				() => gateStep(attempt, composed),
			);
			if (gated.vetoed.length > 0) return gated;
			const after = await configHold(attempt, hold);
			if (typeof after !== "boolean") return after;
			if (!after) return gated;
		}
	};

	let attempt = loaded.attempt;
	let pushedTrunk = false;
	/** The trunk value this attempt may have pushed (after restack-n). */
	let pushing: string | null = null;
	try {
		for (let round = 0; round <= MAX_LAND_ATTEMPTS + 1; round++) {
			const composed = await step.do(
				landStepName("compose", attempt),
				GIT_STEP,
				() => composeStep(attempt),
			);
			if (composed.kind === "ended") {
				return { state: composed.state, attempt };
			}
			if (composed.kind === "jump") {
				attempt = composed.attempt;
				continue;
			}
			if (composed.landed.length === 0) {
				return await end(attempt, "conflicted", { reason: "conflicted" });
			}
			const hold: HoldState = { i: 0, waited: 0 };
			const gate = { pass: 0 };
			const gated = await gatesResolved(attempt, composed, hold, gate);
			if (!("vetoed" in gated)) return gated;
			if (gated.vetoed.length > 0) {
				const n = await next(attempt, "vetoed");
				if (typeof n !== "number") return n;
				attempt = n;
				continue;
			}
			if (loaded.testPolicy === "checks") {
				await step.do(
					landStepName("test", attempt),
					RPC_STEP,
					() => testStep(composed),
				);
				const verdict = await waitVerdict(attempt, composed.candidate);
				if (verdict === "ended") {
					const st = await step.do(
						`ended-${attempt}`,
						RPC_STEP,
						async () => (await svc.land.status(batchId))?.state ?? "failed",
					);
					return { state: st, attempt };
				}
				if (verdict !== "success") {
					return await end(attempt, "failed", {
						reason: verdict === "failure" ? "tests" : "error",
						...(verdict === "timeout"
							? { message: "no verdict within 60 minutes" }
							: {}),
					});
				}
				// A hold that began while the tests ran: its gates run again
				// once it lifts (the candidate is unchanged, so the tests stand).
				const late = await configHold(attempt, hold);
				if (typeof late !== "boolean") return late;
				if (late) {
					const regated = await gatesResolved(attempt, composed, hold, gate);
					if (!("vetoed" in regated)) return regated;
					if (regated.vetoed.length > 0) {
						const n = await next(attempt, "vetoed");
						if (typeof n !== "number") return n;
						attempt = n;
						continue;
					}
				}
			}
			let lock: Locked | null = null;
			let ejected = false;
			let waited = 0;
			for (let i = 0;; i++) {
				const name = i === 0
					? landStepName("lock", attempt)
					: `lock-${attempt}-${i}`;
				const r = await step.do(name, RPC_STEP, () => lockStep(attempt));
				if (r.kind === "locked") {
					lock = r;
					break;
				}
				if (r.kind === "ejected") {
					ejected = true;
					break;
				}
				if (r.kind === "failed") {
					return { state: "failed", attempt, reason: "trunk-unexplained" };
				}
				const delay = Math.min(K5_WAIT_STEP_MAX_MS, K5_WAIT_MIN_MS * 2 ** i);
				if (waited + delay > K5_WAIT_MAX_MS) {
					return await end(attempt, "failed", {
						reason: "error",
						message: "the K5 lock stayed held for 30 minutes",
					});
				}
				waited += delay;
				await step.sleep(landStepName("k5-wait", attempt, i), delay);
			}
			if (ejected || lock === null) {
				// K13.3: a policy sign-off no longer stands; the rest of the
				// batch is composed again without that change.
				const n = await next(attempt, "vetoed");
				if (typeof n !== "number") return n;
				attempt = n;
				continue;
			}
			const restacked = await step.do(
				landStepName("restack", attempt),
				GIT_STEP,
				() => restackStep(lock, composed),
			);
			if (restacked.kind === "stale") {
				const n = await next(attempt, "stale");
				if (typeof n !== "number") return n;
				attempt = n;
				continue;
			}
			pushing = restacked.newSha;
			const trunk = await step.do(
				landStepName("push-trunk", attempt),
				PUSH_STEP,
				() => pushTrunkStep(lock, restacked),
			);
			if (trunk.kind === "stale") {
				pushing = null;
				const n = await next(attempt, "stale");
				if (typeof n !== "number") return n;
				attempt = n;
				continue;
			}
			pushedTrunk = true;
			await step.do(
				landStepName("push-notes", attempt),
				PUSH_STEP,
				async () => {
					await pushNotesStep(lock, composed, restacked);
					return null;
				},
			);
			await step.do(
				landStepName("push-refs", attempt),
				PUSH_STEP,
				async () => {
					await pushRefsStep(lock, restacked);
					return null;
				},
			);
			return await step.do(
				landStepName("complete", attempt),
				RPC_STEP,
				() => completeStep(lock, composed),
			);
		}
		return await end(attempt, "failed", {
			reason: "error",
			message: "too many attempts",
		});
	} catch (error) {
		if (pushedTrunk) {
			// Trunk moved: the K5 sweeper completes the advance and repairs the
			// notes and change refs once this instance has ended.
			throw error;
		}
		const message = fromRpcError(error).message.slice(0, 500);
		svc.log("land attempt failed", { batchId, attempt, error: message });
		try {
			await step.do(`abort-${attempt}`, RPC_STEP, async () => {
				const st = await svc.land.status(batchId);
				if (st === null || TERMINAL.has(st.state)) return null;
				if (
					pushing !== null && (await svc.canonical.refValue(ref)) === pushing
				) {
					// The trunk push landed after all: the sweeper completes it.
					return null;
				}
				if (st.advanceId !== undefined) {
					await svc.land.releaseAdvance(st.advanceId, `error: ${message}`)
						.catch(() => {});
				}
				await svc.land.setBatchState(batchId, "failed", {
					reason: "error",
					message,
				});
				return null;
			});
		} catch {
			// The sweeper and the outbox see what is left.
		}
		throw error;
	}
};
