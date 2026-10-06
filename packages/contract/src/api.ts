// HTTP API DTOs (`/-/api/*`, `/-/setup/*`, `/-/health`, `/-/live`) shared by the
// kernel handlers and the SPA.
//
// Portable: no workers-types globals, so `web/` can import it. Request bodies
// have zod schemas (handlers validate them); responses are plain types.

import { z } from "zod";
import {
	type EffectiveRole,
	EntityRefSchema,
	FootprintSchema,
	type InstallationMode,
	InstallationModeSchema,
	type NodeKind,
	NodePathSchema,
	PROVIDABLE_INTERFACES,
	RepoPathSchema,
	type Role,
	RoleSchema,
	type TokenScope,
	TokenScopeSchema,
	UlidSchema,
	type Visibility,
	VisibilitySchema,
} from "./common.ts";
import type { Envelope } from "./events.ts";
import type { BlameRange, CommitMeta, FileDiff, TreeEntry } from "./git.ts";
import { SLUG_RE } from "./ids.ts";
import type { Advance, LandStatus } from "./land.ts";
import {
	ATTIC_RETENTION_MAX_MS,
	type Lane,
	type LaneMode,
	LaneModeSchema,
	type LaneSeed,
	type LaneSeedFailCode,
} from "./lanes.ts";
import type { Manifest } from "./manifest.ts";
import type { Notice } from "./notices.ts";
import type { WhyNote } from "./notes.ts";
import type { RunStatus, RunTransport } from "./pipeline.ts";
import {
	SLOT_CTX_GATE_RE,
	SLOT_CTX_LIMITS,
	type SlotCtxHint,
} from "./slot-ctx.ts";
import { type RenderCacheScope, SLOT_ROUTE_RE, type SlotId } from "./slots.ts";
import type { ActionResult, HostUiDoc } from "./ui.ts";

export type { WireError as ApiError } from "./errors.ts";

export const API_BASE = "/-/api" as const;

const Slug = z.string().regex(SLUG_RE);
const HttpsUrl = z.url({ protocol: /^https$/ }).max(2048);

// ---------------------------------------------------------------------------
// Health and setup
// ---------------------------------------------------------------------------

export type HealthResponse = {
	readonly ok: boolean;
	readonly product: "Tartan";
	readonly version: string;
	readonly compatDate: string;
	readonly stage: string;
	readonly setupState: "fresh" | "unlocked" | "idp" | "done";
	/** Binding name → present (and, where cheap, live-checked). */
	readonly bindings: Readonly<Record<string, "ok" | "missing" | "error">>;
	/**
	 * The runner image's last warm-up selftest (`POST /-/health/warm`, WP9),
	 * read from the `selftest` sandbox's storage without starting a
	 * container; absent until one has run.
	 */
	readonly runner?: HealthRunner;
	/**
	 * The global log (WP26): `off` (no stream binding), `produce-only` (no
	 * consume token: runs dispatch inline), `degraded`, `blocked` (a
	 * configuration error), `ok`. Nothing more is exposed here.
	 */
	readonly k2?: "ok" | "degraded" | "blocked" | "produce-only" | "off";
};
export type HealthRunner = {
	readonly ok: boolean;
	readonly gitVersion: string | null;
	readonly pnpmVersion: string | null;
	readonly mergeTree: boolean;
	readonly users: boolean;
	/** The image record (base digest, pins) the Dockerfile writes. */
	readonly image: Readonly<Record<string, string>> | null;
	readonly checkedAt: number;
};

export type SetupStateDto = {
	readonly state: "fresh" | "unlocked" | "idp" | "done";
	readonly forgeName?: string;
	readonly canonicalOrigin?: string;
	/** Set for 7 days after a recovery. */
	readonly recoveryBannerUntil?: number;
	/** True when `TARTAN_SECRET` is absent and a generated root key is in use. */
	readonly rootKeyFallback: boolean;
};

export const UnlockRequestSchema = z.strictObject({
	token: z.string().min(16).max(512),
});
export type UnlockRequest = z.infer<typeof UnlockRequestSchema>;

/**
 * One ✓/✗ of the setup wizard's environment check, or the post-claim lane-repo
 * self-test (`lane-repos`, phase `post-claim`): it runs after the claim, only
 * displays a warning with a fix hint, and never changes `LANE_MODE`.
 */
export type EnvironmentCheck = {
	readonly id:
		| "artifacts"
		| "loader"
		| "containers"
		| "ai"
		| "r2"
		| "origin"
		| "lane-repos";
	readonly phase: "setup" | "post-claim";
	readonly ok: boolean;
	readonly optional: boolean;
	readonly message: string;
	readonly hint?: string;
	/** A machine-readable code, e.g. a `LaneSeedFailCode` for `lane-repos`. */
	readonly code?: string;
};
/** `POST /-/setup/checks` (WP2): the pre-claim environment checks. */
export type SetupChecksResponse = {
	readonly checks: readonly EnvironmentCheck[];
};
/** `POST /-/setup/idp/register` (WP2, `IdentityFacade.registerIdp`). */
export type IdpRegisterResponse = { readonly clientId: string };

/**
 * The setup session behind the `__Host-tartan-setup` cookie
 * (`IdentityFacade.setupSession`). Its purpose follows the setup state:
 * `recover` once the forge is claimed.
 */
export type SetupSessionInfo = {
	readonly purpose: "bootstrap" | "recover";
	readonly expiresAt: number;
};
/**
 * `POST /-/setup/status` (WP2): the setup state plus the caller's setup
 * session, null without a valid setup cookie. Setup-exempt in every state.
 */
export type SetupStatusResponse = SetupStateDto & {
	readonly session: SetupSessionInfo | null;
};
/**
 * `POST /-/setup/code` (WP2, `IdentityFacade.ensureBootstrapCode`): whether a
 * claim code was written to Workers Logs (false while a valid one exists,
 * once the forge is claimed, or when the deploy set `TARTAN_SETUP_TOKEN`).
 */
export type SetupCodeResponse = { readonly created: boolean };
/**
 * `POST /-/setup/unlock` and `/-/setup/recover` (WP2): the session itself
 * rides in the `__Host-tartan-setup` cookie.
 */
export type SetupUnlockResponse = { readonly ok: true } & SetupSessionInfo;
/** `POST /-/setup/idp` (WP2): the manual IdP configuration was stored. */
export type SetupOkResponse = { readonly ok: true };

/**
 * The post-claim lane-repo self-test (`POST /-/api/admin/selftest/lanes`,
 * WP5b): one scratch lane opened through the real seeder and capability
 * route (`import` only), verified and deleted. Stored in ForgeDO
 * `meta.lane_selftest_json`. `importer-unreachable` means the route saw no
 * request for the nonce (zone security in front of `/-/cap/*`).
 */
export type LaneSelfTestResult = {
	readonly ok: boolean;
	readonly seed?: LaneSeed;
	readonly seedMs?: number;
	readonly code?: LaneSeedFailCode;
	readonly hint?: string;
	readonly at: number;
};

export const SetupNameRequestSchema = z.strictObject({
	forgeName: z.string().min(1).max(80),
	canonicalOrigin: HttpsUrl,
});

/**
 * Token-endpoint client authentication. `none` is a
 * public client: PKCE S256 is mandatory and no secret exists. It is the
 * default for the demo IdP, which does not support `private_key_jwt`.
 */
export const IDP_CLIENT_AUTH = [
	"none",
	"private_key_jwt",
	"client_secret_basic",
	"client_secret_post",
] as const;
export const IdpClientAuthSchema = z.enum(IDP_CLIENT_AUTH);
export type IdpClientAuth = z.infer<typeof IdpClientAuthSchema>;
export const DEFAULT_IDP_CLIENT_AUTH: IdpClientAuth = "none";

const IdpOptions = {
	scopes: z.string().max(512).optional(),
	usernameClaim: z.string().max(64).optional(),
	allowedEmailDomains: z.array(z.string().max(253)).max(32).optional(),
	jitProvisioning: z.boolean().optional(),
};

/** Manual IdP configuration (the fallback when the wizard cannot register via DCR). */
export const IdpConfigRequestSchema = z.strictObject({
	issuer: HttpsUrl,
	clientId: z.string().min(1).max(512),
	clientAuth: IdpClientAuthSchema.default(DEFAULT_IDP_CLIENT_AUTH),
	clientSecret: z.string().max(1024).optional(),
	...IdpOptions,
}).superRefine((v, ctx) => {
	if (v.clientAuth === "none" && v.clientSecret !== undefined) {
		ctx.addIssue({
			code: "custom",
			message: "a public client (clientAuth none) has no secret",
			path: ["clientSecret"],
		});
	}
});
export type IdpConfigRequest = z.output<typeof IdpConfigRequestSchema>;

/**
 * "Paste the issuer URL": the wizard registers Tartan at the IdP's
 * `registration_endpoint` (RFC 7591 DCR) as a public PKCE client and stores
 * the returned client id. Manual `IdpConfigRequest`
 * is the fallback when the IdP has no registration endpoint.
 */
export const IdpRegisterRequestSchema = z.strictObject({
	issuer: HttpsUrl,
	/** For IdPs whose registration endpoint requires an initial access token (RFC 7591 §3). Used once, never stored. */
	initialAccessToken: z.string().min(1).max(4096).optional(),
	...IdpOptions,
});
export type IdpRegisterRequest = z.infer<typeof IdpRegisterRequestSchema>;

/**
 * `POST /-/admin/idp/deregister` (WP2; 404 unless `TARTAN_DESTROY_TOKEN` is
 * set): the RFC 7592 delete of this stage's DCR client, called by
 * `deno task destroy`.
 */
export type IdpDeregisterResponse = {
	readonly clientId: string;
	readonly deregistered: boolean;
	/** Why not, when `deregistered` is false (no registration stored, the IdP refused, …). */
	readonly reason?: string;
};

export const PackChoiceRequestSchema = z.strictObject({
	pack: z.enum(["tartan.pack.swarm", "tartan.pack.classic"]),
});

// ---------------------------------------------------------------------------
// Nodes, repos, grants, invites
// ---------------------------------------------------------------------------

export type NodeDto = {
	readonly id: string;
	readonly parentId: string | null;
	readonly kind: NodeKind;
	readonly slug: string;
	readonly path: string;
	readonly depth: number;
	readonly visibility: Visibility;
	readonly description?: string;
	/** Repos only. */
	readonly defaultBranch?: string;
	readonly archived: boolean;
	readonly createdAt: number;
};

export type NodesResponse = {
	readonly nodes: readonly NodeDto[];
	readonly cursor?: string;
};

export const NodeCreateRequestSchema = z.strictObject({
	parent: NodePathSchema.optional(),
	kind: z.enum(["group"]),
	slug: Slug,
	visibility: VisibilitySchema.optional(),
	description: z.string().max(500).optional(),
});

/**
 * Where an imported repo comes from: a public URL that
 * `ARTIFACTS.import` pulls server-side, or the Owner-only import mode
 * (`{mode: "push"}`: the repo is created empty with `import_state='importing'`
 * and the forge Owner pushes history in segments, then calls
 * `import-complete`).
 */
export const RepoImportSourceSchema = z.union([
	z.strictObject({
		url: HttpsUrl,
		branch: z.string().max(200).optional(),
	}),
	z.strictObject({ mode: z.literal("push") }),
]);
export type RepoImportSource = z.infer<typeof RepoImportSourceSchema>;

export const RepoCreateRequestSchema = z.strictObject({
	parent: NodePathSchema,
	slug: Slug,
	visibility: VisibilitySchema.optional(),
	description: z.string().max(500).optional(),
	defaultBranch: z.string().max(200).optional(),
	/** Import instead of create. */
	import: RepoImportSourceSchema.optional(),
	/** Seed the bundled sample monorepo. */
	sample: z.boolean().optional(),
});

/**
 * `POST /-/api/repos/<id>/import-complete` (route and DTO WP3, logic WP5a's
 * `importComplete`): ends import mode.
 */
export const ImportCompleteRequestSchema = z.strictObject({
	/** The default branch; defaults to the one the repo was created with. */
	defaultBranch: z.string().min(1).max(200).optional(),
});
export type ImportCompleteRequest = z.infer<typeof ImportCompleteRequestSchema>;
/** After `refs` was reconciled, `trunk_commits` seeded and protection and lanes turned on (⇒ `repo.imported`). */
export type ImportCompleteResponse = {
	readonly repoId: string;
	readonly defaultBranch: string;
	readonly trunkSha: string;
	/** Refs now in the RepoDO index. */
	readonly refs: number;
	/** First-parent chain commits recorded in `trunk_commits` (≤ 1,000, K17). */
	readonly trunkCommits: number;
};

export const NodeMoveRequestSchema = z.strictObject({
	node: NodePathSchema,
	parent: NodePathSchema.optional(),
	slug: Slug.optional(),
});

export const GrantRequestSchema = z.strictObject({
	node: NodePathSchema,
	principal: z.string().min(1).max(64),
	role: RoleSchema,
	expiresAt: z.number().int().optional(),
});

/** One grant stored at a node (not inherited ones). */
export type GrantDto = {
	readonly principal: string;
	readonly role: Role;
	readonly grantedBy: string;
	readonly expiresAt: number | null;
	readonly createdAt: number;
};

/** `GET /-/api/nodes/grants?node=` (members only, never the public view). */
export type GrantsResponse = {
	/** The node's path. */
	readonly node: string;
	readonly grants: readonly GrantDto[];
};

/** `GET /-/api/nodes/resolve?path=` (301 when the path moved). */
export type NodeResolveResponse = { readonly node: NodeDto };

export const InviteCreateRequestSchema = z.strictObject({
	node: NodePathSchema,
	role: z.union([z.literal(10), z.literal(20), z.literal(30), z.literal(40)]),
	note: z.string().max(200).optional(),
	/** Issuer migration: relink this existing principal. */
	relinkPrincipal: z.string().max(64).optional(),
});
export type InviteCreateRequest = z.infer<typeof InviteCreateRequestSchema>;
export type InviteCreated = {
	readonly inviteId: string;
	/** `https://<canonical>/-/invite/<code>`, shown once. */
	readonly url: string;
	readonly expiresAt: number;
};
/** One invite, never with its code (`GET /-/api/invites`; WP2). */
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
/** One PAT or agent token, never with its secret (`GET /-/api/tokens`; WP2). */
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
/** `GET /-/api/me` (WP2 `handleMe`): the caller, how it authenticated, the forge. */
export type MeResponse =
	| { readonly principal: null }
	| {
		readonly principal: {
			readonly id: string;
			readonly kind: "user" | "agent" | "ext" | "system";
			readonly handle: string;
			readonly display: string;
			readonly email?: string;
			/** `/-/avatar/<id>`. */
			readonly avatar: string;
		};
		readonly auth: {
			readonly via: "session" | "pat" | "agent-token" | "oauth";
			readonly isAdmin: boolean;
			readonly scopes: readonly TokenScope[];
			readonly nodeId: string | null;
			readonly laneId: string | null;
			readonly maxRole: Role;
			readonly tokenId?: string;
			readonly expiresAt?: number;
		};
		readonly forge: {
			readonly name?: string;
			readonly rootKeyFallback: boolean;
			readonly recoveryBannerUntil?: number;
			readonly devTools: boolean;
		};
	};

// ---------------------------------------------------------------------------
// View and slots
// ---------------------------------------------------------------------------

export type ViewerDto = {
	readonly principal?: {
		readonly id: string;
		readonly handle: string;
		readonly display: string;
		readonly kind: "user" | "agent";
	};
	readonly role: EffectiveRole;
	readonly isAdmin: boolean;
};

export type StaticContributionDto = {
	readonly installationId: string;
	readonly ext: string;
	readonly slot: SlotId;
	readonly id: string;
	readonly label?: string;
	readonly title?: string;
	readonly icon?: string;
	readonly route?: string;
	readonly order: number;
};

export type SlotInstanceDto = {
	readonly installationId: string;
	readonly ext: string;
	readonly slot: SlotId;
	readonly id: string;
	readonly title?: string;
	readonly refreshOn: readonly string[];
	readonly cache: RenderCacheScope;
	readonly order: number;
};

/** `GET /-/api/view?path=…&view=…`. */
export type ViewResponse = {
	readonly node: NodeDto;
	readonly repo?: {
		readonly id: string;
		readonly defaultBranch: string;
		readonly trunkSha: string | null;
		readonly landingPaused: boolean;
	};
	readonly viewer: ViewerDto;
	readonly view: string;
	readonly static: {
		readonly tabs: readonly StaticContributionDto[];
		readonly nav: readonly StaticContributionDto[];
		readonly actions: readonly StaticContributionDto[];
	};
	readonly slots: readonly SlotInstanceDto[];
	readonly banners: readonly {
		readonly tone: "warning" | "danger" | "info";
		readonly text: string;
	}[];
};

/**
 * `GET /-/api/slot/<inst>/<slot>?ctx=…` returns a validated document (or the
 * error chip). `cursor`, when the slot has a repo, is that repo's event-log
 * head read just before the render ran: the SPA's live channel subscribes
 * with `since=<cursor>`, so an event appended between the render and the
 * socket's `hello` is replayed, never lost.
 */
export type SlotRenderResponse = HostUiDoc & { readonly cursor?: number };

/**
 * Slot ctx hints (`SlotCtxHint`, slot-ctx.ts): the decoded `ctx` query
 * parameter of a slot render (base64url of this JSON object) and the `ctx` of
 * an action body. Strict: unknown keys are refused. Hints only: the kernel
 * refuses what the slot does not take (`slotCtxRefusal`), then re-derives and
 * confines every value (K12). `checkSlotCtxHint` is its zod-free mirror.
 */
export const SlotCtxHintSchema = z.strictObject({
	node: NodePathSchema.optional(),
	repo: NodePathSchema.optional(),
	ref: z.string().min(1).max(SLOT_CTX_LIMITS.refMax).optional(),
	path: RepoPathSchema.optional(),
	entity: EntityRefSchema.optional(),
	route: z.string().regex(SLOT_ROUTE_RE).optional(),
	revision: z.number().int().min(1).max(SLOT_CTX_LIMITS.revisionMax)
		.optional(),
	lines: z.strictObject({
		start: z.number().int().min(1),
		end: z.number().int().min(1),
	}).optional(),
	gate: z.string().regex(SLOT_CTX_GATE_RE).optional(),
});
// The schema and the portable type describe the same object (compile time).
type SameShape<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false)
	: false;
type AssertTrue<T extends true> = T;
type SlotCtxHintMatchesSchema = AssertTrue<
	SameShape<z.infer<typeof SlotCtxHintSchema>, SlotCtxHint>
>;

export const ActionRequestSchema = z.strictObject({
	action: z.string().regex(/^[a-z0-9._-]{1,64}$/),
	payload: z.json().optional(),
	/** Hint only: the kernel re-derives and confines ctx server-side. */
	ctx: SlotCtxHintSchema.optional(),
});
export type ActionRequest = z.infer<typeof ActionRequestSchema>;
export type ActionResponse = ActionResult;

// ---------------------------------------------------------------------------
// Browse (WP3)
// ---------------------------------------------------------------------------

export type TreeResponse = {
	readonly repo: string;
	readonly ref: string;
	readonly sha: string;
	readonly path: string;
	readonly entries: readonly TreeEntry[];
};
export type BlobResponse = {
	readonly repo: string;
	readonly ref: string;
	readonly sha: string;
	readonly path: string;
	readonly blob: string;
	readonly size: number;
	readonly binary: boolean;
	/** UTF-8 text when not binary and ≤ the inline limit. */
	readonly text?: string;
	readonly truncated: boolean;
	/** `/-/raw/…` URL (served with CSP sandbox). */
	readonly rawUrl: string;
};
export type LogResponse = {
	readonly repo: string;
	readonly ref: string;
	readonly commits: readonly CommitMeta[];
	readonly cursor?: string;
};
export type CommitResponse = {
	readonly repo: string;
	readonly commit: CommitMeta;
	readonly files: readonly FileDiff[];
	readonly note?: WhyNote;
};
export type CompareResponse = {
	readonly repo: string;
	readonly base: string;
	readonly head: string;
	readonly mergeBase?: string;
	readonly commits: readonly CommitMeta[];
	readonly files: readonly FileDiff[];
	readonly truncated: boolean;
};
export type BlameResponse = {
	readonly repo: string;
	readonly sha: string;
	readonly path: string;
	readonly ranges: readonly BlameRange[];
	/** commit → why note (when landed through an Advance). */
	readonly notes: Readonly<Record<string, WhyNote>>;
};
export type WhyResponse = {
	readonly repo: string;
	readonly commit: string;
	readonly note: WhyNote | null;
	readonly events: readonly Envelope[];
	readonly chainVerified?: boolean;
};

// ---------------------------------------------------------------------------
// Lanes, runs, advances (WP5, WP9, WP10)
// ---------------------------------------------------------------------------

export type LaneDto = Lane;
export type LanesResponse = {
	readonly lanes: readonly LaneDto[];
	readonly cursor?: string;
};
export const LaneOpenRequestSchema = z.strictObject({
	repo: NodePathSchema,
	purpose: z.string().min(1).max(500),
	footprint: FootprintSchema.optional(),
});

const ATTIC_RETENTION_MAX_DAYS = ATTIC_RETENTION_MAX_MS / (24 * 60 * 60 * 1000);

/** `PUT /-/api/repos/<id>/lanes/settings` (WP5a, Owner). */
export const RepoLaneSettingsRequestSchema = z.strictObject({
	/** The per-repo override of `LANE_MODE` (`meta.lane_mode`); null clears it. */
	laneMode: LaneModeSchema.nullable().optional(),
	/** `meta.max_active_lanes` (default 200 on the repo backend, 2,000 on branch). */
	maxActiveLanes: z.number().int().min(1).max(10_000).optional(),
	/** `meta.attic_retention_ms`, in days (default 7). */
	atticRetentionDays: z.number().int().min(1).max(ATTIC_RETENTION_MAX_DAYS)
		.optional(),
});
export type RepoLaneSettingsRequest = z.infer<
	typeof RepoLaneSettingsRequestSchema
>;

/** `GET /-/api/repos/<id>/lanes/settings`. */
export type RepoLaneSettingsDto = {
	/** The configured mode: the repo's override, else the forge's `LANE_MODE`. */
	readonly laneMode: LaneMode;
	/** What new lanes try first now (the breaker may have degraded it). */
	readonly effectiveMode: LaneMode;
	/** Set while the lane-seed breaker holds the repo on a later mode. */
	readonly degradedUntil?: number;
	/** Set for 24 h after an import hit the size limit (`import` is skipped). */
	readonly importTooLargeUntil?: number;
	/** The trunk pack size estimate (`meta.trunk_pack_bytes`); null until measured. */
	readonly trunkPackBytes: number | null;
	readonly maxActiveLanes: number;
	readonly atticRetentionDays: number;
	/** Lane repos this repo retains (open, closed awaiting GC, attics). */
	readonly retainedLaneRepos: number;
	/** The forge-wide ceiling of retained lane repos (`MAX_LANE_REPOS_FORGE`). */
	readonly maxLaneReposForge: number;
};

export type RunDto = RunStatus;
export type RunsResponse = {
	readonly runs: readonly RunDto[];
	readonly cursor?: string;
};

// ---------------------------------------------------------------------------
// The global log (WP26): `/-/api/log/status` and `/-/api/log/dead`, forge
// Owner only. Ids, counts, states and codes; never a record's content.
// ---------------------------------------------------------------------------

/** `/-/health` `k2` and the status page's health. */
export const K2_HEALTH_STATES = [
	"ok",
	"degraded",
	"blocked",
	"produce-only",
	"off",
] as const;
export type K2Health = typeof K2_HEALTH_STATES[number];

export const RELAY_STATES = ["ok", "backoff", "blocked", "off"] as const;
export type RelayState = typeof RELAY_STATES[number];

/** One Durable Object's relay position into the stream. */
export type RelayStatus = {
	/** `repo:<ulid>` or `forge`. */
	readonly stream: string;
	readonly state: RelayState;
	readonly epoch: string;
	readonly head: number;
	readonly relayedSeq: number;
	/** `head − relayedSeq`. */
	readonly lag: number;
	/** `at` of the oldest unrelayed event, or null when caught up. */
	readonly oldestUnrelayedAt: number | null;
	readonly attempts: number;
	readonly nextAt: number | null;
	/** `K2 <code>` or `throw`; never a message body. */
	readonly lastError: string | null;
	readonly lastOkAt: number | null;
	readonly sentRecords: number;
	readonly sentBytes: number;
	readonly unknownOutcomes: number;
};

export type ConsumeState = "ok" | "off" | "error";

/** Dispatch counts by `via` for one hour (UTC, epoch ms of the hour start). */
export type ViaCounts = {
	readonly hour: number;
	readonly k2: number;
	readonly backstop: number;
	readonly local: number;
};

/** A relay lag the cron recorded (worst first). */
export type RelayLag = {
	readonly stream: string;
	readonly state: RelayState;
	readonly lag: number;
	readonly oldestUnrelayedAt: number | null;
};

/** The workloads consumer's state. */
export type BusStatus = {
	readonly group: string;
	readonly worker: number;
	readonly consume: ConsumeState;
	readonly subscription: string | null;
	readonly lastPollOkAt: number | null;
	/** `timestamp_ms` of the last record consumed. */
	readonly lastRecordAt: number | null;
	/** Consume time minus `timestamp_ms` of the last batch's last record. */
	readonly consumerLagMs: number | null;
	readonly records: number;
	readonly retry: number;
	readonly dead: number;
	readonly resubscribed: number;
	readonly lastError: string | null;
	readonly via: readonly ViaCounts[];
	readonly relayLags: readonly RelayLag[];
	readonly relayLagsAt: number | null;
};

/** A parked record (never its content). */
export type DeadRecordDto = {
	readonly id: string;
	readonly type: string | null;
	readonly error: string;
	readonly at: number;
};

/** `GET /-/api/log/status`. */
export type LogStatusResponse = {
	readonly label: "K2 (public beta)";
	readonly health: K2Health;
	/** The stage's maximum workload transport (`WORKLOAD_TRANSPORT` or its rendered override). */
	readonly transport: RunTransport;
	readonly stream: { readonly configured: boolean; readonly name: string };
	readonly relay: { readonly forge: RelayStatus | null };
	readonly consumer: BusStatus | null;
	/** Dispatch counts by via in the current and the previous clock hour. */
	readonly lastHour: {
		readonly k2: number;
		readonly backstop: number;
		readonly local: number;
	};
};

/** `GET /-/api/log/dead[?limit=&cursor=]`. */
export type LogDeadListResponse = {
	readonly dead: readonly DeadRecordDto[];
	readonly cursor?: string;
};
export type JobLogResponse = {
	readonly runId: string;
	readonly jobId: string;
	readonly text: string;
	readonly truncated: boolean;
	readonly live: boolean;
};

export type AdvanceDto = Advance & {
	/**
	 * Written by the dev-only `seedHistory`, never by a real land. A
	 * seeded Advance ran no gates and has no hash-chain link (`chainSeq` and
	 * `chainHead` are absent), so a chain verifier skips it.
	 */
	readonly seeded?: true;
	readonly gateResults?: readonly {
		readonly ext: string;
		readonly decision: "allow" | "advise" | "veto";
		readonly mode: "enforce" | "shadow";
		readonly message?: string;
	}[];
	readonly chainSeq?: number;
	readonly chainHead?: string;
};
export type AdvancesResponse = {
	readonly advances: readonly AdvanceDto[];
	readonly cursor?: string;
};
export type LandBatchDto = LandStatus;

// ---------------------------------------------------------------------------
// Inbox (WP6)
// ---------------------------------------------------------------------------

export type InboxResponse = {
	readonly notices: readonly Notice[];
	readonly unread: number;
	/** The last returned notice's `seq`, or the request's `since` when empty. */
	readonly head: number;
};
/** `GET /-/api/inbox/peek` and `/-/api/inbox/wait`. */
export type InboxNoticesResponse = { readonly notices: readonly Notice[] };
export const InboxAckRequestSchema = z.strictObject({
	ids: z.array(z.string().max(64)).min(1).max(200),
});
/**
 * `POST /-/api/inbox/send`: `to` is a principal id or a handle; `body` is at
 * most 2 KB of UTF-8, rejected (never truncated) above that by the handler.
 */
export const InboxSendRequestSchema = z.strictObject({
	to: z.string().min(1).max(64),
	body: z.string().min(1).max(8192),
	repo: z.string(),
	laneId: z.string().optional(),
});
export type InboxSendRequest = z.infer<typeof InboxSendRequestSchema>;

// ---------------------------------------------------------------------------
// Events and audit (WP6)
// ---------------------------------------------------------------------------

/** `GET /-/api/events?repo=…`. */
export type EventsResponse = {
	readonly repo: string;
	readonly events: readonly Envelope[];
	readonly head: number;
};
/** `GET /-/api/events?stream=forge` (forge Owner). */
export type ForgeEventsResponse = {
	readonly stream: "forge";
	readonly events: readonly Envelope[];
	readonly head: number;
};
/** `GET /-/api/events?repo=…&verify=1&from&to`. */
export type ChainVerifyResponse = {
	readonly repo: string;
	readonly from: number;
	readonly to: number;
	readonly head: number;
	readonly ok: boolean;
	readonly brokenAt?: number;
};
/** One audit entry as served (the ForgeDO `audit` row). */
export type AuditEntryDto = {
	readonly seq: number;
	readonly at: number;
	readonly principal_id: string;
	readonly via_installation: string | null;
	readonly action: string;
	readonly target: string | null;
	readonly data_json: string | null;
};
/** `GET /-/api/audit` (forge Owner). */
export type AuditResponse = { readonly entries: readonly AuditEntryDto[] };

// ---------------------------------------------------------------------------
// Packages and installations (WP7a)
// ---------------------------------------------------------------------------

export type PackageDto = {
	readonly extId: string;
	readonly version: string;
	readonly runtime: "builtin" | "js" | "wasm";
	readonly manifest: Manifest;
	readonly sha256: string;
	readonly publishedBy: string;
	readonly publishedAt: number;
	readonly bundled: boolean;
};

export type InstallationDto = {
	readonly id: string;
	readonly extId: string;
	readonly version: string;
	readonly nodeId: string;
	readonly nodePath: string;
	readonly mode: InstallationMode;
	readonly storageScope: "node" | "repo";
	readonly runtimeOverride?: "builtin" | "js" | "wasm";
	readonly config: unknown;
	/** Approved permissions. */
	readonly grants: Manifest["permissions"];
	readonly backgroundRole: 10 | 20 | 30 | 40;
	readonly locked: boolean;
	readonly backfill: "none" | "30d" | "all";
	readonly pack?: string;
	readonly installedBy: string;
	readonly installedAt: number;
	readonly modeChangedAt?: number;
	/**
	 * Repository config: present only for a `repo-config` installation
	 * (made from the root package `tartan` on trunk), with the trunk commit it came
	 * from; its settings form is read-only.
	 */
	readonly source?: "repo-config";
	readonly sourceSha?: string;
	/** An Owner disabled this repo-config installation; reconcile keeps it disabled. */
	readonly ownerDisabled?: boolean;
	/** The Owner's opt-in: repositories below may overlay `config.repoOverridable` keys. */
	readonly repoOverrides?: boolean;
};

/** An installation in force at a node with its manifest. */
export type InstallationInForce = {
	readonly installation: InstallationDto;
	readonly manifest: Manifest;
	/** Depth of the installing node (nearest first when sorted descending). */
	readonly depth: number;
};

/** A package-relative path: no leading `/`, no `.` or `..` segment (WP7a). */
export const PACKAGE_PATH_RE =
	/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/-]{1,200}$/;
/**
 * `POST /-/api/packages`: the manifest (validated against `manifest-1.json`
 * and the third-party policy by the handler) and the files, base64 by path.
 */
export const PackagePublishRequestSchema = z.strictObject({
	manifest: z.record(z.string(), z.unknown()),
	files: z.record(z.string().regex(PACKAGE_PATH_RE), z.base64()),
});
export type PackagePublishRequest = z.infer<typeof PackagePublishRequestSchema>;
/** `GET /-/api/packages`. */
export type PackagesResponse = { readonly packages: readonly PackageDto[] };
/** `GET /-/api/installations?node=…`: the node and what is in force there. */
export type InstallationsResponse = {
	readonly node: NodeDto;
	readonly installations: readonly InstallationInForce[];
};

export const InstallRequestSchema = z.strictObject({
	extId: z.string().max(64),
	version: z.string().max(64),
	node: NodePathSchema,
	mode: z.enum(["enforce", "shadow"]),
	config: z.record(z.string(), z.json()).optional(),
	backgroundRole: z.union([
		z.literal(10),
		z.literal(20),
		z.literal(30),
		z.literal(40),
	])
		.optional(),
	/** Owner only. */
	locked: z.boolean().optional(),
	backfill: z.enum(["none", "30d", "all"]).optional(),
	/**
	 * WP7a rejects `builtin` for a package that is not bundled, and an install
	 * whose exposed tool names collide with tools already in force at the
	 * node.
	 */
	runtimeOverride: z.enum(["builtin", "js", "wasm"]).optional(),
});
export type InstallRequest = z.infer<typeof InstallRequestSchema>;

export const ModeChangeRequestSchema = z.strictObject({
	mode: InstallationModeSchema,
});

/**
 * `POST /-/api/installations/replace` (and `RegistryFacade.replaceProvider`):
 * an Owner swaps the provider of one single-provider interface at a node, e.g.
 * `queue@1` Weave → FIFO on a repo.
 */
export const ReplaceProviderRequestSchema = z.strictObject({
	/** The node whose provider changes (its subtree follows). */
	node: NodePathSchema,
	/** A single-provider interface, e.g. `queue@1`. */
	iface: z.enum(PROVIDABLE_INTERFACES),
	/** The extension that provides `iface` here afterwards. */
	extId: z.string().max(64),
	version: z.string().max(64),
	/** Config of a new installation (ignored when one is re-enabled or inherited). */
	config: z.record(z.string(), z.json()).optional(),
	backgroundRole: z.union([
		z.literal(10),
		z.literal(20),
		z.literal(30),
		z.literal(40),
	]).optional(),
	/** Answer the plan without applying it (the swap sheet). */
	dryRun: z.boolean().optional(),
});
export type ReplaceProviderRequest = z.infer<
	typeof ReplaceProviderRequestSchema
>;

/** One step of a swap. */
export type ReplaceStep =
	| { readonly kind: "disable"; readonly installation: InstallationDto }
	| { readonly kind: "enable"; readonly installation: InstallationDto }
	| {
		readonly kind: "install";
		readonly extId: string;
		readonly version: string;
		readonly nodeId: string;
	}
	| { readonly kind: "inherit"; readonly installation: InstallationDto };

/** What a swap did (or, with `dryRun`, would do). */
export type ReplaceProviderResponse = {
	readonly iface: string;
	readonly node: string;
	readonly dryRun: boolean;
	/** The provider before the swap, if any. */
	readonly from: InstallationDto | null;
	/** The provider after it (null only in a dry run that installs). */
	readonly provider: InstallationDto | null;
	readonly steps: readonly ReplaceStep[];
	/** The install sheet's lines for the new provider. */
	readonly lines: readonly string[];
	readonly needsOwner: boolean;
};

/** The install sheet shown before approval. */
export type PermissionSheet = {
	readonly lines: readonly string[];
	readonly replaces?: {
		readonly iface: string;
		readonly installation: string;
		readonly ext: string;
		readonly node: string;
	};
	readonly needsOwner: boolean;
	readonly warnings: readonly string[];
};

export type GateReplayResponse = {
	readonly replayId: string;
	readonly state: "running" | "done" | "error";
	readonly results: readonly {
		readonly advanceId: string;
		readonly decision: "allow" | "advise" | "veto";
		readonly message: string;
	}[];
	/** "would have vetoed 2 of the last 41 advances". */
	readonly summary?: { readonly vetoed: number; readonly of: number };
};

export type CompareResponseDto = {
	readonly live: {
		readonly installation: string;
		readonly decisions: number;
		readonly vetoes: number;
	};
	readonly shadow: {
		readonly installation: string;
		readonly decisions: number;
		readonly vetoes: number;
	};
	readonly disagreements: readonly {
		readonly eventId: string;
		readonly live: string;
		readonly shadow: string;
	}[];
};

// ---------------------------------------------------------------------------
// Agents and tokens (WP2)
// ---------------------------------------------------------------------------

export const AGENT_TOOLS = [
	"claude-code",
	"codex",
	"opencode",
	"other",
] as const;

export const AgentCreateRequestSchema = z.strictObject({
	name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
	tool: z.enum(AGENT_TOOLS),
	model: z.string().max(80).optional(),
	node: NodePathSchema,
	maxRole: RoleSchema.default(30),
	ttlDays: z.number().int().min(1).max(30).default(7),
	scopes: z.array(TokenScopeSchema).optional(),
});
export type AgentCreateRequest = z.input<typeof AgentCreateRequestSchema>;

export type AgentDto = {
	readonly id: string;
	readonly handle: string;
	readonly display: string;
	readonly tool?: string;
	readonly model?: string;
	readonly ownerUserId: string;
	readonly createdAt: number;
	readonly disabled: boolean;
	readonly tokens: readonly {
		readonly id: string;
		readonly nodePath?: string;
		readonly maxRole: Role;
		readonly expiresAt: number;
		readonly lastUsedAt?: number;
		readonly revoked: boolean;
	}[];
};
/** `GET /-/api/agents` (WP2). */
export type AgentsResponse = { readonly agents: readonly AgentDto[] };

export type AgentCreatedResponse = {
	readonly agent: AgentDto;
	/** Shown once. */
	readonly token: string;
	readonly snippets: {
		readonly claudeCode: string;
		readonly codex: string;
		readonly gitCredential: string;
	};
};

export const PatCreateRequestSchema = z.strictObject({
	name: z.string().min(1).max(80),
	scopes: z.array(TokenScopeSchema).min(1),
	node: NodePathSchema.optional(),
	maxRole: RoleSchema.optional(),
	/** Mandatory, ≤ 1 year. */
	expiresInDays: z.number().int().min(1).max(365),
});

/** Dev-only: `TARTAN_STAGE ^dev` and `TARTAN_DEV_TOOLS=1`, else 404. */
export const BulkAgentsRequestSchema = z.strictObject({
	count: z.number().int().min(1).max(1000),
	prefix: z.string().regex(/^[a-z0-9-]{1,20}$/),
	node: NodePathSchema,
	maxRole: RoleSchema.default(30),
	ttlDays: z.number().int().min(1).max(7).default(1),
});

// ---------------------------------------------------------------------------
// Swarm (dev-only)
// ---------------------------------------------------------------------------

export const SwarmRequestSchema = z.strictObject({
	repo: NodePathSchema,
	agents: z.number().int().min(1).max(1000),
	workItems: z.number().int().min(1).max(5000),
	overlap: z.number().min(0).max(1).default(0.15),
	hotFiles: z.number().int().min(0).max(100).default(5),
	minutes: z.number().int().min(1).max(60),
});
export type SwarmRequest = z.infer<typeof SwarmRequestSchema>;

export type SwarmStatus = {
	readonly id: string;
	readonly state: "planning" | "running" | "stopping" | "done" | "error";
	readonly agents: number;
	readonly cohorts: number;
	readonly pushes: number;
	readonly errors: number;
	readonly startedAt: number;
	readonly endsAt: number;
};

// ---------------------------------------------------------------------------
// Live feed (`/-/live?repo=<id>&since=<seq>`)
// ---------------------------------------------------------------------------

export const LIVE_REPLAY_MAX = 500;
export const LIVE_COALESCE_MS = 250;

export type LiveFrame =
	| { readonly t: "hello"; readonly repo: string; readonly head: number }
	| {
		readonly t: "events";
		readonly events: readonly Envelope[];
		readonly head: number;
	}
	| { readonly t: "gap"; readonly from: number; readonly to: number }
	| { readonly t: "ping" };

export const LiveQuerySchema = z.strictObject({
	repo: UlidSchema,
	since: z.coerce.number().int().nonnegative().optional(),
});

// ---------------------------------------------------------------------------
// Projects (WP25 slice A′): `GET /-/api/repos/<repoId>/projects[/<project>[/issues|/changes]]`
// ---------------------------------------------------------------------------

export type ProjectIssueDto = {
	readonly code: string;
	readonly path?: string;
	readonly message: string;
};

export type ProjectLayerDto = {
	/** The `#Base` directory ("" is the repo root). */
	readonly root: string;
	/** `.cue` paths under it outside every project root. */
	readonly paths: readonly string[];
};

export type ProjectDto = {
	/** The root: the stable key (storage, footprints, installations later). */
	readonly key: string;
	/** Unique in the graph (cuenv names carry `@<root slug>` on a duplicate). */
	readonly name: string;
	/** The URL segment of `/<repo>/-/p/<slug>`. */
	readonly slug: string;
	readonly root: string;
	/** The raw cuenv name when `name` carries a uniqueness suffix. */
	readonly cuenvName?: string;
	/** `cuenv`, `tartan-config`, `pnpm-workspace`, `npm-workspaces`, … */
	readonly source: string;
	readonly nameSource?: "literal" | "manifest" | "unresolved";
	readonly fidelity?: "scan" | "eval";
	/** `#Base` directories above the root, root first. */
	readonly layers: readonly string[];
	/** Names of the projects this one depends on (lifted workspace edges). */
	readonly deps: readonly string[];
	readonly dependents: readonly string[];
	/** A change to it is global (every project is affected). */
	readonly manifestPath?: string;
	readonly issues: readonly ProjectIssueDto[];
};

export type ProjectsRepoDto = { readonly id: string; readonly path: string };

/** `GET /-/api/repos/<repoId>/projects[?sha=]`: the graph at the trunk tip (or a trunk commit). */
export type ProjectsResponse = {
	readonly repo: ProjectsRepoDto;
	/** The commit the graph is at; null for a repo without commits. */
	readonly sha: string | null;
	/** `cuenv` (the scan), `config` (package tartan's `projects`), `workspaces`. */
	readonly detector: "cuenv" | "config" | "workspaces" | null;
	readonly fidelity: "scan" | "eval" | "exact" | null;
	readonly projects: readonly ProjectDto[];
	readonly layers: readonly ProjectLayerDto[];
	/** Nested CUE modules and walk limits (`depth-limit`, `dir-limit`, `project-limit`). */
	readonly skipped: readonly string[];
	readonly warnings: readonly ProjectIssueDto[];
	/** A walk limit was hit: every change counts as touching every project. */
	readonly truncated: boolean;
	/** A root `env.cue` with `#Project` names the repository itself. */
	readonly rootProject?: { readonly name: string };
	/** Global file globs: a change to one affects every project. */
	readonly global: readonly string[];
};

export type ProjectRefDto = {
	readonly name: string;
	readonly slug: string;
	readonly root: string;
};

/** `GET /-/api/repos/<repoId>/projects/<slug>`. */
export type ProjectDetailResponse = {
	readonly repo: ProjectsRepoDto;
	readonly sha: string;
	readonly detector: ProjectsResponse["detector"];
	readonly fidelity: ProjectsResponse["fidelity"];
	readonly project: ProjectDto;
	/** The project's layers, root first, with their `.cue` paths. */
	readonly layers: readonly ProjectLayerDto[];
	readonly deps: readonly ProjectRefDto[];
	readonly dependents: readonly ProjectRefDto[];
	/** The first of `README.md`, `readme.md`, `README` in the root (text, capped). */
	readonly readme?: {
		readonly path: string;
		readonly text: string;
		readonly truncated: boolean;
	};
	/** The nearest `AGENTS.md` or `CLAUDE.md` at or above the root. */
	readonly agentsDoc?: { readonly path: string };
	/** Projects in the graph (for the "N of M" captions). */
	readonly total: number;
};

/** One work item of the project's Issues (a `work_list` item, reduced). */
export type ProjectWorkItemDto = {
	readonly ref: string;
	readonly kind: string;
	readonly title: string;
	readonly state: string;
	readonly labels: readonly string[];
	readonly priority: number;
	readonly footprint: {
		readonly projects: readonly string[];
		readonly prefixes: readonly string[];
	};
	/** Live claims (agents working on it). */
	readonly claims: number;
	/** Why it is listed: its footprint names the project, or a footprint prefix lies in its root. */
	readonly matched: "project" | "prefix";
};

/** One change of the project's Pull requests (a `changes_list` change, reduced). */
export type ProjectChangeDto = {
	readonly changeId: string;
	readonly title: string;
	readonly state: string;
	readonly workRef?: string;
	readonly laneId: string;
	readonly author: string;
	/** The latest revision's number (0 for a draft never submitted). */
	readonly revision: number;
	/** The latest revision's affected set (`*` when a global file changed). */
	readonly affected: readonly string[];
	/** Listed because a global file changed (every project is affected). */
	readonly global: boolean;
	readonly at?: number;
};

type Listing = {
	readonly repo: ProjectsRepoDto;
	readonly project: ProjectRefDto;
	/** The extension answering (`work@1` / `changes@1` provider), or null when none is in force. */
	readonly provider: string | null;
	/** Items the tool returned and the filter read. */
	readonly scanned: number;
	/** False when the scan stopped at its page limit. */
	readonly complete: boolean;
};

/** `GET …/projects/<slug>/issues[?state=]`: `work_list` filtered by footprint. */
export type ProjectIssuesResponse = Listing & {
	readonly items: readonly ProjectWorkItemDto[];
};

/** `GET …/projects/<slug>/changes[?state=]`: `changes_list` filtered by affected set. */
export type ProjectChangesResponse = Listing & {
	readonly changes: readonly ProjectChangeDto[];
};
