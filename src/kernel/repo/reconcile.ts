// Ref index reconciliation: protocol v2
// `ls-refs` with `ref-prefix` arguments, so a repo with a thousand lane refs
// still costs one small response. The cron covers the default branch, the
// protected patterns, `refs/tartan/`, `refs/notes/tartan` and, only while
// the repo has active `branch` lanes, `refs/heads/lanes/` (plus each active
// adopted branch exactly); a CAS miss reconciles exactly its refs. Every
// mismatch goes through the observation path (K1 for protected and kernel
// refs, K2 for lane heads), so detection survives a dropped trigger.
// The `ls-refs` answer can be older than the index by the time it arrives
// (a push recorded meanwhile), so a ref whose index entry changed during the
// call is left for the next run instead of being compared.

import {
	invalid,
	isValidRefName,
	LANE_BRANCH_PREFIX,
	NOTES_REF,
	TARTAN_REF_PREFIX,
	ZERO_SHA,
} from "@tartan/contract";
import type { LaneRow, RefRow } from "@tartan/contract/kernel.ts";
import {
	type Core,
	emit,
	first,
	isImporting,
	repoIdentity,
	rows,
} from "./core.ts";
import { authorizationFor } from "./gitremote.ts";
import type { LaneBackends } from "./lanes/facade.ts";
import { laneRow } from "./lanes/rows.ts";
import { observeTransitionSync, pruneTriggerSeen } from "./observe.ts";
import type { Protection } from "./protection.ts";
import {
	CANONICAL,
	canonicalTarget,
	laneRepoSide,
	patternPrefix,
} from "./refs.ts";
import type { ArtifactsAccess } from "./upstream.ts";

/** A repo with no push for this long is reconciled once a day instead of every run. */
export const IDLE_AFTER_MS = 24 * 60 * 60 * 1000;

export type Reconciler = {
	/** `refs` given: exactly those refs (CAS miss); omitted: the cron's prefix set. */
	reconcile(refs?: readonly string[]): Promise<{ changed: string[] }>;
	/** One lane's head against its backend's `readTip` (a report disagreed with `head_sha`). */
	reconcileLane(laneId: string): Promise<void>;
	/** The `ref-prefix` arguments of a cron run (tests, diagnostics). */
	cronPrefixes(): string[];
};

/** What identifies one index entry's value and the push that wrote it. */
const fingerprint = (row: RefRow | undefined): string =>
	row === undefined ? "" : `${row.sha}|${row.push_id ?? ""}|${row.updated_at}`;

/** Drops prefixes another prefix already covers. */
const minimalPrefixes = (prefixes: readonly string[]): string[] => {
	const sorted = [...new Set(prefixes)].sort();
	return sorted.filter((prefix, i) =>
		!sorted.some((other, j) =>
			j !== i && other.endsWith("/") && prefix.startsWith(other) &&
			other !== prefix
		)
	);
};

export const createReconciler = (deps: {
	readonly core: Core;
	readonly access: ArtifactsAccess;
	readonly protection: Protection;
	readonly backends: LaneBackends;
}): Reconciler => {
	const { core, access, protection, backends } = deps;
	let lastFullRun = -Infinity;

	const cronPrefixes = (): string[] => {
		const identity = repoIdentity(core.sql);
		const branchLanes = first<{ n: number }>(
			core.sql,
			`SELECT COUNT(*) AS n FROM lanes WHERE mode = 'branch' AND kind = 'lane'
			 AND state IN ('open','submitted','landing','lost')`,
		)?.n ?? 0;
		const adopted = rows<{ ref: string }>(
			core.sql,
			`SELECT ref FROM lanes WHERE kind = 'adopted'
			 AND state IN ('open','submitted','landing','lost')`,
		).map((row) => row.ref);
		return minimalPrefixes([
			`refs/heads/${identity.defaultBranch}`,
			...protection.patterns().map(patternPrefix),
			TARTAN_REF_PREFIX,
			NOTES_REF,
			...(branchLanes > 0 ? [LANE_BRANCH_PREFIX] : []),
			...adopted,
		]);
	};

	const idleSkip = (): boolean => {
		const now = core.clock.now();
		const lastPush = first<{ at: number | null }>(
			core.sql,
			"SELECT MAX(at) AS at FROM pushes",
		)?.at ?? null;
		const liveLanes = first<{ n: number }>(
			core.sql,
			"SELECT COUNT(*) AS n FROM lanes WHERE state IN ('opening','open','submitted','landing','lost')",
		)?.n ?? 0;
		const active = liveLanes > 0 ||
			(lastPush !== null && now - lastPush < IDLE_AFTER_MS);
		if (active) return false;
		const lastRun = Number.isFinite(lastFullRun)
			? lastFullRun
			: first<{ at: number | null }>(
				core.sql,
				"SELECT MIN(reconciled_at) AS at FROM refs",
			)?.at ?? null;
		return lastRun !== null && now - lastRun < IDLE_AFTER_MS;
	};

	const reconcile = async (
		refs?: readonly string[],
	): Promise<{ changed: string[] }> => {
		const identity = repoIdentity(core.sql);
		if (isImporting(core.sql)) return { changed: [] };
		if (refs !== undefined) {
			for (const ref of refs) {
				if (!isValidRefName(ref)) throw invalid(`invalid ref: ${ref}`);
			}
			if (refs.length === 0) return { changed: [] };
		} else {
			core.tx(() => pruneTriggerSeen(core));
			if (idleSkip()) return { changed: [] };
		}
		await protection.refresh();
		const prefixes = refs === undefined ? cronPrefixes() : [...new Set(refs)];
		const inScope = (ref: string): boolean =>
			refs === undefined
				? prefixes.some((prefix) => ref.startsWith(prefix))
				: prefixes.includes(ref);
		const indexInScope = (): Map<string, RefRow> =>
			new Map(
				rows<RefRow>(core.sql, "SELECT * FROM refs")
					.filter((row) => inScope(row.ref))
					.map((row) => [row.ref, row]),
			);
		const before = new Map(
			[...indexInScope()].map(([ref, row]) => [ref, fingerprint(row)]),
		);
		const token = await access.token(identity.artifactsName, "read");
		const remote = await core.ports.lsRefs(
			{ url: token.remote, authorization: authorizationFor(token.token) },
			{ refPrefixes: prefixes, peel: true },
		);
		const { changed, moved } = core.tx(() => {
			const now = core.clock.now();
			const upstream = new Map(
				remote.filter((ref) => inScope(ref.ref)).map((ref) => [ref.ref, ref]),
			);
			const index = indexInScope();
			const result: string[] = [];
			const skipped: string[] = [];
			for (
				const ref of [...new Set([...index.keys(), ...upstream.keys()])].sort()
			) {
				if ((before.get(ref) ?? "") !== fingerprint(index.get(ref))) {
					// Written while `ls-refs` was in flight: the answer may predate it.
					skipped.push(ref);
					continue;
				}
				const indexSha = index.get(ref)?.sha ?? ZERO_SHA;
				const remoteRef = upstream.get(ref);
				const remoteSha = remoteRef?.sha ?? ZERO_SHA;
				if (indexSha === remoteSha) {
					core.sql.exec(
						"UPDATE refs SET reconciled_at = ?, peeled = COALESCE(?, peeled) WHERE ref = ?",
						now,
						remoteRef?.peeled ?? null,
						ref,
					);
					continue;
				}
				const outcome = observeTransitionSync(core, {
					side: CANONICAL,
					target: canonicalTarget(core.sql, ref),
					ref,
					before: indexSha,
					after: remoteSha,
					source: "reconcile",
					requestId: `rc_${core.ids.ulid()}`,
				}, protection.patterns());
				emit(core, {
					type: "ref.reconciled",
					data: {
						ref,
						indexSha: indexSha === ZERO_SHA ? null : indexSha,
						remoteSha: remoteSha === ZERO_SHA ? null : remoteSha,
						matched: outcome.kind !== "parked",
					},
				});
				result.push(ref);
			}
			return { changed: result, moved: skipped };
		});
		if (moved.length > 0) {
			core.ports.log(
				"reconcile: refs moved during ls-refs, left for the next run",
				{
					refs: moved,
				},
			);
		}
		if (refs === undefined) lastFullRun = core.clock.now();
		return { changed };
	};

	const reconcileLane = async (laneId: string): Promise<void> => {
		const lane = laneRow(core.sql, laneId);
		if (lane === null) return;
		if (lane.mode === "branch") {
			await reconcile([lane.ref]);
			return;
		}
		if (lane.repo_name === null || lane.state === "opening") return;
		const tip = await backends.repo.readTip(lane);
		core.tx(() => {
			const current = laneRow(core.sql, laneId) as LaneRow;
			const head = current.head_sha ?? ZERO_SHA;
			const after = tip ?? ZERO_SHA;
			if (head === after || current.repo_name !== lane.repo_name) return;
			// The head moved while `readTip` was in flight: the tip may predate it.
			if (current.head_sha !== lane.head_sha) return;
			observeTransitionSync(core, {
				side: laneRepoSide(lane.repo_name as string),
				target: laneId,
				ref: "refs/heads/main",
				before: head,
				after,
				source: "reconcile",
				requestId: `rc_${core.ids.ulid()}`,
			}, protection.patterns());
		});
	};

	return { reconcile, reconcileLane, cronPrefixes };
};
