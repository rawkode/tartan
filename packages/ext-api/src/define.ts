// `defineExtension` and the ExtCtx helpers every extension uses (K12).

import {
	ACTOR_REQUIRED_TOOLS,
	denied,
	type ExtCtx,
	type ExtensionModule,
	internal,
} from "@tartan/contract";

/** Every hook an extension module may export. */
export const EXTENSION_HOOKS = [
	"init",
	"onEvent",
	"onTimer",
	"gate",
	"echo",
	"render",
	"onAction",
	"callTool",
	"context",
] as const satisfies readonly (keyof ExtensionModule)[];
export type ExtensionHook = typeof EXTENSION_HOOKS[number];

/**
 * Declares an extension module. Checks that every key is a known hook and
 * every hook is a function, and freezes the module so no call can replace a
 * hook for later calls (state belongs in `sql`/`kv`, never in module objects).
 */
export const defineExtension = <M extends ExtensionModule>(module: M): M => {
	for (const [key, value] of Object.entries(module)) {
		if (!(EXTENSION_HOOKS as readonly string[]).includes(key)) {
			throw internal(`defineExtension: unknown hook "${key}"`);
		}
		if (typeof value !== "function") {
			throw internal(`defineExtension: hook "${key}" is not a function`);
		}
	}
	return Object.freeze({ ...module });
};

/**
 * True for a background call: the acting principal is the installation
 * itself (`x_<inst>`: init, onEvent, onTimer, gate, echo, a background
 * `interfaces.call`) or the kernel.
 */
export const isBackground = (x: Pick<ExtCtx, "actor">): boolean =>
	x.actor.kind === "ext" || x.actor.kind === "system";

/**
 * K12: a mutating interface tool (`queue_enqueue`, `review_decide`,
 * `work_claim`) needs a user or agent actor, unless the
 * provider's documented precondition holds (e.g. `queue_enqueue` only for a
 * change with a non-shadow approval). Throws `denied("actor")` otherwise.
 */
export const requireInteractiveActor = (
	x: Pick<ExtCtx, "actor">,
	tool: string,
	precondition: () => boolean = () => false,
): void => {
	if (isBackground(x) && !precondition()) {
		throw denied(
			"actor",
			`${tool} needs a user or agent actor (K12)`,
		);
	}
};

/** True when `tool` is one of the K12 actor-required interface tools. */
export const isActorRequiredTool = (tool: string): boolean =>
	(ACTOR_REQUIRED_TOOLS as readonly string[]).includes(tool);

/** The principals an actor acts as: itself and, for an agent, the user it acts for. */
export const actingPrincipals = (x: Pick<ExtCtx, "actor">): string[] =>
	x.actor.onBehalfOf ? [x.actor.id, x.actor.onBehalfOf] : [x.actor.id];
