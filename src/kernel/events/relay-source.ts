// What both event logs (RepoDO `./repo.ts`, ForgeDO `./forge.ts`) share for
// the global log relay (WP26): the log's epoch and isolated listener calls.

import { first, type SqlExec } from "./sql.ts";

/** The `meta` key of the log's epoch. */
export const EPOCH_META_KEY = "events.epoch";

/**
 * The log's epoch: a ULID in `meta`, minted on first use, so a storage reset
 * (a dev reset, a new DO) always starts a new epoch.
 */
export const epochOf = (sql: SqlExec, mint: () => string): string => {
	const read = () =>
		first(
			sql.exec<{ v: string }>(
				"SELECT v FROM meta WHERE k = ?",
				EPOCH_META_KEY,
			),
		)?.v ?? null;
	const existing = read();
	if (existing !== null) return existing;
	sql.exec(
		"INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)",
		EPOCH_META_KEY,
		mint(),
	);
	return read()!;
};

/** Calls every listener, each isolated: one failure never skips another. */
export const callEach = (
	listeners: readonly (() => void)[],
	onError: (error: unknown) => void,
): void => {
	for (const listener of listeners) {
		try {
			listener();
		} catch (error) {
			onError(error);
		}
	}
};
