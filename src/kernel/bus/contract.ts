// The global log's own types (WP26). Contract 0.3.2 carries part of them
// (MIGRATION_RANGES, RunEventData, `run.dispatched`, HealthResponse.k2): the
// migration ranges below are read from the contract.
// The facade, status and timer types are still local; moving them into
// `@tartan/contract` (do/bus.ts, `bus()` on RepoDoApi and ForgeDoApi,
// RepoRunsFacade.dispatch) is open, and callers import them from here until
// then.
//
// The global log: every committed repo and forge event is relayed, at least
// once and in `seq` order per DO, into one K2 stream per forge
// (`tartan_<stage>_log`). Durable Objects stay the system of record; the
// stream is a replica and the bus the `workloads` consumer reads to dispatch
// CI runs.

import type { Envelope } from "@tartan/contract";
import { MIGRATION_RANGES } from "@tartan/contract/kernel.ts";

// ---------------------------------------------------------------------------
// Migration ranges and timers (contract: do/common.ts, do/repo.ts, do/forge.ts)
// ---------------------------------------------------------------------------

/** `MIGRATION_RANGES.repo.bus`, `.forge.bus` and `.bus.bus` (BusDO), from the contract. */
export const BUS_MIGRATION_RANGES = {
	repo: MIGRATION_RANGES.repo.bus,
	forge: MIGRATION_RANGES.forge.bus,
	bus: MIGRATION_RANGES.bus.bus,
} as const;

/**
 * Timer keys: `REPO_TIMERS.bus` / `FORGE_TIMERS.bus` (`relay`, the relay
 * drain), `REPO_TIMERS.runs` (`outbox`, the dispatch backstop) and
 * `BUS_TIMERS.bus` (`poll`, `retry`).
 */
export const BUS_TIMER_KEYS = {
	relay: ["relay"],
	runs: ["outbox"],
	consumer: ["poll", "retry"],
} as const;

// ---------------------------------------------------------------------------
// Run transport (contract: events.ts RunEventData, pipeline.ts RunStatus)
// ---------------------------------------------------------------------------

/** How a CI run reaches its Workflow: through the log's consumer, or inline. */
export const RUN_TRANSPORTS = ["k2", "local"] as const;
export type RunTransport = typeof RUN_TRANSPORTS[number];

/** Who created a run's Workflow instance (`run.dispatched.via`). */
export const RUN_DISPATCH_VIAS = ["k2", "backstop", "local"] as const;
export type RunDispatchVia = typeof RUN_DISPATCH_VIAS[number];

/** Why a run exists, from its subject (`run.started.priority`). */
export const RUN_PRIORITIES = ["land", "change", "push", "manual"] as const;
export type RunPriority = typeof RUN_PRIORITIES[number];

/** `RunEventData` additions (all optional; they extend the strict schema). */
export type RunEventK2Data = {
	readonly kind?: "ci" | "git";
	readonly transport?: RunTransport;
	readonly priority?: RunPriority;
	/** `run.dispatched` only. */
	readonly via?: RunDispatchVia;
	/** `run.dispatched` only: run creation → instance created. */
	readonly lagMs?: number;
};

/** `RunStatus` additions: the run's recorded transport and dispatch. */
export type RunStatusK2 = {
	readonly transport?: RunTransport;
	readonly via?: RunDispatchVia;
	readonly dispatchedAt?: number;
};

/** The answer of `RepoRunsFacade.dispatch`. */
export type DispatchOutcome =
	| "dispatched"
	| "already"
	| "terminal"
	| "superseded"
	| "unknown-run";

/** `RepoRunsFacade.dispatch`: the only path that creates a run's Workflow. */
export interface RunsDispatchFacade {
	dispatch(
		runId: string,
		options: { via: RunDispatchVia; requestedAt?: number },
	): Promise<DispatchOutcome>;
}

// ---------------------------------------------------------------------------
// Events internals (contract: RepoEventsInternal, ForgeEventsInternal)
// ---------------------------------------------------------------------------

/**
 * One committed event as the relay reads it: the envelope plus the stored
 * columns a K2 record needs (`readSync` returns every row, shadow and sim
 * included). Forge events carry no chain (`prevHash`/`hash` null).
 */
export type EventLogRow = {
	readonly seq: number;
	readonly idemKey: string;
	readonly prevHash: string | null;
	readonly hash: string | null;
	/** The row's own `repo` column (null for a node-level repo event). */
	readonly repo: string | null;
	readonly envelope: Envelope;
};

/** Called inside the append's transaction, after the insert. */
export type AppendHook = (row: { readonly seq: number }) => void;

/** What `events` adds to its internal API for the relay (both DO kinds). */
export interface EventsRelaySource {
	/** Rows with `seq > since` in seq order, at most `limit`, nothing filtered. */
	readSync(query: { since: number; limit: number }): EventLogRow[];
	/** A ULID minted when the log first started; a storage reset mints a new one. */
	epochSync(): string;
	/** The lowest retained seq, or null for an empty log. */
	oldestSeqSync(): number | null;
	headSync(): { seq: number };
	/** After each coalesced flush (the fast path; lost on eviction by design). */
	onFlush(listener: () => void): void;
	/** Inside every append transaction (the durable trigger). */
	onAppendSync(hook: AppendHook): void;
}

// ---------------------------------------------------------------------------
// Relay (contract: RepoBusInternal/ForgeBusInternal, RepoBusFacade/ForgeBusFacade)
// ---------------------------------------------------------------------------

export const RELAY_STATES = ["ok", "backoff", "blocked", "off"] as const;
export type RelayState = typeof RELAY_STATES[number];

/** The relay's synchronous view for sibling modules (prune guard, transport). */
export interface BusRelayInternal {
	relayedSeqSync(): number;
	stateSync(): RelayState;
}

/** One DO's relay position (ids, counts, states and codes only). */
export type RelayStatus = {
	/** `repo:<ulid>` or `forge`. */
	readonly stream: string;
	readonly state: RelayState;
	readonly epoch: string;
	readonly head: number;
	readonly relayedSeq: number;
	/** `head − relayedSeq`. */
	readonly lag: number;
	/** `at` of the oldest unrelayed event, or null when caught up. */
	readonly oldestUnrelayedAt: number | null;
	readonly attempts: number;
	readonly nextAt: number | null;
	/** `K2 <code>` or `throw`; never a message body. */
	readonly lastError: string | null;
	readonly lastOkAt: number | null;
	readonly sentRecords: number;
	readonly sentBytes: number;
	readonly unknownOutcomes: number;
};

/** `R.bus()` / `forge.bus()` over RPC. */
export interface BusRelayFacade {
	status(): Promise<RelayStatus>;
	/** Runs the relay now (the cron's re-kick); answers the status after it. */
	kick(): Promise<RelayStatus>;
}

// ---------------------------------------------------------------------------
// BusDO consumer (contract: do/bus.ts)
// ---------------------------------------------------------------------------

export type ConsumeState = "ok" | "off" | "error";

/** Dispatch counts by `via` for one hour (UTC, epoch ms of the hour start). */
export type ViaCounts = {
	readonly hour: number;
	readonly k2: number;
	readonly backstop: number;
	readonly local: number;
};

/** A relay lag the cron recorded (worst first). */
export type RelayLag = {
	readonly stream: string;
	readonly state: RelayState;
	readonly lag: number;
	readonly oldestUnrelayedAt: number | null;
};

export type BusStatus = {
	readonly group: string;
	readonly worker: number;
	readonly consume: ConsumeState;
	readonly subscription: string | null;
	readonly lastPollOkAt: number | null;
	/** `timestamp_ms` of the last record consumed. */
	readonly lastRecordAt: number | null;
	/** Consume time minus `timestamp_ms` of the last batch's last record. */
	readonly consumerLagMs: number | null;
	readonly records: number;
	readonly retry: number;
	readonly dead: number;
	readonly resubscribed: number;
	readonly lastError: string | null;
	readonly via: readonly ViaCounts[];
	readonly relayLags: readonly RelayLag[];
	readonly relayLagsAt: number | null;
};

/** A parked record (never its content). */
export type DeadRecordDto = {
	readonly id: string;
	readonly type: string | null;
	readonly error: string;
	readonly at: number;
};

/** The BusDO `bus` facade (`env.BUS.getByName(busDoName(g, n)).bus()`). */
export interface BusFacade {
	/** A relay sent a workload record: poll now. */
	nudge(): Promise<void>;
	/** Re-arms a missing poll timer (the cron). */
	wake(): Promise<BusStatus>;
	status(): Promise<BusStatus>;
	deadList(
		query: { limit?: number; cursor?: string },
	): Promise<{ dead: DeadRecordDto[]; cursor?: string }>;
	deadRetry(id: string): Promise<boolean>;
	deadDiscard(id: string): Promise<boolean>;
	/** The cron's worst relay lags, shown on the status page. */
	recordRelayLags(lags: readonly RelayLag[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// HTTP (contract: api.ts)
// ---------------------------------------------------------------------------

/** `/-/health` `k2` (unauthenticated, nothing more). */
export const K2_HEALTH_STATES = [
	"ok",
	"degraded",
	"blocked",
	"produce-only",
	"off",
] as const;
export type K2Health = typeof K2_HEALTH_STATES[number];

/** `GET /-/api/log/status` (forge Owner only): ids, counts, states and codes. */
export type LogStatusResponse = {
	readonly label: "K2 (public beta)";
	readonly health: K2Health;
	/** The stage's maximum (`workloadTransportOf`: `WORKLOAD_TRANSPORT` or its rendered override). */
	readonly transport: RunTransport;
	readonly stream: { readonly configured: boolean; readonly name: string };
	readonly relay: { readonly forge: RelayStatus | null };
	readonly consumer: BusStatus | null;
	/** Dispatch counts by via in the current and the previous clock hour. */
	readonly lastHour: {
		readonly k2: number;
		readonly backstop: number;
		readonly local: number;
	};
};

/** `GET /-/api/log/dead` (forge Owner only). */
export type LogDeadListResponse = {
	readonly dead: readonly DeadRecordDto[];
	readonly cursor?: string;
};
