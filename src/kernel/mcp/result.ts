// Tool results and the notices middleware (WP11).
//
// Every tool result, errors included, carries the forge's attention data in
// the two places MCP clients use: unread notices (≤ 10, highest severity
// first) appended to `content` as a final fenced text block labelled with
// each notice's source (`renderNoticesBlock`: control characters stripped,
// fences defused), and `structuredContent._tartan = {notices, protocol,
// lane?}`. Nothing relies on `_meta`. Notices are marked delivered by the
// InboxDO `peek` that returns them (`via: "mcp"`).

import {
	type Lane,
	type Notice,
	NOTICES_PER_RESULT,
	type ProtocolMismatch,
	renderNoticesBlock,
	sanitizeNoticeText,
	selectNotices,
	stripControl,
	TARTAN_TRAILER_KEY,
	type TartanTrailer,
	toWire,
} from "@tartan/contract";

export type TextContent = { readonly type: "text"; readonly text: string };

/** The MCP `CallToolResult` the host answers (both transports). */
export type ToolCallResult = {
	readonly content: TextContent[];
	readonly structuredContent: Record<string, unknown>;
	readonly isError?: boolean;
};

/** What a tool produced, before the notices middleware. */
export type ToolOutcome = {
	readonly value: unknown;
	/** Markdown shown instead of the JSON text (e.g. `context_get`). */
	readonly text?: string;
	/** The lane the result is about (`_tartan.lane`). */
	readonly lane?: Lane;
	/** A `protocol_mismatch` answer (an error result). */
	readonly mismatch?: ProtocolMismatch;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** A successful result: the value as JSON text, and as structured content. */
export const okResult = (outcome: ToolOutcome): ToolCallResult => {
	if (outcome.mismatch !== undefined) {
		const m = outcome.mismatch;
		return {
			content: [{
				type: "text",
				text: `protocol_mismatch: ${
					m.message ?? "this repo runs a different protocol"
				}. Register ${m.mcpUrl} as an MCP server and call the tool there.`,
			}],
			structuredContent: { ...m },
			isError: true,
		};
	}
	const json = JSON.stringify(outcome.value ?? null);
	return {
		content: [{ type: "text", text: outcome.text ?? json }],
		structuredContent: isPlainObject(outcome.value)
			? { ...outcome.value }
			: { result: outcome.value ?? null },
	};
};

/**
 * A failed call as a tool result (`isError`), so the model can read and
 * correct it: the wire error (code, message, reason, details) as text and
 * structured content. Internal errors never leak their message (`toWire`).
 */
export const errorResult = (error: unknown): ToolCallResult => {
	const wire = toWire(error);
	return {
		content: [{
			type: "text",
			text: `${wire.error}${wire.reason ? `(${wire.reason})` : ""}: ${
				stripControl(wire.message)
			}`,
		}],
		structuredContent: { ...wire },
		isError: true,
	};
};

/** `_tartan.lane` of a lane. */
export const trailerLane = (
	lane: Lane,
): NonNullable<TartanTrailer["lane"]> => ({
	id: lane.id,
	mode: lane.mode,
	state: lane.state,
	leaseExpiresAt: lane.leaseExpiresAt,
});

/** Notices as they go into `_tartan` (text sanitized again). */
const trailerNotice = (n: Notice): Notice => ({
	...n,
	text: sanitizeNoticeText(n.text),
	...(n.sourceLabel !== undefined
		? { sourceLabel: stripControl(n.sourceLabel) }
		: {}),
});

/**
 * Appends the notices block to `content` and sets `structuredContent._tartan`
 * (the notices middleware). `notices` are the unread notices `peek` returned
 * (already marked delivered).
 */
export const withNotices = (
	result: ToolCallResult,
	notices: readonly Notice[],
	protocol: string,
	lane?: Lane,
): ToolCallResult => {
	const shown = selectNotices(notices, NOTICES_PER_RESULT);
	const block = renderNoticesBlock(shown);
	const trailer: TartanTrailer = {
		notices: shown.map(trailerNotice),
		protocol,
		...(lane !== undefined ? { lane: trailerLane(lane) } : {}),
	};
	return {
		...result,
		content: block === null
			? [...result.content]
			: [...result.content, { type: "text", text: block }],
		structuredContent: {
			...result.structuredContent,
			[TARTAN_TRAILER_KEY]: trailer,
		},
	};
};
