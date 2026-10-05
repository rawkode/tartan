// Shared vocabulary of tartan.radar (conflicts@1): severities and their order,
// which lanes take part in joins, the limits that bound one handler's effects,
// and the row shapes of the extension's own tables (migrations 1 and 2).

import type { ConflictSeverity, Suggestion } from "./types.ts";

export const EXT_ID = "tartan.radar";
/** The short label the kernel shows for this extension (notices, logs). */
export const EXT_SHORT = "radar";

/**
 * Display and escalation order. `trunk_drift` (a landed change touched your
 * paths) ranks with `same_file`: both need the lane's owner to act.
 */
export const SEVERITY_RANK: Readonly<Record<ConflictSeverity, number>> = {
	declared: 1,
	same_project: 2,
	trunk_drift: 3,
	same_file: 4,
	adjacent: 5,
	textual: 6,
	semantic: 7,
};

/**
 * Pair severities that count as a predicted conflict (stats, events,
 * owner notices): an actual file overlap. `declared` and `same_project` are
 * advisory: kept as rows, shown by tools, slots and context, never counted.
 */
export const COUNTED: ReadonlySet<ConflictSeverity> = new Set([
	"same_file",
	"adjacent",
	"textual",
	"semantic",
]);

export const isCounted = (s: ConflictSeverity): boolean => COUNTED.has(s);
/** Severities whose rows produce `conflicts.*` events. */
export const isEventful = (s: ConflictSeverity): boolean =>
	isCounted(s) || s === "trunk_drift";

/** Lane states whose touches and footprints take part in joins. */
export const ACTIVE_STATES = ["open", "submitted"] as const;
export const ACTIVE_SQL = "('open','submitted')";

/** Peers named per notice and per tool answer. */
export const MAX_NOTICE_ITEMS = 5;
/** Other owners notified by one handler run (highest severity first). */
export const MAX_NOTIFY_PEERS = 20;
/** Outbox entries flushed per call; the rest wait for the `flush` timer. */
export const FLUSH_BATCH = 40;
export const FLUSH_RETRY_MS = 2_000;
export const FLUSH_MAX_ATTEMPTS = 5;
export const FLUSH_TIMER = "flush";
/** Lanes listed per `conflicts_check` target. */
export const MAX_CHECK_LANES = 20;
export const MAX_LIST = 200;

export const STAT_KEYS = ["predicted", "avoided", "materialized"] as const;
export type StatKey = typeof STAT_KEYS[number];

export type LaneRow = {
	lane_id: string;
	owner: string;
	entity_kind: string | null;
	entity_id: string | null;
	base_sha: string;
	head_sha: string | null;
	state: string;
	mode: string;
	ref: string | null;
	remote: string | null;
	owner_label: string | null;
	work_title: string | null;
	work_why: string | null;
	change_id: string | null;
	range_base: string | null;
	commits_json: string;
	truncated: number;
	opened_at: number;
	last_push_at: number | null;
	touches_at: string | null;
};

export type ConflictRow = {
	id: string;
	a: string;
	b: string;
	path: string;
	project: string | null;
	severity: ConflictSeverity;
	detail_json: string;
	suggestion: Suggestion;
	state: "open" | "acked" | "cleared";
	ack_json: string | null;
	/** SEVERITY_RANK of the last severity the owners were told about (0: none). */
	notified: number;
	first_seen: number;
	last_seen: number;
	cleared_at: number | null;
	avoided: number | null;
};

export const TRUNK = "trunk";
