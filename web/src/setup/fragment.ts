// Setup token hand-off.
//
// The deploy prints `https://<host>/-/setup#t=<token>`; the token rides in the
// URL fragment so it never reaches server logs. The SPA must read it and strip
// it from the address bar with `history.replaceState` BEFORE the router starts
// or anything renders, so it cannot leak through history, screenshots, or the
// Referer of a later navigation. The token stays in memory only (never in
// storage) and is POSTed to `/-/setup/unlock` by the wizard (WP18).

import type { InjectionKey } from "vue";

export const SETUP_TOKEN: InjectionKey<string | null> = Symbol("setup-token");

type FragmentLocation = Pick<Location, "hash" | "pathname" | "search">;
type FragmentHistory = Pick<History, "replaceState" | "state">;

/**
 * Returns the `t` value from the fragment (or `null`) and removes the whole
 * fragment from the current history entry whenever it carries `t`.
 */
export const takeSetupToken = (
	location: FragmentLocation,
	history: FragmentHistory,
): string | null => {
	if (location.hash.length < 2) return null;
	const params = new URLSearchParams(location.hash.slice(1));
	if (!params.has("t")) return null;
	history.replaceState(history.state, "", location.pathname + location.search);
	const token = params.get("t");
	return token !== null && token !== "" ? token : null;
};
