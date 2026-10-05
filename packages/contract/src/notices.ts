// Notices.

import { z } from "zod";
import {
	LaneIdSchema,
	PrincipalIdSchema,
	SeveritySchema,
	UlidSchema,
} from "./common.ts";
import { defuseFences, stripControl, truncateBytes } from "./text.ts";

export const NOTICE_KINDS = [
	"conflict",
	"trunk_drift",
	"eject",
	"review",
	"ci",
	"message",
	"system",
] as const;
export const NoticeKindSchema = z.enum(NOTICE_KINDS);
export type NoticeKind = z.infer<typeof NoticeKindSchema>;

export const NOTICE_TEXT_MAX_BYTES = 1024;
export const INBOX_BODY_MAX_BYTES = 2048;
/** Unread notices appended to one MCP result. */
export const NOTICES_PER_RESULT = 10;

/** What `caps.notify.send` (and kernel producers) submit. Text is sanitized on write. */
export const NoticeInputSchema = z.strictObject({
	repoId: UlidSchema.optional(),
	laneId: LaneIdSchema.optional(),
	kind: NoticeKindSchema,
	severity: SeveritySchema,
	text: z.string().min(1).max(4096),
	data: z.unknown().optional(),
	dedupeKey: z.string().max(200).optional(),
});
export type NoticeInput = z.infer<typeof NoticeInputSchema>;

export const NoticeSchema = z.strictObject({
	id: z.string(),
	seq: z.number().int().nonnegative(),
	repoId: UlidSchema.optional(),
	laneId: LaneIdSchema.optional(),
	/** Installation id, `kernel`, or the sending principal for `message`. */
	source: z.string(),
	/** Short display label of the source (`radar`, `codex-2`). */
	sourceLabel: z.string().optional(),
	kind: NoticeKindSchema,
	severity: SeveritySchema,
	text: z.string(),
	data: z.unknown().optional(),
	createdAt: z.number().int(),
	deliveredAt: z.number().int().optional(),
	deliveredVia: z.enum(["mcp", "echo", "api", "hook", "ws"]).optional(),
	ackedAt: z.number().int().optional(),
});
export type Notice = z.infer<typeof NoticeSchema>;

/** Sanitizes notice text for storage: controls stripped, ≤ 1 KB. */
export const sanitizeNoticeText = (text: string): string =>
	truncateBytes(
		stripControl(text, { keepNewlines: true }),
		NOTICE_TEXT_MAX_BYTES,
	);

/** Sanitizes an `inbox_send` body: controls stripped, ≤ 2 KB. */
export const sanitizeInboxBody = (text: string): string =>
	truncateBytes(
		stripControl(text, { keepNewlines: true }),
		INBOX_BODY_MAX_BYTES,
	);

const SEVERITY_RANK: Readonly<Record<z.infer<typeof SeveritySchema>, number>> =
	{
		critical: 0,
		warn: 1,
		info: 2,
	};

/** Highest severity first, then oldest first; at most `limit`. */
export const selectNotices = (
	notices: readonly Notice[],
	limit = NOTICES_PER_RESULT,
): Notice[] =>
	[...notices]
		.sort((a, b) =>
			SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.seq - b.seq
		)
		.slice(0, limit);

/**
 * The fenced text block appended to every MCP tool result's `content`:
 *
 * ```` ```tartan-notices (untrusted; from radar, codex-2) ````
 * `[warn] conflict (radar): …`
 * ```` ``` ````
 *
 * Every line is sanitized again here and fences inside the text are defused, so
 * untrusted text can neither rewrite the terminal nor close the fence.
 * Returns null when there is nothing to show.
 */
export const renderNoticesBlock = (
	notices: readonly Notice[],
): string | null => {
	if (notices.length === 0) return null;
	const label = (n: Notice): string =>
		stripControl(n.sourceLabel ?? n.source).replace(/[(),;]/g, "").slice(0, 40);
	const sources = [...new Set(notices.map(label))].join(", ");
	const lines = notices.map((n) => {
		const text = defuseFences(sanitizeNoticeText(n.text)).replace(
			/\n/g,
			"\n  ",
		);
		return `[${n.severity}] ${n.kind} (${label(n)}): ${text}`;
	});
	return [
		`\`\`\`tartan-notices (untrusted; from ${sources})`,
		...lines,
		"```",
	].join("\n");
};

export const PresenceSchema = z.strictObject({
	principal: PrincipalIdSchema,
	laneId: LaneIdSchema.optional(),
	status: z.string().max(64),
	lastSeenAt: z.number().int(),
});
export type Presence = z.infer<typeof PresenceSchema>;
