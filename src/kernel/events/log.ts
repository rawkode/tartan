// The ordered, causal, hash-chained per-repo event log (K3, K4, K10; WP6).
// Synchronous over DO SQLite: every write joins the caller's `transactionSync`,
// so a kernel state change and its event commit together (the log is the
// outbox, K3).
//
// - `appendSync` is idempotent on `idem_key`; it validates (K10), assigns the
//   next `seq` (strictly increasing, one writer: the DO), chains the hash and
//   writes a checkpoint every `EVENT_CHECKPOINT_EVERY` events.
// - Pruning (`prune`) removes unpinned events past retention (30 d; `sim` 24 h)
//   but never the head; it keeps a skeleton per pruned row until the row's
//   whole checkpoint block is gone, so `verifyChain` still verifies across
//   pruning (`./chain.ts`).
//
// DDL: the `events` table plus three columns the envelope needs (`node`,
// `repo`, `source_ext`: `<extId>@<version>` of an installation source), and
// the `events_pruned` skeleton table.

import {
	type AppendInput,
	type AppendResult,
	type Envelope,
	EVENT_PATTERN_RE,
	invalid,
	isLaneEventType,
	repoStream,
} from "@tartan/contract";
import {
	type Clock,
	EVENT_CHECKPOINT_EVERY,
	EVENT_RETENTION_MS,
	type EventRow,
	GENESIS_PREV_HASH,
	type Ids,
	type Migration,
	type Sha256Sync,
	SIM_EVENT_RETENTION_MS,
} from "@tartan/contract/kernel.ts";
import {
	chainHash,
	type ChainItem,
	type ChainVerdict,
	createChainVerifier,
	type HashedEventFields,
	isCheckpointSeq,
	sha256Hex,
} from "./chain.ts";
import { first, jsonList, type SqlExec } from "./sql.ts";
import { validateAppend } from "./validate.ts";

/** `events` plus `node`, `repo`, `source_ext`. */
export type StoredEventRow = EventRow & {
	node: string;
	repo: string | null;
	source_ext: string | null;
};

export const REPO_EVENTS_MIGRATIONS: readonly Migration[] = [
	{
		n: 200,
		name: "events",
		sql: [
			`CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  idem_key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  v INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL,
  source_ext TEXT,
  shadow INTEGER NOT NULL DEFAULT 0,
  actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL, on_behalf_of TEXT,
  subject_kind TEXT, subject_id TEXT,
  caused_by TEXT, correlation TEXT,
  depth INTEGER NOT NULL CHECK (depth BETWEEN 0 AND 8),
  node TEXT NOT NULL, repo TEXT,
  data_json TEXT NOT NULL,
  at INTEGER NOT NULL,
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  sim INTEGER NOT NULL DEFAULT 0)`,
			"CREATE INDEX events_type ON events(type, seq)",
			"CREATE INDEX events_subject ON events(subject_kind, subject_id, seq)",
			"CREATE INDEX events_correlation ON events(correlation, seq)",
			"CREATE INDEX events_age ON events(sim, at)",
		].join(";\n"),
	},
	{
		n: 201,
		name: "chain_checkpoints",
		sql:
			"CREATE TABLE chain_checkpoints (seq INTEGER PRIMARY KEY, hash TEXT NOT NULL, at INTEGER NOT NULL)",
	},
	{
		n: 202,
		name: "subscribers",
		sql:
			"CREATE TABLE subscribers (installation_id TEXT NOT NULL, host_name TEXT NOT NULL, pattern TEXT NOT NULL, mode TEXT NOT NULL, ext_version INTEGER NOT NULL, PRIMARY KEY (installation_id, pattern))",
	},
	{
		n: 203,
		name: "events_pruned",
		sql:
			"CREATE TABLE events_pruned (seq INTEGER PRIMARY KEY, prev_hash TEXT NOT NULL, hash TEXT NOT NULL)",
	},
];

/** `read` bounds (`/-/live` replays ≤ 500). */
export const READ_DEFAULT_LIMIT = 100;
export const READ_MAX_LIMIT = 500;
export const READ_MAX_PATTERNS = 40;
export const GET_MAX_IDS = 500;
/** One `verifyChain` call covers at most this many positions. */
export const VERIFY_MAX_RANGE = 100_000;
/** Rows pruned per transaction, and transactions per `prune` call. */
export const PRUNE_BATCH = 5000;
export const PRUNE_MAX_BATCHES = 40;

export type ReadQuery = {
	readonly since: number;
	readonly limit?: number;
	readonly patterns?: readonly string[];
	readonly includeShadow?: boolean;
};

export type EventLogDeps = {
	readonly sql: SqlExec;
	readonly transact: <T>(fn: () => T) => T;
	readonly clock: Clock;
	readonly ids: Ids;
	/** The RepoDO's repo id when known (from its name); every event must be for it. */
	readonly repoId: () => string | null;
	readonly sha256?: Sha256Sync;
	/**
	 * The lane-transition rule: called inside the append's transaction for every
	 * appended non-shadow event whose type is in `LANE_EVENT_TRANSITIONS`
	 * (`RepoCoreInternal.applyLaneEventSync`, WP5a).
	 */
	readonly applyLaneEvent?: (event: Envelope) => void;
	/** After every created append (still inside the transaction): pokes and live frames. */
	readonly onAppend?: (event: Envelope) => void;
	/**
	 * True while every event of this log is a simulated agent's (a swarm shard):
	 * appends carry `sim: true` whatever the producer said.
	 */
	readonly simulated?: () => boolean;
};

export type EventLog = {
	appendSync(input: AppendInput): AppendResult;
	existingSync(ids: readonly string[]): string[];
	getSync(ids: readonly string[]): Envelope[];
	pinSync(ids: readonly string[]): void;
	headSync(): { seq: number; hash: string };
	/** The lowest retained seq, or null for an empty log. */
	oldestSeqSync(): number | null;
	read(query: ReadQuery): Envelope[];
	/**
	 * Stored rows with `seq > since`, in seq order, nothing filtered (shadow
	 * and sim included): the global log relay's read (WP26).
	 */
	readRowsSync(since: number, limit: number): StoredEventRow[];
	/** Types and shadow flags after `seq`, for poke matching (bounded). */
	typesSince(
		seq: number,
		limit: number,
	): { seq: number; type: string; shadow: boolean }[];
	verifyChain(fromSeq: number, toSeq: number): ChainVerdict;
	/**
	 * Retention. `keepAbove` (the relay's cursor while it is not `off`) is the
	 * prune guard: no row with a greater seq is deleted (WP26).
	 */
	prune(now: number, keepAbove?: number | null): { deleted: number };
};

const toHashed = (row: StoredEventRow): HashedEventFields => ({
	seq: row.seq,
	id: row.id,
	idem_key: row.idem_key,
	type: row.type,
	v: row.v,
	source: row.source,
	source_ext: row.source_ext,
	shadow: row.shadow,
	sim: row.sim,
	actor_kind: row.actor_kind,
	actor_id: row.actor_id,
	on_behalf_of: row.on_behalf_of,
	subject_kind: row.subject_kind,
	subject_id: row.subject_id,
	caused_by: row.caused_by,
	correlation: row.correlation,
	depth: row.depth,
	node: row.node,
	repo: row.repo,
	data_json: row.data_json,
	at: row.at,
});

/** Row → envelope; `hash` is the chain position. */
export const toEnvelope = (row: StoredEventRow): Envelope => {
	const repo = row.repo ?? row.node;
	return {
		id: row.id,
		seq: row.seq,
		stream: repoStream(repo),
		type: row.type,
		v: row.v,
		source: row.source === "kernel"
			? { kind: "kernel" }
			: { kind: "installation", id: row.source, ext: row.source_ext ?? "" },
		actor: {
			kind: row.actor_kind as Envelope["actor"]["kind"],
			id: row.actor_id,
			...(row.on_behalf_of !== null ? { onBehalfOf: row.on_behalf_of } : {}),
		},
		node: row.node,
		repo,
		...(row.subject_kind !== null && row.subject_id !== null
			? { subject: { kind: row.subject_kind, id: row.subject_id } }
			: {}),
		...(row.caused_by !== null ? { causedBy: row.caused_by } : {}),
		...(row.correlation !== null ? { correlation: row.correlation } : {}),
		depth: row.depth,
		shadow: row.shadow === 1,
		...(row.sim === 1 ? { sim: true } : {}),
		at: row.at,
		hash: row.hash,
		data: JSON.parse(row.data_json),
	};
};

/** SQL for a list of `EVENT_PATTERN_RE` patterns (`*`, `ns.*`, exact). */
export const patternClause = (
	patterns: readonly string[],
): { sql: string; args: string[] } | null => {
	if (patterns.includes("*")) return null;
	const parts: string[] = [];
	const args: string[] = [];
	for (const pattern of patterns) {
		if (pattern.endsWith(".*")) {
			const prefix = pattern.slice(0, -1);
			const upper = prefix.slice(0, -1) +
				String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
			parts.push("(type >= ? AND type < ?)");
			args.push(prefix, upper);
		} else {
			parts.push("type = ?");
			args.push(pattern);
		}
	}
	return { sql: `(${parts.join(" OR ")})`, args };
};

export const checkPatterns = (patterns: readonly string[]): void => {
	if (patterns.length > READ_MAX_PATTERNS) {
		throw invalid(`at most ${READ_MAX_PATTERNS} patterns`);
	}
	for (const pattern of patterns) {
		if (typeof pattern !== "string" || !EVENT_PATTERN_RE.test(pattern)) {
			throw invalid(`invalid event pattern: ${String(pattern)}`);
		}
	}
};

const checkIds = (ids: readonly string[]): void => {
	if (!Array.isArray(ids) || ids.length > GET_MAX_IDS) {
		throw invalid(`at most ${GET_MAX_IDS} ids`);
	}
	if (ids.some((id) => typeof id !== "string")) {
		throw invalid("ids are strings");
	}
};

const nonNegativeInt = (value: number, name: string): number => {
	if (!Number.isInteger(value) || value < 0) {
		throw invalid(`${name} must be a non-negative integer`);
	}
	return value;
};

export const createEventLog = (deps: EventLogDeps): EventLog => {
	const { sql } = deps;
	const sha256 = deps.sha256 ?? sha256Hex;

	const headSync = (): { seq: number; hash: string } =>
		first(
			sql.exec<{ seq: number; hash: string }>(
				"SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1",
			),
		) ?? { seq: 0, hash: GENESIS_PREV_HASH };

	const byIdem = (idemKey: string): AppendResult | null => {
		const row = first(
			sql.exec<{ id: string; seq: number; hash: string }>(
				"SELECT id, seq, hash FROM events WHERE idem_key = ?",
				idemKey,
			),
		);
		return row ? { ...row, created: false } : null;
	};

	const causeDepth = (id: string): number | null =>
		first(
			sql.exec<{ depth: number }>("SELECT depth FROM events WHERE id = ?", id),
		)?.depth ?? null;

	const appendSync = (input: AppendInput): AppendResult => {
		const idemKey = typeof input?.idemKey === "string" ? input.idemKey : "";
		const existing = idemKey === "" ? null : byIdem(idemKey);
		if (existing) return existing;
		const valid = validateAppend(input, {
			repoId: deps.repoId(),
			causeDepth,
		});
		const head = headSync();
		const fields: HashedEventFields = {
			seq: head.seq + 1,
			id: deps.ids.ulid(),
			idem_key: valid.idemKey,
			type: valid.type,
			v: valid.v,
			source: valid.source.kind === "kernel" ? "kernel" : valid.source.id,
			source_ext: valid.source.kind === "kernel" ? null : valid.source.ext,
			shadow: valid.shadow ? 1 : 0,
			sim: valid.sim || deps.simulated?.() === true ? 1 : 0,
			actor_kind: valid.actor.kind,
			actor_id: valid.actor.id,
			on_behalf_of: valid.actor.onBehalfOf ?? null,
			subject_kind: valid.subject?.kind ?? null,
			subject_id: valid.subject?.id ?? null,
			caused_by: valid.causedBy ?? null,
			correlation: valid.correlation ?? null,
			depth: valid.depth,
			node: valid.node,
			repo: valid.repo,
			data_json: valid.dataJson,
			at: deps.clock.now(),
		};
		const hash = chainHash(head.hash, fields, sha256);
		sql.exec(
			`INSERT INTO events (seq, id, idem_key, type, v, source, source_ext, shadow, sim,
  actor_kind, actor_id, on_behalf_of, subject_kind, subject_id, caused_by, correlation,
  depth, node, repo, data_json, at, prev_hash, hash, pinned)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
			fields.seq,
			fields.id,
			fields.idem_key,
			fields.type,
			fields.v,
			fields.source,
			fields.source_ext,
			fields.shadow,
			fields.sim,
			fields.actor_kind,
			fields.actor_id,
			fields.on_behalf_of,
			fields.subject_kind,
			fields.subject_id,
			fields.caused_by,
			fields.correlation,
			fields.depth,
			fields.node,
			fields.repo,
			fields.data_json,
			fields.at,
			head.hash,
			hash,
		);
		if (isCheckpointSeq(fields.seq)) {
			sql.exec(
				"INSERT INTO chain_checkpoints (seq, hash, at) VALUES (?, ?, ?)",
				fields.seq,
				hash,
				fields.at,
			);
		}
		const envelope = toEnvelope({
			...fields,
			prev_hash: head.hash,
			hash,
			pinned: 0,
		});
		if (!valid.shadow && isLaneEventType(valid.type)) {
			deps.applyLaneEvent?.(envelope);
		}
		deps.onAppend?.(envelope);
		return { id: fields.id, seq: fields.seq, hash, created: true };
	};

	const rowsByIds = (ids: readonly string[]): StoredEventRow[] => {
		checkIds(ids);
		if (ids.length === 0) return [];
		return sql.exec<StoredEventRow>(
			"SELECT * FROM events WHERE id IN (SELECT value FROM json_each(?)) ORDER BY seq",
			jsonList(ids),
		).toArray();
	};

	const read = (query: ReadQuery): Envelope[] => {
		const since = nonNegativeInt(query.since, "since");
		const limit = Math.min(
			READ_MAX_LIMIT,
			Math.max(1, nonNegativeInt(query.limit ?? READ_DEFAULT_LIMIT, "limit")),
		);
		const patterns = query.patterns ?? ["*"];
		checkPatterns(patterns);
		if (patterns.length === 0) return [];
		const clause = patternClause(patterns);
		const where = [
			"seq > ?",
			...(query.includeShadow ? [] : ["shadow = 0"]),
			...(clause ? [clause.sql] : []),
		].join(" AND ");
		return sql.exec<StoredEventRow>(
			`SELECT * FROM events WHERE ${where} ORDER BY seq LIMIT ?`,
			since,
			...(clause?.args ?? []),
			limit,
		).toArray().map(toEnvelope);
	};

	const readRowsSync = (since: number, limit: number): StoredEventRow[] =>
		sql.exec<StoredEventRow>(
			"SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
			nonNegativeInt(since, "since"),
			Math.max(1, nonNegativeInt(limit, "limit")),
		).toArray();

	const typesSince = (seq: number, limit: number) =>
		sql.exec<{ seq: number; type: string; shadow: number }>(
			"SELECT seq, type, shadow FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
			seq,
			limit,
		).toArray().map((r) => ({
			seq: r.seq,
			type: r.type,
			shadow: r.shadow === 1,
		}));

	const hashAt = (seq: number): string | null => {
		if (seq === 0) return GENESIS_PREV_HASH;
		const row = first(
			sql.exec<{ hash: string }>(
				"SELECT hash FROM events WHERE seq = ? UNION ALL SELECT hash FROM events_pruned WHERE seq = ? UNION ALL SELECT hash FROM chain_checkpoints WHERE seq = ?",
				seq,
				seq,
				seq,
			),
		);
		return row?.hash ?? null;
	};

	const verifyChain = (fromSeq: number, toSeq: number): ChainVerdict => {
		const head = headSync().seq;
		const from = Math.max(1, nonNegativeInt(fromSeq, "fromSeq"));
		const to = Math.min(head, nonNegativeInt(toSeq, "toSeq"));
		if (from > to) return { ok: true };
		if (to - from + 1 > VERIFY_MAX_RANGE) {
			throw invalid(`verify at most ${VERIFY_MAX_RANGE} events per call`);
		}
		const checkpoints = new Map(
			sql.exec<{ seq: number; hash: string }>(
				"SELECT seq, hash FROM chain_checkpoints WHERE seq BETWEEN ? AND ?",
				from - 1,
				to,
			).toArray().map((r) => [r.seq, r.hash]),
		);
		const verifier = createChainVerifier({
			from,
			anchor: hashAt(from - 1),
			checkpoint: (seq) => checkpoints.get(seq) ?? null,
			sha256,
		});
		const page = EVENT_CHECKPOINT_EVERY;
		for (let lo = from; lo <= to; lo += page) {
			const hi = Math.min(to, lo + page - 1);
			const rows: ChainItem[] = sql.exec<StoredEventRow>(
				"SELECT * FROM events WHERE seq BETWEEN ? AND ? ORDER BY seq",
				lo,
				hi,
			).toArray().map((row) => ({
				kind: "row",
				seq: row.seq,
				prevHash: row.prev_hash,
				hash: row.hash,
				row: toHashed(row),
			}));
			const skeletons: ChainItem[] = sql.exec<
				{ seq: number; prev_hash: string; hash: string }
			>(
				"SELECT seq, prev_hash, hash FROM events_pruned WHERE seq BETWEEN ? AND ? ORDER BY seq",
				lo,
				hi,
			).toArray().map((s) => ({
				kind: "skeleton",
				seq: s.seq,
				prevHash: s.prev_hash,
				hash: s.hash,
			}));
			const items = [...rows, ...skeletons].sort((a, b) => a.seq - b.seq);
			for (const item of items) {
				if (!verifier.push(item)) return verifier.result();
			}
		}
		return verifier.result();
	};

	const prune = (
		now: number,
		keepAbove: number | null = null,
	): { deleted: number } => {
		const cutoff = now - EVENT_RETENTION_MS;
		const simCutoff = now - SIM_EVENT_RETENTION_MS;
		let deleted = 0;
		for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch++) {
			const removed = deps.transact(() => {
				const head = headSync().seq;
				const below = keepAbove === null ? head : Math.min(head, keepAbove + 1);
				const seqs = sql.exec<{ seq: number }>(
					`SELECT seq FROM events WHERE pinned = 0 AND seq < ? AND (
  (sim = 0 AND at < ?) OR (sim = 1 AND at < ?)) ORDER BY seq LIMIT ?`,
					below,
					cutoff,
					simCutoff,
					PRUNE_BATCH,
				).toArray().map((r) => r.seq);
				if (seqs.length === 0) return 0;
				const list = JSON.stringify(seqs);
				sql.exec(
					"INSERT OR IGNORE INTO events_pruned (seq, prev_hash, hash) SELECT seq, prev_hash, hash FROM events WHERE seq IN (SELECT value FROM json_each(?))",
					list,
				);
				sql.exec(
					"DELETE FROM events WHERE seq IN (SELECT value FROM json_each(?))",
					list,
				);
				return seqs.length;
			});
			deleted += removed;
			if (removed < PRUNE_BATCH) break;
		}
		deps.transact(dropCompleteBlocks);
		return { deleted };
	};

	/** Drops skeleton blocks whose whole checkpoint block is pruned and unpinned. */
	const dropCompleteBlocks = (): void => {
		const lastCheckpoint = first(
			sql.exec<{ seq: number | null }>(
				"SELECT MAX(seq) AS seq FROM chain_checkpoints",
			),
		)?.seq ?? 0;
		const blocks = sql.exec<{ blk: number }>(
			`SELECT DISTINCT (seq - 1) / ${EVENT_CHECKPOINT_EVERY} AS blk FROM events_pruned`,
		).toArray().map((r) => r.blk);
		for (const blk of blocks) {
			const lo = blk * EVENT_CHECKPOINT_EVERY + 1;
			const hi = (blk + 1) * EVENT_CHECKPOINT_EVERY;
			if (hi > lastCheckpoint) continue;
			const live = first(
				sql.exec<{ n: number }>(
					"SELECT COUNT(*) AS n FROM events WHERE seq BETWEEN ? AND ?",
					lo,
					hi,
				),
			)?.n ?? 0;
			if (live > 0) continue;
			sql.exec("DELETE FROM events_pruned WHERE seq BETWEEN ? AND ?", lo, hi);
		}
	};

	return {
		appendSync,
		existingSync: (ids) => rowsByIds(ids).map((row) => row.id),
		getSync: (ids) => rowsByIds(ids).map(toEnvelope),
		pinSync: (ids) => {
			checkIds(ids);
			if (ids.length === 0) return;
			sql.exec(
				"UPDATE events SET pinned = 1 WHERE id IN (SELECT value FROM json_each(?))",
				jsonList(ids),
			);
		},
		headSync,
		oldestSeqSync: () =>
			first(
				sql.exec<{ seq: number | null }>("SELECT MIN(seq) AS seq FROM events"),
			)?.seq ?? null,
		read,
		readRowsSync,
		typesSince,
		verifyChain,
		prune,
	};
};
