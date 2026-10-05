// The Change Graph's model: one
// swimlane per lane, folded from the lanes API (WP5a `LanesResponse`) and the
// repo's event log (WP6 `/-/api/events`, then `/-/live` frames). Pure: the
// view owns fetching and the socket; tests feed envelopes directly.
//
// What each event contributes (contract `events.ts`, `interfaces.ts`):
// - `lane.*`: state (`opening → open` with the seed time), head, delegates;
//   an unknown lane id is reported so the view can fetch it.
// - `push.accepted` with `target = <laneId>`: a push tick, the head, the count.
// - `work.created` / `work.claimed`: the work item's title and its lane.
// - `changes.*`: the lane's change (for the change page link) and the
//   lane transitions (`LANE_EVENT_TRANSITIONS`, copied below).
// - `land.*` / `changes.landed`: `landing`, back to `submitted`, `landed`.
// - `checks.*` (subject = the change) and `run.*` (subject = change or lane):
//   the CI dot.
// - `conflicts.*`: the radar badge (open conflicts per lane, worst severity).

import type { LaneDto } from "@tartan/contract/api.ts";
import type { Envelope } from "@tartan/contract/events.ts";
import type { LaneState } from "@tartan/contract/lanes.ts";

/** The event patterns the graph folds (history read and live subscription). */
export const GRAPH_EVENT_PATTERNS: readonly string[] = [
	"lane.*",
	"push.accepted",
	"work.created",
	"work.claimed",
	"changes.*",
	"land.*",
	"checks.*",
	"run.*",
	"conflicts.*",
];

/** `LANE_EVENT_TRANSITIONS` (`@tartan/contract/lanes.ts`); parity-tested. */
export const LANE_EVENT_TRANSITIONS: Readonly<
	Record<
		string,
		{ readonly from: readonly LaneState[]; readonly to: LaneState }
	>
> = {
	"changes.submitted": { from: ["open", "submitted"], to: "submitted" },
	"changes.abandoned": { from: ["submitted"], to: "open" },
	"changes.superseded": { from: ["submitted"], to: "open" },
};

/** Lanes still doing work (shown first, counted as active). */
export const ACTIVE_STATES: readonly LaneState[] = [
	"opening",
	"open",
	"submitted",
	"landing",
];

/** `conflicts@1` severities, mildest first (`CONFLICT_SEVERITIES`; parity-tested). */
export const CONFLICT_SEVERITIES = [
	"declared",
	"same_project",
	"same_file",
	"adjacent",
	"textual",
	"semantic",
	"trunk_drift",
] as const;
export type ConflictSeverity = typeof CONFLICT_SEVERITIES[number];

export type CiState =
	| "pending"
	| "running"
	| "success"
	| "failure"
	| "cancelled"
	| "skipped"
	| "cached";

type Conflict = {
	readonly a: string;
	readonly b: string;
	readonly path: string;
	readonly severity: ConflictSeverity;
	readonly state: "open" | "acked";
};

type ChecksOf = {
	/** context → state of `checks.updated`. */
	readonly contexts: Readonly<Record<string, CiState>>;
	/** `checks.completed` of the latest sha, once seen. */
	readonly completed: CiState | null;
	readonly sha: string | null;
	readonly at: number;
};

type RunOf = { readonly state: CiState; readonly at: number };

type SeedFailure = { readonly code: string; readonly next: string };

export type GraphState = {
	readonly lanes: ReadonlyMap<string, LaneDto>;
	/** Work ref → title (`work.created`). */
	readonly workTitles: ReadonlyMap<string, string>;
	/** Lane → work ref (`work.claimed`, or the lane's own entity). */
	readonly laneWork: ReadonlyMap<string, string>;
	/** Lane → its latest change id; and back. */
	readonly laneChange: ReadonlyMap<string, string>;
	readonly changeLane: ReadonlyMap<string, string>;
	/** Lane → push times (ascending, at most `MAX_TICKS`). */
	readonly pushes: ReadonlyMap<string, readonly number[]>;
	/** Change id → checks. */
	readonly checks: ReadonlyMap<string, ChecksOf>;
	/** Change or lane id → its latest run state. */
	readonly runs: ReadonlyMap<string, RunOf>;
	readonly conflicts: ReadonlyMap<string, Conflict>;
	readonly seedFailures: ReadonlyMap<string, SeedFailure>;
	/** The last folded event's seq (0 before any). */
	readonly head: number;
	/** Lane ids that events named but the lanes list did not have. */
	readonly unknownLanes: ReadonlySet<string>;
	/** Lanes of simulated agents: named by an event flagged `sim`. */
	readonly simLanes: ReadonlySet<string>;
};

export const MAX_TICKS = 200;
/** The model bulk-minted swarm agents carry (`agent_model`, WP2). */
export const SIM_MODEL = "sim";

export const emptyGraph = (): GraphState => ({
	lanes: new Map(),
	workTitles: new Map(),
	laneWork: new Map(),
	laneChange: new Map(),
	changeLane: new Map(),
	pushes: new Map(),
	checks: new Map(),
	runs: new Map(),
	conflicts: new Map(),
	seedFailures: new Map(),
	head: 0,
	unknownLanes: new Set(),
	simLanes: new Set(),
});

const LANE_ID_RE = /^ln_[0-9a-z]{26}$/;

const str = (value: unknown): string | undefined =>
	typeof value === "string" && value !== "" ? value : undefined;

const num = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

const record = (value: unknown): Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};

const CI_STATES: ReadonlySet<string> = new Set([
	"pending",
	"running",
	"success",
	"failure",
	"cancelled",
	"skipped",
	"cached",
]);

/** Run and job states (free-form strings in `RunEventData`) → a CI state. */
const ciStateOf = (value: unknown): CiState | null => {
	const s = str(value);
	if (s === undefined) return null;
	if (CI_STATES.has(s)) return s as CiState;
	switch (s) {
		case "queued":
		case "waiting":
			return "pending";
		case "started":
		case "in_progress":
			return "running";
		case "passed":
		case "ok":
		case "completed":
			return "success";
		case "failed":
		case "error":
		case "timed_out":
			return "failure";
		default:
			return null;
	}
};

const severityRank = (s: ConflictSeverity): number =>
	CONFLICT_SEVERITIES.indexOf(s);

const isSeverity = (value: unknown): value is ConflictSeverity =>
	typeof value === "string" &&
	(CONFLICT_SEVERITIES as readonly string[]).includes(value);

const LANE_EVENT_STATE: Readonly<Record<string, LaneState>> = {
	"lane.opening": "opening",
	"lane.opened": "open",
	"lane.closed": "closed",
	"lane.lost": "lost",
	"lane.archived": "archived",
	"lane.deleted": "deleted",
};

const withEntry = <K, V>(map: ReadonlyMap<K, V>, key: K, value: V) =>
	new Map(map).set(key, value);

const withoutEntry = <K, V>(map: ReadonlyMap<K, V>, key: K) => {
	const next = new Map(map);
	next.delete(key);
	return next;
};

/** Seeds the graph from a lanes page (replacing what it knew of those lanes). */
export const withLanes = (
	state: GraphState,
	lanes: readonly LaneDto[],
): GraphState => {
	const next = new Map(state.lanes);
	const unknown = new Set(state.unknownLanes);
	let laneWork = state.laneWork;
	for (const lane of lanes) {
		next.set(lane.id, lane);
		unknown.delete(lane.id);
		if (lane.entity?.kind === "work" && !laneWork.has(lane.id)) {
			laneWork = withEntry(laneWork, lane.id, lane.entity.id);
		}
	}
	return { ...state, lanes: next, unknownLanes: unknown, laneWork };
};

const updateLane = (
	state: GraphState,
	laneId: string,
	patch: (lane: LaneDto) => LaneDto,
): GraphState => {
	const lane = state.lanes.get(laneId);
	if (!lane) {
		return LANE_ID_RE.test(laneId) && !state.unknownLanes.has(laneId)
			? { ...state, unknownLanes: new Set(state.unknownLanes).add(laneId) }
			: state;
	}
	const updated = patch(lane);
	return updated === lane
		? state
		: { ...state, lanes: withEntry(state.lanes, laneId, updated) };
};

const setLaneState = (
	state: GraphState,
	laneId: string,
	to: LaneState,
	from?: readonly LaneState[],
): GraphState =>
	updateLane(
		state,
		laneId,
		(lane) =>
			lane.state === to || (from !== undefined && !from.includes(lane.state))
				? lane
				: { ...lane, state: to },
	);

const linkChange = (
	state: GraphState,
	changeId: string | undefined,
	laneId: string | undefined,
): GraphState =>
	changeId === undefined || laneId === undefined ? state : {
		...state,
		laneChange: withEntry(state.laneChange, laneId, changeId),
		changeLane: withEntry(state.changeLane, changeId, laneId),
	};

const laneOfChange = (
	state: GraphState,
	changeId: string | undefined,
): string | undefined =>
	changeId === undefined ? undefined : state.changeLane.get(changeId);

const foldLaneEvent = (state: GraphState, e: Envelope): GraphState => {
	const d = record(e.data);
	const laneId = str(d["laneId"]);
	if (laneId === undefined) return state;
	if (e.type === "lane.seed_failed") {
		const code = str(d["code"]);
		const next = str(d["next"]);
		return code && next
			? {
				...state,
				seedFailures: withEntry(state.seedFailures, laneId, { code, next }),
			}
			: state;
	}
	const to = LANE_EVENT_STATE[e.type];
	const before = state.lanes.get(laneId);
	const next = updateLane(state, laneId, (lane) => {
		const head = str(d["head"]);
		const base = str(d["base"]);
		const mode = d["mode"] === "repo" || d["mode"] === "branch"
			? d["mode"]
			: lane.mode;
		const seedMs = num(d["seedMs"]);
		const delegates = Array.isArray(d["delegates"])
			? (d["delegates"] as unknown[]).filter((p): p is string =>
				typeof p === "string"
			)
			: lane.delegates;
		return {
			...lane,
			...(to !== undefined ? { state: to } : {}),
			...(head !== undefined ? { head } : {}),
			...(base !== undefined ? { base } : {}),
			...(seedMs !== undefined ? { seedMs } : {}),
			...(to === "closed" || to === "archived" || to === "deleted"
				? { closedAt: lane.closedAt ?? e.at }
				: {}),
			mode,
			delegates,
		};
	});
	// A backend fallback (`repo` → `branch` while opening) changes the ref and
	// the remote too, which the event does not carry: re-read the lane.
	const after = next.lanes.get(laneId);
	return before && after && before.mode !== after.mode
		? { ...next, unknownLanes: new Set(next.unknownLanes).add(laneId) }
		: next;
};

const foldPush = (state: GraphState, e: Envelope): GraphState => {
	const d = record(e.data);
	const target = str(d["target"]);
	if (target === undefined || target === "repo") return state;
	const ticks = [...(state.pushes.get(target) ?? []), e.at]
		.sort((a, b) => a - b)
		.slice(-MAX_TICKS);
	const after = str(d["after"]);
	// The lanes API already counted pushes up to its `lastPushAt`; only a
	// later push (the history read after it, or live) adds to the count.
	const counted = updateLane(
		state,
		target,
		(lane) =>
			e.at <= (lane.lastPushAt ?? -Infinity) ? lane : {
				...lane,
				pushes: lane.pushes + 1,
				lastPushAt: e.at,
				...(after !== undefined ? { head: after } : {}),
			},
	);
	return { ...counted, pushes: withEntry(state.pushes, target, ticks) };
};

const foldChange = (state: GraphState, e: Envelope): GraphState => {
	const d = record(e.data);
	const changeId = str(d["changeId"]);
	const laneId = str(d["laneId"]) ?? laneOfChange(state, changeId);
	let next = linkChange(state, changeId, laneId);
	const workRef = str(d["workRef"]);
	if (laneId !== undefined && workRef !== undefined) {
		next = { ...next, laneWork: withEntry(next.laneWork, laneId, workRef) };
	}
	if (laneId === undefined) return next;
	const transition = LANE_EVENT_TRANSITIONS[e.type];
	if (transition) {
		return setLaneState(next, laneId, transition.to, transition.from);
	}
	if (e.type === "changes.landed") return setLaneState(next, laneId, "landed");
	return next;
};

const foldLand = (state: GraphState, e: Envelope): GraphState => {
	const d = record(e.data);
	if (e.type === "land.submitted" || e.type === "land.testing") {
		const changes = Array.isArray(d["changes"]) ? d["changes"] : [];
		let next = state;
		for (const c of changes) {
			const r = record(c);
			const changeId = str(r["changeId"]);
			const laneId = str(r["laneId"]) ?? laneOfChange(next, changeId);
			next = linkChange(next, changeId, laneId);
			if (laneId) next = setLaneState(next, laneId, "landing", ["submitted"]);
		}
		return next;
	}
	if (e.type === "land.completed") {
		let next = state;
		const landed = Array.isArray(d["landed"]) ? d["landed"] : [];
		for (const l of landed) {
			const laneId = laneOfChange(next, str(record(l)["changeId"]));
			if (laneId) next = setLaneState(next, laneId, "landed");
		}
		for (const key of ["conflicted", "vetoed"]) {
			const ids = Array.isArray(d[key]) ? d[key] as unknown[] : [];
			for (const id of ids) {
				const laneId = laneOfChange(next, str(id));
				if (laneId) next = setLaneState(next, laneId, "submitted", ["landing"]);
			}
		}
		return next;
	}
	if (e.type === "land.conflicted" || e.type === "land.vetoed") {
		const laneId = laneOfChange(state, str(d["changeId"]));
		return laneId
			? setLaneState(state, laneId, "submitted", ["landing"])
			: state;
	}
	return state;
};

const foldChecks = (state: GraphState, e: Envelope): GraphState => {
	const d = record(e.data);
	const subject = record(d["subject"]);
	if (subject["kind"] !== "change") return state;
	const changeId = str(subject["id"]);
	if (changeId === undefined) return state;
	const sha = str(d["sha"]) ?? null;
	const prior = state.checks.get(changeId);
	// A new sha starts a new set of checks.
	const base: ChecksOf = prior && prior.sha === sha
		? prior
		: { contexts: {}, completed: null, sha, at: e.at };
	let next: ChecksOf = base;
	if (e.type === "checks.updated") {
		const context = str(d["context"]);
		const s = ciStateOf(d["state"]);
		if (context === undefined || s === null) return state;
		next = { ...base, contexts: { ...base.contexts, [context]: s }, at: e.at };
	} else if (e.type === "checks.completed") {
		const s = ciStateOf(d["state"]);
		if (s === null) return state;
		next = { ...base, completed: s, at: e.at };
	} else {
		return state;
	}
	return { ...state, checks: withEntry(state.checks, changeId, next) };
};

const foldRun = (state: GraphState, e: Envelope): GraphState => {
	if (e.type !== "run.started" && e.type !== "run.completed") return state;
	const d = record(e.data);
	const subject = record(d["subject"] ?? e.subject);
	const kind = subject["kind"];
	const id = str(subject["id"]);
	if ((kind !== "change" && kind !== "lane") || id === undefined) return state;
	const s = ciStateOf(d["state"]) ??
		(e.type === "run.started" ? "running" : null);
	if (s === null) return state;
	return { ...state, runs: withEntry(state.runs, id, { state: s, at: e.at }) };
};

const foldConflict = (state: GraphState, e: Envelope): GraphState => {
	const d = record(e.data);
	const id = str(d["conflictId"]);
	if (id === undefined) return state;
	const known = state.conflicts.get(id);
	switch (e.type) {
		case "conflicts.detected": {
			const a = str(d["a"]);
			const b = str(d["b"]);
			const severity = d["severity"];
			if (a === undefined || b === undefined || !isSeverity(severity)) {
				return state;
			}
			return {
				...state,
				conflicts: withEntry(state.conflicts, id, {
					a,
					b,
					path: str(d["path"]) ?? "",
					severity,
					state: "open",
				}),
			};
		}
		case "conflicts.escalated":
			return known && isSeverity(d["to"])
				? {
					...state,
					conflicts: withEntry(state.conflicts, id, {
						...known,
						severity: d["to"],
					}),
				}
				: state;
		case "conflicts.acked":
			return known
				? {
					...state,
					conflicts: withEntry(state.conflicts, id, {
						...known,
						state: "acked",
					}),
				}
				: state;
		case "conflicts.cleared":
			return known
				? { ...state, conflicts: withoutEntry(state.conflicts, id) }
				: state;
		default:
			return state;
	}
};

const foldWork = (state: GraphState, e: Envelope): GraphState => {
	const d = record(e.data);
	const ref = str(d["ref"]);
	if (ref === undefined) return state;
	if (e.type === "work.created") {
		const title = str(d["title"]);
		return title
			? { ...state, workTitles: withEntry(state.workTitles, ref, title) }
			: state;
	}
	const laneId = str(d["laneId"]);
	return e.type === "work.claimed" && laneId !== undefined
		? { ...state, laneWork: withEntry(state.laneWork, laneId, ref) }
		: state;
};

/** Folds one envelope (shadow events never change the graph). */
/** The lane a lane or push event names (`laneId`, or a push's `target`). */
const laneOfEvent = (e: Envelope): string | undefined => {
	const data = record(e.data);
	const id = e.type.startsWith("lane.")
		? str(data["laneId"])
		: e.type.startsWith("push.")
		? str(data["target"])
		: undefined;
	return id !== undefined && LANE_ID_RE.test(id) ? id : undefined;
};

const markSim = (state: GraphState, e: Envelope): GraphState => {
	if (e.sim !== true) return state;
	const lane = laneOfEvent(e);
	if (lane === undefined || state.simLanes.has(lane)) return state;
	return { ...state, simLanes: new Set([...state.simLanes, lane]) };
};

export const foldEvent = (state: GraphState, e: Envelope): GraphState => {
	if (e.shadow) return state;
	const seen = markSim({ ...state, head: Math.max(state.head, e.seq) }, e);
	const ns = e.type.split(".")[0];
	switch (ns) {
		case "lane":
			return foldLaneEvent(seen, e);
		case "push":
			return e.type === "push.accepted" ? foldPush(seen, e) : seen;
		case "work":
			return foldWork(seen, e);
		case "changes":
			return foldChange(seen, e);
		case "land":
			return foldLand(seen, e);
		case "checks":
			return foldChecks(seen, e);
		case "run":
			return foldRun(seen, e);
		case "conflicts":
			return foldConflict(seen, e);
		default:
			return seen;
	}
};

/** Folds envelopes in seq order, skipping any already folded (replays). */
export const foldEvents = (
	state: GraphState,
	events: readonly Envelope[],
): GraphState =>
	[...events]
		.filter((e) => e.seq > state.head)
		.sort((a, b) => a.seq - b.seq)
		.reduce(foldEvent, state);

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type AgentInfo = {
	readonly handle: string;
	readonly display: string;
	readonly tool?: string;
	readonly model?: string;
};

export type CiSummary = {
	readonly state: CiState;
	/** e.g. "2 of 3 checks passed". */
	readonly label: string;
};

export type RadarSummary = {
	readonly open: number;
	readonly worst: ConflictSeverity | null;
	/** The other sides (lane ids or `trunk`). */
	readonly with: readonly string[];
	readonly paths: readonly string[];
};

export type LaneRow = {
	readonly lane: LaneDto;
	readonly agent: AgentInfo | null;
	readonly workRef: string | null;
	readonly workTitle: string | null;
	readonly changeId: string | null;
	/** Footprint chips: projects, then path prefixes. */
	readonly chips: readonly string[];
	readonly pushes: readonly number[];
	readonly ci: CiSummary | null;
	readonly radar: RadarSummary;
	readonly seedFailure: SeedFailure | null;
	readonly active: boolean;
	/** A simulated agent's lane (swarm): an event flagged `sim`, or the agent's model `sim`. */
	readonly sim: boolean;
};

const CI_LABELS: Readonly<Record<CiState, string>> = {
	pending: "CI pending",
	running: "CI running",
	success: "CI passed",
	failure: "CI failed",
	cancelled: "CI cancelled",
	skipped: "CI skipped",
	cached: "CI passed (cached)",
};

/** The aggregate of one change's checks: failure > running > pending > passed. */
export const ciSummaryOf = (checks: ChecksOf): CiSummary | null => {
	const states = Object.values(checks.contexts);
	const total = states.length;
	const passed =
		states.filter((s) => s === "success" || s === "cached" || s === "skipped")
			.length;
	const state: CiState | null = checks.completed ??
		(states.includes("failure")
			? "failure"
			: states.includes("running")
			? "running"
			: states.includes("pending")
			? "pending"
			: states.includes("cancelled")
			? "cancelled"
			: total > 0
			? "success"
			: null);
	if (state === null) return null;
	const detail = total > 0 ? ` · ${passed} of ${total} checks passed` : "";
	return { state, label: `${CI_LABELS[state]}${detail}` };
};

const ciOf = (state: GraphState, lane: LaneDto): CiSummary | null => {
	const changeId = state.laneChange.get(lane.id);
	const checks = changeId ? state.checks.get(changeId) : undefined;
	const fromChecks = checks ? ciSummaryOf(checks) : null;
	if (fromChecks) return fromChecks;
	const run = (changeId ? state.runs.get(changeId) : undefined) ??
		state.runs.get(lane.id);
	return run ? { state: run.state, label: CI_LABELS[run.state] } : null;
};

const radarOf = (state: GraphState, laneId: string): RadarSummary => {
	let worst: ConflictSeverity | null = null;
	const others = new Set<string>();
	const paths = new Set<string>();
	let open = 0;
	for (const c of state.conflicts.values()) {
		if (c.state !== "open" || (c.a !== laneId && c.b !== laneId)) continue;
		open += 1;
		others.add(c.a === laneId ? c.b : c.a);
		if (c.path) paths.add(c.path);
		if (worst === null || severityRank(c.severity) > severityRank(worst)) {
			worst = c.severity;
		}
	}
	return { open, worst, with: [...others], paths: [...paths] };
};

const chipsOf = (lane: LaneDto): string[] => [
	...lane.footprint.projects,
	...lane.footprint.prefixes,
];

const lastActivity = (row: LaneRow): number =>
	Math.max(
		row.lane.lastPushAt ?? 0,
		row.lane.createdAt,
		row.pushes[row.pushes.length - 1] ?? 0,
	);

/**
 * One row per lane: active lanes first, then by latest activity. The graph
 * reads only active lanes, so inactive ones are lanes seen finishing (or
 * asked for by id); they stay, dimmed, unless `includeInactive` is false.
 */
export const laneRows = (
	state: GraphState,
	agents: ReadonlyMap<string, AgentInfo>,
	options: { readonly includeInactive?: boolean } = {},
): LaneRow[] => {
	const rows: LaneRow[] = [];
	const includeInactive = options.includeInactive ?? true;
	for (const lane of state.lanes.values()) {
		const active = ACTIVE_STATES.includes(lane.state);
		if (!active && !includeInactive) continue;
		const workRef = state.laneWork.get(lane.id) ??
			(lane.entity?.kind === "work" ? lane.entity.id : null);
		const agent = agents.get(lane.owner) ?? null;
		rows.push({
			lane,
			agent,
			workRef,
			workTitle: workRef ? state.workTitles.get(workRef) ?? null : null,
			changeId: state.laneChange.get(lane.id) ?? null,
			chips: chipsOf(lane),
			pushes: state.pushes.get(lane.id) ?? [],
			ci: ciOf(state, lane),
			radar: radarOf(state, lane.id),
			seedFailure: state.seedFailures.get(lane.id) ?? null,
			active,
			sim: state.simLanes.has(lane.id) || agent?.model === SIM_MODEL,
		});
	}
	return rows.sort((a, b) =>
		Number(b.active) - Number(a.active) ||
		lastActivity(b) - lastActivity(a) ||
		a.lane.id.localeCompare(b.lane.id)
	);
};

// ---------------------------------------------------------------------------
// Time axis and windowing
// ---------------------------------------------------------------------------

export const AXIS_WIDTH = 1000;
const MIN_SPAN = 30 * 60_000;
const MAX_SPAN = 24 * 60 * 60_000;

/** The shared time window of the swimlanes: the oldest row's open → now (30 min – 24 h). */
export const timeAxis = (
	rows: readonly LaneRow[],
	now: number,
): { readonly from: number; readonly to: number } => {
	const oldest = rows.reduce(
		(min, r) => Math.min(min, r.lane.createdAt, r.pushes[0] ?? Infinity),
		now,
	);
	const span = Math.min(MAX_SPAN, Math.max(MIN_SPAN, now - oldest));
	return { from: now - span, to: now };
};

/** An epoch time → x on the `0..AXIS_WIDTH` track (clamped). */
export const axisX = (
	at: number,
	axis: { readonly from: number; readonly to: number },
): number => {
	const span = axis.to - axis.from;
	if (span <= 0) return AXIS_WIDTH;
	const x = ((at - axis.from) / span) * AXIS_WIDTH;
	return Math.round(Math.min(AXIS_WIDTH, Math.max(0, x)) * 10) / 10;
};

/** The rows to render for a scroll position (`overscan` rows either side). */
export const windowRange = (
	count: number,
	rowHeight: number,
	scrollTop: number,
	viewportHeight: number,
	overscan = 8,
): { readonly start: number; readonly end: number } => {
	if (count === 0 || rowHeight <= 0) return { start: 0, end: 0 };
	const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
	const visible = Math.ceil(Math.max(0, viewportHeight) / rowHeight) + 1;
	const start = Math.max(0, Math.min(count - 1, first) - overscan);
	const end = Math.min(count, first + visible + overscan);
	return { start, end: Math.max(start, end) };
};

/** A principal id for display when no agent record names it. */
export const principalLabel = (id: string): string => {
	if (id === "sys_kernel") return "Tartan";
	const cut = id.indexOf("_");
	const prefix = cut === -1 ? "" : id.slice(0, cut);
	const kind = prefix === "a"
		? "agent"
		: prefix === "u"
		? "user"
		: prefix === "x"
		? "extension"
		: "principal";
	return `${kind} …${id.slice(-6)}`;
};
