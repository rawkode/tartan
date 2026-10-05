// Text hygiene for anything that crosses principals: echo lines, notices, inbox
// bodies and the notices block appended to MCP results. One implementation,
// used by the gateway, InboxDO, the MCP host and the extension host.

// C0 controls (incl. ESC), DEL and C1 controls.
// deno-lint-ignore no-control-regex
const CONTROL_ALL = /[\u0000-\u001f\u007f-\u009f]/g;
// The same, but keeping TAB and LF.
// deno-lint-ignore no-control-regex
const CONTROL_KEEP_NEWLINES = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
// Bidirectional overrides and isolates (terminal and review spoofing).
const BIDI = /[‪-‮⁦-⁩‎‏؜]/g;

export type StripOptions = {
	/** Keep `\t` and `\n` (inbox bodies, notice text). Default false (echo lines). */
	readonly keepNewlines?: boolean;
};

/** Removes C0/C1 controls (including ESC, so no ANSI/OSC sequences survive), DEL and bidi controls. */
export const stripControl = (
	text: string,
	options: StripOptions = {},
): string =>
	text
		.replace(options.keepNewlines ? CONTROL_KEEP_NEWLINES : CONTROL_ALL, "")
		.replace(BIDI, "");

const encoder = new TextEncoder();

/** UTF-8 byte length. */
export const byteLength = (text: string): number => encoder.encode(text).length;

/** Truncates to at most `maxBytes` UTF-8 bytes without splitting a code point. */
export const truncateBytes = (text: string, maxBytes: number): string => {
	if (byteLength(text) <= maxBytes) return text;
	let out = "";
	let used = 0;
	for (const ch of text) {
		const size = byteLength(ch);
		if (used + size > maxBytes) break;
		out += ch;
		used += size;
	}
	return out;
};

/** Truncates to at most `maxChars` code points. */
export const truncateChars = (text: string, maxChars: number): string => {
	const chars = Array.from(text);
	return chars.length <= maxChars ? text : chars.slice(0, maxChars).join("");
};

/**
 * Neutralizes Markdown code fences inside untrusted text so it cannot close
 * the fence it is shown in (```` ```tartan-notices ```` or ```` ```untrusted ````).
 */
export const defuseFences = (text: string): string =>
	text.replace(/`{3,}/g, (run) => "ˋ".repeat(run.length));

// ---------------------------------------------------------------------------
// Secret redaction (K11)
// ---------------------------------------------------------------------------

/**
 * An Artifacts token as it appears live (`art_v2_x_<hex>?expires=<unix>`
 * [E A1]); an `art_v1_`-only pattern would miss it.
 */
export const ARTIFACTS_TOKEN_RE =
	/art_v([0-9]+)_[A-Za-z0-9_]+(\?expires=[0-9]+)?/;

/**
 * The secret part of a capability path: the v1 shape
 * `/-/cap/v1/<exp>/<ln_…>/<nonce>/<mac>/` and, for safety, the earlier
 * `/-/cap/<exp>/<hex>/<hex>/` shape. A path cut off before the last `/` is
 * still matched.
 */
export const CAP_PATH_SECRET_RE =
	/\/-\/cap\/(?:v1\/[0-9]+\/ln_[0-9A-Za-z]+|[0-9]+)\/[0-9A-Fa-f]+\/[0-9A-Fa-f]+\/?/;

const ARTIFACTS_TOKEN_ALL = new RegExp(ARTIFACTS_TOKEN_RE.source, "g");
const CAP_PATH_SECRET_ALL = new RegExp(CAP_PATH_SECRET_RE.source, "g");

/**
 * The one redaction for Tartan's own sinks (log lines, events, job logs, error
 * messages, UI strings, evidence): Artifacts tokens become
 * `art_v<n>_<redacted>` and capability paths `/-/cap/<redacted>/`. Platform
 * logs (Workers Logs, zone logs, Logpush) are outside it.
 */
export const redactSecrets = (text: string): string =>
	text
		.replace(ARTIFACTS_TOKEN_ALL, (_m, version: string) =>
			`art_v${version}_<redacted>`)
		.replace(CAP_PATH_SECRET_ALL, "/-/cap/<redacted>/");
