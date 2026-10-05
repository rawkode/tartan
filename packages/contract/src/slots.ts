// Slot catalogue v1 and slot render context.

import type { Actor, EntityRef, InstallMode } from "./common.ts";

export type SlotKind =
	| "static"
	| "dynamic"
	| "static+route"
	| "static+dynamic"
	| "static+action";

export type SlotDef = {
	readonly kind: SlotKind;
	/** What the kernel derives server-side for this slot's render context. */
	readonly context: readonly (
		| "viewer"
		| "node"
		| "repo"
		| "ref"
		| "path"
		| "lane"
		| "work"
		| "change"
		| "revision"
		| "lines"
		| "installation"
		| "forge"
		| "gate"
	)[];
	readonly description: string;
};

export const SLOTS = {
	"nav.global": {
		kind: "static",
		context: ["viewer"],
		description: "global navigation entry",
	},
	"home.section": {
		kind: "dynamic",
		context: ["viewer"],
		description: "home page section (personalised: keep cache 'viewer')",
	},
	"node.tab": {
		kind: "static+route",
		context: ["node"],
		description: "tab on a user or group page",
	},
	"node.section": {
		kind: "dynamic",
		context: ["node"],
		description: "section on a user or group page",
	},
	"repo.tab": {
		kind: "static+route",
		context: ["repo"],
		description: "repo tab with its own sub-route; the page itself is dynamic",
	},
	"repo.sidebar": {
		kind: "dynamic",
		context: ["repo", "ref"],
		description: "repo sidebar panel",
	},
	"repo.header.action": {
		kind: "static+action",
		context: ["repo"],
		description: "repo header button",
	},
	"file.banner": {
		kind: "dynamic",
		context: ["repo", "ref", "path"],
		description: "banner above a file view",
	},
	"lane.badge": {
		kind: "dynamic",
		context: ["lane"],
		description: "badge on a lane",
	},
	"lane.sidebar": {
		kind: "dynamic",
		context: ["lane"],
		description: "lane sidebar panel",
	},
	"work.panel": {
		kind: "dynamic",
		context: ["work"],
		description: "panel on a work item",
	},
	"work.sidebar": {
		kind: "dynamic",
		context: ["work"],
		description: "work item sidebar",
	},
	"change.tab": {
		kind: "static+route",
		context: ["change", "revision"],
		description: "tab on a change",
	},
	"change.panel": {
		kind: "dynamic",
		context: ["change", "revision"],
		description: "panel on a change",
	},
	"change.sidebar": {
		kind: "dynamic",
		context: ["change", "revision"],
		description: "change sidebar",
	},
	"change.gate": {
		kind: "dynamic",
		context: ["change", "gate"],
		description: "gate result chip on a change",
	},
	"blame.annotation": {
		kind: "dynamic",
		context: ["repo", "ref", "path", "lines"],
		description: "why-blame annotation for a line range",
	},
	"hud.metric": {
		kind: "dynamic",
		context: ["forge"],
		description: "HUD metric (may declare cache 'role')",
	},
	"settings.page": {
		kind: "static+dynamic",
		context: ["installation"],
		description: "installation settings form",
	},
	"agent.context": {
		kind: "dynamic",
		context: ["work", "lane"],
		description:
			"markdown only; contributed via context@1 (contributes.context)",
	},
} as const satisfies Record<string, SlotDef>;

/** A routed contribution's `route` (manifest `contributes.slots[].route`). */
export const SLOT_ROUTE_RE = /^[a-z0-9-/*]{1,64}$/;

export type SlotId = keyof typeof SLOTS;
export const SLOT_IDS = Object.keys(SLOTS) as SlotId[];
export const isKnownSlot = (slot: string): slot is SlotId =>
	Object.hasOwn(SLOTS, slot);

export type RenderCacheScope = "viewer" | "role" | "none";

/**
 * Render/action/gate context. Mirrors WIT `slot-context`. Every field
 * is derived server-side from the route and confined to the installation
 * subtree before the call (K12); client values are hints only.
 */
export type SlotContext = {
	/**
	 * The catalogue slot of the contribution being rendered or acted on,
	 * e.g. `repo.tab`; absent for gates. The kernel derives the rest of the
	 * context from `SLOTS[slot].context`.
	 */
	readonly slot?: SlotId;
	/** Node id. */
	readonly node: string;
	/** Repo id (repo-scoped slots). */
	readonly repo?: string;
	/** Git ref or sha (`git-ref` in WIT). */
	readonly ref?: string;
	/** Repo-relative file path. */
	readonly path?: string;
	/** Lane, change, work item, selection … */
	readonly entity?: EntityRef;
	readonly viewer?: Actor;
	readonly mode: InstallMode;
	/**
	 * Kernel-derived extras that have no dedicated field: `route` (sub-route
	 * under a `repo.tab`), `revision`, `lines: {start, end}`, `gate`.
	 */
	readonly extra?: Readonly<Record<string, unknown>>;
};

/**
 * Context for MCP tool calls routed to an extension. Extension-visible: the
 * actor's credential bounds travel separately (`ExtensionHostApi.callTool`).
 */
export type ToolContext = {
	readonly node: string;
	readonly repo?: string;
	/** The MCP scope path the session was opened at (`/-/mcp/<path>`). */
	readonly scope: string;
	readonly laneId?: string;
	readonly actor: Actor;
	readonly mode: InstallMode;
};

/** What `when` expressions on static contributions see. */
export type WhenContext = {
	readonly viewer: { readonly role: number };
	readonly node: { readonly kind: "user" | "group" | "repo" };
	readonly entity?: { readonly kind: string };
};
