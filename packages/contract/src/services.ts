// Cross-module kernel services. Kernel-only. Each is a
// Worker-side module with a `createX(env)` factory and an M0 stub that
// rejects `not_implemented`, so consumers compile against the signature and
// fake it until the owner merges:
//
// | Service         | Owner               | Stub                                          | Consumers                       |
// |-----------------|---------------------|-----------------------------------------------|---------------------------------|
// | `ExtDispatch`   | WP7b                | `src/kernel/exthost/host/dispatch.ts`         | WP4, WP5a, WP10, WP11           |
// | `RepoProbeApi`  | WP8                 | `src/kernel/probe/entrypoint.ts`              | WP3, WP5a, WP7b, WP10           |
// | `KernelGitJobs` | WP10                | `src/kernel/land/gitjobs.ts`                  | WP3 (genesis), WP5a, WP5b, WP10 |
// | `LaneBackend`   | WP5a (`repo`: WP5b) | `src/kernel/repo/lanes/` (`repo-backend/`)    | WP5a (RepoDO core)              |
// | `RepoBackend`   | WP5b                | `src/kernel/repo/lanes/repo-backend/index.ts` | WP5a (RepoDO core module)       |
// | `LaneSelfTest`  | WP5b                | `src/kernel/repo/lanes/repo-backend/index.ts` | WP5b's Owner route, WP18        |
// | `CronTask`      | each                | `src/cron.ts` registry                        | the 5-minute cron               |
//
// None of them is ever called inside `transactionSync`: they await RPC into
// DOs (including back into the caller's own DO). The exceptions are the
// synchronous members of `RepoBackend` (`planOpening`, `startAttempt`), which
// run inside RepoDO core.

import type {
	LaneSelfTestResult,
	RepoLaneSettingsDto,
	RepoLaneSettingsRequest,
} from "./api.ts";
import type { Actor, ActorBounds, GitSource } from "./common.ts";
import type { Envelope } from "./events.ts";
import type {
	EffectiveGateDecision,
	GateCall,
	GateInput,
	GatePoint,
} from "./gates.ts";
import type {
	AddedLine,
	Affected,
	FileDiff,
	FileHunks,
	Merge3Input,
	Merge3Result,
	PathDiff,
	ProjectGraph,
} from "./git.ts";
import type { DefinedInterfaceId, ToolDef } from "./interfaces.ts";
import type {
	ArchiveResult,
	LaneBackendName,
	LaneSeed,
	LaneSeedFailCode,
	LaneSeedPhase,
	SyncResult,
} from "./lanes.ts";
import type { ToolContribution } from "./manifest.ts";
import type { ContextPack, KernelToolName } from "./mcp.ts";
import type { RepoStore } from "./ports.ts";
import type { CapMac } from "./security.ts";
import type { ModuleDeps, TimerHandler } from "./do/common.ts";
import type {
	AuthContext,
	InstallationInForce,
	TreeFacade,
} from "./do/forge.ts";
import type {
	DiffResult,
	KernelWriteIntent,
	LaneRepoReconcileRun,
	LaneRow,
	RepoCoreFacade,
	RepoCoreInternal,
	RepoInternals,
	SweepResult,
	Upstream,
	UpstreamTarget,
} from "./do/repo.ts";

// ---------------------------------------------------------------------------
// Extension fan-out (WP7b)
// ---------------------------------------------------------------------------

/** Where a fan-out happens: the node whose installations are in force, and the repo. */
export type DispatchAt = { readonly nodeId: string; readonly repoId: string };

export type GateDispatchResult = {
	/** One per gate in force at `at` for the point (enforce and shadow), with its manifest timeout, default and onTruncated. */
	readonly calls: readonly GateCall[];
	/** `effectiveGateDecision(call, input.truncated)` for each call (K8). */
	readonly effective: readonly EffectiveGateDecision[];
	/** `aggregateGates(effective).blocked`: any enforce veto. */
	readonly blocked: boolean;
};

/** `context_get` after the MCP host resolved the repo and checked the role. */
export type ContextAssemblyRequest = {
	readonly repo: {
		readonly id: string;
		readonly path: string;
		readonly nodeId: string;
	};
	readonly work?: string;
	readonly laneId?: string;
	readonly paths?: readonly string[];
	readonly budgetTokens?: number;
	readonly actor: Actor;
};

/** Where an MCP tool call goes (WP11 routes; WP7b resolves). */
export type ResolvedTool =
	| { readonly kind: "kernel"; readonly name: KernelToolName }
	| {
		readonly kind: "interface";
		readonly iface: DefinedInterfaceId;
		readonly def: ToolDef;
		/** The provider in force at the scope (nearest, honouring locked ancestors). */
		readonly provider: InstallationInForce;
	}
	| {
		readonly kind: "extension";
		readonly contribution: ToolContribution;
		readonly installation: InstallationInForce;
	};

/**
 * WP7b, created with `createExtDispatch(env)`. Installation lookup,
 * per-gate timeouts and defaults, K8 monotonicity and the truncation default
 * live here once.
 */
export interface ExtDispatch {
	/**
	 * Every gate in force at `at` for `point`, in parallel; never throws for a
	 * gate's failure (timeouts and errors become outcomes). Shadow decisions
	 * never block. The caller records `gate.decided` (with `basis`):
	 * LandWorkflow via `recordGates`, RepoDO core for `lane.open`, the gateway
	 * for `push`.
	 */
	gates(
		point: GatePoint,
		input: GateInput,
		at: DispatchAt,
	): Promise<GateDispatchResult>;
	/**
	 * Echo hooks for a `push.accepted` in force at `at`, with their declared
	 * inputs prefetched (from the shared R2 lane-range diff of `push.diffed`), within
	 * `budgetMs` (≤ `ECHO_LIMITS.totalBudgetMs`); sanitized, prefixed lines.
	 * `[]` on timeout.
	 */
	echo(event: Envelope, at: DispatchAt, budgetMs?: number): Promise<string[]>;
	/** The `context_get` assembler: fan-out ≤ 8 contributors, 300 ms each, budget ranking. */
	context(
		req: ContextAssemblyRequest,
		bounds: ActorBounds,
	): Promise<ContextPack>;
	/** Tool names visible at an MCP scope for this caller (tools/list). */
	tools(
		scopeNodeId: string,
		auth: AuthContext,
	): Promise<{ name: string; description: string; inputSchema: unknown }[]>;
	/** Routes one tool name at an MCP scope; null when unknown there. */
	resolveTool(
		scopeNodeId: string,
		name: string,
		auth: AuthContext,
	): Promise<ResolvedTool | null>;
}
/**
 * `host` is the caller's `ctx` (its `exports` reach RepoProbe and the other
 * loopback entrypoints); module-level exports are used without it (WP7b).
 */
export type CreateExtDispatch<Env> = (
	env: Env,
	host?: { readonly exports: unknown },
) => ExtDispatch;

// ---------------------------------------------------------------------------
// RepoProbe (WP8)
// ---------------------------------------------------------------------------

/** `RepoProbeApi.diff` options. */
export type DiffOptions = {
	/** Also build each text file's unified patch (`FileDiff.patch`). */
	readonly patch?: boolean;
};

/** `addedLines` caps (defaults: `GATE_INPUT_LIMITS`). */
export type AddedLinesLimits = {
	readonly lines: number;
	readonly bytes: number;
};

/**
 * The `RepoProbe` WorkerEntrypoint's RPC surface, reached as
 * `ctx.exports.RepoProbe` (typed by `src/exports.ts`). Stateless and
 * cacheable. Every method takes repo-scoped arguments (a `GitSource`, a
 * repo id) and resolves the Artifacts repo itself through
 * `RepoCoreFacade.upstream`; SHAs are resolved only within that repo family.
 * Kernel callers only: extensions reach these through caps, which
 * applies K12 first.
 */
export interface RepoProbeApi {
	/**
	 * The one diff per push, phase 2 of push recording: the K17
	 * walk finds `rangeBase` (the merge base of `after` with trunk, ≤ 500
	 * commits, by SHA) inside the repo that holds `after` (the lane repo of a
	 * `repo` lane), then stores the `PushDiff` of `rangeBase..after` at R2
	 * `diffKey(repoId, rangeBase, after)` (with added lines when asked). The
	 * result goes to `RepoCoreFacade.recordDiff`.
	 */
	laneDiff(
		source: GitSource,
		after: string,
		options?: { readonly addedLines?: boolean },
	): Promise<DiffResult>;
	diffPaths(source: GitSource, base: string, head: string): Promise<PathDiff>;
	hunks(
		source: GitSource,
		base: string,
		head: string,
		paths: readonly string[],
	): Promise<FileHunks[]>;
	/** ≤ `MERGE3_MAX_PER_CALL`; `Merge3Input.repoId` names the repo family. */
	merge3(input: readonly Merge3Input[]): Promise<Merge3Result[]>;
	/**
	 * File diffs of `a..b` (diff-of-diffs, browse). With `{patch: true}` each
	 * text file also carries its unified `patch`, within `PATCH_LIMITS`, or
	 * the reason it does not (`patchOmitted`).
	 */
	diff(
		a: GitSource & { readonly sha: string },
		b: GitSource & { readonly sha: string },
		options?: DiffOptions,
	): Promise<FileDiff[]>;
	projectGraph(repoId: string, sha: string): Promise<ProjectGraph>;
	/**
	 * `graphAt` recomputes on the project graph at that commit (K6);
	 * default `head`.
	 */
	affected(
		repoId: string,
		base: string,
		head: string,
		options?: { readonly source?: GitSource; readonly graphAt?: string },
	): Promise<Affected>;
	treeHash(
		source: GitSource,
		sha: string,
		path: string,
	): Promise<string | null>;
	/** Added lines for `ref.advance` gate inputs and echo, capped (`truncated`). */
	addedLines(
		source: GitSource,
		base: string,
		head: string,
		limits?: AddedLinesLimits,
	): Promise<{ lines: AddedLine[]; truncated: boolean }>;
}

// ---------------------------------------------------------------------------
// Kernel git jobs (WP10)
// ---------------------------------------------------------------------------

export type GenesisInput = {
	readonly defaultBranch: string;
	readonly message: string;
	readonly author: { readonly name: string; readonly email: string };
};

/**
 * WP10, created with `createKernelGitJobs(env)`. Each job registers its K1
 * intent in `kernel_writes` (through `RepoCoreFacade.registerKernelWrite`)
 * before pushing and marks it `pushed` after, with the purpose named
 * below. All are idempotent: a job that finds the remote
 * already at its target returns success. Jobs that fetch lane heads get
 * their `LaneFetchSpec`s from `RepoCoreFacade.laneFetchSpecs`.
 */
export interface KernelGitJobs {
	/**
	 * The first commit on the default branch of a created repo, written
	 * in the Worker with `packages/gitproto`'s pack writer (WP22), no
	 * container; purpose `genesis`, recorded as advance #0. Called by
	 * `TreeFacade.createRepo` (WP3) after `ARTIFACTS.create`.
	 */
	genesis(repoId: string, input: GenesisInput): Promise<{ commit: string }>;
	/**
	 * Ref-only kernel writes in the Worker, no container (`change-ref`,
	 * `attic`, `lane-gc`, `purge`, candidate deletion): each intent is
	 * registered before the write and marked after it; a ref create of an
	 * object the repo already holds sends an empty pack. One result per
	 * intent, in order (`ok: false` with the upstream `ng` reason, e.g. a CAS
	 * miss).
	 */
	refWrite(
		repoId: string,
		intents: readonly KernelWriteIntent[],
	): Promise<
		readonly {
			readonly ref: string;
			readonly ok: boolean;
			readonly reason?: string;
		}[]
	>;
	/**
	 * The git half of archiving a lane, behind
	 * `RepoCoreFacade.archiveLane`. With `gateFirst`, the `ref.advance` gates
	 * run advisory first and a veto keeps only the summary. `branch`:
	 * writes the attic ref `atticRef` (purpose `attic`) unless vetoed. `repo`:
	 * no git write and no deletion; it only reports `vetoed`. The `repo`
	 * backend's outcome (keep the lane repo until `delete_after`, or delete it
	 * at once on a veto or at the forge ceiling, and the index state) is
	 * WP5b's alone (`RepoBackend.archive`).
	 */
	archive(
		repoId: string,
		laneId: string,
		options: { readonly atticRef?: string; readonly gateFirst: boolean },
	): Promise<ArchiveResult & { readonly vetoed: boolean }>;
	/**
	 * M2: server-side rebase onto trunk, `--force-with-lease` to the lane
	 * (purpose `lane-sync`). Fetches from two repos on the `repo` backend
	 * (trunk from the canonical repo, the lane from its lane repo). Behind
	 * `syncLane`.
	 */
	sync(repoId: string, laneId: string): Promise<SyncResult>;
	/** M2: rebase onto another lane's head (purpose `lane-sync`), fetching from both lanes' repos. Behind `restackLane`. */
	restack(repoId: string, laneId: string, onto: string): Promise<SyncResult>;
	/**
	 * The K5 sweeper's repair of an advance whose trunk push landed but whose
	 * notes or change refs did not (purposes `notes`, `change-ref`); runs as
	 * the `repair-<advanceId>` git run. Re-fetches any missing `repo`-lane
	 * head from its lane repo (`RepoCoreFacade.laneFetchSpecs`) before pushing
	 * change refs.
	 */
	repair(repoId: string, advanceId: string): Promise<void>;
}
export type CreateKernelGitJobs<Env> = (env: Env) => KernelGitJobs;

// ---------------------------------------------------------------------------
// Lane backends (WP5a facade + `branch`; WP5b `repo`)
// ---------------------------------------------------------------------------

/**
 * How a sandbox exec fetches a lane head by SHA: the remote and the repo whose
 * read token the exec mints for itself (tokens never travel in params).
 * Callers outside RepoDO (WP9 mirror fetches, WP10 compose, sync, restack,
 * repair) get them from `RepoCoreFacade.laneFetchSpecs`.
 */
export type LaneFetchSpec = {
	readonly remote: string;
	readonly sha: string;
	readonly token: { readonly artifactsName: string; readonly scope: "read" };
};

/**
 * Lane GC's verdict: `head-moved` → K2 instead;
 * `missing` = the lane repo or ref is already gone (the `lane-delete` intent
 * matches `main → zeros`; the lane still moves to `deleted`);
 * `change-ref-missing` = a landed `repo` lane's `refs/tartan/changes/<id>` is
 * not in the canonical index yet, so GC defers (alerting after
 * `LANE_GC_DEFER_ALERT_MS`).
 */
export type LaneGcOutcome =
	| { readonly deleted: true }
	| {
		readonly deleted: false;
		readonly reason: "head-moved" | "missing" | "change-ref-missing";
	};

/**
 * The storage behind a lane. Runs inside RepoDO core. Opening
 * is not a backend method: a `branch` lane needs no storage call (the ref
 * appears on the owner's first push), and a `repo` lane is seeded by
 * `RepoBackend` (`planOpening` in the open transaction, then `startAttempt`).
 */
export interface LaneBackend {
	readonly name: LaneBackendName;
	/** The lane's `Upstream`, with a token scoped to that one repo (the lane repo, or canonical for `branch`). */
	remoteFor(lane: LaneRow, scope: "read" | "write"): Promise<Upstream>;
	/**
	 * The lane head upstream: `refs/heads/main` of the lane repo (`repo`) or
	 * `refs/heads/lanes/<id>` (`branch`). `null` = the repo is missing or has
	 * no `main` (read as zeros).
	 */
	readTip(lane: LaneRow): Promise<string | null>;
	/** In-DO; `RepoCoreFacade.laneFetchSpecs` serves it to callers outside RepoDO. */
	fetchSpec(lane: LaneRow, sha: string): LaneFetchSpec;
	/** Deletes the lane repo (`lane-delete`) or the lane ref (`lane-gc`) only at `expectHead`. */
	gc(lane: LaneRow, expectHead: string): Promise<LaneGcOutcome>;
}

// ---------------------------------------------------------------------------
// The `repo` backend inside RepoDO core (WP5b)
//
// The split, transaction by transaction:
// - WP5a owns the open transaction (K16, caps, gates, the row, the
//   `lane-seed` intent, the watchdog, ⇒ `lane.opening`), the close CAS
//   (fencing an `opening` lane), the `awaitLane` waiters, the `branch`
//   backend, `gcLanes` and the facade itself.
// - WP5b owns every transition from an attempt's start to `open` or the
//   `branch` fallback (the attempt CAS, phases, failure, the fallback CAS,
//   the breaker), with their events (`lane.seed_failed`, `lane.opened`,
//   `lane.mode_degraded`), plus the capability state, the orphan sweep,
//   lane-repo reconciliation, the `repo` backend's GC, archive and purge,
//   and the lane settings.
// WP5a's `core` module creates the backend with `createRepoBackend(deps)`
// and delegates to it; the module accepts an injected factory so either side
// can test against a fake of the other.
// ---------------------------------------------------------------------------

/**
 * The per-RepoDO bucket every Artifacts control-plane call goes through
 * (`create`, `import`, `delete`, `createToken`, `revokeToken`, `list`;
 * `ARTIFACTS_CONTROL_PER_S_REPO`). WP5a owns it.
 */
export interface ArtifactsControlBucket {
	/** Resolves when a slot is free. */
	take(): Promise<void>;
	/** A 429 or rate-limit answer: pause the bucket (1 s, 2 s, 4 s …). */
	backoff(): void;
}

/** What WP5a's `core` module lends the `repo` backend (in-DO). */
export interface RepoBackendCoreHost {
	/**
	 * WP5a's synchronous internal API (`metaSync`, `laneSync`,
	 * `registerKernelWriteSync`, `markKernelWriteSync`, `explainsSync`,
	 * `observeSync`, …); each call joins the caller's `transactionSync`.
	 */
	readonly internal: RepoCoreInternal;
	/** The memory-only upstream token cache (`RepoCoreFacade.upstream`; K11). */
	upstream(target: UpstreamTarget, scope: "read" | "write"): Promise<Upstream>;
	readonly control: ArtifactsControlBucket;
	/**
	 * Resolves the `awaitLane` waiters of `laneId`. Call after the
	 * transaction that moved the lane out of `opening` has committed.
	 */
	releaseLaneWaiters(laneId: string): void;
}

/**
 * Everything the `repo` backend gets: the `core` module's `ModuleDeps`
 * (`sql`, `ctx`, `env`, `clock`, `ids`, the `core` timers bound to the
 * module, and the sibling internals: `modules.events.appendSync` for its
 * events, `modules.land.inflightAdvanceSync` for the attempt base,
 * `modules.land.landingByLaneSync` for GC) plus the ports below.
 */
export type RepoBackendDeps<Env = unknown> =
	& ModuleDeps<Env, RepoInternals>
	& {
		readonly core: RepoBackendCoreHost;
		/** `env.ARTIFACTS` (FakeArtifacts in tests). */
		readonly artifacts: RepoStore;
		/** ForgeDO's tree facade: `indexArtifacts` (index first, the ceiling), `countLaneRepos`. */
		forgeTree(): TreeFacade;
		/** WP10: `refWrite`. */
		readonly gitJobs: KernelGitJobs;
		/** WP2: signs the capability URL. */
		readonly capMac: CapMac;
		/**
		 * The forge's `canonical_origin` (ForgeDO setup state, cached), the
		 * host Artifacts' importer pulls the capability URL from.
		 */
		canonicalOrigin(): Promise<string>;
	};

/**
 * The columns WP5a's open transaction writes for a new lane,
 * as WP5b decides them inside that transaction (no I/O): the first seed after
 * the breaker, the size flags, the rendered fallback chain and the ceiling
 * estimate; attempt 1's name, nonce, phase, deadline and base. `branch` =
 * open on the `branch` backend at once (`reason` when the repo's mode is not
 * `branch` itself).
 */
export type LaneOpeningPlan =
	| {
		readonly mode: "repo";
		readonly seed: LaneSeed;
		readonly seedPhase: LaneSeedPhase;
		readonly seedDeadline: number;
		readonly repoName: string;
		readonly capNonce: string;
		/** The attempt base (the index tip, or an un-completed Advance's `new_sha`). */
		readonly base: string;
	}
	| {
		readonly mode: "branch";
		readonly reason?: LaneSeedFailCode | "degraded";
	};

/**
 * WP5b's entry points, created once per RepoDO by `createRepoBackend(deps)`.
 * The facade methods marked WP5b in `RepoCoreFacade` delegate here after
 * WP5a's K16 check, where one applies.
 */
export interface RepoBackend {
	/** The `repo` implementation of `LaneBackend`. */
	readonly backend: LaneBackend;
	/** Inside WP5a's open transaction (synchronous, no I/O). */
	planOpening(laneId: string, now: number): LaneOpeningPlan;
	/**
	 * After the open transaction committed: starts attempt 1 detached
	 * (`ctx.waitUntil`). Never awaited by `openLane`, never throws.
	 */
	startAttempt(laneId: string): void;
	seedLane: RepoCoreFacade["seedLane"];
	/** The `seed:<laneId>` watchdog: WP5a's `core` timer handler routes every `seed:` key here. */
	onSeedTimer: TimerHandler;
	redriveSeeds: RepoCoreFacade["redriveSeeds"];
	capContext: RepoCoreFacade["capContext"];
	capUse: RepoCoreFacade["capUse"];
	capReport: RepoCoreFacade["capReport"];
	/**
	 * After K16 and WP10's advisory gates: keep the lane repo until now + the
	 * repo's attic retention (`delete_after`), or delete it at once on a veto
	 * or at the forge ceiling; updates the index row. WP5a records the
	 * returned `ArchiveResult` in `lane.archived`.
	 */
	archive(
		laneId: string,
		o: { readonly vetoed: boolean },
	): Promise<ArchiveResult>;
	/** After K16 `purge`: deletes the lane repo at once (`purge` intent first). */
	purge(laneId: string): Promise<void>;
	sweepLaneRepos(names: readonly string[], now: number): Promise<SweepResult>;
	reconcileLaneRepos(now: number): Promise<LaneRepoReconcileRun>;
	laneSettings(): Promise<RepoLaneSettingsDto>;
	/** After WP5a's Owner check. */
	setLaneSettings(input: RepoLaneSettingsRequest): Promise<RepoLaneSettingsDto>;
}
export type CreateRepoBackend<Env> = (
	deps: RepoBackendDeps<Env>,
) => RepoBackend;

/**
 * WP5b's post-claim lane-repo self-test: one scratch
 * lane through the real seeder and capability route; never changes
 * `LANE_MODE`.
 */
export type LaneSelfTest<Env> = (
	env: Env,
	by: string,
) => Promise<LaneSelfTestResult>;

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

/**
 * One 5-minute cron entry. `src/cron.ts` runs every registered task
 * per tick, each in its own try/catch, so one failure never skips another.
 * Owners: WP5a `repo` (reconciliation of the canonical repo and `branch`-lane
 * refs, lane GC of both backends through `gcLanes`, the outbox), WP5b
 * `repoBackend` (`redriveSeeds`, `reconcileLaneRepos` by exact name, paced,
 * and the orphan sweep of `l-*` lane repos through `sweepLaneRepos`), WP6
 * (retention, known_head recovery), WP2 (IdP metadata refresh), WP7b
 * (dead-letter retries).
 */
export type CronTask<Env> = (
	env: Env,
	ctx: ExecutionContext,
	now: number,
) => Promise<void>;
