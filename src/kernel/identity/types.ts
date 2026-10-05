// Types of the identity module beyond the contract (WP2).
//
// `IdentityKernelFacade` is the contract's `IdentityFacade` plus the
// methods WP2's own Worker-side code needs from ForgeDO and the contract does
// not have yet: reading the IdP for the relying party, checking a setup
// session, the forge name and origin step, the first-boot root key for the
// isolate keyring, the IdP metadata refresh, and the list/revoke calls of the
// token, agent and invite APIs. Only WP2 calls them (routes, middleware,
// cron); they are requested as an additive contract change.
// `ForgeDO.identity()` returns this type, because the
// thin class derives it from the module.

import type {
	AgentDto,
	InviteCreateRequest,
	Role,
	SetupStateDto,
	TokenScope,
} from "@tartan/contract";
import type { IdentityFacade, IdpRow } from "@tartan/contract/kernel.ts";

/** A setup session's purpose follows the setup state: `recover` once the forge is claimed. */
export type SetupSessionInfo = {
	readonly purpose: "bootstrap" | "recover";
	readonly expiresAt: number;
};

/** What the relying party needs: the IdP row and, for `private_key_jwt`, the active client-auth key. */
export type IdpLoginConfig = IdpRow & {
	readonly client_key: {
		readonly kid: string;
		readonly alg: "ES256" | "EdDSA";
		readonly private_jwk_sealed: string;
	} | null;
};

/** One PAT or agent token, never with its secret (`GET /-/api/tokens`). */
export type TokenDto = {
	readonly id: string;
	readonly kind: "pat" | "agent";
	readonly principal: string;
	readonly name: string;
	readonly scopes: readonly TokenScope[];
	readonly nodeId: string | null;
	readonly laneId: string | null;
	readonly maxRole: Role;
	readonly expiresAt: number;
	readonly lastUsedAt: number | null;
	readonly revokedAt: number | null;
	readonly createdAt: number;
};

/** One invite, never with its code (`GET /-/api/invites`). */
export type InviteDto = {
	readonly id: string;
	readonly nodeId: string;
	readonly role: InviteCreateRequest["role"];
	readonly note: string | null;
	readonly relinkPrincipal: string | null;
	readonly createdBy: string;
	readonly createdAt: number;
	readonly expiresAt: number;
	readonly usedAt: number | null;
};

export type SetNameInput = {
	readonly forgeName: string;
	readonly canonicalOrigin: string;
};

/** WP2-internal additions to the identity facade. */
export interface IdentityExtras {
	/** The setup session behind a `__Host-tartan-setup` cookie value, or null. */
	setupSession(cookie: string): Promise<SetupSessionInfo | null>;
	/** Setup: forge name and canonical origin (needs a setup session). */
	setName(input: SetNameInput, setupSession: string): Promise<SetupStateDto>;
	/** The configured IdP for the relying party, or null before step 6. */
	idp(): Promise<IdpLoginConfig | null>;
	/**
	 * The first-boot root key when `TARTAN_SECRET` is absent (button path), so an
	 * isolate can build its keyring once; null when the secret is set.
	 */
	rootKey(): Promise<string | null>;
	/** Re-discovers the IdP when its metadata is older than a day (cron). */
	refreshIdp(): Promise<{ refreshed: boolean }>;
	listTokens(principal: string): Promise<TokenDto[]>;
	listAgents(owner: string): Promise<AgentDto[]>;
	/** Disables an agent principal and revokes its tokens (its owner, or an admin acting `asAdmin`). */
	disableAgent(agentId: string, by: string, asAdmin?: boolean): Promise<void>;
	/** The caller's invites; every invite for an admin acting `asAdmin`. */
	listInvites(by: string, asAdmin?: boolean): Promise<InviteDto[]>;
	/** Withdraws an unused invite (its creator, or an admin acting `asAdmin`). */
	revokeInvite(
		inviteId: string,
		by: string,
		asAdmin?: boolean,
	): Promise<void>;
}

export type IdentityKernelFacade = IdentityFacade & IdentityExtras;
