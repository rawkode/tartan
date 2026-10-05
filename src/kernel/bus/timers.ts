// "Arm no later than" over the WP0 timers API (land's `outboxNoLaterThan`
// pattern). A module's timer row that is already due is the one `alarm()` is
// running (or about to run); the host deletes it after the handler unless its
// `at` changed, so re-arming it always moves `at` past the due value.

import type { ModuleTimersApi } from "@tartan/contract/kernel.ts";

export const armNoLaterThan = (
	timers: ModuleTimersApi,
	key: string,
	at: number,
	now: number,
): void => {
	const current = timers.get(key);
	if (current !== null && current > now && current <= at) return;
	const floor = current !== null && current <= now ? current + 1 : 0;
	timers.schedule(key, Math.max(Math.floor(at), floor));
};
