// RepoDO (`repo:<repoUlid>`): row types for every table of RepoDO
// and the facade + internal APIs of its modules. The DO exposes `core()`,
// `events()`, `probe()`, `runs()`, `land()` and `repoconfig()` (repository
// config in CUE, WP23; ADR repo config).

import type {
	AdvancesResponse,
	ImportCompleteRequest,
	ImportCompleteResponse,
	RepoLaneSettingsDto,
	RepoLaneSettingsRequest,
} from "../api.ts";
import type {
	Actor,
	ActorBounds,
	EntityRef,
	Footprint,
	GitSource,
} from "../common.ts";
import type { DeniedReason } from "../errors.ts";
import type { AppendInput, AppendResult, Envelope } from "../events.ts";
import { SYS_KERNEL } from "../ids.ts";
import type {
	EvalResponse,
	PolicySignoffDto,
	PolicySignoffRequest,
	ProjectConfigAnswer,
	RepoConfigEvalDto,
	RepoConfigHeadDto,
	RepoConfigPreviewDto,
	RepoConfigTrunkRowDto,
	RepoPolicyAnswer,
} from "../repoconfig.ts";
import type {
	ConflictRegion,
	LaneRange,
	PathDiff,
	ProjectGraph,
	RepoInfo,
	Trailer,
} from "../git.ts";
import type {
	AdvanceState,
	AdvanceStep,
	KernelWriteOwnerKind,
	KernelWritePurpose,
	KernelWriteState,
	LandBatchState,
	LandChange,
	LandReason,
	LandRequest,
	LandStatus,
	LandVerdict,
	TestPolicy,
} from "../land.ts";
import type {
	ArchiveResult,
	Lane,
	LaneBackendName,
	LaneKind,
	LaneMode,
	LaneOp,
	LanePlatformFaultCode,
	LaneSeed,
	LaneSeedPhase,
	LaneState,
	SyncResult,
} from "../lanes.ts";
import type {
	JobGraph,
	JobState,
	RunKind,
	RunState,
	RunStatus,
} from "../pipeline.ts";
import type { WhyNote } from "../notes.ts";
import type { LaneFetchSpec } from "../services.ts";
import type { AuthContext } from "./forge.ts";

// ---------------------------------------------------------------------------
// Rows: core (WP5a 100–179; 180–199 reserved for WP5b's `repo` backend)
// ---------------------------------------------------------------------------

export type RepoMetaKey =
	| "repo_id"
	| "node_id"
	| "path"
	| "artifacts_name"
	| "default_branch"
	| "trunk_sha"
	| "landing_paused"
	| "drifted"
	/** `none` | `importing`. */
	| "import_state"
	/** Default 200 while the repo's lanes use the `repo` backend, 2,000 on `branch` (U54). */
	| "max_active_lanes"
	/** Default 20. */
	| "max_lanes_per_principal"
	/** Per-repo override of `LANE_MODE` (`LaneMode`); unset = the forge default; sim repos `branch`. */
	| "lane_mode"
	/** JSON `LaneBreakerState`. */
	| "lane_breaker"
	/**
	 * The `LANE_IMPORT_MAX_BYTES` estimate: the last measured trunk pack (bytes
	 * the capability route served) plus the pushed bytes of every lane landed
	 * since.
	 */
	| "trunk_pack_bytes"
	| "trunk_pack_measured_at"
	/** now + 24 h after an import `MEMORY_LIMIT`; cleared early by a measurement that fits. */
	| "import_too_large_until"
	/** Owner setting, default `ATTIC_RETENTION_DEFAULT_MS`, at most `ATTIC_RETENTION_MAX_MS`. */
	| "attic_retention_ms"
	/**
	 * `1`: a swarm shard (dev stages only): every event appended here
	 * is a simulated agent's and carries `sim: true` (24 h retention).
	 */
	| "sim";

/**
 * `meta.lane_breaker`: one strike per lane that fell back for a platform-side
 * reason, never per attempt.
 */
export type LaneBreakerState = {
	readonly strikes: readonly {
		readonly at: number;
		readonly laneId: string;
		readonly code: LanePlatformFaultCode;
	}[];
	readonly degradedTo?: LaneMode;
	readonly until?: number;
};

export type RefRow = {
	ref: string;
	sha: string;
	updated_at: number;
	push_id: string | null;
	/** Annotated tags: the peeled target (public-view want check). */
	peeled: string | null;
	reconciled_at: number | null;
};

/** The capability route's report for a nonce (`lanes.cap_outcome`, `CapReport.outcome`). */
export type CapOutcome =
	| "served"
	| "trunk-moved"
	| "aborted"
	| "upstream-error";

export type LaneRow = {
	id: string;
	kind: LaneKind;
	/** The `LaneBackend` actually used; may change once, `repo` → `branch`, while `opening`. */
	mode: LaneBackendName;
	/**
	 * `l-<repoUlid>-<laneUlid>[-<n>]` iff `mode = 'repo'`: the CURRENT seed
	 * attempt's name. Earlier attempts' repos are orphans.
	 */
	repo_name: string | null;
	/** The current or final seed; null on `branch`. */
	seed: LaneSeed | null;
	/** Open → verified; null = never opened. */
	seed_ms: number | null;
	/**
	 * The fencing token: every attempt starts with the CAS
	 * `seed_attempt = n → n+1 WHERE state = 'opening'`; every later transition
	 * of the attempt is conditioned on `(state = 'opening', seed_attempt = n)`.
	 */
	seed_attempt: number;
	/** Null unless `opening`. */
	seed_phase: LaneSeedPhase | null;
	/** The current attempt's deadline; the `seed` watchdog timer fires here. */
	seed_deadline: number | null;
	/** 128-bit hex nonce of the current attempt's capability; null once the lane leaves `opening`. */
	cap_nonce: string | null;
	/** `info/refs` (and v2 `ls-refs`) requests served on this nonce (≤ `CAP_INFO_USES_MAX`). */
	cap_uses: number;
	/** The pack request on this nonce was accepted (single use). */
	cap_consumed_at: number | null;
	cap_outcome: CapOutcome | null;
	/**
	 * The head ref: `refs/heads/main` (in the lane repo) on `repo`;
	 * `refs/heads/lanes/<id>` or the adopted branch (in the canonical repo) on
	 * `branch`. Key of the push policy.
	 */
	ref: string;
	owner_principal: string;
	on_behalf_of: string | null;
	delegates_json: string;
	opened_by_installation: string | null;
	entity_kind: string | null;
	entity_id: string | null;
	/**
	 * The change the lane carries (`changes.submitted`, applied by
	 * `applyLaneEventSync`); null until the first submit. Maps
	 * `changes.abandoned`/`changes.superseded` without a `laneId` back to the
	 * lane, and is the key of lane GC's change-ref precondition.
	 */
	change_id: string | null;
	footprint_json: string;
	depends_on_lane: string | null;
	/**
	 * The merge base with trunk (K17): fixed by each seed attempt's CAS
	 * (immutable for its nonce; the capability advertises exactly it), then
	 * each non-truncated `push.diffed.rangeBase`.
	 */
	base_sha: string;
	/** `branch`: null until the first push creates the ref. `repo`: `base_sha` once the seed is verified. */
	head_sha: string | null;
	state: LaneState;
	/** 1 = an observed ref change matched no gateway or kernel write (K2). */
	quarantined: 0 | 1;
	lease_expires_at: number;
	last_push_at: number | null;
	pushes: number;
	created_at: number;
	closed_at: number | null;
	/** `kind = 'lane'` only: when lane GC deletes the lane repo or the branch ref. */
	delete_after: number | null;
};
export type PushVia = "gateway" | "trigger" | "kernel" | "swarm" | "reconcile";
export type PushDiffState = "pending" | "done" | "skipped";
export type PushRow = {
	id: string;
	at: number;
	/** `'repo'` or a lane id (`branch`-lane refs, adopted branches, lane remotes, lane-repo trigger events). */
	target: string;
	/** The lane repo the transition happened in (`repo` lanes); null for the canonical repo. */
	repo_name: string | null;
	/** Request body bytes of a gateway push (the `trunk_pack_bytes` estimate). */
	bytes: number | null;
	ref: string;
	before: string;
	after: string;
	principal_id: string | null;
	on_behalf_of: string | null;
	token_id: string | null;
	via: PushVia;
	seen_via_json: string;
	request_id: string | null;
	kernel_write_id: string | null;
	/** Phase 2 (K17): the merge base of `after` with trunk. */
	range_base: string | null;
	range_truncated: 0 | 1 | null;
	diff_state: PushDiffState;
	/** R2 `diffs/<repoId>/<range_base>..<after>.json`. */
	diff_key: string | null;
};
export type CommitFirstRow = {
	sha: string;
	/** Null while the commit was seen only through the trigger. */
	principal_id: string | null;
	push_id: string;
	at: number;
};
export type TrunkCommitRow = {
	sha: string;
	/** Trunk order: the imported first-parent chain ≤ 0 (tip = 0), genesis 0, each landing 1, 2, … */
	seq: number;
	source: "genesis" | "import" | "advance" | "seed";
};
export type KernelWriteRow = {
	id: string;
	/** `'repo'` (the canonical repo) or a lane id (that lane's repo). */
	target: string;
	ref: string;
	expect_old: string;
	/** 40 zeros = delete (`lane-delete`: the whole lane repo). */
	new_sha: string;
	purpose: KernelWritePurpose;
	owner_kind: KernelWriteOwnerKind;
	owner_id: string;
	state: KernelWriteState;
	/** The intent this retry replaced (notes retries, repairs, seed attempts). */
	supersedes: string | null;
	created_at: number;
	updated_at: number;
};
export type PendingObservationRow = {
	id: string;
	/** The repo the ref lives in: `'repo'` or a lane id. */
	target: string;
	/** The exact lane repo name observed (equal to `lanes.repo_name`). */
	repo_name: string | null;
	ref: string;
	before: string;
	after: string;
	source: "trigger" | "reconcile";
	/** Set for lane heads and any ref of a lane repo (K2 quarantine instead of K1 pause). */
	lane_id: string | null;
	observed_at: number;
	recheck_at: number;
	checks: number;
};

// ---------------------------------------------------------------------------
// Rows: events (WP6, 200–249)
// ---------------------------------------------------------------------------

export type EventRow = {
	seq: number;
	id: string;
	idem_key: string;
	type: string;
	v: number;
	source: string;
	shadow: 0 | 1;
	actor_kind: string;
	actor_id: string;
	on_behalf_of: string | null;
	subject_kind: string | null;
	subject_id: string | null;
	caused_by: string | null;
	correlation: string | null;
	depth: number;
	data_json: string;
	at: number;
	prev_hash: string;
	hash: string;
	pinned: 0 | 1;
	sim: 0 | 1;
	/** The envelope's `node`, `repo` and `source.ext` (not columns of `events`; WP6). */
	node: string;
	repo: string | null;
	source_ext: string | null;
};
export type ChainCheckpointRow = { seq: number; hash: string; at: number };
/** `events_pruned`: the chain skeleton kept for pruned events (WP6). */
export type ChainSkeletonRow = { seq: number; prev_hash: string; hash: string };
export type SubscriberRow = {
	installation_id: string;
	host_name: string;
	pattern: string;
	mode: string;
	ext_version: number;
};

/** Checkpoint cadence and retention. */
export const EVENT_CHECKPOINT_EVERY = 1000;
export const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const SIM_EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;
export const GENESIS_PREV_HASH = "0".repeat(64);

// ---------------------------------------------------------------------------
// Rows: probe cache (WP8, 250–299), runs (WP9, 300–349)
// ---------------------------------------------------------------------------

export type ProjectRow = {
	name: string;
	root: string;
	deps_json: string;
	owners_json: string;
	sensitive: 0 | 1;
	test_cmd: string | null;
	source: string;
	manifest_path: string | null;
	manifests_tree_sha: string;
};
export type GlobalFileRow = {
	glob: string;
	source: "config" | "detector-default";
};

export type RunRow = {
	id: string;
	instance_id: string;
	idem_key: string;
	instance_created: 0 | 1;
	kind: RunKind | "agent";
	requested_by: string;
	subject_kind: string | null;
	subject_id: string | null;
	/** The lane under test (read from that lane's repo on the `repo` backend), or null for a canonical commit (a candidate). */
	lane_id: string | null;
	sha: string;
	graph_json: string;
	concurrency_group: string | null;
	state: RunState;
	created_at: number;
	finished_at: number | null;
};
export type JobRow = {
	run_id: string;
	job_id: string;
	project: string | null;
	state: JobState;
	exit_code: number | null;
	started_at: number | null;
	finished_at: number | null;
	log_key: string | null;
	tail: string | null;
};

// ---------------------------------------------------------------------------
// Rows: land (WP10, 350–399)
// ---------------------------------------------------------------------------

export type LandBatchRow = {
	id: string;
	instance_id: string;
	ref: string;
	instance_created: 0 | 1;
	requested_by: string;
	partition_key: string | null;
	base_sha: string;
	attempt: number;
	candidate_sha: string | null;
	changes_json: string;
	reason_json: string;
	affected_json: string | null;
	test_policy: TestPolicy;
	state: LandBatchState;
	result_json: string | null;
	created_at: number;
	finished_at: number | null;
};
export type LandVerdictRow = {
	batch_id: string;
	attempt: number;
	candidate_sha: string;
	state: "success" | "failure";
	run_ids_json: string;
	evidence_json: string | null;
	reported_by: string;
	at: number;
};
export type AdvanceRow = {
	id: string;
	batch_id: string;
	attempt: number;
	ref: string;
	expect_old: string;
	new_sha: string | null;
	owner_instance: string;
	lease_until: number;
	step: AdvanceStep;
	state: AdvanceState;
	evidence_reused: 0 | 1;
	gate_results_json: string | null;
	chain_seq: number | null;
	chain_head: string | null;
	created_at: number;
	finished_at: number | null;
};
export type LandingRow = {
	commit_sha: string;
	advance_id: string;
	change_id: string;
	lane_id: string;
	/** The lane head this landing was composed from. */
	lane_head: string;
	trunk_seq: number;
	paths_json: string;
	projects_json: string;
	at: number;
};
export type NoteSectionRow = {
	change_id: string;
	ext_id: string;
	section_json: string;
	at: number;
};
export type GateReplayRow = {
	id: string;
	installation_id: string;
	advances_json: string;
	results_json: string | null;
	state: string;
	created_at: number;
};

// ---------------------------------------------------------------------------
// Inputs shared by the facades
// ---------------------------------------------------------------------------

/** One receive-pack command (`<old> <new> <ref>`). */
export type PushCommand = {
	readonly ref: string;
	readonly old: string;
	readonly new: string;
};

/**
 * `recordPush` input from the gateway (or swarm/kernel); `observePush` is the
 * trigger's. Phase 1 of push recording: I/O-free.
 */
export type PushReport = {
	/**
	 * `"repo"`, or a lane id: a lane remote (its `refs/heads/main`), a
	 * `branch`-lane ref or an adopted branch.
	 */
	readonly target: "repo" | string;
	/** The lane's current repo name, for a push through a lane remote. */
	readonly repoName?: string;
	/** Request body bytes (gateway pushes; the `trunk_pack_bytes` estimate). */
	readonly bytes?: number;
	readonly refs: readonly {
		readonly ref: string;
		readonly before: string;
		readonly after: string;
	}[];
	readonly principal: string | null;
	readonly onBehalfOf?: string;
	readonly tokenId?: string;
	readonly via: PushVia;
	/** Gateway request id | trigger event id | kernel_writes id. `UNIQUE(via, request_id)`. */
	readonly requestId: string;
};

/**
 * One `cf.artifacts.repo.pushed` event as IngestWorkflow maps it: one ref per
 * event, no pusher and no timestamp in the payload [E A5]; `repoName`
 * lowercased. RepoDO maps a lane only by exact match with a lane's current
 * `lanes.repo_name`; any other `l-*` name of the family takes the orphan path
 * and never feeds K1/K2.
 */
export type TriggerObservation = {
	readonly eventId: string;
	readonly repoName: string;
	readonly ref: string;
	readonly before: string;
	readonly after: string;
	readonly at: number;
};

export type KernelWriteIntent = {
	/** `"repo"` or a lane id (that lane's repo). */
	readonly target: "repo" | string;
	readonly ref: string;
	readonly expectOld: string;
	readonly newSha: string;
	readonly purpose: KernelWritePurpose;
	readonly ownerKind: KernelWriteOwnerKind;
	readonly ownerId: string;
	/** The intent this one replaces (a retry, a repair, the next seed attempt). */
	readonly supersedes?: string;
};

/**
 * `openLane` returns at once: a `repo` lane `opening` (its seed runs
 * detached, fenced per attempt) or a `branch` lane `open`. The kernel picks
 * the backend. K16 runs inside the open transaction on `actor`: `owner` must
 * be `actor.id` or `actor.onBehalfOf`, and an `ext` actor (a background
 * installation call) is denied. `lanes.opened_by_installation` is
 * `actor.installation`.
 */
export type OpenLaneInput = {
	readonly owner: string;
	/** The user the owning agent acts for (`lanes.on_behalf_of`). */
	readonly onBehalfOf?: string;
	readonly entity?: EntityRef;
	readonly footprint?: Footprint;
	/** Who asks (K16). */
	readonly actor: LaneOpActor;
};

/** `adoptLane` input: K16 `adopt` runs on `actor` in the adopt transaction. */
export type AdoptLaneInput = {
	readonly ref: string;
	readonly owner: string;
	readonly entity?: EntityRef;
	/** Who asks: a user who last pushed `ref` through the gateway, or a Maintainer+ (K16). */
	readonly actor: LaneOpActor;
};

/** Phase 1 of push recording: I/O-free. */
export type RecordPushResult = {
	readonly pushIds: readonly string[];
	readonly eventIds: readonly string[];
	/**
	 * The appended slim `push.accepted` envelopes (no paths, commits or
	 * `diffKey`; those come with `push.diffed`), so the gateway echo needs no
	 * second round trip.
	 */
	readonly events: readonly Envelope[];
	/** Refs whose index CAS missed and were reconciled. */
	readonly reconciled: readonly string[];
};

/**
 * Phase 2 of push recording (`recordDiff`), as `RepoProbeApi.laneDiff`
 * computes it in the repo that holds `after`. `firstPushedBy` is added by
 * RepoDO from `commit_firsts`.
 */
export type DiffResult = {
	readonly rangeBase: string;
	readonly rangeTruncated: boolean;
	readonly diffKey: string;
	/** ≤ `PUSH_COMMITS_MAX`, from `rangeBase..after`. */
	readonly commits: readonly {
		readonly sha: string;
		readonly subject: string;
		readonly trailers: readonly Trailer[];
	}[];
	/** ≤ `PUSH_PATHS_MAX`. */
	readonly paths: readonly string[];
	readonly truncated: boolean;
};

/** The Artifacts repo behind the canonical repo or one of its lanes. */
export type UpstreamTarget = { readonly laneId?: string };

/**
 * Kernel-only upstream access: the gateway (WP4), RepoProbe
 * (WP8), RunWorkflow checkout (WP9) and compose (WP10) map `{repoId, laneId?}`
 * to the Artifacts repo here, so no caller handles raw names. Never exposed to
 * caps, the HTTP API or clients (K11).
 *
 * One exception: the capability route does not use
 * this cached token. WP4 mints a fresh trunk read token per proxied request
 * in the Worker, on `ARTIFACTS.get(repoArtifactsName(cap.repoId))`
 * (`createToken("read", LANE_CAP_TTL_S)`), and revokes it on finish, cancel
 * and abort, under a per-isolate control bucket that WP4 owns
 * (`ARTIFACTS_CONTROL_PER_S_ISOLATE`). The repo id comes from the
 * MAC-verified path, so the name is still derived, never taken from input.
 */
export type Upstream = {
	/**
	 * `r-<repoUlid>` (canonical and `branch` lanes) or the lane's CURRENT
	 * lane repo `l-<repoUlid>-<laneUlid>[-<n>]`.
	 */
	readonly artifactsName: string;
	/** HTTPS git remote (`ArtifactsRepoInfo.remote`). */
	readonly remote: string;
	/**
	 * Memory-only, scoped to exactly this one repo, served from the memory
	 * cache keyed `(artifactsName, scope)` (lane-remote pushes included) and
	 * minted with `createToken(scope, 600)` (K11).
	 */
	readonly token: string;
	readonly expiresAt: number;
	readonly kind: "canonical" | "lane-repo" | "lane-branch";
	/**
	 * The ref holding the target's head: the default branch (canonical),
	 * `refs/heads/main` (lane repo) or `refs/heads/lanes/<id>` (lane branch).
	 */
	readonly ref: string;
};

/**
 * RepoDO's half of the receive-pack policy inputs, answered in one RPC by
 * `pushContext`. The caller's current role and forge ownership come from authz
 * (`security.ts` `PushCaller`).
 */
export type PushContext = {
	readonly caller: {
		readonly kind: "user" | "agent";
		/**
		 * The token carries the `lanes` or `repo:write` scope and the caller's
		 * CURRENT effective role on the repo is ≥ Developer.
		 */
		readonly writeCredential: boolean;
	};
	/**
	 * The caller's active lanes (owner or delegate; only the pinned lane for a
	 * lane-pinned token).
	 */
	readonly ownLanes: readonly {
		readonly laneId: string;
		readonly mode: LaneBackendName;
		readonly ref: string;
		readonly state: LaneState;
		readonly headSha: string | null;
		/**
		 * False only for a `lost` lane past its 24 h resume window
		 * (`LANE_RESUME_MS` after `lease_expires_at`).
		 */
		readonly resumable: boolean;
		/** Held by another request's push lease (U48 fallback; always false while it is off). */
		readonly leased: boolean;
	}[];
	/** The lane a lane remote names. */
	readonly target?: {
		readonly laneId: string;
		readonly mode: LaneBackendName;
		readonly state: LaneState;
		readonly owner: string;
		readonly delegates: readonly string[];
		readonly headSha: string | null;
		readonly quarantined: boolean;
		/** As `ownLanes[].resumable`. */
		readonly resumable: boolean;
		/** As `ownLanes[].leased`. */
		readonly leased: boolean;
	};
	/** Head refs of active adopted lanes and who may write them. */
	readonly adopted: readonly {
		readonly ref: string;
		readonly owner: string;
		readonly delegates: readonly string[];
	}[];
	readonly protectedPatterns: readonly string[];
	readonly defaultBranch: string;
	/** Every ref in the index, case-folded. */
	readonly caseFoldedRefs: readonly string[];
	readonly importState: "none" | "importing";
	readonly landingPaused: boolean;
};

/**
 * The U48 fallback: with `PUSH_LEASE_ENABLED` on, `pushContext`
 * takes a short per-ref lease for `requestId` on every lane head among
 * `refs`, and reports a head another request holds as `leased: true` (the
 * policies answer `stale-old`). Phase 1 of `recordPush` and `recordRejection`
 * release it for the same request id; otherwise it expires
 * (`PUSH_LEASE_MS`). With the switch off this is ignored, so the U48 outcome
 * stays a constants change.
 */
export type PushLeaseRequest = {
	/** The gateway request id (`PushReport.requestId`). */
	readonly requestId: string;
	/** The refs of the push's commands (`peekCommands`). */
	readonly refs: readonly string[];
};

/**
 * The upload-pack inputs, from the RepoDO index and push log only (no upstream
 * call).
 */
export type ReadContext = {
	/** `public` for `readContext("anon")` (the gateway's public view), else `member`. */
	readonly view: "member" | "public";
	/** Current tips of visible refs, and peeled targets of visible annotated tags. */
	readonly visibleTips: readonly string[];
	/** Tips visible refs held within the last 10 minutes. */
	readonly recentTips: readonly string[];
	/** The caller's own `branch`-lane refs, advertised to it alone. */
	readonly ownLanes: readonly {
		readonly laneId: string;
		readonly ref: string;
		readonly headSha: string | null;
	}[];
};

/**
 * What the capability route serves for one seed attempt.
 * The isolate already verified the path's `exp` and MAC, so no expiry is
 * returned (no `lanes` column holds it).
 */
export type CapContext = {
	readonly repoId: string;
	readonly laneId: string;
	readonly nonce: string;
	readonly attempt: number;
	/** The attempt's base: the only SHA advertised (as `refs/heads/main`) and wanted. */
	readonly base: string;
	/** The canonical default branch whose upstream tip the route compares with `base`. */
	readonly defaultBranch: string;
	/** `LANE_CAP_PIN_BASE`: serve `base` when a kernel-explained trunk move happened (U55). */
	readonly pinBase: boolean;
	/**
	 * Default-branch tips the kernel explains at `capUse` time (`explainsSync`
	 * on `refs/heads/<defaultBranch>`: the `new_sha` of an open intent or an
	 * un-completed Advance on that ref). When the upstream tip `T_up` ≠
	 * `base`, the route serves `base` only if `pinBase` and `T_up` is listed;
	 * otherwise 503 and `capReport({outcome: "trunk-moved", upstreamTip})`.
	 * A move that happens after `capUse` is unlisted, which only costs one
	 * `trunk-moved` retry.
	 */
	readonly explainedTips: readonly string[];
};

/**
 * `capUse`: atomic; `info` (`info/refs` or a v2 `ls-refs`) counts against
 * `CAP_INFO_USES_MAX`, `pack` consumes the nonce (a second pack request is
 * refused).
 */
export type CapUse =
	| { readonly ok: true; readonly ctx: CapContext }
	| {
		readonly ok: false;
		readonly reason: "unknown" | "not-opening" | "consumed" | "uses-exceeded";
	};

/** The route's report on a nonce, for failure classification and the size estimate. */
export type CapReport = {
	readonly op: "info" | "pack";
	/** Pack bytes served (a `trunk_pack_bytes` measurement when `served`). */
	readonly bytes?: number;
	readonly outcome: CapOutcome;
	/**
	 * The upstream default-branch tip the route read (`trunk-moved`): RepoDO
	 * parks a K1 observation for it unless the kernel explains it.
	 */
	readonly upstreamTip?: string;
};

/** The orphan sweep's answer for the `l-*` names of one repo family. */
export type SweepResult = {
	readonly deleted: readonly string[];
	readonly kept: readonly string[];
};

/** One cron pass of lane-repo reconciliation (`reconcileLaneRepos`; WP5b). */
export type LaneRepoReconcileRun = {
	/** Lane repos read (`readTip` by exact `repo_name`, paced ≤ `LANE_RECONCILE_PER_S`). */
	readonly checked: number;
	/** Ref changes that matched no gateway or kernel record, parked for K2. */
	readonly observed: number;
};

/** One run of lane GC (`gcLanes`), by lane id. */
export type LaneGcRun = {
	readonly deleted: readonly string[];
	/** Waiting for a landed lane's change ref (alerted after `LANE_GC_DEFER_ALERT_MS`). */
	readonly deferred: readonly string[];
	/** Head moved (K2), adopted, or not yet due. */
	readonly skipped: readonly string[];
};

/**
 * Who asks for a lane operation (K16): the acting principal and, for
 * extension calls, the calling installation. RepoDO derives the current role
 * itself. Callers build it from the authenticated context, never from
 * request input: the MCP host and the HTTP API from `AuthContext`, KernelCaps
 * (WP7b) from `CapsProps` (an `ext` actor = a background hook). Kernel-internal
 * callers pass `KERNEL_LANE_ACTOR`.
 */
export type LaneOpActor = Actor & {
	/** The calling installation (`i_<ulid>`), for extension calls. */
	readonly installation?: string;
	/**
	 * The caller's credential bounds (the HTTP API and the MCP host:
	 * `actorBoundsOf(auth)` for a token; KernelCaps: `CapsProps.bounds`, or
	 * the installation's background role confined to its node). RepoDO
	 * applies `boundRole` (ceiling, node subtree, lane pin at the target lane)
	 * to the role it derives, and a credential whose scopes lack `lanes`
	 * brings no role to a lane operation. Absent: unbounded (a session).
	 */
	readonly bounds?: ActorBounds;
};

/**
 * The kernel's own lane actor (`sys_kernel`): LandWorkflow (the `landing`
 * freeze and release), lease expiry, lane GC, the orphan sweep and the
 * seeder. K16 lets it bypass the actor rules, never the state rules (no sync
 * or restack while `landing`). Only kernel code may pass it: the MCP host,
 * the HTTP API and KernelCaps never do.
 */
export const KERNEL_LANE_ACTOR: LaneOpActor = Object.freeze({
	kind: "system",
	id: SYS_KERNEL,
});

export type LaneOpDecision =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: DeniedReason };

/** Everything LandWorkflow needs about a batch. */
export type LandBatchDetail = {
	readonly status: LandStatus;
	readonly changes: readonly LandChange[];
	readonly reason: LandReason;
	readonly testPolicy: TestPolicy;
	readonly partitionKey?: string;
	readonly requestedBy: string;
};

// ---------------------------------------------------------------------------
// Facades (RPC) and internals (sync, in-DO)
// ---------------------------------------------------------------------------

/**
 * core (WP5a; the `repo` backend's seeder, capability state, sweep, GC and
 * settings are WP5b's behind it, through `RepoBackend` in services.ts): refs,
 * pushes, kernel writes, lanes, tokens.
 *
 * **K16 is enforced here, inside each lane operation.**
 * Every lane-mutating method takes a `LaneOpActor` and runs the K16 check in
 * the same transaction as its own state change, whether the call comes from
 * MCP, the HTTP API, KernelCaps or a kernel module: a denial throws
 * `denied("lane-op")` (`details.code` = the reason code) and appends
 * `lane.denied` in its own transaction. No caller-side check is ever the
 * enforcement point; `authorizeLaneOp` is a read-only pre-check.
 */
export interface RepoCoreFacade {
	/** Called once by tree.createRepo/importRepo; seeds meta and `refs`. */
	init(
		input: {
			repoId: string;
			nodeId: string;
			path: string;
			defaultBranch: string;
			refs?: Record<string, string>;
			/**
			 * Owner import mode starts `importing`; WP3's
			 * `importRepo({mode: "push"})` passes it (default `none`).
			 */
			importState?: "none" | "importing";
		},
	): Promise<void>;
	info(): Promise<RepoInfo>;
	refs(): Promise<RefRow[]>;
	/** A ref name, a lane id or a SHA → SHA from the index and lane rows, never the binding (K15). */
	resolveRef(ref: string): Promise<string | null>;
	/**
	 * Phase 1: I/O-free (no binding read); merges by the cross-channel rule, CAS on `refs`,
	 * lane head, lease and quarantine ⇒ slim `push.accepted` per ref.
	 */
	recordPush(report: PushReport): Promise<RecordPushResult>;
	/**
	 * Phase 2: `pushes.range_base`/`diff_key`, `lanes.base_sha` (non-truncated
	 * ranges), `commit_firsts` ⇒ `push.diffed`. Idempotent per `pushId`.
	 */
	recordDiff(pushId: string, result: DiffResult): Promise<void>;
	/** The lane's current range (K17): runs or awaits phase 2 for its head. */
	laneRange(laneId: string): Promise<LaneRange>;
	/** ⇒ `push.rejected`. Releases the push lease of `requestId` (U48 fallback). */
	recordRejection(
		rejection: {
			principal: string;
			tokenId?: string;
			target: "repo" | string;
			commands: readonly PushCommand[];
			reason: string;
			/** The gateway request id given to `pushContext`. */
			requestId?: string;
		},
	): Promise<void>;
	/** Idempotent per trigger event id; parks unmatched protected/kernel-ref observations (K1) and lane-ref ones (K2). */
	observePush(observation: TriggerObservation): Promise<void>;
	/** Reconciles refs from a fresh upload-pack advertisement (cron, CAS miss). */
	reconcile(refs?: string[]): Promise<{ changed: string[] }>;
	/**
	 * The Artifacts repo of the canonical repo or one of its lanes, with a
	 * memory-only token scoped to that one repo (K11). A RepoDO only ever
	 * mints tokens for its own repo family. Never returned to
	 * clients.
	 */
	upstream(
		target: UpstreamTarget,
		scope: "read" | "write",
	): Promise<Upstream>;
	/**
	 * The receive-pack policy inputs in one RPC. `tokenLaneId`
	 * (the token's lane pin) narrows `ownLanes`; `target` names a lane remote;
	 * `lease` is the U48 fallback's push lease (`PushLeaseRequest`).
	 */
	pushContext(
		principal: AuthContext,
		tokenLaneId: string | null,
		target?: { laneId: string },
		lease?: PushLeaseRequest,
	): Promise<PushContext>;
	/** Upload-pack inputs; `"anon"` for the public view. */
	readContext(principal: AuthContext | "anon"): Promise<ReadContext>;
	/**
	 * Ends import mode ⇒ `repo.imported`. `source` (kernel
	 * callers only; the HTTP route never passes it) is the redacted origin of
	 * a URL import for the event; without it the event says `import-mode`.
	 */
	importComplete(
		by: string,
		input: ImportCompleteRequest,
		source?: string,
	): Promise<ImportCompleteResponse>;
	/**
	 * K16 as a read-only pre-check (UIs, tool listing): the decision the
	 * operation itself would take now. Writes nothing and appends no
	 * `lane.denied`; it is never the enforcement point (each mutating method
	 * re-checks inside its own transaction). `laneId` is null for `open`.
	 */
	authorizeLaneOp(
		actor: LaneOpActor,
		laneId: string | null,
		op: LaneOp,
	): Promise<LaneOpDecision>;
	/**
	 * Returns at once: `opening` on the `repo` backend (⇒
	 * `lane.opening`; the seed runs detached) or `open` on `branch` (⇒
	 * `lane.opened`). K16 `open` on `input.actor`, the lane caps and the
	 * `lane.open` gates run in the open transaction; the kernel picks the
	 * backend (`RepoBackend.planOpening` for `repo`).
	 */
	openLane(input: OpenLaneInput): Promise<Lane>;
	/**
	 * Resolves when the lane leaves `opening` (open, fallen back or closed),
	 * or with the lane as it is at `timeoutMs`. For the MCP host only, outside
	 * any ExtensionDO.
	 */
	awaitLane(laneId: string, timeoutMs: number): Promise<Lane>;
	/**
	 * The watchdog / re-drive of one `opening` lane: a no-op
	 * unless the current attempt's deadline has passed; then probes that
	 * attempt's repo and advances it by CAS. Never awaits an import or a
	 * push, never throws. WP5b (`RepoBackend.seedLane`).
	 */
	seedLane(laneId: string): Promise<void>;
	/**
	 * The cron's seed re-drive: `seedLane` for every `opening`
	 * lane whose deadline passed more than 30 s ago. WP5b.
	 */
	redriveSeeds(now: number): Promise<{ laneIds: string[] }>;
	/** Capability state, called only after the isolate verified the MAC. WP5b. */
	capContext(laneId: string, nonce: string): Promise<CapContext | null>;
	capUse(laneId: string, nonce: string, op: "info" | "pack"): Promise<CapUse>;
	capReport(laneId: string, nonce: string, report: CapReport): Promise<void>;
	/** K16 `adopt` on `input.actor` in the adopt transaction; always `mode = 'branch'`. */
	adoptLane(input: AdoptLaneInput): Promise<Lane>;
	getLane(laneId: string): Promise<Lane | null>;
	listLanes(
		filter: {
			state?: LaneState[];
			owner?: string;
			entity?: EntityRef;
			cursor?: string;
			limit?: number;
		},
	): Promise<{ lanes: Lane[]; cursor?: string }>;
	/**
	 * K16 `close` on `by`, then a CAS on the lane's state; on an `opening`
	 * lane it fences the seed (⇒ `lane.closed{seedCode: "cancelled"}`).
	 */
	closeLane(laneId: string, reason: string, by: LaneOpActor): Promise<void>;
	/**
	 * K16 `archive` on `by` (owner or Maintainer+), then WP10's advisory gates
	 * (`KernelGitJobs.archive`), then the backend's outcome (`branch`: the
	 * attic ref; `repo`: `RepoBackend.archive`) ⇒ `lane.archived`.
	 */
	archiveLane(
		laneId: string,
		o: { atticRef?: string },
		by: LaneOpActor,
	): Promise<ArchiveResult>;
	/** K16 `delegate` (owner only) ⇒ `lane.delegated`. */
	delegateLane(
		laneId: string,
		add: readonly string[],
		remove: readonly string[],
		by: LaneOpActor,
	): Promise<void>;
	/** K16 `sync` (owner or delegate; refused while `landing`); git work by WP10. */
	syncLane(laneId: string, by: LaneOpActor): Promise<SyncResult>;
	/** K16 `restack` (owner only; `onto` an active lane of this repo); git work by WP10. */
	restackLane(
		laneId: string,
		onto: string,
		by: LaneOpActor,
	): Promise<SyncResult>;
	/**
	 * K16 `purge`: an Owner deletes a closed (or archived) lane's storage at
	 * once: the lane repo (`RepoBackend.purge`, WP5b) or the
	 * lane or attic ref (`KernelGitJobs.refWrite`, purpose `purge`, WP5a)
	 * ⇒ `lane.deleted`.
	 */
	purgeLane(laneId: string, by: LaneOpActor): Promise<void>;
	/** An Owner clears a lane's K2 quarantine (`by` must hold Owner on the repo). */
	ackQuarantine(laneId: string, by: LaneOpActor): Promise<void>;
	/**
	 * Lane GC (cron, `KERNEL_LANE_ACTOR`): `LaneBackend.gc` for every lane past
	 * `delete_after`, both backends ⇒ `lane.deleted`. WP5a's cron calls it;
	 * the `repo` backend's `gc` is WP5b's.
	 */
	gcLanes(now: number): Promise<LaneGcRun>;
	/**
	 * The orphan sweep for `l-*` names of this repo
	 * family: deletes a name only when it is older than the orphan age and no
	 * lane that opened owns it; a `lane-delete` intent precedes each deletion.
	 * WP5b.
	 */
	sweepLaneRepos(names: readonly string[], now: number): Promise<SweepResult>;
	/**
	 * Lane-repo reconciliation (cron): `readTip` of each active `repo`
	 * lane's exact `repo_name`, paced; an unexplained change is parked for K2.
	 * WP5b.
	 */
	reconcileLaneRepos(now: number): Promise<LaneRepoReconcileRun>;
	/**
	 * Marks the repo as a swarm shard (dev tools only, else `not_found`): from
	 * then on every event appended in it carries `sim: true`. Idempotent; there
	 * is no way back (sim repos are scratch). WP20.
	 */
	markSimulated(): Promise<void>;
	/** WP5b. */
	laneSettings(): Promise<RepoLaneSettingsDto>;
	/** Owner only (`by` must hold Owner on the repo). WP5b. */
	setLaneSettings(
		input: RepoLaneSettingsRequest,
		by: LaneOpActor,
	): Promise<RepoLaneSettingsDto>;
	/**
	 * How a sandbox exec outside RepoDO fetches lane heads by SHA (WP9 mirror
	 * fetches, WP10 compose, sync, restack and repair): one
	 * `LaneFetchSpec` per lane, in order; the exec mints its own read token
	 * for `token.artifactsName` (the lane's CURRENT repo, or the canonical repo
	 * for a `branch` lane). Unknown lanes are skipped.
	 */
	laneFetchSpecs(laneIds: readonly string[]): Promise<LaneFetchSpec[]>;
	/**
	 * The `trunk_commits` positions of `shas` (absent = not on trunk), for
	 * RepoProbe's K17 range walk outside RepoDO: one batched call per log
	 * page, never one per commit.
	 */
	trunkSeqs(shas: readonly string[]): Promise<Record<string, number>>;
	renewLease(
		laneId: string,
		principal: string,
	): Promise<{ leaseExpiresAt: number }>;
	/** Batched presence/lease flush from InboxDO (≤ 1/min). */
	flushPresence(
		entries: {
			principal: string;
			laneId?: string;
			status: string;
			at: number;
		}[],
	): Promise<void>;
	/** Owner acknowledges a `ref.tampered` (clears `landing_paused`, `drifted`). */
	ackTampered(by: string): Promise<void>;
	/**
	 * K1 write-intent ledger for kernel git jobs running outside the DO
	 * (genesis, attic, lane-sync, lane-seed, lane-delete, purge, seed,
	 * repair): register BEFORE the write, mark `pushed` after it. LandWorkflow
	 * steps register through the land facade, in the same transaction as
	 * their state change.
	 */
	registerKernelWrite(intent: KernelWriteIntent): Promise<KernelWriteRow>;
	markKernelWrite(id: string, state: KernelWriteState): Promise<void>;
}
export interface RepoCoreInternal {
	metaSync(key: RepoMetaKey): string | null;
	/**
	 * `meta.sim` without a read per call (kept in memory; it has no way
	 * back): the events log flags a swarm shard's appends `sim` (WP20).
	 */
	simulatedSync(): boolean;
	/** Sets `meta.sim` (inside a transaction); `markSimulated` gates it. */
	markSimulatedSync(): void;
	refSync(ref: string): RefRow | null;
	laneSync(laneId: string): LaneRow | null;
	/** Inserts the K1 intent row (call inside the same transaction as the step's state change). */
	registerKernelWriteSync(intent: KernelWriteIntent): KernelWriteRow;
	markKernelWriteSync(id: string, state: KernelWriteState): void;
	/** Sets `refs[ref] = sha` and upserts the matching `pushes(via='kernel')` row (completeAdvance). */
	applyKernelWriteSync(id: string): void;
	setLandingPausedSync(paused: boolean): void;
	setLaneStateSync(laneId: string, state: LaneState): void;
	/**
	 * The lane-transition rule: called by `events.appendSync` (WP6) for every
	 * appended non-shadow event whose type is in `LANE_EVENT_TRANSITIONS`, inside
	 * the same `transactionSync`; moves the lane per that table (WP5a). It also
	 * sets `lanes.change_id` from `changes.submitted`.
	 */
	applyLaneEventSync(event: Envelope): void;
	/**
	 * The match test on the canonical repo: true only when an open
	 * `kernel_writes` intent or an un-completed Advance on `ref` has exactly
	 * `new_sha = sha`. WP10's fail-closed `lock-n` and the capability state
	 * (`CapContext.explainedTips`) use it.
	 */
	explainsSync(ref: string, sha: string): boolean;
	/**
	 * One ref transition seen by reconciliation, through the same path as a
	 * trigger observation: merged into a matching push or kernel write
	 * (K1 matching on `(target, ref, new_sha)`), else parked in
	 * `pending_observations` (K1 for protected and kernel refs, K2 for a lane
	 * head or any ref of a lane's current repo). WP5b's lane-repo
	 * reconciliation calls it.
	 */
	observeSync(
		observation: {
			readonly target: "repo" | string;
			/** The exact lane repo read (`lanes.repo_name`), or null for the canonical repo. */
			readonly repoName: string | null;
			readonly ref: string;
			readonly before: string;
			readonly after: string;
		},
	): void;
	/**
	 * WP10's `completeAdvance` calls it inside its transaction: appends the
	 * landed commits to `trunk_commits` (`source:
	 * "advance"`, the next seqs, in trunk order) and adds the landed lanes'
	 * gateway-pushed bytes to `meta.trunk_pack_bytes`. WP5a.
	 */
	recordLandingSync(
		input: {
			readonly trunkCommits: readonly string[];
			readonly landedLaneIds: readonly string[];
		},
	): void;
}

/** events (WP6): the ordered, causal, hash-chained log. */
export interface RepoEventsFacade {
	/**
	 * Extensions via `caps.events.emit`. Caps enforces K10 `mayEmit` (it knows
	 * the manifest's `provides`); RepoDO re-checks the type namespace and the
	 * payload schema.
	 */
	append(input: AppendInput): Promise<AppendResult>;
	/** Envelopes by id, in log order; unknown ids are skipped. */
	get(ids: readonly string[]): Promise<Envelope[]>;
	read(
		query: {
			since: number;
			limit?: number;
			patterns?: string[];
			includeShadow?: boolean;
		},
	): Promise<Envelope[]>;
	head(): Promise<number>;
	verifyChain(
		fromSeq: number,
		toSeq: number,
	): Promise<{ ok: boolean; brokenAt?: number }>;
	/** Retention: prune unpinned events past 30 d (24 h for sim). */
	prune(now: number): Promise<{ deleted: number }>;
	/** Refresh the subscribers cache from the registry (on `ext_version` change). */
	refreshSubscribers(
		subscribers: SubscriberRow[],
		extVersion: number,
	): Promise<void>;
}
export interface RepoEventsInternal {
	/** Idempotent append inside the caller's `transactionSync` (K3). */
	appendSync(input: AppendInput): AppendResult;
	/** Ids from `ids` that exist in this log. */
	existingSync(ids: readonly string[]): string[];
	/** Envelopes by id (K4 validation reads types and payloads). */
	getSync(ids: readonly string[]): Envelope[];
	/** Marks reason-chain events as pinned (never pruned). */
	pinSync(ids: readonly string[]): void;
	headSync(): { seq: number; hash: string };
}

/** probe (WP8): RepoDO-side project graph cache. */
export interface RepoProbeFacade {
	projects(sha: string): Promise<ProjectGraph | null>;
	putProjects(graph: ProjectGraph): Promise<void>;
	/** The shared per-push path diff (also in R2 `diffs/`). */
	diffPaths(source: GitSource, base: string, head: string): Promise<PathDiff>;
}
export interface RepoProbeInternal {
	projectsSync(manifestsTreeSha: string): ProjectGraph | null;
}

/** runs (WP9). */
export interface RepoRunsFacade {
	/**
	 * Idempotent on `idemKey`; the run row is written before `RUNS.create`.
	 * `kind: "git"` graphs come only from kernel modules
	 * (`requestedBy: "kernel"`); caps passes extension CI graphs
	 * (`CiJobGraphSchema`). Artifacts write tokens are minted only for runs
	 * with `requestedBy: "kernel"` (K1, K11).
	 */
	start(
		input: { graph: JobGraph; idemKey: string; requestedBy: string },
	): Promise<{ runId: string }>;
	get(runId: string): Promise<RunStatus | null>;
	list(
		filter: { subject?: EntityRef; cursor?: string; limit?: number },
	): Promise<{ runs: RunStatus[]; cursor?: string }>;
	cancel(runId: string, by: string): Promise<void>;
	/** RunWorkflow callbacks. */
	setRunState(runId: string, state: RunState): Promise<void>;
	setJobState(
		runId: string,
		jobId: string,
		update: { state: JobState; exitCode?: number; logKey?: string },
	): Promise<void>;
	/** Log pump sink: tail + live broadcast. */
	jobLog(runId: string, jobId: string, chunk: string): Promise<void>;
	logs(runId: string, jobId: string, tailBytes?: number): Promise<string>;
}
export interface RepoRunsInternal {
	runSync(runId: string): RunRow | null;
}

/** A git author or committer (LandWorkflow's squash and notes commits). */
export type GitIdentity = {
	readonly name: string;
	readonly email: string;
};

/** The lane range of one change, as `git rev-list <head> ^<trunk>` listed it. */
export type ComposeRange = {
	readonly changeId: string;
	/** Newest first; capped by LandWorkflow. */
	readonly commits: readonly string[];
	/** The listing stopped at the cap. */
	readonly truncated: boolean;
};

/**
 * What the squash commits of one attempt are written with: RepoDO composes
 * the messages and identities from verified state (`composePlan`), after
 * LandWorkflow listed each lane range in git.
 */
export type ComposePlan = {
	/** Epoch seconds: the author and committer date of every squash commit. */
	readonly date: number;
	readonly committer: GitIdentity;
	readonly changes: readonly {
		readonly changeId: string;
		readonly laneId: string;
		readonly head: string;
		readonly message: string;
		readonly author: GitIdentity;
	}[];
};

/** One change's compose outcome (`recordCompose`). */
export type ComposedChange = {
	readonly changeId: string;
	readonly commit?: string;
	/** Paths the squash commit changed against its parent. */
	readonly paths?: readonly string[];
	/**
	 * The squash commit's root `*.cue` digest (`null` when it has none),
	 * computed for a change whose paths touch a policy path: the K13.2 check
	 * against the digest its sign-off names (ADR repo config).
	 */
	readonly policyDigest?: string | null;
	readonly conflict?: {
		readonly paths: readonly string[];
		readonly regions?: readonly {
			readonly path: string;
			readonly regions: readonly ConflictRegion[];
		}[];
		/** Changes already in the candidate (or trunk) at the conflict. */
		readonly conflictsWith?: readonly string[];
	};
};

/** land (WP10): batches, verdicts, the Advance and why notes. */
export interface RepoLandFacade {
	/**
	 * Idempotent on the caller-minted batchId; K4 + `landing_paused` validated;
	 * intent first. Every lane must be `submitted`. Grant checks
	 * (`land` covers the ref, queue@1 provider) happen in caps before this call.
	 * K4: a `gate.decided` counts as the approval only with `basis:
	 * "answer"`, and a `review.decided` only when its `head` (when present)
	 * equals the batch's `LandChange.head`.
	 */
	submit(
		request: LandRequest,
		requestedBy: string,
	): Promise<{ batchId: string; created: boolean }>;
	status(batchId: string): Promise<LandStatus | null>;
	/** The full batch for LandWorkflow: heads, messages, trailers, reason, test policy. */
	batch(batchId: string): Promise<LandBatchDetail | null>;
	/** K14: accepted only for the batch's current (attempt, candidateSha); first verdict wins. */
	report(
		batchId: string,
		verdict: LandVerdict,
		reportedBy: string,
	): Promise<{ accepted: boolean; reason?: string }>;
	contributeNote(
		changeId: string,
		extId: string,
		section: unknown,
	): Promise<void>;
	/**
	 * The squash messages and identities of an attempt, composed from the
	 * batch's verified state and the lane ranges LandWorkflow listed.
	 */
	composePlan(
		batchId: string,
		attempt: number,
		ranges: readonly ComposeRange[],
	): Promise<ComposePlan>;
	/** LandWorkflow step bookkeeping. */
	recordCompose(
		batchId: string,
		attempt: number,
		candidateSha: string,
		perChange: readonly ComposedChange[],
	): Promise<void>;
	recordGates(
		batchId: string,
		attempt: number,
		decisions: unknown[],
	): Promise<void>;
	setBatchState(
		batchId: string,
		state: LandBatchState,
		result?: unknown,
	): Promise<void>;
	nextAttempt(
		batchId: string,
		reason: "stale" | "vetoed",
	): Promise<{ attempt: number } | { exhausted: true }>;
	/**
	 * Idempotent per (batch, attempt); `{wait}` while another batch holds the
	 * ref's K5 lock; `{ejected}` when a policy change's sign-off no longer
	 * stands at the lock (K13.3: revoked, replaced, or its signer is no
	 * longer Maintainer+), those changes vetoed: the workflow starts the
	 * next attempt.
	 */
	beginAdvance(
		batchId: string,
		attempt: number,
		instanceId: string,
		options?: {
			/** The remote trunk the workflow just read; omitted ⇒ RepoDO reads a fresh ref advertisement. */
			expectOld?: string;
		},
	): Promise<
		{ advanceId: string; expectOld: string } | { wait: true } | {
			ejected: readonly string[];
		}
	>;
	/**
	 * Records a sub-step and, in the same transaction, the K1 intents of the
	 * pushes that step is about to make (restack-n registers notes and
	 * change-ref intents with their old/new SHAs).
	 */
	markAdvanceStep(
		advanceId: string,
		step: AdvanceStep,
		update?: {
			newSha?: string;
			evidenceReused?: boolean;
			intents?: readonly KernelWriteIntent[];
		},
	): Promise<void>;
	/** Idempotent; accepts refs[ref] ∈ {expect_old, new}. */
	completeAdvance(advanceId: string): Promise<void>;
	/**
	 * K13.1 (WP23): whether lands of this repo wait for repository config
	 * to resolve; LandWorkflow sleeps on it before testing, outside the K5
	 * lock and without using a land attempt.
	 */
	configHold(): Promise<{ held: boolean; reason?: string }>;
	releaseAdvance(advanceId: string, reason: string): Promise<void>;
	verdict(
		batchId: string,
		attempt: number,
		candidateSha: string,
	): Promise<LandVerdictRow | null>;
	/** Builds the why note for a landed change (kernel + extension sections). */
	whyNote(advanceId: string, changeId: string): Promise<WhyNote>;
	why(
		query: { sha?: string; path?: string; line?: number },
	): Promise<
		{ commit: string; note: WhyNote | null; events: Envelope[] } | null
	>;
	/** Stores a replay's results (`gate_replays`), started by RegistryFacade.replayGate. */
	recordReplay(
		replay: {
			id: string;
			installationId: string;
			results: {
				advanceId: string;
				changeId: string;
				decision: "allow" | "advise" | "veto";
				message: string;
			}[];
			state: "running" | "done" | "error";
		},
	): Promise<void>;
	replay(replayId: string): Promise<GateReplayRow | null>;
	/** `GET /-/api/advances`: this repo's advances, newest first. */
	advances(
		filter: { readonly cursor?: string; readonly limit?: number },
	): Promise<AdvancesResponse>;
	/**
	 * Dev-only audited seeding (dev tools only, else `not_found`):
	 * `count` (1–100) labelled `done` Advances on trunk, one commit each,
	 * pushed through the K1 ledger (purpose `seed`); two of them add a `.env`
	 * file with AWS's documented example key, for the gate replay.
	 */
	seedHistory(
		input: { count: number; actor: Actor },
	): Promise<{
		readonly advances: number;
		/** Trunk's tip after the seed. */
		readonly head: string;
		/** 1-based positions of the Advances whose commit carries a fake key. */
		readonly withFakeKeys: readonly number[];
	}>;
}
export interface RepoLandInternal {
	inflightAdvanceSync(ref: string): AdvanceRow | null;
	advanceSync(advanceId: string): AdvanceRow | null;
	landingsSinceSync(trunkSeq: number): LandingRow[];
	/**
	 * The landing of a lane (its `change_id` and `lane_head`), or null: lane
	 * GC's change-ref precondition for a landed `repo` lane.
	 */
	landingByLaneSync(laneId: string): LandingRow | null;
}

// ---------------------------------------------------------------------------
// repoconfig (WP23, 400–429; ADR repo config)
// ---------------------------------------------------------------------------

/** How a lane's range relates to the policy paths (K13.3). */
export type PolicyTouch = "touched" | "clean" | "unknown";

/** A kernel-recorded sign-off, as the land checks read it. */
export type PolicySignoffRef = {
	readonly eventId: string;
	readonly signedBy: string;
	/** The root `*.cue` digest the signer approved (null: none at the head). */
	readonly policyDigest: string | null;
};

/** One landed change of an Advance, for the K13.1 decision. */
export type AdvanceLanded = {
	readonly changeId: string;
	readonly laneId: string;
	readonly head: string;
	/** The squash commit on trunk (its `trunk_commits` seq keys the config row). */
	readonly commit: string;
	/** The squash commit's paths; `null` when unknown. */
	readonly paths: readonly string[] | null;
	/** The path list reached its cap (counts as touching). */
	readonly capped: boolean;
};

/** The trunk config in force at a trunk position (`policyAtSync`). */
export type RepoPolicyAt =
	| {
		readonly state: "ok";
		/** The trunk commit of the row read. */
		readonly sha: string;
		/** Absent when the last good config is "no config" (`{}`). */
		readonly inputKey?: string;
		readonly exact: boolean;
		/** The resolved JSON of the row read (repository-controlled). */
		readonly resolved: unknown;
		/** With `exact: false`: the newer row that failed (or is pending under keep-last-good). */
		readonly failed?: RepoConfigTrunkRowDto;
	}
	| { readonly state: "none" }
	| { readonly state: "pending"; readonly lastGood: RepoPolicyAt | null }
	| { readonly state: "expired" };

export interface RepoConfigFacade {
	/** This repo's config head (the settings page merges ForgeDO's rows into it). */
	state(): Promise<RepoConfigHeadDto>;
	evaluation(inputKey: string): Promise<RepoConfigEvalDto | null>;
	/** Requests a lane preview; answers at once (`evaluating` or a cached result). */
	preview(laneId: string, requestedBy: string): Promise<RepoConfigPreviewDto>;
	previewOf(laneId: string): Promise<RepoConfigPreviewDto | null>;
	previewByKey(inputKey: string): Promise<RepoConfigPreviewDto | null>;
	/**
	 * K13.3: records a Maintainer+ session user's sign-off of a lane head.
	 * The caller (HTTP) has checked the session and the role; RepoDO
	 * re-reads the head by SHA and binds the sign-off to its root `*.cue`
	 * digest.
	 */
	signOff(
		laneId: string,
		input: PolicySignoffRequest,
		signer: string,
	): Promise<PolicySignoffDto>;
	revokeSignOff(laneId: string, head: string, by: string): Promise<void>;
	/** A Maintainer+ session user's explicit apply of trunk's config (`needs-apply`). */
	apply(sha: string, by: string): Promise<RepoConfigHeadDto>;
	/** Re-evaluates trunk's config (Maintainer+; audited, rate-limited). */
	reevaluate(by: string): Promise<RepoConfigHeadDto>;
	/** An Owner's `keep-last-good` (releases the hold until the next resolution), or `clear`. */
	override(
		action: "keep-last-good" | "clear",
		by: string,
	): Promise<RepoConfigHeadDto>;
	/**
	 * The sandbox sink: caches the envelope and wakes the state
	 * machine. `origin` is the role of the sandbox that answered (`trunk`
	 * for `cue:trunk`, `preview` for `cue:preview:<k>`): a preview's answer
	 * never resolves a trunk job, and never overwrites a trunk-origin cache
	 * entry.
	 */
	cueResult(
		inputKey: string,
		envelope: EvalResponse,
		origin?: "trunk" | "preview",
	): Promise<void>;
	/** ForgeDO's poke after a registry change. */
	registryChanged(epoch: number): Promise<void>;
	/**
	 * `caps.repo.policy` (ADR repo config, K13): the `keys` of `extId`'s entry in
	 * the trunk config in force at `at`, a commit in `trunk_commits`; any
	 * other sha is `denied("policy-not-trunk")`. Never runs CUE, never waits.
	 */
	policy(
		at: string,
		extId: string,
		keys: readonly string[],
	): Promise<RepoPolicyAnswer>;
	/**
	 * RepoProbe: the configured projects and global files at a commit's
	 * trunk base (the commit itself when it is on trunk). `needsBase` asks
	 * the probe to walk to the merge base and call again with it.
	 */
	projectConfig(sha: string): Promise<ProjectConfigAnswer>;
	/** The trunk config history, newest first (settings page, MCP). */
	trunkHistory(limit?: number): Promise<RepoConfigTrunkRowDto[]>;
}

export interface RepoConfigInternal {
	/** `TARTAN_REPO_CONFIG` is on. */
	enabledSync(): boolean;
	/**
	 * WP10, inside `completeAdvanceSync`: a landed policy path (or an
	 * unknown or capped path list) makes the head `pending` and holds lands
	 * (K13.1); otherwise nothing changes.
	 */
	onAdvanceSync(input: {
		readonly sha: string;
		readonly changes: readonly AdvanceLanded[];
	}): void;
	/** Every appended repo event (WP6's append hook, inside its transaction). */
	observeSync(event: Envelope): void;
	/** Whether a lane head's range touches a policy path, from its `push.diffed`. */
	policyTouchSync(laneId: string, head: string): PolicyTouch;
	/** The unrevoked sign-off of a lane head, or null. */
	signoffSync(laneId: string, head: string): PolicySignoffRef | null;
	/**
	 * The trunk config in force at trunk position `seq` (ADR repo config):
	 * `policyAt(seq)` of the ADR, for in-DO readers.
	 */
	policyAtSync(seq: number): RepoPolicyAt;
	/**
	 * K13.1: whether lands of this repo wait (`pending`, or ForgeDO's
	 * `gate-missing`). `forgeHold` is ForgeDO's hold read just now
	 * (`registry.landContext`), with its generation `forgeHoldId`; it is
	 * recorded and used instead of the copy the last evaluation saw.
	 */
	holdSync(forgeHold?: string | null, forgeHoldId?: number): {
		readonly held: boolean;
		readonly reason?: "pending" | "gate-missing";
	};
}

/** The RepoDO RPC surface (thin class; WP0). */
export interface RepoDoApi {
	core(): RepoCoreFacade;
	events(): RepoEventsFacade;
	probe(): RepoProbeFacade;
	runs(): RepoRunsFacade;
	land(): RepoLandFacade;
	repoconfig(): RepoConfigFacade;
}

export type RepoModuleName =
	| "core"
	| "events"
	| "probe"
	| "runs"
	| "land"
	| "repoconfig";
export type RepoInternals = {
	readonly core: RepoCoreInternal;
	readonly events: RepoEventsInternal;
	readonly probe: RepoProbeInternal;
	readonly runs: RepoRunsInternal;
	readonly land: RepoLandInternal;
	readonly repoconfig: RepoConfigInternal;
};

/**
 * The `core` timer key prefix of the seed watchdog (`seed:<laneId>`); WP5a's
 * `core` timer handler routes every key with it to `RepoBackend.onSeedTimer`.
 */
export const SEED_TIMER_PREFIX = "seed:" as const;
export const seedTimerKey = (laneId: string): string =>
	`${SEED_TIMER_PREFIX}${laneId}`;

/** Timer users in RepoDO: `_timers.module` → key prefixes. */
export const REPO_TIMERS = {
	/**
	 * `seed:<laneId>` is the lane-repo seeder's watchdog, one per `opening`
	 * lane, scheduled at the current attempt's `seed_deadline` (never at
	 * "now"); its handler probes and fences only, ≤ 3 s, and never throws.
	 */
	core: ["lease", "outbox", "observe", "diff", "seed"],
	/**
	 * `k5`: the Advance lease sweeper; `outbox`: retries `LAND.create` for a
	 * batch whose instance is not yet created; `candidates`: deletes candidate
	 * refs 24 h after their batch ended.
	 */
	land: ["k5", "outbox", "candidates"],
	/**
	 * `eval`: trunk-side evaluation (reads, key, cache, dispatch); `apply`:
	 * the fenced apply intents; `jobs`: the evaluation deadlines; `previews`:
	 * lane previews. None ever awaits an evaluation.
	 */
	repoconfig: ["eval", "apply", "jobs", "previews"],
} as const;
