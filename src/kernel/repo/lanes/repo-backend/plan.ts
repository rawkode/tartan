// The seeder's decisions, pure (WP5b): which seed
// a new lane tries first, what an attempt's deadline is, how a failed attempt
// is classified, what the lane tries next, and when a lane's outcome is a
// breaker strike. Everything here is a function of its inputs, so the rules are
// tested without storage or I/O.

import {
	isLanePlatformFault,
	LANE_FALLBACK_ORDER,
	LANE_SEED_MAX_ATTEMPTS,
	type LaneMode,
	type LanePlatformFaultCode,
	type LaneSeed,
	type LaneSeedFailCode,
} from "@tartan/contract";
import {
	isRepoStoreError,
	type LaneBreakerState,
} from "@tartan/contract/kernel.ts";
import {
	LANE_BREAKER,
	LANE_IMPORT_MAX_BYTES,
	LANE_IMPORT_TIMEOUT,
	LANE_SEED_GRACE_MS,
	LANE_SEED_TRANSIENT_RETRIES,
} from "../../../../constants.ts";
import { isRateLimitError } from "../../upstream.ts";

const MiB = 1024 * 1024;

/** Verification after an import: two binding reads by SHA and one `ls-refs`. */
export const VERIFY_BUDGET_MS = 5_000;
/** The watchdog's own bound. */
export const WATCHDOG_BUDGET_MS = 3_000;
/** The cron re-drives an `opening` lane this long after its deadline passed. */
export const REDRIVE_AFTER_MS = 30_000;

/** The JS-side bound on one `import()`: 8 s + 0.4 s per MiB, at most 30 s. */
export const importTimeoutMs = (packBytes: number | null): number =>
	Math.min(
		LANE_IMPORT_TIMEOUT.maxMs,
		LANE_IMPORT_TIMEOUT.baseMs +
			Math.ceil(
				(LANE_IMPORT_TIMEOUT.perMiBMs * Math.max(0, packBytes ?? 0)) / MiB,
			),
	);

/** When the `seed:<laneId>` watchdog of an attempt fires (`lanes.seed_deadline`). */
export const attemptDeadline = (
	startAt: number,
	packBytes: number | null,
): number =>
	startAt + importTimeoutMs(packBytes) + VERIFY_BUDGET_MS + LANE_SEED_GRACE_MS;

/** The phase an attempt starts in (`lanes.seed_phase`): minting its capability. */
export const START_PHASE = "cap" as const;

const position = (mode: LaneMode): number => LANE_FALLBACK_ORDER.indexOf(mode);

/**
 * The first mode of `chain` at or after `mode` in the fixed order: a mode the
 * rendered chain left out moves on to the next one that is in it. The chain
 * always ends at `branch`.
 */
export const modeIn = (
	mode: LaneMode,
	chain: readonly LaneMode[],
): LaneMode =>
	chain.find((step) => position(step) >= position(mode)) ?? "branch";

/** The mode after `mode` in `chain`. */
export const nextMode = (
	mode: LaneMode,
	chain: readonly LaneMode[],
): LaneMode =>
	chain.find((step) => position(step) > position(mode)) ?? "branch";

/** True while the breaker holds the repo on a later mode. */
export const degradedMode = (
	breaker: LaneBreakerState | null,
	now: number,
): LaneMode | null =>
	breaker?.degradedTo !== undefined && breaker.until !== undefined &&
		breaker.until > now
		? breaker.degradedTo
		: null;

export type FirstSeedInput = {
	/** The repo's configured mode (`meta.lane_mode`, else `LANE_MODE`). */
	readonly configured: LaneMode;
	/** `laneFallback(TARTAN_LANE_FALLBACK)`. */
	readonly chain: readonly LaneMode[];
	readonly now: number;
	readonly breaker: LaneBreakerState | null;
	/** `meta.import_too_large_until`. */
	readonly tooLargeUntil: number | null;
	/** `meta.trunk_pack_bytes`. */
	readonly packBytes: number | null;
	/** The forge-wide ceiling of retained lane repos is known to be reached. */
	readonly ceilingReached: boolean;
};

export type FirstSeed =
	| { readonly mode: LaneSeed }
	| {
		readonly mode: "branch";
		readonly reason?: "degraded" | "lane-too-large" | "lane-repo-ceiling";
	};

/** What a new lane tries first (the breaker decides). */
export const firstSeed = (input: FirstSeedInput): FirstSeed => {
	let mode = modeIn(input.configured, input.chain);
	let reason: "degraded" | "lane-too-large" | undefined;
	const degraded = degradedMode(input.breaker, input.now);
	if (degraded !== null && position(degraded) > position(mode)) {
		mode = modeIn(degraded, input.chain);
		reason = "degraded";
	}
	const tooLarge = (input.tooLargeUntil ?? 0) > input.now ||
		(input.packBytes ?? 0) > LANE_IMPORT_MAX_BYTES;
	if (mode === "import" && tooLarge) {
		mode = nextMode("import", input.chain);
		reason = "lane-too-large";
	}
	if (mode === "branch") {
		return reason === undefined ? { mode } : { mode, reason };
	}
	if (input.ceilingReached) {
		return { mode: "branch", reason: "lane-repo-ceiling" };
	}
	return { mode };
};

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/** What the capability route reported on the attempt's nonce (`lanes.cap_*`). */
export type CapEvidence = {
	readonly uses: number;
	readonly consumedAt: number | null;
	readonly outcome: string | null;
};

/**
 * A failed `import()`: `MEMORY_LIMIT` ⇒ `lane-too-large`; a 429 ⇒
 * `rate-limited`; the route answered `trunk-moved` ⇒ `trunk-moved`; the route
 * saw no request for the nonce ⇒ `importer-unreachable`; the JS-side timeout
 * ⇒ `import-timeout`; anything else ⇒ `import-error`.
 */
export const classifyImportFailure = (
	error: unknown,
	evidence: CapEvidence,
	timedOut: boolean,
): LaneSeedFailCode => {
	if (isRepoStoreError(error, "MEMORY_LIMIT")) return "lane-too-large";
	if (!timedOut && isRateLimitError(error)) return "rate-limited";
	if (evidence.outcome === "trunk-moved") return "trunk-moved";
	if (evidence.uses === 0 && evidence.consumedAt === null) {
		return "importer-unreachable";
	}
	return timedOut ? "import-timeout" : "import-error";
};

// ---------------------------------------------------------------------------
// Fallback rules
// ---------------------------------------------------------------------------

/** One ended attempt of a lane, oldest first. */
export type AttemptOutcome = {
	readonly attempt: number;
	readonly seed: LaneSeed;
	readonly code: LaneSeedFailCode | null;
};

const TRANSIENT: readonly LaneSeedFailCode[] = [
	"trunk-moved",
	"interrupted",
	"rate-limited",
];
/** Codes after which `import` is retried once before the lane falls back. */
const IMPORT_RETRY_ONCE: readonly LaneSeedFailCode[] = [
	"import-error",
	"import-timeout",
	"importer-unreachable",
	"verify-failed",
];
/** Backoff of the `rate-limited` retries: 1 s, 2 s, 4 s. */
export const RATE_LIMIT_BACKOFF_MS = [1_000, 2_000, 4_000] as const;

export type NextStep =
	| {
		readonly kind: "seed";
		readonly seed: LaneSeed;
		/** Wait this long before starting it (the rate-limit backoff). */
		readonly delayMs: number;
	}
	| { readonly kind: "branch" };

/** The mode a `NextStep` names, for `lane.seed_failed.next`. */
export const nextOf = (step: NextStep): LaneMode =>
	step.kind === "seed" ? step.seed : "branch";

const advance = (
	seed: LaneSeed,
	chain: readonly LaneMode[],
): NextStep => {
	const next = nextMode(seed, chain);
	return next === "branch"
		? { kind: "branch" }
		: { kind: "seed", seed: next, delayMs: 0 };
};

/**
 * What a lane tries after `failed` (the attempt just ended; `history` holds
 * every earlier ended attempt, oldest first): a transient code retries the
 * same seed (≤ `LANE_SEED_TRANSIENT_RETRIES` per lane, rate limits after
 * 1 s, 2 s, 4 s); `import` gets one more try after a platform-side failure;
 * `lane-too-large` goes to `branch` at once, as do `lane-repo-ceiling` and
 * attempt 9.
 */
export const nextAfterFailure = (input: {
	readonly failed: AttemptOutcome & { readonly code: LaneSeedFailCode };
	readonly history: readonly AttemptOutcome[];
	readonly chain: readonly LaneMode[];
}): NextStep => {
	const { failed, chain } = input;
	const all = [...input.history, failed];
	if (failed.code === "lane-repo-ceiling") return { kind: "branch" };
	if (failed.attempt >= LANE_SEED_MAX_ATTEMPTS) return { kind: "branch" };
	if (TRANSIENT.includes(failed.code)) {
		const transient = all.filter((a) =>
			a.code !== null && TRANSIENT.includes(a.code)
		).length;
		if (transient > LANE_SEED_TRANSIENT_RETRIES) {
			return advance(failed.seed, chain);
		}
		const limited = all.filter((a) => a.code === "rate-limited").length;
		const delayMs = failed.code === "rate-limited"
			? RATE_LIMIT_BACKOFF_MS[
				Math.min(limited, RATE_LIMIT_BACKOFF_MS.length) - 1
			]
			: 0;
		return { kind: "seed", seed: failed.seed, delayMs };
	}
	if (IMPORT_RETRY_ONCE.includes(failed.code)) {
		const tries = all.filter((a) =>
			a.seed === "import" && a.code !== null &&
			IMPORT_RETRY_ONCE.includes(a.code)
		).length;
		if (tries <= 1) return { kind: "seed", seed: "import", delayMs: 0 };
	}
	return advance(failed.seed, chain);
};

// ---------------------------------------------------------------------------
// Breaker
// ---------------------------------------------------------------------------

/**
 * A strike is counted per LANE OUTCOME: the lane left `opening` on a later
 * seed or backend than its first one and at least one of its failed attempts
 * had a platform-side code. Tartan-side codes and `lane-too-large` never
 * strike; a lane closed while `opening` never reaches this.
 */
export const strikeOf = (input: {
	readonly firstSeed: LaneSeed;
	/** The seed the lane opened on, or `branch` after the fallback. */
	readonly final: LaneMode;
	readonly attempts: readonly AttemptOutcome[];
}): LanePlatformFaultCode | null => {
	if (input.final === input.firstSeed) return null;
	const fault = input.attempts.find((a) =>
		a.code !== null && isLanePlatformFault(a.code)
	);
	return fault?.code !== undefined && fault.code !== null &&
			isLanePlatformFault(fault.code)
		? fault.code
		: null;
};

export type BreakerUpdate = {
	readonly state: LaneBreakerState;
	/** Set when this strike degraded the repo (⇒ `lane.mode_degraded`). */
	readonly degraded?: {
		readonly from: LaneMode;
		readonly to: LaneMode;
		readonly until: number;
		readonly strikes: LaneBreakerState["strikes"];
	};
};

/**
 * Records one lane's strike: 3 different lanes within 10 minutes move the
 * repo to the next mode after the one new lanes try now, for 1 hour. The
 * strike list restarts after a degradation, so it is never counted twice.
 * Only a lane whose FIRST seed is the mode new lanes try now strikes: a lane
 * that started before a degradation (or before the repo's mode changed)
 * reports a fault of a mode the breaker already left, so it is dropped.
 */
export const recordStrike = (input: {
	readonly state: LaneBreakerState | null;
	readonly strike: {
		readonly at: number;
		readonly laneId: string;
		readonly code: LanePlatformFaultCode;
	};
	/** The seed the striking lane tried first. */
	readonly firstSeed: LaneSeed;
	/** What new lanes try now (the configured mode, or the current degradation). */
	readonly effective: LaneMode;
	readonly chain: readonly LaneMode[];
}): BreakerUpdate => {
	const { strike } = input;
	const previous = input.state;
	if (input.firstSeed !== input.effective) {
		return { state: previous ?? { strikes: [] } };
	}
	const recent = (previous?.strikes ?? []).filter((s) =>
		s.at > strike.at - LANE_BREAKER.windowMs && s.laneId !== strike.laneId
	);
	const strikes = [...recent, strike];
	const keep = degradedMode(previous, strike.at) !== null
		? { degradedTo: previous?.degradedTo, until: previous?.until }
		: {};
	const lanes = new Set(strikes.map((s) => s.laneId));
	// (A `branch` repo never gets here: no lane's first seed is `branch`.)
	if (lanes.size < LANE_BREAKER.strikes) {
		return { state: { strikes, ...stripUndefined(keep) } };
	}
	const to = nextMode(input.effective, input.chain);
	const until = strike.at + LANE_BREAKER.degradeMs;
	return {
		state: { strikes: [], degradedTo: to, until },
		degraded: { from: input.effective, to, until, strikes },
	};
};

const stripUndefined = (
	value: { degradedTo?: LaneMode; until?: number },
): { degradedTo?: LaneMode; until?: number } =>
	Object.fromEntries(
		Object.entries(value).filter(([, v]) => v !== undefined),
	) as { degradedTo?: LaneMode; until?: number };

/** Parses `meta.lane_breaker` (null for a missing or malformed value). */
export const parseBreaker = (raw: string | null): LaneBreakerState | null => {
	if (raw === null) return null;
	try {
		const value = JSON.parse(raw) as LaneBreakerState;
		if (typeof value !== "object" || value === null) return null;
		return {
			strikes: Array.isArray(value.strikes) ? value.strikes : [],
			...(typeof value.degradedTo === "string"
				? { degradedTo: value.degradedTo }
				: {}),
			...(typeof value.until === "number" ? { until: value.until } : {}),
		};
	} catch {
		return null;
	}
};
