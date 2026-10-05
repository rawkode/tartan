// Lanes (K2, K7, K16, K17).
//
// A lane is a RepoDO row plus its storage, which a `LaneBackend` provides
// (`services.ts`): the `repo` backend gives each lane its own Artifacts repo,
// created with `import()` from the capability URL; the `branch` backend keeps
// the lane as `refs/heads/lanes/<id>` in the canonical repo (the fallback).

import { z } from "zod";
import {
	EntityRefSchema,
	FootprintSchema,
	LaneIdSchema,
	PrincipalIdSchema,
	RefNameSchema,
	ShaSchema,
	UlidSchema,
} from "./common.ts";
import type { ConflictRegion } from "./git.ts";

/**
 * Lane states. `opening` exists only on the `repo` backend,
 * until the seed is verified: pushes get `lane-opening`, and K7 (lease
 * expiry) never fires on it (the lease is set on the `opening` row and again
 * at open).
 */
export const LANE_STATES = [
	"opening",
	"open",
	"submitted",
	"landing",
	"landed",
	"closed",
	"lost",
	"archived",
	"deleted",
] as const;
export const LaneStateSchema = z.enum(LANE_STATES);
export type LaneState = z.infer<typeof LaneStateSchema>;

/**
 * `lane`: opened for a unit of work. `adopted`: a human branch taken over by
 * `changes_open {sourceRef}` (always on the `branch` backend; lane GC never
 * deletes its ref).
 */
export const LaneKindSchema = z.enum(["lane", "adopted"]);
export type LaneKind = z.infer<typeof LaneKindSchema>;

/** The `LaneBackend` implementations: `lanes.mode`. */
export const LANE_BACKENDS = ["repo", "branch"] as const;
export const LaneBackendNameSchema = z.enum(LANE_BACKENDS);
export type LaneBackendName = z.infer<typeof LaneBackendNameSchema>;

/** How a `repo`-backend lane repo is seeded (`lanes.seed`). */
export const LANE_SEEDS = ["import"] as const;
export const LaneSeedSchema = z.enum(LANE_SEEDS);
export type LaneSeed = z.infer<typeof LaneSeedSchema>;

/**
 * The values of the `LANE_MODE` switch and of the per-repo override
 * `meta.lane_mode`: lane repos created with `import()`, or the `branch`
 * backend.
 */
export const LANE_MODES = ["import", "branch"] as const;
export const LaneModeSchema = z.enum(LANE_MODES);
export type LaneMode = z.infer<typeof LaneModeSchema>;

/**
 * The fallback order per lane (`LANE_FALLBACK`); it may be shortened to
 * `branch`.
 */
export const LANE_FALLBACK_ORDER = [
	"import",
	"branch",
] as const satisfies readonly LaneMode[];

/**
 * The only ref of every lane repo (`HEAD` → it), whatever the canonical
 * repo's default branch is called: the capability route advertises it and
 * the seeder imports with `branch: "main"`.
 */
export const LANE_REPO_HEAD_REF = "refs/heads/main" as const;

/** Phases of one seed attempt (`lanes.seed_phase`). */
export const LANE_SEED_PHASES = [
	"cap",
	"importing",
	"verifying",
] as const;
export const LaneSeedPhaseSchema = z.enum(LANE_SEED_PHASES);
export type LaneSeedPhase = z.infer<typeof LaneSeedPhaseSchema>;

/**
 * Failure codes of a seed attempt (`lane.seed_failed.code`) and of a lane
 * closed while `opening` (`lane.closed.seedCode = "cancelled"`). The first
 * four are platform-side (`LANE_PLATFORM_FAULT_CODES`): only a lane that fell
 * back with one of them counts as a breaker strike. The rest are Tartan-side
 * or size codes and never strike.
 */
export const LANE_SEED_FAIL_CODES = [
	"import-error",
	"import-timeout",
	"importer-unreachable",
	"verify-failed",
	"lane-too-large",
	"trunk-moved",
	"interrupted",
	"rate-limited",
	"cancelled",
	"lane-repo-ceiling",
] as const;
export const LaneSeedFailCodeSchema = z.enum(LANE_SEED_FAIL_CODES);
export type LaneSeedFailCode = z.infer<typeof LaneSeedFailCodeSchema>;

/** The platform-side subset of `LANE_SEED_FAIL_CODES` (`platformFault: true`). */
export const LANE_PLATFORM_FAULT_CODES = [
	"import-error",
	"import-timeout",
	"importer-unreachable",
	"verify-failed",
] as const satisfies readonly LaneSeedFailCode[];
export type LanePlatformFaultCode = typeof LANE_PLATFORM_FAULT_CODES[number];

export const isLanePlatformFault = (
	code: string,
): code is LanePlatformFaultCode =>
	(LANE_PLATFORM_FAULT_CODES as readonly string[]).includes(code);

/** Default lease (K7) and the resume window for `lost` lanes. */
export const LANE_LEASE_MS = 30 * 60 * 1000;
export const LANE_RESUME_MS = 24 * 60 * 60 * 1000;
/**
 * Close → lane GC: the `repo` backend deletes the lane repo (`lane-delete`,
 * once a landed lane's change ref exists), the `branch` backend deletes the
 * lane ref (`lane-gc`).
 */
export const LANE_DELETE_AFTER_CLOSE_MS = 24 * 60 * 60 * 1000;

/**
 * How long the MCP host waits (`RepoCoreFacade.awaitLane`) for an `opening`
 * lane before answering `lanes_open` / `work_claim`. Never
 * waited inside an extension call: `caps.lanes.open` returns at once.
 */
export const LANE_OPEN_WAIT_MS = 20_000;

/**
 * Attic retention of an archived `repo`-backend lane (`lanes.archive`): an
 * Owner setting per repo (`meta.attic_retention_ms`), default 7 days, at most
 * 30.
 */
export const ATTIC_RETENTION_DEFAULT_MS = 7 * 24 * 60 * 60 * 1000;
export const ATTIC_RETENTION_MAX_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Lane operations K16 authorizes, inside each operation's own transaction
 * (`RepoCoreFacade`; `authorizeLaneOp` is the read-only pre-check). `purge`
 * is Owner only.
 */
export const LANE_OPS = [
	"open",
	"adopt",
	"close",
	"archive",
	"sync",
	"restack",
	"delegate",
	"purge",
] as const;
export const LaneOpSchema = z.enum(LANE_OPS);
export type LaneOp = z.infer<typeof LaneOpSchema>;

/**
 * A lane as seen through `caps.lanes`, MCP and the API. The Artifacts repo
 * name is deliberately absent: targets are always `{repoId, laneId}`.
 */
export const LaneSchema = z.strictObject({
	id: LaneIdSchema,
	repoId: UlidSchema,
	kind: LaneKindSchema,
	/** The backend actually used; may change once, `repo` → `branch`, while `opening`. */
	mode: LaneBackendNameSchema,
	/** The current (or final) seed of a `repo` lane; absent on `branch`. */
	seed: LaneSeedSchema.optional(),
	/** Open → verified, once a `repo` lane has opened. */
	seedMs: z.number().int().nonnegative().optional(),
	/**
	 * The lane's head ref: `refs/heads/main` in the lane repo (`repo`), or
	 * `refs/heads/lanes/<id>` or the adopted branch in the canonical repo
	 * (`branch`).
	 */
	ref: RefNameSchema,
	/** The local branch name agents use for the lane: `lanes/<id>`. */
	branch: z.string().min(1).max(1024),
	owner: PrincipalIdSchema,
	onBehalfOf: PrincipalIdSchema.optional(),
	delegates: z.array(PrincipalIdSchema),
	openedByInstallation: z.string().optional(),
	entity: EntityRefSchema.optional(),
	footprint: FootprintSchema,
	dependsOnLane: LaneIdSchema.optional(),
	/** The lane's merge base with trunk (K17): the trunk tip at open, then each non-truncated `rangeBase` (moves on rebase). */
	base: ShaSchema,
	/**
	 * `repo`: equal to `base` once the seed is verified. `branch`: absent until
	 * the owner's first push creates the ref.
	 */
	head: ShaSchema.optional(),
	state: LaneStateSchema,
	/** An observed head change matched no gateway or kernel write (K2). */
	quarantined: z.boolean(),
	leaseExpiresAt: z.number().int(),
	lastPushAt: z.number().int().optional(),
	pushes: z.number().int().nonnegative(),
	createdAt: z.number().int(),
	closedAt: z.number().int().optional(),
	/**
	 * Gateway git URL path (`laneRemotePath`): the lane remote
	 * `/<repoPath>/-/lanes/<id>.git` (`repo`), or the repo's
	 * `/<repoPath>.git` (`branch`).
	 */
	remote: z.string(),
}).superRefine((lane, ctx) => {
	if (lane.kind === "adopted" && lane.mode !== "branch") {
		ctx.addIssue({
			code: "custom",
			message: "an adopted lane is always on the branch backend",
			path: ["mode"],
		});
	}
	if (lane.mode === "branch" && lane.seed !== undefined) {
		ctx.addIssue({
			code: "custom",
			message: "a branch lane has no seed",
			path: ["seed"],
		});
	}
	if (lane.mode === "repo" && lane.ref !== LANE_REPO_HEAD_REF) {
		ctx.addIssue({
			code: "custom",
			message: `a repo lane's head ref is ${LANE_REPO_HEAD_REF}`,
			path: ["ref"],
		});
	}
	if (lane.state === "opening" && lane.mode !== "repo") {
		ctx.addIssue({
			code: "custom",
			message: "only repo lanes are ever opening",
			path: ["state"],
		});
	}
});
export type Lane = z.infer<typeof LaneSchema>;

export type SyncResult =
	| { readonly ok: true; readonly head: string }
	| {
		readonly ok: false;
		readonly conflicts: readonly {
			readonly path: string;
			readonly regions: readonly ConflictRegion[];
		}[];
	};

/**
 * What archiving a lane kept (`caps.lanes.archive`): the lane's own
 * repo itself until `until` (`repo` backend), an attic ref in the canonical
 * repo (`branch` backend), or only the summary (a veto, or the forge-wide
 * ceiling of retained lane repos).
 */
export const ArchiveResultSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("lane"),
		laneId: LaneIdSchema,
		head: ShaSchema,
		until: z.number().int(),
	}),
	z.strictObject({
		kind: z.literal("ref"),
		ref: RefNameSchema,
		head: ShaSchema,
	}),
	z.strictObject({ kind: z.literal("summary") }),
]);
export type ArchiveResult = z.infer<typeof ArchiveResultSchema>;

/**
 * Lane states moved by `changes@1` events: the one mechanism that takes a
 * lane to `submitted` (required by `RepoLandFacade.submit`) and
 * back. WP6's `appendSync` calls `RepoCoreInternal.applyLaneEventSync(event)`
 * for every appended **non-shadow** event whose type is a key here, inside
 * the same `transactionSync` (K3); WP5a implements it with this table. A lane
 * outside `from` is left unchanged, so replays and out-of-order delivery are
 * harmless, and a changes event never moves an `opening` lane. Events without
 * a `laneId` (`changes.abandoned`, `changes.superseded`) are mapped through
 * the change id WP5a records on the lane at `changes.submitted`.
 *
 * Land transitions (`submitted` → `landing` → `landed`, or back to
 * `submitted` on conflict, veto or failure) are kernel-owned: WP10's land
 * module sets them with `setLaneStateSync` in the transaction that appends
 * the matching `land.*` event.
 */
export const LANE_EVENT_TRANSITIONS = {
	"changes.submitted": { from: ["open", "submitted"], to: "submitted" },
	"changes.abandoned": { from: ["submitted"], to: "open" },
	"changes.superseded": { from: ["submitted"], to: "open" },
} as const satisfies Readonly<
	Record<
		string,
		{ readonly from: readonly LaneState[]; readonly to: LaneState }
	>
>;
export type LaneEventType = keyof typeof LANE_EVENT_TRANSITIONS;
export const isLaneEventType = (type: string): type is LaneEventType =>
	Object.hasOwn(LANE_EVENT_TRANSITIONS, type);

/** The state a lane moves to on `type`, or null when the event leaves it alone. */
export const laneStateAfter = (
	current: LaneState,
	type: string,
): LaneState | null => {
	if (!isLaneEventType(type)) return null;
	const t: { readonly from: readonly LaneState[]; readonly to: LaneState } =
		LANE_EVENT_TRANSITIONS[type];
	return t.from.includes(current) && t.to !== current ? t.to : null;
};

/** The `repo` backend's lane remote path: `/<repoPath>/-/lanes/<laneId>.git`. */
export const laneGitPath = (repoPath: string, lane: string): string =>
	`/${repoPath}/-/lanes/${lane}.git`;
/** The canonical repo's git path: `/<repoPath>.git` (also the `branch` backend's remote). */
export const repoGitPath = (repoPath: string): string => `/${repoPath}.git`;
/** The gateway git path agents push a lane to, by the lane's backend. */
export const laneRemotePath = (
	lane: { readonly id: string; readonly mode: LaneBackendName },
	repoPath: string,
): string =>
	lane.mode === "repo" ? laneGitPath(repoPath, lane.id) : repoGitPath(repoPath);

/** The exact git commands of a lane handle. */
export type LaneGitCommands = {
	/** Starts a local branch at the lane's head (or base before the first push). */
	readonly start: string;
	/** Pushes the local branch to the lane's head ref. */
	readonly push: string;
};

/**
 * The commands for the lane's backend: `repo` fetches
 * and pushes `main` of the lane remote; `branch` uses `origin` (the repo's
 * git URL) and the lane's ref. `remoteUrl` is the absolute lane remote (the
 * canonical origin + `lane.remote`); it is only used on `repo`. Every handle
 * builder (the MCP host for every handle it returns, suggestions, attic
 * hints) uses this one function.
 */
export const laneGitCommands = (
	lane: Pick<Lane, "mode" | "ref" | "branch" | "base" | "head">,
	remoteUrl: string,
): LaneGitCommands =>
	lane.mode === "repo"
		? {
			start:
				`git fetch ${remoteUrl} main && git switch -c ${lane.branch} FETCH_HEAD`,
			push: `git push ${remoteUrl} HEAD:${LANE_REPO_HEAD_REF}`,
		}
		: {
			start: `git fetch origin && git switch -c ${lane.branch} ${
				lane.head ?? lane.base
			}`,
			push: `git push -u origin HEAD:${lane.ref}`,
		};
