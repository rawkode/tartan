// What every part of the RepoDO `core` module shares (WP5a): the module deps,
// the ports it reaches other WPs through (each a contract facade, so tests
// inject fakes), typed SQL helpers, `meta` access and the one way to append
// an event (K3: the event joins the caller's `transactionSync`).

import {
	type Actor,
	type AppendResult,
	conflict,
	type EntityRef,
	fromRpcError,
	type LaneMode,
	notFound,
	principalKind,
	repoArtifactsName,
	SYS_KERNEL,
	trunkRef,
} from "@tartan/contract";
import type {
	AdvanceRow,
	CapMac,
	Clock,
	ExtDispatch,
	Ids,
	KernelGitJobs,
	LandingRow,
	ModuleTimersApi,
	RepoInternals,
	RepoMetaKey,
	RepoProbeApi,
	RepoStore,
	TreeFacade,
} from "@tartan/contract/kernel.ts";
import type { GitRemote, LsRef } from "@tartan/gitproto";
import type { Env } from "../../env.ts";

export type LsRefsPort = (
	remote: GitRemote,
	options?: {
		readonly refPrefixes?: readonly string[];
		readonly peel?: boolean;
		readonly symrefs?: boolean;
	},
) => Promise<readonly LsRef[]>;

/**
 * Everything `core` reaches outside RepoDO, as contract facades: tests pass
 * fakes, the module builds the real ones from `env` and `ctx`.
 */
export type CorePorts = {
	/** `env.ARTIFACTS` (control calls go through the control bucket). */
	readonly artifacts: RepoStore;
	/** ForgeDO's tree (WP3): roles, protected patterns, node, artifacts index. */
	forgeTree(): TreeFacade;
	/** ForgeDO's `canonical_origin` (WP2), for WP5b's capability URL. */
	canonicalOrigin(): Promise<string>;
	/** WP10: ref-only writes, archive, sync, restack. */
	readonly gitJobs: KernelGitJobs;
	/** WP2: the capability MAC (WP5b signs). */
	readonly capMac: CapMac;
	/** WP7b: `lane.open` gates. */
	readonly dispatch: Pick<ExtDispatch, "gates">;
	/** WP8: phase 2 of push recording (the lane-range diff). */
	probe(): Pick<RepoProbeApi, "laneDiff">;
	/** WP22: protocol v2 `ls-refs` (reconciliation, `readTip`). */
	readonly lsRefs: LsRefsPort;
	/** The forge default `LANE_MODE` (a repo overrides it in `meta.lane_mode`). */
	readonly laneMode: LaneMode;
	/** `PUSH_LEASE_ENABLED` (the push-lease fallback). */
	readonly pushLeases: boolean;
	/** `ctx.waitUntil` (detached work after a facade call returns). */
	waitUntil(promise: Promise<unknown>): void;
	log(message: string, data: Record<string, unknown>): void;
	sleep(ms: number): Promise<void>;
};

export type Core = {
	readonly sql: SqlStorage;
	/** `storage.transactionSync`. */
	tx<T>(closure: () => T): T;
	readonly clock: Clock;
	readonly ids: Ids;
	readonly timers: ModuleTimersApi;
	readonly modules: RepoInternals;
	readonly ports: CorePorts;
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

export const scalar = (
	sql: SqlStorage,
	query: string,
	...bindings: SqlStorageValue[]
): number => {
	const row = first<{ n: number | null }>(sql, query, ...bindings);
	return row?.n ?? 0;
};

/** A JSON array parameter for `json_each(?)` (≤ 100 bound parameters). */
export const jsonList = (values: readonly string[]): string =>
	JSON.stringify(values);

// ---------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------

export const getMeta = (sql: SqlStorage, key: RepoMetaKey): string | null =>
	first<{ v: string }>(sql, "SELECT v FROM meta WHERE k = ?", key)?.v ?? null;

export const setMeta = (
	sql: SqlStorage,
	key: RepoMetaKey,
	value: string | number | null,
): void => {
	if (value === null) {
		sql.exec("DELETE FROM meta WHERE k = ?", key);
		return;
	}
	sql.exec(
		"INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
		key,
		String(value),
	);
};

export const getMetaNumber = (
	sql: SqlStorage,
	key: RepoMetaKey,
): number | null => {
	const value = getMeta(sql, key);
	if (value === null || value.trim() === "") return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
};

/** The repo identity `init` stored; `not_found` before `init`. */
export type RepoIdentity = {
	readonly repoId: string;
	readonly nodeId: string;
	readonly path: string;
	readonly artifactsName: string;
	readonly defaultBranch: string;
};

export const repoIdentity = (sql: SqlStorage): RepoIdentity => {
	const repoId = getMeta(sql, "repo_id");
	const nodeId = getMeta(sql, "node_id");
	if (repoId === null || nodeId === null) {
		throw notFound("repo is not initialized");
	}
	return {
		repoId,
		nodeId,
		path: getMeta(sql, "path") ?? "",
		artifactsName: getMeta(sql, "artifacts_name") ?? repoArtifactsName(repoId),
		defaultBranch: getMeta(sql, "default_branch") ?? "main",
	};
};

export const isInitialized = (sql: SqlStorage): boolean =>
	getMeta(sql, "repo_id") !== null;

/** `refs/heads/<default branch>`. */
export const trunkRefOf = (sql: SqlStorage): string =>
	trunkRef(getMeta(sql, "default_branch") ?? "main");

export const isImporting = (sql: SqlStorage): boolean =>
	getMeta(sql, "import_state") === "importing";

export const requireNotImporting = (sql: SqlStorage, what: string): void => {
	if (isImporting(sql)) throw conflict(`${what}: the repo is importing`);
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
	readonly actor?: Actor;
	readonly subject?: EntityRef;
	readonly causedBy?: string;
	readonly correlation?: string;
	/** Defaults to a fresh key: the event is appended exactly once by this call. */
	readonly idemKey?: string;
};

/** Appends one kernel event inside the caller's `transactionSync` (K3). */
export const emit = (core: Core, input: EmitInput): AppendResult => {
	const id = repoIdentity(core.sql);
	return core.modules.events.appendSync({
		type: input.type,
		source: { kind: "kernel" },
		actor: input.actor ?? KERNEL_ACTOR,
		node: id.nodeId,
		repo: id.repoId,
		...(input.subject ? { subject: input.subject } : {}),
		...(input.causedBy ? { causedBy: input.causedBy } : {}),
		...(input.correlation ? { correlation: input.correlation } : {}),
		depth: 0,
		shadow: false,
		data: input.data,
		idemKey: input.idemKey ?? `core:${core.ids.ulid()}:${input.type}`,
	});
};

/** The event actor of a principal id (`principalKind`), or the kernel. */
export const actorOf = (
	principal: string | null,
	onBehalfOf?: string | null,
): Actor => {
	const kind = principal === null ? null : principalKind(principal);
	if (principal === null || kind === null) return KERNEL_ACTOR;
	return onBehalfOf
		? { kind, id: principal, onBehalfOf }
		: { kind, id: principal };
};

export const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

// ---------------------------------------------------------------------------
// WP10's land internals
// ---------------------------------------------------------------------------

/**
 * Reads of WP10's land module. Before WP10 merges its M0 stub throws
 * `not_implemented`; no Advance or landing can exist then, so that one
 * answer reads as "none". Every other error propagates.
 */
const landRead = <T>(read: () => T | null): T | null => {
	try {
		return read();
	} catch (error) {
		if (fromRpcError(error).code === "not_implemented") return null;
		throw error;
	}
};

/** The un-completed Advance on `ref` (K1/K5), or null. */
export const inflightAdvance = (core: Core, ref: string): AdvanceRow | null =>
	landRead(() => core.modules.land.inflightAdvanceSync(ref));

/** The landing of a lane (lane GC's expected head), or null. */
export const landingOf = (core: Core, laneId: string): LandingRow | null =>
	landRead(() => core.modules.land.landingByLaneSync(laneId));
