// ForgeDO (`forge`, singleton): row types for every table of ForgeDO
// and the facade + internal APIs of its modules. The DO exposes
// `identity()`, `tree()`, `registry()`, `events()` and `slots()` (job slots).
//
// Rows mirror the DDL exactly (snake_case, epoch-ms INTEGERs, JSON as TEXT);
// each module maps them to the camelCase DTOs with typed mappers.

import type {
	Actor,
	EffectiveRole,
	InstallationMode,
	NodeKind,
	Role,
	TokenScope,
	Visibility,
} from "../common.ts";
import type { Envelope } from "../events.ts";
import type { Manifest } from "../manifest.ts";
import type { Ulid } from "../ids.ts";
import type {
	AgentCreateRequest,
	AgentDto,
	EnvironmentCheck,
	IdpClientAuth,
	IdpConfigRequest,
	IdpDeregisterResponse,
	IdpRegisterRequest,
	InstallationDto,
	InstallationInForce,
	InstallRequest,
	InviteCreateRequest,
	InviteDto,
	LaneSelfTestResult,
	NodeDto,
	PackageDto,
	ReplaceProviderRequest,
	ReplaceProviderResponse,
	RepoImportSource,
	SetupSessionInfo,
	SetupStateDto,
	TokenDto,
} from "../api.ts";
import type {
	ConfigApprovalDto,
	ConfigApprovalRequest,
	ConfigApprovalRequestDto,
	RepoConfigApplyAnswer,
	RepoConfigApplyInput,
	RepoConfigCheckAnswer,
	RepoConfigEffectiveRow,
	RepoConfigForgeState,
	RepoConfigLandContext,
	RepoConfigSchemaDto,
} from "../repoconfig.ts";

// ---------------------------------------------------------------------------
// Rows: identity (WP2, 100–199)
// ---------------------------------------------------------------------------

export type SetupState = "fresh" | "unlocked" | "idp" | "done";
export type ForgeMetaKey =
	| "setup_state"
	| "forge_name"
	| "canonical_origin"
	| "owner_principal"
	| "authz_version"
	| "hierarchy_version"
	| "ext_version"
	| "root_key_fallback_sealed"
	| "recovery_banner_until"
	/** The last post-claim lane-repo self-test (`LaneSelfTestResult` JSON; display only). */
	| "lane_selftest_json";

export type SetupCodeRow = {
	code_hash: string;
	purpose: "bootstrap" | "recover";
	source: "secret" | "logs";
	expires_at: number;
	used_at: number | null;
};
export type ConsumedSetupSecretRow = {
	hash: string;
	purpose: "bootstrap" | "recover";
	consumed_at: number;
	consumed_by: string;
};
export type InviteRow = {
	id: string;
	code_hash: string;
	node_id: string;
	role: 10 | 20 | 30 | 40;
	note: string | null;
	relink_principal: string | null;
	created_by: string;
	created_at: number;
	expires_at: number;
	used_at: number | null;
	used_by_issuer: string | null;
	used_by_sub: string | null;
};
export type KeyRow = {
	kid: string;
	alg: "ES256" | "EdDSA";
	use: "client-auth" | "federation";
	private_jwk_sealed: string;
	public_jwk: string;
	state: "active" | "retiring" | "retired";
	created_at: number;
};
export type IdpRow = {
	id: "default";
	issuer: string;
	client_id: string;
	/**
	 * WP2's DDL CHECK lists the same values, including `none` (public client +
	 * PKCE). For DCR: the `token_endpoint_auth_method` the registration RESPONSE
	 * returned, never the one requested.
	 */
	client_auth: IdpClientAuth;
	/** The returned `id_token_signed_response_alg` (default `RS256`). */
	id_token_alg: string;
	client_secret_sealed: string | null;
	/**
	 * Sealed DCR `registration_access_token` + `registration_client_uri`
	 * (kept only when the URI has the registration endpoint's origin).
	 */
	registration_sealed: string | null;
	scopes: string;
	metadata_json: string;
	discovered_at: number;
	username_claim: string;
	allowed_email_domains_json: string | null;
	jit_provisioning: 0 | 1;
	verify_id_token_signature: 0 | 1;
	source: "wizard" | "dcr" | "env";
	updated_at: number;
};
/**
 * `consumed_destroy_tokens` (identity migration 101): the one-time
 * `TARTAN_DESTROY_TOKEN` is accepted once.
 */
export type ConsumedDestroyTokenRow = {
	hash: string;
	consumed_at: number;
	outcome: string;
};
/** Stretch: an IdP `groups`/`roles` claim value mapped to a grant (never Owner). */
export type IdpGroupMappingRow = {
	claim: "groups" | "roles";
	value: string;
	node_id: string;
	role: 10 | 20 | 30 | 40;
	created_by: string;
	created_at: number;
};
export type PrincipalRow = {
	id: string;
	kind: "user" | "agent" | "ext" | "system";
	handle: string;
	display: string;
	email: string | null;
	email_verified: 0 | 1;
	owner_user_id: string | null;
	agent_tool: string | null;
	agent_model: string | null;
	is_admin: 0 | 1;
	created_at: number;
	disabled_at: number | null;
};
export type IdentityRow = {
	issuer: string;
	sub: string;
	principal_id: string;
	last_login_at: number;
};
export type SessionRow = {
	id_hash: string;
	principal_id: string;
	kind: "user" | "setup";
	idp_sid: string | null;
	created_at: number;
	last_seen_at: number;
	idle_expires_at: number;
	absolute_expires_at: number;
};
export type LoginTxnRow = {
	state_hash: string;
	binding_hash: string;
	purpose: "login" | "bootstrap" | "recover";
	verifier_sealed: string;
	nonce: string;
	return_to: string;
	expires_at: number;
	invite_hash: string | null;
};
export type TokenRow = {
	id: string;
	hash: string;
	kind: "pat" | "agent";
	principal_id: string;
	name: string;
	scopes_json: string;
	node_id: string | null;
	lane_id: string | null;
	max_role: Role;
	expires_at: number;
	last_used_at: number | null;
	revoked_at: number | null;
	created_by: string;
	created_at: number;
};
export type DelegationRow = {
	id: string;
	agent_id: string;
	user_id: string;
	node_id: string;
	max_role: number;
	scopes_json: string;
	oauth_client_id: string | null;
	expires_at: number;
	created_at: number;
	revoked_at: number | null;
};

// ---------------------------------------------------------------------------
// Rows: tree (WP3, 200–299)
// ---------------------------------------------------------------------------

export type NodeRow = {
	id: string;
	parent_id: string | null;
	kind: NodeKind;
	slug: string;
	path: string;
	depth: number;
	visibility: Visibility;
	artifacts_name: string | null;
	default_branch: string | null;
	description: string | null;
	created_by: string;
	created_at: number;
	archived_at: number | null;
};
export type RedirectRow = {
	old_path: string;
	node_id: string;
	created_at: number;
};
export type GrantRow = {
	node_id: string;
	principal_id: string;
	role: Role;
	granted_by: string;
	expires_at: number | null;
	created_at: number;
};
export type ProtectedRefRow = {
	node_id: string;
	pattern: string;
	created_at: number;
};
/**
 * `artifacts_index`: one row per Artifacts repo Tartan creates. A lane name is
 * a cache entry (the name itself carries the family).
 */
export type ArtifactsIndexRow = {
	/** Lowercase `r-<repoUlid>`, or `l-<repoUlid>-<laneUlid>[-<n>]` (one row per seed attempt). */
	name: string;
	kind: "repo" | "lane";
	/** The canonical repo (for a lane repo: its family); not unique. */
	repo_id: string;
	/** `ln_<ulid>` iff `kind = 'lane'`. */
	lane_id: string | null;
	/** `pending` is upserted as the FIRST step of every create/import attempt, before any capability is minted. */
	state: "pending" | "live" | "deleted";
	created_at: number;
	updated_at: number;
};

// ---------------------------------------------------------------------------
// Rows: registry (WP7a, 300–399)
// ---------------------------------------------------------------------------

export type PackageRow = {
	ext_id: string;
	version: string;
	runtime: "builtin" | "js" | "wasm";
	manifest_json: string;
	sha256: string;
	r2_prefix: string | null;
	imports_json: string | null;
	published_by: string;
	published_at: number;
	/** A published package's `config.cue` (repository config; migration 311). */
	config_cue?: string | null;
	/**
	 * The input key of the version's passing repository-config self-check
	 * (migration 311; `builtin` for a bundled package, whose `config.cue` is
	 * tested against the CLI); NULL until it passes.
	 */
	config_checked?: string | null;
};
export type InstallationRow = {
	id: string;
	ext_id: string;
	version: string;
	node_id: string;
	mode: InstallationMode;
	storage_scope: "node" | "repo";
	runtime_override: "builtin" | "js" | "wasm" | null;
	config_json: string;
	grants_json: string;
	background_role: 10 | 20 | 30 | 40;
	locked: 0 | 1;
	backfill: "none" | "30d" | "all";
	pack: string | null;
	installed_by: string;
	installed_at: number;
	mode_changed_at: number | null;
	/** Repository config (migration 311): `repo-config` rows come from the root package `tartan` on trunk. */
	source?: "manual" | "repo-config";
	source_sha?: string | null;
	source_key?: string | null;
	/** The approval node a `repo-config` row is bound to. */
	approval_node?: string | null;
	/** An Owner's kill switch on a `repo-config` row; reconcile never re-enables it. */
	owner_disabled?: 0 | 1;
	/** The Owner's opt-in: repositories below may overlay `repoOverridable` keys. */
	repo_overrides?: 0 | 1;
};
export type ContributionKind =
	| "provides"
	| "slot"
	| "tool"
	| "gate"
	| "echo"
	| "subscribe"
	| "context"
	| "protocol"
	| "settings";
export type ContributionRow = {
	installation_id: string;
	kind: ContributionKind;
	key: string;
	data_json: string;
};

// ---------------------------------------------------------------------------
// Rows: forge events + audit (WP6, 400–449); job slots (WP9, 450–499)
// ---------------------------------------------------------------------------

export type ForgeEventRow = {
	seq: number;
	id: string;
	/** `forge_events.idem_key UNIQUE`: the facade is idempotent on it (WP6). */
	idem_key: string;
	type: string;
	envelope_json: string;
	at: number;
};
export type AuditRow = {
	seq: number;
	at: number;
	principal_id: string;
	via_installation: string | null;
	action: string;
	target: string | null;
	data_json: string | null;
};
export type JobSlotRow = {
	slot_key: string;
	kind: "ci" | "git" | "agent";
	run_id: string;
	acquired_at: number;
	expires_at: number;
};
export type UsageDailyRow = {
	day: string;
	kind: string;
	container_ms: number;
	runs: number;
};

// ---------------------------------------------------------------------------
// Shared DTOs used by the facades
// ---------------------------------------------------------------------------

/**
 * Who is calling, as established by `authenticate(req)` (WP2). For OAuth
 * (M2) WP2/WP11 fold the delegation's node, role ceiling and scopes into
 * `nodeId`, `maxRole` and `scopes`. `actorBoundsOf(auth)` turns it into the
 * `ActorBounds` that authz and caps apply.
 */
export type AuthContext = {
	readonly principal: string;
	readonly kind: "user" | "agent";
	readonly via: "session" | "pat" | "agent-token" | "oauth";
	readonly onBehalfOf?: string;
	readonly tokenId?: string;
	readonly scopes: readonly TokenScope[];
	/** Token scope root (null = the principal's grants). */
	readonly nodeId: string | null;
	readonly laneId: string | null;
	readonly maxRole: Role;
	readonly delegationId?: string;
	readonly isAdmin: boolean;
	readonly expiresAt?: number;
};

export type ResolvedPath = {
	readonly node: NodeDto;
	/** Remainder after the longest existing prefix (e.g. `-/changes/zkqv`). */
	readonly rest: string;
	/** Set when the path matched a redirect (301 to the new path). */
	readonly redirectTo?: string;
};

/** Portable since wave 1 (`api.ts`); re-exported here for kernel callers. */
export type { InstallationInForce } from "../api.ts";

export type IndexArtifactsInput = {
	readonly name: string;
	readonly kind: "repo" | "lane";
	readonly repoId: string;
	readonly laneId?: string;
	readonly state: "pending" | "live" | "deleted";
};
/**
 * An index upsert: a `pending` lane row is refused while
 * `MAX_LANE_REPOS_FORGE` lane rows are `pending` or `live` (the lane then
 * opens on `branch`).
 */
export type IndexArtifactsResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: "lane-repo-ceiling" };

/**
 * A stage's deploy record (written by `deno task deploy`, read by `destroy`):
 * what was deployed where, and the DCR client to deregister.
 */
export type DeployRecord = {
	readonly stage: string;
	readonly worker: string;
	readonly hostname: string | null;
	/** `IMAGE_VARIANT=registry`: the digest-pinned runner image reference. */
	readonly imageDigest: string | null;
	/** The DCR client id the wizard registered for this stage. */
	readonly idpClientId: string | null;
	/** Set by `destroy` after `POST /-/admin/idp/deregister`. */
	readonly idpDeregistered?: { readonly at: number; readonly ok: boolean };
	readonly updatedAt: number;
};

// ---------------------------------------------------------------------------
// Facades (RPC) and internals (sync, in-DO)
// ---------------------------------------------------------------------------

/** identity (WP2). */
export interface IdentityFacade {
	setupState(): Promise<SetupStateDto>;
	/** Generates (once) and logs the bootstrap claim code when no setup secret is set. */
	ensureBootstrapCode(): Promise<{ created: boolean }>;
	/** Verifies a setup token or logs code (constant time, rate-limited, single-use); returns a setup session cookie value. */
	unlock(
		input: { token: string; purpose: "bootstrap" | "recover"; ipHash: string },
	): Promise<{ sessionCookie: string; expiresAt: number }>;
	environmentChecks(): Promise<EnvironmentCheck[]>;
	/** Manual IdP configuration (fallback). */
	configureIdp(input: IdpConfigRequest, setupSession: string): Promise<void>;
	/**
	 * Discovers the issuer and registers Tartan by RFC 7591 DCR as a public
	 * PKCE client (`client_auth = none`), then stores it as `configureIdp`
	 * would. Fails `unavailable` without a
	 * `registration_endpoint`, so the wizard falls back to manual entry.
	 */
	registerIdp(
		input: IdpRegisterRequest,
		setupSession: string,
	): Promise<{ clientId: string }>;
	/**
	 * RFC 7592 delete of the stored DCR registration, authorized only by the
	 * one-time `TARTAN_DESTROY_TOKEN` (its sha256 here; accepted once).
	 */
	deregisterIdp(destroyTokenHash: string): Promise<IdpDeregisterResponse>;
	putLoginTxn(row: LoginTxnRow): Promise<void>;
	/** `DELETE … RETURNING`: single use, browser-bound. */
	consumeLoginTxn(
		stateHash: string,
		bindingHash: string,
	): Promise<LoginTxnRow | null>;
	/** First owner (consumes the setup secret). */
	claimOwner(
		identity: {
			issuer: string;
			sub: string;
			handle: string;
			display: string;
			email?: string;
		},
		setupTokenHash: string | null,
	): Promise<{ principal: string; rootNodeId: string }>;
	/** Existing identity → principal; invite → new principal; JIT if allowed; else null. */
	loginIdentity(
		identity: {
			issuer: string;
			sub: string;
			handle: string;
			display: string;
			email?: string;
			emailVerified: boolean;
		},
		inviteHash: string | null,
	): Promise<{ principal: string } | null>;
	createSession(
		principal: string,
		idpSid: string | null,
	): Promise<{ cookie: string; expiresAt: number }>;
	session(idHash: string): Promise<AuthContext | null>;
	deleteSession(idHash: string): Promise<void>;
	/** Token lookup by sha256(plaintext); cached ≤ 60 s per isolate by the caller. */
	token(hash: string): Promise<AuthContext | null>;
	createPat(
		owner: string,
		input: {
			name: string;
			scopes: TokenScope[];
			nodeId?: string;
			maxRole: Role;
			expiresAt: number;
		},
	): Promise<{ tokenId: string; token: string }>;
	createAgent(
		owner: string,
		input: AgentCreateRequest,
	): Promise<{ principal: string; tokenId: string; token: string }>;
	/** Only with `TARTAN_STAGE ^dev` and `TARTAN_DEV_TOOLS=1`. */
	bulkMintAgents(
		owner: string,
		input: {
			count: number;
			prefix: string;
			nodeId: string;
			maxRole: Role;
			ttlMs: number;
		},
	): Promise<{ principal: string; token: string }[]>;
	/**
	 * Its holder, the agent's owner, or an admin. `asAdmin` is the request's
	 * scope-aware admin power (`AuthContext.isAdmin`: a session of an admin,
	 * or a token with the `admin` scope); `principals.is_admin` alone never
	 * grants it.
	 */
	revokeToken(tokenId: string, by: string, asAdmin?: boolean): Promise<void>;
	principal(id: string): Promise<PrincipalRow | null>;
	principalByHandle(handle: string): Promise<PrincipalRow | null>;
	/**
	 * True when `principal` is the forge Owner (the claimed first user). The
	 * gateway asks it for ref-policy row 1: only the forge Owner pushes to an
	 * importing repo.
	 */
	isOwner(principal: string): Promise<boolean>;
	/**
	 * The last post-claim lane-repo self-test (`meta.lane_selftest_json`, display
	 * only), or null.
	 */
	lastLaneSelfTest(): Promise<LaneSelfTestResult | null>;
	/** WP5b's self-test stores its result here; it never changes `LANE_MODE`. */
	recordLaneSelfTest(result: LaneSelfTestResult): Promise<void>;
	createInvite(
		by: string,
		input: InviteCreateRequest,
	): Promise<{ inviteId: string; code: string }>;
	jwks(): Promise<{ keys: unknown[] }>;
	rateLimit(
		key: string,
		limit: number,
		windowMs: number,
	): Promise<{ ok: boolean; retryAfterMs?: number }>;
	/** The setup session behind a `__Host-tartan-setup` cookie value, or null. */
	setupSession(cookie: string): Promise<SetupSessionInfo | null>;
	/** Setup: forge name and canonical origin (needs a setup session). */
	setName(
		input: { forgeName: string; canonicalOrigin: string },
		setupSession: string,
	): Promise<SetupStateDto>;
	/** The configured IdP for the relying party, or null before step 6. */
	idp(): Promise<IdpLoginConfig | null>;
	/**
	 * The first-boot root key when `TARTAN_SECRET` is absent (button path), so an
	 * isolate builds its keyring once; null when the secret is set.
	 */
	rootKey(): Promise<string | null>;
	/** Re-discovers the IdP when its metadata is older than a day (cron). */
	refreshIdp(): Promise<{ refreshed: boolean }>;
	listTokens(principal: string): Promise<TokenDto[]>;
	listAgents(owner: string): Promise<AgentDto[]>;
	/**
	 * Disables an agent principal and revokes its tokens (its owner, or an
	 * admin acting `asAdmin`, as for `revokeToken`).
	 */
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
/** Defined in `api.ts` (portable, the SPA reads it); re-exported for kernel callers. */
export type { SetupSessionInfo };
/** The IdP row and, for `private_key_jwt`, the active client-auth key. */
export type IdpLoginConfig = IdpRow & {
	readonly client_key: {
		readonly kid: string;
		readonly alg: "ES256" | "EdDSA";
		readonly private_jwk_sealed: string;
	} | null;
};
export interface IdentityInternal {
	principalSync(id: string): PrincipalRow | null;
	isOwner(principal: string): boolean;
}

/** tree (WP3). */
export interface TreeFacade {
	resolvePath(path: string): Promise<ResolvedPath | null>;
	node(id: string): Promise<NodeDto | null>;
	children(
		nodeId: string | null,
		cursor?: string,
	): Promise<{ nodes: NodeDto[]; cursor?: string }>;
	createRoot(
		input: { kind: "user" | "group"; slug: string; owner: string },
	): Promise<NodeDto>;
	createNode(
		by: string,
		input: {
			parentId: string;
			kind: "group";
			slug: string;
			visibility?: Visibility;
			description?: string;
		},
	): Promise<NodeDto>;
	/** Writes `artifacts_index(pending)` before `A.create`, then genesis. */
	createRepo(
		by: string,
		input: {
			parentId: string;
			slug: string;
			visibility?: Visibility;
			description?: string;
			defaultBranch?: string;
		},
	): Promise<NodeDto>;
	/** `{url, branch?}`: `ARTIFACTS.import`; `{mode: "push"}`: Owner import mode, `import_state='importing'`. */
	importRepo(
		by: string,
		input: {
			parentId: string;
			slug: string;
			import: RepoImportSource;
			visibility?: Visibility;
			description?: string;
		},
	): Promise<NodeDto>;
	moveNode(
		by: string,
		nodeId: string,
		to: { parentId?: string; slug?: string },
	): Promise<NodeDto>;
	archiveNode(by: string, nodeId: string): Promise<void>;
	effectiveRole(principals: string[], nodeId: string): Promise<EffectiveRole>;
	grant(
		by: string,
		nodeId: string,
		principal: string,
		role: Role,
		expiresAt?: number,
	): Promise<void>;
	revoke(by: string, nodeId: string, principal: string): Promise<void>;
	grants(nodeId: string): Promise<GrantRow[]>;
	protectedRefs(nodeId: string): Promise<string[]>;
	/**
	 * Every repo, by path, for crons that sweep repos (reconciliation, GC).
	 * `archived: false` leaves out archived repos and repos below an archived
	 * group (read-only; the per-tick sweeps skip them).
	 */
	listRepos(
		options?: { cursor?: string; limit?: number; archived?: boolean },
	): Promise<{ repos: { id: string; path: string }[]; cursor?: string }>;
	/** An upsert; enforces the forge-wide lane-repo ceiling. */
	indexArtifacts(input: IndexArtifactsInput): Promise<IndexArtifactsResult>;
	/** Lowercases `name` first (names fold case). */
	lookupArtifacts(name: string): Promise<ArtifactsIndexRow | null>;
	/** Feeds the reconciler and the orphan sweep. */
	listArtifactsIndex(
		state: ArtifactsIndexRow["state"],
		olderThan: number,
	): Promise<ArtifactsIndexRow[]>;
	/** Retained lane repos (`pending`/`live` lane rows) and the ceiling (Admin → Usage). */
	countLaneRepos(): Promise<{ retained: number; max: number }>;
}
export interface TreeInternal {
	nodeSync(id: string): NodeRow | null;
	nodeByPathSync(path: string): NodeRow | null;
	/** Ancestor-or-self paths, root first. */
	ancestorPathsSync(nodeId: string): string[];
	effectiveRoleSync(
		principals: readonly string[],
		nodeId: string,
		now: number,
	): EffectiveRole;
	isWithinSync(rootNodeId: string, nodeId: string): boolean;
	/**
	 * Whether `principal` holds any role at `rootNodeId` or anywhere inside
	 * its subtree (K12: principal events reach only such principals; WP6).
	 */
	holdsRoleWithinSync(
		principal: string,
		rootNodeId: string,
		now: number,
	): boolean;
	/**
	 * Creates a user root inside the caller's `transactionSync`, so the owner
	 * claim is one transaction with its root node (WP2).
	 */
	createRootSync(
		input: { kind: "user"; slug: string; owner: string },
	): NodeRow;
	/** Grants inside the caller's transaction (invite acceptance, WP2). */
	grantSync(by: string, nodeId: string, principal: string, role: Role): void;
}

/** registry (WP7a). */
export interface RegistryFacade {
	publish(
		by: string,
		manifest: Manifest,
		artifact: {
			sha256: string;
			r2Prefix: string | null;
			imports?: string[];
			/** The package's `config.cue` text, iff the manifest declares `config.cue`. */
			configCue?: string;
		},
	): Promise<PackageDto>;
	packages(extId?: string): Promise<PackageDto[]>;
	install(by: string, input: InstallRequest): Promise<InstallationDto>;
	setMode(
		by: string,
		installationId: string,
		mode: InstallationMode,
	): Promise<InstallationDto>;
	/** Atomically shadow → enforce and old → disabled. */
	promote(by: string, installationId: string): Promise<InstallationDto>;
	/**
	 * Removes an installation (a pack also removes its members at the same
	 * node, disabled ones included) and returns every removed row as it was,
	 * so the caller deletes exactly their ExtensionDO data.
	 */
	uninstall(by: string, installationId: string): Promise<InstallationDto[]>;
	installation(id: string): Promise<InstallationDto | null>;
	/**
	 * What acts at a node, nearest first: the
	 * effective installations (nearest provider per interface, nearest
	 * install per extension, a nearer pack masking a farther one), then every
	 * other gate holder reduced to its gates (K8). Event subscribers, echo,
	 * context, extension tools and the exthost cron read this.
	 */
	inForce(nodeId: string): Promise<InstallationInForce[]>;
	/**
	 * Every non-disabled installation at the node or an ancestor, nearest
	 * first, unresolved (the registry query): what the install rules need.
	 */
	installed(nodeId: string): Promise<InstallationInForce[]>;
	/** Swaps the provider of one interface at a node in one transaction. */
	replaceProvider(
		by: string,
		input: ReplaceProviderRequest,
	): Promise<ReplaceProviderResponse>;
	/** Nearest enforce provider, honouring locked ancestors. */
	provider(iface: string, nodeId: string): Promise<InstallationInForce | null>;
	contributions(
		kind: ContributionKind,
		nodeId: string,
	): Promise<ContributionRow[]>;
	/**
	 * Validates a replay of a gate over the last `n` advances of `repoId` and
	 * mints its id; the installations API rebuilds each advance's input
	 * from `expectOld..newSha` through RepoProbe and runs it.
	 */
	replayGate(
		installationId: string,
		n: number,
		repoId: string,
	): Promise<{ replayId: string }>;
	/**
	 * Protocol cards in force at a node, nearest installation first, for MCP
	 * `instructions` and `protocol_get`: bundled cards come from
	 * `src/builtins.ts`, published ones from R2.
	 */
	protocolCards(
		nodeId: string,
	): Promise<{ installation: string; ext: string; md: string }[]>;
	/** Boot-time registration of bundled packages (`published_by = sys_kernel`). */
	registerBuiltins(manifests: Manifest[]): Promise<void>;
	extVersion(): Promise<number>;

	// --- Repository config (WP23; ADR repo config) ---------------------------
	/**
	 * The forge files, schema key and epoch the evaluator uses for a repo.
	 * `watch` (RepoDO's trunk evaluations): ForgeDO pokes this repo after
	 * every later registry change, even before anything was applied there
	 * (a first config the registry denied re-evaluates once it is approved).
	 */
	repoConfigSchema(
		repoNodeId: string,
		options?: { readonly watch?: boolean },
	): Promise<RepoConfigSchemaDto>;
	/** Dry run: the denials and the plan of a resolved config (previews, needs-apply). */
	checkRepoConfig(
		repoNodeId: string,
		resolved: unknown,
	): Promise<RepoConfigCheckAnswer>;
	/** Fenced, all-or-nothing apply; RepoDO stores the answer's state. */
	applyRepoConfig(
		repoNodeId: string,
		input: RepoConfigApplyInput,
	): Promise<RepoConfigApplyAnswer>;
	repoConfigState(repoNodeId: string): Promise<RepoConfigForgeState | null>;
	/** The settings page: where each installation in force comes from, the approvals and the epoch. */
	repoConfigEffective(repoNodeId: string): Promise<{
		effective: RepoConfigEffectiveRow[];
		approvals: ConfigApprovalDto[];
		epoch: number;
	}>;
	/** LandWorkflow's one read (K13.1): the review provider and ForgeDO's hold. */
	landContext(repoNodeId: string): Promise<RepoConfigLandContext>;
	/** Owner (session): records the request and starts the self-check. */
	requestConfigApproval(
		by: string,
		nodeId: string,
		extId: string,
		input: ConfigApprovalRequest,
	): Promise<ConfigApprovalRequestDto>;
	/** The self-check sink: commits the approval only on a pass. */
	selfCheckResult(
		requestId: string,
		envelope: unknown,
	): Promise<ConfigApprovalRequestDto>;
	revokeConfigApproval(
		by: string,
		nodeId: string,
		extId: string,
	): Promise<void>;
	configApprovals(nodeId: string): Promise<{
		approvals: ConfigApprovalDto[];
		requests: ConfigApprovalRequestDto[];
	}>;
	/** Owner at the installation's node: the repo-overrides opt-in. */
	setRepoOverrides(
		by: string,
		installationId: string,
		on: boolean,
	): Promise<InstallationDto>;
	/**
	 * An installation as its ExtensionDO for one repo sees it: the config
	 * with that repo's overlay merged over it (WP7b; nothing else changes).
	 */
	installationAt(
		installationId: string,
		repoNodeId: string,
	): Promise<InstallationDto | null>;
}
export interface RegistryInternal {
	inForceSync(nodeId: string): InstallationInForce[];
	extVersionSync(): number;
	/** The repository-config epoch (`meta.config_epoch`). */
	repoConfigEpochSync(): number;
	/**
	 * WP3's tree move and archive call this inside their transaction: drops
	 * the repo-config rows in the subtree whose approval no longer binds.
	 */
	revalidateRepoConfigSync(by: string, scopeNodeId: string): number;
}

/** forge events + audit (WP6). */
export interface ForgeEventsFacade {
	/** Filtered by the reading installation's subtree (K12) when `subtreeNodeId` is set. */
	read(
		since: number,
		patterns: string[],
		options?: { limit?: number; subtreeNodeId?: string },
	): Promise<Envelope[]>;
	/**
	 * `read` with how far it looked: `scannedTo` is the last seq the read
	 * considered (the head when it reached it). A subtree-filtered read stops
	 * after a bounded scan, so a short page alone does not mean caught up; a
	 * cursor advances to `scannedTo`, never past it (ExtensionDO's drain).
	 */
	readPage(
		since: number,
		patterns: string[],
		options?: { limit?: number; subtreeNodeId?: string },
	): Promise<{ events: Envelope[]; scannedTo: number }>;
	head(): Promise<number>;
	/**
	 * Appends a kernel event to the forge stream over RPC. Only types
	 * whose `KERNEL_EVENT_STREAMS` entry is `forge` or `both` and that a
	 * non-ForgeDO producer may append: `extension.error` (ExtensionDO, for
	 * every installation including node-scoped ones).
	 */
	appendKernel(
		event: {
			type: "extension.error";
			actor: Actor;
			node: string;
			data: unknown;
			idemKey: string;
		},
	): Promise<{ id: string; seq: number }>;
	audit(
		entry: {
			principal: string;
			viaInstallation?: string;
			action: string;
			target?: string;
			data?: unknown;
		},
	): Promise<void>;
	auditLog(since: number, limit: number): Promise<AuditRow[]>;
}
export interface ForgeEventsInternal {
	/** Appends inside the caller's `transactionSync` (K3 for forge-level changes). */
	appendSync(
		event: {
			type: string;
			actor: Actor;
			node: string;
			data: unknown;
			idemKey: string;
		},
	): { id: string; seq: number };
	auditSync(
		entry: {
			principal: string;
			viaInstallation?: string;
			action: string;
			target?: string;
			data?: unknown;
		},
	): void;
}

/** job slots + usage (WP9). */
export interface JobSlotsFacade {
	acquire(
		kind: "ci" | "git" | "agent",
		runId: string,
		ttlMs: number,
	): Promise<{ slotKey: string } | { wait: true; retryAfterMs: number }>;
	release(slotKey: string): Promise<void>;
	recordUsage(kind: string, containerMs: number): Promise<void>;
	usage(day: string): Promise<UsageDailyRow[]>;
	budgetExceeded(kind: "ci" | "git" | "agent"): Promise<boolean>;
}
export type JobSlotsInternal = Record<string, never>;

/** The ForgeDO RPC surface (thin class; WP0). */
export interface ForgeDoApi {
	identity(): IdentityFacade;
	tree(): TreeFacade;
	registry(): RegistryFacade;
	events(): ForgeEventsFacade;
	slots(): JobSlotsFacade;
}

export type ForgeModuleName =
	| "identity"
	| "tree"
	| "registry"
	| "events"
	| "slots";
export type ForgeInternals = {
	readonly identity: IdentityInternal;
	readonly tree: TreeInternal;
	readonly registry: RegistryInternal;
	readonly events: ForgeEventsInternal;
	readonly slots: JobSlotsInternal;
};

export type NodeId = Ulid;

/** Timer users in ForgeDO: `_timers.module` → key prefixes. */
export const FORGE_TIMERS = {
	tree: ["tree"],
	slots: ["slots"],
	/** `repoconfig`: the dirty outbox that pokes RepoDOs after a registry change (WP23). */
	registry: ["repoconfig"],
} as const;
