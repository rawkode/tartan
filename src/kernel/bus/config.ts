// Global log tuning, names and K2 error classes (WP26). The one switch,
// `WORKLOAD_TRANSPORT`, lives with the other fallback switches in
// `src/constants.ts` (re-exported by `./switches.ts`); these are the
// module's own constants.
//
// K2 facts behind them: delivery is at least once and K2 never
// deduplicates; delivery keeps the production order for one producer per
// subscription; a nack redelivers at once. The conformance suite
// (`./conformance.ts`) checks these against a deployed stream.

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Stream names allow letters, digits and `_` only: `tartan_<stage>_log`. */
export const logStreamName = (stage: string): string =>
	`tartan_${stage.replaceAll("-", "_")}_log`;

/** A stream id: 32 lowercase hex characters. */
export const K2_STREAM_ID_RE = /^[0-9a-f]{32}$/;

/** The data-plane endpoint of a stream. */
export const k2Endpoint = (streamId: string): string =>
	`https://${streamId}.k2.cloudflarestorage.com`;

/** BusDO name: `bus:<group>:<n>`. */
export const busDoName = (group: string, n: number): string =>
	`bus:${group}:${n}`;

export const BUS_DO_NAME_RE = /^bus:([a-z][a-z0-9-]{0,30}):([0-9]{1,3})$/;

/** The K2 `worker_id` of a BusDO: `tartan-<stage>-<group>-<n>`. */
export const busWorkerId = (stage: string, group: string, n: number): string =>
	`tartan-${stage}-${group}-${n}`;

/** The subscription of a group: `<group>-<gen>` (gen: a ULID per BusDO storage). */
export const subscriptionName = (group: string, gen: string): string =>
	`${group}-${gen}`;

// ---------------------------------------------------------------------------
// Relay (RepoDO, ForgeDO)
// ---------------------------------------------------------------------------

/** One `send()` carries at most this many records and encoded bytes. */
export const K2_RELAY_BATCH = { records: 500, bytes: 4_000_000 } as const;
/** An append arms the relay timer no later than this far ahead (durability). */
export const K2_RELAY_ARM_MS = 1_000;
/** Resend delays of the same range after a retryable or unknown outcome. */
export const K2_RELAY_BACKOFF_MS = [
	1_000,
	2_000,
	5_000,
	15_000,
	60_000,
] as const;
/** A configuration-class error retries this often (and turns health red). */
export const K2_RELAY_BLOCKED_RETRY_MS = 300_000;

/** `send()` codes whose batch may or may not be stored: resend, count, dedupe. */
export const K2_UNKNOWN_OUTCOME_CODES: readonly number[] = [10212, 10213];
/** Configuration-class produce codes: `blocked` until a deploy fixes it. */
export const K2_CONFIG_ERROR_CODES: readonly number[] = [
	10200,
	10204,
	10205,
	10206,
	10207,
	10399,
	10400,
	10401,
];

// ---------------------------------------------------------------------------
// Consumer (BusDO)
// ---------------------------------------------------------------------------

export type ConsumerGroup = {
	readonly workers: number;
	readonly maxRecords: number;
	readonly startAt: "latest" | "earliest";
};

/**
 * The floor's one group. `workloads` subscribes at `latest`: anything
 * produced before its subscription existed is covered by the runs backstop,
 * so a new or reset subscription never replays a storm of dispatches.
 */
export const K2_GROUPS: Readonly<Record<string, ConsumerGroup>> = {
	workloads: { workers: 1, maxRecords: 100, startAt: "latest" },
};

/** Idle poll backoff; a nudge resets it. */
export const K2_POLL_BACKOFF_MS = [250, 500, 1_000, 2_000, 5_000] as const;
/** A group handler gets this long per record; a timeout counts as `retry`. */
export const K2_HANDLER_TIMEOUT_MS = 10_000;
/** A record whose handler crashed this many times is parked. */
export const K2_MAX_CRASH_ATTEMPTS = 3;
/** `retry` rows: at most this many attempts, then `dead`. */
export const K2_RETRY_MAX_ATTEMPTS = 8;
export const K2_RETRY_BACKOFF = { initialMs: 1_000, maxMs: 600_000 } as const;
/** Retry rows handled per `retry` timer run. */
export const K2_RETRY_BATCH = 20;
/** Extend the lease when less than this is left mid-batch. */
export const K2_LEASE_EXTEND_MARGIN_MS = 60_000;
/** `seen` rows outlive the longest retention by a day. */
export const K2_SEEN_RETENTION_MS = 31 * 24 * 60 * 60 * 1000;
/** Parked records keep at most this much content. */
export const K2_DEAD_CONTENT_MAX_BYTES = 64 * 1024;
/** Hours of via counts kept. */
export const K2_VIA_HOURS = 48;

/** Consume codes to retry after a backoff (the docs' list). */
export const K2_CONSUME_RETRYABLE_CODES: readonly number[] = [
	10211,
	10214,
	10216,
	10217,
];
/** The subscription is gone or the stream changed: re-resolve, never retry unchanged. */
export const K2_RESUBSCRIBE_CODES: readonly number[] = [10215, 10200];
/** `extend` after the lease was lost: log it and go on. */
export const K2_LEASE_LOST_CODE = 10218;
/** Same subscription name, different settings: health red. */
export const K2_SUBSCRIPTION_CONFLICT_CODE = 10201;

// ---------------------------------------------------------------------------
// Runs transport (RepoDO runs)
// ---------------------------------------------------------------------------

/** A `k2` run not dispatched by the consumer within this is dispatched by the backstop. */
export const K2_DISPATCH_GRACE_MS = 20_000;
/** A RepoDO caches the consumer's health this long. */
export const K2_HEALTH_TTL_MS = 30_000;
/** The consumer is healthy when it polled successfully within this. */
export const K2_HEALTH_FRESH_MS = 15_000;
/** The health RPC's bound; a timeout is unhealthy. */
export const K2_HEALTH_TIMEOUT_MS = 500;
/** Due runs the outbox timer dispatches per invocation. */
export const OUTBOX_DISPATCH_BATCH = 25;

// ---------------------------------------------------------------------------
// Deploy budgets: retention ≤ the DO log's 30 d; never filter
// ---------------------------------------------------------------------------

export type StageBudget = {
	readonly retentionSeconds: number;
	readonly budgetBytes: number;
};

const GB = 1_000_000_000;

/** Retention and storage budget by stage (third-party stages get `default`). */
export const K2_STAGE_BUDGETS: Readonly<Record<string, StageBudget>> = {
	"dev-demo": { retentionSeconds: 604_800, budgetBytes: 4 * GB },
	dev: { retentionSeconds: 86_400, budgetBytes: 1 * GB },
	"dev-wp": { retentionSeconds: 86_400, budgetBytes: GB / 2 },
	default: { retentionSeconds: 604_800, budgetBytes: 4 * GB },
};

export const stageBudget = (stage: string): StageBudget =>
	K2_STAGE_BUDGETS[stage] ??
		(/^dev-wp[0-9]/.test(stage)
			? K2_STAGE_BUDGETS["dev-wp"]
			: K2_STAGE_BUDGETS.default);

/** K2 retention bounds (seconds). */
export const K2_RETENTION_MIN_S = 3_600;
export const K2_RETENTION_MAX_S = 2_592_000;
/** Preflight refuses a new stream at this many on the account. */
export const K2_STREAM_BUDGET = 18;
