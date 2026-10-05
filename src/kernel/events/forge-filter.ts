// K12 confinement of the forge stream (WP6): a reader confined to a subtree
// sees node events only for nodes inside it, `principal.*` only for principals
// holding a role inside it, extension events only for installations inside it,
// and `repo.*` only for repos inside it. Payloads never carry an email address
// (the kernel event schemas have none).

import type { Envelope } from "@tartan/contract";

export type SubtreeCheck = {
	/** True when `nodeId` is the subtree root or below it. */
	readonly within: (nodeId: string) => boolean;
	/** True when `principalId` holds a role inside the subtree. */
	readonly principalWithin: (principalId: string) => boolean;
};

const field = (data: unknown, key: string): string | null => {
	if (data === null || typeof data !== "object") return null;
	const value = (data as Record<string, unknown>)[key];
	return typeof value === "string" ? value : null;
};

/** The node a forge event is about, for K12 (null = principal events). */
export const forgeEventNode = (event: Envelope): string | null => {
	const ns = event.type.split(".")[0];
	switch (ns) {
		case "node":
			return field(event.data, "nodeId") ?? event.node;
		case "repo":
			return field(event.data, "repoId") ?? event.node;
		case "extension":
			return event.type === "extension.error"
				? event.node
				: field(event.data, "node") ?? event.node;
		case "principal":
			return null;
		default:
			return event.node;
	}
};

export const visibleInSubtree = (
	event: Envelope,
	check: SubtreeCheck,
): boolean => {
	if (event.type.startsWith("principal.")) {
		const principal = field(event.data, "principalId");
		return principal !== null && check.principalWithin(principal);
	}
	const node = forgeEventNode(event);
	return node !== null && check.within(node);
};
