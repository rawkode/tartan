// Shared by the repo and forge event modules (WP6): poke delivery to
// ExtensionDOs, coalescing constants and small helpers.

import type { StreamRef } from "@tartan/contract";
import type { Env } from "../../env.ts";

/** Poke coalescing: 25 ms idle, ≤ 1 run per 250 ms. */
export const POKE_DELAY_MS = 25;
export const POKE_MIN_INTERVAL_MS = 250;

export type PokeSink = (
	host: string,
	input: { stream: StreamRef; head: number },
) => Promise<void>;

export type Logger = (message: string, data: Record<string, unknown>) => void;

export const extensionPokeSink = (env: Env): PokeSink => (host, input) =>
	env.EXT.getByName(host).poke(input);

/** Runs `fn` and returns its result as a promise (sync throws become rejections). */
export const settle = <T>(fn: () => T): Promise<T> => {
	try {
		return Promise.resolve(fn());
	} catch (error) {
		return Promise.reject(error);
	}
};

const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/** Logs each distinct failure once, so a stubbed peer is not noisy. */
export const createReportOnce = (log: Logger) => {
	const reported = new Set<string>();
	return (message: string, error: unknown): void => {
		const text = `${message}: ${errorText(error)}`;
		if (reported.has(text)) return;
		reported.add(text);
		log(message, { error: errorText(error) });
	};
};
