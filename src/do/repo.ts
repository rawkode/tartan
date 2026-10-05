// RepoDO (`repo:<repoUlid>`): a thin adapter over its modules. Each getter
// returns the module's RpcTarget facade for promise pipelining
// (`env.REPO.getByName(repoDoName(id)).core().recordPush(…)`); `alarm()`, the
// `webSocket*` handlers and `fetch` delegate to the host's timer multiplexer,
// WebSocket dispatch table and module fetch routing (the live feed registers
// there). Feature logic never goes here.

import { DurableObject } from "cloudflare:workers";
import type { RepoDoApi } from "@tartan/contract/kernel.ts";
import type { Env } from "../env.ts";
import { repoBusModule } from "../kernel/bus/relay.ts";
import { repoEventsModule } from "../kernel/events/repo.ts";
import { repoLandModule } from "../kernel/land/module.ts";
import { repoProbeModule } from "../kernel/probe/module.ts";
import { repoCoreModule } from "../kernel/repo/module.ts";
import { repoConfigModule } from "../kernel/repoconfig/module.ts";
import { repoRunsModule } from "../kernel/runs/module.ts";
import { createDoHost, type DoHost } from "./host.ts";
import { COMMON_MIGRATIONS } from "./migrations.ts";

/**
 * RepoDO modules: core 100–199 (WP5a 100–179, the `repo` lane
 * backend of WP5b 180–199), events 200–249, probe 250–299, runs 300–349,
 * land 350–399, repoconfig 400–429 (WP23), bus 460–479 (the global
 * log relay, WP26).
 */
export const REPO_MODULES = {
	core: repoCoreModule,
	events: repoEventsModule,
	probe: repoProbeModule,
	runs: repoRunsModule,
	land: repoLandModule,
	repoconfig: repoConfigModule,
	bus: repoBusModule,
} as const;

/** Common migrations of RepoDO: meta + _timers. */
export const REPO_COMMON = [COMMON_MIGRATIONS.base] as const;

export class RepoDO extends DurableObject<Env> implements RepoDoApi {
	readonly #host: DoHost<typeof REPO_MODULES>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.#host = createDoHost({
			kind: "repo",
			ctx,
			env,
			modules: REPO_MODULES,
			common: REPO_COMMON,
		});
	}

	core() {
		return this.#host.facade("core");
	}

	events() {
		return this.#host.facade("events");
	}

	probe() {
		return this.#host.facade("probe");
	}

	runs() {
		return this.#host.facade("runs");
	}

	land() {
		return this.#host.facade("land");
	}

	repoconfig() {
		return this.#host.facade("repoconfig");
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
