// Canonical host (WP2; WP4 consumes it for git routes). Once `canonical_origin`
// is set, a request on another host gets, by its route's `RoutePolicy.host`:
// `redirect` → 308 to the same path on the canonical origin (except
// setup-exempt routes while setup is incomplete, so the wizard can run on
// workers.dev before the custom domain answers); `forbid` → 403
// `denied("host")` (git, MCP, the capability route); `any` → served. Before the
// origin is set every host is served.

import type { RoutePolicy } from "@tartan/contract/kernel.ts";

export type HostDecision =
	| { readonly kind: "serve" }
	| { readonly kind: "redirect"; readonly location: string }
	| { readonly kind: "forbid" };

export const decideHost = (
	url: URL,
	policy: Pick<RoutePolicy, "host" | "setupExempt">,
	canonicalOrigin: string | null,
	setupDone: boolean,
): HostDecision => {
	if (canonicalOrigin === null || url.origin === canonicalOrigin) {
		return { kind: "serve" };
	}
	switch (policy.host) {
		case "any":
			return { kind: "serve" };
		case "forbid":
			return { kind: "forbid" };
		case "redirect":
			return !setupDone && policy.setupExempt ? { kind: "serve" } : {
				kind: "redirect",
				location: `${canonicalOrigin}${url.pathname}${url.search}`,
			};
	}
};
