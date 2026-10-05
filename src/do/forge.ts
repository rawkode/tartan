// ForgeDO (`forge`, singleton): a thin adapter over
// its modules. Each getter returns the module's RpcTarget
// facade for promise pipelining
// (`env.FORGE.getByName("forge").identity().setupState()`); `alarm()` and the
// `webSocket*` handlers delegate to the host's timer multiplexer and dispatch
// table. Feature logic never goes here.

import { DurableObject } from "cloudflare:workers";
import type { ForgeDoApi } from "@tartan/contract/kernel.ts";
import type { Env } from "../env.ts";
import { forgeBusModule } from "../kernel/bus/relay.ts";
import { forgeEventsModule } from "../kernel/events/forge.ts";
import { registryModule } from "../kernel/exthost/registry/module.ts";
import { identityModule } from "../kernel/identity/module.ts";
import { jobSlotsModule } from "../kernel/runs/slots.ts";
import { treeModule } from "../kernel/tree/module.ts";
import { createDoHost, type DoHost } from "./host.ts";
import { COMMON_MIGRATIONS } from "./migrations.ts";

/** ForgeDO modules: identity 100–199, tree 200–299, registry 300–399, events 400–449, slots 450–499, bus 550–569 (WP26). */
export const FORGE_MODULES = {
	identity: identityModule,
	tree: treeModule,
	registry: registryModule,
	events: forgeEventsModule,
	slots: jobSlotsModule,
	bus: forgeBusModule,
} as const;

/** Common migrations of ForgeDO: meta + _timers, and rate_limits. */
export const FORGE_COMMON = [
	COMMON_MIGRATIONS.base,
	COMMON_MIGRATIONS.rateLimits,
] as const;

export class ForgeDO extends DurableObject<Env> implements ForgeDoApi {
	readonly #host: DoHost<typeof FORGE_MODULES>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.#host = createDoHost({
			kind: "forge",
			ctx,
			env,
			modules: FORGE_MODULES,
			common: FORGE_COMMON,
		});
	}

	identity() {
		return this.#host.facade("identity");
	}

	tree() {
		return this.#host.facade("tree");
	}

	registry() {
		return this.#host.facade("registry");
	}

	events() {
		return this.#host.facade("events");
	}

	slots() {
		return this.#host.facade("slots");
	}

	bus() {
		return this.#host.facade("bus");
	}

	/**
	 * HTTP into a module: the Worker sends
	 * `stub.fetch(moduleRequest("<module>", req))`, e.g. the `/-/live`
	 * WebSocket upgrade for `events`; anything else is 404.
	 */
	override fetch(req: Request): Promise<Response> {
		return this.#host.fetch(req);
	}

	override async alarm(): Promise<void> {
		await this.#host.alarm();
	}

	override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		return this.#host.webSocketMessage(ws, message);
	}

	override webSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
		wasClean: boolean,
	) {
		return this.#host.webSocketClose(ws, code, reason, wasClean);
	}

	override webSocketError(ws: WebSocket, error: unknown) {
		return this.#host.webSocketError(ws, error);
	}
}
