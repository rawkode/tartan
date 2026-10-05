// HTTP security, authorization and git-policy seams. Kernel-only.
//
// Who implements what:
// - WP0 `src/router.ts`: every route carries a `RoutePolicy`; `createRouter`
//   runs every request (routes, 404/405 and the SPA fall-through) through
//   WP2's security middleware, which puts `auth` on the RouteContext.
// - WP2 `src/kernel/http/middleware.ts` (`withSecurity`): setup gating,
//   canonical host, authentication per policy, CSRF and security headers.
//   `src/kernel/http/auth.ts`: `createAuthenticate`, `requireSameOrigin`.
// - WP3 `src/kernel/tree/authz.ts`: `createAuthorize`, which every route
//   owner calls before touching a node.
// - WP4 `src/kernel/gateway/policy.ts`: the pure push policies
//   (`CanonicalPushPolicy`, `LaneRepoPushPolicy`), the canonical write
//   precheck and `PublicView`, over RepoDO's `pushContext`/`readContext`.
// - WP2 `src/kernel/http/capmac.ts`: `createCapMac`, the capability URL MAC
//   that WP4's route verifies and WP5b's seeder signs.

import type { NodeDto } from "./api.ts";
import type {
	ActorBounds,
	EffectiveRole,
	Permission,
	TokenScope,
} from "./common.ts";
import type { CapFields } from "./ids.ts";
import type { AuthContext } from "./do/forge.ts";
import type { PushCommand, PushContext } from "./do/repo.ts";

/**
 * Credentials `authenticate` may accept on a route:
 * - `none`: never authenticated (`auth` is null);
 * - `cookie`: the session cookie only (browser pages, `/-/live`);
 * - `token`: `Authorization` only (Bearer, or a Basic password for git);
 *   cookies are ignored. Git, MCP;
 * - `any`: `Authorization` when present (cookies are then never read), else
 *   the session cookie. The API.
 * Tokens are never accepted from query strings or cookies.
 */
export const ROUTE_AUTH = ["none", "cookie", "token", "any"] as const;
export type RouteAuth = typeof ROUTE_AUTH[number];

export type RoutePolicy = {
	readonly auth: RouteAuth;
	/**
	 * Unauthenticated requests reach the handler (public reads, login, git's
	 * own 401-first). False: the middleware answers 401 itself.
	 */
	readonly anonymous: boolean;
	/**
	 * Same-origin required for unsafe methods and WebSocket upgrades
	 * that are not bearer-authenticated: `Sec-Fetch-Site: same-origin`, or an
	 * exact canonical `Origin` when that header is absent; JSON endpoints also
	 * need `Content-Type: application/json`.
	 */
	readonly csrf: boolean;
	/**
	 * Served while `setup_state ≠ done`. Otherwise HTML
	 * navigations get 302 `/-/setup` and everything else 503
	 * `setup_required`.
	 */
	readonly setupExempt: boolean;
	/**
	 * A non-canonical host: `redirect` = 308 to the canonical
	 * origin (not while setup is incomplete for `setupExempt` routes),
	 * `forbid` = 403 `denied("host")` (git, MCP), `any` = served anywhere
	 * (health, polled on workers.dev before the custom domain answers).
	 */
	readonly host: "redirect" | "forbid" | "any";
	/** Channel scope a token request needs here (`mcp`, `api`); sessions need none. */
	readonly tokenScope?: TokenScope;
};

export type AuthenticateOptions = {
	readonly allowCookie: boolean;
	readonly allowToken: boolean;
};

/**
 * WP2. Resolves the request's credential: `Authorization: Bearer tpat_|tagt_`
 * (or an OAuth access token, M2), a Basic password for git, else the session
 * cookie when allowed. Never reads cookies when `Authorization` is present.
 * Returns null when there is no credential; throws `unauthenticated` for an
 * invalid, expired or revoked one. Token lookups are cached ≤ 60 s per
 * isolate.
 */
export type Authenticate = (
	req: Request,
	options: AuthenticateOptions,
) => Promise<AuthContext | null>;
export type CreateAuthenticate<Env> = (env: Env) => Authenticate;

/** WP2. Throws `denied("csrf")` unless the request is same-origin. */
export type RequireSameOrigin = (req: Request, canonicalOrigin: string) => void;

export type AuthorizeTarget = {
	readonly node: NodeDto;
	/** The lane an operation targets (push to a lane, lane tools): lane pins apply. */
	readonly laneId?: string;
};

/**
 * WP3. The caller's effective role at `target.node`:
 * max over the node and its ancestors (owner synthesized at roots), public
 * and internal visibility for anonymous and signed-in readers, then the
 * credential bounds (`boundRole`: token ceiling, node subtree, lane pin;
 * delegation folded in by WP2) and `scopesAllow`. Returns the bounded role
 * when it reaches `PERMISSION_MIN_ROLE[perm]`; otherwise throws
 * `unauthenticated` (anonymous), `denied("scopes")` or `denied("role")`
 * (a target outside the token's node is `denied("scope")`).
 */
export type Authorize = (
	auth: AuthContext | null,
	target: AuthorizeTarget,
	perm: Permission,
) => Promise<EffectiveRole>;
export type CreateAuthorize<Env> = (env: Env) => Authorize;

/** The credential bounds of an authenticated caller: sessions are unrestricted. */
export const actorBoundsOf = (auth: AuthContext): ActorBounds => ({
	maxRole: auth.via === "session" ? 50 : auth.maxRole,
	scopes: auth.via === "session" ? null : auth.scopes,
	nodeId: auth.via === "session" ? null : auth.nodeId,
	laneId: auth.via === "session" ? null : auth.laneId,
	...(auth.delegationId ? { delegationId: auth.delegationId } : {}),
});

// ---------------------------------------------------------------------------
// Git policy
// ---------------------------------------------------------------------------

/**
 * The one definition of the public view: true when the caller may
 * read a public repo but not as a member, i.e. anonymous, roleless or Guest,
 * or a token whose node subtree or scopes do not cover the repo. `role` is the
 * credential-bounded role (0 when the token does not cover the repo). Lane
 * remotes have no public view.
 */
export type PublicView = (
	auth: AuthContext | null,
	repo: { readonly node: NodeDto; readonly role: EffectiveRole },
) => boolean;

/** `ng` reasons of the receive-pack policies. */
export const REF_POLICY_REASONS = [
	"invalid-ref",
	"reserved-parent",
	"case-collision",
	"repo-importing",
	"woven-by-tartan",
	"kernel-only",
	"not-your-lane",
	"lane-closed",
	"lane-owned",
	"lane-landing",
	"lane-opening",
	"lane-main-only",
	"stale-old",
	"no-write-credential",
	"agents-lanes-only",
	"tags-maintainer",
	"unsupported-ref",
	"push-too-large",
	"object-too-large",
	"use-lanes-close",
	// Whole-section protocol violations of a receive-pack command section
	// (push-cert, shallow, delimiters, bad lengths, disallowed capabilities)
	// and the per-push command cap (`@tartan/gitproto`, WP22).
	"malformed-push",
	"too-many-commands",
] as const;
export type RefPolicyReason = typeof REF_POLICY_REASONS[number];

/** `ERR` reasons of the fail-closed upload-pack request parsers. */
export const UPLOAD_REASONS = [
	"want-not-advertised",
	"unsupported-command",
	"unsupported-argument",
	"upload-encoding",
] as const;
export type UploadReason = typeof UPLOAD_REASONS[number];

/** Lane reason codes of notices, refusals and rejections (K16). */
export const LANE_REASONS = [
	"lane-cap",
	"lane-op",
	"lane-seed-failed",
	"lane-too-large",
	"lane-repo-ceiling",
	"empty-lane",
	"head-moved",
] as const;
export type LaneReason = typeof LANE_REASONS[number];

/** The caller facts the push policies take besides RepoDO's `PushContext`. */
export type PushCaller = {
	readonly principal: string;
	readonly kind: "user" | "agent";
	/** The CURRENT effective role on the repo, credential-bounded (`Authorize`). */
	readonly role: EffectiveRole;
	/** The token's lane pin: such a token writes only that lane. */
	readonly laneId: string | null;
	/** The forge Owner (import mode). */
	readonly forgeOwner: boolean;
};

/** One command's verdict; one rejection rejects the whole push (nothing is forwarded). */
export type RefPolicyDecision =
	| { readonly ref: string; readonly allow: true }
	| {
		readonly ref: string;
		readonly allow: false;
		readonly reason: RefPolicyReason;
	};

/** The canonical repo's per-command table. */
export type CanonicalPushPolicy = (
	ctx: PushContext,
	commands: readonly PushCommand[],
	caller: PushCaller,
) => RefPolicyDecision[];

/** A lane remote's per-command table; `ctx.target` is the lane. */
export type LaneRepoPushPolicy = (
	ctx: PushContext,
	commands: readonly PushCommand[],
	caller: PushCaller,
) => RefPolicyDecision[];

/**
 * Independent of the policy functions: before any canonical write
 * token is minted for a receive-pack, the caller must be a user with a write
 * credential or an agent with an own active `branch`-backend lane in the
 * repo; otherwise every command gets `agents-lanes-only` and no upstream
 * token exists.
 */
export type CanonicalWritePrecheck = (
	ctx: PushContext,
	caller: PushCaller,
) => boolean;

/**
 * The capability route's in-isolate failure buckets: they
 * count failed verifications only (bad syntax, expired, wrong MAC) and never
 * throttle a request whose MAC verifies; past a limit, failures get a 429 and
 * a counter instead of a log line. Every `/-/cap/` path reaches WP4 (the two
 * precise routes and the `cap.not-found` catch-all), so syntax failures are
 * counted too.
 *
 * Zero DO calls before the MAC verifies (the route's spy): the spy
 * counts RepoDO calls, which must be zero. WP2's setup gating for
 * `POLICY.capability` reads ForgeDO's setup state from its per-isolate cache
 * (≤ one ForgeDO call per isolate per 10 s), never once per request, so
 * forged traffic cannot drive ForgeDO either.
 */
export const CAP_FAILURE_LIMITS = {
	perIpPerMin: 20,
	perIsolatePerMin: 200,
} as const;

/**
 * The capability URL MAC: HMAC-SHA256 over
 * `capMacInput(fields)` with `LANE_CAP_KEY` (HKDF-SHA256 from
 * `TARTAN_SECRET`, label `tartan:lane-cap:v1`), imported once per isolate as a
 * non-extractable `CryptoKey` by WP2's keyring. WP5b's seeder signs; WP4's
 * route verifies, in the isolate, before any DO call.
 */
export interface CapMac {
	/** 64 lowercase hex chars. Throws `invalid` for malformed fields. */
	sign(fields: CapFields): Promise<string>;
	/**
	 * Constant-time; false (never a throw) for a wrong, malformed or
	 * wrong-length `mac` or malformed fields.
	 */
	verify(fields: CapFields, mac: string): Promise<boolean>;
}
export type CreateCapMac<Env> = (env: Env) => CapMac;
