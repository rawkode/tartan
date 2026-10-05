// Kernel constants and the fallback switches. WP0 alone changes a switch,
// and the note next to each value says what its default means.
// Contract-owned values are not repeated here: `LANE_OPEN_WAIT_MS`,
// `LANE_REPO_HEAD_REF`, `LANE_FALLBACK_ORDER`, `ATTIC_RETENTION_*_MS`
// (lanes.ts), `LANE_SEED_MAX_ATTEMPTS` (ids.ts), `MAX_OBJECT_BYTES` (git.ts),
// the extension `BREAKER` (do/ext.ts) and `CAP_FAILURE_LIMITS` (security.ts).

import { LANE_FALLBACK_ORDER, type LaneMode } from "@tartan/contract";

export { COMPAT_DATE, PRODUCT_NAME } from "@tartan/contract";

/** Matches package.json "version". */
export const TARTAN_VERSION = "0.0.0" as const;

const MiB = 1024 * 1024;
/** Decimal megabyte, the unit zone plans use for request-body limits. */
const MB = 1_000_000;

// ---------------------------------------------------------------------------
// Fallback switches
// ---------------------------------------------------------------------------

/**
 * Upstream Artifacts git auth: `bearer` sends `Authorization: Bearer
 * <full token incl. ?expires>`; `basic` sends Basic with the stripped secret.
 * Default: `bearer`; `basic` is the one-line fallback.
 */
export const UPSTREAM_AUTH: "bearer" | "basic" = "bearer";

/**
 * `true`: band-2 echo lines and synthesized `ng` with side-band. `false`:
 * plain report-status only; notices carry the text.
 * Default: off.
 */
export const ECHO_ENABLED = false as boolean;

/**
 * Where new lanes live: `import` (a per-lane repo created with
 * `import()` through the capability URL) or `branch` (branch lanes
 * `refs/heads/lanes/<laneId>` on the canonical repo, the fallback). A repo
 * may override it in `meta.lane_mode`, and a stage in `TARTAN_LANE_MODE`
 * (`laneModeOf`); sim repos use `branch`.
 * Default: `branch`; a stage opts in to `import` with
 * `render-config.ts --lane-mode import`.
 */
export const LANE_MODE: LaneMode = "branch";

/**
 * The fallback order behind `LANE_MODE`: `import`, then branch lanes.
 * `TARTAN_LANE_FALLBACK` (read with `laneFallback`) may shorten it to
 * `branch`.
 * Default: the design's fallback order.
 */
export const LANE_FALLBACK = "import>branch" as const;

/**
 * Above this trunk pack estimate (`meta.trunk_pack_bytes`) a repo skips
 * `import` and opens new lanes as branch lanes.
 */
export const LANE_IMPORT_MAX_BYTES = 36 * MiB;

/**
 * Capability URL lifetime, and the TTL of each trunk read token behind it:
 * a margin over the import time of the largest seed, and at least
 * `ARTIFACTS_TOKEN_MIN_TTL_S`.
 */
export const LANE_CAP_TTL_S = 120;

/**
 * `true`: when trunk moved during an import and the kernel explains the
 * move, the capability route still serves the attempt's base. `false`: it
 * answers 503 and the seeder retries at once at the new base (`trunk-moved`,
 * no breaker strike).
 * Default: off.
 */
export const LANE_CAP_PIN_BASE = false as boolean;

/**
 * Optional defence in depth on the capability route: accept only requests from
 * ASN 13335 with `User-Agent: artifacts/1.0`. Never an authenticator.
 * Default: off.
 */
export const LANE_CAP_CLIENT_CHECK = false as boolean;

/**
 * `true`: `js`/`wasm` extensions run as Dynamic Workers (Worker
 * Loader, facets), each installation in its own ExtensionDO behind the
 * breaker. `false`: builtins only, third-party upload disabled with an
 * explicit message; `wasm-bundled` remains the last resort.
 * Default: on; the breaker is mandatory.
 */
export const EXT_DYNAMIC_ENABLED = true as boolean;

/**
 * `dockerfile`: `containers/runner/Dockerfile`, which builds a pinned git
 * (≥ 2.38). `registry`: the same image pushed to ttl.sh and rendered by
 * digest only (dev and demo stages). `none`: the `--no-containers` render
 * (CI and land report "unavailable").
 */
export const IMAGE_VARIANT: "dockerfile" | "registry" | "none" = "dockerfile";

/**
 * `true`: `cf.artifacts.repo.pushed` (one event per ref update, `r-*` and
 * `l-*` repos) drives IngestWorkflow as the push backstop. `false`: the
 * trigger is dropped; gateway + kernel record every push and the 5-minute
 * cron reconciles refs.
 * Default: on.
 */
export const TRIGGER_ENABLED = true as boolean;

/**
 * `event`: Workflows `waitForEvent` with a poll-step fallback. `poll`:
 * poll steps on DO state every 15 s only. Correctness never depends on event
 * buffering either way: the poll step covers an event that arrives before its
 * wait.
 */
export const WAIT_MODE: "event" | "poll" = "event";

/**
 * `false`: the gateway checks each lane command's `old` against the index,
 * and Artifacts' own old-SHA CAS stops a concurrent update. `true`:
 * `pushContext` also takes a short per-ref push lease on every lane head in the
 * push, released by phase 1 of `recordPush` or by `recordRejection` (contract
 * `PushLeaseRequest`).
 * Default: off.
 */
export const PUSH_LEASE_ENABLED = false as boolean;

/**
 * `sdk`: `createMcpHandler` (`agents/mcp/server`) with a per-request
 * `McpServer` (`@modelcontextprotocol/server`). `raw`: the plain JSON-RPC
 * 2.0 handler (`initialize`, `ping`, `tools/list`, `tools/call`) with JSON
 * responses.
 * Default: `sdk`; `raw` is the fallback.
 */
export const MCP_TRANSPORT = "sdk" as "sdk" | "raw";

/**
 * The most a CI run may use: `k2` lets a run go through
 * the global log's `workloads` consumer when the binding, stream, token, the
 * RepoDO's relay and the consumer are all healthy (chosen per run at
 * runtime); `local` dispatches every run inline. The outbox timer backs both.
 * Default: `local`; a stage opts in with `render-config.ts
 * --workload-transport k2` (`workloadTransportOf`).
 */
export const WORKLOAD_TRANSPORT = "local" as "local" | "k2";

/** All switches, for `/-/health`-style diagnostics and tests. */
export const FALLBACK_SWITCHES = {
	UPSTREAM_AUTH,
	ECHO_ENABLED,
	LANE_MODE,
	LANE_FALLBACK,
	LANE_IMPORT_MAX_BYTES,
	LANE_CAP_TTL_S,
	LANE_CAP_PIN_BASE,
	LANE_CAP_CLIENT_CHECK,
	EXT_DYNAMIC_ENABLED,
	IMAGE_VARIANT,
	TRIGGER_ENABLED,
	WAIT_MODE,
	PUSH_LEASE_ENABLED,
	MCP_TRANSPORT,
	WORKLOAD_TRANSPORT,
} as const;

// ---------------------------------------------------------------------------
// Per-stage switch overrides (rendered vars)
// ---------------------------------------------------------------------------

/**
 * The forge's lane mode: the rendered `TARTAN_LANE_MODE` when it names a
 * mode (`render-config.ts --lane-mode`), else `LANE_MODE`. The button path
 * renders nothing, so it keeps the compiled default.
 */
export const laneModeOf = (
	env: { readonly TARTAN_LANE_MODE?: string } | undefined,
): LaneMode => {
	const rendered = env?.TARTAN_LANE_MODE;
	return rendered === "import" || rendered === "branch" ? rendered : LANE_MODE;
};

/**
 * The most a CI run may use on this stage: the rendered
 * `TARTAN_WORKLOAD_TRANSPORT` (`render-config.ts --workload-transport`, only
 * with a K2 stream) when it is `local` or `k2`, else `WORKLOAD_TRANSPORT`.
 * Runs still fall back to `local` at runtime whenever the global log is
 * unhealthy.
 */
export const workloadTransportOf = (
	env: { readonly TARTAN_WORKLOAD_TRANSPORT?: string } | undefined,
): "local" | "k2" => {
	const rendered = env?.TARTAN_WORKLOAD_TRANSPORT;
	return rendered === "local" || rendered === "k2"
		? rendered
		: WORKLOAD_TRANSPORT;
};

// ---------------------------------------------------------------------------
// Lane fallback order
// ---------------------------------------------------------------------------

const parseChain = (
	value: string | undefined,
): readonly LaneMode[] | null => {
	if (value === undefined || value.trim() === "") return null;
	const steps = value.split(">").map((step) => step.trim() as LaneMode);
	const at = steps.map((step) => LANE_FALLBACK_ORDER.indexOf(step));
	const ordered = at.every((index, i) =>
		index !== -1 && (i === 0 || index > at[i - 1])
	);
	return ordered && steps.at(-1) === "branch" ? steps : null;
};

/**
 * The effective fallback order: the configured `TARTAN_LANE_FALLBACK` when
 * it is `LANE_FALLBACK` or its shortening to `branch`, else `LANE_FALLBACK`.
 * A reordered, repeated or unknown step, or a chain without `branch`, is
 * ignored.
 */
export const laneFallback = (
	rendered: string | undefined,
): readonly LaneMode[] =>
	parseChain(rendered) ?? parseChain(LANE_FALLBACK) ?? LANE_FALLBACK_ORDER;

// ---------------------------------------------------------------------------
// Push limits
// ---------------------------------------------------------------------------

/**
 * `TARTAN_MAX_PUSH_MB` when unset or invalid.
 * Default: a margin under the smallest zone plan's request body limit.
 */
export const DEFAULT_MAX_PUSH_MB = 95;

/**
 * `MAX_PUSH_BYTES` from `TARTAN_MAX_PUSH_MB`: the push body cap the gateway
 * checks from `Content-Length` before contacting upstream. Decimal MB, so the
 * default stays under the smallest zone plan limit (100 MB).
 */
export const maxPushBytes = (mb: string | undefined): number => {
	const value = mb === undefined || mb.trim() === "" ? NaN : Number(mb);
	const valid = Number.isSafeInteger(value) && value > 0;
	return (valid ? value : DEFAULT_MAX_PUSH_MB) * MB;
};

// ---------------------------------------------------------------------------
// Runtime limits
// ---------------------------------------------------------------------------

/**
 * Distinct Dynamic Workers per request and per DO (the host semaphore).
 */
export const DYN_CONCURRENCY = { request: 4, do: 10 } as const;

/**
 * Artifacts binding reads: a token bucket per isolate, and at most this many
 * concurrent reads per request.
 */
export const BINDING_READS_PER_S = 250;
export const BINDING_READS_CONCURRENCY = 16;

// ---------------------------------------------------------------------------
// Lane range, upload and push-recording bounds
// ---------------------------------------------------------------------------

/** K17: parent walk bound for a lane's range base. */
export const LANE_RANGE_MAX_COMMITS = 500;
/** K17: first-parent chain recorded into `trunk_commits` on import. */
export const TRUNK_IMPORT_CHAIN = 1_000;
/** Public-view wants may name a visible tip from this window. */
export const RECENT_TIP_WINDOW_MS = 600_000;
/** Decoded upload-pack request bodies (gzip) are capped here. */
export const UPLOAD_DECODE_MAX_BYTES = 4 * MiB;
/** Active lanes per principal per repo. */
export const MAX_LANES_PER_PRINCIPAL = 20;
/** Active lanes per repo on the `branch` backend. */
export const MAX_ACTIVE_LANES = 2_000;
/** `lanes_open` calls per principal per minute. */
export const LANES_OPEN_PER_MIN = 30;
/** The gateway awaits phase-1 recording this long before the final flush. */
export const PHASE1_FLUSH_WAIT_MS = 5_000;
/** The RepoDO `diff` timer completes a missing phase 2 after this delay. */
export const DIFF_BACKSTOP_MS = 30_000;

// ---------------------------------------------------------------------------
// Lane repo constants
// ---------------------------------------------------------------------------

/** Active lanes per repo on the `repo` backend (provisional). */
export const MAX_ACTIVE_LANES_REPO_BACKEND = 200;
/** Retained lane repos per forge (`artifacts_index` `pending` + `live`; provisional). */
export const MAX_LANE_REPOS_FORGE = 1_000;
/** JS-side bound on one `import()`: 8 s + 0.4 s per MiB of trunk pack, at most 30 s. */
export const LANE_IMPORT_TIMEOUT = {
	baseMs: 8_000,
	perMiBMs: 400,
	maxMs: 30_000,
} as const;
/** Added to an attempt's timeout to give its `seed_deadline` (the watchdog). */
export const LANE_SEED_GRACE_MS = 5_000;
/** Seed attempts in flight per repo. */
export const LANE_SEED_CONCURRENCY = 8;
/** Retries of a transient seed failure before the lane falls back to a branch lane. */
export const LANE_SEED_TRANSIENT_RETRIES = 3;
/** Seed breaker: strikes are lanes (never attempts) with a platform-side failure. */
export const LANE_BREAKER = {
	strikes: 3,
	windowMs: 600_000,
	degradeMs: 3_600_000,
} as const;
/** How long a `MEMORY_LIMIT` keeps a repo off `import` (`import_too_large_until`). */
export const IMPORT_TOO_LARGE_TTL_MS = 86_400_000;
/** `info/refs` requests one capability nonce may serve before its pack request. */
export const CAP_INFO_USES_MAX = 3;
/** Artifacts control-plane calls per second, per RepoDO and per isolate (429 = backoff). */
export const ARTIFACTS_CONTROL_PER_S_REPO = 20;
export const ARTIFACTS_CONTROL_PER_S_ISOLATE = 50;
/** Lane-repo reconciliation pace per repo. */
export const LANE_RECONCILE_PER_S = 2;
/** Idle lane repos are reconciled this often. */
export const LANE_IDLE_RECONCILE_MS = 3_600_000;
/** The orphan sweep only considers `l-*` repos older than this. */
export const LANE_ORPHAN_AGE_MS = 900_000;
/** A lane-repo deletion deferred for this long raises an alert. */
export const LANE_GC_DEFER_ALERT_MS = 86_400_000;
/**
 * A push lease's lifetime when nothing releases it (`PUSH_LEASE_ENABLED`):
 * provisional.
 */
export const PUSH_LEASE_MS = 120_000;

/** The `*\/5 * * * *` cron trigger (`wrangler.jsonc`, `src/cron.ts`). */
export const CRON_PERIOD_MS = 5 * 60_000;

/**
 * Whether a cron tick also sweeps archived repos (and repos below an
 * archived group; `TreeFacade.listRepos` `archived`): only the first tick of
 * each UTC day. They are read-only, so the per-tick sweeps leave them out
 * and a forge's background load does not grow with its archive, while
 * lane GC, event retention and the relay backstop still reach them daily.
 */
export const sweepArchived = (now: number): boolean =>
	now % 86_400_000 < CRON_PERIOD_MS;
