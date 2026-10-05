// Live store: one WebSocket per repo (`/-/live?repo=<id>&since=<seq>`),
// shared by every subscriber on the page.
//
// - Subscribers register event-type patterns (`refreshOn`) and get the
//   matching envelopes of each coalesced `events` frame.
// - The store tracks the head seq; a reconnect resumes with `since=<head>` so
//   the server replays what was missed (≤ 500). A `gap` frame (replay limit
//   exceeded) tells every subscriber to resync, i.e. refetch.
// - A subscriber may say what its view already reflects (`since`, a slot
//   render's `cursor`): a fresh socket opens with `since` (the lowest of its
//   subscribers'), so an event appended between the render and the `hello`
//   is replayed. A subscriber joining a channel that is already past its
//   `since` is resynced once if an event in between matches its patterns
//   (the channel keeps the seq and type of its last `RECENT_MAX` events), or
//   if the channel cannot tell (it did not see them all). Events of types it
//   never subscribed to do not make it refetch. A reconnect that cannot
//   resume (no hello yet, no since) resyncs every subscriber at its hello.
// - The socket closes when the last subscriber leaves; while subscribers
//   remain it reconnects with capped exponential backoff.
// The browser enforces the Origin check server-side; cookies authenticate.

import { type Ref, ref } from "vue";
import type { LiveFrame } from "@tartan/contract/api.ts";
import type { Envelope } from "@tartan/contract/events.ts";
import { matchesAnyPattern } from "./patterns.ts";
import {
	browserScheduler,
	type Scheduler,
	type TimerHandle,
} from "./scheduler.ts";

export type SocketLike = {
	onopen: ((event: unknown) => void) | null;
	onmessage: ((event: { readonly data: unknown }) => void) | null;
	onclose: ((event: unknown) => void) | null;
	onerror: ((event: unknown) => void) | null;
	close: () => void;
};

export type LiveListener = {
	readonly patterns: readonly string[];
	readonly onEvents: (events: readonly Envelope[]) => void;
	/** Called after a `gap` frame or a reconnect that could not resume. */
	readonly onResync?: () => void;
	/** The log seq this subscriber's view already reflects (a render's `cursor`). */
	readonly since?: number;
};

export type LiveStatus = "connecting" | "open" | "reconnecting" | "closed";

export type LiveStore = {
	readonly subscribe: (repoId: string, listener: LiveListener) => () => void;
	readonly status: (repoId: string) => Readonly<Ref<LiveStatus>>;
	readonly head: (repoId: string) => number | null;
};

export type LiveDeps = {
	readonly connect: (path: string) => SocketLike;
	readonly scheduler?: Scheduler;
	readonly maxBackoffMs?: number;
};

type Channel = {
	readonly repoId: string;
	readonly listeners: Set<LiveListener>;
	readonly status: Ref<LiveStatus>;
	socket: SocketLike | null;
	head: number | null;
	/** The `since` the current socket opened with (null: it starts at its `hello`). */
	from: number | null;
	/** Subscribers with a `since` that joined before any `hello`: checked there. */
	readonly pending: Set<LiveListener>;
	/** Seq and type of the latest events this channel saw, oldest first. */
	readonly recent: { readonly seq: number; readonly type: string }[];
	/** `recent` holds every event after this seq (null: nothing known yet). */
	seenFrom: number | null;
	retries: number;
	timer: TimerHandle | null;
};

const REPO_ID_RE = /^[0-9a-z]{26}$/;
/** How many recent events a channel remembers to decide a joiner's resync. */
export const RECENT_MAX = 256;

const parseFrame = (data: unknown): LiveFrame | null => {
	if (typeof data !== "string") return null;
	try {
		const frame = JSON.parse(data) as { t?: unknown };
		switch (frame.t) {
			case "hello":
			case "ping":
			case "gap":
				return frame as LiveFrame;
			case "events":
				return Array.isArray((frame as { events?: unknown }).events)
					? frame as LiveFrame
					: null;
			default:
				return null;
		}
	} catch {
		return null;
	}
};

export const livePath = (repoId: string, since: number | null): string =>
	since === null
		? `/-/live?repo=${encodeURIComponent(repoId)}`
		: `/-/live?repo=${encodeURIComponent(repoId)}&since=${since}`;

export const createLiveStore = (deps: LiveDeps): LiveStore => {
	const scheduler = deps.scheduler ?? browserScheduler;
	const maxBackoff = deps.maxBackoffMs ?? 30_000;
	const channels = new Map<string, Channel>();

	const channelFor = (repoId: string): Channel => {
		const existing = channels.get(repoId);
		if (existing) return existing;
		const channel: Channel = {
			repoId,
			listeners: new Set(),
			status: ref<LiveStatus>("closed"),
			socket: null,
			head: null,
			from: null,
			pending: new Set(),
			recent: [],
			seenFrom: null,
			retries: 0,
			timer: null,
		};
		channels.set(repoId, channel);
		return channel;
	};

	/** The lowest `since` of the channel's subscribers (null: none gave one). */
	const lowestSince = (channel: Channel): number | null => {
		let low: number | null = null;
		for (const listener of channel.listeners) {
			if (listener.since === undefined) continue;
			low = low === null ? listener.since : Math.min(low, listener.since);
		}
		return low;
	};

	/** One subscriber's view may have missed events: it refetches (after this turn). */
	const resyncLater = (channel: Channel, listener: LiveListener): void => {
		void Promise.resolve().then(() => {
			if (channel.listeners.has(listener)) listener.onResync?.();
		});
	};

	/** Whether a view at `since` missed an event it subscribed to (or may have). */
	const missed = (channel: Channel, listener: LiveListener): boolean => {
		const since = listener.since;
		if (since === undefined || channel.head === null) return false;
		if (since >= channel.head) return false;
		if (channel.seenFrom === null || since < channel.seenFrom) return true;
		return channel.recent.some((e) =>
			e.seq > since && matchesAnyPattern(listener.patterns, e.type)
		);
	};

	const remember = (channel: Channel, events: readonly Envelope[]): void => {
		for (const e of events) {
			if (typeof e?.seq !== "number" || typeof e.type !== "string") continue;
			channel.recent.push({ seq: e.seq, type: e.type });
		}
		while (channel.recent.length > RECENT_MAX) {
			const dropped = channel.recent.shift()!;
			channel.seenFrom = dropped.seq;
		}
	};

	const deliver = (channel: Channel, events: readonly Envelope[]): void => {
		for (const listener of [...channel.listeners]) {
			const matched = events.filter((e) =>
				typeof e?.type === "string" &&
				matchesAnyPattern(listener.patterns, e.type)
			);
			if (matched.length > 0) listener.onEvents(matched);
		}
	};

	const resync = (channel: Channel): void => {
		for (const listener of [...channel.listeners]) listener.onResync?.();
	};

	const open = (channel: Channel): void => {
		channel.timer = null;
		if (channel.listeners.size === 0) return;
		channel.status.value = channel.retries === 0
			? "connecting"
			: "reconnecting";
		channel.from = channel.head ?? lowestSince(channel);
		// A reconnect that cannot resume (no socket of this channel ever said
		// hello, and no subscriber gave a since) starts at the new hello's
		// head: whatever was appended while it was down is lost to every
		// subscriber, so each one refetches.
		const blind = channel.retries > 0 && channel.from === null;
		const socket = deps.connect(livePath(channel.repoId, channel.from));
		channel.socket = socket;
		socket.onopen = () => {
			if (channel.socket !== socket) return;
			channel.status.value = "open";
			channel.retries = 0;
		};
		socket.onmessage = (event) => {
			if (channel.socket !== socket) return;
			const frame = parseFrame(event.data);
			if (!frame) return;
			switch (frame.t) {
				case "hello": {
					if (channel.head === null) channel.head = frame.head;
					channel.seenFrom ??= channel.from ?? frame.head;
					// Replayed from here on: anyone whose view is older missed some.
					const covered = channel.from ?? frame.head;
					for (const listener of channel.pending) {
						if ((listener.since ?? covered) < covered) {
							resyncLater(channel, listener);
						}
					}
					channel.pending.clear();
					if (blind) {
						for (const listener of channel.listeners) {
							resyncLater(channel, listener);
						}
					}
					return;
				}
				case "events":
					channel.head = Math.max(channel.head ?? 0, frame.head);
					remember(channel, frame.events);
					deliver(channel, frame.events);
					return;
				case "gap":
					channel.head = Math.max(channel.head ?? 0, frame.to);
					channel.recent.length = 0;
					channel.seenFrom = channel.head;
					resync(channel);
					return;
				case "ping":
					return;
			}
		};
		socket.onerror = () => {
			// `onclose` follows; reconnect is handled there.
		};
		socket.onclose = () => {
			if (channel.socket !== socket) return;
			channel.socket = null;
			if (channel.listeners.size === 0) {
				channel.status.value = "closed";
				return;
			}
			channel.status.value = "reconnecting";
			const delay = Math.min(maxBackoff, 1000 * 2 ** channel.retries);
			channel.retries += 1;
			channel.timer = scheduler.setTimeout(() => open(channel), delay);
		};
	};

	const close = (channel: Channel): void => {
		if (channel.timer !== null) scheduler.clearTimeout(channel.timer);
		channel.timer = null;
		const socket = channel.socket;
		channel.socket = null;
		channel.retries = 0;
		channel.status.value = "closed";
		channel.pending.clear();
		socket?.close();
	};

	return {
		subscribe: (repoId, listener) => {
			if (!REPO_ID_RE.test(repoId)) return () => {};
			const channel = channelFor(repoId);
			channel.listeners.add(listener);
			if (listener.since !== undefined) {
				if (channel.head !== null) {
					// Events up to the head went to the others before it joined.
					if (missed(channel, listener)) resyncLater(channel, listener);
				} else {
					channel.pending.add(listener);
				}
			}
			if (channel.socket === null && channel.timer === null) open(channel);
			return () => {
				channel.listeners.delete(listener);
				channel.pending.delete(listener);
				if (channel.listeners.size === 0) close(channel);
			};
		},
		status: (repoId) => channelFor(repoId).status,
		head: (repoId) => channels.get(repoId)?.head ?? null,
	};
};

/** The browser connector: a same-origin `ws(s):` URL for a `/-/live` path. */
export const browserConnect = (path: string): SocketLike => {
	const url = new URL(path, globalThis.location.href);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return new WebSocket(url.href) as unknown as SocketLike;
};
