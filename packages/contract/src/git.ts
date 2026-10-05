// Read-side git and monorepo shapes returned by `caps.repo.*`, RepoProbe and
// the browse API.

import { z } from "zod";

export type TreeEntryType = "tree" | "blob" | "symlink" | "gitlink" | "exec";

export type TreeEntry = {
	readonly name: string;
	/** Repo-relative path of the entry. */
	readonly path: string;
	readonly mode: string;
	readonly hash: string;
	readonly type: TreeEntryType;
};

export type Trailer = { readonly key: string; readonly value: string };

export type CommitMeta = {
	readonly sha: string;
	readonly treeSha: string;
	readonly subject: string;
	readonly message: string;
	readonly author: { readonly name: string; readonly email: string };
	readonly committer: { readonly name: string; readonly email: string };
	readonly parents: readonly string[];
	/** Epoch seconds, as git stores them. */
	readonly authoredAt: number;
	readonly committedAt: number;
	readonly trailers: readonly Trailer[];
};

export type PathChange = "added" | "modified" | "deleted" | "renamed" | "type";

export type PathDiff = {
	readonly paths: readonly {
		readonly path: string;
		readonly change: PathChange;
		readonly oldPath?: string;
		readonly project?: string;
	}[];
	readonly truncated: boolean;
};

export type Hunk = {
	readonly oldStart: number;
	readonly oldLines: number;
	readonly newStart: number;
	readonly newLines: number;
};

export type FileHunks = {
	readonly path: string;
	readonly binary: boolean;
	readonly hunks: readonly Hunk[];
	/**
	 * True when only the path is known (budget exceeded, empty read bucket,
	 * blob too large or unreadable); `hunks` is then empty (WP8).
	 */
	readonly pathLevel?: boolean;
};

/**
 * Blob shas are resolved only within the repo family of `repoId`: the
 * canonical repo plus its lane repos.
 */
export type Merge3Input = {
	readonly repoId: string;
	readonly path: string;
	/** Merge-base blob, or null for an add/add. */
	readonly base: string | null;
	readonly ours: string;
	readonly theirs: string;
};

export const ConflictRegionSchema = z.strictObject({
	baseStart: z.number().int().nonnegative(),
	baseLines: z.number().int().nonnegative(),
	oursStart: z.number().int().nonnegative(),
	oursLines: z.number().int().nonnegative(),
	theirsStart: z.number().int().nonnegative(),
	theirsLines: z.number().int().nonnegative(),
});
export type ConflictRegion = z.infer<typeof ConflictRegionSchema>;

export type Merge3Result = {
	readonly path: string;
	readonly clean: boolean;
	readonly binary: boolean;
	readonly regions: readonly ConflictRegion[];
	/** True when the result is path level only, as for `FileHunks` (WP8). */
	readonly pathLevel?: boolean;
};

/**
 * Why a `FileDiff` that was asked for its patch carries none (a binary file
 * says so with `binary` instead):
 *
 * - `too-large`: this file's patch, or one of its blobs, is over the
 *   per-file cap (`PATCH_LIMITS.fileBytes`, `LINE_DIFF_MAX_BYTES`);
 * - `budget`: the response's patch budget (`PATCH_LIMITS.responseBytes`)
 *   or its file limit was used up by the files before it;
 * - `path-level`: only the path is known (a root commit's listing, a
 *   submodule, an unreadable blob).
 */
export const PATCH_OMITTED = ["too-large", "budget", "path-level"] as const;
export type PatchOmitted = typeof PATCH_OMITTED[number];

/** Patch caps of `RepoProbeApi.diff` with `{patch: true}` (UTF-8 bytes). */
export const PATCH_LIMITS = {
	/** One file's patch, headers included. */
	fileBytes: 256 * 1024,
	/** Every patch of one answer together. */
	responseBytes: 1024 * 1024,
} as const;

export type FileDiff = {
	readonly path: string;
	readonly oldPath?: string;
	readonly change: PathChange;
	readonly binary: boolean;
	readonly additions: number;
	readonly deletions: number;
	readonly hunks: readonly Hunk[];
	/**
	 * Git-style unified patch text (`diff --git` header, 3 context lines)
	 * when requested (`RepoProbeApi.diff` `{patch: true}`, `patch=1` on
	 * `/-/api/commit` and `/-/api/compare`) and within `PATCH_LIMITS`. A
	 * rename or mode change without content changes has the header only.
	 */
	readonly patch?: string;
	/** Set only when a patch was requested and is absent (not for binary files). */
	readonly patchOmitted?: PatchOmitted;
};

/**
 * Where a project came from: `tartan-config` is the top-level `projects`
 * of the repository's package `tartan` at the commit's trunk base
 * (ADR repo config); `cuenv` is a cuenv `#Project` (WP25, `TARTAN_PROJECTS`);
 * the others are workspace detectors.
 */
export type ProjectSource =
	| "tartan-config"
	| "cuenv"
	| "pnpm-workspace"
	| "npm-workspaces"
	| "deno-workspace"
	| "cargo"
	| "go.work";

/** `scan`: a cuenv name from the textual scan (Tier 0); `eval`: from `cue export` (Tier 1). */
export type ProjectFidelity = "scan" | "eval";

/** A finding of project detection (never a failure). */
export type ProjectIssue = {
	readonly code: string;
	readonly path?: string;
	readonly message: string;
};

/** A cuenv `#Base` layer and the `.cue` paths under it outside every project root. */
export type ProjectLayer = {
	/** The layer directory ("" is the repo root). */
	readonly root: string;
	readonly paths: readonly string[];
};

/** URL slugs of projects (`/<repo>/-/p/<slug>`), unique within one graph. */
export const PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9.-]{0,127}$/;

export type Project = {
	/** Unique within the graph (a duplicate cuenv name gets `@<root slug>`). */
	readonly name: string;
	readonly root: string;
	readonly deps: readonly string[];
	readonly dependents: readonly string[];
	readonly owners: readonly string[];
	readonly sensitive: boolean;
	readonly testCmd?: string;
	readonly source: ProjectSource;
	/** Changes to this file are global for K6. */
	readonly manifestPath?: string;
	/** The root: the stable key of a project (present on cuenv projects). */
	readonly key?: string;
	readonly slug?: string;
	/** The raw cuenv name when `name` carries a uniqueness suffix. */
	readonly cuenvName?: string;
	readonly nameSource?: "literal" | "manifest" | "unresolved";
	/** `#Base` directories above the root, root first ("" is the repo root). */
	readonly layers?: readonly string[];
	readonly fidelity?: ProjectFidelity;
	readonly issues?: readonly ProjectIssue[];
};

/** The project graph **at a commit** (K6 uses the graph at the trunk being landed onto). */
export type ProjectGraph = {
	readonly sha: string;
	readonly manifestsTreeSha: string;
	readonly projects: readonly Project[];
	readonly globalFiles: readonly {
		readonly glob: string;
		readonly source: "config" | "detector-default";
	}[];
	/**
	 * The trunk config the configured projects came from (ADR repo config): its
	 * input key, `none`, `off`, or `provisional:<key>`. Part of the cache key.
	 */
	readonly configKey?: string;
	/**
	 * The trunk config at the commit's base is still evaluating, so the last
	 * good one was used; K6 never sees it (lands of the repo are held, K13.1).
	 */
	readonly provisional?: boolean;
	/**
	 * The detector of a graph computed with `TARTAN_PROJECTS=scan` (absent on
	 * every graph computed without it: RepoProbe recomputes on a mismatch).
	 */
	readonly detector?: "config" | "cuenv" | "workspaces";
	readonly fidelity?: ProjectFidelity | "exact";
	readonly layers?: readonly ProjectLayer[];
	/** Nested CUE modules and the walk limits hit (`depth-limit`, `dir-limit`, `project-limit`, `packages-limit`). */
	readonly skipped?: readonly string[];
	readonly warnings?: readonly ProjectIssue[];
	/** A walk limit was hit: every path is global. */
	readonly truncated?: boolean;
	/** The package clause of each `.cue` blob outside nested modules (null: none). */
	readonly packages?: Readonly<Record<string, string | null>>;
	/** A root `env.cue` with `#Project` names the repository itself (no project row). */
	readonly rootProject?: { readonly name: string };
};

export type Affected = {
	readonly projects: readonly string[];
	/** True when a global file, a manifest or a path outside every project root changed. */
	readonly global: boolean;
	readonly globalPaths?: readonly string[];
};

export type BlameRange = {
	readonly start: number;
	readonly lines: number;
	readonly commit: string;
	readonly origPath?: string;
	readonly origStart?: number;
};

export type RepoInfo = {
	readonly id: string;
	readonly nodeId: string;
	readonly path: string;
	readonly defaultBranch: string;
	readonly visibility: "private" | "internal" | "public";
	readonly trunkSha: string | null;
	readonly landingPaused: boolean;
	readonly description?: string;
};

/**
 * The shared per-push diff stored at R2 `diffs/<repoId>/<rangeBase>..<after>.json`:
 * the lane range `rangeBase..after` (K17), never `before..after`, and
 * never against the empty tree for a ref create.
 */
export type PushDiff = {
	readonly repoId: string;
	/** `"repo"` or a lane id (lane remotes and `branch`-lane refs). */
	readonly target: "repo" | string;
	/** Merge base of `after` with trunk, found in the repo that holds `after`. */
	readonly rangeBase: string;
	/** The 500-commit walk gave up and fell back to `lanes.base_sha`. */
	readonly rangeTruncated: boolean;
	readonly after: string;
	readonly files: readonly FileDiff[];
	readonly addedLines?: readonly AddedLine[];
	readonly truncated: boolean;
};

export type AddedLine = {
	readonly path: string;
	readonly line: number;
	readonly text: string;
};

/** A lane's current range (K17), as `caps.repo.laneRange` and `RepoCoreFacade.laneRange` return it. */
export type LaneRange = {
	readonly head: string;
	readonly rangeBase: string;
	readonly rangeTruncated: boolean;
	readonly diffKey: string;
};

export const diffKey = (
	repoId: string,
	rangeBase: string,
	after: string,
): string => `diffs/${repoId}/${rangeBase}..${after}.json`;

// ---------------------------------------------------------------------------
// Push and import limits
// ---------------------------------------------------------------------------

/** The limits a push is checked against (README, rejection text, pre-push hook). */
export type PushLimits = {
	/** `MAX_PUSH_BYTES`: the request body, from `Content-Length` (`TARTAN_MAX_PUSH_MB`). */
	readonly maxPushBytes: number;
	/** The pre-push hook's per-object limit (`MAX_OBJECT_BYTES`). */
	readonly maxObjectBytes: number;
};

const MIB = 1024 * 1024;
/** `tartan hooks install --git` refuses objects of this size or more before pushing. */
export const MAX_OBJECT_BYTES = 31 * MIB;
/** Artifacts rejects a git object of this size or more. */
export const ARTIFACTS_OBJECT_LIMIT_BYTES = 33_554_432;
/**
 * Upstream receive-pack messages that mean "object too large"; the
 * gateway translates them (and a hang-up after a body above 32 MiB) to
 * `ng <ref> object-too-large`.
 */
export const ARTIFACTS_UPSTREAM_SIZE_ERRORS = [
	"zlib member compressed data exceeds maximum",
	"artifacts_git_receive_pack_object_too_large",
] as const;
/**
 * Numeric `ArtifactsError` codes the seeder handles from `import()`:
 * `MEMORY_LIMIT` (the source pack is too large; the lane opens as a branch
 * lane) and `INTERNAL_ERROR`.
 */
export const ARTIFACTS_IMPORT_ERRORS = {
	MEMORY_LIMIT: 10402,
	INTERNAL_ERROR: 10400,
} as const;
export const logKey = (repoId: string, runId: string, jobId: string): string =>
	`logs/${repoId}/${runId}/${jobId}.log`;
export const blameKey = (
	repoId: string,
	sha: string,
	pathSha256: string,
): string => `blame/${repoId}/${sha}/${pathSha256}.json`;
export const extPackagePrefix = (
	extId: string,
	version: string,
	sha256: string,
): string => `ext/${extId}/${version}/${sha256}/`;
