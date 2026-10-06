// The global log's own types (WP26). Contract 0.3.2 carries part of them
// (MIGRATION_RANGES, RunEventData, `run.dispatched`, HealthResponse.k2): the
// migration ranges below are read from the contract. Contract 0.4.5 added the
// run's transport and dispatch to `RunStatus` and the log routes' answers
// (status, relay, consumer, dead letters) to `api.ts`; they are re-exported
// here. The facade and timer types are still local; moving them into
// `@tartan/contract` (do/bus.ts, `bus()` on RepoDoApi and ForgeDoApi,
// RepoRunsFacade.dispatch) is open, and callers import them from here until
// then.
//
// The global log: every committed repo and forge event is relayed, at least
// once and in `seq` order per DO, into one K2 stream per forge
// (`tartan_<stage>_log`). Durable Objects stay the system of record; the
// stream is a replica and the bus the `workloads` consumer reads to dispatch
// CI runs.

import type {
	BusStatus,
	DeadRecordDto,
	Envelope,
	RelayLag,
	RelayState,
	RelayStatus,
	RunDispatchVia,
	RunStatus,
	RunTransport,
} from "@tartan/contract";
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

// Contract 0.4.5: the run transport and its dispatch are in `RunStatus`.
export {
	RUN_DISPATCH_VIAS,
	RUN_TRANSPORTS,
	type RunDispatchVia,
	type RunTransport,
} from "@tartan/contract";

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

/** `RunStatus`'s transport and dispatch (in the contract since 0.4.5). */
export type RunStatusK2 = Pick<
	RunStatus,
	"transport" | "via" | "dispatchedAt"
>;

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

/** The relay's synchronous view for sibling modules (prune guard, transport). */
export interface BusRelayInternal {
	relayedSeqSync(): number;
	stateSync(): RelayState;
}

/** `R.bus()` / `forge.bus()` over RPC. */
export interface BusRelayFacade {
	status(): Promise<RelayStatus>;
	/** Runs the relay now (the cron's re-kick); answers the status after it. */
	kick(): Promise<RelayStatus>;
}

// ---------------------------------------------------------------------------
// BusDO consumer (contract: do/bus.ts)
// ---------------------------------------------------------------------------

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
// HTTP (contract: api.ts, since 0.4.5)
// ---------------------------------------------------------------------------

export {
	type BusStatus,
	type ConsumeState,
	type DeadRecordDto,
	K2_HEALTH_STATES,
	type K2Health,
	type LogDeadListResponse,
	type LogStatusResponse,
	RELAY_STATES,
	type RelayLag,
	type RelayState,
	type RelayStatus,
	type ViaCounts,
} from "@tartan/contract";
