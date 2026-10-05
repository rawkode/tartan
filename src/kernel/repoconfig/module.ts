// RepoDO `repoconfig` module (WP25, migrations 400–429; ADR repo config):
// Tartan config is the CUE package `tartan` in
// the repository root, evaluated only in a `cue:*` sandbox, cached by
// content in this DO, applied only by ForgeDO's registry, and read as repo
// policy at each change's base from the trunk config history kept here.
//
// The state machine (`config_head`):
//   unconfigured  nothing applied, no config on trunk
//   current       the applied key is trunk's key
//   pending       a policy-touching Advance is unresolved; lands HELD (K13.1)
//   failed        trunk's config is a CUE error, rejected input or denial; last-good stays
//   stale         the registry epoch moved under the applied head; re-evaluating
//   needs-apply   trunk moved outside the Advance and its config differs
//
// The trunk config history (`config_trunk`, ADR repo config): one row per trunk
// commit at which the root `*.cue` files changed (`pending`, then `ok`,
// `error` or `none`), keyed by `trunk_commits.seq`. `policyAtSync(seq)` reads
// the newest row at or before `seq` (an `error` row, or a `pending` one under
// keep-last-good, reads as the last good row, `exact: false`); `caps.repo.
// policy` and the project graph read it, never CUE. A registry
// re-evaluation never rewrites a row.
//
// Transitions (each a short timer or an RPC; nothing ever awaits an
// evaluation):
// - `onAdvanceSync` (WP10, inside `completeAdvanceSync`): a landed policy
//   path (a root `*.cue` file), or an unknown or capped path list, sets
//   `pending`, holds lands and opens a `pending` trunk row at the landed
//   commit's seq.
// - `eval` timer: positive-evidence reads of the root tree (reader.ts), the
//   schema from ForgeDO, the input key over every root `*.cue` file; current,
//   a cache hit (trunk's own answer only, never a preview sandbox's; the
//   sha256 of the canonical bytes must match; a TIMEOUT or LIMIT counts
//   once two trunk runs gave it), or a dispatch with `cueSubmit` to
//   `cue:trunk`. An unavailable read changes nothing and
//   retries; an unavailable evaluator keeps `pending` and held with
//   background rounds (1 → 30 min).
// - `cueResult` (the sandbox's sink): caches the envelope and wakes `eval`.
// - `apply` timer: the fenced `applyRepoConfig` with idempotent retries;
//   RepoDO stores exactly ForgeDO's answer, and the answer resolves
//   the trunk row (a `shape` or `policy_key` denial makes it `error`; other
//   denials concern installations only).
// - `observeSync` (WP6's append hook): `push.diffed` records whether a lane
//   head touches a policy path (K13.3) and queues its preview; trunk moves
//   outside the Advance (`repo.imported`, `repo.created`, `ref.acknowledged`,
//   `ref.reconciled`) open and resolve a trunk row (read as policy at once)
//   and give `needs-apply` for installations.
// - `registryChanged` (ForgeDO's outbox): `stale` with a background
//   re-evaluation of TRUNK's config (the newest trunk row, not the applied
//   one), under a fresh fence position; a schema-only change never sets
//   `pending`. A newest row that is `error` (it did not evaluate
//   under the old schema) may be resolved again; an `ok` row never is.
//   While `needs-apply` holds, registry work re-applies the applied config
//   (installations stay bound) and keeps `needs-apply` and its plan.
// - `history` work resolves a trunk row left `pending` by a later
//   policy-touching Advance (the head follows the newest; the older row
//   still answers `policyAt` for bases between the two).
// - `previews` timer: lane previews on `cue:preview:<k>`; never applied,
//   never read as policy, never used for gates, routing, CI or
//   installations (K13).
// - Sign-offs (K13.3): a Maintainer+ session user's kernel act, bound to a
//   lane head and its root `*.cue` digest; the land checks read them.
//
// With `TARTAN_REPO_CONFIG` off nothing is evaluated, held or required, and
// there is no repo policy at all (`caps.repo.policy` answers `none`).

import {
	type Actor,
	conflict,
	CUE_EVAL_CONTRACT,
	CUE_EVALUATOR_ID,
	CUE_TRUNK_SANDBOX,
	type CueEvalErrorCode,
	type CueJobClass,
	cuePreviewSandboxName,
	DEFAULT_EVAL_LIMITS,
	denied,
	type Envelope,
	type EvalIssue,
	type EvalResponse,
	fromRpcError,
	hostEvalError,
	invalid,
	isEvalOk,
	isIdOf,
	isPolicyPath,
	isSha,
	notFound,
	parseEvalResponse,
	type PolicySignoffDto,
	PolicySignoffRequestSchema,
	PREVIEW_ONLY_EVAL_CODES,
	previewSandboxIndex,
	type ProjectConfigAnswer,
	rateLimited,
	REPO_CONFIG_LIMITS,
	REPO_POLICY_DENIAL_CODES,
	type RepoConfigDenial,
	type RepoConfigEvalDto,
	type RepoConfigHeadDto,
	type RepoConfigPlanLine,
	type RepoConfigPreviewDto,
	type RepoConfigPreviewState,
	type RepoConfigSchemaDto,
	type RepoConfigStatus,
	type RepoConfigTrunkRowDto,
	type RepoPolicyAnswer,
	type RepoPolicyDto,
	unavailable,
	UNCACHED_EVAL_CODES,
} from "@tartan/contract";
import {
	type AdvanceLanded,
	type DoModule,
	MIGRATION_RANGES,
	type ModuleDeps,
	type PolicySignoffRef,
	type PolicyTouch,
	type RepoConfigFacade,
	type RepoConfigInternal,
	type RepoInternals,
	type RepoPolicyAt,
	type TimerHandler,
} from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import { inputKeyOf } from "./key.ts";
import { policyPlan } from "./plan.ts";
import { envRepoConfigPorts, type RepoConfigModulePorts } from "./ports.ts";
import {
	type ConfigSnapshot,
	readConfigAt,
	readPolicyDigest,
} from "./reader.ts";
import { REPO_CONFIG_MIGRATIONS } from "./schema.ts";

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

type HeadRow = {
	id: 1;
	status: RepoConfigStatus;
	obs_seq: number;
	trunk_sha: string | null;
	pending_seq: number | null;
	pending_sha: string | null;
	pending_key: string | null;
	pending_cause: "advance" | "apply" | null;
	pending_row_seq: number | null;
	pending_principals_json: string | null;
	pending_removal_ok: 0 | 1;
	hold: 0 | 1;
	override_by: string | null;
	/** The keep-last-good covers the pending row (released hold). */
	override_pending: 0 | 1;
	/**
	 * The generation of ForgeDO's gate-missing hold the keep-last-good covers
	 * (0: none): a later gate loss is a new generation and holds.
	 */
	override_gate: number;
	applied_seq: number | null;
	applied_epoch: number | null;
	applied_sha: string | null;
	applied_key: string | null;
	applied_principals_json: string | null;
	applied_at: number | null;
	forge_hold: string | null;
	/** ForgeDO's hold generation (`holdId`) as last read (migration 402). */
	forge_hold_id: number;
	/** When lands of this repo became held (cleared when they are not). */
	held_since: number | null;
	/** The hold the Owners were last told about (`<reason>:<generation>`). */
	hold_noticed: string | null;
	/**
	 * The switch as this repo last saw it (migration 403): 0 never on, 1 on,
	 * 2 seen off since it was on.
	 */
	enabled_state: 0 | 1 | 2;
	/** Trunk's tip when the switch was first seen off. */
	off_tip: string | null;
	/**
	 * The trunk row opened when the switch went on: its config landed with
	 * nobody's sign-off, so it is not repo policy until a Maintainer applies
	 * it or a signed Advance supersedes it.
	 */
	boot_seq: number | null;
	epoch_seen: number;
	external_due: 0 | 1;
	external_cause: ExternalCause | null;
	external_by: string | null;
	registry_due: 0 | 1;
	plan_json: string | null;
	plan_key: string | null;
	failure_json: string | null;
	unavailable_until: number | null;
	eval_attempts: number;
	last_eval_at: number | null;
	reeval_at: number | null;
	cue_version: string | null;
	root_files_json: string | null;
	legacy_dir: 0 | 1;
	trunk_pruned_seq: number | null;
	updated_at: number;
};

type EvalRow = {
	input_key: string;
	evaluator: string;
	schema_key: string;
	origin: "trunk" | "preview";
	files_json: string;
	status: "ok" | "error";
	code: string | null;
	resolved_json: string | null;
	error_json: string | null;
	first_sha: string;
	first_lane: string | null;
	cue_version: string | null;
	finished_at: number;
	used_at: number;
};

type JobFamily = "trunk" | "preview";

type JobRow = {
	input_key: string;
	family: JobFamily;
	class: CueJobClass;
	sha: string;
	lane_id: string | null;
	schema_key: string;
	epoch: number;
	files_json: string;
	sandbox: string;
	principal: string | null;
	dispatched_at: number | null;
	deadline_at: number | null;
	attempts: number;
	next_at: number | null;
};

type IntentRow = {
	trunk_seq: number;
	epoch: number;
	input_key: string;
	schema_key: string;
	sha: string;
	principals_json: string;
	explicit: 0 | 1;
	removal: 0 | 1;
	row_seq: number | null;
	cause: Work["cause"] | null;
	state: "pending" | "done" | "refused";
	attempts: number;
	answer_json: string | null;
	created_at: number;
};

type TrunkRow = {
	trunk_seq: number;
	sha: string;
	policy_digest: string | null;
	input_key: string | null;
	status: "pending" | "ok" | "error" | "none";
	code: string | null;
	message: string | null;
	issues_json: string | null;
	principals_json: string | null;
	at: number;
};

type PreviewRow = {
	lane_id: string;
	head_sha: string;
	input_key: string | null;
	status: RepoConfigPreviewState | "queued";
	requested_by: string;
	result_json: string | null;
	attempts: number;
	updated_at: number;
};

type SignoffRow = {
	lane_id: string;
	head: string;
	event_id: string;
	signed_by: string;
	policy_digest: string | null;
	revoked_at: number | null;
	at: number;
};

type Failure = NonNullable<RepoConfigHeadDto["failure"]>;
type ExternalCause =
	| "repo.imported"
	| "ref.acknowledged"
	| "ref.reconciled"
	| "repo.created"
	| "enabled";
type FileTriple = [string, string, string];
type Schema = Pick<
	RepoConfigSchemaDto,
	"epoch" | "schemaKey" | "files" | "entries" | "epochBy"
>;

type Work =
	| {
		readonly cause: "advance" | "apply";
		readonly sha: string;
		readonly seq: number;
		/** The trunk config row this work resolves. */
		readonly rowSeq: number;
		readonly cls: "trunk" | "apply";
	}
	| {
		readonly cause: "external";
		readonly sha: string;
		readonly cls: "external";
	}
	| {
		readonly cause: "registry";
		readonly sha: string;
		/** A fresh fence position (registry work never reuses the applied one). */
		readonly seq: number;
		/** The trunk row re-evaluated (trunk's config), or null (re-apply the applied config). */
		readonly rowSeq: number | null;
		readonly cls: "registry";
	}
	| {
		/** A trunk row left pending by a later Advance: resolves the row only. */
		readonly cause: "history";
		readonly sha: string;
		readonly rowSeq: number;
		readonly cls: "external";
	};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Read retries back off from 5 s to 5 min (positive evidence). */
const READ_BACKOFF = { initialMs: 5_000, maxMs: 5 * 60_000 } as const;
/** Evaluator outages back off from 1 min to 30 min (background rounds). */
const OUTAGE_BACKOFF = { initialMs: 60_000, maxMs: 30 * 60_000 } as const;
/** The `eval` handler's budget for its reads and the schema lookup. */
export const EVAL_BUDGET_MS = 3_000;
/** "Re-evaluate" at most once a minute. */
const REEVALUATE_MIN_MS = 60_000;
const PREVIEWS_PER_PASS = 5;
const PREVIEW_RETRY_MS = 10_000;
/** A rate-limited or unavailable preview is queued again, backing off from 30 s to 10 min. */
const PREVIEW_BACKOFF = { initialMs: 30_000, maxMs: 10 * 60_000 } as const;
/** …at most this many times per lane head. */
const PREVIEW_RETRIES = 6;
/** Trunk config history rows kept (newest first); older bases read `expired`. */
export const TRUNK_ROWS_KEPT = 50;
/** A hold this long is told to the repo's Owners (K9). */
export const HOLD_NOTICE_MS = 15 * 60_000;
/**
 * A job's watchdog deadline grows by this much per job queued ahead of it
 * (a deep queue after a deploy is not an outage), counting
 * at most `QUEUED_AHEAD_MAX` of them.
 */
export const QUEUED_JOB_MS = 2_000;
export const QUEUED_AHEAD_MAX = 30;

/** The watchdog deadline of an accepted submit, counted from now. */
const deadlineAfter = (answer: { warm: boolean; ahead?: number }): number =>
	(answer.warm
		? REPO_CONFIG_LIMITS.deadlineWarmMs
		: REPO_CONFIG_LIMITS.deadlineColdMs) +
	Math.min(QUEUED_AHEAD_MAX, Math.max(0, answer.ahead ?? 0)) * QUEUED_JOB_MS;
/** Why the boot row is not policy (the `failed` message readers see). */
export const UNSIGNED_BOOT_MESSAGE =
	"this config landed while repository config was off, with nobody's sign-off; a Maintainer applies it (Apply trunk config) before it is policy";

const backoff = (
	attempts: number,
	b: { initialMs: number; maxMs: number },
): number => Math.min(b.maxMs, b.initialMs * 2 ** Math.max(0, attempts - 1));

const parse = <T>(text: string | null, fallback: T): T => {
	if (text === null) return fallback;
	try {
		return JSON.parse(text) as T;
	} catch {
		return fallback;
	}
};

const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const actorOf = (principal: string): Actor => ({
	kind: principal.startsWith("u_")
		? "user"
		: principal.startsWith("a_")
		? "agent"
		: "system",
	id: principal,
});

const KERNEL: Actor = { kind: "system", id: "sys_kernel" };

/** Rejects after `ms` (the handler then reschedules itself). */
const withBudget = <T>(ms: number, work: Promise<T>): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new BudgetExceeded(`budget of ${ms} ms exceeded`)),
			ms,
		);
	});
	return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
};

class BudgetExceeded extends Error {
	override readonly name = "BudgetExceeded";
}

export type RepoConfigModuleOptions = {
	readonly ports?: (
		deps: ModuleDeps<Env, RepoInternals>,
	) => RepoConfigModulePorts;
	/** Overrides `TARTAN_REPO_CONFIG` (tests). */
	readonly enabled?: boolean;
	readonly budgetMs?: number;
};

/** The repo-policy keys of each extension the schema offers (plan lines). */
const policyKeysOf = (
	schema: Pick<RepoConfigSchemaDto, "entries">,
): Map<string, readonly string[]> =>
	new Map(
		schema.entries.filter((e) => e.repoPolicy.length > 0).map((
			e,
		) => [e.extId, e.repoPolicy]),
	);

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

export const createRepoConfig = (
	deps: ModuleDeps<Env, RepoInternals>,
	options: RepoConfigModuleOptions = {},
) => {
	const { sql, timers, clock } = deps;
	const now = () => clock.now();
	const tx = <T>(fn: () => T): T => deps.storage.transactionSync(fn);
	let portsCache: RepoConfigModulePorts | null = null;
	const ports = (): RepoConfigModulePorts =>
		portsCache ??= (options.ports ?? ((d) => envRepoConfigPorts(d.env)))(deps);
	const budgetMs = options.budgetMs ?? EVAL_BUDGET_MS;
	const enabled = (): boolean =>
		options.enabled ?? deps.env.TARTAN_REPO_CONFIG === "on";

	const rows = <T>(query: string, ...bindings: unknown[]): T[] =>
		sql.exec<T & Record<string, SqlStorageValue>>(query, ...bindings)
			.toArray() as T[];
	const one = <T>(query: string, ...bindings: unknown[]): T | null =>
		rows<T>(query, ...bindings)[0] ?? null;

	const core = () => deps.modules.core;
	const repoId = (): string => {
		const id = core().metaSync("repo_id");
		if (id === null) throw notFound("repo is not initialized");
		return id;
	};
	const nodeId = (): string => core().metaSync("node_id") ?? repoId();
	const trunkRef = (): string =>
		`refs/heads/${core().metaSync("default_branch") ?? "main"}`;
	const canonicalName = (): string => {
		const name = core().metaSync("artifacts_name");
		if (name === null) throw notFound("repo has no artifacts name");
		return name;
	};
	/** The Artifacts repo that holds a lane's commits (K15). */
	const laneRepoName = (laneId: string): string => {
		const lane = core().laneSync(laneId);
		if (lane === null) throw notFound(`unknown lane: ${laneId}`);
		return lane.mode === "repo" && lane.repo_name !== null
			? lane.repo_name
			: canonicalName();
	};

	// -- head -----------------------------------------------------------------

	const head = (): HeadRow => {
		const row = one<HeadRow>("SELECT * FROM config_head WHERE id = 1");
		if (row !== null) return row;
		sql.exec(
			"INSERT INTO config_head (id, status, updated_at) VALUES (1, 'unconfigured', ?)",
			now(),
		);
		return one<HeadRow>("SELECT * FROM config_head WHERE id = 1")!;
	};

	const setHead = (patch: Partial<Omit<HeadRow, "id">>): HeadRow => {
		head();
		const entries = Object.entries({ ...patch, updated_at: now() });
		sql.exec(
			`UPDATE config_head SET ${
				entries.map(([k]) => `${k} = ?`).join(", ")
			} WHERE id = 1`,
			...entries.map(([, v]) => v ?? null),
		);
		return head();
	};

	const emit = (
		type: string,
		data: Record<string, unknown>,
		idem: string,
		actor: Actor = KERNEL,
	): string =>
		deps.modules.events.appendSync({
			type,
			source: { kind: "kernel" },
			actor,
			node: nodeId(),
			repo: repoId(),
			depth: 0,
			shadow: false,
			data,
			idemKey: `repoconfig:${idem}`,
		}).id;

	// -- the cache ------------------------------------------------------------

	const triples = (
		files: readonly { name: string; oid: string; sha256: string }[],
	): FileTriple[] =>
		files.map((f): FileTriple => [f.name, f.oid, f.sha256]).sort((a, b) =>
			a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
		);

	const cacheGet = (key: string): EvalRow | null =>
		one<EvalRow>("SELECT * FROM config_evals WHERE input_key = ?", key);

	const envelopeOf = (row: EvalRow): EvalResponse => {
		if (row.status === "ok") {
			return {
				version: CUE_EVAL_CONTRACT,
				evaluator: row.evaluator,
				cueVersion: row.cue_version,
				ok: parse<unknown>(row.resolved_json, null),
				issues: [],
			};
		}
		const err = parse<{ message?: string; issues?: EvalIssue[] }>(
			row.error_json,
			{},
		);
		return {
			version: CUE_EVAL_CONTRACT,
			evaluator: row.evaluator,
			cueVersion: row.cue_version,
			error: {
				code: (row.code ?? "INTERNAL") as CueEvalErrorCode,
				message: err.message ?? "",
			},
			issues: err.issues ?? [],
		};
	};

	/** A resource-limit error (TIMEOUT, LIMIT_EXCEEDED): it may depend on the environment. */
	const isLimitError = (row: Pick<EvalRow, "status" | "code">): boolean =>
		row.status === "error" &&
		(PREVIEW_ONLY_EVAL_CODES as readonly string[]).includes(row.code ?? "");

	/** How many trunk evaluations in a row gave this key's resource-limit error. */
	const limitHits = (row: EvalRow): number =>
		parse<{ limitHits?: number }>(row.error_json, {}).limitHits ?? 1;

	/**
	 * A cache entry trunk may use: only trunk's own answer (a preview
	 * sandbox evaluates any principal's input, so its result is shown on the
	 * change card but never applied, never read as policy and never taken as
	 * trunk's), with the sha256 of each canonical file matching.
	 * A trunk TIMEOUT or LIMIT_EXCEEDED is final only once two trunk
	 * evaluations in a row gave it (a cold or contended instance must not
	 * fail a config for good). A mismatching entry is dropped, so trunk
	 * re-evaluates.
	 */
	const trunkHit = (key: string, files: FileTriple[]): EvalRow | null => {
		const row = cacheGet(key);
		if (row === null) return null;
		if (JSON.stringify(parse(row.files_json, [])) !== JSON.stringify(files)) {
			sql.exec("DELETE FROM config_evals WHERE input_key = ?", key);
			return null;
		}
		if (row.origin !== "trunk") return null;
		if (isLimitError(row) && limitHits(row) < 2) return null;
		sql.exec(
			"UPDATE config_evals SET used_at = ? WHERE input_key = ?",
			now(),
			key,
		);
		return row;
	};

	const previewHit = (key: string): EvalRow | null => {
		const row = cacheGet(key);
		if (row === null) return null;
		sql.exec(
			"UPDATE config_evals SET used_at = ? WHERE input_key = ?",
			now(),
			key,
		);
		return row;
	};

	/** LRU: keep 50, the applied key and every key a kept trunk row names. */
	const pruneCache = (): void => {
		const keep = head().applied_key;
		const n = one<{ n: number }>(
			`SELECT COUNT(*) AS n FROM config_evals WHERE input_key <> ?
			   AND input_key NOT IN (SELECT input_key FROM config_trunk WHERE input_key IS NOT NULL)`,
			keep ?? "",
		)?.n ?? 0;
		const extra = n - REPO_CONFIG_LIMITS.cacheEntries;
		if (extra <= 0) return;
		sql.exec(
			`DELETE FROM config_evals WHERE input_key IN (
			   SELECT input_key FROM config_evals WHERE input_key <> ?
			     AND input_key NOT IN (SELECT input_key FROM config_trunk WHERE input_key IS NOT NULL)
			   ORDER BY used_at LIMIT ?)`,
			keep ?? "",
			extra,
		);
	};

	// -- the trunk config history (ADR repo config) -------------------------------

	/** `trunk_commits.seq` of a trunk commit (WP5a's table, read-only), or null. */
	const trunkSeqOf = (sha: string): number | null =>
		one<{ seq: number }>("SELECT seq FROM trunk_commits WHERE sha = ?", sha)
			?.seq ?? null;
	const trunkTipSeq = (): number =>
		one<{ n: number | null }>("SELECT MAX(seq) AS n FROM trunk_commits")?.n ??
			0;

	const trunkRow = (seq: number): TrunkRow | null =>
		one<TrunkRow>("SELECT * FROM config_trunk WHERE trunk_seq = ?", seq);
	const newestTrunkRow = (): TrunkRow | null =>
		one<TrunkRow>(
			"SELECT * FROM config_trunk ORDER BY trunk_seq DESC LIMIT 1",
		);
	/** The newest row at or before `seq`. */
	const trunkRowAt = (seq: number): TrunkRow | null =>
		one<TrunkRow>(
			"SELECT * FROM config_trunk WHERE trunk_seq <= ? ORDER BY trunk_seq DESC LIMIT 1",
			seq,
		);
	/** The newest resolved-and-good row (`ok` or `none`) strictly before `seq`. */
	/** The newest resolved-and-good row strictly before `seq` (never the unsigned boot row). */
	const lastGoodBefore = (seq: number): TrunkRow | null =>
		one<TrunkRow>(
			`SELECT * FROM config_trunk WHERE trunk_seq < ? AND status IN ('ok','none')
			   AND trunk_seq <> ? ORDER BY trunk_seq DESC LIMIT 1`,
			seq,
			head().boot_seq ?? -1,
		);

	const trunkRowDto = (row: TrunkRow): RepoConfigTrunkRowDto => ({
		trunkSeq: row.trunk_seq,
		sha: row.sha,
		policyDigest: row.policy_digest,
		...(row.input_key === null ? {} : { inputKey: row.input_key }),
		status: row.status,
		...(row.code === null ? {} : { code: row.code }),
		...(row.message === null ? {} : { message: row.message }),
		issues: parse<EvalIssue[]>(row.issues_json, []),
		at: row.at,
	});

	/**
	 * Opens (or keeps) a row; an existing resolved row is never rewritten.
	 * `principals`: the signers of the landing (or the applier) the row's
	 * config came from (a registry re-apply names them after the Owner).
	 */
	const openTrunkRowSync = (
		seq: number,
		sha: string,
		digest?: string | null,
		principals?: readonly string[],
	): TrunkRow => {
		const existing = trunkRow(seq);
		const signers = principals === undefined
			? null
			: JSON.stringify([...new Set(principals)].slice(0, 32));
		if (existing !== null && existing.sha === sha) {
			if (existing.status === "pending" && digest !== undefined) {
				sql.exec(
					"UPDATE config_trunk SET policy_digest = ? WHERE trunk_seq = ?",
					digest,
					seq,
				);
			}
			if (existing.status === "pending" && signers !== null) {
				sql.exec(
					"UPDATE config_trunk SET principals_json = ? WHERE trunk_seq = ?",
					signers,
					seq,
				);
			}
			return trunkRow(seq)!;
		}
		sql.exec(
			`INSERT INTO config_trunk (trunk_seq, sha, policy_digest, input_key, status, code, message, issues_json,
			   principals_json, at)
			 VALUES (?, ?, ?, NULL, 'pending', NULL, NULL, NULL, ?, ?)
			 ON CONFLICT (trunk_seq) DO UPDATE SET sha = excluded.sha, policy_digest = excluded.policy_digest,
			   input_key = NULL, status = 'pending', code = NULL, message = NULL, issues_json = NULL,
			   principals_json = excluded.principals_json, at = excluded.at`,
			seq,
			sha,
			digest ?? null,
			signers,
			now(),
		);
		pruneTrunkSync();
		return trunkRow(seq)!;
	};

	/**
	 * Resolves a pending row (once) and announces it (`repo.config.resolved`).
	 * `reresolve`: registry work and an explicit apply evaluated the row's
	 * config under a newer schema; an `error` row (it did not evaluate, or
	 * was rejected as a whole) may then be resolved again. An `ok` or `none`
	 * row is never rewritten.
	 */
	const resolveTrunkRowSync = (
		seq: number | null,
		result: {
			readonly status: "ok" | "error" | "none";
			readonly inputKey?: string | null;
			readonly digest?: string | null;
			readonly code?: string;
			readonly message?: string;
			readonly issues?: readonly EvalIssue[];
		},
		options: { readonly reresolve?: boolean } = {},
	): void => {
		if (seq === null) return;
		const row = trunkRow(seq);
		if (row === null) return;
		const again = options.reresolve === true && row.status === "error";
		if (row.status !== "pending" && !again) return;
		if (again && result.status === "error") return; // still does not evaluate
		sql.exec(
			`UPDATE config_trunk SET status = ?, input_key = ?, policy_digest = COALESCE(?, policy_digest),
			   code = ?, message = ?, issues_json = ?, at = ? WHERE trunk_seq = ?`,
			result.status,
			result.inputKey ?? null,
			result.digest ?? null,
			result.code ?? null,
			result.message?.slice(0, 2000) ?? null,
			result.issues === undefined || result.issues.length === 0
				? null
				: JSON.stringify(result.issues.slice(0, REPO_CONFIG_LIMITS.issues)),
			now(),
			seq,
		);
		emit(
			"repo.config.resolved",
			{
				trunkSeq: seq,
				sha: row.sha,
				status: result.status,
				...(result.inputKey ? { inputKey: result.inputKey } : {}),
			},
			again
				? `reresolved:${seq}:${row.sha}:${result.inputKey ?? result.status}`
				: `resolved:${seq}:${row.sha}`,
		);
	};

	const pruneTrunkSync = (): void => {
		const cut = one<{ seq: number | null }>(
			"SELECT trunk_seq AS seq FROM config_trunk ORDER BY trunk_seq DESC LIMIT 1 OFFSET ?",
			TRUNK_ROWS_KEPT,
		)?.seq;
		if (cut === undefined || cut === null) return;
		// The last good row is pinned: while every kept row is
		// `error` or `pending`, the newest `ok`/`none` row below the cut stays,
		// so a failed head keeps reading its last good config, never `{}`.
		const goodKept = one<{ n: number }>(
			"SELECT COUNT(*) AS n FROM config_trunk WHERE trunk_seq > ? AND status IN ('ok','none')",
			cut,
		)?.n ?? 0;
		const pinned = goodKept > 0 ? null : one<{ seq: number }>(
			`SELECT trunk_seq AS seq FROM config_trunk WHERE trunk_seq <= ? AND status IN ('ok','none')
			 ORDER BY trunk_seq DESC LIMIT 1`,
			cut,
		)?.seq ?? null;
		sql.exec(
			"DELETE FROM config_trunk WHERE trunk_seq <= ? AND trunk_seq <> ?",
			cut,
			pinned ?? -1,
		);
		setHead({
			trunk_pruned_seq: Math.max(head().trunk_pruned_seq ?? cut, cut),
		});
	};

	const resolvedOfRow = (row: TrunkRow): unknown => {
		if (row.status === "none" || row.input_key === null) return {};
		const cached = cacheGet(row.input_key);
		return cached === null || cached.status !== "ok"
			? {}
			: parse<unknown>(cached.resolved_json, {});
	};

	/** `policyAt(seq)` of the ADR: the trunk config in force at a trunk position. */
	const policyAtSync = (seq: number): RepoPolicyAt => {
		if (!live()) return { state: "none" };
		const row = trunkRowAt(seq);
		const pruned = head().trunk_pruned_seq;
		if (row === null || (pruned !== null && row.trunk_seq <= pruned)) {
			// No kept row at or before `seq`: once rows were pruned, every such
			// position is older than the kept history (the row that answered it
			// is gone), so it reads `expired`, never "no config". A pinned
			// last-good row below the cut answers only as the last good of a
			// newer failed row.
			return pruned !== null ? { state: "expired" } : { state: "none" };
		}
		const lastGood = (failed: TrunkRow): RepoPolicyAt => {
			// The last good row is never pruned (it is pinned), so none here
			// means no config was ever good: no config, not exact.
			const good = lastGoodBefore(failed.trunk_seq);
			return {
				state: "ok",
				sha: good?.sha ?? failed.sha,
				...(good?.input_key ? { inputKey: good.input_key } : {}),
				exact: false,
				resolved: good === null ? {} : resolvedOfRow(good),
				failed: trunkRowDto(failed),
			};
		};
		if (row.status !== "pending" && row.trunk_seq === head().boot_seq) {
			// Config that landed while the switch was off: nobody signed it, so
			// it is not policy until a Maintainer applies it. Readers
			// get the last good config, not exact: review routes every change
			// to a person, CI plans zero-config with a note.
			return {
				...lastGood(row),
				failed: {
					...trunkRowDto(row),
					message: UNSIGNED_BOOT_MESSAGE,
				},
			} as RepoPolicyAt;
		}
		switch (row.status) {
			case "ok":
				return {
					state: "ok",
					sha: row.sha,
					...(row.input_key ? { inputKey: row.input_key } : {}),
					exact: true,
					resolved: resolvedOfRow(row),
				};
			case "none":
				return { state: "none" };
			case "error":
				return lastGood(row);
			case "pending": {
				const h = head();
				if (h.override_pending === 1 && h.pending_row_seq === row.trunk_seq) {
					return lastGood(row);
				}
				const good = lastGoodBefore(row.trunk_seq);
				return {
					state: "pending",
					lastGood: good === null
						? null
						: good.status === "none"
						? { state: "none" }
						: {
							state: "ok",
							sha: good.sha,
							...(good.input_key ? { inputKey: good.input_key } : {}),
							exact: false,
							resolved: resolvedOfRow(good),
						},
				};
			}
		}
	};

	/** The policy DTO of the trunk tip (settings page, MCP). */
	const policyDto = (): RepoPolicyDto => {
		const newest = newestTrunkRow();
		const at = policyAtSync(Math.max(trunkTipSeq(), newest?.trunk_seq ?? 0));
		const values = at.state === "ok"
			? at.resolved
			: at.state === "pending" && at.lastGood?.state === "ok"
			? at.lastGood.resolved
			: {};
		const v = isRecord(values) ? values : {};
		const settingsOf = (extId: string) => {
			const ext = isRecord(v.extensions) ? v.extensions[extId] : undefined;
			return isRecord(ext) && isRecord(ext.settings) ? ext.settings : {};
		};
		const inForceRow = at.state === "ok"
			? (at.exact ? newest : (at.inputKey === undefined ? null : one<TrunkRow>(
				"SELECT * FROM config_trunk WHERE input_key = ? ORDER BY trunk_seq DESC LIMIT 1",
				at.inputKey,
			)))
			: null;
		return {
			newest: newest === null ? null : trunkRowDto(newest),
			inForce: inForceRow === null ? null : trunkRowDto(inForceRow),
			exact: at.state !== "ok" || at.exact,
			pending: at.state === "pending",
			...(settingsOf("tartan.ci").pipeline === undefined
				? {}
				: { pipeline: settingsOf("tartan.ci").pipeline }),
			...(settingsOf("tartan.review").owners === undefined
				? {}
				: { owners: settingsOf("tartan.review").owners }),
			...(v.projects === undefined ? {} : { projects: v.projects }),
			...(v.global === undefined ? {} : { global: v.global }),
		};
	};

	// -- state transitions ----------------------------------------------------

	const failureOf = (
		envelope: EvalResponse,
		denials: readonly RepoConfigDenial[] = [],
	): Failure =>
		isEvalOk(envelope)
			? {
				code: denials[0]?.code ?? "denied",
				message: denials.map((d) => d.message).join("; ").slice(0, 2000),
				issues: [],
				denials,
			}
			: {
				code: envelope.error.code,
				message: envelope.error.message,
				issues: envelope.issues,
				denials,
			};

	/** Denials that make a trunk row `error` (the config as a whole is rejected). */
	const rowDenials = (denials: readonly RepoConfigDenial[]) =>
		denials.filter((d) => REPO_POLICY_DENIAL_CODES.includes(d.code));

	const clearedPending = {
		pending_seq: null,
		pending_sha: null,
		pending_key: null,
		pending_cause: null,
		pending_row_seq: null,
		pending_principals_json: null,
		pending_removal_ok: 0 as const,
		hold: 0 as const,
	};

	/**
	 * Ends the pending work: no pending row, no hold. An Owner's
	 * keep-last-good covered that resolution only; it stays while it still
	 * covers ForgeDO's gate-missing hold.
	 */
	const clearPending = (h: HeadRow = head()) => ({
		...clearedPending,
		override_pending: 0 as const,
		...(h.override_gate !== 0 ? {} : { override_by: null }),
	});

	/** ForgeDO's hold, as read or answered; a cleared hold ends the override part that covered it. */
	const forgeHoldPatch = (
		h: HeadRow,
		hold: string | null,
		holdId?: number,
	) => ({
		forge_hold: hold,
		// A registry without generations answers none: 1 while held.
		...(hold === null ? {} : { forge_hold_id: holdId ?? 1 }),
		...(hold === null && h.override_gate !== 0
			? {
				override_gate: 0 as const,
				...(h.override_pending === 1 ? {} : { override_by: null }),
			}
			: {}),
	});

	const recordForgeHold = (hold: string | null, holdId?: number): HeadRow => {
		const h = head();
		if (
			h.forge_hold === hold &&
			(hold === null
				? h.override_gate === 0
				: h.forge_hold_id === (holdId ?? 1))
		) {
			return h;
		}
		return setHead(forgeHoldPatch(h, hold, holdId));
	};

	/**
	 * Schedules `key` no later than `at`: the WP0 timers API upserts,
	 * so a later write would push out a sooner wake another path set (a
	 * preview's retry over the queued previews' requeue, a preview's 75 s
	 * watchdog over trunk's 30 s one). A row that is already due (the handler
	 * running now, or one this alarm runs anyway) is simply replaced.
	 */
	const soon = (key: string, at: number): void => {
		const existing = timers.get(key);
		timers.schedule(
			key,
			existing === null || existing <= now() ? at : Math.min(existing, at),
		);
	};

	const scheduleEval = (at = now()): void => soon("eval", at);

	/**
	 * The switch, with its transitions. While it is off nothing is
	 * evaluated, held or recorded, so turning it on (again) must not trust
	 * what this repo knew before: trunk's root `*.cue` files may have changed
	 * with nobody's sign-off. The first call that finds it on after it was
	 * never on, or after it was seen off while trunk moved:
	 * - drops the trunk history (its rows may no longer be trunk's config;
	 *   bases before the tip then read `expired`, or `none` when there was
	 *   no history);
	 * - opens the tip's row `pending` (readers wait for it, never `none`),
	 *   marked as the boot row: unsigned, so not policy until a Maintainer
	 *   applies it;
	 * - schedules external work (installations go to `needs-apply`) and
	 *   registry work (pokes dropped while off).
	 * The first call that finds it off records trunk's tip, once.
	 */
	const live = (): boolean => {
		if (!enabled()) {
			const row = one<Pick<HeadRow, "enabled_state">>(
				"SELECT enabled_state FROM config_head WHERE id = 1",
			);
			if (row?.enabled_state === 1) {
				setHead({
					enabled_state: 2,
					off_tip: core().refSync(trunkRef())?.sha ?? null,
				});
			}
			return false;
		}
		if (head().enabled_state !== 1) enableSync();
		return true;
	};

	const enableSync = (): void => {
		const h = head();
		const tip = core().refSync(trunkRef())?.sha ?? null;
		const configured = h.applied_key !== null || newestTrunkRow() !== null;
		if (h.enabled_state === 2 && tip === h.off_tip) {
			// Trunk did not move while the switch was off: only registry
			// changes made meanwhile (their pokes were dropped) are missing.
			setHead({
				enabled_state: 1,
				off_tip: null,
				...(configured ? { registry_due: 1 as const } : {}),
			});
			if (configured) scheduleEval();
			return;
		}
		const tipSeq = tip === null || !isSha(tip) ? null : trunkSeqOf(tip);
		const hadRows = newestTrunkRow() !== null;
		sql.exec("DELETE FROM config_trunk");
		if (tip === null || tipSeq === null) {
			setHead({
				enabled_state: 1,
				off_tip: null,
				boot_seq: null,
				trunk_pruned_seq: null,
				...(h.applied_key !== null ? { registry_due: 1 as const } : {}),
			});
			return;
		}
		openTrunkRowSync(tipSeq, tip);
		setHead({
			...clearPending(h),
			enabled_state: 1,
			off_tip: null,
			boot_seq: tipSeq,
			trunk_pruned_seq: hadRows ? tipSeq - 1 : null,
			obs_seq: h.obs_seq + 1,
			trunk_sha: tip,
			external_due: 1,
			external_cause: "enabled",
			...(h.applied_key !== null ? { registry_due: 1 as const } : {}),
			...(h.status === "pending" ? { status: "stale" as const } : {}),
			eval_attempts: 0,
			unavailable_until: null,
		});
		emit(
			"repo.config.evaluating",
			{ sha: tip, cause: "external", trunkSeq: h.obs_seq + 1 },
			`evaluating:enabled:${tip}:${now()}`,
		);
		scheduleEval();
	};

	/** The registry epoch the evaluation pass in hand used (its schema). */
	let workEpoch: number | undefined;

	/**
	 * Ends registry work only when it ran at the newest epoch this repo was
	 * poked with: a poke that arrived during the pass's awaits (an
	 * approval the config needs) keeps it due, since ForgeDO already dropped
	 * its outbox row.
	 */
	const registryCleared = (epoch: number | undefined) =>
		epoch !== undefined && head().epoch_seen > epoch
			? {}
			: { registry_due: 0 as const };

	/** ForgeDO's dry-run check, bounded like a read (a slow ForgeDO never stalls the alarm). */
	const checkResolved = (resolved: unknown) =>
		withBudget(budgetMs, ports().check(repoId(), resolved));

	/** An evaluator outage: the head keeps its state; background rounds. */
	const outage = (message: string): void => {
		const h = head();
		const attempts = h.eval_attempts + 1;
		const until = now() + backoff(attempts, OUTAGE_BACKOFF);
		setHead({ eval_attempts: attempts, unavailable_until: until });
		ports().log("evaluator unavailable", {
			attempts,
			message: message.slice(0, 200),
		});
		scheduleEval(until);
	};

	const writeIntent = (input: {
		readonly seq: number;
		readonly epoch: number;
		readonly key: string;
		readonly schemaKey: string;
		readonly sha: string;
		readonly principals: readonly string[];
		readonly explicit: boolean;
		readonly removal: boolean;
		readonly rowSeq: number | null;
		readonly cause: Work["cause"];
	}): void => {
		sql.exec(
			`INSERT INTO config_apply_intents (trunk_seq, epoch, input_key, schema_key, sha, principals_json,
			   explicit, removal, row_seq, cause, state, attempts, answer_json, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?)
			 ON CONFLICT (trunk_seq, epoch) DO UPDATE SET input_key = excluded.input_key,
			   schema_key = excluded.schema_key, sha = excluded.sha,
			   principals_json = excluded.principals_json, explicit = excluded.explicit,
			   removal = excluded.removal, row_seq = excluded.row_seq, cause = excluded.cause,
			   state = 'pending', answer_json = NULL`,
			input.seq,
			input.epoch,
			input.key,
			input.schemaKey,
			input.sha,
			JSON.stringify([...new Set(input.principals)].slice(0, 32)),
			input.explicit ? 1 : 0,
			input.removal ? 1 : 0,
			input.rowSeq,
			input.cause,
			now(),
		);
		soon("apply", now());
	};

	/** The principals of the work: the signers, the applier, or the kernel. */
	const principalsOf = (h: HeadRow): string[] =>
		parse<string[]>(h.pending_principals_json, []);

	// -- the eval handler -----------------------------------------------------

	/**
	 * Registry work evaluates TRUNK's config (the newest trunk row) under the
	 * new schema, so a config the old schema refused can apply once allowed;
	 * while `needs-apply` holds (or trunk's row is still pending) it
	 * re-applies the applied config instead. Each round gets a fresh fence
	 * position: the applied one would be an equal fence with another key.
	 */
	const registryWork = (h: HeadRow): Work | null => {
		const seq = Math.max(h.obs_seq, h.applied_seq ?? 0) + 1;
		const newest = newestTrunkRow();
		if (
			newest !== null && newest.status !== "pending" &&
			h.status !== "needs-apply"
		) {
			return {
				cause: "registry",
				sha: newest.sha,
				seq,
				rowSeq: newest.trunk_seq,
				cls: "registry",
			};
		}
		if (h.applied_sha !== null) {
			return {
				cause: "registry",
				sha: h.applied_sha,
				seq,
				rowSeq: null,
				cls: "registry",
			};
		}
		return null;
	};

	/** The oldest trunk row still pending that no work owns (a later Advance superseded it). */
	const orphanRow = (h: HeadRow): TrunkRow | null =>
		one<TrunkRow>(
			`SELECT * FROM config_trunk WHERE status = 'pending' AND (? IS NULL OR trunk_seq <> ?)
			 ORDER BY trunk_seq LIMIT 1`,
			h.pending_row_seq,
			h.pending_row_seq,
		);

	const nextWork = (h: HeadRow): Work | null => {
		if (h.pending_sha !== null && h.pending_seq !== null) {
			const rowSeq = h.pending_row_seq ?? trunkSeqOf(h.pending_sha) ??
				trunkTipSeq();
			return h.pending_cause === "apply"
				? {
					cause: "apply",
					sha: h.pending_sha,
					seq: h.pending_seq,
					rowSeq,
					cls: "apply",
				}
				: {
					cause: "advance",
					sha: h.pending_sha,
					seq: h.pending_seq,
					rowSeq,
					cls: "trunk",
				};
		}
		if (h.external_due === 1) {
			const sha = core().refSync(trunkRef())?.sha ?? h.trunk_sha;
			if (sha !== null && isSha(sha)) {
				return { cause: "external", sha, cls: "external" };
			}
		}
		if (h.registry_due === 1) {
			const work = registryWork(h);
			if (work !== null) return work;
		}
		const orphan = orphanRow(h);
		return orphan === null ? null : {
			cause: "history",
			sha: orphan.sha,
			rowSeq: orphan.trunk_seq,
			cls: "external",
		};
	};

	/** The same work across passes (a registry round's fence position aside). */
	const workId = (w: Work): string =>
		`${w.cause}:${w.sha}:${"rowSeq" in w ? String(w.rowSeq) : ""}`;

	/** The trunk row an external move resolves: the tip's seq (or the newest known). */
	const externalRowSeq = (sha: string): number =>
		trunkSeqOf(sha) ?? trunkTipSeq();

	/** A registry re-apply names the Owner whose change moved the epoch, then the config's signers. */
	const registryPrincipals = (
		h: HeadRow,
		work: Extract<Work, { cause: "registry" }>,
		schema: Pick<Schema, "epochBy">,
	): string[] => {
		const signers = work.rowSeq === null
			? parse<string[]>(h.applied_principals_json, [])
			: parse<string[]>(trunkRow(work.rowSeq)?.principals_json ?? null, []);
		return [
			...new Set([
				...(schema.epochBy === undefined ? [] : [schema.epochBy]),
				...signers,
			]),
		].slice(0, 32);
	};

	type ApplyWork = Extract<
		Work,
		{ cause: "advance" | "apply" | "registry" }
	>;

	/** The work's config is what ForgeDO applied at this epoch: nothing to apply. */
	const settleApplied = (
		work: ApplyWork,
		key: string,
		removal: boolean,
		digest?: string | null,
	): void => {
		const result = removal ? { status: "none" as const } : {
			status: "ok" as const,
			inputKey: key,
			...(digest === undefined ? {} : { digest }),
		};
		tx(() => {
			if (work.cause === "registry") {
				resolveTrunkRowSync(work.rowSeq, result, { reresolve: true });
				setHead({
					...registryCleared(workEpoch),
					eval_attempts: 0,
					unavailable_until: null,
					...(work.rowSeq === null ? {} : {
						status: "current" as const,
						failure_json: null,
						plan_json: null,
					}),
				});
				return;
			}
			resolveTrunkRowSync(work.rowSeq, result, {
				reresolve: work.cause === "apply",
			});
			setHead({
				...clearPending(),
				// An applied config is policy (a Maintainer's apply).
				...(head().boot_seq === work.rowSeq ? { boot_seq: null } : {}),
				status: "current",
				...registryCleared(workEpoch),
				...(work.cause === "apply" ? { external_due: 0 } : {}),
				failure_json: null,
				plan_json: null,
				eval_attempts: 0,
				unavailable_until: null,
			});
		});
	};

	/** The work's outcome is a resolved config (from cache or a removal). */
	const resolvedOutcome = async (
		work: Work,
		key: string,
		schema: Pick<Schema, "epoch" | "schemaKey" | "epochBy">,
		resolved: unknown,
		removal: boolean,
	): Promise<void> => {
		const h = head();
		const rowResult = (bad: readonly RepoConfigDenial[]) =>
			bad.length > 0
				? {
					status: "error" as const,
					inputKey: key,
					code: bad[0].code,
					message: bad.map((d) => d.message).join("; "),
				}
				: {
					status: removal ? "none" as const : "ok" as const,
					inputKey: removal ? null : key,
				};
		if (work.cause === "external") {
			const rowSeq = externalRowSeq(work.sha);
			const answer = await checkResolved(resolved);
			tx(() => {
				// Repo policy reads the new trunk config at once (as the YAML
				// files were read from trunk); installations wait for an apply.
				resolveTrunkRowSync(rowSeq, rowResult(rowDenials(answer.denials)));
				if (key === h.applied_key) {
					// Trunk is back at the applied config: nothing to apply. That
					// config was signed or applied, so a boot row of it is policy.
					setHead({
						external_due: 0,
						external_by: null,
						...(h.boot_seq === rowSeq ? { boot_seq: null } : {}),
						...(h.status === "needs-apply"
							? {
								status: "current" as const,
								plan_json: null,
								plan_key: null,
								failure_json: null,
							}
							: {}),
					});
					return;
				}
				setHead({
					status: "needs-apply",
					external_due: 0,
					plan_json: JSON.stringify(answer.plan),
					plan_key: key,
					failure_json: answer.denials.length > 0
						? JSON.stringify(failureOf(
							{
								version: CUE_EVAL_CONTRACT,
								evaluator: CUE_EVALUATOR_ID,
								cueVersion: null,
								ok: resolved,
								issues: [],
							},
							answer.denials,
						))
						: null,
					eval_attempts: 0,
					unavailable_until: null,
				});
				emit(
					"repo.config.needs-apply",
					{
						sha: work.sha,
						inputKey: key,
						cause: removal ? "removal" : h.external_cause ?? "ref.reconciled",
					},
					`needs-apply:${work.sha}:${key}`,
				);
			});
			return;
		}
		if (work.cause === "history") {
			// An older trunk row: its result answers `policyAt` for the bases
			// before the newer row, and nothing is applied.
			const answer = await checkResolved(resolved);
			tx(() =>
				resolveTrunkRowSync(
					work.rowSeq,
					rowResult(rowDenials(answer.denials)),
				)
			);
			return;
		}
		if (work.cause === "advance" && h.status === "needs-apply") {
			// An Advance during needs-apply updates the displayed plan and the
			// trunk row (repo policy), not the installations.
			const answer = await checkResolved(resolved);
			tx(() => {
				resolveTrunkRowSync(
					work.rowSeq,
					rowResult(rowDenials(answer.denials)),
				);
				setHead({
					...clearPending(),
					plan_json: JSON.stringify(answer.plan),
					plan_key: key,
				});
			});
			return;
		}
		if (key === h.applied_key && h.applied_epoch === schema.epoch) {
			settleApplied(work, key, removal);
			return;
		}
		tx(() => {
			if (work.cause === "registry") {
				// An Advance or an explicit apply arrived during the pass's
				// awaits, or trunk has a newer config row: this work's config
				// is no longer trunk's, and applying it at a higher fence would
				// roll the newer one back. It runs again after that work
				// (registry_due stays set).
				const current = head();
				if (
					current.pending_sha !== null ||
					(work.rowSeq !== null &&
						newestTrunkRow()?.trunk_seq !== work.rowSeq)
				) {
					scheduleEval();
					return;
				}
			}
			// Registry work reserves its fence position here, in the
			// transaction that writes the intent: an Advance during
			// the pass's awaits took the position nextWork saw, and an UPSERT
			// on it would merge two different works into one intent.
			const seq = work.cause === "registry"
				? Math.max(work.seq, head().obs_seq + 1)
				: work.seq;
			writeIntent({
				seq,
				epoch: schema.epoch,
				key,
				schemaKey: schema.schemaKey,
				sha: work.sha,
				principals: work.cause === "registry"
					? registryPrincipals(h, work, schema)
					: principalsOf(h),
				explicit: work.cause === "apply",
				removal,
				rowSeq: work.rowSeq,
				cause: work.cause,
			});
			setHead({
				...(work.cause === "registry"
					? { obs_seq: Math.max(head().obs_seq, seq) }
					: { pending_key: key }),
				eval_attempts: 0,
				unavailable_until: null,
			});
		});
	};

	const errorOutcome = (
		work: Work,
		envelope: EvalResponse,
		key: string | null,
		digest?: string | null,
	) => {
		if (isEvalOk(envelope)) return;
		const code = envelope.error.code;
		if ((UNCACHED_EVAL_CODES as readonly string[]).includes(code)) {
			// EVALUATOR_UNAVAILABLE and INTERNAL never become `failed`, and the
			// trunk row stays pending.
			tx(() => outage(envelope.error.message));
			return;
		}
		const failure = failureOf(envelope);
		const rowResult = {
			status: "error" as const,
			inputKey: key,
			...(digest === undefined ? {} : { digest }),
			code,
			message: envelope.error.message,
			issues: envelope.issues,
		};
		const failed = () =>
			emit(
				"repo.config.failed",
				{
					sha: work.sha,
					...(key === null ? {} : { inputKey: key }),
					code,
					message: envelope.error.message.slice(0, 2000),
				},
				`failed:${work.sha}:${key ?? code}`,
			);
		tx(() => {
			if (work.cause === "history") {
				resolveTrunkRowSync(work.rowSeq, rowResult);
				return;
			}
			if (work.cause === "external" || work.cause === "apply") {
				resolveTrunkRowSync(
					work.cause === "apply" ? work.rowSeq : externalRowSeq(work.sha),
					rowResult,
					{ reresolve: work.cause === "apply" },
				);
				setHead({
					...(work.cause === "apply" ? clearPending() : {}),
					status: "needs-apply",
					external_due: 0,
					plan_json: "[]",
					plan_key: key,
					failure_json: JSON.stringify(failure),
					eval_attempts: 0,
					unavailable_until: null,
				});
				return;
			}
			if (work.cause === "registry") {
				// Trunk's config does not evaluate under the new schema: its row
				// keeps the recorded result (registry work never rewrites it into
				// an error); `needs-apply` keeps its plan.
				const keep = head().status === "needs-apply";
				setHead({
					...(keep ? {} : { status: "failed" as const, plan_json: null }),
					...registryCleared(workEpoch),
					failure_json: JSON.stringify(failure),
					eval_attempts: 0,
					unavailable_until: null,
				});
				if (!keep) failed();
				return;
			}
			resolveTrunkRowSync(work.rowSeq, rowResult);
			if (head().status === "needs-apply") {
				setHead({ ...clearPending(), failure_json: JSON.stringify(failure) });
				return;
			}
			setHead({
				...clearPending(),
				status: "failed",
				...registryCleared(workEpoch),
				failure_json: JSON.stringify(failure),
				plan_json: null,
				eval_attempts: 0,
				unavailable_until: null,
			});
			failed();
		});
	};

	/** The request files: the forge's overlay and the repo's root `*.cue` files. */
	const requestFiles = (
		schema: Pick<Schema, "files">,
		snapshot: Extract<ConfigSnapshot, { kind: "files" }>,
	): Record<string, string> => {
		const files: Record<string, string> = { ...schema.files };
		for (const f of snapshot.files) files[f.name] = f.text;
		return files;
	};

	/** A trunk-family job (`cue:trunk`); previews keep their own rows. */
	const trunkJob = (key: string): JobRow | null =>
		one<JobRow>(
			"SELECT * FROM config_jobs WHERE input_key = ? AND family = 'trunk'",
			key,
		);

	const dispatch = async (
		work: Work,
		key: string,
		snapshot: Extract<ConfigSnapshot, { kind: "files" }>,
		schema: Schema,
	): Promise<void> => {
		// Single flight on trunk's own job only: a preview of the same key
		// never answers for trunk, and trunk never waits on the preview queue.
		const job = trunkJob(key);
		if (
			job !== null && job.deadline_at !== null && job.deadline_at > now()
		) {
			return; // single flight: the running evaluation answers
		}
		const attempts = (job?.attempts ?? 0) + 1;
		if (attempts > REPO_CONFIG_LIMITS.dispatchesPerRound) {
			tx(() => {
				sql.exec(
					"DELETE FROM config_jobs WHERE input_key = ? AND family = 'trunk'",
					key,
				);
				outage(`no answer after ${attempts - 1} dispatches`);
			});
			return;
		}
		const files = requestFiles(schema, snapshot);
		tx(() => {
			sql.exec(
				`INSERT INTO config_jobs (input_key, family, class, sha, lane_id, schema_key, epoch, files_json,
				   sandbox, principal, dispatched_at, deadline_at, attempts, next_at)
				 VALUES (?, 'trunk', ?, ?, NULL, ?, ?, ?, ?, NULL, ?, NULL, ?, NULL)
				 ON CONFLICT (input_key, family) DO UPDATE SET class = excluded.class, sha = excluded.sha,
				   schema_key = excluded.schema_key, epoch = excluded.epoch, files_json = excluded.files_json,
				   dispatched_at = excluded.dispatched_at, deadline_at = NULL, attempts = excluded.attempts`,
				key,
				work.cls,
				work.sha,
				schema.schemaKey,
				schema.epoch,
				JSON.stringify(triples(snapshot.files)),
				CUE_TRUNK_SANDBOX,
				now(),
				attempts,
			);
			if (work.cause === "advance" || work.cause === "apply") {
				setHead({ pending_key: key });
			}
		});
		let answer;
		try {
			// `cueSubmit` returns at once; a stuck call is bounded like a read.
			answer = await withBudget(
				budgetMs,
				ports().submit(CUE_TRUNK_SANDBOX, {
					class: work.cls,
					sink: { kind: "repo", repoId: repoId() },
					request: {
						version: CUE_EVAL_CONTRACT,
						evaluator: CUE_EVALUATOR_ID,
						inputKey: key,
						files,
						limits: DEFAULT_EVAL_LIMITS,
					},
				}),
			);
		} catch (error) {
			if (error instanceof BudgetExceeded) throw error;
			answer = {
				accepted: false as const,
				reason: "unavailable" as const,
				message: errorText(error).slice(0, 300),
			};
		}
		if (answer.accepted) {
			const deadline = now() + deadlineAfter(answer);
			tx(() => {
				sql.exec(
					"UPDATE config_jobs SET deadline_at = ? WHERE input_key = ? AND family = 'trunk'",
					deadline,
					key,
				);
				soon("jobs", deadline);
			});
			return;
		}
		tx(() =>
			sql.exec(
				"DELETE FROM config_jobs WHERE input_key = ? AND family = 'trunk'",
				key,
			)
		);
		if (answer.reason === "too_large" || answer.reason === "invalid") {
			errorOutcome(work, hostEvalError("INVALID_INPUT", answer.message), key);
			return;
		}
		// Unavailable (CONTAINERS_UNAVAILABLE included) or a full trunk queue.
		errorOutcome(
			work,
			hostEvalError("EVALUATOR_UNAVAILABLE", answer.message),
			key,
		);
	};

	const evaluate = async (work: Work): Promise<void> => {
		const reads = await withBudget(budgetMs, ports().reads(canonicalName()));
		let snapshot: ConfigSnapshot;
		let schema: Schema;
		try {
			[snapshot, schema] = await withBudget(
				budgetMs,
				Promise.all([
					readConfigAt(reads, work.sha),
					// `watch`: ForgeDO pokes this repo after later registry changes,
					// even if nothing was ever applied here.
					ports().schema(repoId(), { watch: true }),
				]),
			);
		} finally {
			reads.close();
		}
		workEpoch = schema.epoch;
		if (schema.epoch > head().epoch_seen) {
			tx(() => setHead({ epoch_seen: schema.epoch }));
		}
		if (snapshot.kind === "unavailable") {
			tx(() => {
				const attempts = head().eval_attempts + 1;
				setHead({ eval_attempts: attempts });
				scheduleEval(now() + backoff(attempts, READ_BACKOFF));
			});
			ports().log("reads were not positive evidence", {
				reason: snapshot.reason,
			});
			return;
		}
		const digest = snapshot.policyDigest;
		const external = work.cause === "external";
		if (
			(external || work.cause === "apply") &&
			core().refSync(trunkRef())?.sha === work.sha
		) {
			// Trunk as last read: an import or a reconciled ref moves it
			// outside the Advance, and `trunkSha` is what an explicit apply
			// (the settings page's button) names. Only while trunk is still
			// there: an Advance that landed since the work was queued already
			// recorded the newer tip, which an apply must not move back.
			tx(() => setHead({ trunk_sha: work.sha }));
		}
		if (external) {
			// A trunk move outside the Advance whose root `*.cue` digest equals
			// the newest row's changes nothing.
			const newest = newestTrunkRow();
			const tipSeq = externalRowSeq(work.sha);
			if (
				newest !== null && newest.policy_digest === digest &&
				newest.status !== "pending" && newest.trunk_seq <= tipSeq
			) {
				tx(() => setHead({ external_due: 0, external_by: null }));
				return;
			}
			if (newest === null && digest === null) {
				// Never configured and still nothing: no row to open.
				tx(() => setHead({ external_due: 0, external_by: null }));
			} else {
				tx(() => openTrunkRowSync(tipSeq, work.sha, digest));
			}
		} else if (work.cause !== "registry") {
			tx(() =>
				openTrunkRowSync(
					work.rowSeq,
					work.sha,
					digest,
					work.cause === "history" ? undefined : principalsOf(head()),
				)
			);
		}
		if (work.cause !== "registry" && work.cause !== "history") {
			tx(() =>
				setHead({
					last_eval_at: now(),
					root_files_json: JSON.stringify(
						snapshot.entries.map((e) => ({ name: e.name, oid: e.oid })),
					),
					legacy_dir: snapshot.legacyDir ? 1 : 0,
				})
			);
		}
		if (snapshot.kind === "invalid") {
			errorOutcome(
				work,
				hostEvalError(
					"INVALID_INPUT",
					`${
						snapshot.path === "" ? "root .cue files" : snapshot.path
					}: ${snapshot.message}`,
				),
				null,
				digest,
			);
			return;
		}
		if (snapshot.kind === "absent") {
			await removal(work, schema);
			return;
		}
		const key = inputKeyOf({
			evaluator: CUE_EVALUATOR_ID,
			schemaKey: schema.schemaKey,
			files: snapshot.files,
		});
		const h = head();
		if (
			key === h.applied_key && h.applied_epoch === schema.epoch &&
			!external
		) {
			if (work.cause === "history") {
				tx(() =>
					resolveTrunkRowSync(work.rowSeq, {
						status: "ok",
						inputKey: key,
						digest,
					})
				);
				return;
			}
			settleApplied(work, key, false, digest);
			return;
		}
		const hit = trunkHit(key, triples(snapshot.files));
		if (hit !== null) {
			const envelope = envelopeOf(hit);
			if (isEvalOk(envelope)) {
				// `{}`: no package tartan among the root files (positive evidence).
				const empty = isRecord(envelope.ok) &&
					Object.keys(envelope.ok).length === 0;
				if (empty) {
					await removal(work, schema, key);
					return;
				}
				await resolvedOutcome(work, key, schema, envelope.ok, false);
			} else {
				errorOutcome(work, envelope, key, digest);
			}
			return;
		}
		await dispatch(work, key, snapshot, schema);
	};

	/**
	 * No Tartan config at the work's commit, on positive evidence: no root
	 * `*.cue` file, or none in package `tartan` (`{}`). The trunk row is
	 * `none`; installations are removed only with a signed landing (or an
	 * explicit apply, or registry work over an applied removal).
	 */
	const removal = async (
		work: Work,
		schema: Pick<Schema, "epoch" | "schemaKey" | "epochBy">,
		evaluatedKey?: string,
	): Promise<void> => {
		const key = evaluatedKey ?? inputKeyOf({
			evaluator: CUE_EVALUATOR_ID,
			schemaKey: schema.schemaKey,
			files: [],
		});
		const h = head();
		if (work.cause === "history") {
			tx(() => resolveTrunkRowSync(work.rowSeq, { status: "none" }));
			return;
		}
		if (h.applied_key === null) {
			tx(() => {
				if (work.cause === "external") {
					const rowSeq = externalRowSeq(work.sha);
					resolveTrunkRowSync(rowSeq, { status: "none" });
					// No Tartan config at the tip and nothing applied: what was in
					// force while the switch was off (none) stays in force.
					if (h.boot_seq === rowSeq) setHead({ boot_seq: null });
				} else {
					resolveTrunkRowSync(work.rowSeq, { status: "none" }, {
						reresolve: work.cause !== "advance",
					});
				}
				setHead({
					...clearPending(),
					status: "unconfigured",
					external_due: 0,
					...registryCleared(workEpoch),
					failure_json: null,
					plan_json: null,
				});
			});
			return;
		}
		const allowed = work.cause === "apply" ||
			(work.cause === "advance" && h.pending_removal_ok === 1) ||
			work.cause === "registry";
		if (!allowed && work.cause === "advance") {
			// A removal without a signed landing goes through needs-apply; repo
			// policy reads "no config" at once.
			const answer = await checkResolved({});
			tx(() => {
				resolveTrunkRowSync(work.rowSeq, { status: "none" });
				setHead({
					...clearPending(),
					status: "needs-apply",
					plan_json: JSON.stringify(answer.plan),
					plan_key: key,
				});
				emit(
					"repo.config.needs-apply",
					{ sha: work.sha, inputKey: key, cause: "removal" },
					`needs-apply:${work.sha}:${key}`,
				);
			});
			return;
		}
		await resolvedOutcome(work, key, schema, {}, true);
	};

	/** ForgeDO's hold for this repo (gate-missing), refreshed on every evaluation pass. */
	const refreshForgeHold = async (): Promise<void> => {
		const state = await ports().forgeState(repoId());
		tx(() => recordForgeHold(state?.holdReason ?? null, state?.holdId));
	};

	const onEval = async (): Promise<void> => {
		if (!live()) return;
		let h = head();
		if (
			h.registry_due === 1 && h.pending_sha === null &&
			h.external_due === 0 && registryWork(h) === null
		) {
			h = tx(() => setHead({ registry_due: 0 }));
		}
		const work = nextWork(h);
		if (work === null) return;
		if (h.unavailable_until !== null && h.unavailable_until > now()) {
			scheduleEval(h.unavailable_until);
			return;
		}
		try {
			// ForgeDO's gate-missing hold travels with every evaluation pass.
			await withBudget(budgetMs, refreshForgeHold());
			await evaluate(work);
		} catch (error) {
			if (error instanceof BudgetExceeded) {
				ports().log("eval budget exceeded; rescheduled", {});
				scheduleEval(now() + 1000);
				return;
			}
			throw error;
		}
		// More work (an external move after a pending one, an older trunk
		// row left pending): run again soon.
		const after = head();
		const more = nextWork(after);
		if (
			more !== null && workId(more) !== workId(work) &&
			(after.unavailable_until === null || after.unavailable_until <= now())
		) {
			scheduleEval(now());
		}
	};

	// -- the apply handler ----------------------------------------------------

	const onApply = async (): Promise<void> => {
		const pending = rows<IntentRow>(
			"SELECT * FROM config_apply_intents WHERE state = 'pending' ORDER BY trunk_seq, epoch",
		);
		for (const intent of pending) {
			const cached = intent.removal === 1 ? null : cacheGet(intent.input_key);
			// Only trunk's own answer is applied.
			if (
				intent.removal === 0 &&
				(cached === null || cached.status !== "ok" || cached.origin !== "trunk")
			) {
				tx(() => {
					sql.exec(
						"UPDATE config_apply_intents SET state = 'refused', answer_json = ? WHERE trunk_seq = ? AND epoch = ?",
						JSON.stringify({ reason: "cache-evicted" }),
						intent.trunk_seq,
						intent.epoch,
					);
					scheduleEval();
				});
				continue;
			}
			// The apply is fenced and idempotent: a slow ForgeDO never stalls
			// this alarm (co-due timers of other modules), it retries.
			let answer: Awaited<ReturnType<RepoConfigModulePorts["apply"]>>;
			try {
				answer = await withBudget(
					budgetMs,
					ports().apply(repoId(), {
						trunkSeq: intent.trunk_seq,
						epoch: intent.epoch,
						sha: intent.sha,
						inputKey: intent.input_key,
						schemaKey: intent.schema_key,
						resolved: intent.removal === 1
							? {}
							: parse<unknown>(cached!.resolved_json, null),
						principals: parse<string[]>(intent.principals_json, []),
						provenance: {
							firstSha: cached?.first_sha ?? intent.sha,
							...(cached?.first_lane ? { firstLane: cached.first_lane } : {}),
							evaluator: cached?.evaluator ?? CUE_EVALUATOR_ID,
							cueVersion: cached?.cue_version ?? null,
						},
						...(intent.explicit === 1 ? { explicit: true } : {}),
						...(intent.removal === 1 ? { removal: true } : {}),
					}),
				);
			} catch (error) {
				if (error instanceof BudgetExceeded) {
					ports().log("apply budget exceeded; retrying", {
						trunkSeq: intent.trunk_seq,
					});
					soon("apply", now() + 1000);
					return;
				}
				// An archived repo is read-only: its intents end refused rather
				// than retrying on every timer pass.
				if (fromRpcError(error).reason !== "archived") throw error;
				tx(() =>
					sql.exec(
						"UPDATE config_apply_intents SET state = 'refused', answer_json = ? WHERE trunk_seq = ? AND epoch = ?",
						JSON.stringify({ reason: "archived" }),
						intent.trunk_seq,
						intent.epoch,
					)
				);
				continue;
			}
			tx(() => {
				recordAnswer(intent, answer);
				// The answer may end the work in hand (a resolved pending head):
				// what was queued behind it (an older trunk row, registry work)
				// runs next.
				if (nextWork(head()) !== null) scheduleEval();
			});
		}
	};

	const recordAnswer = (
		intent: IntentRow,
		answer: Awaited<ReturnType<RepoConfigModulePorts["apply"]>>,
	): void => {
		const h = head();
		const cause: Work["cause"] = intent.cause ??
			(intent.explicit === 1
				? "apply"
				: intent.row_seq === null
				? "registry"
				: "advance");
		const registry = cause === "registry";
		// Registry work that re-applied the applied config (needs-apply, or
		// trunk's row still pending) resolves nothing: the head keeps its
		// state and plan.
		const reapplyOnly = registry &&
			(intent.row_seq === null || h.status === "needs-apply" ||
				h.external_due === 1);
		const done = (state: "done" | "refused") =>
			sql.exec(
				"UPDATE config_apply_intents SET state = ?, attempts = attempts + 1, answer_json = ? WHERE trunk_seq = ? AND epoch = ?",
				state,
				JSON.stringify(answer).slice(0, 8192),
				intent.trunk_seq,
				intent.epoch,
			);
		const adopt = (state: NonNullable<typeof answer.state>) =>
			setHead({
				applied_seq: state.appliedSeq,
				applied_epoch: state.appliedEpoch,
				applied_sha: state.appliedSha,
				applied_key: state.appliedKey,
				applied_principals_json: JSON.stringify(state.principals),
				applied_at: state.updatedAt,
				...forgeHoldPatch(head(), state.holdReason, state.holdId),
				obs_seq: Math.max(head().obs_seq, state.appliedSeq),
			});
		const resolveRow = (
			result: Parameters<typeof resolveTrunkRowSync>[1],
		) =>
			resolveTrunkRowSync(intent.row_seq, result, {
				reresolve: registry || cause === "apply",
			});
		const okRow = () =>
			resolveRow(
				intent.removal === 1
					? { status: "none" }
					: { status: "ok", inputKey: intent.input_key },
			);
		if (answer.kind === "applied" || answer.kind === "noop") {
			done("done");
			adopt(answer.state);
			okRow();
			const resolves = !reapplyOnly &&
				answer.state.appliedKey === intent.input_key &&
				(h.pending_sha === null || h.pending_key === intent.input_key);
			setHead({
				...(resolves
					? {
						...clearPending(),
						status: "current" as const,
						failure_json: null,
						plan_json: null,
					}
					: {}),
				// A Maintainer's apply makes the unsigned boot row policy.
				...(intent.explicit === 1 && intent.row_seq !== null &&
						head().boot_seq === intent.row_seq
					? { boot_seq: null }
					: {}),
				...registryCleared(intent.epoch),
				...(intent.explicit === 1 ? { external_due: 0 } : {}),
			});
			if (answer.kind === "applied") {
				emit(
					"repo.config.applied",
					{
						sha: intent.sha,
						inputKey: intent.input_key,
						trunkSeq: intent.trunk_seq,
						epoch: intent.epoch,
						installed: answer.changes.installed,
						updated: answer.changes.updated,
						removed: answer.changes.removed,
						overlays: answer.changes.overlays,
						principals: parse<string[]>(intent.principals_json, []),
						...(intent.explicit === 1 ? { explicit: true } : {}),
						...(intent.removal === 1 ? { removal: true } : {}),
						...(registry ? { cause: "registry" } : {}),
					},
					`applied:${intent.trunk_seq}:${intent.epoch}`,
				);
			}
			pruneCache();
			return;
		}
		if (answer.kind === "refused") {
			done("refused");
			if (answer.state !== null) adopt(answer.state);
			if (answer.reason === "schema-changed") {
				// Re-evaluate under the new schema; a pending head stays held.
				setHead({
					epoch_seen: Math.max(h.epoch_seen, answer.epoch),
					...(h.pending_sha === null
						? {
							registry_due: 1,
							status: h.status === "current" ? "stale" : h.status,
						}
						: {}),
				});
				scheduleEval();
				return;
			}
			// An older or conflicting fence: our trunk position is behind
			// ForgeDO's (a restored DO), or an equal fence carried another key;
			// move past it and re-evaluate (registry work then takes a fence
			// position above ForgeDO's, so this happens at most once).
			const floor = Math.max(head().obs_seq, answer.state?.appliedSeq ?? 0) + 1;
			setHead({
				obs_seq: floor,
				...(h.pending_sha !== null ? { pending_seq: floor } : {}),
			});
			if (answer.state?.appliedKey === intent.input_key) {
				okRow();
				setHead({
					...registryCleared(intent.epoch),
					...(reapplyOnly ? {} : { ...clearPending(), status: "current" }),
				});
				return;
			}
			scheduleEval();
			return;
		}
		// Denied: last-good installations stay, lands are not held. A shape or
		// policy_key denial rejects the config as a whole (its trunk row is
		// `error`, repo policy reads last good); any other denial concerns
		// installations only (the row is `ok`).
		const denied = answer as Extract<typeof answer, { kind: "denied" }>;
		done("refused");
		if (denied.state !== null) adopt(denied.state);
		const bad = rowDenials(denied.denials);
		if (bad.length > 0) {
			resolveRow({
				status: "error",
				inputKey: intent.input_key,
				code: bad[0].code,
				message: bad.map((d) => d.message).join("; "),
			});
		} else okRow();
		const failure: Failure = {
			code: denied.denials[0]?.code ?? "denied",
			message: denied.denials.map((d) => d.message).join("; ").slice(0, 2000),
			issues: [],
			denials: denied.denials,
		};
		if (intent.explicit === 1) {
			setHead({
				...clearPending(),
				status: "needs-apply",
				failure_json: JSON.stringify(failure),
			});
			return;
		}
		if (reapplyOnly) {
			setHead({
				...registryCleared(intent.epoch),
				failure_json: JSON.stringify(failure),
			});
			return;
		}
		setHead({
			...clearPending(),
			status: "failed",
			...registryCleared(intent.epoch),
			failure_json: JSON.stringify(failure),
		});
		emit(
			"repo.config.failed",
			{
				sha: intent.sha,
				inputKey: intent.input_key,
				code: failure.code,
				message: failure.message,
			},
			`failed:${intent.trunk_seq}:${intent.epoch}`,
		);
	};

	// -- the jobs watchdog ----------------------------------------------------

	const onJobs = (): void => {
		const t = now();
		const due = rows<JobRow>(
			"SELECT * FROM config_jobs WHERE deadline_at IS NOT NULL AND deadline_at <= ?",
			t,
		);
		let trunk = false;
		let preview = false;
		tx(() => {
			for (const job of due) {
				if (job.family === "preview") {
					sql.exec(
						"DELETE FROM config_jobs WHERE input_key = ? AND family = 'preview'",
						job.input_key,
					);
					sql.exec(
						"UPDATE config_previews SET status = 'unavailable', updated_at = ? WHERE input_key = ? AND status = 'evaluating'",
						t,
						job.input_key,
					);
					preview = true;
				} else {
					// The eval handler re-dispatches (attempts + 1) or gives up.
					sql.exec(
						"UPDATE config_jobs SET deadline_at = NULL WHERE input_key = ? AND family = 'trunk'",
						job.input_key,
					);
					trunk = true;
				}
			}
			const next = one<{ at: number | null }>(
				"SELECT MIN(deadline_at) AS at FROM config_jobs WHERE deadline_at IS NOT NULL",
			)?.at;
			if (typeof next === "number") soon("jobs", next);
		});
		if (trunk) {
			scheduleEval();
			// A preview waiting on that trunk job runs its own evaluation now.
			soon("previews", now());
		}
		if (preview) soon("previews", now());
	};

	// -- previews -------------------------------------------------------------

	const previewDto = (row: PreviewRow): RepoConfigPreviewDto => {
		const result = parse<{
			issues?: EvalIssue[];
			denials?: RepoConfigDenial[];
			plan?: RepoConfigPlanLine[];
			code?: string;
			message?: string;
			evaluatedAt?: number;
			policyDigest?: string | null;
		}>(row.result_json, {});
		const signoff = one<SignoffRow>(
			"SELECT * FROM policy_signoffs WHERE lane_id = ? AND head = ?",
			row.lane_id,
			row.head_sha,
		);
		const touch = policyTouchSync(row.lane_id, row.head_sha);
		return {
			laneId: row.lane_id,
			head: row.head_sha,
			...(row.input_key === null ? {} : { inputKey: row.input_key }),
			status: row.status === "queued" ? "evaluating" : row.status,
			policyTouched: touch !== "clean",
			...(result.policyDigest === undefined
				? {}
				: { policyDigest: result.policyDigest }),
			...(result.code === undefined ? {} : { code: result.code }),
			...(result.message === undefined ? {} : { message: result.message }),
			issues: result.issues ?? [],
			denials: result.denials ?? [],
			plan: result.plan ?? [],
			...(result.evaluatedAt === undefined
				? {}
				: { evaluatedAt: result.evaluatedAt }),
			...(signoff === null ? {} : { signoff: signoffDto(signoff) }),
		};
	};

	const setPreview = (
		laneId: string,
		patch: Partial<Omit<PreviewRow, "lane_id">>,
	): void => {
		const entries = Object.entries({ ...patch, updated_at: now() });
		sql.exec(
			`UPDATE config_previews SET ${
				entries.map(([k]) => `${k} = ?`).join(", ")
			} WHERE lane_id = ?`,
			...entries.map(([, v]) => v ?? null),
			laneId,
		);
	};

	const finishPreview = async (
		row: PreviewRow,
		status: RepoConfigPreviewState,
		result: Record<string, unknown>,
	): Promise<void> => {
		tx(() => {
			setPreview(row.lane_id, {
				status,
				result_json: JSON.stringify({ ...result, evaluatedAt: now() }),
			});
			emit(
				"repo.config.previewed",
				{
					laneId: row.lane_id,
					head: row.head_sha,
					...(row.input_key === null ? {} : { inputKey: row.input_key }),
					status,
				},
				`previewed:${row.lane_id}:${row.head_sha}:${
					row.input_key ?? ""
				}:${status}`,
			);
			if (status === "rate_limited" || status === "unavailable") {
				// Queued again later (onPreviews), with backoff.
				soon(
					"previews",
					now() + backoff(row.attempts + 1, PREVIEW_BACKOFF),
				);
			}
		});
		try {
			await ports().notify(row.requested_by, {
				source: "kernel",
				sourceLabel: "repo config",
				repoId: repoId(),
				laneId: row.lane_id,
				kind: "system",
				severity: status === "ok" || status === "clean" ? "info" : "warn",
				text: `repo config preview of ${row.lane_id} at ${
					row.head_sha.slice(0, 8)
				}: ${status}`,
				dedupeKey: `repoconfig:${row.lane_id}:${row.head_sha}:${status}`,
			});
		} catch (error) {
			ports().log("preview notice failed", {
				error: errorText(error).slice(0, 200),
			});
		}
	};

	/**
	 * A preview's plan: the registry's installation lines plus the repo-policy
	 * lines against the trunk config in force at the trunk tip (K13: the
	 * lane's config is shown, never read as policy).
	 */
	const previewPlan = (
		resolved: unknown,
		installationLines: readonly RepoConfigPlanLine[],
		schema: Pick<Schema, "entries">,
	): RepoConfigPlanLine[] => {
		const at = policyAtSync(trunkTipSeq());
		const before = at.state === "ok"
			? at.resolved
			: at.state === "pending" && at.lastGood?.state === "ok"
			? at.lastGood.resolved
			: {};
		return [
			...installationLines,
			...policyPlan({
				before,
				after: resolved,
				policyKeys: policyKeysOf(schema),
			}),
		];
	};

	const runPreview = async (row: PreviewRow): Promise<void> => {
		const lane = core().laneSync(row.lane_id);
		if (lane === null) {
			tx(() =>
				sql.exec("DELETE FROM config_previews WHERE lane_id = ?", row.lane_id)
			);
			return;
		}
		const headSha = lane.head_sha ?? lane.base_sha;
		if (headSha !== row.head_sha) {
			tx(() =>
				setPreview(row.lane_id, {
					head_sha: headSha,
					input_key: null,
					status: "queued",
					result_json: null,
					attempts: 0,
				})
			);
			row = {
				...row,
				head_sha: headSha,
				input_key: null,
				status: "queued",
				attempts: 0,
			};
		}
		const reads = await ports().reads(laneRepoName(row.lane_id));
		let snapshot: ConfigSnapshot;
		let schema: Schema;
		try {
			[snapshot, schema] = await Promise.all([
				readConfigAt(reads, row.head_sha),
				ports().schema(repoId()),
			]);
		} finally {
			reads.close();
		}
		if (snapshot.kind === "unavailable") {
			soon("previews", now() + PREVIEW_RETRY_MS);
			return;
		}
		const policyDigest = snapshot.policyDigest;
		if (snapshot.kind === "invalid") {
			await finishPreview(row, "error", {
				code: "INVALID_INPUT",
				message: `${
					snapshot.path === "" ? "root .cue files" : snapshot.path
				}: ${snapshot.message}`,
				policyDigest,
			});
			return;
		}
		const files = snapshot.kind === "files" ? snapshot.files : [];
		const key = inputKeyOf({
			evaluator: CUE_EVALUATOR_ID,
			schemaKey: schema.schemaKey,
			files,
		});
		const finishResolved = async (resolved: unknown) => {
			const answer = await checkResolved(resolved);
			await finishPreview(row, answer.denials.length > 0 ? "denied" : "ok", {
				plan: previewPlan(resolved, answer.plan, schema),
				denials: answer.denials,
				policyDigest,
			});
		};
		if (snapshot.kind === "absent") {
			row = { ...row, input_key: key };
			tx(() => setPreview(row.lane_id, { input_key: key }));
			await finishResolved({});
			return;
		}
		const hit = previewHit(key);
		if (hit !== null) {
			row = { ...row, input_key: key };
			tx(() => setPreview(row.lane_id, { input_key: key }));
			const envelope = envelopeOf(hit);
			if (!isEvalOk(envelope)) {
				await finishPreview(row, "error", {
					code: envelope.error.code,
					message: envelope.error.message,
					issues: envelope.issues,
					policyDigest,
				});
				return;
			}
			await finishResolved(envelope.ok);
			return;
		}
		// A preview joins any live job of the same key (its own, or trunk's:
		// a trunk result answers previews too), and never re-marks a trunk job.
		const live = one<{ n: number }>(
			"SELECT COUNT(*) AS n FROM config_jobs WHERE input_key = ? AND deadline_at > ?",
			key,
			now(),
		)?.n ?? 0;
		if (live > 0) {
			tx(() =>
				setPreview(row.lane_id, { input_key: key, status: "evaluating" })
			);
			return;
		}
		const sandbox = cuePreviewSandboxName(
			previewSandboxIndex(row.requested_by),
		);
		let answer;
		try {
			answer = await ports().submit(sandbox, {
				class: "preview",
				principal: row.requested_by,
				laneId: row.lane_id,
				sink: { kind: "repo", repoId: repoId() },
				request: {
					version: CUE_EVAL_CONTRACT,
					evaluator: CUE_EVALUATOR_ID,
					inputKey: key,
					files: requestFiles(schema, snapshot),
					limits: DEFAULT_EVAL_LIMITS,
				},
			});
		} catch (error) {
			answer = {
				accepted: false as const,
				reason: "unavailable" as const,
				message: errorText(error).slice(0, 300),
			};
		}
		if (!answer.accepted) {
			row = { ...row, input_key: key };
			tx(() => setPreview(row.lane_id, { input_key: key }));
			await finishPreview(
				row,
				answer.reason === "rate_limited" ? "rate_limited" : "unavailable",
				{ code: answer.reason, message: answer.message, policyDigest },
			);
			return;
		}
		const deadline = now() + deadlineAfter(answer);
		tx(() => {
			sql.exec(
				`INSERT INTO config_jobs (input_key, family, class, sha, lane_id, schema_key, epoch, files_json,
				   sandbox, principal, dispatched_at, deadline_at, attempts, next_at)
				 VALUES (?, 'preview', 'preview', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)
				 ON CONFLICT (input_key, family) DO UPDATE SET sha = excluded.sha, lane_id = excluded.lane_id,
				   schema_key = excluded.schema_key, epoch = excluded.epoch, files_json = excluded.files_json,
				   sandbox = excluded.sandbox, principal = excluded.principal,
				   dispatched_at = excluded.dispatched_at, deadline_at = excluded.deadline_at,
				   attempts = attempts + 1`,
				key,
				row.head_sha,
				row.lane_id,
				schema.schemaKey,
				schema.epoch,
				JSON.stringify(triples(snapshot.files)),
				sandbox,
				row.requested_by,
				now(),
				deadline,
			);
			setPreview(row.lane_id, { input_key: key, status: "evaluating" });
			soon("jobs", deadline);
		});
	};

	/**
	 * Rate-limited and unavailable previews of a lane's current head are
	 * queued again with backoff (at most `PREVIEW_RETRIES` times); returns
	 * when the next one is due, or null.
	 */
	const requeuePreviews = (): number | null => {
		const t = now();
		let next: number | null = null;
		const waiting = rows<PreviewRow>(
			`SELECT * FROM config_previews WHERE status IN ('rate_limited','unavailable')
			 AND attempts < ? ORDER BY updated_at LIMIT 50`,
			PREVIEW_RETRIES,
		);
		for (const row of waiting) {
			const due = row.updated_at + backoff(row.attempts + 1, PREVIEW_BACKOFF);
			if (due > t) {
				next = next === null ? due : Math.min(next, due);
				continue;
			}
			sql.exec(
				`UPDATE config_previews SET status = 'queued', attempts = attempts + 1, updated_at = ?
				 WHERE lane_id = ? AND head_sha = ?`,
				t,
				row.lane_id,
				row.head_sha,
			);
		}
		return next;
	};

	const onPreviews = async (): Promise<void> => {
		if (!live()) return;
		const retryAt = tx(requeuePreviews);
		const queued = rows<PreviewRow>(
			`SELECT * FROM config_previews WHERE status IN ('queued','evaluating')
			 ORDER BY updated_at LIMIT ?`,
			PREVIEWS_PER_PASS,
		);
		// A pass gives previews at most a few seconds of this alarm, so a
		// preview flood never delays the trunk work or another module's
		// timers by much; the rest runs in the next pass.
		const started = now();
		for (const row of queued) {
			if (now() - started > budgetMs * 2) {
				soon("previews", now() + 1000);
				break;
			}
			if (row.status === "evaluating" && row.input_key !== null) {
				// Waiting for a live job of that key (its own or trunk's) unless
				// the result is cached by now; with no live job it runs again.
				const live = one<{ n: number }>(
					"SELECT COUNT(*) AS n FROM config_jobs WHERE input_key = ? AND deadline_at > ?",
					row.input_key,
					now(),
				)?.n ?? 0;
				if (cacheGet(row.input_key) === null && live > 0) continue;
			}
			try {
				await withBudget(budgetMs * 2, runPreview(row));
			} catch (error) {
				ports().log("preview failed", {
					lane: row.lane_id,
					error: errorText(error).slice(0, 200),
				});
				soon("previews", now() + PREVIEW_RETRY_MS);
			}
		}
		const left = one<{ n: number }>(
			"SELECT COUNT(*) AS n FROM config_previews WHERE status = 'queued'",
		)?.n ?? 0;
		if (left > 0) soon("previews", now() + 1000);
		if (retryAt !== null) soon("previews", retryAt);
	};

	// -- sign-offs ------------------------------------------------------------

	const signoffDto = (row: SignoffRow): PolicySignoffDto => ({
		laneId: row.lane_id,
		head: row.head,
		policyDigest: row.policy_digest,
		signedBy: row.signed_by,
		eventId: row.event_id,
		at: row.at,
		...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
	});

	const signOff = async (
		laneId: string,
		raw: unknown,
		signer: string,
	): Promise<PolicySignoffDto> => {
		const parsed = PolicySignoffRequestSchema.safeParse(raw);
		if (!parsed.success) {
			throw invalid("a sign-off names {head, policyDigest}");
		}
		if (!isIdOf("user", signer)) {
			throw invalid("a policy sign-off is a person's act");
		}
		const input = parsed.data;
		const lane = core().laneSync(laneId);
		if (lane === null) throw notFound(`unknown lane: ${laneId}`);
		if (lane.head_sha !== input.head) {
			throw conflict(
				`head-moved: the lane is at ${
					lane.head_sha ?? "nothing"
				}; review the newer push`,
				{ code: "head-moved" },
			);
		}
		// The kernel re-reads the head by SHA, so a stale page cannot sign a
		// newer push (K13.3).
		const reads = await ports().reads(laneRepoName(laneId));
		let digest: string | null | undefined;
		try {
			digest = await readPolicyDigest(reads, input.head);
		} finally {
			reads.close();
		}
		if (digest === undefined) {
			throw unavailable("the lane head could not be read; retry");
		}
		if (digest !== input.policyDigest) {
			throw conflict(
				`policy-digest: the root .cue files at ${input.head.slice(0, 8)} are ${
					digest ?? "none"
				}, not ${input.policyDigest ?? "none"}; reload and review again`,
				{ code: "policy-digest" },
			);
		}
		return tx(() => {
			const existing = one<SignoffRow>(
				"SELECT * FROM policy_signoffs WHERE lane_id = ? AND head = ?",
				laneId,
				input.head,
			);
			if (existing !== null && existing.revoked_at === null) {
				return signoffDto(existing);
			}
			const preview = one<PreviewRow>(
				"SELECT * FROM config_previews WHERE lane_id = ? AND head_sha = ?",
				laneId,
				input.head,
			);
			const at = now();
			const eventId = emit(
				"repo.policy.approved",
				{
					laneId,
					head: input.head,
					policyDigest: digest,
					...(preview?.input_key ? { inputKey: preview.input_key } : {}),
				},
				`approved:${laneId}:${input.head}:${at}`,
				actorOf(signer),
			);
			sql.exec(
				`INSERT INTO policy_signoffs (lane_id, head, event_id, signed_by, policy_digest, revoked_at, at)
				 VALUES (?, ?, ?, ?, ?, NULL, ?)
				 ON CONFLICT (lane_id, head) DO UPDATE SET event_id = excluded.event_id,
				   signed_by = excluded.signed_by, policy_digest = excluded.policy_digest,
				   revoked_at = NULL, at = excluded.at`,
				laneId,
				input.head,
				eventId,
				signer,
				digest,
				at,
			);
			return signoffDto(
				one<SignoffRow>(
					"SELECT * FROM policy_signoffs WHERE lane_id = ? AND head = ?",
					laneId,
					input.head,
				)!,
			);
		});
	};

	const revokeSignOff = (laneId: string, headSha: string, by: string): void =>
		tx(() => {
			const row = one<SignoffRow>(
				"SELECT * FROM policy_signoffs WHERE lane_id = ? AND head = ?",
				laneId,
				headSha,
			);
			if (row === null || row.revoked_at !== null) {
				throw notFound("no sign-off of that head");
			}
			const t = now();
			sql.exec(
				"UPDATE policy_signoffs SET revoked_at = ? WHERE lane_id = ? AND head = ?",
				t,
				laneId,
				headSha,
			);
			emit(
				"repo.policy.revoked",
				{ laneId, head: headSha, approval: row.event_id },
				`revoked:${laneId}:${headSha}:${t}`,
				actorOf(by),
			);
		});

	// -- internal -------------------------------------------------------------

	const policyTouchSync = (laneId: string, headSha: string): PolicyTouch => {
		const row = one<{ touched: number }>(
			"SELECT touched FROM config_lane_paths WHERE lane_id = ? AND head = ?",
			laneId,
			headSha,
		);
		return row === null ? "unknown" : row.touched === 1 ? "touched" : "clean";
	};

	const signoffSync = (
		laneId: string,
		headSha: string,
	): PolicySignoffRef | null => {
		const row = one<SignoffRow>(
			"SELECT * FROM policy_signoffs WHERE lane_id = ? AND head = ? AND revoked_at IS NULL",
			laneId,
			headSha,
		);
		return row === null ? null : {
			eventId: row.event_id,
			signedBy: row.signed_by,
			policyDigest: row.policy_digest,
		};
	};

	/**
	 * K13.1. `forgeHold`: ForgeDO's hold read just now (the land path reads
	 * it through `registry.landContext` in the same step), with its
	 * generation; without it, the copy the last evaluation pass saw. An
	 * Owner's keep-last-good releases a gate-missing hold only for the
	 * generation present when it was set. A hold that lasts
	 * `HOLD_NOTICE_MS` is told to the repo's Owners once (K9: a long hold
	 * delays and notifies; only an Owner can clear a gate-missing hold).
	 */
	const holdSync = (forgeHold?: string | null, forgeHoldId?: number): {
		held: boolean;
		reason?: "pending" | "gate-missing";
	} => {
		if (!live()) return { held: false };
		const h = forgeHold === undefined
			? head()
			: recordForgeHold(forgeHold, forgeHoldId);
		const out: { held: boolean; reason?: "pending" | "gate-missing" } =
			h.hold === 1
				? { held: true, reason: "pending" }
				: h.forge_hold !== null && h.override_gate !== h.forge_hold_id
				? { held: true, reason: "gate-missing" }
				: { held: false };
		trackHeld(h, out);
		return out;
	};

	/** The hold a notice is about: its reason and its generation. */
	const noticeKey = (
		h: HeadRow,
		reason: "pending" | "gate-missing",
	): string =>
		reason === "gate-missing"
			? `gate-missing:${h.forge_hold_id}`
			: `pending:${h.pending_row_seq ?? h.pending_seq ?? 0}`;

	const trackHeld = (
		h: HeadRow,
		out: { held: boolean; reason?: "pending" | "gate-missing" },
	): void => {
		if (!out.held) {
			if (h.held_since !== null) {
				setHead({ held_since: null, hold_noticed: null });
			}
			return;
		}
		if (h.held_since === null) {
			setHead({ held_since: now() });
			return;
		}
		if (
			now() - h.held_since >= HOLD_NOTICE_MS &&
			h.hold_noticed !== noticeKey(h, out.reason!)
		) {
			soon("notice", now());
		}
	};

	const onAdvanceSync = (input: {
		readonly sha: string;
		readonly changes: readonly AdvanceLanded[];
	}): void => {
		if (!live()) return;
		const h = head();
		const seq = h.obs_seq + 1;
		const touching = input.changes.filter((c) =>
			c.paths === null || c.capped || c.paths.some(isPolicyPath)
		);
		if (touching.length === 0) {
			setHead({ obs_seq: seq, trunk_sha: input.sha });
			return;
		}
		const signers = [
			...new Set(
				touching.flatMap((c) => {
					const s = signoffSync(c.laneId, c.head);
					return s === null ? [] : [s.signedBy];
				}),
			),
		];
		// The trunk row sits at the (last) touching change's commit: commits
		// from it onward read the new config (K13.2 keeps it to one per batch).
		const positioned = touching
			.map((c) => ({ c, seq: trunkSeqOf(c.commit) }))
			.filter((x): x is { c: AdvanceLanded; seq: number } => x.seq !== null)
			.sort((a, b) => a.seq - b.seq);
		const last = positioned[positioned.length - 1];
		const rowSha = last?.c.commit ?? input.sha;
		const rowSeq = last?.seq ?? trunkSeqOf(input.sha) ?? trunkTipSeq();
		// A still-pending older row is not abandoned: `history` work
		// resolves it once this one is (bases between the two read it).
		openTrunkRowSync(rowSeq, rowSha, undefined, signers);
		// A signed Advance at the tip is the same authority as an explicit
		// apply: the signers approved the full root `*.cue` set at that head
		// and K13.2 bound the candidate's digest to it. It supersedes
		// `needs-apply`: lands wait and it applies. Only an
		// unsigned touch keeps `needs-apply` (installations wait for a
		// Maintainer; repo policy follows the new row).
		const signed = touching.every((c) =>
			signoffSync(c.laneId, c.head) !== null
		);
		const needsApply = h.status === "needs-apply" && !signed;
		setHead({
			obs_seq: seq,
			trunk_sha: input.sha,
			pending_seq: seq,
			pending_sha: rowSha,
			pending_key: null,
			pending_cause: "advance",
			pending_row_seq: rowSeq,
			pending_principals_json: JSON.stringify(signers),
			pending_removal_ok: signers.length > 0 ? 1 : 0,
			hold: needsApply ? 0 : 1,
			// The signed row owns its position: an unsigned boot row there ends.
			...(h.boot_seq === rowSeq ? { boot_seq: null } : {}),
			// A keep-last-good covered the previous resolution only; its part
			// covering ForgeDO's gate-missing hold stays.
			override_pending: 0,
			...(h.override_gate === 1 ? {} : { override_by: null }),
			...(needsApply ? {} : { status: "pending" as const }),
			eval_attempts: 0,
			unavailable_until: null,
		});
		emit(
			"repo.config.evaluating",
			{ sha: rowSha, cause: "advance", trunkSeq: seq },
			`evaluating:${seq}`,
		);
		scheduleEval();
	};

	const observeSync = (event: Envelope): void => {
		try {
			const data = (typeof event.data === "object" && event.data !== null
				? event.data
				: {}) as Record<string, unknown>;
			switch (event.type) {
				case "push.diffed": {
					const target = data.target;
					const after = data.after;
					if (typeof target !== "string" || !isIdOf("lane", target)) {
						return;
					}
					if (typeof after !== "string" || !isSha(after)) {
						return;
					}
					// Nothing reads it while the switch is off; a lane
					// pushed then reads `unknown`, which the land check backfills.
					if (!live()) {
						return;
					}
					const paths = Array.isArray(data.paths) ? data.paths : [];
					const touched = data.truncated === true ||
						data.rangeTruncated === true ||
						paths.some((p) =>
							typeof p === "string" && isPolicyPath(p)
						);
					sql.exec(
						`INSERT INTO config_lane_paths (lane_id, head, touched, at) VALUES (?, ?, ?, ?)
						 ON CONFLICT (lane_id, head) DO UPDATE SET touched = MAX(touched, excluded.touched), at = excluded.at`,
						target,
						after,
						touched ? 1 : 0,
						now(),
					);
					// Only the lane's current head is ever read (land.submit lands
					// the lane head): one row per lane, not one per push.
					sql.exec(
						"DELETE FROM config_lane_paths WHERE lane_id = ? AND head <> ?",
						target,
						after,
					);
					if (touched) {
						sql.exec(
							`INSERT INTO config_previews (lane_id, head_sha, input_key, status, requested_by, result_json,
							   attempts, updated_at)
							 VALUES (?, ?, NULL, 'queued', ?, NULL, 0, ?)
							 ON CONFLICT (lane_id) DO UPDATE SET head_sha = excluded.head_sha, input_key = NULL,
							   status = 'queued', requested_by = excluded.requested_by, result_json = NULL,
							   attempts = 0, updated_at = excluded.updated_at
							 WHERE config_previews.head_sha <> excluded.head_sha`,
							target,
							after,
							core().laneSync(target)?.owner_principal ?? event.actor.id,
							now(),
						);
						soon("previews", now());
					}
					return;
				}
				case "repo.created":
				case "repo.imported":
					markExternal(event.type);
					return;
				case "ref.acknowledged": {
					const refs = Array.isArray(data.refs) ? data.refs : [];
					if (data.laneId === undefined && refs.includes(trunkRef())) {
						markExternal("ref.acknowledged");
					}
					return;
				}
				case "ref.reconciled":
					if (data.ref === trunkRef() && data.matched === false) {
						markExternal("ref.reconciled");
					}
					return;
				default:
					return;
			}
		} catch (error) {
			// Never fail an append; a missing row only makes a land check stricter.
			ports().log("observe failed", { error: errorText(error).slice(0, 200) });
		}
	};

	const markExternal = (cause: ExternalCause): void => {
		if (!live()) return;
		const h = head();
		if (cause === "repo.imported") {
			// An import re-seeds `trunk_commits` (seq ≤ 0): the old history's
			// positions no longer name the same commits. The imported tip's
			// row opens `pending` at once, so readers wait for its config
			// instead of reading "no config" until the evaluation runs.
			sql.exec("DELETE FROM config_trunk");
			setHead({ trunk_pruned_seq: null, boot_seq: null });
			const tip = core().refSync(trunkRef())?.sha ?? null;
			const tipSeq = tip === null ? null : trunkSeqOf(tip);
			if (tip !== null && tipSeq !== null) openTrunkRowSync(tipSeq, tip);
		}
		setHead({ obs_seq: h.obs_seq + 1, external_due: 1, external_cause: cause });
		scheduleEval();
	};

	const internal: RepoConfigInternal = {
		enabledSync: live,
		onAdvanceSync,
		observeSync,
		policyTouchSync,
		signoffSync,
		policyAtSync,
		holdSync,
	};

	// -- facade ---------------------------------------------------------------

	const headDto = (): RepoConfigHeadDto => {
		const h = head();
		const hold = holdSync();
		const failure = parse<RepoConfigHeadDto["failure"] | null>(
			h.failure_json,
			null,
		);
		return {
			repoId: repoId(),
			enabled: enabled(),
			status: h.status,
			held: hold.held,
			...(hold.reason === undefined ? {} : { holdReason: hold.reason }),
			...(h.override_by === null ? {} : { keptLastGoodBy: h.override_by }),
			evaluator: CUE_EVALUATOR_ID,
			...(h.cue_version === null ? {} : { cueVersion: h.cue_version }),
			...(h.trunk_sha === null ? {} : { trunkSha: h.trunk_sha }),
			...(h.pending_sha === null ? {} : { pendingSha: h.pending_sha }),
			...(h.pending_key === null ? {} : { pendingKey: h.pending_key }),
			...(h.applied_sha === null ? {} : { appliedSha: h.applied_sha }),
			...(h.applied_key === null ? {} : { appliedKey: h.applied_key }),
			...(h.applied_epoch === null ? {} : { appliedEpoch: h.applied_epoch }),
			...(h.applied_seq === null ? {} : { appliedSeq: h.applied_seq }),
			...(h.applied_at === null ? {} : { appliedAt: h.applied_at }),
			appliedBy: parse<string[]>(h.applied_principals_json, []),
			...(h.last_eval_at === null ? {} : { lastEvaluatedAt: h.last_eval_at }),
			...(failure === null ? {} : { failure }),
			plan: parse<RepoConfigPlanLine[]>(h.plan_json, []),
			policy: policyDto(),
			rootFiles: parse<{ name: string; oid: string }[]>(h.root_files_json, []),
			legacyDir: h.legacy_dir === 1,
			updatedAt: h.updated_at,
		};
	};

	const evalDto = (row: EvalRow): RepoConfigEvalDto => {
		const envelope = envelopeOf(row);
		return {
			inputKey: row.input_key,
			evaluator: row.evaluator,
			cueVersion: row.cue_version,
			origin: row.origin,
			status: row.status,
			...(isEvalOk(envelope)
				? { resolved: envelope.ok }
				: { code: envelope.error.code, message: envelope.error.message }),
			issues: envelope.issues,
			files: parse<FileTriple[]>(row.files_json, []).map(([name, oid]) => ({
				name,
				oid,
			})),
			firstSha: row.first_sha,
			...(row.first_lane === null ? {} : { firstLane: row.first_lane }),
			finishedAt: row.finished_at,
		};
	};

	const requireEnabled = (): void => {
		if (!live()) throw invalid("repository config is off on this forge");
	};

	/**
	 * The sandbox sink. `origin` is the answering sandbox's role: a preview's
	 * result fills only the preview job of that key (it never resolves trunk's
	 * job, and never overwrites a trunk-origin cache entry); without it (an
	 * older sandbox) a preview job of the key, if any, is assumed.
	 */
	const cueResult = (
		inputKey: string,
		raw: EvalResponse,
		origin?: JobFamily,
	): void => {
		const envelope = parseEvalResponse(raw);
		tx(() => {
			const family: JobFamily = origin ??
				(one<{ n: number }>(
						"SELECT COUNT(*) AS n FROM config_jobs WHERE input_key = ? AND family = 'preview'",
						inputKey,
					)?.n
					? "preview"
					: "trunk");
			const job = one<JobRow>(
				"SELECT * FROM config_jobs WHERE input_key = ? AND family = ?",
				inputKey,
				family,
			);
			if (job === null) {
				ports().log("a result arrived for no dispatched job", {
					inputKey,
					origin: family,
				});
				return;
			}
			sql.exec(
				"DELETE FROM config_jobs WHERE input_key = ? AND family = ?",
				inputKey,
				family,
			);
			const ok = isEvalOk(envelope);
			const code = isEvalOk(envelope) ? null : envelope.error.code;
			const message = isEvalOk(envelope) ? "" : envelope.error.message;
			const cached = code === null ||
				!(UNCACHED_EVAL_CODES as readonly string[]).includes(code);
			if (cached) {
				const t = now();
				// A trunk TIMEOUT or LIMIT_EXCEEDED counts how many trunk
				// evaluations in a row gave it; it is final at two.
				const before = cacheGet(inputKey);
				const hits = family === "trunk" && code !== null &&
						isLimitError({ status: "error", code })
					? (before !== null && before.origin === "trunk" &&
							isLimitError(before)
						? limitHits(before) + 1
						: 1)
					: undefined;
				// A trunk-origin entry is never overwritten by a preview's result.
				sql.exec(
					`INSERT INTO config_evals (input_key, evaluator, schema_key, origin, files_json, status, code,
					   resolved_json, error_json, first_sha, first_lane, cue_version, finished_at, used_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT (input_key) DO UPDATE SET origin = excluded.origin,
					   files_json = excluded.files_json, schema_key = excluded.schema_key,
					   status = excluded.status, code = excluded.code, resolved_json = excluded.resolved_json,
					   error_json = excluded.error_json, cue_version = excluded.cue_version,
					   finished_at = excluded.finished_at, used_at = excluded.used_at
					 WHERE config_evals.origin = 'preview' OR excluded.origin = 'trunk'`,
					inputKey,
					envelope.evaluator,
					job.schema_key,
					family,
					job.files_json,
					ok ? "ok" : "error",
					code,
					ok ? JSON.stringify(envelope.ok) : null,
					ok ? null : JSON.stringify({
						message: envelope.error.message,
						issues: envelope.issues,
						...(hits === undefined ? {} : { limitHits: hits }),
					}),
					job.sha,
					job.lane_id,
					envelope.cueVersion,
					t,
					t,
				);
				pruneCache();
				if (family === "trunk") {
					// The trunk evaluator answered: an outage recorded by earlier
					// work no longer gates the work this result answers.
					setHead({ unavailable_until: null, eval_attempts: 0 });
				}
			} else if (family === "trunk") {
				outage(`${code}: ${message}`);
			} else {
				sql.exec(
					"UPDATE config_previews SET status = 'unavailable', result_json = ?, updated_at = ? WHERE input_key = ? AND status = 'evaluating'",
					JSON.stringify({ code, message }),
					now(),
					inputKey,
				);
			}
			if (envelope.cueVersion !== null) {
				setHead({ cue_version: envelope.cueVersion });
			}
			emit(
				"repo.config.evaluated",
				{
					inputKey,
					sha: job.sha,
					origin: family,
					status: ok ? "ok" : "error",
					...(code === null ? {} : { code }),
					evaluator: envelope.evaluator.slice(0, 128),
					cueVersion: envelope.cueVersion,
				},
				`evaluated:${inputKey}:${family}:${now()}`,
			);
			// Previews waiting on this key (on their own job or on trunk's).
			soon("previews", now());
			// Trunk work uses only trunk's own answers: a trunk result
			// wakes the state machine whenever it has work.
			if (cached && family === "trunk" && nextWork(head()) !== null) {
				scheduleEval();
			}
		});
	};

	/** `caps.repo.policy`: only the caller's keys, only at a trunk commit (K13). */
	const policyFor = (
		at: string,
		extId: string,
		keys: readonly string[],
	): RepoPolicyAnswer => {
		if (!isSha(at)) throw invalid("at must be a commit sha");
		if (!live()) return { state: "none" };
		const seq = trunkSeqOf(at);
		if (seq === null) {
			throw denied(
				"policy-not-trunk",
				`policy-not-trunk: repo policy is read at a trunk commit; ${
					at.slice(0, 12)
				} is not on trunk (a lane head, revision or candidate is never read as policy, K13)`,
			);
		}
		const read = policyAtSync(seq);
		if (read.state !== "ok") return { state: read.state };
		const resolved = isRecord(read.resolved) ? read.resolved : {};
		const ext = isRecord(resolved.extensions)
			? resolved.extensions[extId]
			: undefined;
		const settings = isRecord(ext) && isRecord(ext.settings)
			? ext.settings
			: {};
		const values = Object.fromEntries(
			keys.filter((k) => Object.hasOwn(settings, k)).map((k) => [
				k,
				settings[k],
			]),
		);
		return {
			state: "ok",
			configSha: read.sha,
			...(read.inputKey === undefined ? {} : { inputKey: read.inputKey }),
			exact: read.exact,
			values,
			...(read.failed === undefined ? {} : {
				failed: {
					sha: read.failed.sha,
					message: read.failed.message ??
						(read.failed.status === "pending"
							? "still evaluating (kept last good)"
							: "the config does not evaluate"),
					issues: read.failed.issues,
				},
			}),
		};
	};

	/** RepoProbe: the configured projects and global files at a commit's trunk base. */
	const projectConfigFor = (sha: string): ProjectConfigAnswer => {
		if (!isSha(sha)) throw invalid("sha must be a commit sha");
		const none = (key: string): ProjectConfigAnswer => ({
			key,
			projects: null,
			global: [],
			provisional: false,
		});
		if (!live()) return none("off");
		const seq = trunkSeqOf(sha);
		if (seq === null) {
			return newestTrunkRow() === null ? none("none") : { needsBase: true };
		}
		const fields = (resolved: unknown) => {
			const v = isRecord(resolved) ? resolved : {};
			return {
				projects: isRecord(v.projects) ? v.projects : null,
				global: Array.isArray(v.global)
					? v.global.filter((g): g is string => typeof g === "string")
					: [],
			};
		};
		const read = policyAtSync(seq);
		switch (read.state) {
			case "none":
				return none("none");
			case "expired":
				return none("expired");
			case "ok":
				return {
					key: read.inputKey ?? "none",
					...fields(read.resolved),
					provisional: false,
				};
			case "pending": {
				const good = read.lastGood;
				return good !== null && good.state === "ok"
					? {
						key: `provisional:${good.inputKey ?? "none"}`,
						...fields(good.resolved),
						provisional: true,
					}
					: { ...none("provisional:none"), provisional: true };
			}
		}
	};

	const facade: RepoConfigFacade = {
		state: () => Promise.resolve().then(headDto),
		evaluation: (inputKey) =>
			Promise.resolve().then(() => {
				const row = cacheGet(String(inputKey));
				return row === null ? null : evalDto(row);
			}),
		preview: (laneId, requestedBy) =>
			Promise.resolve().then(() => {
				requireEnabled();
				const lane = core().laneSync(laneId);
				if (lane === null) throw notFound(`unknown lane: ${laneId}`);
				const headSha = lane.head_sha ?? lane.base_sha;
				const existing = one<PreviewRow>(
					"SELECT * FROM config_previews WHERE lane_id = ?",
					laneId,
				);
				const fresh = existing !== null && existing.head_sha === headSha &&
					!["rate_limited", "unavailable"].includes(existing.status);
				if (!fresh) {
					tx(() => {
						sql.exec(
							`INSERT INTO config_previews (lane_id, head_sha, input_key, status, requested_by, result_json,
							   attempts, updated_at)
							 VALUES (?, ?, NULL, 'queued', ?, NULL, 0, ?)
							 ON CONFLICT (lane_id) DO UPDATE SET head_sha = excluded.head_sha, input_key = NULL,
							   status = 'queued', requested_by = excluded.requested_by, result_json = NULL,
							   attempts = 0, updated_at = excluded.updated_at`,
							laneId,
							headSha,
							requestedBy,
							now(),
						);
						soon("previews", now());
					});
				}
				return previewDto(
					one<PreviewRow>(
						"SELECT * FROM config_previews WHERE lane_id = ?",
						laneId,
					)!,
				);
			}),
		previewOf: (laneId) =>
			Promise.resolve().then(() => {
				const row = one<PreviewRow>(
					"SELECT * FROM config_previews WHERE lane_id = ?",
					laneId,
				);
				return row === null ? null : previewDto(row);
			}),
		previewByKey: (inputKey) =>
			Promise.resolve().then(() => {
				const row = one<PreviewRow>(
					"SELECT * FROM config_previews WHERE input_key = ?",
					String(inputKey),
				);
				return row === null ? null : previewDto(row);
			}),
		signOff: (laneId, input, signer) => signOff(laneId, input, signer),
		revokeSignOff: (laneId, headSha, by) =>
			Promise.resolve().then(() => revokeSignOff(laneId, headSha, by)),
		apply: (sha, by) =>
			Promise.resolve().then(() => {
				requireEnabled();
				if (!isSha(sha)) throw invalid("sha must be a commit sha");
				const trunk = core().refSync(trunkRef())?.sha ?? null;
				if (trunk !== sha) {
					throw conflict(
						`trunk-moved: trunk is at ${trunk ?? "nothing"}; reload the plan`,
						{ code: "trunk-moved" },
					);
				}
				tx(() => {
					const h = head();
					if (h.pending_cause === "advance" && h.pending_sha !== null) {
						throw conflict("a policy-touching Advance is still resolving");
					}
					const seq = Math.max(h.obs_seq, h.applied_seq ?? 0) + 1;
					setHead({
						obs_seq: seq,
						pending_seq: seq,
						pending_sha: sha,
						pending_key: null,
						pending_cause: "apply",
						pending_row_seq: externalRowSeq(sha),
						pending_principals_json: JSON.stringify([by]),
						pending_removal_ok: 1,
						external_by: by,
						eval_attempts: 0,
						unavailable_until: null,
					});
					emit(
						"repo.config.evaluating",
						{ sha, cause: "apply", trunkSeq: seq },
						`evaluating:${seq}`,
						actorOf(by),
					);
					scheduleEval();
				});
				return headDto();
			}),
		reevaluate: (by) =>
			Promise.resolve().then(() => {
				requireEnabled();
				tx(() => {
					const h = head();
					if (h.reeval_at !== null && now() - h.reeval_at < REEVALUATE_MIN_MS) {
						throw rateLimited(
							"re-evaluate at most once a minute",
							REEVALUATE_MIN_MS - (now() - h.reeval_at),
						);
					}
					setHead({
						reeval_at: now(),
						eval_attempts: 0,
						unavailable_until: null,
						// Registry work re-evaluates trunk's config (a first config
						// that never applied included).
						...(h.pending_sha === null ? { registry_due: 1 } : {}),
						...(h.pending_sha === null ? { external_due: 1 } : {}),
					});
					// A running trunk job still answers (deleting it dropped its
					// result, so repeated calls could keep a hold alive); jobs
					// past their deadline start a fresh round of dispatches.
					sql.exec(
						"DELETE FROM config_jobs WHERE family = 'trunk' AND (deadline_at IS NULL OR deadline_at <= ?)",
						now(),
					);
					// A resource-limit answer may have been the environment's:
					// re-evaluating runs it again.
					sql.exec(
						`DELETE FROM config_evals WHERE status = 'error' AND code IN ('TIMEOUT','LIMIT_EXCEEDED')
						 AND input_key <> ?`,
						h.applied_key ?? "",
					);
					emit(
						"repo.config.evaluating",
						{
							sha: h.pending_sha ?? h.trunk_sha ?? h.applied_sha ??
								"0".repeat(40),
							cause: "reevaluate",
							trunkSeq: h.obs_seq,
						},
						`reevaluate:${now()}`,
						actorOf(by),
					);
					scheduleEval();
				});
				return headDto();
			}),
		override: (action, by) =>
			Promise.resolve().then(async () => {
				requireEnabled();
				// The Owner decides on ForgeDO's hold as it is now.
				if (action === "keep-last-good") {
					try {
						await withBudget(budgetMs, refreshForgeHold());
					} catch (error) {
						if (error instanceof BudgetExceeded) {
							throw unavailable("the registry did not answer; retry");
						}
						throw error;
					}
				}
				tx(() => {
					const h = head();
					if (action === "keep-last-good") {
						if (!holdSync().held) throw invalid("lands are not held");
						// It covers the holds present now: the pending resolution
						// and/or ForgeDO's gate-missing hold, nothing later.
						setHead({
							hold: 0,
							override_by: by,
							override_pending: h.hold === 1 ? 1 : h.override_pending,
							override_gate: h.forge_hold !== null
								? h.forge_hold_id
								: h.override_gate,
						});
					} else {
						setHead({
							override_by: null,
							override_pending: 0,
							override_gate: 0,
							...(h.status === "pending" && h.pending_sha !== null
								? { hold: 1 }
								: {}),
						});
					}
					emit(
						"repo.config.overridden",
						{
							action,
							...(h.pending_sha === null ? {} : { sha: h.pending_sha }),
						},
						`overridden:${action}:${now()}`,
						actorOf(by),
					);
				});
				return headDto();
			}),
		cueResult: (inputKey, envelope, origin) =>
			Promise.resolve().then(() =>
				cueResult(
					inputKey,
					envelope,
					origin === "trunk" || origin === "preview" ? origin : undefined,
				)
			),
		registryChanged: (epoch) =>
			Promise.resolve().then(() => {
				if (!live()) return;
				tx(() => {
					const h = head();
					if (epoch <= h.epoch_seen && h.registry_due === 0) {
						if (epoch < h.epoch_seen) return;
					}
					// Something to re-evaluate: an applied config, or trunk's config
					// (a first config the registry or CUE refused included).
					const configured = h.applied_key !== null ||
						newestTrunkRow() !== null;
					setHead({
						epoch_seen: Math.max(h.epoch_seen, epoch),
						...(configured
							? {
								registry_due: 1,
								...(h.status === "current" ? { status: "stale" as const } : {}),
							}
							: {}),
					});
					scheduleEval();
				});
			}),
		policy: (at, extId, keys) =>
			Promise.resolve().then(() =>
				policyFor(String(at), String(extId), [...keys].map(String))
			),
		projectConfig: (sha) =>
			Promise.resolve().then(() => projectConfigFor(String(sha))),
		trunkHistory: (limit = TRUNK_ROWS_KEPT) =>
			Promise.resolve().then(() =>
				rows<TrunkRow>(
					"SELECT * FROM config_trunk ORDER BY trunk_seq DESC LIMIT ?",
					Math.max(1, Math.min(TRUNK_ROWS_KEPT, Math.floor(limit))),
				).map(trunkRowDto)
			),
	};

	/**
	 * A hold that lasted `HOLD_NOTICE_MS`: the repo's Owners are told once
	 * per hold (its reason and generation), since only an Owner can release
	 * it (keep-last-good) or fix a lost gate approval.
	 */
	const onNotice = async (): Promise<void> => {
		if (!live()) return;
		const h = head();
		const hold = holdSync();
		if (!hold.held || h.held_since === null) return;
		if (now() - h.held_since < HOLD_NOTICE_MS) return;
		const key = noticeKey(head(), hold.reason!);
		if (head().hold_noticed === key) return;
		const owners = await withBudget(budgetMs, ports().owners(repoId()));
		const minutes = Math.floor((now() - h.held_since) / 60_000);
		const why = hold.reason === "gate-missing"
			? "a gate that repository config installed lost its Owner approval; approve it again, or choose Keep last-good"
			: "trunk's repository config has not resolved (the evaluator may be unavailable); it resolves by itself, or choose Keep last-good";
		for (const owner of owners) {
			try {
				await ports().notify(owner, {
					source: "kernel",
					sourceLabel: "repo config",
					repoId: repoId(),
					kind: "system",
					severity: "warn",
					text:
						`lands of this repository have been held for ${minutes} min: ${why}`,
					dedupeKey: `repoconfig:hold:${key}`,
				});
			} catch (error) {
				ports().log("hold notice failed", {
					error: errorText(error).slice(0, 200),
				});
			}
		}
		tx(() => setHead({ hold_noticed: key }));
	};

	const onTimer: TimerHandler = async (key) => {
		switch (key) {
			case "eval":
				await onEval();
				return;
			case "notice":
				await onNotice();
				return;
			case "apply":
				if (!live()) return;
				await onApply();
				return;
			case "jobs":
				onJobs();
				return;
			case "previews":
				await onPreviews();
				return;
			default:
				throw invalid(`unknown repoconfig timer: ${key}`);
		}
	};

	return { facade, internal, onTimer, headDto };
};

export const createRepoConfigModule = (
	options: RepoConfigModuleOptions = {},
): DoModule<RepoConfigFacade, RepoConfigInternal, Env, RepoInternals> => ({
	name: "repoconfig",
	range: MIGRATION_RANGES.repo.repoconfig,
	migrations: REPO_CONFIG_MIGRATIONS,
	create: (deps) => {
		const m = createRepoConfig(deps, options);
		return { facade: m.facade, internal: m.internal, onTimer: m.onTimer };
	},
});

export const repoConfigModule = createRepoConfigModule();
