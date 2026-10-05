// What every part of the `repo` lane backend shares (WP5b): the contract's
// `RepoBackendDeps` plus a few ports tests replace (protocol v2 `ls-refs`,
// notices, logging, sleep), the lane-repo token cache, typed SQL helpers on
// WP5a's tables, kernel events (K3: joined to the caller's transaction) and
// the attempt-history table this backend owns.

import {
	type Actor,
	type AppendResult,
	type EntityRef,
	fromRpcError,
	inboxDoName,
	isPrincipalId,
	type LaneMode,
	type NoticeInput,
	redactSecrets,
	SYS_KERNEL,
	trunkRef,
	ZERO_SHA,
} from "@tartan/contract";
import type {
	AdvanceRow,
	LandingRow,
	LaneRow,
	RepoBackendDeps,
} from "@tartan/contract/kernel.ts";
import { type LsRef, lsRefs as gitLsRefs } from "@tartan/gitproto";
import { laneFallback, laneModeOf } from "../../../../constants.ts";
import type { Env } from "../../../../env.ts";
import { first, getMeta, repoIdentity, rows } from "../../core.ts";
import { authorizationFor } from "../../gitremote.ts";
import { indexSha } from "../../refs.ts";
import {
	type ArtifactsAccess,
	createArtifactsAccess,
	isMissingRepo,
} from "../../upstream.ts";
import { laneRow } from "../rows.ts";
import type { SeedAttemptRow } from "./schema.ts";

/** `ls-refs` as the backend calls it (gitproto's client, or a test fake). */
export type LsRefs = (
	remote: {
		readonly url: string;
		readonly authorization: string;
		readonly fetch?: typeof fetch;
	},
	options?: { readonly refPrefixes?: readonly string[] },
) => Promise<readonly LsRef[]>;

/** A kernel notice for one principal's inbox (best effort, never awaited in a transaction). */
export type Notify = (
	principal: string,
	notice: NoticeInput & {
		readonly source: string;
		readonly sourceLabel?: string;
	},
) => Promise<void>;

/** Ports the backend reaches beyond `RepoBackendDeps` (tests override them). */
export type RepoBackendPorts = {
	readonly lsRefs: LsRefs;
	/** The fetch gitproto uses for lane-repo remotes (tests route it to a fake). */
	readonly fetch?: typeof fetch;
	readonly notify: Notify;
	log(message: string, data: Record<string, unknown>): void;
	sleep(ms: number): Promise<void>;
	/** 16 random bytes, hex (capability nonces). */
	nonce(): string;
	/** The forge default (`laneModeOf`: `LANE_MODE` or the stage's rendered override; a repo overrides it in `meta.lane_mode`). */
	readonly laneMode: LaneMode;
	/** `laneFallback(TARTAN_LANE_FALLBACK)`. */
	readonly chain: readonly LaneMode[];
	/** The JS-side bound of one step in ms (tests shorten it). */
	bound(kind: "import" | "verify" | "watchdog", ms: number): number;
};

const hex = (bytes: Uint8Array): string =>
	[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

export const defaultPorts = (
	deps: RepoBackendDeps<Env>,
): RepoBackendPorts => ({
	lsRefs: (remote, options) => gitLsRefs(remote, options),
	notify: async (principal, notice) => {
		const inbox = (deps.env as Partial<Env> | undefined)?.INBOX;
		if (inbox === undefined || !isPrincipalId(principal)) return;
		if (principal === SYS_KERNEL) return;
		await inbox.getByName(inboxDoName(principal)).deliver(notice);
	},
	log: redactedLog("lanes.repo"),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	nonce: () => hex(crypto.getRandomValues(new Uint8Array(16))),
	laneMode: laneModeOf(deps.env as Partial<Env> | undefined),
	bound: (_kind, ms) => ms,
	chain: laneFallback(
		(deps.env as Partial<Env> | undefined)?.TARTAN_LANE_FALLBACK,
	),
});

export type Ctx = {
	readonly deps: RepoBackendDeps<Env>;
	readonly ports: RepoBackendPorts;
	readonly sql: SqlStorage;
	tx<T>(closure: () => T): T;
	now(): number;
	/** The lane-repo token cache (memory only, scoped per repo, K11). */
	readonly access: ArtifactsAccess;
	/** Runs `work` after the caller returns; failures are logged. */
	detach(what: string, work: () => Promise<unknown>): void;
};

export const createCtx = (
	deps: RepoBackendDeps<Env>,
	ports: RepoBackendPorts,
): Ctx => {
	const access = createArtifactsAccess({
		artifacts: deps.artifacts,
		clock: deps.clock,
		sleep: ports.sleep,
		bucket: {
			take: () => deps.core.control.take(),
			backoff: () => deps.core.control.backoff(),
			pausedUntil: () => 0,
		},
	});
	return {
		deps,
		ports,
		sql: deps.sql,
		tx: (closure) => deps.storage.transactionSync(closure),
		now: () => deps.clock.now(),
		access,
		detach: (what, work) => {
			const run = (async () => {
				try {
					await work();
				} catch (error) {
					ports.log(what, { error: errorText(error) });
				}
			})();
			try {
				deps.ctx.waitUntil(run);
			} catch {
				// A host without waitUntil keeps the promise alive by itself.
			}
		},
	};
};

/**
 * An error as Tartan's own log lines carry it: redacted first (import() and
 * Artifacts errors may quote a capability path or an `art_v…` token), then
 * cut to 300 characters.
 */
export const errorText = (error: unknown): string =>
	redactSecrets(fromRpcError(error).message).slice(0, 300);

/** A log sink for Tartan's own lines, redacted. */
export const redactedLog =
	(scope: string) => (message: string, data: Record<string, unknown>): void =>
		console.error(
			`[tartan] ${scope}: ${redactSecrets(message)}`,
			redactSecrets(JSON.stringify(data)),
		);

// ---------------------------------------------------------------------------
// Repo facts
// ---------------------------------------------------------------------------

export const identity = (ctx: Ctx) => repoIdentity(ctx.sql);
export const trunkOf = (ctx: Ctx): string =>
	trunkRef(identity(ctx).defaultBranch);
export const trunkTip = (ctx: Ctx): string => indexSha(ctx.sql, trunkOf(ctx));

/** The repo's configured mode: `meta.lane_mode`, else the forge default. */
export const configuredMode = (ctx: Ctx): LaneMode => {
	const own = getMeta(ctx.sql, "lane_mode");
	return own === "import" || own === "branch" ? own : ctx.ports.laneMode;
};

/** A read of WP10's land internals (`not_implemented` before WP10 = none). */
const landRead = <T>(read: () => T | null): T | null => {
	try {
		return read();
	} catch (error) {
		if (fromRpcError(error).code === "not_implemented") return null;
		throw error;
	}
};

export const inflightAdvance = (ctx: Ctx, ref: string): AdvanceRow | null =>
	landRead(() => ctx.deps.modules.land.inflightAdvanceSync(ref));

export const landingOf = (ctx: Ctx, laneId: string): LandingRow | null =>
	landRead(() => ctx.deps.modules.land.landingByLaneSync(laneId));

const PUSHED_STEPS = ["trunk-pushed", "notes-pushed", "refs-pushed"];

/**
 * An attempt's base: the ref-index tip of the default branch,
 * or, while an Advance on it has pushed trunk but not completed, that
 * Advance's `new_sha` (K5 guarantees it completes).
 */
export const attemptBase = (ctx: Ctx): string => {
	const ref = trunkOf(ctx);
	const advance = inflightAdvance(ctx, ref);
	if (
		advance !== null && advance.new_sha !== null &&
		advance.state !== "done" && PUSHED_STEPS.includes(advance.step)
	) {
		return advance.new_sha;
	}
	return indexSha(ctx.sql, ref);
};

/** Default-branch tips the kernel explains now (open intents, an un-completed Advance). */
export const explainedTips = (ctx: Ctx): string[] => {
	const ref = trunkOf(ctx);
	const open = rows<{ new_sha: string }>(
		ctx.sql,
		`SELECT DISTINCT new_sha FROM kernel_writes WHERE target = 'repo' AND ref = ?
		 AND state IN ('intent','pushed') AND new_sha <> ?`,
		ref,
		ZERO_SHA,
	).map((r) => r.new_sha);
	const advance = inflightAdvance(ctx, ref);
	const tips = advance?.new_sha ? [...open, advance.new_sha] : open;
	return [...new Set(tips)].filter((sha) =>
		ctx.deps.core.internal.explainsSync(ref, sha)
	);
};

// ---------------------------------------------------------------------------
// Lanes and attempts
// ---------------------------------------------------------------------------

export const lane = (ctx: Ctx, laneId: string): LaneRow | null =>
	laneRow(ctx.sql, laneId);

/** The lane is still on attempt `n` of its seed (every attempt transition is fenced on this). */
export const isCurrent = (
	row: LaneRow | null,
	attempt: number,
): row is LaneRow =>
	row !== null && row.state === "opening" && row.mode === "repo" &&
	row.seed_attempt === attempt;

export const attemptRow = (
	ctx: Ctx,
	laneId: string,
	attempt: number,
): SeedAttemptRow | null =>
	first<SeedAttemptRow>(
		ctx.sql,
		"SELECT * FROM lane_seed_attempts WHERE lane_id = ? AND attempt = ?",
		laneId,
		attempt,
	);

export const attemptByName = (
	ctx: Ctx,
	name: string,
): SeedAttemptRow | null =>
	first<SeedAttemptRow>(
		ctx.sql,
		"SELECT * FROM lane_seed_attempts WHERE repo_name = ?",
		name.toLowerCase(),
	);

export const attemptsOf = (ctx: Ctx, laneId: string): SeedAttemptRow[] =>
	rows<SeedAttemptRow>(
		ctx.sql,
		"SELECT * FROM lane_seed_attempts WHERE lane_id = ? ORDER BY attempt",
		laneId,
	);

export const insertAttempt = (
	ctx: Ctx,
	row: Omit<SeedAttemptRow, "remote" | "ended_at" | "outcome" | "code">,
): void => {
	ctx.sql.exec(
		`INSERT INTO lane_seed_attempts (lane_id, attempt, seed, repo_name, base_sha, started_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT (lane_id, attempt) DO NOTHING`,
		row.lane_id,
		row.attempt,
		row.seed,
		row.repo_name,
		row.base_sha,
		row.started_at,
	);
};

export const endAttempt = (
	ctx: Ctx,
	laneId: string,
	attempt: number,
	outcome: "open" | "failed" | "fenced",
	code: string | null,
): void => {
	ctx.sql.exec(
		`UPDATE lane_seed_attempts SET ended_at = ?, outcome = ?, code = ?
		 WHERE lane_id = ? AND attempt = ? AND outcome IS NULL`,
		ctx.now(),
		outcome,
		code,
		laneId,
		attempt,
	);
};

export const setAttemptRemote = (
	ctx: Ctx,
	name: string,
	remote: string,
): void => {
	ctx.sql.exec(
		"UPDATE lane_seed_attempts SET remote = ? WHERE repo_name = ?",
		remote,
		name.toLowerCase(),
	);
};

// ---------------------------------------------------------------------------
// Events (K3) and notices
// ---------------------------------------------------------------------------

export const KERNEL: Actor = Object.freeze({ kind: "system", id: SYS_KERNEL });

export const emit = (
	ctx: Ctx,
	input: {
		readonly type: string;
		readonly data: unknown;
		readonly subject?: EntityRef;
		readonly actor?: Actor;
	},
): AppendResult => {
	const id = identity(ctx);
	return ctx.deps.modules.events.appendSync({
		type: input.type,
		source: { kind: "kernel" },
		actor: input.actor ?? KERNEL,
		node: id.nodeId,
		repo: id.repoId,
		...(input.subject ? { subject: input.subject } : {}),
		depth: 0,
		shadow: false,
		data: input.data,
		idemKey: `lanes.repo:${ctx.deps.ids.ulid()}:${input.type}`,
	});
};

/** A `system` notice for a lane's owner, after the transaction committed. */
export const notifyOwner = (
	ctx: Ctx,
	row: Pick<LaneRow, "id" | "owner_principal">,
	text: string,
	code: string,
): void => {
	const repoId = identity(ctx).repoId;
	ctx.detach(
		"owner notice failed",
		() =>
			ctx.ports.notify(row.owner_principal, {
				repoId,
				laneId: row.id,
				kind: "system",
				severity: "warn",
				text,
				data: { code },
				dedupeKey: `lane-seed:${row.id}:${code}`,
				source: "kernel",
				sourceLabel: "lanes",
			}),
	);
};

// ---------------------------------------------------------------------------
// Lane repos
// ---------------------------------------------------------------------------

/** `ls-refs` of one lane repo; null when the repo does not exist. */
export const laneRepoRefs = async (
	ctx: Ctx,
	name: string,
	prefixes: readonly string[],
): Promise<readonly LsRef[] | null> => {
	let token;
	try {
		token = await ctx.access.token(name, "read");
	} catch (error) {
		if (isMissingRepo(error)) return null;
		throw error;
	}
	try {
		return await ctx.ports.lsRefs(
			{
				url: token.remote,
				authorization: authorizationFor(token.token),
				...(ctx.ports.fetch ? { fetch: ctx.ports.fetch } : {}),
			},
			{ refPrefixes: prefixes },
		);
	} catch (error) {
		if (isMissingRepo(error) || /\b404\b/.test(errorText(error))) {
			ctx.access.forget(name);
			return null;
		}
		throw error;
	}
};

/** Lane-repo upkeep (reconciliation pacing, GC deferral). */
export const upkeep = (ctx: Ctx, laneId: string) =>
	first<{
		lane_id: string;
		reconciled_at: number | null;
		gc_deferred_since: number | null;
		gc_alerted_at: number | null;
	}>(ctx.sql, "SELECT * FROM lane_repo_upkeep WHERE lane_id = ?", laneId);

export const setUpkeep = (
	ctx: Ctx,
	laneId: string,
	patch: {
		readonly reconciled_at?: number | null;
		readonly gc_deferred_since?: number | null;
		readonly gc_alerted_at?: number | null;
	},
): void => {
	ctx.sql.exec(
		"INSERT INTO lane_repo_upkeep (lane_id) VALUES (?) ON CONFLICT (lane_id) DO NOTHING",
		laneId,
	);
	for (const [column, value] of Object.entries(patch)) {
		ctx.sql.exec(
			`UPDATE lane_repo_upkeep SET ${column} = ? WHERE lane_id = ?`,
			value ?? null,
			laneId,
		);
	}
};

export { configuredMode as configuredLaneMode };
