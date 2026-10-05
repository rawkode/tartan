// `tartan-ui@1` constants for the SPA renderer.
//
// Types come from `@tartan/contract/ui.ts` (type-only imports, so zod never
// reaches the browser bundle). The runtime constants below are copies of the
// contract's values for the same reason; `test/contract-parity.spec.ts`
// asserts that every copy equals the contract export, so drift fails CI.
//
// The SPA receives only documents the kernel validated with `validateUi()` and
// re-serialized from the parsed value. The renderer still treats every field as
// untrusted: it re-checks each node's shape (`guards.ts`) and falls back to a
// chip for anything it does not recognise.

import type { Tone, UiNodeType } from "@tartan/contract/ui.ts";

export type {
	ErrorChipNode,
	HostUiDoc,
	Tone,
	UiAction,
	UiDoc,
	UiJson,
	UiNode,
	UiNodeType,
} from "@tartan/contract/ui.ts";

export const UI_NODE_TYPES: readonly UiNodeType[] = [
	"stack",
	"row",
	"grid",
	"section",
	"card",
	"tabs",
	"divider",
	"heading",
	"text",
	"markdown",
	"code",
	"badge",
	"label",
	"avatar",
	"icon",
	"link",
	"empty",
	"progress",
	"kv",
	"stat",
	"alert",
	"button",
	"menu",
	"form",
	"input",
	"textarea",
	"select",
	"checkbox",
	"table",
	"list",
	"timeline",
	"diff",
	"board",
	"matrix",
	"sparkline",
];

export const TONES: readonly Tone[] = [
	"neutral",
	"info",
	"success",
	"warning",
	"danger",
	"muted",
];

export const UI_LIMITS = {
	maxNodes: 500,
	maxBytes: 64 * 1024,
	maxDepth: 16,
} as const;

/** Host-level depth limit. */
export const MAX_DEPTH = UI_LIMITS.maxDepth;

/** Host-only node: produced by the kernel for failed renders, never accepted from extensions. */
export const ERROR_CHIP = "error-chip";

// deno-lint-ignore no-control-regex
export const SAME_ORIGIN_PATH_RE = /^\/(?![/\\])[^\u0000-\u001f\u007f]*$/;
export const LINK_HREF_RE =
	// deno-lint-ignore no-control-regex
	/^(?:\/(?![/\\])|https:\/\/)[^\u0000-\u001f\u007f]*$/;
export const AVATAR_PRINCIPAL_RE = /^[a-z0-9_]{1,80}$/;
export const ICON_NAME_RE = /^[a-z0-9-]{1,32}$/;
export const ACTION_ID_RE = /^[a-z0-9._-]{1,64}$/;
export const FIELD_NAME_RE = /^[a-z0-9_]{1,32}$/;

const KNOWN: ReadonlySet<string> = new Set(UI_NODE_TYPES);
const TONE_SET: ReadonlySet<string> = new Set(TONES);

export const isUiNodeType = (t: unknown): t is UiNodeType =>
	typeof t === "string" && KNOWN.has(t);

export const isTone = (value: unknown): value is Tone =>
	typeof value === "string" && TONE_SET.has(value);

/** A tone for CSS classes: anything that is not a known tone becomes `neutral`. */
export const toneOf = (value: unknown, fallback: Tone = "neutral"): Tone =>
	isTone(value) ? value : fallback;
