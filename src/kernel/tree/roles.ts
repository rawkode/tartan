// Effective roles from grants (WP3): the
// maximum over the node and its ancestors (raise-only downward), with the
// forge Owner (`meta.owner_principal`) synthesized at Owner on every root and
// the kernel (`sys_kernel`) likewise. An agent counts its own grants and its
// owner user's (`min(agent grants ∪ owner user's role, token.max_role)`: the
// token bounds are applied later, by `authorize`). Disabled principals bring
// no role. Credential bounds (token ceiling, node subtree, lane pin, scopes)
// are never applied here: this is the grants view every module reads.

import {
	type EffectiveRole,
	isWithinPath,
	ROLE,
	SYS_KERNEL,
} from "@tartan/contract";
import type { IdentityInternal, NodeRow } from "@tartan/contract/kernel.ts";
import { ancestorPaths } from "./paths.ts";
import { count, first, jsonList, nodeById } from "./store.ts";

export type RolesDeps = {
	readonly sql: SqlStorage;
	/** WP2's identity internals (principal rows, the forge Owner). */
	identity(): IdentityInternal;
};

/** Every principal of the forge holds a role here (the Owner, the kernel). */
export const ALL = "all" as const;

export type Roles = {
	/**
	 * The principals whose grants count for `principals` (agents add their
	 * owner user), or `"all"` for the forge Owner and the kernel.
	 */
	expand(principals: readonly string[]): readonly string[] | typeof ALL;
	/** The grants role at a node path (0 for an unknown path). */
	atPath(
		principals: readonly string[],
		path: string,
		now: number,
	): EffectiveRole;
	at(principals: readonly string[], nodeId: string, now: number): EffectiveRole;
	/** A grant at `node` or anywhere strictly below it. */
	holdsBelow(
		principals: readonly string[],
		node: NodeRow,
		now: number,
	): boolean;
	/** A role at `rootNodeId` (inherited) or anywhere inside its subtree. */
	holdsWithin(principal: string, rootNodeId: string, now: number): boolean;
	/** True when `nodeId` is `rootNodeId` or lies below it. */
	isWithin(rootNodeId: string, nodeId: string): boolean;
};

export const createRoles = (deps: RolesDeps): Roles => {
	const { sql } = deps;

	const principalRow = (id: string) => {
		try {
			return deps.identity().principalSync(id);
		} catch {
			return null;
		}
	};
	const isOwner = (id: string): boolean => {
		try {
			return deps.identity().isOwner(id);
		} catch {
			return false;
		}
	};

	const expand = (
		principals: readonly string[],
	): readonly string[] | typeof ALL => {
		const out = new Set<string>();
		for (const id of principals) {
			if (id === SYS_KERNEL) return ALL;
			const row = principalRow(id);
			if (row !== null && row.disabled_at !== null) continue;
			if (isOwner(id)) return ALL;
			out.add(id);
			if (row?.kind === "agent" && row.owner_user_id !== null) {
				const owner = principalRow(row.owner_user_id);
				if (owner === null || owner.disabled_at !== null) continue;
				if (isOwner(owner.id)) return ALL;
				out.add(owner.id);
			}
		}
		return [...out];
	};

	const grantedAtPaths = (
		ids: readonly string[],
		paths: readonly string[],
		now: number,
	): EffectiveRole => {
		if (ids.length === 0 || paths.length === 0) return ROLE.none;
		const row = first<{ role: number | null }>(
			sql,
			`SELECT MAX(g.role) AS role FROM grants g JOIN nodes n ON n.id = g.node_id
			 WHERE n.path IN (SELECT value FROM json_each(?))
			   AND g.principal_id IN (SELECT value FROM json_each(?))
			   AND (g.expires_at IS NULL OR g.expires_at > ?)`,
			jsonList(paths),
			jsonList(ids),
			now,
		);
		return (row?.role ?? 0) as EffectiveRole;
	};

	const atPath = (
		principals: readonly string[],
		path: string,
		now: number,
	): EffectiveRole => {
		const ids = expand(principals);
		if (ids === ALL) return ROLE.owner;
		return grantedAtPaths(ids, ancestorPaths(path), now);
	};

	const at = (
		principals: readonly string[],
		nodeId: string,
		now: number,
	): EffectiveRole => {
		const node = nodeById(sql, nodeId);
		return node === null ? ROLE.none : atPath(principals, node.path, now);
	};

	const holdsBelow = (
		principals: readonly string[],
		node: NodeRow,
		now: number,
	): boolean => {
		const ids = expand(principals);
		if (ids === ALL) return true;
		if (ids.length === 0) return false;
		return count(
			sql,
			`SELECT COUNT(*) AS n FROM grants g JOIN nodes n ON n.id = g.node_id
			 WHERE n.path > ?1 || '/' AND n.path < ?1 || '0'
			   AND g.principal_id IN (SELECT value FROM json_each(?2))
			   AND (g.expires_at IS NULL OR g.expires_at > ?3)`,
			node.path,
			jsonList(ids),
			now,
		) > 0;
	};

	const holdsWithin = (
		principal: string,
		rootNodeId: string,
		now: number,
	): boolean => {
		const root = nodeById(sql, rootNodeId);
		if (root === null) return false;
		return atPath([principal], root.path, now) > ROLE.none ||
			holdsBelow([principal], root, now);
	};

	const isWithin = (rootNodeId: string, nodeId: string): boolean => {
		const root = nodeById(sql, rootNodeId);
		const node = rootNodeId === nodeId ? root : nodeById(sql, nodeId);
		return root !== null && node !== null && isWithinPath(root.path, node.path);
	};

	return { expand, atPath, at, holdsBelow, holdsWithin, isWithin };
};
