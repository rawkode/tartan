// Forge events identity appends (WP2): `principal.created`
// on the forge stream, inside the caller's transaction, through WP6's
// `ForgeEventsInternal.appendSync`. Every envelope belongs to a node, so a
// principal created without one (JIT provisioning) has an audit row only.

import { type ActorKind, eventIdemKey } from "@tartan/contract";
import type { IdentityContext } from "./context.ts";

export const appendPrincipalCreated = (
	c: IdentityContext,
	e: {
		readonly principal: string;
		readonly kind: "user" | "agent";
		readonly handle: string;
		readonly node: string;
		/** Who created it (the inviter, the agent's owner); the principal itself by default. */
		readonly actor?: { readonly kind: ActorKind; readonly id: string };
	},
): void => {
	c.modules.events.appendSync({
		type: "principal.created",
		actor: e.actor ?? { kind: e.kind, id: e.principal },
		node: e.node,
		data: { principalId: e.principal, kind: e.kind, handle: e.handle },
		idemKey: eventIdemKey("identity", e.principal, "principal.created"),
	});
};
