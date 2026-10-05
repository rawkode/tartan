// The serial queue@1 train shared by `tartan.weave` and `tartan.fifo` (K4).
//
// The extension import rule keeps every extension
// self-contained, so `extensions/fifo/src/engine.ts` is a byte-identical copy
// of this file; `extensions/fifo/src/engine_copy.test.ts` fails if they drift.
// The two providers differ only in their `QueuePolicy`: the Weave batches up
// to four changes and enqueues on any non-shadow approval; FIFO lands one
// change at a time and enqueues only on a user's `review.decided`.
//
// The train (M1, serial: one batch in flight per repo):
//
// - `changes.submitted`/`changes.revised` record the change's lane, head,
//   affected projects and the event ids K4 needs; a revision withdraws a
//   waiting entry approved at another head.
// - `review.decided{approve}` enqueues the change at the approved head
//   (`queue.enqueued`) and arms the debounced `tick` timer.
// - `tick` (under the ExtensionDO mutex): a batch still `minted` is
//   resubmitted as stored; a `submitted` batch is polled (watchdog); else the
//   next ≤ `batch` waiting entries are composed into a `LandRequest`, whose
//   batch id is minted and **stored with the whole request before**
//   `land.submit`, so a retried tick resubmits the identical request and
//   the kernel's idempotency on `batchId` returns the existing batch.
// - Every land change carries the approved head; its reason chain holds the
//   change's `changes.submitted` (plus the `changes.revised` of the landed
//   revision) and the `review.decided` that approved that head (K4).
// - A refused submit (`head-moved`, a quarantined or closed lane, an invalid
//   chain) drops the culprits found by reading their lanes; unexplained
//   refusals retry each change alone, and a change refused alone is ejected.
// - `land.conflicted`/`land.vetoed` eject the change (`queue.ejected`) and
//   notify its author with both intents, the other changes' paths and the
//   conflict regions (the notify-author resolver floor).
// - `land.failed` requeues the batch (tests: each change alone; one change
//   failing alone is ejected), `land.completed` lands entries
//   (`queue.landed`) and ticks the next batch.
//
// Provider hand-over (an Owner swaps `queue@1` on a live subtree, e.g. Weave →
// FIFO on one repo):
//
// - Only the queue@1 provider in force at the repo forms batches. Before a
//   batch, and on the `adopt` timer, the train asks the kernel who provides
//   queue@1 here (`providerHere`); when it is another installation, it
//   releases its waiting entries without events (the new provider takes
//   them over) and leaves its in-flight batch to finish. A kernel refusal
//   of `land.submit` as "not the queue@1 provider in force" does the same.
// - The provider in force adopts what the stream says is approved and not
//   landed: the `adopt` timer (at activation, then every `ADOPT_MS`) replays
//   `changes.*` and `review.decided` from its own cursor, quietly; the
//   cursor does not move while another installation provides queue@1, so
//   approvals made meanwhile are adopted once it provides again. An adopted
//   entry waits (`reason = 'adopting'`, never batched) until the replay
//   reaches the end of the stream, then its lane is checked (still
//   `submitted` at the approved head) and it is announced
//   (`queue.enqueued`). While the previous provider's batch is landing the
//   lane, the entry stays `adopting` and is looked at again after
//   `ADOPT_RECHECK_MS`, so a batch that fails there never strands the change. FIFO declines approvals that are not a user's and
//   says so once (`queue.ejected{withdrawn}`), so the change does not look
//   queued.
//
// Partitions, parallel sub-trains, bisect and resolver work items are M2.

import {
	type Actor,
	type ContextRequest,
	type ContextSection,
	denied,
	type Envelope,
	type ExtCtx,
	type ExtensionModule,
	fromRpcError,
	invalid,
	type LandChange,
	type LandRequest,
	type LandStatus,
	notFound,
	QUEUE_TOOLS,
	type QueueEntry,
	type SlotContext,
	SUMMARY_MAX_BYTES,
	type Tone,
	type ToolContext,
	truncateBytes,
	trunkRef,
	type UiDoc,
	type UiNode,
} from "@tartan/contract";
import {
	actingPrincipals,
	type Db,
	db as dbOf,
	defineExtension,
	json,
	requireInteractiveActor,
	result,
	ui,
} from "@tartan/ext-api";

// ---------------------------------------------------------------------------
// Policy and settings
// ---------------------------------------------------------------------------

export type QueuePolicy = {
	/** Manifest id (`tartan.weave`, `tartan.fifo`). */
	readonly extId: string;
	/** Short name used in summaries, notices and dedupe keys. */
	readonly label: string;
	/** Hard cap on a batch; config `batch` is clamped to `1..maxBatch`. */
	readonly maxBatch: number;
	/** Enqueue only on a `review.decided` whose `decidedBy` is a user. */
	readonly humanOnly: boolean;
	readonly defaultDebounceMs: number;
};

export type QueueSettings = {
	readonly batch: number;
	readonly debounceMs: number;
};

export const settingsOf = (
	policy: QueuePolicy,
	config: unknown,
): QueueSettings => {
	const c = (config ?? {}) as Record<string, unknown>;
	const batch = typeof c.batch === "number" && Number.isInteger(c.batch)
		? c.batch
		: policy.maxBatch;
	const debounce = typeof c.debounceMs === "number" &&
			Number.isFinite(c.debounceMs)
		? c.debounceMs
		: policy.defaultDebounceMs;
	return {
		batch: Math.min(policy.maxBatch, Math.max(1, batch)),
		debounceMs: Math.min(60_000, Math.max(0, Math.floor(debounce))),
	};
};

/** The timer key of the train. */
export const TICK = "tick";
/** Watchdog interval while a batch is in flight (land.status poll). */
export const WATCH_MS = 5 * 60_000;
/** Retry interval while landing is paused or the land grant is refused. */
export const PAUSE_RETRY_MS = 60_000;
/**
 * A batch the kernel's repository-config hold returned (`config-hold`, K9)
 * is submitted again after this long; the requeue never counts toward
 * ejection.
 */
export const CONFIG_HOLD_RETRY_MS = 5 * 60_000;
/** Requeues of one entry (stale, abandoned, error) before it is ejected. */
export const MAX_REQUEUES = 3;
/** The timer key of the adoption replay (provider hand-over). */
export const ADOPT = "adopt";
/** How often the provider in force replays the stream for approvals it missed. */
export const ADOPT_MS = 10 * 60_000;
/**
 * How soon the adoption looks again while an adopted change is still being
 * landed by another queue's batch (after a hand-over): if that batch fails,
 * the change is announced and queued here instead of being stranded.
 */
export const ADOPT_RECHECK_MS = 60_000;
/** Pages of the stream one adoption run replays before it re-arms. */
export const ADOPT_PAGES = 20;
/** What the adoption replay reads. */
export const ADOPT_PATTERNS: readonly string[] = [
	"changes.submitted",
	"changes.revised",
	"changes.abandoned",
	"changes.superseded",
	"changes.landed",
	"review.decided",
];
/** `entries.reason` of a replayed approval not yet checked against its lane. */
const ADOPTING = "adopting";
/**
 * …once announced: its `queue.enqueued` used the adoption's key, so a late
 * live delivery of the same approval says nothing new.
 */
const ADOPTED = "adopted";
/** `entries.reason` of a replayed approval FIFO declined (not a user's). */
const NEEDS_HUMAN = "needs-human";
/** …once the change was told (`queue.ejected{withdrawn}`). */
const NEEDS_HUMAN_TOLD = "needs-human-told";
/** `entries.reason` of entries released to another queue@1 provider. */
const PROVIDER_CHANGED = "provider-changed";
/** The kernel's `land.submit` refusal of a provider that is not in force. */
const NOT_PROVIDER = /not the queue@1 provider in force/;
/** Adopted (and declined) entries one adoption run settles. */
export const SETTLE_MAX = 25;
/** `caps.events.read` answers at most 100 events per call. */
const SCAN_PAGE = 100;
const SCAN_PAGES = 100;
const RECENT_LIMIT = 20;
const NOTICE_TEXT_BYTES = 1000;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type EntryState =
	| "waiting"
	| "batched"
	| "landing"
	| "landed"
	| "ejected"
	| "withdrawn";
export type EjectReason =
	| "conflict"
	| "veto"
	| "failure"
	| "stale"
	| "withdrawn";

export type EntryRow = {
	change_id: string;
	lane_id: string;
	head: string;
	affected_json: string;
	partition_key: string;
	priority: number;
	enqueued_at: number;
	state: EntryState;
	attempts: number;
	batch_id: string | null;
	last_error: string | null;
	revision: number;
	review_event: string | null;
	review_json: string;
	solo: number;
	withdraw_requested: number;
	reason: string | null;
	commit_sha: string | null;
	updated_at: number;
};

export type BatchRow = {
	batch_id: string;
	partition_key: string;
	change_ids_json: string;
	state: "minted" | "submitted" | "refused" | "done" | "failed";
	result_json: string | null;
	created_at: number;
	finished_at: number | null;
	seq: number;
	request_json: string | null;
	phase: string | null;
	submit_tries: number;
	submitted_at: number | null;
	last_error: string | null;
};

export type ChangeRow = {
	change_id: string;
	lane_id: string;
	revision: number;
	head: string;
	base: string | null;
	affected_json: string;
	work_ref: string | null;
	submitted_event: string | null;
	revised_event: string | null;
	title: string | null;
	summary: string | null;
	author: string | null;
	closed: number;
	updated_at: number;
};

type ReviewInfo = {
	readonly route?: string;
	readonly risk?: number;
	readonly decidedBy?: Actor;
};

const ACTIVE: readonly EntryState[] = ["batched", "landing"];
const FINAL: readonly EntryState[] = ["landed", "ejected", "withdrawn"];

// ---------------------------------------------------------------------------
// Small readers (event payloads are open objects; read defensively)
// ---------------------------------------------------------------------------

const SHA_RE = /^[0-9a-f]{40}$/;
const rec = (v: unknown): Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v)
		? v as Record<string, unknown>
		: {};
const str = (v: unknown): string | null =>
	typeof v === "string" && v.length > 0 ? v : null;
const sha = (v: unknown): string | null =>
	typeof v === "string" && SHA_RE.test(v) ? v : null;
const int = (v: unknown): number | null =>
	typeof v === "number" && Number.isInteger(v) ? v : null;
const strs = (v: unknown): string[] =>
	Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
const errText = (e: unknown): string => {
	const t = fromRpcError(e);
	return `${t.code}${t.reason ? `(${t.reason})` : ""}: ${t.text}`;
};
const oneLine = (s: string, max: number): string => {
	const flat = s.replace(/[\r\n\t]+/g, " ").replace(
		// deno-lint-ignore no-control-regex
		/[\u0000-\u001f\u007f]/g,
		"",
	).trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** `sorted(affected)` or `*` when nothing is known. */
export const partitionKeyOf = (affected: readonly string[]): string => {
	const keys = [...new Set(affected.filter((a) => a.length > 0))].sort();
	return keys.length === 0 ? "*" : keys.join(",").slice(0, 1024);
};

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const getEntry = (d: Db, changeId: string): EntryRow | null =>
	d.first<EntryRow>("SELECT * FROM entries WHERE change_id = ?", changeId);
const getChange = (d: Db, changeId: string): ChangeRow | null =>
	d.first<ChangeRow>("SELECT * FROM changes WHERE change_id = ?", changeId);
const getBatch = (d: Db, batchId: string): BatchRow | null =>
	d.first<BatchRow>("SELECT * FROM batches WHERE batch_id = ?", batchId);
const entriesOfBatch = (d: Db, batchId: string): EntryRow[] =>
	d.all<EntryRow>(
		"SELECT * FROM entries WHERE batch_id = ? ORDER BY priority, enqueued_at, change_id",
		batchId,
	);
const inflightBatch = (d: Db): BatchRow | null =>
	d.first<BatchRow>(
		"SELECT * FROM batches WHERE state IN ('minted', 'submitted') ORDER BY created_at, seq LIMIT 1",
	);
const metaGet = (d: Db, key: string): string | null =>
	d.value<string>("SELECT value FROM meta WHERE key = ?", key);
const metaSet = (d: Db, key: string, value: string): void => {
	d.run(
		"INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
		key,
		value,
	);
};
const metaDelete = (d: Db, key: string): void => {
	d.run("DELETE FROM meta WHERE key = ?", key);
};

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export const createQueueExtension = (policy: QueuePolicy): ExtensionModule => {
	const now = (x: ExtCtx): number => x.caps.clock.now();
	/**
	 * The repo this host serves: its scope (`repo:<id>`). The installation's
	 * node is the repo only when the queue is installed on the repo itself;
	 * a pack installs it on a group, and each repo below gets its own host.
	 */
	const repoId = (x: ExtCtx): string =>
		x.install.scopeKey.startsWith("repo:")
			? x.install.scopeKey.slice("repo:".length)
			: x.install.node.id;
	const repoRef = (x: ExtCtx) => ({ id: repoId(x) });
	/**
	 * The ref a batch lands on: the repo's default branch, the only one the
	 * kernel lands (an imported repo keeps its source's).
	 */
	const trunkRefOf = async (x: ExtCtx): Promise<string> =>
		trunkRef((await x.caps.repo.info(repoRef(x))).defaultBranch);

	const emit = async (
		x: ExtCtx,
		type: string,
		data: Record<string, unknown>,
		idemKey: string,
		subject?: string,
	): Promise<void> => {
		await x.caps.events.emit(type, data, {
			idemKey,
			...(subject ? { subject: { kind: "change", id: subject } } : {}),
		});
	};

	/**
	 * Arms the train timer at `at` unless an earlier tick is already pending
	 * (debounce: repeated enqueues collapse into one tick).
	 */
	const wake = async (x: ExtCtx, at: number): Promise<void> => {
		const d = dbOf(x.sql);
		const pending = Number(metaGet(d, "next_tick") ?? Number.NaN);
		if (Number.isFinite(pending) && pending >= now(x) && pending <= at) return;
		await x.caps.timers.set(TICK, at);
		metaSet(d, "next_tick", String(at));
	};

	// -- changes and approvals ----------------------------------------------------

	/**
	 * Finds the latest `changes.submitted` of a change in the repo stream
	 * (installed after the submit, or a delivery the Weave missed). Bounded.
	 */
	const scanSubmitted = async (
		x: ExtCtx,
		changeId: string,
	): Promise<Envelope | null> => {
		let since = 0;
		let found: Envelope | null = null;
		for (let page = 0; page < SCAN_PAGES; page += 1) {
			const events = await x.caps.events.read(
				`repo:${repoId(x)}`,
				since,
				["changes.submitted"],
				SCAN_PAGE,
			);
			for (const ev of events) {
				if (ev.shadow) continue;
				if (
					ev.type === "changes.submitted" && rec(ev.data).changeId === changeId
				) {
					found = ev;
				}
			}
			// A short page is not the end: the kernel caps its page size.
			if (events.length === 0) break;
			since = events[events.length - 1].seq;
		}
		return found;
	};

	/** Records a `changes.submitted`/`changes.revised` (idempotent; older revisions ignored). */
	const recordRevision = (
		x: ExtCtx,
		ev: Envelope,
	): ChangeRow | null => {
		const data = rec(ev.data);
		const changeId = str(data.changeId);
		const laneId = str(data.laneId);
		const revision = int(data.revision);
		const head = sha(data.head);
		if (!changeId || !laneId || revision === null || !head) {
			x.log.warn(`${ev.type} without changeId/laneId/revision/head`, {
				id: ev.id,
			});
			return null;
		}
		const d = dbOf(x.sql);
		const submitted = ev.type === "changes.submitted";
		return d.tx(() => {
			const row = getChange(d, changeId);
			if (row && row.revision > revision) return row;
			d.run(
				`INSERT INTO changes (change_id, lane_id, revision, head, base, affected_json, work_ref,
				   submitted_event, revised_event, closed, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
				 ON CONFLICT (change_id) DO UPDATE SET lane_id = excluded.lane_id,
				   revision = excluded.revision, head = excluded.head, base = excluded.base,
				   affected_json = excluded.affected_json,
				   work_ref = COALESCE(excluded.work_ref, changes.work_ref),
				   submitted_event = COALESCE(excluded.submitted_event, changes.submitted_event),
				   revised_event = excluded.revised_event, closed = 0, updated_at = excluded.updated_at`,
				changeId,
				laneId,
				revision,
				head,
				sha(data.base),
				json.encode(strs(data.affected)),
				str(data.workRef),
				submitted ? ev.id : null,
				submitted ? null : ev.id,
				now(x),
			);
			return getChange(d, changeId);
		});
	};

	const onRevision = async (ev: Envelope, x: ExtCtx): Promise<void> => {
		const change = recordRevision(x, ev);
		if (!change) return;
		const entry = getEntry(dbOf(x.sql), change.change_id);
		// A new revision withdraws a waiting entry approved at another head.
		if (entry?.state === "waiting" && entry.head !== change.head) {
			await drop(x, entry, {
				state: "withdrawn",
				reason: "stale",
				message: `revision ${change.revision} replaced the approved head`,
			});
		}
	};

	const onClosed = async (ev: Envelope, x: ExtCtx): Promise<void> => {
		const changeId = str(rec(ev.data).changeId);
		if (!changeId) return;
		const d = dbOf(x.sql);
		d.run(
			"UPDATE changes SET closed = 1, updated_at = ? WHERE change_id = ?",
			now(x),
			changeId,
		);
		const entry = getEntry(d, changeId);
		if (!entry) return;
		if (entry.state === "waiting") {
			await drop(x, entry, {
				state: "withdrawn",
				reason: "withdrawn",
				message: ev.type.replace("changes.", "change "),
			});
		} else if (ACTIVE.includes(entry.state)) {
			d.run(
				"UPDATE entries SET withdraw_requested = 1, updated_at = ? WHERE change_id = ?",
				now(x),
				changeId,
			);
		}
	};

	/**
	 * Enqueues the change at the approved head. A later
	 * `request_changes` of the same head withdraws a waiting entry.
	 */
	const onDecided = (ev: Envelope, x: ExtCtx): Promise<void> =>
		decide(ev, x, "live");

	/**
	 * `review.decided`, live or replayed by the adoption (`adopt`): a
	 * replayed approval is recorded quietly (`reason = 'adopting'`, no event,
	 * no tick) until `settleAdoptions` checks its lane; a replayed approval
	 * FIFO declines is remembered (`needs-human`) so the change can be told.
	 */
	const decide = async (
		ev: Envelope,
		x: ExtCtx,
		mode: "live" | "adopt",
	): Promise<void> => {
		const data = rec(ev.data);
		const changeId = str(data.changeId);
		const revision = int(data.revision);
		const head = sha(data.head);
		if (!changeId || revision === null || !head) {
			x.log.warn("review.decided without changeId/revision/head", {
				id: ev.id,
			});
			return;
		}
		if (data.decision !== "approve") {
			const entry = getEntry(dbOf(x.sql), changeId);
			if (entry?.state === "waiting" && entry.head === head) {
				if (mode === "adopt") {
					// The replay touches only what it adopted: a live entry
					// already reflects every event the live path delivered.
					if (entry.reason === ADOPTING) {
						quietly(x, entry, "withdrawn", "review requested changes");
					}
				} else {
					await drop(x, entry, {
						state: "withdrawn",
						reason: "withdrawn",
						message: "review requested changes",
					});
				}
			}
			return;
		}
		const decidedBy = rec(data.decidedBy) as Partial<Actor>;
		if (policy.humanOnly && decidedBy.kind !== "user") {
			x.log.info(`${policy.label}: ignoring a non-human approval`, {
				changeId,
				kind: decidedBy.kind,
			});
			if (mode === "adopt") needsHuman(x, ev, changeId, revision, head);
			return;
		}
		const d = dbOf(x.sql);
		let change = getChange(d, changeId);
		// The replay has read the change's submit already, if there was one.
		if (!change && mode === "live") {
			const submitted = await scanSubmitted(x, changeId);
			change = submitted ? recordRevision(x, submitted) : null;
		}
		if (!change) {
			x.log.warn("approval for a change without changes.submitted", {
				changeId,
			});
			return;
		}
		if (
			revision < change.revision ||
			(revision === change.revision && head !== change.head)
		) {
			x.log.info("ignoring an approval of an older revision", {
				changeId,
				revision,
				current: change.revision,
			});
			return;
		}
		const review: ReviewInfo = {
			route: str(data.route) ?? undefined,
			risk: typeof data.risk === "number" ? data.risk : undefined,
			decidedBy: decidedBy.kind && decidedBy.id
				? decidedBy as Actor
				: undefined,
		};
		const affected = json.decode<string[]>(change.affected_json, []);
		const partition = partitionKeyOf(affected);
		const t = now(x);
		// Queue order is approval order: the event's time, not delivery time.
		const at = Number.isFinite(ev.at) && ev.at > 0 ? ev.at : t;
		const enqueued = d.tx(
			(): "inserted" | "redelivered" | "adopted" | false => {
				const entry = getEntry(d, changeId);
				if (
					entry && (ACTIVE.includes(entry.state) || entry.state === "landed")
				) {
					return false;
				}
				// The same approval event never enqueues twice (a redelivery after
				// the entry moved on must not bring it back), except an entry this
				// installation released to another provider: the replay adopts it
				// again once this one provides queue@1 again.
				const released = entry?.state === "withdrawn" &&
					entry.reason === PROVIDER_CHANGED && mode === "adopt";
				if (entry && entry.review_event === ev.id && !released) {
					if (entry.state !== "waiting") return false;
					// The replay read this approval before its live delivery: the
					// approval is announced once, under the adoption's key, whichever
					// path gets there first (`settleAdoptions` skips it after this).
					if (
						mode === "live" &&
						(entry.reason === ADOPTING || entry.reason === ADOPTED)
					) {
						d.run(
							"UPDATE entries SET reason = ?, updated_at = ? WHERE change_id = ? AND reason = ?",
							ADOPTED,
							t,
							changeId,
							ADOPTING,
						);
						return "adopted";
					}
					return "redelivered";
				}
				// A replayed approval never rewrites an entry the live path queued
				// (its review event, attempts and solo flag stand).
				if (
					mode === "adopt" && entry?.state === "waiting" &&
					entry.reason !== ADOPTING
				) {
					return false;
				}
				d.run(
					`INSERT INTO entries (change_id, lane_id, head, affected_json, partition_key, priority,
				   enqueued_at, state, attempts, batch_id, depends_on, last_error, revision, review_event,
				   review_json, solo, withdraw_requested, reason, commit_sha, updated_at)
				 VALUES (?, ?, ?, ?, ?, 2, ?, 'waiting', 0, NULL, NULL, NULL, ?, ?, ?, 0, 0, ?, NULL, ?)
				 ON CONFLICT (change_id) DO UPDATE SET lane_id = excluded.lane_id, head = excluded.head,
				   affected_json = excluded.affected_json, partition_key = excluded.partition_key,
				   enqueued_at = CASE WHEN entries.state = 'waiting' THEN entries.enqueued_at
				     ELSE excluded.enqueued_at END,
				   state = 'waiting', attempts = 0, batch_id = NULL, last_error = NULL,
				   revision = excluded.revision, review_event = excluded.review_event,
				   review_json = excluded.review_json, solo = 0, withdraw_requested = 0,
				   reason = excluded.reason, commit_sha = NULL, updated_at = excluded.updated_at`,
					changeId,
					change!.lane_id,
					head,
					change!.affected_json,
					partition,
					at,
					revision,
					ev.id,
					json.encode(review),
					mode === "adopt" ? ADOPTING : null,
					t,
				);
				return "inserted";
			},
		);
		// A replayed approval waits for `settleAdoptions`; one the live path
		// already enqueued stays as it is.
		if (mode === "adopt") return;
		if (!enqueued) {
			x.log.info("approval for a change already in a batch or landed", {
				changeId,
			});
			return;
		}
		await emit(
			x,
			"queue.enqueued",
			{ changeId, partition },
			enqueued === "adopted" ? `adopted:${ev.id}` : `enqueued:${ev.id}`,
			changeId,
		);
		await wake(x, t + settingsOf(policy, x.config).debounceMs);
	};

	// -- provider hand-over (see the header) --------------------------------------

	/** Moves an entry to a final state without an event (replay, release). */
	const quietly = (
		x: ExtCtx,
		entry: EntryRow,
		state: "withdrawn" | "landed",
		why: string,
		reason: string | null = state === "withdrawn" ? "withdrawn" : null,
	): void => {
		dbOf(x.sql).run(
			"UPDATE entries SET state = ?, reason = ?, last_error = ?, updated_at = ? WHERE change_id = ? AND state = ?",
			state,
			reason,
			why.slice(0, 2000),
			now(x),
			entry.change_id,
			entry.state,
		);
	};

	/** Remembers a replayed approval FIFO declined, so the change can be told. */
	const needsHuman = (
		x: ExtCtx,
		ev: Envelope,
		changeId: string,
		revision: number,
		head: string,
	): void => {
		const d = dbOf(x.sql);
		const change = getChange(d, changeId);
		const entry = getEntry(d, changeId);
		if (!change || change.revision !== revision || change.head !== head) {
			return;
		}
		if (entry && (ACTIVE.includes(entry.state) || entry.state === "landed")) {
			return;
		}
		if (entry?.state === "waiting") return;
		d.run(
			`INSERT INTO entries (change_id, lane_id, head, affected_json, partition_key, priority,
			   enqueued_at, state, attempts, batch_id, depends_on, last_error, revision, review_event,
			   review_json, solo, withdraw_requested, reason, commit_sha, updated_at)
			 VALUES (?, ?, ?, ?, ?, 2, ?, 'withdrawn', 0, NULL, NULL, ?, ?, ?, '{}', 0, 0, ?, NULL, ?)
			 ON CONFLICT (change_id) DO UPDATE SET lane_id = excluded.lane_id, head = excluded.head,
			   state = 'withdrawn', revision = excluded.revision, review_event = excluded.review_event,
			   last_error = excluded.last_error, reason = excluded.reason, updated_at = excluded.updated_at`,
			changeId,
			change.lane_id,
			head,
			change.affected_json,
			partitionKeyOf(json.decode<string[]>(change.affected_json, [])),
			Number.isFinite(ev.at) && ev.at > 0 ? ev.at : now(x),
			`${policy.label} lands only changes a person approved`,
			revision,
			ev.id,
			NEEDS_HUMAN,
			now(x),
		);
	};

	/**
	 * Whether this installation provides queue@1 at its repo: true, false
	 * (another installation does, or none does), or null when the kernel
	 * cannot say right now (`caps.interfaces.provider`, a read).
	 */
	const providerHere = async (x: ExtCtx): Promise<boolean | null> => {
		try {
			const provider = await x.caps.interfaces.provider(
				"queue@1",
				repoRef(x),
			);
			return provider !== null && provider.self;
		} catch (e) {
			x.log.warn(`${policy.label}: cannot tell the queue@1 provider`, {
				error: errText(e),
			});
			return null;
		}
	};

	/**
	 * Hands the queue over (another installation provides queue@1 here):
	 * waiting entries and a batch not yet accepted are released without
	 * events; the new provider adopts what is still approved. An in-flight
	 * batch finishes under the watchdog.
	 */
	const release = (x: ExtCtx, why: string): void => {
		const d = dbOf(x.sql);
		const t = now(x);
		const released = d.tx(() => {
			const minted = d.all<{ batch_id: string }>(
				"SELECT batch_id FROM batches WHERE state = 'minted'",
			).map((b) => b.batch_id);
			d.run(
				`UPDATE batches SET state = 'refused', last_error = ?, finished_at = ?
				 WHERE batch_id IN (SELECT value FROM json_each(?))`,
				why.slice(0, 2000),
				t,
				json.encode(minted),
			);
			return d.run(
				`UPDATE entries SET state = 'withdrawn', reason = ?, batch_id = NULL, last_error = ?, updated_at = ?
				 WHERE state = 'waiting' OR (state = 'batched' AND batch_id IN (SELECT value FROM json_each(?)))`,
				PROVIDER_CHANGED,
				why.slice(0, 2000),
				t,
				json.encode(minted),
			).rowsWritten;
		});
		metaDelete(d, "paused");
		if (released > 0) {
			x.log.info(`${policy.label}: released ${released} entries`, { why });
		}
	};

	/** One replayed event of the adoption (quiet: no events, no tick). */
	const replay = async (ev: Envelope, x: ExtCtx): Promise<void> => {
		if (ev.shadow) return;
		const d = dbOf(x.sql);
		const changeId = str(rec(ev.data).changeId);
		switch (ev.type) {
			case "changes.submitted":
			case "changes.revised": {
				const change = recordRevision(x, ev);
				const entry = change ? getEntry(d, change.change_id) : null;
				if (entry?.state === "waiting" && entry.head !== change!.head) {
					quietly(x, entry, "withdrawn", "a new revision replaced it", "stale");
				}
				return;
			}
			case "changes.abandoned":
			case "changes.superseded": {
				if (!changeId) return;
				d.run(
					"UPDATE changes SET closed = 1, updated_at = ? WHERE change_id = ?",
					now(x),
					changeId,
				);
				const entry = getEntry(d, changeId);
				if (entry?.state === "waiting") {
					quietly(
						x,
						entry,
						"withdrawn",
						ev.type.replace("changes.", "change "),
					);
				}
				return;
			}
			case "changes.landed": {
				const entry = changeId ? getEntry(d, changeId) : null;
				if (entry?.state === "waiting") {
					quietly(x, entry, "landed", "landed by another queue");
				}
				return;
			}
			case "review.decided":
				return await decide(ev, x, "adopt");
		}
	};

	/**
	 * The end of a replay: each adopted entry whose lane is still
	 * `submitted` at the approved head is announced (`queue.enqueued`); one
	 * another queue's batch is landing stays `adopting` (`deferred`, looked
	 * at again later); the rest are withdrawn quietly; each change FIFO
	 * declined is told once.
	 */
	const settleAdoptions = async (
		x: ExtCtx,
	): Promise<{ adopted: number; deferred: number; more: boolean }> => {
		const d = dbOf(x.sql);
		const laneOf = async (
			entry: EntryRow,
		): Promise<"ok" | "landing" | "gone"> => {
			try {
				const lane = await x.caps.lanes.get(entry.lane_id);
				if (lane.quarantined || lane.head !== entry.head) return "gone";
				return lane.state === "submitted"
					? "ok"
					: lane.state === "landing"
					? "landing"
					: "gone";
			} catch {
				return "gone";
			}
		};
		const laneOk = async (entry: EntryRow): Promise<boolean> =>
			(await laneOf(entry)) === "ok";
		let adopted = 0;
		let deferred = 0;
		// Bounded per run (one lane read and one event each): the timer
		// re-arms at once while more are left. Deferred entries are touched,
		// so the next run reads the ones not looked at yet first.
		const pending = d.all<EntryRow>(
			"SELECT * FROM entries WHERE state = 'waiting' AND reason = ? ORDER BY updated_at, enqueued_at, change_id LIMIT ?",
			ADOPTING,
			SETTLE_MAX + 1,
		);
		const more = pending.length > SETTLE_MAX;
		pending.length = Math.min(pending.length, SETTLE_MAX);
		for (const entry of pending) {
			const lane = await laneOf(entry);
			if (lane === "landing") {
				d.run(
					"UPDATE entries SET updated_at = ? WHERE change_id = ? AND reason = ?",
					now(x),
					entry.change_id,
					ADOPTING,
				);
				deferred += 1;
				continue;
			}
			if (lane === "gone") {
				quietly(
					x,
					entry,
					"withdrawn",
					"adoption: the lane is no longer submitted at the approved head",
				);
				continue;
			}
			const settled = d.run(
				"UPDATE entries SET reason = ?, updated_at = ? WHERE change_id = ? AND state = 'waiting' AND reason = ?",
				ADOPTED,
				now(x),
				entry.change_id,
				ADOPTING,
			).rowsWritten;
			// The live delivery of the approval announced it meanwhile.
			if (settled === 0) continue;
			await emit(
				x,
				"queue.enqueued",
				{ changeId: entry.change_id, partition: entry.partition_key },
				`adopted:${entry.review_event}`,
				entry.change_id,
			);
			adopted += 1;
		}
		const declined = d.all<EntryRow>(
			"SELECT * FROM entries WHERE state = 'withdrawn' AND reason = ? LIMIT ?",
			NEEDS_HUMAN,
			SETTLE_MAX + 1,
		);
		const moreDeclined = declined.length > SETTLE_MAX;
		declined.length = Math.min(declined.length, SETTLE_MAX);
		for (const entry of declined) {
			d.run(
				"UPDATE entries SET reason = ?, updated_at = ? WHERE change_id = ? AND reason = ?",
				NEEDS_HUMAN_TOLD,
				now(x),
				entry.change_id,
				NEEDS_HUMAN,
			);
			if (!(await laneOk(entry))) continue;
			await emit(
				x,
				"queue.ejected",
				{
					changeId: entry.change_id,
					reason: "withdrawn",
					message:
						`${policy.label} lands only changes a person approved: approve this head to queue it`,
				},
				`needs-human:${entry.review_event}`,
				entry.change_id,
			);
		}
		// A run where every entry it read is still landing elsewhere does not
		// spin: those wait for the recheck.
		const progressed = deferred < pending.length;
		return {
			adopted,
			deferred,
			more: (more && progressed) || moreDeclined,
		};
	};

	/**
	 * The `adopt` timer: the provider in force replays the stream from its
	 * cursor (`ADOPT_PAGES` per run); another installation's provider
	 * releases instead and keeps its cursor.
	 */
	const adopt = async (x: ExtCtx): Promise<void> => {
		const d = dbOf(x.sql);
		if (x.install.mode === "shadow") return;
		const here = await providerHere(x);
		if (here !== true) {
			if (here === false) {
				release(x, "queue@1 is provided by another installation here");
			}
			await x.caps.timers.set(ADOPT, now(x) + ADOPT_MS);
			return;
		}
		let since = Number(metaGet(d, "adopt_since") ?? "0") || 0;
		for (let page = 0; page < ADOPT_PAGES; page += 1) {
			const events = await x.caps.events.read(
				`repo:${repoId(x)}`,
				since,
				[...ADOPT_PATTERNS],
				SCAN_PAGE,
			);
			if (events.length === 0) {
				const { adopted, deferred, more } = await settleAdoptions(x);
				if (more) {
					await x.caps.timers.set(ADOPT, now(x));
				} else {
					metaSet(d, "adopted_at", String(now(x)));
					await x.caps.timers.set(
						ADOPT,
						now(x) + (deferred > 0 ? ADOPT_RECHECK_MS : ADOPT_MS),
					);
				}
				if (adopted > 0) await wake(x, now(x));
				return;
			}
			for (const ev of events) await replay(ev, x);
			since = events[events.length - 1].seq;
			metaSet(d, "adopt_since", String(since));
		}
		// More to read: continue in the next run.
		await x.caps.timers.set(ADOPT, now(x));
	};

	// -- entry transitions --------------------------------------------------------

	type Drop = {
		readonly state: "ejected" | "withdrawn";
		readonly reason: EjectReason;
		readonly message: string;
		readonly paths?: readonly string[];
		readonly conflictsWith?: readonly string[];
		readonly regions?: unknown;
		readonly failing?: readonly string[];
	};

	/**
	 * Ejects or withdraws an entry: the state change, `queue.ejected`
	 * (idempotent per batch, change and head) and, for an ejection, the
	 * notify-author floor. A retried delivery re-runs only the idempotent
	 * effects.
	 */
	const drop = async (x: ExtCtx, entry: EntryRow, o: Drop): Promise<void> => {
		const d = dbOf(x.sql);
		const moved = d.tx(() => {
			const cur = getEntry(d, entry.change_id);
			if (!cur || FINAL.includes(cur.state)) return false;
			d.run(
				"UPDATE entries SET state = ?, reason = ?, last_error = ?, updated_at = ? WHERE change_id = ?",
				o.state,
				o.reason,
				o.message.slice(0, 2000),
				now(x),
				entry.change_id,
			);
			return true;
		});
		if (!moved) {
			const cur = getEntry(d, entry.change_id);
			const same = cur?.state === o.state && cur.batch_id === entry.batch_id &&
				cur.head === entry.head;
			if (!same) return;
		}
		await emit(
			x,
			"queue.ejected",
			{
				changeId: entry.change_id,
				reason: o.reason,
				...(o.paths ? { paths: [...o.paths] } : {}),
				...(o.conflictsWith ? { conflictsWith: [...o.conflictsWith] } : {}),
			},
			`ejected:${
				entry.batch_id ?? `q${entry.enqueued_at}`
			}:${entry.change_id}:${entry.head}`,
			entry.change_id,
		);
		if (o.state === "ejected") await notifyAuthor(x, entry, o);
	};

	/** Puts an entry of a finished batch back in the queue, keeping its place. */
	const requeue = async (
		x: ExtCtx,
		entry: EntryRow,
		o: { readonly solo: boolean; readonly bump: boolean; readonly why: string },
	): Promise<void> => {
		if (entry.withdraw_requested === 1) {
			await drop(x, entry, {
				state: "withdrawn",
				reason: "withdrawn",
				message: "withdrawn while in a batch",
			});
			return;
		}
		if (o.bump && entry.attempts + 1 > MAX_REQUEUES) {
			await drop(x, entry, {
				state: "ejected",
				reason: "failure",
				message: `requeued ${entry.attempts} times; last: ${o.why}`,
			});
			return;
		}
		const d = dbOf(x.sql);
		d.run(
			`UPDATE entries SET state = 'waiting', batch_id = NULL, attempts = attempts + ?,
			   solo = MAX(solo, ?), last_error = ?, updated_at = ?
			 WHERE change_id = ? AND state IN ('batched', 'landing')`,
			o.bump ? 1 : 0,
			o.solo ? 1 : 0,
			o.why.slice(0, 2000),
			now(x),
			entry.change_id,
		);
	};

	const markLanded = async (
		x: ExtCtx,
		entry: EntryRow,
		commit: string | null,
	): Promise<void> => {
		const d = dbOf(x.sql);
		const moved = d.tx(() => {
			const cur = getEntry(d, entry.change_id);
			if (!cur || cur.batch_id !== entry.batch_id) return false;
			if (cur.state === "landed") return true;
			if (!ACTIVE.includes(cur.state)) return false;
			d.run(
				"UPDATE entries SET state = 'landed', commit_sha = ?, last_error = NULL, updated_at = ? WHERE change_id = ?",
				commit,
				now(x),
				entry.change_id,
			);
			return true;
		});
		if (!moved || !entry.batch_id) return;
		await emit(
			x,
			"queue.landed",
			{
				changeId: entry.change_id,
				batchId: entry.batch_id,
				...(commit ? { commit } : {}),
			},
			`landed:${entry.batch_id}:${entry.change_id}`,
			entry.change_id,
		);
	};

	// -- the notify-author floor -----------------------------------

	type Intent = {
		readonly ref: string;
		readonly title: string;
		readonly why: string;
		readonly acceptance: readonly string[];
	};

	const intentOf = async (
		x: ExtCtx,
		ref: string | null,
	): Promise<Intent | null> => {
		if (!ref) return null;
		try {
			const item = rec(
				await x.caps.interfaces.call("work@1", "work_get", { ref }),
			);
			return {
				ref,
				title: str(item.title) ?? ref,
				why: typeof item.why === "string" ? item.why : "",
				acceptance: strs(item.acceptance).slice(0, 10),
			};
		} catch (e) {
			x.log.info("work_get failed", { ref, error: errText(e) });
			return null;
		}
	};

	const laneOwner = async (
		x: ExtCtx,
		laneId: string,
	): Promise<string | null> => {
		try {
			return (await x.caps.lanes.get(laneId)).owner;
		} catch {
			return null;
		}
	};

	const changedPaths = async (
		x: ExtCtx,
		change: ChangeRow,
	): Promise<string[]> => {
		if (!change.base) return [];
		try {
			const diff = await x.caps.repo.diffPaths(
				{ repoId: repoId(x), laneId: change.lane_id },
				change.base,
				change.head,
			);
			return diff.paths.slice(0, 50).map((p) => p.path);
		} catch (e) {
			x.log.info("diffPaths failed", {
				changeId: change.change_id,
				error: errText(e),
			});
			return [];
		}
	};

	const intentLine = (label: string, i: Intent | null): string =>
		i
			? `${label}: ${oneLine(i.title, 120)}${
				i.why ? ` (${oneLine(i.why, 160)})` : ""
			}.`
			: "";

	const notifyAuthor = async (
		x: ExtCtx,
		entry: EntryRow,
		o: Drop,
	): Promise<void> => {
		const d = dbOf(x.sql);
		const change = getChange(d, entry.change_id);
		const author = change?.author ?? await laneOwner(x, entry.lane_id);
		if (!author) {
			x.log.warn("no author to notify", { changeId: entry.change_id });
			return;
		}
		const title = change?.title ? ` "${oneLine(change.title, 80)}"` : "";
		const what = `${policy.label} ejected change ${entry.change_id}${title}`;
		let text: string;
		let data: Record<string, unknown> = {
			changeId: entry.change_id,
			laneId: entry.lane_id,
			head: entry.head,
			batchId: entry.batch_id,
			reason: o.reason,
		};
		if (o.reason === "conflict") {
			const others = (o.conflictsWith ?? []).map((id) => ({
				id,
				row: getChange(d, id),
			}));
			const mine = await intentOf(x, change?.work_ref ?? null);
			const theirs: Intent[] = [];
			const otherChanges: Record<string, unknown>[] = [];
			for (const other of others.slice(0, 3)) {
				const intent = await intentOf(x, other.row?.work_ref ?? null);
				if (intent) theirs.push(intent);
				otherChanges.push({
					changeId: other.id,
					...(other.row
						? {
							laneId: other.row.lane_id,
							head: other.row.head,
							base: other.row.base,
							workRef: other.row.work_ref,
							paths: await changedPaths(x, other.row),
						}
						: {}),
				});
			}
			const paths = (o.paths ?? []).slice(0, 5).join(", ");
			text = [
				`${what}: it conflicts at land time with ${
					others.length > 0 ? others.map((c) => c.id).join(", ") : "trunk"
				}${paths ? ` on ${paths}` : ""}.`,
				intentLine("Your intent", mine),
				...theirs.map((i) => intentLine(`Their intent (${i.ref})`, i)),
				"Rebase your lane onto trunk (git fetch origin main && git rebase FETCH_HEAD), resolve both intents and push a new revision; review and the queue run again.",
			].filter((s) => s.length > 0).join(" ");
			data = {
				...data,
				paths: [...(o.paths ?? [])],
				conflictsWith: [...(o.conflictsWith ?? [])],
				regions: o.regions ?? [],
				intents: { mine, theirs },
				others: otherChanges,
			};
		} else if (o.reason === "veto") {
			text = `${what}: a ref.advance gate vetoed it: ${
				oneLine(o.message, 300)
			}. Address the finding and push a new revision.`;
		} else {
			text = `${what}: ${oneLine(o.message, 300)}.${
				o.failing && o.failing.length > 0
					? ` Failing: ${o.failing.slice(0, 5).join(", ")}.`
					: ""
			} Fix it and push a new revision; review and the queue run again.`;
			if (o.failing) data = { ...data, failing: [...o.failing] };
		}
		try {
			await x.caps.notify.send(author, {
				repo: repoRef(x),
				laneId: entry.lane_id,
				kind: "eject",
				severity: "warn",
				text: truncateBytes(text, NOTICE_TEXT_BYTES),
				data,
				dedupeKey: `${policy.label}:eject:${entry.change_id}:${entry.head}:${
					entry.batch_id ?? "queue"
				}`,
			});
		} catch (e) {
			x.log.warn("notify author failed", {
				changeId: entry.change_id,
				error: errText(e),
			});
		}
	};

	// -- composing and submitting a batch -----------------------------------------

	/** Title, summary, author and K4 events of a change (cached in `changes`). */
	const changeInfo = async (
		x: ExtCtx,
		entry: EntryRow,
	): Promise<ChangeRow | null> => {
		const d = dbOf(x.sql);
		let change = getChange(d, entry.change_id);
		if (!change?.submitted_event) {
			const submitted = await scanSubmitted(x, entry.change_id);
			if (submitted) {
				recordRevision(x, submitted);
				d.run(
					"UPDATE changes SET submitted_event = ? WHERE change_id = ?",
					submitted.id,
					entry.change_id,
				);
				change = getChange(d, entry.change_id);
			}
		}
		if (!change) return null;
		if (change.title === null) {
			try {
				const got = rec(
					await x.caps.interfaces.call("changes@1", "changes_get", {
						changeId: entry.change_id,
					}),
				);
				d.run(
					"UPDATE changes SET title = ?, summary = ?, author = ?, work_ref = COALESCE(work_ref, ?) WHERE change_id = ?",
					str(got.title) ?? `Change ${entry.change_id}`,
					typeof got.summary === "string" ? got.summary : "",
					str(got.author),
					str(got.workRef),
					entry.change_id,
				);
			} catch (e) {
				x.log.info("changes_get failed; using a default title", {
					changeId: entry.change_id,
					error: errText(e),
				});
				d.run(
					"UPDATE changes SET title = ?, summary = '' WHERE change_id = ?",
					`Change ${entry.change_id}`,
					entry.change_id,
				);
			}
			change = getChange(d, entry.change_id);
		}
		if (change && change.author === null) {
			const owner = await laneOwner(x, entry.lane_id);
			if (owner) {
				d.run(
					"UPDATE changes SET author = ? WHERE change_id = ?",
					owner,
					entry.change_id,
				);
				change = { ...change, author: owner };
			}
		}
		return change;
	};

	const reviewTrailer = async (
		x: ExtCtx,
		review: ReviewInfo,
	): Promise<string> => {
		const by = review.decidedBy;
		if (review.route === "auto" || !by || by.kind !== "user") {
			return `auto(${(review.risk ?? 0).toFixed(2)})`;
		}
		try {
			const p = await x.caps.principals.get(by.id);
			return `human(@${oneLine(p.handle, 64)})`;
		} catch {
			return `human(${by.id})`;
		}
	};

	/** K4: the change's submit (and landed revision) plus the approval of that head. */
	const reasonEventsOf = (entry: EntryRow, change: ChangeRow): string[] => [
		...new Set(
			[
				change.submitted_event,
				entry.revision > 1 && change.revision === entry.revision
					? change.revised_event
					: null,
				entry.review_event,
			].filter((id): id is string => typeof id === "string"),
		),
	];

	const landChangeOf = async (
		x: ExtCtx,
		entry: EntryRow,
		change: ChangeRow,
	): Promise<LandChange> => {
		const review = json.decode<ReviewInfo>(entry.review_json, {});
		const trailers = [
			{ key: "Tartan-Change", value: entry.change_id },
			...(change.work_ref
				? [{ key: "Tartan-Work", value: oneLine(change.work_ref, 200) }]
				: []),
			{ key: "Tartan-Review", value: await reviewTrailer(x, review) },
		];
		return {
			changeId: entry.change_id,
			laneId: entry.lane_id,
			head: entry.head,
			title: oneLine(change.title ?? `Change ${entry.change_id}`, 200) ||
				`Change ${entry.change_id}`,
			message: truncateBytes(change.summary ?? "", SUMMARY_MAX_BYTES),
			trailers,
		};
	};

	/** Next waiting entries: a solo entry goes alone; others fill up to `batch`. */
	const pickWaiting = (d: Db, batch: number): EntryRow[] => {
		// An adopted entry waits until the replay checked its lane.
		const waiting = d.all<EntryRow>(
			`SELECT * FROM entries WHERE state = 'waiting' AND (reason IS NULL OR reason <> ?)
			 ORDER BY priority, enqueued_at, change_id LIMIT ?`,
			ADOPTING,
			batch,
		);
		if (waiting.length === 0) return [];
		if (waiting[0].solo === 1) return [waiting[0]];
		const picked: EntryRow[] = [];
		for (const e of waiting) {
			if (e.solo === 1) break;
			picked.push(e);
		}
		return picked;
	};

	const formBatch = async (x: ExtCtx): Promise<void> => {
		const d = dbOf(x.sql);
		const settings = settingsOf(policy, x.config);
		if (pickWaiting(d, settings.batch).length === 0) return;
		// Only the provider in force lands (hand-over, see the header); when
		// the kernel cannot say, wait rather than land as a replaced queue.
		const here = await providerHere(x);
		if (here === false) {
			release(x, "queue@1 is provided by another installation here");
			return;
		}
		if (here === null) {
			await wake(x, now(x) + PAUSE_RETRY_MS);
			return;
		}
		const picked = pickWaiting(d, settings.batch);
		if (picked.length === 0) return;
		const changes: LandChange[] = [];
		const events: string[] = [];
		const members: EntryRow[] = [];
		for (const entry of picked) {
			const change = await changeInfo(x, entry);
			if (!change?.submitted_event || !entry.review_event) {
				await drop(x, entry, {
					state: "ejected",
					reason: "failure",
					message:
						"no changes.submitted event for this change, so no K4 reason chain",
				});
				continue;
			}
			changes.push(await landChangeOf(x, entry, change));
			events.push(...reasonEventsOf(entry, change));
			members.push(entry);
		}
		if (members.length === 0) {
			await wake(x, now(x));
			return;
		}
		const seq = Number(metaGet(d, "batch_seq") ?? "0") + 1;
		const batchId = `lb_${x.caps.ids.ulid()}`;
		const partitions = [...new Set(members.map((m) => m.partition_key))];
		const request: LandRequest = {
			batchId,
			repo: repoRef(x),
			ref: await trunkRefOf(x),
			batch: changes,
			reason: {
				events: [...new Set(events)],
				entities: members.map((m) => ({ kind: "change", id: m.change_id })),
				summary: oneLine(
					`${policy.label} batch ${seq} [${partitions.join("; ")}]`,
					1000,
				),
			},
			testPolicy: "checks",
			partitionKey: "*",
		};
		const t = now(x);
		d.tx(() => {
			d.run(
				`INSERT INTO batches (batch_id, partition_key, change_ids_json, state, parent_batch, result_json,
				   created_at, finished_at, seq, request_json, phase, submit_tries, submitted_at, last_error)
				 VALUES (?, '*', ?, 'minted', NULL, NULL, ?, NULL, ?, ?, NULL, 0, NULL, NULL)`,
				batchId,
				json.encode(members.map((m) => m.change_id)),
				t,
				seq,
				json.encode(request),
			);
			for (const m of members) {
				d.run(
					"UPDATE entries SET state = 'batched', batch_id = ?, updated_at = ? WHERE change_id = ? AND state = 'waiting'",
					batchId,
					t,
					m.change_id,
				);
			}
			metaSet(d, "batch_seq", String(seq));
		});
		const batch = getBatch(d, batchId);
		if (batch) await submitBatch(x, batch);
	};

	const markSubmitted = (x: ExtCtx, batchId: string): boolean => {
		const d = dbOf(x.sql);
		return d.tx(() => {
			const t = now(x);
			const moved = d.run(
				"UPDATE batches SET state = 'submitted', submitted_at = ?, last_error = NULL WHERE batch_id = ? AND state = 'minted'",
				t,
				batchId,
			).rowsWritten > 0;
			d.run(
				"UPDATE entries SET state = 'landing', updated_at = ? WHERE batch_id = ? AND state = 'batched'",
				t,
				batchId,
			);
			return moved;
		});
	};

	const backoffMs = (tries: number): number =>
		Math.min(WATCH_MS, 5_000 * 2 ** Math.max(0, tries - 1));

	/** Submits the stored request (the same bytes on every retry). */
	const submitBatch = async (x: ExtCtx, batch: BatchRow): Promise<void> => {
		const d = dbOf(x.sql);
		const request = json.decode<LandRequest | null>(batch.request_json, null);
		if (!request) {
			await refuse(x, batch, "stored land request is unreadable");
			return;
		}
		await emit(
			x,
			"queue.batched",
			{
				batchId: batch.batch_id,
				partition: batch.partition_key,
				changes: request.batch.map((c) => c.changeId),
			},
			`batched:${batch.batch_id}`,
		);
		d.run(
			"UPDATE batches SET submit_tries = submit_tries + 1 WHERE batch_id = ?",
			batch.batch_id,
		);
		try {
			await x.caps.land.submit(request);
		} catch (e) {
			await onSubmitError(
				x,
				{ ...batch, submit_tries: batch.submit_tries + 1 },
				e,
			);
			return;
		}
		markSubmitted(x, batch.batch_id);
		metaDelete(d, "paused");
		await wake(x, now(x) + WATCH_MS);
	};

	const pause = async (x: ExtCtx, why: string): Promise<void> => {
		const d = dbOf(x.sql);
		if (metaGet(d, "paused") === null) {
			const since = String(now(x));
			metaSet(d, "paused", json.encode({ why, since }));
			await emit(
				x,
				"queue.paused",
				{ reason: oneLine(why, 500) },
				`paused:${since}`,
			);
		}
	};

	const TRANSIENT = new Set([
		"internal",
		"unavailable",
		"timeout",
		"rate_limited",
		"not_implemented",
	]);
	/**
	 * Refusals that clear by themselves: a lane-sync job still holds the lane,
	 * so the freeze to `landing` was refused; nothing was created.
	 */
	const TRANSIENT_REASONS = new Set(["lane-git-job"]);

	const onSubmitError = async (
		x: ExtCtx,
		batch: BatchRow,
		error: unknown,
	): Promise<void> => {
		const d = dbOf(x.sql);
		const e = fromRpcError(error);
		const text = errText(error);
		if (TRANSIENT.has(e.code) || TRANSIENT_REASONS.has(e.reason ?? "")) {
			// The kernel may have created the batch before the answer was lost:
			// keep it minted and resubmit the stored request (idempotent).
			d.run(
				"UPDATE batches SET last_error = ? WHERE batch_id = ?",
				text.slice(0, 2000),
				batch.batch_id,
			);
			await wake(x, now(x) + backoffMs(batch.submit_tries));
			return;
		}
		if (e.code === "denied" && NOT_PROVIDER.test(text)) {
			// The kernel lands only for the queue@1 provider in force: hand over.
			release(x, `land.submit refused: ${text}`);
			return;
		}
		if (e.code === "denied") {
			d.run(
				"UPDATE batches SET last_error = ? WHERE batch_id = ?",
				text.slice(0, 2000),
				batch.batch_id,
			);
			await pause(
				x,
				e.reason === "landing-paused"
					? "landing is paused until an Owner acknowledges (K1)"
					: `land.submit denied: ${e.reason ?? e.text}`,
			);
			await wake(x, now(x) + PAUSE_RETRY_MS);
			return;
		}
		await refuse(x, batch, text);
	};

	/**
	 * The kernel refused the batch (nothing was created): drop the culprits it
	 * can name from lane state, requeue the rest. Without a culprit, a batch
	 * of several changes retries each change alone; a change refused alone is
	 * ejected.
	 */
	const refuse = async (
		x: ExtCtx,
		batch: BatchRow,
		why: string,
	): Promise<void> => {
		const d = dbOf(x.sql);
		const members = entriesOfBatch(d, batch.batch_id).filter((e) =>
			e.state === "batched"
		);
		const culprits = new Map<string, Drop>();
		/** Changes another batch is landing: left to it, without an event. */
		const elsewhere = new Set<string>();
		for (const entry of members) {
			try {
				const lane = await x.caps.lanes.get(entry.lane_id);
				if (lane.quarantined) {
					culprits.set(entry.change_id, {
						state: "ejected",
						reason: "failure",
						message: `lane ${entry.lane_id} is quarantined (K2)`,
					});
				} else if (lane.head !== entry.head) {
					culprits.set(entry.change_id, {
						state: "withdrawn",
						reason: "stale",
						message: `head-moved: the lane is at ${
							lane.head ?? "nothing"
						}, the approval names ${entry.head}`,
					});
				} else if (lane.state === "landing") {
					// This batch created nothing, so another batch (another
					// queue@1 provider's, after a swap) is landing the lane.
					elsewhere.add(entry.change_id);
				} else if (lane.state !== "submitted") {
					culprits.set(entry.change_id, {
						state: "withdrawn",
						reason: "withdrawn",
						message: `lane ${entry.lane_id} is ${lane.state}`,
					});
				}
			} catch (e) {
				if (fromRpcError(e).code === "not_found") {
					culprits.set(entry.change_id, {
						state: "ejected",
						reason: "failure",
						message: `lane ${entry.lane_id} not found`,
					});
				}
			}
		}
		d.run(
			"UPDATE batches SET state = 'refused', last_error = ?, finished_at = ? WHERE batch_id = ? AND state = 'minted'",
			why.slice(0, 2000),
			now(x),
			batch.batch_id,
		);
		for (const entry of members) {
			const culprit = culprits.get(entry.change_id);
			if (elsewhere.has(entry.change_id)) {
				// Left to that batch, quietly, but kept: if it fails there, the
				// adoption's recheck announces the change and queues it here.
				d.run(
					`UPDATE entries SET state = 'waiting', reason = ?, batch_id = NULL, last_error = ?,
					   updated_at = ? WHERE change_id = ? AND state = 'batched'`,
					ADOPTING,
					"another batch is landing this change",
					now(x),
					entry.change_id,
				);
			} else if (culprit) {
				await drop(x, entry, culprit);
			} else if (culprits.size > 0 || elsewhere.size > 0) {
				await requeue(x, entry, { solo: false, bump: false, why });
			} else if (members.length > 1) {
				await requeue(x, entry, { solo: true, bump: true, why });
			} else {
				await drop(x, entry, {
					state: "ejected",
					reason: "failure",
					message: `land.submit refused: ${why}`,
				});
			}
		}
		if (elsewhere.size > 0) {
			await x.caps.timers.set(ADOPT, now(x) + ADOPT_RECHECK_MS);
		}
		await wake(x, now(x));
	};

	// -- batch outcomes -----------------------------------------------------------

	const finishBatch = (
		x: ExtCtx,
		batchId: string,
		state: "done" | "failed",
		outcome: unknown,
	): void => {
		dbOf(x.sql).run(
			`UPDATE batches SET state = ?, result_json = ?, finished_at = ?
			 WHERE batch_id = ? AND state IN ('minted', 'submitted')`,
			state,
			json.encode(outcome),
			now(x),
			batchId,
		);
	};

	const completed = async (
		x: ExtCtx,
		batch: BatchRow,
		o: {
			readonly landed: readonly { changeId: string; commit: string | null }[];
			readonly conflicted: readonly string[];
			readonly vetoed: readonly string[];
		},
	): Promise<void> => {
		const d = dbOf(x.sql);
		markSubmitted(x, batch.batch_id);
		const members = new Map(
			entriesOfBatch(d, batch.batch_id).map((e) => [e.change_id, e]),
		);
		for (const l of o.landed) {
			const entry = members.get(l.changeId);
			if (entry) await markLanded(x, entry, l.commit);
		}
		for (
			const [ids, reason] of [
				[o.conflicted, "conflict"],
				[o.vetoed, "veto"],
			] as const
		) {
			for (const id of ids) {
				const entry = members.get(id);
				if (entry && ACTIVE.includes(entry.state)) {
					await drop(x, entry, {
						state: "ejected",
						reason,
						message: reason === "conflict"
							? "conflicted at land time"
							: "vetoed at land time",
					});
				}
			}
		}
		for (const entry of entriesOfBatch(d, batch.batch_id)) {
			if (ACTIVE.includes(entry.state)) {
				await requeue(x, entry, {
					solo: false,
					bump: true,
					why: "batch completed without this change",
				});
			}
		}
		finishBatch(x, batch.batch_id, "done", o);
		await wake(x, now(x));
	};

	const failed = async (
		x: ExtCtx,
		batch: BatchRow,
		o: {
			readonly reason: string;
			readonly failing: readonly string[];
			readonly message?: string;
		},
	): Promise<void> => {
		const d = dbOf(x.sql);
		markSubmitted(x, batch.batch_id);
		const remaining = entriesOfBatch(d, batch.batch_id).filter((e) =>
			ACTIVE.includes(e.state)
		);
		const why = `land.failed (${o.reason})${
			o.message ? `: ${oneLine(o.message, 300)}` : ""
		}`;
		if (o.reason === "tests" && remaining.length === 1) {
			await drop(x, remaining[0], {
				state: "ejected",
				reason: "failure",
				message: `checks failed on the land candidate${
					o.message ? `: ${oneLine(o.message, 300)}` : ""
				}`,
				failing: o.failing,
			});
		} else if (o.reason === "tests") {
			// Bisect is M2: retry each change alone, so only the culprit is ejected.
			for (const entry of remaining) {
				await requeue(x, entry, { solo: true, bump: false, why });
			}
		} else if (o.reason === "trunk-unexplained") {
			for (const entry of remaining) {
				await requeue(x, entry, { solo: false, bump: false, why });
			}
			await pause(x, "trunk moved outside Tartan; landing is paused (K1)");
		} else if (o.reason === "config-hold") {
			// K9: the repository-config hold delays a land, never vetoes it.
			for (const entry of remaining) {
				await requeue(x, entry, { solo: false, bump: false, why });
			}
		} else {
			for (const entry of remaining) {
				await requeue(x, entry, { solo: false, bump: true, why });
			}
		}
		finishBatch(x, batch.batch_id, "failed", o);
		await wake(
			x,
			now(x) +
				(o.reason === "trunk-unexplained"
					? PAUSE_RETRY_MS
					: o.reason === "config-hold"
					? CONFIG_HOLD_RETRY_MS
					: 0),
		);
	};

	/** Watchdog: applies a terminal `land.status` the events have not delivered yet. */
	const watchBatch = async (x: ExtCtx, batch: BatchRow): Promise<void> => {
		let status: LandStatus;
		try {
			status = await x.caps.land.status(batch.batch_id);
		} catch (e) {
			x.log.info("land.status failed", {
				batchId: batch.batch_id,
				error: errText(e),
			});
			await wake(x, now(x) + WATCH_MS);
			return;
		}
		const outcome = (k: string) =>
			status.changes.filter((c) => c.outcome === k);
		switch (status.state) {
			case "landed":
			case "conflicted":
			case "vetoed":
				await completed(x, batch, {
					landed: outcome("landed").map((c) => ({
						changeId: c.changeId,
						commit: c.commit ?? null,
					})),
					conflicted: outcome("conflicted").map((c) => c.changeId),
					vetoed: outcome("vetoed").map((c) => c.changeId),
				});
				return;
			case "failed":
			case "cancelled":
				await failed(x, batch, {
					reason: str(rec(status.result).reason) ??
						(status.state === "cancelled" ? "abandoned" : "error"),
					failing: strs(rec(status.result).failing),
				});
				return;
			default:
				dbOf(x.sql).run(
					"UPDATE batches SET phase = ? WHERE batch_id = ?",
					status.state,
					batch.batch_id,
				);
				await wake(x, now(x) + WATCH_MS);
		}
	};

	const tick = async (x: ExtCtx): Promise<void> => {
		const d = dbOf(x.sql);
		metaDelete(d, "next_tick");
		if (x.install.mode === "shadow") return;
		const inflight = inflightBatch(d);
		if (inflight?.state === "minted") return await submitBatch(x, inflight);
		if (inflight) return await watchBatch(x, inflight);
		await formBatch(x);
	};

	// -- land events --------------------------------------------------------------

	const onLand = async (ev: Envelope, x: ExtCtx): Promise<void> => {
		const data = rec(ev.data);
		const batchId = str(data.batchId);
		if (!batchId) return;
		const d = dbOf(x.sql);
		const batch = getBatch(d, batchId);
		if (!batch) return; // another provider's batch
		const changeId = str(data.changeId);
		const entry = changeId ? getEntry(d, changeId) : null;
		const inBatch = entry !== null && entry.batch_id === batchId;
		switch (ev.type) {
			case "land.submitted":
				if (markSubmitted(x, batchId)) await wake(x, now(x) + WATCH_MS);
				return;
			case "land.testing":
				d.run(
					"UPDATE batches SET phase = 'testing' WHERE batch_id = ?",
					batchId,
				);
				return;
			case "land.conflicted":
				if (inBatch) {
					await drop(x, entry, {
						state: "ejected",
						reason: "conflict",
						message: "conflicted at land time",
						paths: strs(data.paths),
						conflictsWith: strs(data.conflictsWith),
						regions: Array.isArray(data.regions) ? data.regions : [],
					});
				}
				return;
			case "land.vetoed":
				if (inBatch) {
					await drop(x, entry, {
						state: "ejected",
						reason: "veto",
						message: typeof data.message === "string" ? data.message : "vetoed",
					});
				}
				return;
			case "land.failed":
				await failed(x, batch, {
					reason: str(data.reason) ?? "error",
					failing: strs(data.failing),
					message: typeof data.message === "string" ? data.message : undefined,
				});
				return;
			case "land.completed":
				await completed(x, batch, {
					landed: (Array.isArray(data.landed) ? data.landed : []).map((l) => ({
						changeId: str(rec(l).changeId) ?? "",
						commit: sha(rec(l).commit),
					})).filter((l) => l.changeId !== ""),
					conflicted: strs(data.conflicted),
					vetoed: strs(data.vetoed),
				});
				return;
		}
	};

	const onAdvanced = async (ev: Envelope, x: ExtCtx): Promise<void> => {
		const d = dbOf(x.sql);
		const changes = rec(ev.data).changes;
		for (const c of Array.isArray(changes) ? changes : []) {
			const changeId = str(rec(c).changeId);
			const entry = changeId ? getEntry(d, changeId) : null;
			if (entry && ACTIVE.includes(entry.state)) {
				await markLanded(x, entry, sha(rec(c).commit));
			} else if (entry?.state === "waiting") {
				// Landed by another batch (another queue@1 provider, before a
				// swap back): nothing is left to land here.
				quietly(x, entry, "landed", "landed by another queue");
			}
		}
	};

	// -- queue@1 tools and the withdraw action ------------------------------------

	const positionOf = (d: Db): Map<string, number> => {
		const rows = d.all<{ change_id: string }>(
			"SELECT change_id FROM entries WHERE state = 'waiting' ORDER BY priority, enqueued_at, change_id",
		);
		return new Map(rows.map((r, i) => [r.change_id, i + 1]));
	};

	const toQueueEntry = (
		e: EntryRow,
		positions: Map<string, number>,
	): QueueEntry => ({
		changeId: e.change_id,
		partition: e.partition_key,
		position: positions.get(e.change_id) ?? 0,
		state: e.state,
		...(e.batch_id ? { batchId: e.batch_id } : {}),
	});

	const queueStatus = (x: ExtCtx) => {
		const d = dbOf(x.sql);
		const positions = positionOf(d);
		const rows = d.all<EntryRow>(
			`SELECT * FROM entries WHERE state IN ('waiting', 'batched', 'landing')
			 ORDER BY CASE state WHEN 'waiting' THEN 1 ELSE 0 END, priority, enqueued_at, change_id`,
		);
		const byPartition = new Map<string, QueueEntry[]>();
		for (const row of rows) {
			const list = byPartition.get(row.partition_key) ?? [];
			list.push(toQueueEntry(row, positions));
			byPartition.set(row.partition_key, list);
		}
		return {
			partitions: [...byPartition].map(([key, entries]) => ({ key, entries })),
			paused: metaGet(d, "paused") !== null,
		};
	};

	const parseArgs = <T>(tool: keyof typeof QUEUE_TOOLS, args: unknown): T => {
		const parsed = QUEUE_TOOLS[tool].input.safeParse(args ?? {});
		if (!parsed.success) {
			throw invalid(
				`${tool}: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
			);
		}
		return parsed.data as T;
	};

	/** The change's author (or the user it acts for) or a Maintainer+ of the repo. */
	const mayWithdraw = async (
		x: ExtCtx,
		actor: Actor,
		entry: EntryRow,
	): Promise<boolean> => {
		const d = dbOf(x.sql);
		const author = getChange(d, entry.change_id)?.author ??
			await laneOwner(x, entry.lane_id);
		const acting = actingPrincipals({ actor });
		if (author !== null && acting.includes(author)) return true;
		try {
			return await x.caps.authz.check(actor.id, repoRef(x), "approve");
		} catch {
			return false;
		}
	};

	/**
	 * `queue_withdraw`: a waiting entry leaves at once; a batched change is
	 * released only when its batch ends (it is not landed if it fails).
	 */
	const withdraw = async (
		x: ExtCtx,
		actor: Actor,
		changeId: string,
		why: string | undefined,
	): Promise<{ ok: boolean; state: EntryState }> => {
		const d = dbOf(x.sql);
		const entry = getEntry(d, changeId);
		if (!entry) throw notFound(`change ${changeId} is not queued`);
		if (!(await mayWithdraw(x, actor, entry))) {
			throw denied(
				"role",
				"only the change's author or a Maintainer+ may withdraw it",
			);
		}
		if (entry.state === "waiting") {
			await drop(x, entry, {
				state: "withdrawn",
				reason: "withdrawn",
				message: why ?? `withdrawn by ${actor.id}`,
			});
			return { ok: true, state: "withdrawn" };
		}
		if (ACTIVE.includes(entry.state)) {
			d.run(
				"UPDATE entries SET withdraw_requested = 1, updated_at = ? WHERE change_id = ?",
				now(x),
				changeId,
			);
			return { ok: true, state: entry.state };
		}
		return { ok: false, state: entry.state };
	};

	const enqueue = async (
		x: ExtCtx,
		actor: Actor,
		changeId: string,
	): Promise<QueueEntry> => {
		const d = dbOf(x.sql);
		const entry = getEntry(d, changeId);
		const change = getChange(d, changeId);
		// The documented precondition (K12): an approval of the change's current
		// head is on record (`review_event`), from a user for FIFO.
		const review = entry ? json.decode<ReviewInfo>(entry.review_json, {}) : {};
		const approved = entry !== null && entry.review_event !== null &&
			(change === null || change.head === entry.head) &&
			(!policy.humanOnly || review.decidedBy?.kind === "user");
		requireInteractiveActor(x, "queue_enqueue", () => approved);
		if (!entry || !approved) {
			throw invalid(
				`${changeId} has no ${
					policy.humanOnly ? "human " : ""
				}approval of its current head; it is enqueued when review approves it`,
			);
		}
		// Undoing a withdrawal (a withdrawn entry, or a pending withdraw of a
		// batched one) needs the authority that withdrew it: the author or a
		// Maintainer+. An ejected entry keeps the rule above.
		const undoesWithdraw = entry.state === "withdrawn" ||
			(ACTIVE.includes(entry.state) && entry.withdraw_requested === 1);
		if (undoesWithdraw && !(await mayWithdraw(x, actor, entry))) {
			throw denied(
				"role",
				"only the change's author or a Maintainer+ may re-enqueue a withdrawn change",
			);
		}
		if (entry.state === "withdrawn" || entry.state === "ejected") {
			if (entry.state === "ejected" && entry.reason === "conflict") {
				throw invalid(
					`${changeId} was ejected for a conflict; push a new revision`,
				);
			}
			const t = now(x);
			d.run(
				`UPDATE entries SET state = 'waiting', batch_id = NULL, attempts = 0, solo = 0,
				   withdraw_requested = 0, reason = NULL, last_error = NULL, enqueued_at = ?, updated_at = ?
				 WHERE change_id = ?`,
				t,
				t,
				changeId,
			);
			await emit(
				x,
				"queue.enqueued",
				{ changeId, partition: entry.partition_key },
				`enqueued:${entry.review_event}:${t}`,
				changeId,
			);
			await wake(x, t + settingsOf(policy, x.config).debounceMs);
		} else if (ACTIVE.includes(entry.state) && entry.withdraw_requested) {
			d.run(
				"UPDATE entries SET withdraw_requested = 0 WHERE change_id = ?",
				changeId,
			);
		}
		const row = getEntry(d, changeId)!;
		return toQueueEntry(row, positionOf(d));
	};

	const callTool = async (
		name: string,
		args: unknown,
		ctx: ToolContext,
		x: ExtCtx,
	): Promise<unknown> => {
		switch (name) {
			case "queue_status":
				parseArgs("queue_status", args);
				return queueStatus(x);
			case "queue_enqueue": {
				const a = parseArgs<{ changeId: string }>("queue_enqueue", args);
				return await enqueue(x, ctx.actor, a.changeId);
			}
			case "queue_withdraw": {
				const a = parseArgs<{ changeId: string; reason?: string }>(
					"queue_withdraw",
					args,
				);
				const out = await withdraw(x, ctx.actor, a.changeId, a.reason);
				return { ok: out.ok, state: out.state };
			}
			default:
				throw notFound(`${policy.extId} has no tool ${name}`);
		}
	};

	// -- slots and context ----------------------------------------------------------

	const TONE: Record<EntryState, Tone> = {
		waiting: "neutral",
		batched: "info",
		landing: "info",
		landed: "success",
		ejected: "danger",
		withdrawn: "muted",
	};

	const queueTab = (x: ExtCtx): UiDoc => {
		const d = dbOf(x.sql);
		const positions = positionOf(d);
		const paused = json.decode<{ why?: string } | null>(
			metaGet(d, "paused"),
			null,
		);
		const inflight = inflightBatch(d);
		const waiting = d.all<EntryRow>(
			"SELECT * FROM entries WHERE state = 'waiting' ORDER BY priority, enqueued_at, change_id LIMIT 100",
		);
		const recent = d.all<EntryRow>(
			"SELECT * FROM entries WHERE state IN ('landed', 'ejected', 'withdrawn') ORDER BY updated_at DESC LIMIT ?",
			RECENT_LIMIT,
		);
		const title = (id: string): string => getChange(d, id)?.title ?? id;
		const children: UiNode[] = [
			ui.heading(policy.label === "fifo" ? "FIFO queue" : "Weave", 2),
		];
		if (paused) {
			children.push(
				ui.alert("warning", "Landing paused", ui.text(paused.why ?? "")),
			);
		}
		children.push(
			ui.section("In flight", [
				inflight
					? ui.stack([
						ui.kv([
							{ k: "Batch", v: ui.text(inflight.batch_id, { mono: true }) },
							{
								k: "State",
								v: ui.badge(inflight.phase ?? inflight.state, "info"),
							},
							{ k: "Number", v: String(inflight.seq) },
						]),
						ui.table(
							["Change", "Title", "State"],
							entriesOfBatch(d, inflight.batch_id).map((e) => [
								ui.text(e.change_id, { mono: true }),
								title(e.change_id),
								ui.badge(e.state, TONE[e.state]),
							]),
						),
					])
					: ui.empty("No batch in flight"),
			]),
			ui.section(`Waiting (${waiting.length})`, [
				waiting.length > 0
					? ui.table(
						["#", "Change", "Title", "Projects", ""],
						waiting.map((e) => [
							positions.get(e.change_id) ?? 0,
							ui.text(e.change_id, { mono: true }),
							title(e.change_id),
							e.partition_key,
							ui.button(
								"Withdraw",
								ui.action(
									"withdraw",
									{ changeId: e.change_id },
									"Withdraw this change from the queue?",
								),
								"danger",
							),
						]),
					)
					: ui.empty("Nothing waiting"),
			]),
			ui.section("Recent", [
				recent.length > 0
					? ui.table(
						["Change", "Title", "Outcome", "Detail"],
						recent.map((e) => [
							ui.text(e.change_id, { mono: true }),
							title(e.change_id),
							ui.badge(e.state, TONE[e.state]),
							e.state === "landed"
								? ui.text(e.commit_sha ?? "", { mono: true })
								: oneLine(e.last_error ?? e.reason ?? "", 200),
						]),
					)
					: ui.empty("Nothing landed yet"),
			]),
		);
		return ui.doc(ui.stack(children), { refreshOn: ["queue.*", "land.*"] });
	};

	const positionPanel = (x: ExtCtx, ctx: SlotContext): UiDoc => {
		const d = dbOf(x.sql);
		const changeId = ctx.entity?.kind === "change" ? ctx.entity.id : null;
		const entry = changeId ? getEntry(d, changeId) : null;
		if (!entry) {
			return ui.doc(
				ui.empty(
					"Not queued",
					"The change is enqueued when review approves it.",
				),
				{
					refreshOn: ["queue.*", "land.*"],
				},
			);
		}
		const position = positionOf(d).get(entry.change_id);
		const items: { k: string; v: string | UiNode }[] = [
			{ k: "State", v: ui.badge(entry.state, TONE[entry.state]) },
		];
		if (position !== undefined) {
			items.push({ k: "Position", v: String(position) });
		}
		if (entry.batch_id) {
			items.push({ k: "Batch", v: ui.text(entry.batch_id, { mono: true }) });
		}
		items.push({
			k: "Head",
			v: ui.text(entry.head.slice(0, 12), { mono: true }),
		});
		if (entry.commit_sha) {
			items.push({
				k: "Commit",
				v: ui.text(entry.commit_sha.slice(0, 12), { mono: true }),
			});
		}
		if (entry.state === "ejected" || entry.state === "withdrawn") {
			items.push({
				k: "Why",
				v: oneLine(entry.last_error ?? entry.reason ?? "", 300),
			});
		}
		return ui.doc(
			ui.section(policy.label === "fifo" ? "FIFO" : "Weave", [ui.kv(items)]),
			{
				refreshOn: ["queue.*", "land.*"],
			},
		);
	};

	const landedPerHour = (x: ExtCtx): UiDoc => {
		const d = dbOf(x.sql);
		const n = d.value<number>(
			"SELECT COUNT(*) FROM entries WHERE state = 'landed' AND updated_at >= ?",
			now(x) - 3_600_000,
		) ?? 0;
		return ui.doc(ui.stat("Landed / hour", Number(n)), {
			refreshOn: ["queue.landed"],
		});
	};

	const render = (
		slot: string,
		ctx: SlotContext,
		_props: unknown,
		x: ExtCtx,
	): Promise<UiDoc> => {
		switch (slot) {
			case "weave":
			case "queue":
				return Promise.resolve(queueTab(x));
			case "position":
				return Promise.resolve(positionPanel(x, ctx));
			case "landed-per-hour":
				return Promise.resolve(landedPerHour(x));
			default:
				return Promise.resolve(
					ui.doc(ui.empty(`${policy.extId}: unknown slot ${slot}`)),
				);
		}
	};

	const onAction = async (
		action: string,
		payload: unknown,
		ctx: SlotContext,
		x: ExtCtx,
	) => {
		if (action !== "withdraw") {
			return result.toast("danger", `unknown action ${action}`);
		}
		const changeId = str(rec(payload).changeId);
		if (!changeId) return result.toast("danger", "changeId required");
		const actor = ctx.viewer ?? x.actor;
		try {
			const out = await withdraw(x, actor, changeId, undefined);
			return out.state === "withdrawn"
				? result.toast("success", `${changeId} withdrawn`)
				: result.toast(
					"info",
					`${changeId} leaves the queue when its batch ends`,
				);
		} catch (e) {
			return result.toast("danger", fromRpcError(e).text);
		}
	};

	/** `weave-health`: where the asking lane's change stands, and the queue depth. */
	const context = (
		req: ContextRequest,
		x: ExtCtx,
	): Promise<ContextSection[]> => {
		const d = dbOf(x.sql);
		const depth = d.value<number>(
			"SELECT COUNT(*) FROM entries WHERE state IN ('waiting', 'batched', 'landing')",
		) ?? 0;
		const lines = [`${policy.label}: ${depth} change(s) queued or landing.`];
		if (req.laneId) {
			const entry = d.first<EntryRow>(
				"SELECT * FROM entries WHERE lane_id = ? ORDER BY updated_at DESC LIMIT 1",
				req.laneId,
			);
			if (entry) {
				const position = positionOf(d).get(entry.change_id);
				lines.push(
					`Your change ${entry.change_id} is ${entry.state}${
						position !== undefined ? ` at position ${position}` : ""
					}${
						entry.state === "ejected"
							? `: ${oneLine(entry.last_error ?? entry.reason ?? "", 300)}`
							: ""
					}.`,
				);
			}
		}
		if (metaGet(d, "paused") !== null) lines.push("Landing is paused.");
		const md = truncateBytes(lines.join("\n"), req.maxBytes);
		return Promise.resolve([{
			id: policy.label === "fifo" ? "queue-health" : "weave-health",
			priority: "hints",
			md,
		}]);
	};

	return defineExtension({
		init: async (x: ExtCtx) => {
			const d = dbOf(x.sql);
			if (x.install.mode === "shadow") return;
			// Adopt what was approved before this provider took the repo over
			// (or while it did not provide queue@1 here), then every ADOPT_MS.
			await x.caps.timers.set(ADOPT, now(x));
			const pending = inflightBatch(d) !== null ||
				d.value<number>(
						"SELECT COUNT(*) FROM entries WHERE state = 'waiting'",
					) !== 0;
			if (pending) {
				metaDelete(d, "next_tick");
				await wake(x, now(x));
			}
		},
		onEvent: async (ev: Envelope, x: ExtCtx) => {
			// Shadow events never drive the train (K4: non-shadow approvals only).
			if (ev.shadow) return;
			switch (ev.type) {
				case "changes.submitted":
				case "changes.revised":
					return await onRevision(ev, x);
				case "changes.abandoned":
				case "changes.superseded":
					return await onClosed(ev, x);
				case "review.decided":
					return await onDecided(ev, x);
				case "ref.advanced":
					return await onAdvanced(ev, x);
				default:
					if (ev.type.startsWith("land.")) return await onLand(ev, x);
			}
		},
		onTimer: async (key: string, x: ExtCtx) => {
			if (key === TICK) await tick(x);
			else if (key === ADOPT) await adopt(x);
		},
		render,
		onAction,
		callTool,
		context,
	});
};
