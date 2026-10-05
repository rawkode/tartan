// The repo live feed inside RepoDO (WP6).
// The Worker (`routes.ts`) authenticates, checks the exact Origin and
// authorizes, then forwards a fresh upgrade request (only the headers it sets
// itself) to the `events` module with `moduleRequest`. Here the socket is
// accepted with hibernation tags `feed` and `role:<n>`, gets `hello`, a replay
// of ≤ `LIVE_REPLAY_MAX` events after `since` (a `gap` frame first when more
// were missed or pruned), and then coalesced `events` frames (≤ 1 per 250 ms).
// Each socket's attachment records the last seq it was sent, so a replay and
// a broadcast never overlap and a socket survives hibernation.
// Shadow events never reach the feed.

import {
	type Envelope,
	LIVE_REPLAY_MAX,
	type LiveFrame,
	UlidSchema,
} from "@tartan/contract";
import type { SocketHandlers } from "@tartan/contract/kernel.ts";
import type { EventLog } from "./log.ts";

export const LIVE_TAG = "feed";
/** Set by the Worker on the forwarded upgrade; client values never reach the DO. */
export const LIVE_ROLE_HEADER = "x-tartan-live-role";
/** Client → server keepalive; answered with `{t:"ping"}`. */
export const LIVE_PING = "ping";

type Attachment = { readonly sent: number; readonly role: number };

export type LiveFeedDeps = {
	readonly ctx: Pick<DurableObjectState, "acceptWebSocket" | "getWebSockets">;
	readonly log: Pick<EventLog, "headSync" | "read" | "oldestSeqSync">;
	/** The repo id (known once the DO has a name or an event). */
	readonly repoId: () => string | null;
	readonly onError?: (message: string, data: Record<string, unknown>) => void;
};

export type LiveFeed = {
	/** The module's `fetch`: accepts a forwarded WebSocket upgrade. */
	fetch(req: Request): Response;
	/** Sends every socket the events it has not seen (coalesced by the caller). */
	broadcast(): void;
	readonly handlers: SocketHandlers;
	/** Sockets currently attached. */
	count(): number;
};

const send = (ws: WebSocket, frame: LiveFrame): void => {
	ws.send(JSON.stringify(frame));
};

const attachmentOf = (ws: WebSocket): Attachment | null => {
	const value = ws.deserializeAttachment() as Attachment | null;
	return value && typeof value.sent === "number" ? value : null;
};

const plainError = (status: number, text: string): Response =>
	new Response(text, { status, headers: { "content-type": "text/plain" } });

export const createLiveFeed = (deps: LiveFeedDeps): LiveFeed => {
	/**
	 * Frames that bring a socket from `sent` to `head`: a `gap` when events
	 * were pruned or more than `LIVE_REPLAY_MAX` were missed, then the events.
	 */
	const framesSince = (
		sent: number,
		head: number,
		cache: Map<number, Envelope[]>,
	): LiveFrame[] => {
		if (head <= sent) return [];
		const frames: LiveFrame[] = [];
		let from = sent;
		if (head - sent > LIVE_REPLAY_MAX) {
			from = head - LIVE_REPLAY_MAX;
			frames.push({ t: "gap", from: sent + 1, to: from });
		} else {
			const oldest = deps.log.oldestSeqSync();
			if (oldest !== null && oldest > sent + 1) {
				frames.push({ t: "gap", from: sent + 1, to: oldest - 1 });
				from = oldest - 1;
			}
		}
		let events = cache.get(from);
		if (events === undefined) {
			events = deps.log.read({ since: from, limit: LIVE_REPLAY_MAX })
				.filter((e) => e.seq <= head);
			cache.set(from, events);
		}
		frames.push({ t: "events", events, head });
		return frames;
	};

	const deliver = (
		ws: WebSocket,
		att: Attachment,
		head: number,
		cache: Map<number, Envelope[]>,
	): void => {
		for (const frame of framesSince(att.sent, head, cache)) send(ws, frame);
		ws.serializeAttachment({ ...att, sent: head } satisfies Attachment);
	};

	const fetch = (req: Request): Response => {
		if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			return plainError(426, "expected a WebSocket upgrade");
		}
		const url = new URL(req.url);
		const sinceText = url.searchParams.get("since");
		const since = sinceText === null ? null : Number(sinceText);
		const roleText = req.headers.get(LIVE_ROLE_HEADER);
		const role = roleText === null || roleText === "" ? NaN : Number(roleText);
		if (
			(since !== null && (!Number.isInteger(since) || since < 0)) ||
			!Number.isInteger(role) || role < 0 || role > 50
		) {
			return plainError(400, "invalid live request");
		}
		const repo = deps.repoId();
		const head = deps.log.headSync().seq;
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		deps.ctx.acceptWebSocket(server, [LIVE_TAG, `role:${role}`]);
		send(server, {
			t: "hello",
			repo: repo !== null && UlidSchema.safeParse(repo).success ? repo : "",
			head,
		});
		const att: Attachment = { sent: since ?? head, role };
		// A client ahead of the log (a reset DO) restarts from the head.
		deliver(
			server,
			{ ...att, sent: Math.min(att.sent, head) },
			head,
			new Map(),
		);
		return new Response(null, { status: 101, webSocket: client });
	};

	const broadcast = (): void => {
		const sockets = deps.ctx.getWebSockets(LIVE_TAG);
		if (sockets.length === 0) return;
		const head = deps.log.headSync().seq;
		const cache = new Map<number, Envelope[]>();
		for (const ws of sockets) {
			try {
				const att = attachmentOf(ws);
				if (att === null || att.sent >= head) continue;
				deliver(ws, att, head, cache);
			} catch (error) {
				deps.onError?.("live frame failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	};

	const handlers: SocketHandlers = {
		tagPrefix: LIVE_TAG,
		message: (ws, message) => {
			if (message === LIVE_PING) send(ws, { t: "ping" });
		},
		close: (ws, code, reason) => {
			try {
				ws.close(
					code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000,
					reason,
				);
			} catch {
				// Already closed.
			}
		},
		error: () => {},
	};

	return {
		fetch,
		broadcast,
		handlers,
		count: () => deps.ctx.getWebSockets(LIVE_TAG).length,
	};
};
