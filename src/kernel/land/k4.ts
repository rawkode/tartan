// K4: an advance requires a reason chain.
// Pure: the land module reads the envelopes and hands
// them in.
//
// For every change of the batch the chain must contain
// - that change's `changes.submitted` (same change id and lane), and
// - an approval bound to the head being landed:
//   - a non-shadow `review.decided{decision: "approve"}` emitted by an
//     installation, whose `head` equals the batch entry's `head` (and, when
//     the registry names the `review@1` provider in force at the repo, by
//     that installation), or
//   - a passing kernel `gate.decided` of the `ref.advance` point for that
//     change (`mode: "enforce"`, `decision: "allow"`, `basis: "answer"`)
//     recorded by an earlier batch that carried the same head.
// Every id must exist in this repo's log; ids are de-duplicated. A
// provider's own `queue.*` events never count, so a chain made only of them
// is refused.

import type { Envelope, LandChange } from "@tartan/contract";

export type K4Issue = {
	readonly changeId?: string;
	readonly code:
		| "unknown-event"
		| "no-submitted"
		| "no-approval"
		| "approval-head";
	readonly message: string;
};

export type K4Input = {
	readonly changes: readonly Pick<LandChange, "changeId" | "laneId" | "head">[];
	/** The ids the request named. */
	readonly ids: readonly string[];
	/** The envelopes of those ids found in this repo's log. */
	readonly found: readonly Envelope[];
	/**
	 * The installation id of the `review@1` provider in force at the repo,
	 * `null` when none is in force, or `undefined` when the registry could
	 * not be asked (then only K10's `provides` rule stands behind the event).
	 */
	readonly reviewProvider?: string | null;
	/** Whether an earlier batch carried `changeId` at `head` (gate approvals). */
	readonly gateBatchHad: (
		batchId: string,
		changeId: string,
		head: string,
	) => boolean;
};

type Data = Record<string, unknown>;
const dataOf = (e: Envelope): Data =>
	(typeof e.data === "object" && e.data !== null ? e.data : {}) as Data;

const isSubmitted = (
	e: Envelope,
	change: K4Input["changes"][number],
): boolean => {
	if (e.type !== "changes.submitted" || e.shadow) return false;
	const d = dataOf(e);
	return d.changeId === change.changeId && d.laneId === change.laneId;
};

const reviewApproves = (
	e: Envelope,
	change: K4Input["changes"][number],
	provider: string | null | undefined,
): "ok" | "head" | "no" => {
	if (e.type !== "review.decided" || e.shadow) return "no";
	if (e.source.kind !== "installation") return "no";
	if (typeof provider === "string" && e.source.id !== provider) return "no";
	if (provider === null) return "no";
	const d = dataOf(e);
	if (d.changeId !== change.changeId || d.decision !== "approve") return "no";
	return d.head === change.head ? "ok" : "head";
};

const gateApproves = (
	e: Envelope,
	change: K4Input["changes"][number],
	had: K4Input["gateBatchHad"],
): boolean => {
	if (e.type !== "gate.decided" || e.shadow) return false;
	if (e.source.kind !== "kernel") return false;
	const d = dataOf(e);
	if (
		d.point !== "ref.advance" || d.changeId !== change.changeId ||
		d.decision !== "allow" || d.mode !== "enforce" || d.basis !== "answer"
	) {
		return false;
	}
	return typeof d.batchId === "string" &&
		had(d.batchId, change.changeId, change.head);
};

/** Every K4 issue of the request (empty: the chain satisfies K4). */
export const reasonChainIssues = (input: K4Input): K4Issue[] => {
	const issues: K4Issue[] = [];
	const wanted = [...new Set(input.ids)];
	const byId = new Map(input.found.map((e) => [e.id, e]));
	const missing = wanted.filter((id) => !byId.has(id));
	if (missing.length > 0) {
		issues.push({
			code: "unknown-event",
			message: `reason events not in this repo's log: ${
				missing.slice(0, 5).join(", ")
			}${missing.length > 5 ? ", …" : ""}`,
		});
	}
	const events = wanted.map((id) => byId.get(id)).filter((e) =>
		e !== undefined
	);
	for (const change of input.changes) {
		if (!events.some((e) => isSubmitted(e, change))) {
			issues.push({
				changeId: change.changeId,
				code: "no-submitted",
				message:
					`${change.changeId}: the chain has no changes.submitted for this change and lane`,
			});
		}
		const reviews = events.map((e) =>
			reviewApproves(e, change, input.reviewProvider)
		);
		const approved = reviews.includes("ok") ||
			events.some((e) => gateApproves(e, change, input.gateBatchHad));
		if (!approved) {
			issues.push({
				changeId: change.changeId,
				code: reviews.includes("head") ? "approval-head" : "no-approval",
				message: reviews.includes("head")
					? `${change.changeId}: the approval names another head than ${change.head}`
					: `${change.changeId}: the chain has no approval for head ${change.head}`,
			});
		}
	}
	return issues;
};
