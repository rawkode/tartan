// What every part of the RepoDO `land` module shares (WP10): its deps, the
// ports it reaches outside RepoDO through (injectable, so tests use fakes),
// typed SQL helpers, the one way it appends an event (K3: joins the
// caller's `transactionSync`, with a deterministic idempotency key so a
// retried call appends nothing twice) and the row readers.
//
// Siblings are reached only through their synchronous internal APIs
// (`modules.core`, `modules.events`). Two reads of WP5a's tables have no
// internal API in contract v0.2 and are done here read-only, each named at
// its use (`commit_firsts` for attribution, `trunk_commits` for a landing's
// trunk position) until the internal readers exist.

import {
	type Actor,
	conflict,
	type EntityRef,
	type LandBatchState,
	notFound,
	SYS_KERNEL,
	TERMINAL_BATCH_STATES,
	trunkRef,
} from "@tartan/contract";
import type {
	AdvanceRow,
	Clock,
	Ids,
	KernelGitJobs,
	LandBatchRow as ContractBatchRow,
	ModuleTimersApi,
	RepoConfigInternal,
	RepoCoreInternal,
	RepoEventsInternal,
	RepoStore,
} from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import type { LandWorkflowParams } from "./params.ts";
import type { LandChangeRow } from "./types.ts";

/** A principal as attribution needs it (ForgeDO identity). */
export type PrincipalInfo = {
	readonly id: string;
	readonly kind: "user" | "agent" | "ext" | "system";
	readonly handle: string;
	readonly display: string;
	readonly email: string | null;
	readonly agentTool: string | null;
	readonly agentModel: string | null;
};

export type InstanceState = InstanceStatus["status"] | "missing";

/** Workflow statuses after which an owner instance will never act again. */
export const TERMINAL_INSTANCE: ReadonlySet<string> = new Set([
	"complete",
	"errored",
	"terminated",
	"missing",
]);

/** Everything the land module reaches outside RepoDO. */
export type LandPorts = {
	/** `LAND.create`; `exists` for a duplicate id (counts as success). */
	createInstance(
		id: string,
		params: LandWorkflowParams,
	): Promise<"created" | "exists">;
	/** `LAND.get(id).status()`; `missing` when there is no such instance. */
	instanceStatus(id: string): Promise<InstanceState>;
	/** `LAND.get(id).sendEvent(…)`. */
	sendEvent(id: string, type: string, payload: unknown): Promise<void>;
	/** The canonical repo's current value of `ref` (a fresh `ls-refs`), null when absent. */
	remoteRef(ref: string): Promise<string | null>;
	/** ForgeDO identity (WP2); null when unknown. */
	principal(id: string): Promise<PrincipalInfo | null>;
	/** The forge's canonical host, for synthetic co-author emails. */
	canonicalHost(): Promise<string>;
	/**
	 * The installation id of the `review@1` provider in force at a node;
	 * null when none; undefined when the registry cannot answer yet (its
	 * dependencies are M0 stubs).
	 */
	reviewProvider(nodeId: string): Promise<string | null | undefined>;
	/** WP10's kernel git jobs: the K5 repair and ref-only writes. */
	gitJobs(): Pick<KernelGitJobs, "repair" | "refWrite">;
	/** RepoDO core's `closeLane(…, KERNEL_LANE_ACTOR)` (a landed lane). */
	closeLane(laneId: string, reason: string): Promise<void>;
	/**
	 * Repository config (WP23): a principal's role at a node from grants
	 * (ForgeDO tree), for the signer re-check of K13.3.
	 */
	roleOf?(principal: string, nodeId: string): Promise<number>;
	/** RepoDO core's `laneRange(laneId)`: runs phase 2, so the head's `push.diffed` exists. */
	laneRange?(laneId: string): Promise<void>;
	/**
	 * Repository config (WP23, K13.1): ForgeDO's `registry.landContext` for
	 * the repo node, read in the same step as the hold check, so a
	 * `gate-missing` hold ForgeDO just set holds this land at once.
	 */
	landContext?(nodeId: string): Promise<{
		readonly configHold: string | null;
		readonly configHoldId?: number;
	}>;
	waitUntil(promise: Promise<unknown>): void;
	log(message: string, data: Record<string, unknown>): void;
	/** The Artifacts binding (the dev-only seeding reads and pushes trunk). */
	artifacts(): RepoStore;
	/** `TARTAN_STAGE` ^dev and `TARTAN_DEV_TOOLS=1`. */
	devTools(): boolean;
};

export type LandCtx = {
	readonly sql: SqlStorage;
	tx<T>(closure: () => T): T;
	readonly clock: Clock;
	readonly ids: Ids;
	readonly timers: ModuleTimersApi;
	readonly core: RepoCoreInternal;
	readonly events: RepoEventsInternal;
	/** Repository config (WP23): K13.1–K13.3; null where the module is not composed. */
	readonly repoconfig: RepoConfigInternal | null;
	readonly ports: LandPorts;
	readonly env: Env;
};

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

type Row = Record<string, SqlStorageValue>;

export const rows = <T extends Row>(
	sql: SqlStorage,
	query: string,
	...bindings: SqlStorageValue[]
): T[] => sql.exec<T>(query, ...bindings).toArray();

export const first = <T extends Row>(
	sql: SqlStorage,
	query: string,
	...bindings: SqlStorageValue[]
): T | null => rows<T>(sql, query, ...bindings)[0] ?? null;

export const parseJson = <T>(text: string | null, fallback: T): T => {
	if (text === null) return fallback;
	try {
		return JSON.parse(text) as T;
	} catch {
		return fallback;
	}
};

export const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

// ---------------------------------------------------------------------------
// Repo identity (from core's meta)
// ---------------------------------------------------------------------------

export type RepoIds = {
	readonly repoId: string;
	readonly nodeId: string;
	readonly defaultBranch: string;
	readonly trunkRef: string;
};

export const repoIds = (ctx: LandCtx): RepoIds => {
	const repoId = ctx.core.metaSync("repo_id");
	const nodeId = ctx.core.metaSync("node_id");
	if (repoId === null || nodeId === null) {
		throw notFound("repo is not initialized");
	}
	const defaultBranch = ctx.core.metaSync("default_branch") ?? "main";
	return { repoId, nodeId, defaultBranch, trunkRef: trunkRef(defaultBranch) };
};

/** The ref index value of `ref`, or null. */
export const indexSha = (ctx: LandCtx, ref: string): string | null =>
	ctx.core.refSync(ref)?.sha ?? null;

/** Candidate refs are deleted this long after their batch ended. */
export const CANDIDATE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Arms the candidate sweep for a batch that ended at `endedAt`: the timer
 * fires no later than `endedAt + CANDIDATE_TTL_MS`, and an earlier one is
 * kept (each ending batch never pushes the sweep out).
 */
export const armCandidateSweep = (ctx: LandCtx, endedAt: number): void => {
	const at = endedAt + CANDIDATE_TTL_MS;
	const current = ctx.timers.get("candidates");
	if (current === null || at < current) ctx.timers.schedule("candidates", at);
};

// ---------------------------------------------------------------------------
// Events (K3)
// ---------------------------------------------------------------------------

export const KERNEL_ACTOR: Actor = Object.freeze({
	kind: "system",
	id: SYS_KERNEL,
});

export type EmitInput = {
	readonly type: string;
	readonly data: unknown;
	/** Deterministic, so a retried call appends the event once. */
	readonly idemKey: string;
	readonly actor?: Actor;
	readonly subject?: EntityRef;
	readonly causedBy?: string;
	readonly correlation?: string;
};

/** Appends one kernel event inside the caller's transaction; returns its id. */
export const emit = (ctx: LandCtx, input: EmitInput): string => {
	const ids = repoIds(ctx);
	return ctx.events.appendSync({
		type: input.type,
		source: { kind: "kernel" },
		actor: input.actor ?? KERNEL_ACTOR,
		node: ids.nodeId,
		repo: ids.repoId,
		...(input.subject ? { subject: input.subject } : {}),
		...(input.causedBy ? { causedBy: input.causedBy } : {}),
		...(input.correlation ? { correlation: input.correlation } : {}),
		depth: 0,
		shadow: false,
		data: input.data,
		idemKey: input.idemKey,
	}).id;
};

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** `land_batches` with the design-lag `request_hash` column (schema.ts). */
export type LandBatchRow = ContractBatchRow & { request_hash: string };

export const batchRow = (ctx: LandCtx, batchId: string): LandBatchRow | null =>
	first<LandBatchRow>(
		ctx.sql,
		"SELECT * FROM land_batches WHERE id = ?",
		batchId,
	);

export const requireBatch = (ctx: LandCtx, batchId: string): LandBatchRow => {
	const row = batchRow(ctx, batchId);
	if (row === null) throw notFound(`unknown batch: ${batchId}`);
	return row;
};

export const isTerminal = (state: LandBatchState): boolean =>
	TERMINAL_BATCH_STATES.includes(state);

/** Refuses a call for another attempt than the batch's current one. */
export const requireAttempt = (
	batch: LandBatchRow,
	attempt: number,
): void => {
	if (batch.attempt !== attempt) {
		throw conflict(
			`stale-attempt: batch ${batch.id} is at attempt ${batch.attempt}, not ${attempt}`,
			{ code: "stale-attempt" },
		);
	}
	if (isTerminal(batch.state)) {
		throw conflict(`batch-ended: batch ${batch.id} is ${batch.state}`, {
			code: "batch-ended",
		});
	}
};

export const changeRows = (ctx: LandCtx, batchId: string): LandChangeRow[] =>
	rows<LandChangeRow>(
		ctx.sql,
		"SELECT * FROM land_changes WHERE batch_id = ? ORDER BY position",
		batchId,
	);

export const advanceRow = (ctx: LandCtx, id: string): AdvanceRow | null =>
	first<AdvanceRow>(ctx.sql, "SELECT * FROM advances WHERE id = ?", id);

export const requireAdvance = (ctx: LandCtx, id: string): AdvanceRow => {
	const row = advanceRow(ctx, id);
	if (row === null) throw notFound(`unknown advance: ${id}`);
	return row;
};

/**
 * Lane release: every lane of `changes` still `landing` goes
 * back to `submitted` (its approval still names its unchanged head), so its
 * owner's pushes reopen. Inside the caller's transaction.
 */
export const releaseLanes = (
	ctx: LandCtx,
	changes: readonly Pick<LandChangeRow, "lane_id">[],
): void => {
	for (const change of changes) {
		const lane = ctx.core.laneSync(change.lane_id);
		if (lane?.state === "landing") {
			ctx.core.setLaneStateSync(change.lane_id, "submitted");
		}
	}
};
