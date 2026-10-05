// K16: lane operations are owner-bound. A pure
// decision over the lane row, the acting
// principal and its current role on the repo; every lane-mutating method of
// the `core` facade calls it inside its own transaction, and
// `authorizeLaneOp` returns it read-only. `KERNEL_LANE_ACTOR` bypasses the
// actor rules, never the state rules (those are `laneStateIssue`).

import {
	type LaneOp,
	type LaneState,
	ROLE,
	SYS_KERNEL,
} from "@tartan/contract";
import type { LaneOpActor, LaneRow } from "@tartan/contract/kernel.ts";
import { delegatesOf, isActive } from "./rows.ts";

export type K16Input = {
	readonly actor: LaneOpActor;
	readonly op: LaneOp;
	/** The lane operated on; null for `open` and `adopt`. */
	readonly lane: LaneRow | null;
	/** The actor's current effective role on the repo (0 when unknown). */
	readonly role: number;
	/** `open`/`adopt`: the requested owner. */
	readonly owner?: string;
	/** `adopt`: the most recent gateway pusher of the branch, from the push log. */
	readonly lastPusher?: string | null;
	/** `restack`: the lane to restack onto. */
	readonly onto?: LaneRow | null;
};

export type K16Decision =
	| { readonly ok: true }
	| { readonly ok: false; readonly code: string };

export const isKernelActor = (actor: LaneOpActor): boolean =>
	actor.kind === "system" && actor.id === SYS_KERNEL;

/** The actor is the lane's owner (or acts for the user who owns it). */
const isOwner = (lane: LaneRow, actor: LaneOpActor): boolean =>
	lane.owner_principal === actor.id ||
	(actor.onBehalfOf !== undefined && lane.owner_principal === actor.onBehalfOf);

const isOwnerOrDelegate = (lane: LaneRow, actor: LaneOpActor): boolean =>
	isOwner(lane, actor) || delegatesOf(lane).includes(actor.id);

const deny = (code: string): K16Decision => ({ ok: false, code });
const allow: K16Decision = { ok: true };

/** The actor rules of K16 (who may do `op`). */
export const decideLaneOp = (input: K16Input): K16Decision => {
	const { actor, op, lane, role } = input;
	if (isKernelActor(actor)) return allow;
	const background = actor.kind === "ext";
	switch (op) {
		case "open": {
			if (background) return deny("background-open");
			if (actor.kind === "system") return deny("not-kernel");
			const owner = input.owner;
			return owner === actor.id ||
					(actor.onBehalfOf !== undefined && owner === actor.onBehalfOf)
				? allow
				: deny("owner-not-actor");
		}
		case "adopt": {
			if (actor.kind !== "user") return deny("adopt-user-only");
			const owner = input.owner;
			if (owner !== actor.id && owner !== actor.onBehalfOf) {
				return deny("owner-not-actor");
			}
			return input.lastPusher === actor.id || role >= ROLE.maintainer
				? allow
				: deny("not-last-pusher");
		}
		case "close": {
			if (lane === null) return deny("no-lane");
			if (background) return deny("background");
			return isOwnerOrDelegate(lane, actor) || role >= ROLE.maintainer
				? allow
				: deny("not-owner-or-delegate");
		}
		case "sync": {
			if (lane === null) return deny("no-lane");
			if (background) return deny("background");
			return isOwnerOrDelegate(lane, actor)
				? allow
				: deny("not-owner-or-delegate");
		}
		case "restack":
		case "delegate": {
			if (lane === null) return deny("no-lane");
			if (background) return deny("background");
			return isOwner(lane, actor) ? allow : deny("not-owner");
		}
		case "archive": {
			if (lane === null) return deny("no-lane");
			if (background) return deny("background");
			return isOwner(lane, actor) || role >= ROLE.maintainer
				? allow
				: deny("not-owner");
		}
		case "purge": {
			if (lane === null) return deny("no-lane");
			if (background) return deny("background");
			return role >= ROLE.owner ? allow : deny("owner-role");
		}
	}
};

/** Lane states each operation accepts (the state rules, which nobody bypasses). */
const ALLOWED_STATES: Readonly<
	Record<Exclude<LaneOp, "open" | "adopt">, readonly LaneState[]>
> = {
	close: ["opening", "open", "submitted", "lost", "landed"],
	sync: ["open", "submitted", "lost"],
	restack: ["open", "submitted", "lost"],
	delegate: ["opening", "open", "submitted", "landing", "lost"],
	archive: ["open", "submitted", "lost", "closed"],
	purge: ["closed", "archived"],
};

/**
 * Why `op` cannot run on `lane` in its current state, or null. A `landing`
 * lane is frozen (no sync, restack, close or archive), a quarantined lane
 * cannot be archived (K2).
 */
export const laneStateIssue = (
	op: Exclude<LaneOp, "open" | "adopt">,
	lane: LaneRow,
	onto?: LaneRow | null,
): string | null => {
	if (lane.state === "landing" && op !== "delegate") return "lane-landing";
	if (!ALLOWED_STATES[op].includes(lane.state)) return `lane-${lane.state}`;
	if (op === "archive" && lane.quarantined === 1) return "lane-quarantined";
	if (op === "restack") {
		if (onto === undefined || onto === null) return "onto-unknown";
		if (onto.id === lane.id) return "onto-self";
		if (!isActive(onto)) return "onto-inactive";
	}
	return null;
};
