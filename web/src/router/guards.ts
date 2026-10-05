// First-run guard: while the forge is not set up,
// every page except the wizard (and the "leaving" interstitial) goes to
// `/-/setup`. The kernel already 302s HTML routes server-side; this covers
// client-side navigation. Once `done` is seen it is cached. An unreachable
// or slow health endpoint never blocks navigation: the check is bounded
// (`SETUP_GUARD_TIMEOUT_MS`) and the page goes on without it, so a `/-/health`
// that never answers cannot leave a blank page.

import type { NavigationGuard } from "vue-router";

type SetupState = "fresh" | "unlocked" | "idp" | "done";

const OPEN_ROUTES: ReadonlySet<string> = new Set(["setup", "leaving"]);

/** How long a navigation waits for the setup state before it goes on. */
export const SETUP_GUARD_TIMEOUT_MS = 3000;

export const createSetupGuard = (
	setupState: () => Promise<SetupState>,
	options: { readonly timeoutMs?: number } = {},
): NavigationGuard => {
	const timeoutMs = options.timeoutMs ?? SETUP_GUARD_TIMEOUT_MS;
	let done = false;
	return async (to) => {
		if (done || OPEN_ROUTES.has(String(to.name))) return true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const late = new Promise<"late">((resolve) => {
			timer = setTimeout(() => resolve("late"), timeoutMs);
		});
		try {
			const state = await Promise.race([setupState(), late]);
			if (state === "late") return true;
			if (state === "done") {
				done = true;
				return true;
			}
			return { name: "setup" };
		} catch {
			return true;
		} finally {
			clearTimeout(timer);
		}
	};
};
