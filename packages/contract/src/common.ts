// Shared primitives used across the contract.
// Zod schemas are suffixed `Schema`; the inferred type carries the bare name.

import { z } from "zod";
import {
	CHANGE_ID_RE,
	PRINCIPAL_ID_RE,
	SHA1_RE,
	SHA256_HEX_RE,
	ULID_RE,
} from "./ids.ts";
import { NODE_PATH_RE, REPO_PATH_RE } from "./paths.ts";

// Zod-free since 0.2.1 (paths.ts), so the SPA bundle can use it; still exported here.
export { REPO_PATH_RE };

export const UlidSchema = z.string().regex(ULID_RE, "lowercase ulid");
export const ShaSchema = z.string().regex(SHA1_RE, "40-char lowercase sha");
export const Sha256HexSchema = z.string().regex(SHA256_HEX_RE);
export const PrincipalIdSchema = z.string().regex(PRINCIPAL_ID_RE);
const ULID_BODY = "[0-7][0-9a-hjkmnp-tv-z]{25}";
export const InstallationIdSchema = z.string().regex(
	new RegExp(`^i_${ULID_BODY}$`),
	"installation id i_<ulid>",
);
export const LaneIdSchema = z.string().regex(
	new RegExp(`^ln_${ULID_BODY}$`),
	"lane id ln_<ulid>",
);
export const BatchIdSchema = z.string().regex(
	new RegExp(`^lb_${ULID_BODY}$`),
	"batch id lb_<ulid>",
);
export const ChangeIdSchema = z.string().regex(CHANGE_ID_RE, "change id");
export const RefNameSchema = z.string().min(5).max(1024).startsWith("refs/");
export const RepoPathSchema = z.string().max(4096).regex(
	REPO_PATH_RE,
	"repo-relative path",
);
export const NodePathSchema = z.string().min(1).max(16384).regex(
	NODE_PATH_RE,
	"node path",
);

export type PrincipalId = string;
export type LaneId = string;
export type EventId = string;
export type InstallationId = string;
export type Sha = string;

// ---------------------------------------------------------------------------
// Roles and permissions
// ---------------------------------------------------------------------------

export const ROLE = {
	none: 0,
	guest: 10,
	reporter: 20,
	developer: 30,
	maintainer: 40,
	owner: 50,
} as const;
export type RoleName = keyof typeof ROLE;
/** Stored roles (grants, tokens). 0 = no access is only ever computed. */
export const RoleSchema = z.union([
	z.literal(10),
	z.literal(20),
	z.literal(30),
	z.literal(40),
	z.literal(50),
]);
export type Role = z.infer<typeof RoleSchema>;
export type EffectiveRole = Role | 0;

export const roleName = (role: number): RoleName =>
	role >= 50
		? "owner"
		: role >= 40
		? "maintainer"
		: role >= 30
		? "developer"
		: role >= 20
		? "reporter"
		: role >= 10
		? "guest"
		: "none";

/** Permissions checked by `caps.authz.check` and the router, with their minimum role. */
export const PERMISSION_MIN_ROLE = {
	"read-metadata": 10,
	"read": 20,
	"comment": 20,
	"push": 30,
	"claim": 30,
	"submit": 30,
	"approve": 40,
	"push-tags": 40,
	"install": 40,
	"grant": 50,
	"install-privileged": 50,
	"delete": 50,
} as const satisfies Record<string, Role>;
export type Permission = keyof typeof PERMISSION_MIN_ROLE;
export const PermissionSchema = z.enum(
	Object.keys(PERMISSION_MIN_ROLE) as [Permission, ...Permission[]],
);

export const VisibilitySchema = z.enum(["private", "internal", "public"]);
export type Visibility = z.infer<typeof VisibilitySchema>;

export const NodeKindSchema = z.enum(["user", "group", "repo"]);
export type NodeKind = z.infer<typeof NodeKindSchema>;

/** Token scopes. */
export const TokenScopeSchema = z.enum([
	"repo:read",
	"repo:write",
	"lanes",
	"mcp",
	"api",
	"admin",
]);
export type TokenScope = z.infer<typeof TokenScopeSchema>;

/**
 * Capability scopes a token needs for each permission (any one of them; an
 * empty list means no scope is needed). Channel scopes (`mcp` for `/-/mcp`,
 * `api` for `/-/api`) are checked per route by the HTTP middleware
 * (`RoutePolicy.tokenScope`), not here. Sessions are unrestricted.
 */
export const PERMISSION_TOKEN_SCOPES = {
	"read-metadata": [],
	"read": ["repo:read", "repo:write"],
	"comment": ["repo:read", "repo:write"],
	"push": ["repo:write"],
	"claim": ["lanes"],
	"submit": ["lanes"],
	"approve": ["repo:write"],
	"push-tags": ["repo:write"],
	"install": ["admin"],
	"grant": ["admin"],
	"install-privileged": ["admin"],
	"delete": ["admin"],
} as const satisfies Record<Permission, readonly TokenScope[]>;

/**
 * The credential bounds of an acting user or agent, derived
 * from its `AuthContext` by the kernel and never shown to extensions. An
 * agent's role is `min(grants ∪ owner user's role, maxRole)` ∩ scopes ∩ token
 * node subtree ∩ lane pin (∩ delegation, folded in by WP2/WP11).
 */
export type ActorBounds = {
	/** Role ceiling (50 for sessions). */
	readonly maxRole: Role;
	/** Token scopes; null for a session (unrestricted). */
	readonly scopes: readonly TokenScope[] | null;
	/** Token scope root; null = the principal's grants anywhere. */
	readonly nodeId: string | null;
	/** Lane pin; null = not pinned. */
	readonly laneId: string | null;
	readonly delegationId?: string;
};

/** Bounds of an unrestricted session (a signed-in human in the browser). */
export const SESSION_BOUNDS: ActorBounds = {
	maxRole: 50,
	scopes: null,
	nodeId: null,
	laneId: null,
};

/** True when `scopes` (null = session) allow `perm`. */
export const scopesAllow = (
	scopes: readonly TokenScope[] | null,
	perm: Permission,
): boolean => {
	if (scopes === null) return true;
	const needed: readonly TokenScope[] = PERMISSION_TOKEN_SCOPES[perm];
	return needed.length === 0 || needed.some((s) => scopes.includes(s));
};

/**
 * Applies credential bounds to a role computed from grants:
 * 0 outside the token's node subtree; capped at `maxRole`; capped at
 * Reporter (read and comment only) for a lane-pinned token acting on anything
 * but its lane. Scopes are checked separately with `scopesAllow`.
 */
export const boundRole = (
	granted: EffectiveRole,
	bounds: ActorBounds | null,
	at: {
		/** The target lies in `bounds.nodeId`'s subtree (always true when it is null). */
		readonly withinTokenNode: boolean;
		/** The lane the operation targets, if any. */
		readonly laneId?: string | null;
	},
): EffectiveRole => {
	if (bounds === null) return granted;
	if (bounds.nodeId !== null && !at.withinTokenNode) return 0;
	let role = Math.min(granted, bounds.maxRole) as EffectiveRole;
	if (bounds.laneId !== null && at.laneId !== bounds.laneId) {
		role = Math.min(role, ROLE.reporter) as EffectiveRole;
	}
	return role;
};

// ---------------------------------------------------------------------------
// Actors, entities and target references (K12)
// ---------------------------------------------------------------------------

export const ActorKindSchema = z.enum(["user", "agent", "ext", "system"]);
export type ActorKind = z.infer<typeof ActorKindSchema>;

export const ActorSchema = z.strictObject({
	kind: ActorKindSchema,
	id: PrincipalIdSchema,
	onBehalfOf: PrincipalIdSchema.optional(),
});
export type Actor = z.infer<typeof ActorSchema>;

export const EntityRefSchema = z.strictObject({
	kind: z.string().min(1).max(32).regex(/^[a-z][a-z0-9_-]*$/),
	id: z.string().min(1).max(200),
});
export type EntityRef = z.infer<typeof EntityRefSchema>;

/**
 * A node by id or by path. Every NodeRef/RepoRef an installation names is
 * resolved by the kernel and confined to the installation subtree (K12).
 */
export const NodeRefSchema = z.union([
	z.strictObject({ id: UlidSchema }),
	z.strictObject({ path: NodePathSchema }),
]);
export type NodeRef = z.infer<typeof NodeRefSchema>;
/** A repo node by id or path (same shape as NodeRef; the kernel checks kind = repo). */
export const RepoRefSchema = NodeRefSchema;
export type RepoRef = NodeRef;

/**
 * Git data source: the canonical repo or one of its lanes. Never a raw
 * Artifacts name. A `laneId` reads that lane's current lane repo
 * (`repo` backend) or the canonical repo (`branch` backend), resolved by
 * RepoDO (K15).
 */
export const GitSourceSchema = z.strictObject({
	repoId: UlidSchema,
	laneId: LaneIdSchema.optional(),
});
export type GitSource = z.infer<typeof GitSourceSchema>;

/** Event streams: one per repo, plus the forge stream. */
export const StreamRefSchema = z.union([
	z.literal("forge"),
	z.templateLiteral(["repo:", UlidSchema]),
]);
export type StreamRef = "forge" | `repo:${string}`;
export const repoStream = (repoId: string): `repo:${string}` =>
	`repo:${repoId}`;

/** Declared at claim time. */
export const FootprintSchema = z.strictObject({
	projects: z.array(z.string().min(1).max(128)).max(64),
	prefixes: z.array(RepoPathSchema).max(64),
});
export type Footprint = z.infer<typeof FootprintSchema>;
export const EMPTY_FOOTPRINT: Footprint = { projects: [], prefixes: [] };

export const InstallModeSchema = z.enum(["enforce", "shadow"]);
export type InstallMode = z.infer<typeof InstallModeSchema>;
export const InstallationModeSchema = z.enum(["enforce", "shadow", "disabled"]);
export type InstallationMode = z.infer<typeof InstallationModeSchema>;

export const SeveritySchema = z.enum(["info", "warn", "critical"]);
export type Severity = z.infer<typeof SeveritySchema>;

/** The versioned interfaces. */
export const INTERFACE_IDS = [
	"work@1",
	"changes@1",
	"conflicts@1",
	"checks@1",
	"review@1",
	"queue@1",
	"context@1",
] as const;
export type InterfaceId = typeof INTERFACE_IDS[number];
export const InterfaceIdSchema = z.enum(INTERFACE_IDS);
/** Interfaces a manifest may `provide` (context@1 is contributed via `contributes.context`). */
export const PROVIDABLE_INTERFACES = [
	"work@1",
	"changes@1",
	"conflicts@1",
	"checks@1",
	"review@1",
	"queue@1",
] as const;
export type ProvidableInterface = typeof PROVIDABLE_INTERFACES[number];

/** Installing a provider of these needs an Owner. */
export const OWNER_APPROVED_INTERFACES = [
	"checks@1",
	"review@1",
	"queue@1",
] as const;

/**
 * K12: the only interface tools that reject a bare installation actor
 * (`x_<inst>`) unless the provider's documented precondition holds (e.g.
 * `queue_enqueue` only for a change with a non-shadow approval). A
 * precondition waives this actor rule only; the tool's `role` is still
 * checked against the installation's `background_role`.
 */
export const ACTOR_REQUIRED_TOOLS = [
	"queue_enqueue",
	"review_decide",
	"work_claim",
] as const;

/** Shadow installs are limited to gates and review@1 routing. */
export const SHADOWABLE_INTERFACES = ["review@1"] as const;

export const Json = z.json();
export type JsonValue = z.infer<typeof Json>;
