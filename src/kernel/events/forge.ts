// ForgeDO `events` module (WP6, migrations 400–449; K12): the forge stream
// (`node.*`, `principal.*`, `extension.*`, `repo.created/imported`) and the
// audit log.
//
// - `appendSync` joins the caller's transaction (K3 for forge-level changes),
//   is idempotent on `idemKey`, and accepts only kernel types whose stream is
//   `forge` or `both`, with their payload schema. Forge events carry no hash
//   chain (the envelope's `hash` is for repo streams).
// - `read` filters by the reader's subtree when `subtreeNodeId` is set (K12).
// - Pokes: after commit, coalesced like the repo stream, each node-scoped
//   installation in force at an event's node whose manifest subscribes to a
//   matching pattern is poked with `{stream: "forge", head}`.
// - `audit`: logins, tokens, grants, installs, setup, swarm; target and
//   data are redacted (`redactSecrets`) and data is capped at 16 KB.
//
// DDL: the forge event and audit tables plus `idem_key` on `forge_events`
// (the facade is idempotent on it).
//
// The global log relay (WP26) reads the forge stream through the internal
// API: `readSync`, `epochSync`, `oldestSeqSync`, `onAppendSync` and `onFlush`,
// as on RepoDO (`./repo.ts`). Forge events carry no chain.

import { z } from "zod";
import {
	type Actor,
	ActorSchema,
	byteLength,
	type Envelope,
	EVENT_DATA_MAX_BYTES,
	extDoName,
	invalid,
	isKernelEventType,
	KERNEL_EVENT_STREAMS,
	matchesEventPattern,
	redactSecrets,
	tartanError,
	UlidSchema,
	validateEventData,
} from "@tartan/contract";
import {
	type AuditRow,
	type DoModule,
	type ForgeEventRow,
	type ForgeEventsFacade,
	type ForgeEventsInternal,
	type ForgeInternals,
	type Migration,
	MIGRATION_RANGES,
} from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import type {
	AppendHook,
	EventLogRow,
	EventsRelaySource,
} from "../bus/contract.ts";
import { createCoalescer, type Schedule, timerSchedule } from "./coalesce.ts";
import { visibleInSubtree } from "./forge-filter.ts";
import { checkPatterns, patternClause, READ_MAX_LIMIT } from "./log.ts";
import {
	createReportOnce,
	extensionPokeSink,
	type Logger,
	POKE_DELAY_MS,
	POKE_MIN_INTERVAL_MS,
	type PokeSink,
	settle,
} from "./pokes.ts";
import { callEach, epochOf } from "./relay-source.ts";
import { first, type SqlExec } from "./sql.ts";

export const FORGE_EVENTS_MIGRATIONS: readonly Migration[] = [
	{
		n: 400,
		name: "forge_events",
		sql: [
			"CREATE TABLE forge_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, idem_key TEXT NOT NULL UNIQUE, type TEXT NOT NULL, envelope_json TEXT NOT NULL, at INTEGER NOT NULL)",
			"CREATE INDEX forge_events_type ON forge_events(type, seq)",
		].join(";\n"),
	},
	{
		n: 401,
		name: "audit",
		sql: [
			"CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, principal_id TEXT NOT NULL, via_installation TEXT, action TEXT NOT NULL, target TEXT, data_json TEXT)",
			"CREATE INDEX audit_principal ON audit(principal_id, seq)",
		].join(";\n"),
	},
];

/** A subtree-filtered read scans at most this many rows per call. */
export const FORGE_SCAN_MAX = 5000;
export const AUDIT_MAX_LIMIT = 500;

const ForgeAppendSchema = z.strictObject({
	type: z.string(),
	actor: ActorSchema,
	node: UlidSchema,
	data: z.unknown(),
	idemKey: z.string().min(1).max(512),
});

const AuditEntrySchema = z.strictObject({
	principal: z.string().min(1).max(128),
	viaInstallation: z.string().min(1).max(128).optional(),
	action: z.string().min(1).max(128),
	target: z.string().max(2048).optional(),
	data: z.unknown().optional(),
});

type ForgeAppend = {
	type: string;
	actor: Actor;
	node: string;
	data: unknown;
	idemKey: string;
};

type AuditEntry = {
	principal: string;
	viaInstallation?: string;
	action: string;
	target?: string;
	data?: unknown;
};

const issues = (error: z.ZodError): string =>
	error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
		.join("; ");

export type ForgeEventsOptions = {
	readonly poke?: (env: Env) => PokeSink;
	readonly schedule?: Schedule;
	readonly log?: Logger;
};

const defaultLog: Logger = (message, data) =>
	console.error(`[tartan] forge events: ${message}`, JSON.stringify(data));

/** A forge row as the relay reads it (no chain; `repo` from the envelope). */
export const forgeRelayRowOf = (row: ForgeEventRow): EventLogRow => {
	const envelope = JSON.parse(row.envelope_json) as Envelope;
	return {
		seq: row.seq,
		idemKey: row.idem_key,
		prevHash: null,
		hash: null,
		repo: envelope.repo ?? null,
		envelope,
	};
};

export type ForgeEventsInternalK2 = ForgeEventsInternal & EventsRelaySource;

export const createForgeEventsModule = (
	options: ForgeEventsOptions = {},
): DoModule<ForgeEventsFacade, ForgeEventsInternalK2, Env, ForgeInternals> => ({
	name: "events",
	range: MIGRATION_RANGES.forge.events,
	migrations: FORGE_EVENTS_MIGRATIONS,
	create: (deps) => {
		const sql = deps.sql as unknown as SqlExec;
		const log = options.log ?? defaultLog;
		const transact = <T>(fn: () => T): T =>
			deps.ctx.storage.transactionSync(fn);
		const pokeSink = (options.poke ?? extensionPokeSink)(deps.env);
		const reportOnce = createReportOnce(log);

		const headSync = (): number =>
			first(
				sql.exec<{ seq: number | null }>(
					"SELECT MAX(seq) AS seq FROM forge_events",
				),
			)?.seq ?? 0;

		const appendHooks: AppendHook[] = [];
		const flushListeners: (() => void)[] = [];

		const coalescer = createCoalescer({
			delayMs: POKE_DELAY_MS,
			minIntervalMs: POKE_MIN_INTERVAL_MS,
			now: () => deps.clock.now(),
			schedule: options.schedule ?? timerSchedule,
			run: () => flush(),
			onError: (error) => reportOnce("flush failed", error),
		});

		const appendSync = (
			event: ForgeAppend,
		): { id: string; seq: number } => {
			const parsed = ForgeAppendSchema.safeParse(event);
			if (!parsed.success) {
				throw invalid(`invalid forge event: ${issues(parsed.error)}`);
			}
			const e = parsed.data;
			const existing = first(
				sql.exec<{ id: string; seq: number }>(
					"SELECT id, seq FROM forge_events WHERE idem_key = ?",
					e.idemKey,
				),
			);
			if (existing) return existing;
			if (
				!isKernelEventType(e.type) || KERNEL_EVENT_STREAMS[e.type] === "repo"
			) {
				throw invalid(`${e.type} is not a forge-stream event`);
			}
			const data = validateEventData(e.type, e.data);
			if (!data.ok) {
				throw invalid(`invalid ${e.type} data: ${data.errors.join("; ")}`);
			}
			if (
				byteLength(JSON.stringify(data.data ?? null)) > EVENT_DATA_MAX_BYTES
			) {
				throw tartanError(
					"payload_too_large",
					`event data exceeds ${EVENT_DATA_MAX_BYTES} bytes`,
				);
			}
			const seq = headSync() + 1;
			const at = deps.clock.now();
			const repoId = e.type.startsWith("repo.") &&
					typeof (data.data as { repoId?: unknown })?.repoId === "string"
				? (data.data as { repoId: string }).repoId
				: undefined;
			const envelope: Envelope = {
				id: deps.ids.ulid(),
				seq,
				stream: "forge",
				type: e.type,
				v: 1,
				source: { kind: "kernel" },
				actor: e.actor,
				node: e.node,
				...(repoId ? { repo: repoId } : {}),
				depth: 0,
				shadow: false,
				at,
				data: data.data,
			};
			sql.exec(
				"INSERT INTO forge_events (seq, id, idem_key, type, envelope_json, at) VALUES (?, ?, ?, ?, ?, ?)",
				seq,
				envelope.id,
				e.idemKey,
				e.type,
				JSON.stringify(envelope),
				at,
			);
			coalescer.trigger();
			// Inside the append's transaction: a throwing hook rolls it back.
			for (const hook of appendHooks) hook({ seq });
			return { id: envelope.id, seq };
		};

		const auditSync = (entry: AuditEntry): void => {
			const parsed = AuditEntrySchema.safeParse(entry);
			if (!parsed.success) {
				throw invalid(`invalid audit entry: ${issues(parsed.error)}`);
			}
			const a = parsed.data;
			const dataJson = a.data === undefined
				? null
				: redactSecrets(JSON.stringify(a.data));
			if (dataJson !== null && byteLength(dataJson) > EVENT_DATA_MAX_BYTES) {
				throw tartanError(
					"payload_too_large",
					`audit data exceeds ${EVENT_DATA_MAX_BYTES} bytes`,
				);
			}
			sql.exec(
				"INSERT INTO audit (at, principal_id, via_installation, action, target, data_json) VALUES (?, ?, ?, ?, ?, ?)",
				deps.clock.now(),
				a.principal,
				a.viaInstallation ?? null,
				a.action,
				a.target === undefined ? null : redactSecrets(a.target),
				dataJson,
			);
		};

		const rowsAfter = (
			since: number,
			patterns: readonly string[],
			limit: number,
		): ForgeEventRow[] => {
			const clause = patternClause(patterns);
			return sql.exec<ForgeEventRow>(
				`SELECT * FROM forge_events WHERE seq > ?${
					clause ? ` AND ${clause.sql}` : ""
				} ORDER BY seq LIMIT ?`,
				since,
				...(clause?.args ?? []),
				limit,
			).toArray();
		};

		/**
		 * One page and the last seq it considered: the
		 * subtree filter scans at most `FORGE_SCAN_MAX` matching rows, so a
		 * short page is complete only when `scannedTo` is the head.
		 */
		const readPageSync = (
			since: number,
			patterns: string[],
			options?: { limit?: number; subtreeNodeId?: string },
		): { events: Envelope[]; scannedTo: number } => {
			if (!Number.isInteger(since) || since < 0) throw invalid("since");
			checkPatterns(patterns);
			const limit = Math.min(
				READ_MAX_LIMIT,
				Math.max(1, Math.trunc(options?.limit ?? 100)),
			);
			const head = headSync();
			if (patterns.length === 0) return { events: [], scannedTo: head };
			const subtree = options?.subtreeNodeId;
			if (subtree === undefined) {
				const rows = rowsAfter(since, patterns, limit);
				return {
					events: rows.map((row) => JSON.parse(row.envelope_json) as Envelope),
					scannedTo: rows.length < limit ? head : rows[rows.length - 1].seq,
				};
			}
			const now = deps.clock.now();
			const tree = deps.modules.tree;
			const check = {
				within: (nodeId: string) => tree.isWithinSync(subtree, nodeId),
				principalWithin: (principal: string) =>
					tree.effectiveRoleSync([principal], subtree, now) > 0,
			};
			const out: Envelope[] = [];
			let cursor = since;
			let scanned = 0;
			let exhausted = false;
			while (out.length < limit && scanned < FORGE_SCAN_MAX) {
				const rows = rowsAfter(cursor, patterns, 200);
				for (const row of rows) {
					cursor = row.seq;
					scanned++;
					const envelope = JSON.parse(row.envelope_json) as Envelope;
					if (visibleInSubtree(envelope, check)) out.push(envelope);
					if (out.length >= limit) break;
				}
				if (rows.length < 200 && out.length < limit) {
					exhausted = true;
					break;
				}
			}
			return { events: out, scannedTo: exhausted ? head : cursor };
		};

		const read: ForgeEventsFacade["read"] = (since, patterns, options) =>
			settle(() => readPageSync(since, patterns, options).events);

		let lastPoked = headSync();
		const flush = (): void => {
			callEach(
				flushListeners,
				(error) => reportOnce("flush listener failed", error),
			);
			const head = headSync();
			if (head <= lastPoked) return;
			const rows = rowsAfter(lastPoked, ["*"], 2000);
			lastPoked = head;
			const hosts = new Set<string>();
			const registry = deps.modules.registry;
			for (const row of rows) {
				const event = JSON.parse(row.envelope_json) as Envelope;
				for (
					const { installation, manifest } of registry.inForceSync(event.node)
				) {
					if (
						installation.mode === "disabled" ||
						installation.storageScope !== "node"
					) continue;
					const subscribed = (manifest.subscribe ?? []).some((s) =>
						matchesEventPattern(s.event, event.type)
					);
					if (subscribed) {
						hosts.add(extDoName(installation.id, { kind: "node" }));
					}
				}
			}
			for (const host of hosts) {
				deps.ctx.waitUntil(
					pokeSink(host, { stream: "forge", head }).catch((error) =>
						reportOnce("poke failed", error)
					),
				);
			}
		};

		const facade: ForgeEventsFacade = {
			read,
			readPage: (since, patterns, options) =>
				settle(() => readPageSync(since, patterns, options)),
			head: () => settle(headSync),
			appendKernel: (event) =>
				settle(() => {
					if (event?.type !== "extension.error") {
						throw invalid("appendKernel accepts extension.error only");
					}
					return transact(() => appendSync(event));
				}),
			audit: (entry) => settle(() => transact(() => auditSync(entry))),
			auditLog: (since, limit) =>
				settle(() => {
					if (!Number.isInteger(since) || since < 0) throw invalid("since");
					return sql.exec<AuditRow>(
						"SELECT * FROM audit WHERE seq > ? ORDER BY seq LIMIT ?",
						since,
						Math.min(AUDIT_MAX_LIMIT, Math.max(1, Math.trunc(limit))),
					).toArray();
				}),
		};

		const internal: ForgeEventsInternalK2 = {
			appendSync,
			auditSync,
			readSync: ({ since, limit }) =>
				sql.exec<ForgeEventRow>(
					"SELECT * FROM forge_events WHERE seq > ? ORDER BY seq LIMIT ?",
					since,
					Math.max(1, Math.trunc(limit)),
				).toArray().map(forgeRelayRowOf),
			epochSync: () => epochOf(sql, deps.ids.ulid),
			oldestSeqSync: () =>
				first(
					sql.exec<{ seq: number | null }>(
						"SELECT MIN(seq) AS seq FROM forge_events",
					),
				)?.seq ?? null,
			headSync: () => ({ seq: headSync() }),
			onFlush: (listener) => {
				flushListeners.push(listener);
			},
			onAppendSync: (hook) => {
				appendHooks.push(hook);
			},
		};

		return { facade, internal };
	},
});

export const forgeEventsModule = createForgeEventsModule();
