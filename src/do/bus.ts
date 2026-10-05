// BusDO (`bus:<group>:<n>`; WP26): a thin adapter over the
// global log's consumer module. It polls the forge's K2
// stream on its own alarm (the WP0 timers, `bus/poll` and `bus/retry`) and
// applies each record through its group's handler. Feature logic never goes
// here.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { busConsumerModule } from "../kernel/bus/consumer.ts";
import { createDoHost, type DoHost } from "./host.ts";
import { COMMON_MIGRATIONS } from "./migrations.ts";

/** BusDO modules: the consumer, 100–199. */
export const BUS_MODULES = { bus: busConsumerModule } as const;

/** Common migrations of BusDO: meta + _timers. */
export const BUS_COMMON = [COMMON_MIGRATIONS.base] as const;

export class BusDO extends DurableObject<Env> {
	readonly #host: DoHost<typeof BUS_MODULES>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.#host = createDoHost({
			kind: "bus",
			ctx,
			env,
			modules: BUS_MODULES,
			common: BUS_COMMON,
		});
	}

	bus() {
		return this.#host.facade("bus");
	}

	override async alarm(): Promise<void> {
		await this.#host.alarm();
	}
}
