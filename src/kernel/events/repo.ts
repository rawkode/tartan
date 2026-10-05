// RepoDO `events` module (WP6, migrations 200–249; K3, K4, K10): the ordered,
// causal, hash-chained log (`./log.ts`), the subscriber cache and coalesced
// pokes to ExtensionDOs, and the live feed's WebSocket handlers (`./live.ts`).
//
// Pokes and live frames run after the appending transaction, from one
// coalescer (25 ms when idle, at most one run per 250 ms under load). A run
// reads what committed since the last run, pokes each matching subscriber
// once with the head (`ExtensionDO.poke`, fire-and-forget; WP7b drains) and
// sends every live socket its missed events. The subscriber cache is
// refreshed from the ForgeDO registry when `ext_version` changes (checked at
// most every 30 s from a run, and by the cron), and through
// `refreshSubscribers`. Lost pokes are recovered by the 5-minute cron.
//
// The global log relay (WP26, `../bus/relay.ts`) reads through the internal
// API: `readSync` (every stored row, nothing filtered), `epochSync` (a ULID
// in `meta`, minted on first use, so a storage reset starts a new epoch),
// `oldestSeqSync`, `onAppendSync` (hooks inside the append transaction) and
// `onFlush` (after each coalesced run). Retention keeps every row the relay
// has not sent while it is not `off` (the prune guard).

import {
	type AppendInput,
	type Envelope,
	invalid,
	repoStream,
	ULID_RE,
} from "@tartan/contract";
import {
	type DoModule,
	MIGRATION_RANGES,
	type RepoCoreInternal,
	type RepoEventsFacade,
	type RepoEventsInternal,
	type RepoInternals,
	type SubscriberRow,
} from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import type {
	AppendHook,
	BusRelayInternal,
	EventLogRow,
	EventsRelaySource,
} from "../bus/contract.ts";
import { createCoalescer, type Schedule, timerSchedule } from "./coalesce.ts";
import { createLiveFeed } from "./live.ts";
import {
	createReportOnce,
	extensionPokeSink,
	type Logger,
	POKE_DELAY_MS,
	POKE_MIN_INTERVAL_MS,
	type PokeSink,
	settle,
} from "./pokes.ts";
import {
	createEventLog,
	REPO_EVENTS_MIGRATIONS,
	type StoredEventRow,
	toEnvelope,
} from "./log.ts";
import { callEach, epochOf } from "./relay-source.ts";
import type { SqlExec } from "./sql.ts";
import {
	allHosts,
	createSubscriberCache,
	hostsToPoke,
	registrySubscriberSource,
	type SubscriberSource,
} from "./subscribers.ts";

/** Events inspected per run for matching; a longer backlog pokes every subscriber. */
export const POKE_WINDOW = 2000;
/** How often a run may ask the registry whether `ext_version` changed. */
export const SUBSCRIBER_CHECK_MS = 30_000;

export type RepoEventsOptions = {
	readonly poke?: (env: Env) => PokeSink;
	readonly subscribers?: (env: Env) => SubscriberSource;
	readonly schedule?: Schedule;
	readonly log?: Logger;
};

const defaultLog: Logger = (message, data) =>
	console.error(`[tartan] events: ${message}`, JSON.stringify(data));

/** `repo:<ulid>` → `<ulid>` (the DO's own repo), else null. */
export const repoIdFromName = (name: string | undefined): string | null => {
	if (name === undefined || !name.startsWith("repo:")) return null;
	const id = name.slice("repo:".length);
	return ULID_RE.test(id) ? id : null;
};

/** A stored row as the relay reads it (`repo` is the row's own column). */
export const relayRowOf = (row: StoredEventRow): EventLogRow => ({
	seq: row.seq,
	idemKey: row.idem_key,
	prevHash: row.prev_hash,
	hash: row.hash,
	repo: row.repo,
	envelope: toEnvelope(row),
});

export type RepoEventsInternalK2 = RepoEventsInternal & EventsRelaySource;

type RepoSiblings = RepoInternals & { readonly bus?: BusRelayInternal };

export const createRepoEventsModule = (
	options: RepoEventsOptions = {},
): DoModule<RepoEventsFacade, RepoEventsInternalK2, Env, RepoInternals> => ({
	name: "events",
	range: MIGRATION_RANGES.repo.events,
	migrations: REPO_EVENTS_MIGRATIONS,
	create: (deps) => {
		const sql = deps.sql as unknown as SqlExec;
		const log = options.log ?? defaultLog;
		const transact = <T>(fn: () => T): T =>
			deps.ctx.storage.transactionSync(fn);
		const source = (options.subscribers ?? registrySubscriberSource)(deps.env);
		const pokeSink = (options.poke ?? extensionPokeSink)(deps.env);

		let repoId: string | null = repoIdFromName(deps.ctx.id.name) ??
			(sql.exec<{ repo: string | null; node: string }>(
				"SELECT repo, node FROM events ORDER BY seq DESC LIMIT 1",
			).toArray().map((r) => r.repo ?? r.node)[0] ?? null);

		const reportOnce = createReportOnce(log);

		const appendHooks: AppendHook[] = [];
		const flushListeners: (() => void)[] = [];

		const subscribers = createSubscriberCache({ sql });
		const coalescer = createCoalescer({
			delayMs: POKE_DELAY_MS,
			minIntervalMs: POKE_MIN_INTERVAL_MS,
			now: () => deps.clock.now(),
			schedule: options.schedule ?? timerSchedule,
			run: () => flush(),
			onError: (error) => reportOnce("flush failed", error),
		});

		// A swarm shard (RepoCoreFacade.markSimulated, WP20): core keeps the
		// flag in memory. Hosts without a core (module tests) never are.
		const simulated = (): boolean =>
			(deps.modules.core as Partial<RepoCoreInternal> | undefined)
				?.simulatedSync?.() === true;

		const eventLog = createEventLog({
			sql,
			transact,
			clock: deps.clock,
			ids: deps.ids,
			repoId: () => repoId,
			applyLaneEvent: (event: Envelope) =>
				deps.modules.core.applyLaneEventSync(event),
			// A swarm shard (WP20): every event is a simulated agent's.
			simulated,
			onAppend: (event: Envelope) => {
				repoId ??= event.repo ?? event.node;
				// Repository config (WP23): policy touches of lane heads, trunk
				// moves outside the Advance. Never throws.
				deps.modules.repoconfig?.observeSync(event);
				coalescer.trigger();
				// Inside the append's transaction: a throwing hook rolls it back.
				for (const hook of appendHooks) hook({ seq: event.seq });
			},
		});

		const live = createLiveFeed({
			ctx: deps.ctx,
			log: eventLog,
			repoId: () => repoId,
			onError: log,
		});

		const poke = (hosts: readonly string[], head: number): void => {
			if (repoId === null || hosts.length === 0) return;
			const stream = repoStream(repoId);
			for (const host of hosts) {
				const sent = pokeSink(host, { stream, head }).catch((error) =>
					reportOnce("poke failed", error)
				);
				deps.ctx.waitUntil(sent);
			}
		};

		const replaceSubscribers = (
			rows: readonly SubscriberRow[],
			extVersion: number,
		): void => {
			transact(() => subscribers.replace(rows, extVersion));
			// New subscribers catch up from their own cursor.
			poke(allHosts(subscribers.all()), eventLog.headSync().seq);
		};

		let lastCheck = Number.NEGATIVE_INFINITY;
		let checking = false;
		const checkSubscribers = async (): Promise<void> => {
			const now = deps.clock.now();
			if (
				checking || repoId === null || now - lastCheck < SUBSCRIBER_CHECK_MS
			) {
				return;
			}
			checking = true;
			lastCheck = now;
			try {
				const version = await source.extVersion();
				if (version === subscribers.version()) return;
				const loaded = await source.load(repoId);
				replaceSubscribers(loaded.rows, loaded.extVersion);
			} catch (error) {
				reportOnce("subscriber refresh failed", error);
			} finally {
				checking = false;
			}
		};

		let lastPoked = eventLog.headSync().seq;
		const flush = (): void => {
			live.broadcast();
			const head = eventLog.headSync().seq;
			if (head > lastPoked) {
				const window = eventLog.typesSince(lastPoked, POKE_WINDOW);
				const last = window.at(-1);
				const truncated = window.length === POKE_WINDOW &&
					last !== undefined && last.seq < head;
				const subs = subscribers.all();
				lastPoked = head;
				poke(truncated ? allHosts(subs) : hostsToPoke(subs, window), head);
			}
			deps.ctx.waitUntil(checkSubscribers());
			callEach(
				flushListeners,
				(error) => reportOnce("flush listener failed", error),
			);
		};

		/** The prune guard: the relay's cursor while it is not `off`. */
		const keepAbove = (): number | null => {
			const bus = (deps.modules as RepoSiblings).bus;
			if (bus === undefined || bus.stateSync() === "off") return null;
			return bus.relayedSeqSync();
		};

		const facade: RepoEventsFacade = {
			append: (input: AppendInput) =>
				settle(() => transact(() => eventLog.appendSync(input))),
			get: (ids) => settle(() => eventLog.getSync(ids)),
			read: (query) => settle(() => eventLog.read(query)),
			head: () => settle(() => eventLog.headSync().seq),
			verifyChain: (fromSeq, toSeq) =>
				settle(() => eventLog.verifyChain(fromSeq, toSeq)),
			prune: (now) =>
				settle(() => {
					if (!Number.isInteger(now)) throw invalid("now");
					return eventLog.prune(now, keepAbove());
				}),
			refreshSubscribers: (rows, extVersion) =>
				settle(() => replaceSubscribers(rows, extVersion)),
		};

		const internal: RepoEventsInternalK2 = {
			appendSync: eventLog.appendSync,
			existingSync: eventLog.existingSync,
			getSync: eventLog.getSync,
			pinSync: eventLog.pinSync,
			headSync: eventLog.headSync,
			readSync: ({ since, limit }) =>
				eventLog.readRowsSync(since, limit).map(relayRowOf),
			epochSync: () => epochOf(sql, deps.ids.ulid),
			oldestSeqSync: eventLog.oldestSeqSync,
			onFlush: (listener) => {
				flushListeners.push(listener);
			},
			onAppendSync: (hook) => {
				appendHooks.push(hook);
			},
		};

		return {
			facade,
			internal,
			sockets: [live.handlers],
			fetch: (req) => live.fetch(req),
		};
	},
});

export const repoEventsModule = createRepoEventsModule();
