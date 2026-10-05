// The current role of a principal on this repo (K16 Maintainer+/Owner
// checks, the gateway's write credential): RepoDO asks ForgeDO's tree (WP3)
// and caches the answer briefly. A failure counts as no role, so only the
// owner-based K16 paths stay open while ForgeDO is unavailable.
//
// The granted role is then bounded by the caller's credential when the actor
// carries `bounds`: the token's role ceiling, its node
// subtree (outside it: no role) and its lane pin (Reporter at most on any
// other lane), exactly as `boundRole` applies them at the HTTP and caps
// boundaries, so a narrow token never reaches K16's Maintainer+/Owner
// alternatives through RepoDO.

import {
	type ActorBounds,
	boundRole,
	type EffectiveRole,
	isWithinPath,
	ROLE,
	SYS_KERNEL,
} from "@tartan/contract";
import type { LaneOpActor } from "@tartan/contract/kernel.ts";
import { type Core, errorText, getMeta } from "./core.ts";

export const ROLE_CACHE_MS = 10_000;

export type Roles = {
	/**
	 * The effective role of `actor` (and the user it acts for) on this repo,
	 * bounded by `actor.bounds` when present; `at.laneId` is the lane the
	 * operation targets (a lane pin applies to every other lane).
	 */
	of(
		actor: Pick<LaneOpActor, "id" | "onBehalfOf" | "bounds">,
		at?: { readonly laneId?: string | null },
	): Promise<EffectiveRole>;
};

export const createRoles = (core: Core): Roles => {
	const cache = new Map<string, { role: EffectiveRole; at: number }>();
	const paths = new Map<string, { path: string | null; at: number }>();

	const granted = async (
		nodeId: string,
		principals: string[],
	): Promise<EffectiveRole> => {
		const key = `${nodeId}|${principals.join(",")}`;
		const now = core.clock.now();
		const hit = cache.get(key);
		if (hit !== undefined && now - hit.at < ROLE_CACHE_MS) return hit.role;
		try {
			const role = await core.ports.forgeTree().effectiveRole(
				principals,
				nodeId,
			);
			cache.set(key, { role, at: now });
			return role;
		} catch (error) {
			core.ports.log("role lookup failed", { error: errorText(error) });
			return ROLE.none;
		}
	};

	/** A node's current path (it can move), cached like roles; null when unknown. */
	const pathOf = async (nodeId: string): Promise<string | null> => {
		const now = core.clock.now();
		const hit = paths.get(nodeId);
		if (hit !== undefined && now - hit.at < ROLE_CACHE_MS) return hit.path;
		try {
			const node = await core.ports.forgeTree().node(nodeId);
			const path = node?.path ?? null;
			paths.set(nodeId, { path, at: now });
			return path;
		} catch (error) {
			core.ports.log("node lookup failed", { error: errorText(error) });
			return null;
		}
	};

	/** The repo lies in the token's node subtree (fails closed). */
	const withinTokenNode = async (
		bounds: ActorBounds,
		repoNodeId: string,
	): Promise<boolean> => {
		if (bounds.nodeId === null || bounds.nodeId === repoNodeId) return true;
		const [root, repo] = await Promise.all([
			pathOf(bounds.nodeId),
			pathOf(repoNodeId),
		]);
		return root !== null && repo !== null && isWithinPath(root, repo);
	};

	return {
		of: async (actor, at = {}) => {
			if (actor.id === SYS_KERNEL) return ROLE.owner;
			const nodeId = getMeta(core.sql, "node_id");
			if (nodeId === null) return ROLE.none;
			const role = await granted(
				nodeId,
				actor.onBehalfOf ? [actor.id, actor.onBehalfOf] : [actor.id],
			);
			const bounds = actor.bounds;
			if (bounds === undefined) return role;
			return boundRole(role, bounds, {
				withinTokenNode: await withinTokenNode(bounds, nodeId),
				laneId: at.laneId ?? null,
			});
		},
	};
};
