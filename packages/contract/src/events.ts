// Events: the envelope and every kernel event (K3, K10).
//
// `EnvelopeSchema` is the generic envelope (data unchecked); `schema/envelope-1.json`
// is generated from it. `KernelEventSchema` is a discriminated union on `type`
// over every kernel event. Interface events (`work.*`, `changes.*`, …)
// are validated against `interfaces.ts`; extension-private events are
// `x.<extId>.<name>` with free-form data.

import { z } from "zod";
import {
	ActorSchema,
	EntityRefSchema,
	FootprintSchema,
	InstallationIdSchema,
	InstallationModeSchema,
	LaneIdSchema,
	NodeKindSchema,
	NodePathSchema,
	PrincipalIdSchema,
	RefNameSchema,
	Sha256HexSchema,
	ShaSchema,
	StreamRefSchema,
	UlidSchema,
} from "./common.ts";
import {
	INTERFACE_EVENT_SCHEMAS,
	interfaceOfEventType,
	INTERFACES,
} from "./interfaces.ts";
import { ConflictRegionSchema } from "./git.ts";
import {
	isLanePlatformFault,
	LANE_PLATFORM_FAULT_CODES,
	LaneBackendNameSchema,
	LaneModeSchema,
	LaneOpSchema,
	LaneSeedFailCodeSchema,
	LaneSeedSchema,
} from "./lanes.ts";
import { LANE_SEED_MAX_ATTEMPTS } from "./ids.ts";
import { CueEvalErrorCodeSchema } from "./repoconfig.ts";

export const MAX_EVENT_DEPTH = 8;
export const EVENT_DATA_MAX_BYTES = 16 * 1024;
export const PUSH_COMMITS_MAX = 20;
export const PUSH_PATHS_MAX = 2000;

/**
 * `a.b`, `extension.mode.changed`, `x.tartan.radar.notice`, `lane.seed_failed`.
 * The namespace has no `_`; later segments may (the kernel names
 * `lane.seed_failed` and `lane.mode_degraded`). Extension event names stay
 * `[a-z0-9-]+` (`EXT_EVENT_NAME_RE`).
 */
export const EVENT_TYPE_RE = /^[a-z0-9-]+(\.[a-z0-9_-]+)+$/;
/** Subscription / `events.read` pattern: exact type, `ns.*`, or `*`. */
export const EVENT_PATTERN_RE = /^([a-z0-9_-]+\.)*([a-z0-9_-]+|\*)$/;

export const EventTypeSchema = z.string().max(128).regex(EVENT_TYPE_RE);

/** Kernel-reserved namespaces plus `job` (`job.*` events are kernel events). */
export const KERNEL_NAMESPACES = [
	"node",
	"principal",
	"repo",
	"push",
	"ref",
	"lane",
	"land",
	"advance",
	"run",
	"job",
	"gate",
	"presence",
	"extension",
] as const;

export const EventSourceSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("kernel") }),
	z.strictObject({
		kind: z.literal("installation"),
		id: InstallationIdSchema,
		/** `<extId>@<version>`. */
		ext: z.string().max(128),
	}),
]);
export type EventSource = z.infer<typeof EventSourceSchema>;

const envelopeShape = {
	id: UlidSchema,
	seq: z.number().int().nonnegative(),
	stream: StreamRefSchema,
	type: EventTypeSchema,
	v: z.number().int().min(1),
	source: EventSourceSchema,
	actor: ActorSchema,
	/** Node the event belongs to (the repo node for repo streams). */
	node: UlidSchema,
	repo: UlidSchema.optional(),
	subject: EntityRefSchema.optional(),
	causedBy: UlidSchema.optional(),
	correlation: z.string().max(256).optional(),
	depth: z.number().int().min(0).max(MAX_EVENT_DEPTH),
	shadow: z.boolean(),
	/** Emitted for a simulated agent (24 h retention). */
	sim: z.boolean().optional(),
	at: z.number().int().nonnegative(),
	/** Hash-chain position (repo streams only). */
	hash: Sha256HexSchema.optional(),
	data: z.unknown(),
};

/** Generic envelope as delivered to consumers (`events.read`, drains, `/-/live`). */
export const EnvelopeSchema = z.strictObject(envelopeShape);
export type Envelope<T = unknown> =
	& Omit<z.infer<typeof EnvelopeSchema>, "data">
	& {
		readonly data: T;
	};

// ---------------------------------------------------------------------------
// Kernel event payloads
// ---------------------------------------------------------------------------

const NodeEventData = z.strictObject({
	nodeId: UlidSchema,
	kind: NodeKindSchema,
	path: NodePathSchema,
	oldPath: NodePathSchema.optional(),
});
const PrincipalEventData = z.strictObject({
	principalId: PrincipalIdSchema,
	kind: z.enum(["user", "agent", "ext", "system"]),
	handle: z.string().max(64),
});
const ExtensionEventData = z.strictObject({
	inst: InstallationIdSchema,
	ext: z.string().max(64),
	version: z.string().max(64),
	node: UlidSchema,
	mode: InstallationModeSchema,
	/**
	 * `repo-config` when repository config made the change (absent: a manual
	 * install, `manual`), with its provenance: the trunk commit, the
	 * input key, the trunk position and where the evaluation first ran.
	 */
	source: z.enum(["manual", "repo-config"]).optional(),
	sha: ShaSchema.optional(),
	inputKey: Sha256HexSchema.optional(),
	trunkSeq: z.number().int().nonnegative().optional(),
	firstSha: ShaSchema.optional(),
	firstLane: LaneIdSchema.optional(),
	evaluator: z.string().max(128).optional(),
	cueVersion: z.string().max(64).nullable().optional(),
	/** `extension.configured` of an overlay: the repo node whose settings changed. */
	repoNode: UlidSchema.optional(),
	/** `extension.configured`: the settings keys that changed. */
	keys: z.array(z.string().max(64)).max(64).optional(),
});
const ExtensionErrorData = z.strictObject({
	inst: InstallationIdSchema,
	eventId: UlidSchema.optional(),
	error: z.string().max(2000),
	attempts: z.number().int().nonnegative(),
	/** The installation's circuit breaker after this error. */
	breaker: z.enum(["open", "half-open", "closed"]).optional(),
});
const RepoEventData = z.strictObject({
	repoId: UlidSchema,
	path: NodePathSchema,
	artifactsName: z.string().max(64),
	/**
	 * Where the repo came from, redacted (`redactSecrets`; origin and path
	 * only, no query or userinfo), or `"import-mode"` for an Owner push
	 * import. Never a capability URL. Lane repos emit no `repo.*` event.
	 */
	source: z.string().max(2048).optional(),
});

const PushTargetSchema = z.union([z.literal("repo"), LaneIdSchema]);
const PushViaSchema = z.enum([
	"gateway",
	"trigger",
	"kernel",
	"swarm",
	"reconcile",
]);
const PushIdSchema = z.string().min(1).max(64);
const DiffCommitSchema = z.strictObject({
	sha: ShaSchema,
	subject: z.string().max(500),
	trailers: z.array(z.strictObject({ key: z.string(), value: z.string() })),
	/** The first principal to push this commit anywhere in the repo family (`commit_firsts`); null when only the trigger saw it. */
	firstPushedBy: PrincipalIdSchema.nullable(),
});
/**
 * Phase 1 of push recording: I/O-free, no paths or commits. For a
 * `repo` lane `target` is the lane and `ref` is `refs/heads/main` of its lane
 * repo.
 */
const PushAcceptedData = z.strictObject({
	pushId: PushIdSchema,
	target: PushTargetSchema,
	ref: RefNameSchema,
	before: ShaSchema,
	after: ShaSchema,
	via: PushViaSchema,
});
/** Phase 2: the shared lane-range diff `rangeBase..after` (K17). */
const PushDiffedData = z.strictObject({
	pushId: PushIdSchema,
	target: PushTargetSchema,
	ref: RefNameSchema,
	after: ShaSchema,
	rangeBase: ShaSchema,
	rangeTruncated: z.boolean(),
	commits: z.array(DiffCommitSchema).max(PUSH_COMMITS_MAX),
	paths: z.array(z.string()).max(PUSH_PATHS_MAX),
	truncated: z.boolean(),
	/** R2 key of the shared diff: `diffs/<repoId>/<rangeBase>..<after>.json`. */
	diffKey: z.string().max(512),
});
const PushRejectedData = z.strictObject({
	target: PushTargetSchema,
	refs: z.array(RefNameSchema),
	reason: z.string().max(500),
});
/**
 * K1 (a protected or kernel ref) or, with `laneId`, K2 (a lane head or any
 * ref of a lane repo: the lane is quarantined).
 */
const RefTamperedData = z.strictObject({
	/** The repo the ref lives in: `"repo"` (canonical) or a lane id (its lane repo). */
	target: PushTargetSchema,
	ref: RefNameSchema,
	before: ShaSchema,
	after: ShaSchema,
	source: z.enum(["trigger", "reconcile"]),
	parkedAt: z.number().int(),
	laneId: LaneIdSchema.optional(),
});
/**
 * An Owner acknowledged a K1 or K2 alarm (K3: the acknowledgement is a
 * kernel state change, so it is an event; the envelope's `actor` is the
 * Owner). With `laneId` (K2): that lane's quarantine was cleared. Without
 * (K1): the observed values of `refs` were adopted into the index (empty when
 * nothing was tampered) and landing resumed, unless `landingPaused` (another
 * tampered ref was raised meanwhile and still waits for an acknowledgement).
 */
const RefAcknowledgedData = z.strictObject({
	refs: z.array(RefNameSchema).max(1000).optional(),
	laneId: LaneIdSchema.optional(),
	landingPaused: z.boolean().optional(),
});
const RefReconciledData = z.strictObject({
	ref: RefNameSchema,
	indexSha: ShaSchema.nullable(),
	remoteSha: ShaSchema.nullable(),
	matched: z.boolean(),
});
/** `lane.opening/opened/closed/lost/archived/synced/restacked/delegated/deleted`. */
const LaneEventData = z.strictObject({
	laneId: LaneIdSchema,
	entity: EntityRefSchema.optional(),
	owner: PrincipalIdSchema,
	base: ShaSchema,
	head: ShaSchema.optional(),
	footprint: FootprintSchema.optional(),
	/** The backend in use (`lane.opened` on a later backend after a fallback). */
	mode: LaneBackendNameSchema,
	seed: LaneSeedSchema.optional(),
	/** Open → verified (`lane.opened` of a `repo` lane). */
	seedMs: z.number().int().nonnegative().optional(),
	/** `"cancelled"` on the `lane.closed` of a lane closed while `opening`. */
	seedCode: LaneSeedFailCodeSchema.optional(),
	reason: z.string().max(500).optional(),
	/** `branch` backend: the attic ref an archive wrote. */
	atticRef: RefNameSchema.optional(),
	/** `repo` backend: the archived lane repo's head and when it is deleted. */
	atticHead: ShaSchema.optional(),
	atticUntil: z.number().int().optional(),
	delegates: z.array(PrincipalIdSchema).optional(),
});
/** One failed seed attempt. */
const LaneSeedFailedData = z.strictObject({
	laneId: LaneIdSchema,
	seed: LaneSeedSchema,
	code: LaneSeedFailCodeSchema,
	attempt: z.number().int().min(1).max(LANE_SEED_MAX_ATTEMPTS),
	/** What the lane tries next. */
	next: LaneModeSchema,
	/** True exactly for the platform-side codes (`LANE_PLATFORM_FAULT_CODES`). */
	platformFault: z.boolean(),
}).superRefine((d, ctx) => {
	if (d.code === "cancelled") {
		ctx.addIssue({
			code: "custom",
			message: "cancelled is carried by lane.closed.seedCode, not seed_failed",
			path: ["code"],
		});
	}
	if (d.platformFault !== isLanePlatformFault(d.code)) {
		ctx.addIssue({
			code: "custom",
			message: `platformFault must be ${
				isLanePlatformFault(d.code)
			} for ${d.code}`,
			path: ["platformFault"],
		});
	}
});
/**
 * The lane-seed breaker moved the repo to the next mode until `until`. Each
 * strike is a different lane that fell back for a platform-side reason,
 * never an attempt.
 */
const LaneModeDegradedData = z.strictObject({
	from: LaneModeSchema,
	to: LaneModeSchema,
	until: z.number().int(),
	strikes: z.array(z.strictObject({
		at: z.number().int(),
		laneId: LaneIdSchema,
		code: z.enum(LANE_PLATFORM_FAULT_CODES),
	})).min(1),
});
/** K16 refused a lane operation. */
const LaneDeniedData = z.strictObject({
	laneId: LaneIdSchema.optional(),
	op: LaneOpSchema,
	actor: PrincipalIdSchema,
	reason: z.string().max(500),
});

const BatchAttempt = {
	batchId: z.string().max(64),
	attempt: z.number().int().min(1),
};
const LandSubmittedData = z.strictObject({
	...BatchAttempt,
	ref: RefNameSchema,
	changes: z.array(z.strictObject({
		changeId: z.string(),
		laneId: LaneIdSchema,
		head: ShaSchema,
	})),
	reasonEvents: z.array(UlidSchema),
	requestedBy: z.string(),
	testPolicy: z.enum(["checks", "none"]),
	partitionKey: z.string().optional(),
});
const LandConflictedData = z.strictObject({
	...BatchAttempt,
	changeId: z.string(),
	paths: z.array(z.string()),
	regions: z.array(z.strictObject({
		path: z.string(),
		regions: z.array(ConflictRegionSchema),
	})).optional(),
	conflictsWith: z.array(z.string()),
});
const LandVetoedData = z.strictObject({
	...BatchAttempt,
	changeId: z.string(),
	inst: InstallationIdSchema,
	ext: z.string().optional(),
	message: z.string().max(2000),
	/**
	 * A kernel ejection (K13.2, K13.3; `inst` is the zero installation):
	 * the change touched a policy path without a matching sign-off, a second
	 * policy-touching change shared its batch, or its candidate's root
	 * `*.cue` digest is not the one signed off.
	 */
	code: z.enum(["policy-signoff", "policy-batch", "config-plan-changed"])
		.optional(),
});
const LandTestingData = z.strictObject({
	...BatchAttempt,
	candidateSha: ShaSchema,
	base: ShaSchema,
	affected: z.array(z.string()),
});
const LandFailedData = z.strictObject({
	...BatchAttempt,
	reason: z.enum([
		"tests",
		"stale",
		"abandoned",
		"conflicted",
		"vetoed",
		"error",
		"trunk-unexplained",
		/**
		 * K9/K13.1: repository config held the batch past the hold's bound;
		 * the changes are back in the queue unchanged (never an ejection).
		 */
		"config-hold",
	]),
	failing: z.array(z.string()).optional(),
	message: z.string().max(2000).optional(),
});
const LandCompletedData = z.strictObject({
	...BatchAttempt,
	landed: z.array(z.strictObject({ changeId: z.string(), commit: ShaSchema })),
	conflicted: z.array(z.string()),
	vetoed: z.array(z.string()),
});
const AdvanceStaleData = z.strictObject({
	...BatchAttempt,
	expectOld: ShaSchema,
	actual: ShaSchema.nullable(),
});
const AdvanceReleasedData = z.strictObject({
	advanceId: z.string(),
	batchId: z.string(),
	reason: z.string().max(500),
});
const RefAdvancedData = z.strictObject({
	ref: RefNameSchema,
	old: ShaSchema,
	new: ShaSchema,
	advanceId: z.string(),
	changes: z.array(z.strictObject({
		changeId: z.string(),
		laneId: LaneIdSchema,
		commit: ShaSchema,
	})),
	reasonEvents: z.array(UlidSchema),
	evidenceReused: z.boolean(),
});
const RunEventData = z.strictObject({
	runId: z.string(),
	jobId: z.string().optional(),
	state: z.string(),
	project: z.string().optional(),
	durationMs: z.number().int().nonnegative().optional(),
	cached: z.boolean().optional(),
	subject: EntityRefSchema.optional(),
	/**
	 * The queued `run.started` (WP26): the run's kind, the transport it was
	 * given (`k2`: the global log's consumer dispatches it; `local`: inline)
	 * and why it exists. This record is the workload request.
	 */
	kind: z.enum(["ci", "git"]).optional(),
	transport: z.enum(["k2", "local"]).optional(),
	priority: z.enum(["land", "change", "push", "manual"]).optional(),
	/**
	 * `run.dispatched` (WP26): who created the Workflow instance, and the
	 * time from the run's creation to it.
	 */
	via: z.enum(["k2", "backstop", "local"]).optional(),
	lagMs: z.number().int().nonnegative().optional(),
});
const GateDecidedData = z.strictObject({
	point: z.enum(["ref.advance", "lane.open", "push"]),
	inst: InstallationIdSchema,
	ext: z.string(),
	decision: z.enum(["allow", "advise", "veto"]),
	mode: z.enum(["enforce", "shadow"]),
	message: z.string().max(2000),
	batchId: z.string().optional(),
	changeId: z.string().optional(),
	replay: z.boolean().optional(),
	truncated: z.boolean().optional(),
	/**
	 * The extension's own answer, or a kernel default (timeout, error,
	 * truncation). K4 counts only `answer` as a passing human-review
	 * gate.
	 */
	basis: z.enum(["answer", "default", "truncated"]).optional(),
});
const PresenceChangedData = z.strictObject({
	principal: PrincipalIdSchema,
	laneId: LaneIdSchema.optional(),
	status: z.string().max(64),
});

// Repository config (ADR repo config; K13.1–K13.3). Repo stream only.
const RepoConfigEvaluatingData = z.strictObject({
	sha: ShaSchema,
	cause: z.enum(["advance", "external", "registry", "apply", "reevaluate"]),
	trunkSeq: z.number().int().nonnegative(),
});
const RepoConfigEvaluatedData = z.strictObject({
	inputKey: Sha256HexSchema,
	sha: ShaSchema,
	origin: z.enum(["trunk", "preview"]),
	status: z.enum(["ok", "error"]),
	code: CueEvalErrorCodeSchema.optional(),
	evaluator: z.string().max(128),
	cueVersion: z.string().max(64).nullable(),
});
const RepoConfigAppliedData = z.strictObject({
	sha: ShaSchema,
	inputKey: Sha256HexSchema,
	trunkSeq: z.number().int().nonnegative(),
	epoch: z.number().int().nonnegative(),
	installed: z.number().int().nonnegative(),
	updated: z.number().int().nonnegative(),
	removed: z.number().int().nonnegative(),
	overlays: z.number().int().nonnegative(),
	principals: z.array(PrincipalIdSchema).max(32),
	/** Applied by a Maintainer's explicit apply (`needs-apply`). */
	explicit: z.boolean().optional(),
	/** Removal of the repository's config (no root `*.cue` file, or none in package `tartan`). */
	removal: z.boolean().optional(),
});
const RepoConfigFailedData = z.strictObject({
	sha: ShaSchema,
	inputKey: Sha256HexSchema.optional(),
	code: z.string().max(64),
	message: z.string().max(2000),
});
const RepoConfigPreviewedData = z.strictObject({
	laneId: LaneIdSchema,
	head: ShaSchema,
	inputKey: Sha256HexSchema.optional(),
	status: z.enum([
		"ok",
		"error",
		"denied",
		"unavailable",
		"rate_limited",
		"clean",
	]),
});
const RepoConfigNeedsApplyData = z.strictObject({
	sha: ShaSchema,
	inputKey: Sha256HexSchema.optional(),
	cause: z.enum([
		"repo.imported",
		"ref.acknowledged",
		"ref.reconciled",
		"repo.created",
		"removal",
		/** The switch went on over trunk config nobody signed. */
		"enabled",
	]),
});
/**
 * A trunk config history row was resolved (ADR repo config): repo policy at and
 * after `trunkSeq` now reads `status` (`tartan.ci` and `tartan.review` retry
 * a `pending` read on it).
 */
const RepoConfigResolvedData = z.strictObject({
	trunkSeq: z.number().int(),
	sha: ShaSchema,
	status: z.enum(["ok", "error", "none"]),
	inputKey: Sha256HexSchema.optional(),
});
const RepoConfigOverriddenData = z.strictObject({
	action: z.enum(["keep-last-good", "clear"]),
	sha: ShaSchema.optional(),
});
const RepoPolicyApprovedData = z.strictObject({
	laneId: LaneIdSchema,
	head: ShaSchema,
	/**
	 * sha256 of the sorted `[name, mode, oid]` of the root `*.cue` entries at
	 * `head` (ADR repo config), `null` when the head has none.
	 */
	policyDigest: Sha256HexSchema.nullable(),
	inputKey: Sha256HexSchema.optional(),
	resolvedHash: Sha256HexSchema.optional(),
});
const RepoPolicyRevokedData = z.strictObject({
	laneId: LaneIdSchema,
	head: ShaSchema,
	/** The `repo.policy.approved` event the revocation ends. */
	approval: UlidSchema,
});

/** Kernel event type → payload schema. */
export const KERNEL_EVENT_DATA = {
	"node.created": NodeEventData,
	"node.moved": NodeEventData,
	"node.archived": NodeEventData,
	"principal.created": PrincipalEventData,
	"principal.disabled": PrincipalEventData,
	"extension.installed": ExtensionEventData,
	"extension.upgraded": ExtensionEventData,
	"extension.mode.changed": ExtensionEventData,
	"extension.configured": ExtensionEventData,
	"extension.uninstalled": ExtensionEventData,
	"extension.error": ExtensionErrorData,
	"repo.created": RepoEventData,
	"repo.imported": RepoEventData,
	"repo.config.evaluating": RepoConfigEvaluatingData,
	"repo.config.evaluated": RepoConfigEvaluatedData,
	"repo.config.applied": RepoConfigAppliedData,
	"repo.config.failed": RepoConfigFailedData,
	"repo.config.previewed": RepoConfigPreviewedData,
	"repo.config.needs-apply": RepoConfigNeedsApplyData,
	"repo.config.resolved": RepoConfigResolvedData,
	"repo.config.overridden": RepoConfigOverriddenData,
	"repo.policy.approved": RepoPolicyApprovedData,
	"repo.policy.revoked": RepoPolicyRevokedData,
	"push.accepted": PushAcceptedData,
	"push.diffed": PushDiffedData,
	"push.rejected": PushRejectedData,
	"ref.tampered": RefTamperedData,
	"ref.acknowledged": RefAcknowledgedData,
	"ref.reconciled": RefReconciledData,
	"ref.advanced": RefAdvancedData,
	"lane.opening": LaneEventData,
	"lane.opened": LaneEventData,
	"lane.seed_failed": LaneSeedFailedData,
	"lane.mode_degraded": LaneModeDegradedData,
	"lane.closed": LaneEventData,
	"lane.lost": LaneEventData,
	"lane.archived": LaneEventData,
	"lane.synced": LaneEventData,
	"lane.restacked": LaneEventData,
	"lane.delegated": LaneEventData,
	"lane.deleted": LaneEventData,
	"lane.denied": LaneDeniedData,
	"land.submitted": LandSubmittedData,
	"land.conflicted": LandConflictedData,
	"land.vetoed": LandVetoedData,
	"land.testing": LandTestingData,
	"land.failed": LandFailedData,
	"land.completed": LandCompletedData,
	"advance.stale": AdvanceStaleData,
	"advance.released": AdvanceReleasedData,
	"run.started": RunEventData,
	"run.dispatched": RunEventData,
	"job.started": RunEventData,
	"job.completed": RunEventData,
	"run.completed": RunEventData,
	"gate.decided": GateDecidedData,
	"presence.changed": PresenceChangedData,
} as const;

export type KernelEventType = keyof typeof KERNEL_EVENT_DATA;
export const KERNEL_EVENT_TYPES = Object.keys(
	KERNEL_EVENT_DATA,
) as KernelEventType[];
export type KernelEventData<T extends KernelEventType> = z.infer<
	typeof KERNEL_EVENT_DATA[T]
>;

/** Which stream(s) carry each kernel event. */
export const KERNEL_EVENT_STREAMS: Readonly<
	Record<KernelEventType, "forge" | "repo" | "both">
> = {
	"node.created": "forge",
	"node.moved": "forge",
	"node.archived": "forge",
	"principal.created": "forge",
	"principal.disabled": "forge",
	"extension.installed": "forge",
	"extension.upgraded": "forge",
	"extension.mode.changed": "forge",
	"extension.configured": "forge",
	"extension.uninstalled": "forge",
	"extension.error": "both",
	"repo.created": "both",
	"repo.imported": "both",
	"repo.config.evaluating": "repo",
	"repo.config.evaluated": "repo",
	"repo.config.applied": "repo",
	"repo.config.failed": "repo",
	"repo.config.previewed": "repo",
	"repo.config.needs-apply": "repo",
	"repo.config.resolved": "repo",
	"repo.config.overridden": "repo",
	"repo.policy.approved": "repo",
	"repo.policy.revoked": "repo",
	"push.accepted": "repo",
	"push.diffed": "repo",
	"push.rejected": "repo",
	"ref.tampered": "repo",
	"ref.acknowledged": "repo",
	"ref.reconciled": "repo",
	"ref.advanced": "repo",
	"lane.opening": "repo",
	"lane.opened": "repo",
	"lane.seed_failed": "repo",
	"lane.mode_degraded": "repo",
	"lane.closed": "repo",
	"lane.lost": "repo",
	"lane.archived": "repo",
	"lane.synced": "repo",
	"lane.restacked": "repo",
	"lane.delegated": "repo",
	"lane.deleted": "repo",
	"lane.denied": "repo",
	"land.submitted": "repo",
	"land.conflicted": "repo",
	"land.vetoed": "repo",
	"land.testing": "repo",
	"land.failed": "repo",
	"land.completed": "repo",
	"advance.stale": "repo",
	"advance.released": "repo",
	"run.started": "repo",
	"run.dispatched": "repo",
	"job.started": "repo",
	"job.completed": "repo",
	"run.completed": "repo",
	"gate.decided": "repo",
	"presence.changed": "repo",
};

const kernelEvent = <T extends KernelEventType>(type: T) =>
	z.strictObject({
		...envelopeShape,
		type: z.literal(type),
		data: KERNEL_EVENT_DATA[type] as typeof KERNEL_EVENT_DATA[T],
	});

/** Discriminated union over every kernel event, envelope included. */
export const KernelEventSchema = z.discriminatedUnion("type", [
	kernelEvent("node.created"),
	kernelEvent("node.moved"),
	kernelEvent("node.archived"),
	kernelEvent("principal.created"),
	kernelEvent("principal.disabled"),
	kernelEvent("extension.installed"),
	kernelEvent("extension.upgraded"),
	kernelEvent("extension.mode.changed"),
	kernelEvent("extension.configured"),
	kernelEvent("extension.uninstalled"),
	kernelEvent("extension.error"),
	kernelEvent("repo.created"),
	kernelEvent("repo.imported"),
	kernelEvent("repo.config.evaluating"),
	kernelEvent("repo.config.evaluated"),
	kernelEvent("repo.config.applied"),
	kernelEvent("repo.config.failed"),
	kernelEvent("repo.config.previewed"),
	kernelEvent("repo.config.needs-apply"),
	kernelEvent("repo.config.resolved"),
	kernelEvent("repo.config.overridden"),
	kernelEvent("repo.policy.approved"),
	kernelEvent("repo.policy.revoked"),
	kernelEvent("push.accepted"),
	kernelEvent("push.diffed"),
	kernelEvent("push.rejected"),
	kernelEvent("ref.tampered"),
	kernelEvent("ref.acknowledged"),
	kernelEvent("ref.reconciled"),
	kernelEvent("ref.advanced"),
	kernelEvent("lane.opening"),
	kernelEvent("lane.opened"),
	kernelEvent("lane.seed_failed"),
	kernelEvent("lane.mode_degraded"),
	kernelEvent("lane.closed"),
	kernelEvent("lane.lost"),
	kernelEvent("lane.archived"),
	kernelEvent("lane.synced"),
	kernelEvent("lane.restacked"),
	kernelEvent("lane.delegated"),
	kernelEvent("lane.deleted"),
	kernelEvent("lane.denied"),
	kernelEvent("land.submitted"),
	kernelEvent("land.conflicted"),
	kernelEvent("land.vetoed"),
	kernelEvent("land.testing"),
	kernelEvent("land.failed"),
	kernelEvent("land.completed"),
	kernelEvent("advance.stale"),
	kernelEvent("advance.released"),
	kernelEvent("run.started"),
	kernelEvent("run.dispatched"),
	kernelEvent("job.started"),
	kernelEvent("job.completed"),
	kernelEvent("run.completed"),
	kernelEvent("gate.decided"),
	kernelEvent("presence.changed"),
]);
export type KernelEvent = z.infer<typeof KernelEventSchema>;

// ---------------------------------------------------------------------------
// Classification, matching, K10 and parsing
// ---------------------------------------------------------------------------

export const isKernelEventType = (type: string): type is KernelEventType =>
	Object.hasOwn(KERNEL_EVENT_DATA, type);

export const namespaceOf = (type: string): string => type.split(".")[0];

export const isKernelNamespace = (type: string): boolean =>
	(KERNEL_NAMESPACES as readonly string[]).includes(namespaceOf(type));

/** The `<name>` of `x.<extId>.<name>`: one segment. */
export const EXT_EVENT_NAME_RE = /^[a-z0-9-]+$/;

/**
 * `x.<extId>.<name>`: extension-private events. `<name>` is a single
 * segment, so `acme.a` cannot emit into `acme.a.b`'s `x.acme.a.b.*`
 * namespace (K10). Subscribers of a dotted prefix may still see a
 * longer id's events (`x.acme.a.*` matches `x.acme.a.b.evt`); consumers check
 * `envelope.source`.
 */
export const extensionEventPrefix = (extId: string): string => `x.${extId}.`;
export const isExtensionEventType = (type: string, extId?: string): boolean =>
	extId === undefined
		? type.startsWith("x.") && EVENT_TYPE_RE.test(type)
		: type.startsWith(extensionEventPrefix(extId)) &&
			EXT_EVENT_NAME_RE.test(type.slice(extensionEventPrefix(extId).length));

/** Exact type, `ns.*` (any depth below `ns`), or `*`. */
export const matchesEventPattern = (pattern: string, type: string): boolean => {
	if (pattern === "*") return true;
	if (pattern.endsWith(".*")) return type.startsWith(pattern.slice(0, -1));
	return pattern === type;
};
export const matchesAnyPattern = (
	patterns: readonly string[],
	type: string,
): boolean => patterns.some((p) => matchesEventPattern(p, type));

export type Producer =
	| { readonly kind: "kernel" }
	| {
		readonly kind: "installation";
		readonly extId: string;
		readonly provides: readonly string[];
	};

/**
 * K10: the kernel emits kernel types only; an installation emits its own
 * `x.<extId>.*` types and the events of interfaces it `provides`.
 */
export const mayEmit = (producer: Producer, type: string): boolean => {
	if (!EVENT_TYPE_RE.test(type)) return false;
	if (producer.kind === "kernel") return isKernelEventType(type);
	if (isExtensionEventType(type, producer.extId)) return true;
	const iface = interfaceOfEventType(type);
	return iface !== null && producer.provides.includes(iface);
};

export type ParsedEvent =
	| { readonly ok: true; readonly kind: "kernel"; readonly event: KernelEvent }
	| {
		readonly ok: true;
		readonly kind: "interface";
		readonly iface: string;
		readonly event: Envelope;
	}
	| { readonly ok: true; readonly kind: "extension"; readonly event: Envelope }
	| { readonly ok: false; readonly errors: readonly string[] };

const issues = (error: z.ZodError): string[] =>
	error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);

/**
 * Parses an envelope and validates its payload: kernel types against the
 * kernel union, interface types against their interface schema, `x.*` types
 * as free-form. Unknown types fail.
 */
export const parseEvent = (input: unknown): ParsedEvent => {
	const env = EnvelopeSchema.safeParse(input);
	if (!env.success) return { ok: false, errors: issues(env.error) };
	const type = env.data.type;
	if (isKernelEventType(type)) {
		const ev = KernelEventSchema.safeParse(input);
		return ev.success
			? { ok: true, kind: "kernel", event: ev.data }
			: { ok: false, errors: issues(ev.error) };
	}
	const iface = interfaceOfEventType(type);
	if (iface !== null) {
		const data = INTERFACE_EVENT_SCHEMAS[type].safeParse(env.data.data);
		return data.success
			? {
				ok: true,
				kind: "interface",
				iface,
				event: { ...env.data, data: data.data },
			}
			: { ok: false, errors: issues(data.error).map((e) => `data.${e}`) };
	}
	if (isExtensionEventType(type)) {
		return { ok: true, kind: "extension", event: env.data };
	}
	return { ok: false, errors: [`type: unknown event type ${type}`] };
};

/** Validates only an event payload (K10 at append time). */
export const validateEventData = (
	type: string,
	data: unknown,
): { ok: true; data: unknown } | { ok: false; errors: string[] } => {
	const schema = isKernelEventType(type)
		? KERNEL_EVENT_DATA[type]
		: INTERFACE_EVENT_SCHEMAS[type];
	if (!schema) {
		return isExtensionEventType(type)
			? { ok: true, data }
			: { ok: false, errors: [`unknown event type ${type}`] };
	}
	const r = schema.safeParse(data);
	return r.success
		? { ok: true, data: r.data }
		: { ok: false, errors: issues(r.error) };
};

/** What a producer hands to `appendSync` / `caps.events.emit`; the log assigns id, seq, hash, at. */
export type AppendInput = {
	readonly type: string;
	readonly v?: number;
	readonly source: EventSource;
	readonly actor: z.infer<typeof ActorSchema>;
	readonly node: string;
	readonly repo?: string;
	readonly subject?: z.infer<typeof EntityRefSchema>;
	readonly causedBy?: string;
	readonly correlation?: string;
	readonly depth: number;
	readonly shadow: boolean;
	readonly sim?: boolean;
	readonly data: unknown;
	/** Producer idempotency key (`eventIdemKey`). */
	readonly idemKey: string;
};

export type AppendResult = {
	readonly id: string;
	readonly seq: number;
	readonly hash: string;
	/** False when `idemKey` already existed (the existing event is returned). */
	readonly created: boolean;
};

/** Events every interface defines, for docs and UI (`work.*` …). */
export const INTERFACE_EVENT_TYPES: readonly string[] = Object.values(
	INTERFACES,
)
	.flatMap((def) => Object.keys(def.events));
