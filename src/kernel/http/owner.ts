// The forge-wide Owner credential.

import { ROLE } from "@tartan/contract";
import type { AuthContext } from "@tartan/contract/kernel.ts";

/**
 * True for a credential that carries the forge Owner's whole authority: a
 * user acting as an admin (a session, or a token with the `admin` scope),
 * bound to no node or lane and capped at no less than Owner. Forge-wide admin
 * actions (the global log, the lane self-test) require it together with
 * `isOwner`, so a bounded token of the Owner (a CI PAT on one subtree at
 * Reporter) never reaches them.
 */
export const isForgeWide = (auth: AuthContext): boolean =>
	auth.kind === "user" && auth.isAdmin && auth.nodeId === null &&
	auth.laneId === null && auth.maxRole >= ROLE.owner;

/** Why a credential is refused a forge-wide action (for the 403 text). */
export const FORGE_WIDE_HINT =
	"sign in as the forge Owner, or use an Owner token with the admin scope, no node and the Owner role";
