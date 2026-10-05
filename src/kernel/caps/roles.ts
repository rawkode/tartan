// The acting principal's role at a node, shared by `createKernelCaps` and the
// extension host's tool-role check:
//
// - a user or agent: its grants at the node (the agent's owner user folded in
//   by the tree), bounded by its credential (`boundRole`: token ceiling, node
//   subtree, lane pin);
// - the installation's own principal (`x_<inst>`, background): its
//   `background_role`;
// - another installation acting through `interfaces.call`: the role its
//   caller carried in `bounds` (its background role, confined to its
//   subtree), never more;
// - the kernel: Owner.

import {
	type Actor,
	type ActorBounds,
	boundRole,
	type EffectiveRole,
	isWithinPath,
	type NodeRef,
} from "@tartan/contract";
import type { KernelPorts, PortNode } from "./ports.ts";

export type ActorRoles = {
	roleAt(node: PortNode, laneId?: string): Promise<EffectiveRole>;
};

export const createActorRoles = (
	ports: Pick<KernelPorts, "effectiveRole">,
	resolve: (ref: NodeRef) => Promise<PortNode | null>,
	who: {
		/** The calling installation's own principal (`x_<inst>`). */
		readonly self: string;
		readonly backgroundRole: EffectiveRole;
		readonly actor: Actor;
		readonly bounds: ActorBounds | null;
	},
): ActorRoles => {
	const cache = new Map<string, Promise<EffectiveRole>>();

	const withinBounds = async (
		bounds: ActorBounds,
		node: PortNode,
	): Promise<boolean> => {
		if (bounds.nodeId === null) return true;
		const root = await resolve({ id: bounds.nodeId });
		return root !== null && isWithinPath(root.path, node.path);
	};

	const compute = async (
		node: PortNode,
		laneId?: string,
	): Promise<EffectiveRole> => {
		const { actor, bounds } = who;
		if (actor.kind === "system") return 50;
		const granted: EffectiveRole = actor.kind === "ext"
			? actor.id === who.self ? who.backgroundRole : (bounds?.maxRole ?? 0)
			: await ports.effectiveRole(
				actor.onBehalfOf ? [actor.id, actor.onBehalfOf] : [actor.id],
				node.id,
			);
		if (bounds === null) return granted;
		return boundRole(granted, bounds, {
			withinTokenNode: await withinBounds(bounds, node),
			laneId: laneId ?? null,
		});
	};

	return {
		roleAt: (node, laneId) => {
			const key = `${node.id}:${laneId ?? ""}`;
			let found = cache.get(key);
			if (found === undefined) {
				found = compute(node, laneId);
				cache.set(key, found);
			}
			return found;
		},
	};
};
