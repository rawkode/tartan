// SPA-side response shapes that `@tartan/contract/api.ts` does not define
// (yet). Each wraps contract DTOs for a route no handler serves yet; they
// are requested so the contract can adopt them.
// Every DTO the contract already has (`MeResponse`, `SetupStatusResponse`,
// `InstallationsResponse`, …) is imported from it, never redefined here.

import type {
	IdpClientAuth,
	LaneSelfTestResult,
} from "@tartan/contract/api.ts";
import type { PushLimits } from "@tartan/contract/git.ts";
import type { LaneMode } from "@tartan/contract/lanes.ts";

/** `GET /-/api/admin/selftest/lanes` (WP5b): the last stored result, if any. */
export type LaneSelfTestStatus = {
	readonly last: LaneSelfTestResult | null;
};

/**
 * `GET /-/api/settings` (WP2/WP0): forge settings shown read-only in
 * Settings. Every field already exists server-side (`meta`, `idp`, `PushLimits`,
 * `LANE_MODE`, `MAX_LANE_REPOS_FORGE`); only the DTO and route are missing.
 */
export type ForgeSettingsDto = {
	readonly forgeName: string;
	readonly canonicalOrigin: string | null;
	readonly idp: {
		readonly issuer: string;
		readonly clientId: string;
		readonly clientAuth: IdpClientAuth;
		/** True when `OIDC_ISSUER`/`OIDC_CLIENT_ID` vars lock the IdP (GitOps). */
		readonly lockedByVars: boolean;
	} | null;
	readonly pushLimits: PushLimits;
	readonly laneMode: LaneMode;
	readonly maxLaneReposForge: number;
	readonly retainedLaneRepos: number;
	readonly rootKeyFallback: boolean;
};

/**
 * `POST /-/api/admin/root-key/export` (WP2, Owner, once): the root key ForgeDO
 * generated on the button path, so the owner can `wrangler secret put
 * TARTAN_SECRET`. The kernel decides whether it may be shown again.
 */
export type RootKeyExport = { readonly value: string };
