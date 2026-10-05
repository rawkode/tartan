// K13.2 and K13.3 on the land path (WP25 writes, WP10 reviews; ADR repo
// config, "K13 in the kernel: the policy sign-off"). With
// repository config on, a change whose lane range touches a policy path
// (`isPolicyPath`: a root `*.cue` file of any package; a missing or
// truncated diff counts as touching) lands only with an unrevoked kernel
// sign-off of its head by a person who is still Maintainer+ at the repo,
// and a batch holds at most one such change. The kernel pins the sign-off
// event into the batch's reason chain itself (K4).
//
// After compose, the per-change paths are authoritative (a list at its cap
// counts as touching): the policy-touching change's candidate root `*.cue`
// digest must equal the digest its sign-off names, or the change is ejected
// with `config-plan-changed` (a person approved one config and trunk would
// get another). No evaluation runs on the land path.

import { denied, isPolicyPath, type LandChange, ROLE } from "@tartan/contract";
import type {
	ComposedChange,
	PolicySignoffRef,
} from "@tartan/contract/kernel.ts";
import type { LandCtx } from "./ctx.ts";

/** `recordCompose` keeps at most this many paths; a full list counts as touching. */
export const COMPOSED_PATHS_MAX = 5000;

/** The zero installation of a kernel ejection (`land.vetoed` names one). */
export const KERNEL_EJECTION_INST = "i_00000000000000000000000000";

export type CheckedPolicyChange = {
	readonly changeId: string;
	readonly laneId: string;
	readonly head: string;
	readonly signoff: PolicySignoffRef;
};

const active = (ctx: LandCtx) => {
	const rc = ctx.repoconfig;
	return rc !== null && rc.enabledSync() ? rc : null;
};

/**
 * K13.3 at `land.submit`, before its transaction (the role lookup and the
 * diff backfill are async). Throws `denied(policy-batch | policy-signoff)`.
 */
export const checkPolicyAtSubmit = async (
	ctx: LandCtx,
	changes: readonly Pick<LandChange, "changeId" | "laneId" | "head">[],
	nodeId: string,
): Promise<readonly CheckedPolicyChange[]> => {
	const rc = active(ctx);
	if (rc === null) return [];
	const touching: Pick<LandChange, "changeId" | "laneId" | "head">[] = [];
	for (const change of changes) {
		let touch = rc.policyTouchSync(change.laneId, change.head);
		if (touch === "unknown" && ctx.ports.laneRange !== undefined) {
			// Phase 2 of the head's push appends its `push.diffed`.
			try {
				await ctx.ports.laneRange(change.laneId);
			} catch (error) {
				ctx.ports.log("lane range for the policy check failed", {
					laneId: change.laneId,
					error: error instanceof Error ? error.message.slice(0, 200) : "",
				});
			}
			touch = rc.policyTouchSync(change.laneId, change.head);
		}
		if (touch !== "clean") touching.push(change);
	}
	if (touching.length === 0) return [];
	if (touching.length > 1) {
		throw denied(
			"policy-batch",
			`policy-batch: a batch holds at most one change that touches a root .cue file (${
				touching.map((c) => c.changeId).join(", ")
			}); land them one at a time`,
		);
	}
	const change = touching[0];
	const signoff = rc.signoffSync(change.laneId, change.head);
	if (signoff === null) {
		throw denied(
			"policy-signoff",
			`policy-signoff: ${change.changeId} changes a root .cue file (Tartan config; or its diff is unknown); a Maintainer must approve the policy change at head ${
				change.head.slice(0, 12)
			} first (K13)`,
		);
	}
	const role = ctx.ports.roleOf === undefined
		? 0
		: await ctx.ports.roleOf(signoff.signedBy, nodeId);
	if (role < ROLE.maintainer) {
		throw denied(
			"policy-signoff",
			`policy-signoff: ${signoff.signedBy} who signed off ${change.changeId} is no longer a Maintainer here`,
		);
	}
	return [{ ...change, signoff }];
};

/**
 * Inside the submit transaction: the sign-offs are still unrevoked and the
 * same; returns their event ids, which the kernel pins into the reason chain.
 */
export const pinPolicySignoffsSync = (
	ctx: LandCtx,
	checked: readonly CheckedPolicyChange[],
): string[] => {
	const rc = active(ctx);
	if (rc === null) return [];
	return checked.map((c) => {
		const now = rc.signoffSync(c.laneId, c.head);
		if (now === null || now.eventId !== c.signoff.eventId) {
			throw denied(
				"policy-signoff",
				`policy-signoff: the sign-off of ${c.changeId} was revoked or replaced`,
			);
		}
		return now.eventId;
	});
};

/** Whether a composed change touches a policy path (a capped list counts). */
export const composedTouches = (
	paths: readonly string[] | undefined,
): boolean =>
	paths === undefined || paths.length >= COMPOSED_PATHS_MAX ||
	paths.some(isPolicyPath);

export type Ejection = {
	readonly code: "policy-signoff" | "policy-batch" | "config-plan-changed";
	readonly message: string;
};

/**
 * K13.2 after compose: the changes to eject (in `recordCompose`'s
 * transaction). The first policy-touching change may stay only with its
 * sign-off and an equal candidate root `*.cue` digest; any later one is a
 * `policy-batch`.
 */
export const composeEjectionsSync = (
	ctx: LandCtx,
	changes: readonly {
		readonly changeId: string;
		readonly laneId: string;
		readonly head: string;
	}[],
	perChange: readonly ComposedChange[],
): Map<string, Ejection> => {
	const out = new Map<string, Ejection>();
	const rc = active(ctx);
	if (rc === null) return out;
	let seen = false;
	for (const item of perChange) {
		if (item.commit === undefined) continue;
		if (!composedTouches(item.paths)) continue;
		const change = changes.find((c) => c.changeId === item.changeId);
		if (change === undefined) continue;
		if (seen) {
			out.set(item.changeId, {
				code: "policy-batch",
				message:
					"a batch holds at most one change that touches a root .cue file",
			});
			continue;
		}
		seen = true;
		const signoff = rc.signoffSync(change.laneId, change.head);
		if (signoff === null) {
			out.set(item.changeId, {
				code: "policy-signoff",
				message:
					"the candidate touches a root .cue file without a sign-off of this head",
			});
			continue;
		}
		if (
			item.policyDigest === undefined ||
			item.policyDigest !== signoff.policyDigest
		) {
			out.set(item.changeId, {
				code: "config-plan-changed",
				message: `the candidate's root .cue digest is ${
					item.policyDigest === undefined
						? "unknown"
						: item.policyDigest ?? "none"
				}, but the sign-off approved ${
					signoff.policyDigest ?? "none"
				} (another config change landed in between)`,
			});
		}
	}
	return out;
};
