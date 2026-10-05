// The K2 producer binding, typed by hand (workers-types has no K2 type;
// wrangler 4.145's `wrangler types` emits exactly this shape), and the
// global log's view of the bindings it reads from `Env`. `send()` never
// throws for a rejected batch: it answers `{success: false, error}`.

import type { Env } from "../../env.ts";
import type { BusFacade, BusRelayFacade } from "./contract.ts";

export type K2Record = {
	readonly content: Uint8Array;
	readonly headers?: Readonly<Record<string, string>>;
};

export type K2SendError = {
	readonly code: number;
	readonly message: string;
	readonly retryable: boolean;
};

export type K2SendResult =
	| { readonly success: true }
	| { readonly success: false; readonly error: K2SendError };

export interface K2Producer {
	send(records: K2Record[]): Promise<K2SendResult>;
}

/** A Secrets Store binding (`secrets_store_secrets`). */
export interface StoredSecret {
	get(): Promise<string>;
}

/** What `env.BUS.getByName(name)` answers, as the bus code uses it. */
export type BusStub = { bus(): BusFacade };
export type BusNamespace = { getByName(name: string): BusStub };

/** What `env.REPO.getByName(name)` / `env.FORGE.getByName(name)` add. */
export type BusRelayStub = { bus(): BusRelayFacade };

/**
 * The global-log slice of `Env`, its fields taken from `Env` itself (a rename
 * there fails to compile here): the producer binding and the stream id are
 * rendered per stage only, the K2 Consume token is read by the BusDO only.
 * `BUS` is the bus code's narrow view of the BusDO namespace (optional for
 * fakes and the consumer-less tests).
 */
export type K2Env =
	& Pick<Env, "TARTAN_STAGE" | "EVENT_LOG" | "TARTAN_K2_STREAM">
	& {
		readonly TARTAN_K2_TOKEN?: StoredSecret;
		readonly BUS?: BusNamespace;
	};

/** The global-log view of a Worker `Env`. */
export const k2Env = (env: Env): K2Env => ({
	TARTAN_STAGE: env.TARTAN_STAGE,
	...(env.EVENT_LOG !== undefined ? { EVENT_LOG: env.EVENT_LOG } : {}),
	...(env.TARTAN_K2_STREAM !== undefined
		? { TARTAN_K2_STREAM: env.TARTAN_K2_STREAM }
		: {}),
	...(env.TARTAN_K2_TOKEN !== undefined
		? { TARTAN_K2_TOKEN: env.TARTAN_K2_TOKEN }
		: {}),
	...(env.BUS !== undefined ? { BUS: env.BUS as unknown as BusNamespace } : {}),
});
