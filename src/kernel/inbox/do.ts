// InboxDO (`inbox:<principalId>`): per-principal
// notices, presence and long-poll waiters. A thin adapter over the `inbox`
// module on the shared DO host (migrations, `_timers`, sockets); its RPC
// surface is `InboxFacade` directly on the class, with `wait` taking the
// delivery channel it marks (`mcp` by default). Class and module: WP6.

import { DurableObject } from "cloudflare:workers";
import type { InboxFacade } from "@tartan/contract/kernel.ts";
import { createDoHost, type DoHost } from "../../do/host.ts";
import { COMMON_MIGRATIONS } from "../../do/migrations.ts";
import type { Env } from "../../env.ts";
import { type InboxApi, inboxModule } from "./module.ts";

export const INBOX_MODULES = { inbox: inboxModule } as const;

type Api<K extends keyof InboxApi> = InboxApi[K];

export class InboxDO extends DurableObject<Env> implements InboxFacade {
	readonly #host: DoHost<typeof INBOX_MODULES>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.#host = createDoHost({
			kind: "inbox",
			ctx,
			env,
			modules: INBOX_MODULES,
			common: [COMMON_MIGRATIONS.base],
		});
	}

	#inbox(): InboxApi {
		return this.#host.facade("inbox");
	}

	deliver(...args: Parameters<Api<"deliver">>): ReturnType<Api<"deliver">> {
		return this.#inbox().deliver(...args);
	}

	peek(...args: Parameters<Api<"peek">>): ReturnType<Api<"peek">> {
		return this.#inbox().peek(...args);
	}

	read(...args: Parameters<Api<"read">>): ReturnType<Api<"read">> {
		return this.#inbox().read(...args);
	}

	ack(...args: Parameters<Api<"ack">>): ReturnType<Api<"ack">> {
		return this.#inbox().ack(...args);
	}

	wait(...args: Parameters<Api<"wait">>): ReturnType<Api<"wait">> {
		return this.#inbox().wait(...args);
	}

	unreadCount(): ReturnType<Api<"unreadCount">> {
		return this.#inbox().unreadCount();
	}

	touch(...args: Parameters<Api<"touch">>): ReturnType<Api<"touch">> {
		return this.#inbox().touch(...args);
	}

	presence(...args: Parameters<Api<"presence">>): ReturnType<Api<"presence">> {
		return this.#inbox().presence(...args);
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
