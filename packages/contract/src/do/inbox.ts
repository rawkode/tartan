// InboxDO (`inbox:<principalId>`): its rows and its RPC
// surface (WP6). Long-poll waiters are in-memory promises resolved by
// `deliver()`; there is no table for them.

import type { Notice, NoticeInput, Presence } from "../notices.ts";

export type NoticeRow = {
	seq: number;
	id: string;
	repo_id: string | null;
	lane_id: string | null;
	source: string;
	kind: string;
	severity: "info" | "warn" | "critical";
	text: string;
	data_json: string | null;
	dedupe_key: string | null;
	/** `Notice.sourceLabel` (WP6). */
	source_label: string | null;
	created_at: number;
	delivered_at: number | null;
	delivered_via: string | null;
	acked_at: number | null;
};
export type PresenceRow = {
	repo_id: string;
	lane_id: string | null;
	status: string | null;
	last_seen_at: number;
	flushed_at: number | null;
};

export type DeliveryChannel = "mcp" | "echo" | "api" | "hook" | "ws";

export interface InboxFacade {
	/** Dedupes on `dedupeKey`; text stripped of control characters on write. */
	deliver(
		notice: NoticeInput & { source: string; sourceLabel?: string },
	): Promise<{ id: string; created: boolean }>;
	/** Unread notices (≤ limit, highest severity first) and marks them delivered via `via`. */
	peek(limit: number, via: DeliveryChannel, repoId?: string): Promise<Notice[]>;
	read(
		query: { since?: number; repoId?: string; limit?: number },
	): Promise<Notice[]>;
	ack(ids: string[]): Promise<{ acked: number }>;
	/**
	 * Resolves on the next delivery or after `timeoutMs` (≤ 25 s), marking the
	 * returned notices delivered via `via` (default `mcp`; the HTTP route
	 * passes `api`).
	 */
	wait(
		timeoutMs: number,
		repoId?: string,
		via?: DeliveryChannel,
	): Promise<Notice[]>;
	unreadCount(): Promise<number>;
	/** Presence and lease renewal, flushed to RepoDO in batches ≤ 1/min. */
	touch(
		input: { repoId: string; laneId?: string; status?: string; at: number },
	): Promise<void>;
	presence(repoId: string): Promise<Presence | null>;
}

/** InboxDO has a single module; no sibling internals. */
export type InboxInternal = Record<string, never>;

export const INBOX_TIMERS = { inbox: ["flush"] } as const;
