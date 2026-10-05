// Run transport selection (WP26): chosen per run at runtime.
// A CI run goes through the global log only when every condition holds; any
// missing piece (the button path has no binding, a produce-only forge has no
// token, the relay is backing off, the consumer is silent) means `local`:
// dispatched inline, as before the log existed, with no added delay.
// Kernel runs (`requestedBy: "kernel"`, every `git` run) are always `local`.

import type { Clock } from "@tartan/contract/kernel.ts";
import {
	busDoName,
	K2_HEALTH_FRESH_MS,
	K2_HEALTH_TIMEOUT_MS,
	K2_HEALTH_TTL_MS,
} from "./config.ts";
import type { BusStatus, RelayState, RunTransport } from "./contract.ts";
import type { K2Env } from "./k2.ts";
import { withRpc } from "../../do/dispose.ts";

export type TransportInputs = {
	readonly kind: string;
	readonly requestedBy: string;
	/** The stage's maximum (`workloadTransportOf`). */
	readonly maximum: RunTransport;
	readonly producer: boolean;
	readonly stream: boolean;
	readonly token: boolean;
	/** This DO's relay state (null: no relay module). */
	readonly relay: RelayState | null;
	readonly consumerHealthy: boolean;
};

/** The pure rule. */
export const selectTransport = (input: TransportInputs): RunTransport =>
	input.kind === "ci" && input.requestedBy !== "kernel" &&
		input.maximum === "k2" && input.producer && input.stream &&
		input.token && input.relay === "ok" && input.consumerHealthy
		? "k2"
		: "local";

/** The consumer polled successfully within `K2_HEALTH_FRESH_MS` and has a subscription. */
export const consumerIsHealthy = (
	status: BusStatus | null,
	now: number,
): boolean =>
	status !== null && status.consume === "ok" &&
	status.subscription !== null && status.lastPollOkAt !== null &&
	status.lastPollOkAt >= now - K2_HEALTH_FRESH_MS;

export type ConsumerHealth = {
	/** Cached `K2_HEALTH_TTL_MS`; a miss asks the BusDO with a 500 ms bound. */
	healthy(): Promise<boolean>;
	/** Forgets the cached answer. */
	reset(): void;
};

export const withTimeout = <T>(work: Promise<T>, ms: number): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
	});
	return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
};

/** At most one status RPC per DO per TTL; any error or timeout is unhealthy. */
export const createConsumerHealth = (
	deps: {
		readonly clock: Clock;
		readonly status: () => Promise<BusStatus | null>;
		readonly ttlMs?: number;
		readonly timeoutMs?: number;
	},
): ConsumerHealth => {
	const ttl = deps.ttlMs ?? K2_HEALTH_TTL_MS;
	const timeoutMs = deps.timeoutMs ?? K2_HEALTH_TIMEOUT_MS;
	let cached: { at: number; healthy: boolean } | null = null;
	let pending: Promise<boolean> | null = null;
	return {
		healthy: () => {
			const now = deps.clock.now();
			if (cached !== null && now - cached.at < ttl) {
				return Promise.resolve(cached.healthy);
			}
			pending ??= withTimeout(deps.status(), timeoutMs)
				.then((status) => consumerIsHealthy(status, deps.clock.now()))
				.catch(() => false)
				.then((healthy) => {
					cached = { at: deps.clock.now(), healthy };
					pending = null;
					return healthy;
				});
			return pending;
		},
		reset: () => {
			cached = null;
		},
	};
};

/** What `runs.start` asks: the transport for one new run. */
export type TransportPort = {
	choose(input: { kind: string; requestedBy: string }): Promise<RunTransport>;
};

/** The production port: the switch, the bindings, this DO's relay and the consumer. */
export const createTransportPort = (
	deps: {
		readonly maximum: RunTransport;
		readonly env: K2Env;
		readonly relay: () => RelayState | null;
		readonly clock: Clock;
		readonly health?: ConsumerHealth;
	},
): TransportPort => {
	const { env } = deps;
	const health = deps.health ?? createConsumerHealth({
		clock: deps.clock,
		status: () =>
			env.BUS === undefined ? Promise.resolve(null) : withRpc(
				() => env.BUS!.getByName(busDoName("workloads", 0)).bus(),
				(b) => b.status(),
			),
	});
	return {
		choose: async ({ kind, requestedBy }) => {
			const sync = {
				kind,
				requestedBy,
				maximum: deps.maximum,
				producer: env.EVENT_LOG !== undefined,
				stream: typeof env.TARTAN_K2_STREAM === "string" &&
					env.TARTAN_K2_STREAM !== "",
				token: env.TARTAN_K2_TOKEN !== undefined,
				relay: deps.relay(),
			};
			// The RPC is asked only when everything else already says `k2`.
			if (selectTransport({ ...sync, consumerHealthy: true }) === "local") {
				return "local";
			}
			return selectTransport({
				...sync,
				consumerHealthy: await health.healthy(),
			});
		},
	};
};
