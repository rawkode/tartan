// `awaitLane` waiters: in-memory promises per lane, released after the
// transaction that moved the lane out of `opening` committed (WP5b's open or
// fallback CAS, WP5a's close CAS), or at their timeout. Only the MCP host
// waits, outside any ExtensionDO.

export type LaneWaiters = {
	/** Resolves when `release(laneId)` runs or after `timeoutMs`, whichever is first. */
	wait(laneId: string, timeoutMs: number): Promise<void>;
	release(laneId: string): void;
	/** Waiters currently registered (tests, diagnostics). */
	count(laneId?: string): number;
};

export const createLaneWaiters = (): LaneWaiters => {
	const waiting = new Map<string, Set<() => void>>();

	const release = (laneId: string): void => {
		const set = waiting.get(laneId);
		if (set === undefined) return;
		waiting.delete(laneId);
		for (const resolve of set) resolve();
	};

	const wait = (laneId: string, timeoutMs: number): Promise<void> =>
		new Promise<void>((resolve) => {
			let settled = false;
			const done = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				waiting.get(laneId)?.delete(done);
				if (waiting.get(laneId)?.size === 0) waiting.delete(laneId);
				resolve();
			};
			const timer = setTimeout(done, Math.max(0, timeoutMs));
			const set = waiting.get(laneId) ?? new Set();
			set.add(done);
			waiting.set(laneId, set);
		});

	return {
		wait,
		release,
		count: (laneId) =>
			laneId === undefined
				? [...waiting.values()].reduce((n, set) => n + set.size, 0)
				: waiting.get(laneId)?.size ?? 0,
	};
};
