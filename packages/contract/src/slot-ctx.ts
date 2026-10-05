// Slot ctx hints (K12): what a client sends with `/-/api/slot/*` (the base64url
// `ctx` query parameter of a render, the `ctx` of an action body), and the
// per-slot rule for which hints a slot takes (`SLOTS[slot].context` and the
// slot's kind).
//
// One rule, three users:
// - the kernel parses hints with `SlotCtxHintSchema` (api.ts, strict: unknown
//   keys are refused), then refuses any hint the slot does not take with
//   `slotCtxRefusal` before it re-derives and confines every value (K12);
// - the SPA builds one hint per page and narrows it per slot with
//   `narrowSlotCtx` before every render and action, so a page that hosts slots
//   with different contexts (a file banner next to the repo sidebar, a change
//   tab next to the change panels) sends each slot only what it takes;
// - the SPA's mock API checks hints with `checkSlotCtxHint` (the zod-free
//   mirror of `SlotCtxHintSchema`, parity-tested) and `slotCtxRefusal`.
//
// Zod-free on purpose (type-only imports, and values from the zod-free
// `paths.ts` and `slots.ts` only): the SPA bundle imports this module at
// runtime, and zod must stay out of the browser.

import type { EntityRef } from "./common.ts";
import { NODE_PATH_RE, REPO_PATH_RE } from "./paths.ts";
import { SLOT_ROUTE_RE, type SlotId, SLOTS } from "./slots.ts";

/** A line range (`blame.annotation`), 1-based and inclusive. */
export type SlotCtxLines = { readonly start: number; readonly end: number };

/**
 * Client hints for a slot render or action. Every value is a hint: the kernel
 * resolves `node`/`repo` (a path or a node id) through the tree, confines it
 * to the installation's subtree, resolves `ref` to a SHA and checks a lane
 * entity against the repo (K12). Unknown keys are refused.
 *
 * - `node`: the page's node (path or id). For a repo page this is the repo;
 *   the kernel derives `repo` from the node's kind, so pages send `node` only.
 * - `repo`: a repo node, when it differs from what `node` names (rare).
 * - `ref`: a branch, tag or SHA (slots whose context lists `ref`).
 * - `path`: a repo-relative file path (`file.banner`, `blame.annotation`).
 * - `entity`: the change, lane or work item a page shows
 *   (`{kind: "change" | "lane" | "work", id}`).
 * - `route`: for a routed tab page (`static+route` slots only): the
 *   sub-route after the tab of a `repo.tab` / `node.tab` page
 *   (`/-/<tab>/<route>`), the tab's own route for a `change.tab`.
 * - `revision`, `lines`, `gate`: slots whose context lists them.
 */
export type SlotCtxHint = {
	readonly node?: string;
	readonly repo?: string;
	readonly ref?: string;
	readonly path?: string;
	readonly entity?: EntityRef;
	readonly route?: string;
	readonly revision?: number;
	readonly lines?: SlotCtxLines;
	readonly gate?: string;
};

export type SlotCtxHintKey = keyof SlotCtxHint;

export const SLOT_CTX_HINT_KEYS = [
	"node",
	"repo",
	"ref",
	"path",
	"entity",
	"route",
	"revision",
	"lines",
	"gate",
] as const satisfies readonly SlotCtxHintKey[];

/** Entity kinds a slot context can name (`SLOTS[slot].context`). */
export const SLOT_ENTITY_KINDS = ["lane", "work", "change"] as const;
export type SlotEntityKind = (typeof SLOT_ENTITY_KINDS)[number];

/** Limits of `SlotCtxHintSchema` (api.ts), shared with `checkSlotCtxHint`. */
export const SLOT_CTX_LIMITS = {
	nodeMax: 16384,
	refMax: 1024,
	pathMax: 4096,
	entityKindMax: 32,
	entityIdMax: 200,
	revisionMax: 1_000_000,
} as const;
export const SLOT_CTX_ENTITY_KIND_RE = /^[a-z][a-z0-9_-]*$/;
export const SLOT_CTX_GATE_RE = /^[a-z0-9._-]{1,64}$/;

// ---------------------------------------------------------------------------
// Shape (the zod-free mirror of `SlotCtxHintSchema`)
// ---------------------------------------------------------------------------

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";

const isInt = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value);

/** Per-key checks: `null` when the value is well formed, else the problem. */
const FIELD_CHECKS: Readonly<
	Record<SlotCtxHintKey, (value: unknown) => string | null>
> = {
	node: (v) =>
		isString(v) && v.length >= 1 && v.length <= SLOT_CTX_LIMITS.nodeMax &&
			NODE_PATH_RE.test(v)
			? null
			: "a node path or id",
	repo: (v) =>
		isString(v) && v.length >= 1 && v.length <= SLOT_CTX_LIMITS.nodeMax &&
			NODE_PATH_RE.test(v)
			? null
			: "a repo path or id",
	ref: (v) =>
		isString(v) && v.length >= 1 && v.length <= SLOT_CTX_LIMITS.refMax
			? null
			: "1 to 1024 characters",
	path: (v) =>
		isString(v) && v.length <= SLOT_CTX_LIMITS.pathMax && REPO_PATH_RE.test(v)
			? null
			: "a repo-relative path",
	entity: (v) => {
		if (!isObject(v)) return "an object {kind, id}";
		const extra = Object.keys(v).filter((k) => k !== "kind" && k !== "id");
		if (extra.length > 0) return `unknown keys ${extra.join(", ")}`;
		const { kind, id } = v;
		if (
			!isString(kind) || kind.length < 1 ||
			kind.length > SLOT_CTX_LIMITS.entityKindMax ||
			!SLOT_CTX_ENTITY_KIND_RE.test(kind)
		) return "kind is not an entity kind";
		if (
			!isString(id) || id.length < 1 || id.length > SLOT_CTX_LIMITS.entityIdMax
		) {
			return "id is not 1 to 200 characters";
		}
		return null;
	},
	route: (v) => isString(v) && SLOT_ROUTE_RE.test(v) ? null : "a slot route",
	revision: (v) =>
		isInt(v) && v >= 1 && v <= SLOT_CTX_LIMITS.revisionMax
			? null
			: "an integer from 1 to 1000000",
	lines: (v) => {
		if (!isObject(v)) return "an object {start, end}";
		const extra = Object.keys(v).filter((k) => k !== "start" && k !== "end");
		if (extra.length > 0) return `unknown keys ${extra.join(", ")}`;
		return isInt(v.start) && v.start >= 1 && isInt(v.end) && v.end >= 1
			? null
			: "start and end are integers from 1";
	},
	gate: (v) => isString(v) && SLOT_CTX_GATE_RE.test(v) ? null : "a gate id",
};

const isHintKey = (key: string): key is SlotCtxHintKey =>
	Object.hasOwn(FIELD_CHECKS, key);

export type SlotCtxHintCheck =
	| { readonly ok: true; readonly hint: SlotCtxHint }
	| { readonly ok: false; readonly issues: readonly string[] };

/**
 * Checks a decoded hint object the way `SlotCtxHintSchema` parses it (strict:
 * unknown keys fail; an `undefined` value counts as absent). The zod-free
 * mirror for the SPA and its mock; the kernel parses with the schema.
 */
export const checkSlotCtxHint = (value: unknown): SlotCtxHintCheck => {
	if (!isObject(value)) return { ok: false, issues: ["(root): not an object"] };
	const issues: string[] = [];
	const unknown = Object.keys(value).filter((k) => !isHintKey(k));
	if (unknown.length > 0) {
		issues.push(`(root): unrecognized keys ${unknown.join(", ")}`);
	}
	const hint: Record<string, unknown> = {};
	for (const key of SLOT_CTX_HINT_KEYS) {
		const v = value[key];
		if (v === undefined) continue;
		const problem = FIELD_CHECKS[key](v);
		if (problem !== null) issues.push(`${key}: ${problem}`);
		else hint[key] = v;
	}
	return issues.length > 0
		? { ok: false, issues }
		: { ok: true, hint: hint as SlotCtxHint };
};

// ---------------------------------------------------------------------------
// The per-slot rule
// ---------------------------------------------------------------------------

type SlotContextField = (typeof SLOTS)[SlotId]["context"][number];

const wantsOf = (slot: SlotId) => (field: SlotContextField): boolean =>
	(SLOTS[slot].context as readonly string[]).includes(field);

/** The entity kinds `slot` takes (a change slot takes a change, …). */
export const slotEntityKinds = (slot: SlotId): readonly SlotEntityKind[] =>
	SLOT_ENTITY_KINDS.filter(wantsOf(slot));

/**
 * Why the kernel refuses a well-formed hint for `slot`, or `null` when the
 * slot takes it (a slot receives only what its catalogue context lists).
 * The kernel checks the rest itself: the node, repo and entity must exist,
 * lie in the installation's subtree and be readable, a repo-scoped slot needs
 * a repo, and a `ref` must resolve.
 */
export const slotCtxRefusal = (
	slot: SlotId,
	hint: SlotCtxHint,
): string | null => {
	const def = SLOTS[slot];
	const wants = wantsOf(slot);
	const kinds = slotEntityKinds(slot);
	if (hint.entity !== undefined) {
		if (!(kinds as readonly string[]).includes(hint.entity.kind)) {
			return `slot ${slot} takes no ${hint.entity.kind} entity`;
		}
	} else if (kinds.length > 0 && slot !== "agent.context") {
		return `slot ${slot} needs a ${kinds.join(" or ")} entity`;
	}
	if (hint.ref !== undefined && !wants("ref")) {
		return `slot ${slot} takes no ref`;
	}
	if (hint.path !== undefined && !wants("path")) {
		return `slot ${slot} takes no path`;
	}
	if (hint.route !== undefined && def.kind !== "static+route") {
		return `slot ${slot} takes no route`;
	}
	if (hint.lines !== undefined && !wants("lines")) {
		return `slot ${slot} takes no lines`;
	}
	if (hint.lines !== undefined && hint.lines.end < hint.lines.start) {
		return "ctx.lines ends before it starts";
	}
	if (hint.revision !== undefined && !wants("revision")) {
		return `slot ${slot} takes no revision`;
	}
	if (hint.gate !== undefined && !wants("gate")) {
		return `slot ${slot} takes no gate`;
	}
	return null;
};

const filled = (value: string | undefined): value is string =>
	value !== undefined && value !== "";

const wellFormed = (key: SlotCtxHintKey, value: unknown): boolean =>
	FIELD_CHECKS[key](value) === null;

/**
 * Narrows a page's hint to what `slot` takes (`SLOTS[slot].context` and its
 * kind): `node` and `repo` always stay; `ref`, `path`, `lines`, `revision` and
 * `gate` stay only when the context lists them, an `entity` only when its
 * kind is listed, and a `route` only on a routed tab (`static+route`). Empty
 * strings and malformed optional values are dropped, so the result passes
 * `slotCtxRefusal` for every slot whose entity (if it needs one) is present.
 */
export const narrowSlotCtx = (
	slot: SlotId,
	hint: SlotCtxHint,
): SlotCtxHint => {
	const wants = wantsOf(slot);
	const keep = (key: SlotCtxHintKey, wanted: boolean): boolean => {
		const value = hint[key];
		if (!wanted || value === undefined || value === "") return false;
		return wellFormed(key, value);
	};
	const entity = hint.entity;
	return {
		...(filled(hint.node) ? { node: hint.node } : {}),
		...(filled(hint.repo) ? { repo: hint.repo } : {}),
		...(keep("ref", wants("ref")) ? { ref: hint.ref } : {}),
		...(keep("path", wants("path")) ? { path: hint.path } : {}),
		...(entity !== undefined &&
				(slotEntityKinds(slot) as readonly string[]).includes(entity.kind) &&
				wellFormed("entity", entity)
			? { entity: { kind: entity.kind, id: entity.id } }
			: {}),
		...(keep("route", SLOTS[slot].kind === "static+route")
			? { route: hint.route }
			: {}),
		...(keep("revision", wants("revision")) ? { revision: hint.revision } : {}),
		...(keep("lines", wants("lines")) &&
				hint.lines!.end >= hint.lines!.start
			? { lines: { start: hint.lines!.start, end: hint.lines!.end } }
			: {}),
		...(keep("gate", wants("gate")) ? { gate: hint.gate } : {}),
	};
};
