// Job log hygiene (K11): every byte a job writes passes a line-buffered
// redactor before it reaches DO storage, RepoDO, R2 or an API response, so a
// token split across two output chunks is still matched (tokens never contain a
// newline).

import {
	ARTIFACTS_TOKEN_RE,
	byteLength,
	CAP_PATH_SECRET_RE,
	redactSecrets,
	truncateBytes,
} from "@tartan/contract";

/** The redacted tail RepoDO keeps per job (`jobs.tail`, last 8 KB). */
export const JOB_TAIL_BYTES = 8 * 1024;
/** A line longer than this is flushed unterminated (bounded memory). */
export const MAX_PENDING_LINE_BYTES = 16 * 1024;
/** The pump flushes to RepoDO this often. */
export const LOG_FLUSH_MS = 500;

/** R2 key of a job's full log. */
export const jobLogKey = (
	repoId: string,
	runId: string,
	jobId: string,
): string => `logs/${repoId}/${runId}/${jobId}.log`;

export type LineRedactor = {
	/** Feeds raw output; returns the redacted complete lines it now holds. */
	push(chunk: string): string;
	/** Returns whatever is left (the unterminated last line), redacted. */
	end(): string;
};

/**
 * What a forced flush of an over-long line keeps back: longer than any
 * secret `redactSecrets` knows (an Artifacts token is about 80 characters, a
 * capability path about 150), so a secret still arriving is never split
 * across two flushed outputs that a sink later joins.
 */
export const SECRET_HOLDBACK_CHARS = 512;

const SECRET_PATTERNS = [ARTIFACTS_TOKEN_RE, CAP_PATH_SECRET_RE].map((re) =>
	new RegExp(re.source, "g")
);

/**
 * Where a forced flush may cut `text`: `hold` characters before its end,
 * moved back to the start of any secret that would straddle the cut. A
 * secret longer than the whole window is cut anyway (the line must move).
 */
const safeCut = (text: string, hold: number): number => {
	let cut = Math.max(0, text.length - hold);
	for (let moved = true; moved && cut > 0;) {
		moved = false;
		for (const re of SECRET_PATTERNS) {
			for (const m of text.matchAll(re)) {
				if (m.index < cut && m.index + m[0].length > cut) {
					cut = m.index;
					moved = true;
				}
			}
		}
	}
	return cut > 0 ? cut : Math.max(1, text.length - hold);
};

/**
 * Splits on newlines and redacts each complete line with `redactSecrets`.
 * A pending partial line is held back until its newline arrives or it grows
 * past `MAX_PENDING_LINE_BYTES`; then all but its last
 * `SECRET_HOLDBACK_CHARS` (never inside a secret) is flushed.
 */
export const createLineRedactor = (
	maxPending: number = MAX_PENDING_LINE_BYTES,
): LineRedactor => {
	let pending = "";
	const hold = Math.min(SECRET_HOLDBACK_CHARS, Math.floor(maxPending / 2));
	return {
		push: (chunk) => {
			pending += chunk;
			const cut = pending.lastIndexOf("\n");
			let out = "";
			if (cut !== -1) {
				out = redactSecrets(pending.slice(0, cut + 1));
				pending = pending.slice(cut + 1);
			}
			if (byteLength(pending) > maxPending) {
				const at = safeCut(pending, hold);
				out += redactSecrets(pending.slice(0, at));
				pending = pending.slice(at);
			}
			return out;
		},
		end: () => {
			const out = redactSecrets(pending);
			pending = "";
			return out;
		},
	};
};

/** The last `maxBytes` UTF-8 bytes of `text`, never splitting a code point. */
export const tailBytes = (text: string, maxBytes: number): string => {
	if (byteLength(text) <= maxBytes) return text;
	const chars = Array.from(text);
	let used = 0;
	let start = chars.length;
	while (start > 0) {
		const size = byteLength(chars[start - 1]);
		if (used + size > maxBytes) break;
		used += size;
		start -= 1;
	}
	return chars.slice(start).join("");
};

/** Characters an Artifacts token or a capability path is made of. */
const SECRET_CHAR = /[A-Za-z0-9_?=/.:-]/;
const SECRET_RUN = /^[A-Za-z0-9_?=/.:-]+/;

/**
 * The last `maxBytes` of `text`, redacted after the join (two redacted
 * halves of a secret can form a whole one again) and without a partial
 * secret at its start: when the cut falls inside a run of secret characters
 * no longer than a secret, the rest of that run is dropped. A longer run is
 * ordinary output (a secret's own run would have been redacted whole), so it
 * stays.
 */
export const secretSafeTail = (
	text: string,
	maxBytes: number = JOB_TAIL_BYTES,
): string => {
	const redacted = redactSecrets(text);
	const tail = tailBytes(redacted, maxBytes);
	if (tail.length === redacted.length) return tail;
	const before = redacted[redacted.length - tail.length - 1];
	const run = SECRET_RUN.exec(tail)?.[0] ?? "";
	return SECRET_CHAR.test(before) && run.length <= SECRET_HOLDBACK_CHARS
		? tail.slice(run.length)
		: tail;
};

/** Appends a chunk to a tail and keeps the last `maxBytes` (`secretSafeTail`). */
export const appendTail = (
	tail: string,
	chunk: string,
	maxBytes: number = JOB_TAIL_BYTES,
): string => secretSafeTail(tail + chunk, maxBytes);

/** Redacts and caps text that leaves the kernel in an error or step output. */
export const safeText = (text: string, maxBytes = 2048): string =>
	truncateBytes(redactSecrets(text), maxBytes);
