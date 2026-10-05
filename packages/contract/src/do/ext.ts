// ExtensionDO (`ext:<instId>:<scopeKey>`): host table rows and its RPC
// surface (WP7b). Every entry point runs under one in-memory
// async mutex per ExtensionDO; `render`, `context` and calls of
// non-mutating tools are read-only and bypass it.
//
// Reentrancy: a mutating call holds the mutex across any awaited
// `interfaces.call`, so a cycle A → B → A would deadlock until the host
// timeout. `CapsProps.callChain` carries the installation ids of the chain;
// the host rejects a call into an installation already on it with
// `conflict("call cycle")` before taking the mutex.

import type { Actor, ActorBounds, StreamRef } from "../common.ts";
import type { Envelope } from "../events.ts";
import type {
	GateDecision,
	GateInput,
	GatePoint,
	PrefetchedInputs,
} from "../gates.ts";
import type { ContextRequest, ContextSection } from "../interfaces.ts";
import type { SlotContext, ToolContext } from "../slots.ts";
import type { ActionResult, HostUiDoc } from "../ui.ts";

export type HostKey =
	| "installation_id"
	| "ext"
	| "runtime"
	| "scope"
	| "mode"
	| "data_version"
	/** `closed` | `open` | `half-open`. */
	| "breaker"
	| "breaker_until"
	| "breaker_trips";
export type HostRow = { k: string; v: string };
export type ExtMigrationRow = { n: number; name: string; at: number };
export type CursorRow = { stream: string; seq: number; known_head: number };
export type SeenRow = { event_id: string; at: number };
export type RetryRow = {
	stream: string;
	event_id: string;
	attempts: number;
	next_at: number;
	error: string | null;
};
export type DeadRow = {
	event_id: string;
	stream: string;
	attempts: number;
	error: string;
	at: number;
};
export type RenderCacheRow = {
	key: string;
	data_version: number;
	ui_json: string;
	at: number;
};
export type ConsoleRow = {
	seq: number;
	at: number;
	level: string;
	msg: string;
};
/** Circuit-breaker evidence (js/wasm); pruned after 24 h. */
export type StrikeRow = {
	seq: number;
	at: number;
	method: string;
	kind: "timeout" | "cpu" | "hung" | "reset";
};
/**
 * Write-ahead marker of a facet call: inserted and `storage.sync()`'d
 * before the RPC, deleted when it settles; one older than `budget_ms` + 5 s
 * becomes a `reset` strike at the next host entry or alarm.
 */
export type InflightRow = {
	call_id: string;
	method: string;
	started_at: number;
	budget_ms: number;
};

/**
 * Host table names; extension SQL naming them (or `sqlite_*`) is rejected.
 * `_migrations` is the host-table ledger (1–99) and `_ext_migrations` the
 * extension's own (1–999); see `MIGRATION_RANGES.ext`.
 */
export const HOST_TABLES = [
	"_host",
	"_migrations",
	"_ext_migrations",
	"_cursors",
	"_seen",
	"_retry",
	"_dead",
	"_timers",
	"_render_cache",
	"_console",
	"_strikes",
	"_inflight",
] as const;

/** Event retry schedule, then a dead letter. */
export const EVENT_RETRY_BACKOFF_MS = [
	1000,
	5000,
	30000,
	120000,
	600000,
] as const;
export const SEEN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const CONSOLE_RING_ROWS = 2000;
/**
 * The per-installation circuit breaker: `strikes` strikes within
 * `windowMs` open it for `cooldownMs`; a strike while half-open reopens it
 * with a doubled cooldown, at most `maxCooldownMs`.
 */
export const BREAKER = {
	strikes: 3,
	windowMs: 600_000,
	cooldownMs: 900_000,
	maxCooldownMs: 14_400_000,
} as const;

/** The circuit breaker of one installation scope (`_host` rows). */
export type BreakerView = {
	readonly state: "closed" | "open" | "half-open";
	/** When an open breaker turns half-open. */
	readonly until: number | null;
	/** Consecutive openings (doubles the cooldown). */
	readonly trips: number;
};

/** `ExtensionHostApi.breaker()`: the view plus the strikes behind it. */
export type BreakerStatus = BreakerView & {
	/** Strikes inside the current window (`BREAKER.windowMs`). */
	readonly recentStrikes: number;
	/** The latest strikes, newest first (at most 20; kept 24 h). */
	readonly strikes: readonly StrikeRow[];
};

/**
 * Who is looking at a render: principal id (default) or role+kind (`cache:
 * "role"`). `role` is already bounded by the viewer's credential: WP7a's slot
 * handler authorizes the viewer at the node (`authorize`, with token
 * ceiling, node subtree and scopes) before calling `render`.
 */
export type Viewer = {
	readonly actor?: Actor;
	readonly role: number;
	readonly kind: "user" | "agent" | "anonymous";
};

export type EchoOutcome = {
	readonly lines: readonly string[];
	readonly timedOut: boolean;
};

/**
 * The ExtensionDO RPC surface. Context (`ctx`) is always kernel-derived and
 * confined (K12). Interactive entry points take the actor's credential
 * `bounds` as a host-side argument: it becomes `CapsProps.bounds` and is
 * never part of the extension-visible ctx.
 */
export interface ExtensionHostApi {
	/** Event delivery: store `known_head` and drain if not draining. */
	poke(input: { stream: StreamRef; head: number }): Promise<void>;
	/** `slot` is the contribution id (unique per manifest); `ctx.slot` its catalogue slot. */
	render(
		slot: string,
		ctx: SlotContext,
		viewer: Viewer,
		props?: unknown,
	): Promise<HostUiDoc>;
	action(
		slot: string,
		action: string,
		payload: unknown,
		ctx: SlotContext,
		actor: Actor,
		bounds: ActorBounds,
	): Promise<ActionResult>;
	/** Mutating tools run under the mutex; `mutating: false` tools bypass it. */
	callTool(
		name: string,
		args: unknown,
		ctx: ToolContext,
		bounds: ActorBounds,
		/** The `interfaces.call` chain (installation ids, outermost first). */
		chain?: readonly string[],
	): Promise<unknown>;
	context(req: ContextRequest, bounds: ActorBounds): Promise<ContextSection[]>;
	gate(
		point: GatePoint,
		input: GateInput,
		ctx: SlotContext,
	): Promise<GateDecision>;
	/** Sanitized, prefixed lines; `[]` on timeout. */
	echo(event: Envelope, input: PrefetchedInputs): Promise<EchoOutcome>;
	/** Admin: kill switch / upgrade (`facets.abort`). */
	abort(reason: "disabled" | "upgrade"): Promise<void>;
	console(sinceSeq: number, limit: number): Promise<ConsoleRow[]>;
	deadLetters(limit: number): Promise<DeadRow[]>;
	/** Admin: the circuit breaker's state and its strikes (js/wasm). */
	breaker(): Promise<BreakerStatus>;
	/**
	 * Owner reset: closed, strikes cleared; `by` is written to the
	 * installation console. Answers the state after it.
	 */
	resetBreaker(by: string): Promise<BreakerStatus>;
	/** Delete all extension data for this scope (uninstall, after confirmation). */
	deleteData(): Promise<void>;
}
