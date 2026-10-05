// The RepoDO subscriber cache and poke matching (WP6). The cache mirrors the
// ForgeDO registry: one row per (installation, subscribed pattern), with the
// ExtensionDO host to poke and the installation's mode. Shadow-emitted events
// reach only shadow subscribers; disabled installations never.

import {
	EVENT_PATTERN_RE,
	extDoName,
	FORGE_DO_NAME,
	invalid,
	matchesEventPattern,
} from "@tartan/contract";
import type {
	InstallationInForce,
	SubscriberRow,
} from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import { withRpc } from "../../do/dispose.ts";
import type { SqlExec } from "./sql.ts";

export const MAX_SUBSCRIBERS = 2000;

export type SubscriberCache = {
	all(): readonly SubscriberRow[];
	/** The registry `ext_version` the cache was built from (null = never built). */
	version(): number | null;
	replace(rows: readonly SubscriberRow[], extVersion: number): void;
};

const validRow = (row: SubscriberRow): boolean =>
	typeof row?.installation_id === "string" &&
	row.installation_id.length > 0 &&
	typeof row.host_name === "string" &&
	row.host_name.length > 0 &&
	typeof row.pattern === "string" &&
	EVENT_PATTERN_RE.test(row.pattern) &&
	typeof row.mode === "string";

/**
 * `replace` runs inside the caller's transaction; the in-memory copy is
 * rebuilt lazily, so a rolled-back replace never leaves it stale.
 */
export const createSubscriberCache = (
	deps: { readonly sql: SqlExec },
): SubscriberCache => {
	let cached: { rows: SubscriberRow[]; version: number | null } | null = null;
	let builtVersion: number | null = null;

	const load = () => {
		if (cached !== null) return cached;
		const rows = deps.sql.exec<SubscriberRow>(
			"SELECT installation_id, host_name, pattern, mode, ext_version FROM subscribers ORDER BY installation_id, pattern",
		).toArray();
		const version = rows.length > 0
			? Math.max(...rows.map((r) => r.ext_version))
			: builtVersion;
		cached = { rows, version };
		return cached;
	};

	return {
		all: () => load().rows,
		version: () => load().version,
		replace: (rows, extVersion) => {
			if (!Number.isInteger(extVersion)) throw invalid("extVersion");
			if (rows.length > MAX_SUBSCRIBERS) {
				throw invalid(`at most ${MAX_SUBSCRIBERS} subscriber rows`);
			}
			if (!rows.every(validRow)) throw invalid("invalid subscriber row");
			deps.sql.exec("DELETE FROM subscribers");
			if (rows.length > 0) {
				deps.sql.exec(
					`INSERT OR REPLACE INTO subscribers (installation_id, host_name, pattern, mode, ext_version)
SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), ?
FROM json_each(?)`,
					extVersion,
					JSON.stringify(
						rows.map((
							r,
						) => [r.installation_id, r.host_name, r.pattern, r.mode]),
					),
				);
			}
			builtVersion = extVersion;
			cached = null;
		},
	};
};

/** Whether a subscriber in `mode` receives an event with `shadow`. */
export const modeReceives = (mode: string, shadow: boolean): boolean =>
	mode === "disabled" ? false : shadow ? mode === "shadow" : true;

/** ExtensionDO hosts to poke for `events` (each at most once). */
export const hostsToPoke = (
	subscribers: readonly SubscriberRow[],
	events: readonly { readonly type: string; readonly shadow: boolean }[],
): string[] => {
	const hosts = new Set<string>();
	for (const sub of subscribers) {
		if (hosts.has(sub.host_name)) continue;
		if (
			events.some((ev) =>
				modeReceives(sub.mode, ev.shadow) &&
				matchesEventPattern(sub.pattern, ev.type)
			)
		) {
			hosts.add(sub.host_name);
		}
	}
	return [...hosts];
};

/** Every host that could receive anything (cron recovery, truncated windows). */
export const allHosts = (subscribers: readonly SubscriberRow[]): string[] => [
	...new Set(
		subscribers.filter((s) => s.mode !== "disabled").map((s) => s.host_name),
	),
];

/** Registry installations in force at the repo → subscriber rows. */
export const subscriberRows = (
	repoId: string,
	inForce: readonly InstallationInForce[],
	extVersion: number,
): SubscriberRow[] => {
	const rows = new Map<string, SubscriberRow>();
	for (const { installation, manifest } of inForce) {
		if (installation.mode === "disabled") continue;
		const host = extDoName(
			installation.id,
			installation.storageScope === "repo"
				? { kind: "repo", repoId }
				: { kind: "node" },
		);
		for (const sub of manifest.subscribe ?? []) {
			rows.set(`${installation.id}\u0000${sub.event}`, {
				installation_id: installation.id,
				host_name: host,
				pattern: sub.event,
				mode: installation.mode,
				ext_version: extVersion,
			});
		}
	}
	return [...rows.values()];
};

/** Where the RepoDO reads the registry from (ForgeDO; injectable for tests). */
export type SubscriberSource = {
	extVersion(): Promise<number>;
	load(repoId: string): Promise<{ rows: SubscriberRow[]; extVersion: number }>;
};

/**
 * Each call opens ForgeDO's registry facade and disposes it when the call
 * settles: every RepoDO checks its subscribers and the events cron
 * loads them for every repo, and an undisposed stub keeps a ForgeDO call
 * context open until it is collected.
 */
export const registrySubscriberSource = (env: Env): SubscriberSource => {
	const registry = () => env.FORGE.getByName(FORGE_DO_NAME).registry();
	const extVersion = () => withRpc(registry, (r) => r.extVersion());
	return {
		extVersion,
		load: async (repoId) => {
			const version = await extVersion();
			const inForce = await withRpc(registry, (r) => r.inForce(repoId));
			return {
				rows: subscriberRows(repoId, inForce, version),
				extVersion: version,
			};
		},
	};
};
