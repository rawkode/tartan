// Protected-ref patterns of a repo (K1, K8): the default branch always, plus
// the patterns inherited down the tree from ForgeDO (WP3's `protectedRefs`).
// They are read in async entry points and cached in memory, so the synchronous
// paths (observations inside a transaction) use the last known set. Import mode
// turns protection off.

import { type Core, errorText, getMeta, isImporting } from "./core.ts";

/** How long a fetched pattern set is reused. */
export const PROTECTION_TTL_MS = 60_000;

export type Protection = {
	/** Refreshes the cache when stale; a ForgeDO failure keeps the last set. */
	refresh(): Promise<void>;
	/** The patterns in force now (`[]` while importing). */
	patterns(): readonly string[];
	/** For tests and `importComplete`: forget the cached set. */
	invalidate(): void;
};

export const createProtection = (core: Core): Protection => {
	let cached:
		| { readonly patterns: readonly string[]; readonly at: number }
		| null = null;

	const refresh = async (): Promise<void> => {
		const now = core.clock.now();
		if (cached !== null && now - cached.at < PROTECTION_TTL_MS) return;
		const nodeId = getMeta(core.sql, "node_id");
		if (nodeId === null) return;
		try {
			const patterns = await core.ports.forgeTree().protectedRefs(nodeId);
			cached = { patterns: [...patterns], at: now };
		} catch (error) {
			core.ports.log("protected refs unavailable", { error: errorText(error) });
			cached = { patterns: cached?.patterns ?? [], at: now };
		}
	};

	return {
		refresh,
		patterns: () => isImporting(core.sql) ? [] : cached?.patterns ?? [],
		invalidate: () => {
			cached = null;
		},
	};
};
