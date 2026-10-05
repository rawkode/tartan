// The global log's health and status (WP26): `/-/health`'s
// minimal `k2` word, and the Owner-only status the Admin "Global log" tile
// reads. Only ids, counts, states and codes; never record content, headers
// beyond `ce_id`/`ce_type`, or the token. No control-plane call is made.

import { FORGE_DO_NAME } from "@tartan/contract";
import type { Env } from "../../env.ts";
import { busDoName, K2_HEALTH_FRESH_MS, logStreamName } from "./config.ts";
import type {
	BusFacade,
	BusStatus,
	K2Health,
	LogStatusResponse,
	RelayStatus,
	RunTransport,
} from "./contract.ts";
import { type BusRelayStub, type K2Env, k2Env } from "./k2.ts";
import { workloadTransportOf } from "./switches.ts";
import { withTimeout } from "./transport.ts";
import { disposeRpc, withRpc } from "../../do/dispose.ts";

/** Status RPCs give up after this (health stays cheap). */
export const STATUS_TIMEOUT_MS = 2_000;

export type StatusPorts = {
	readonly env: K2Env;
	readonly maximum: RunTransport;
	readonly now: () => number;
	/** The `workloads` consumer (worker 0), or null without a `BUS` binding. */
	consumer(): BusFacade | null;
	/** ForgeDO's relay. */
	forgeRelay(): Promise<RelayStatus | null>;
};

export const envStatusPorts = (env: Env): StatusPorts => {
	const k2 = k2Env(env);
	return {
		env: k2,
		maximum: workloadTransportOf(env),
		now: () => Date.now(),
		consumer: () =>
			k2.BUS === undefined
				? null
				: k2.BUS.getByName(busDoName("workloads", 0)).bus(),
		forgeRelay: () =>
			withRpc(
				() =>
					(env.FORGE.getByName(FORGE_DO_NAME) as unknown as BusRelayStub)
						.bus(),
				(bus) => bus.status(),
			),
	};
};

const quietly = async <T>(work: () => Promise<T>): Promise<T | null> => {
	try {
		return await withTimeout(work(), STATUS_TIMEOUT_MS);
	} catch {
		return null;
	}
};

/** The `k2` word from what is configured and what the DOs report. */
export const k2Health = (
	input: {
		readonly producer: boolean;
		readonly stream: boolean;
		readonly token: boolean;
		readonly relay: RelayStatus | null;
		readonly consumer: BusStatus | null;
		readonly now: number;
	},
): K2Health => {
	if (!input.producer || !input.stream) return "off";
	if (input.relay?.state === "blocked") return "blocked";
	if (!input.token) {
		return input.relay === null || input.relay.state === "backoff"
			? "degraded"
			: "produce-only";
	}
	if (input.consumer?.consume === "error") return "blocked";
	if (
		input.relay === null || input.relay.state !== "ok" ||
		input.consumer === null || input.consumer.consume !== "ok" ||
		input.consumer.lastPollOkAt === null ||
		input.consumer.lastPollOkAt < input.now - K2_HEALTH_FRESH_MS
	) {
		return "degraded";
	}
	return "ok";
};

const configured = (env: K2Env) => ({
	producer: env.EVENT_LOG !== undefined,
	stream: typeof env.TARTAN_K2_STREAM === "string" &&
		env.TARTAN_K2_STREAM !== "",
	token: env.TARTAN_K2_TOKEN !== undefined,
});

/** `/-/health` `k2` (unauthenticated). */
export const readK2Health = async (ports: StatusPorts): Promise<K2Health> => {
	const config = configured(ports.env);
	if (!config.producer || !config.stream) return "off";
	const consumer = ports.consumer();
	const [relay, status] = await Promise.all([
		quietly(() => ports.forgeRelay()),
		consumer === null ? null : quietly(() => consumer.status()),
	]).finally(() => disposeRpc(consumer));
	return k2Health({ ...config, relay, consumer: status, now: ports.now() });
};

const HOUR_MS = 3_600_000;

/** `GET /-/api/log/status` (the caller is already the forge Owner). */
export const readLogStatus = async (
	ports: StatusPorts,
): Promise<LogStatusResponse> => {
	const config = configured(ports.env);
	const consumer = ports.consumer();
	const [relay, status] = await Promise.all([
		config.producer && config.stream ? quietly(() => ports.forgeRelay()) : null,
		consumer === null ? null : quietly(() => consumer.status()),
	]).finally(() => disposeRpc(consumer));
	const now = ports.now();
	const since = Math.floor(now / HOUR_MS) * HOUR_MS - HOUR_MS;
	const lastHour = (status?.via ?? [])
		.filter((h) => h.hour >= since)
		.reduce(
			(acc, h) => ({
				k2: acc.k2 + h.k2,
				backstop: acc.backstop + h.backstop,
				local: acc.local + h.local,
			}),
			{ k2: 0, backstop: 0, local: 0 },
		);
	return {
		label: "K2 (public beta)",
		health: k2Health({ ...config, relay, consumer: status, now }),
		transport: ports.maximum,
		stream: {
			configured: config.producer && config.stream,
			name: logStreamName(ports.env.TARTAN_STAGE),
		},
		relay: { forge: relay },
		consumer: status,
		lastHour,
	};
};
