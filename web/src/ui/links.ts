// Link targets for server-driven UI and kernel markdown.
//
// - A same-origin path (`/…`, never `//…` or `/\…`, no control characters)
//   becomes an in-app router link.
// - An `https://` URL never becomes a direct link: it routes to the "leaving
//   Tartan" interstitial (`/-/leaving?to=<url>`), which shows the full URL and
//   opens it with `rel="noopener noreferrer"`.
// - Everything else (`//evil`, `/\evil`, `javascript:`, `http:`, `data:` …) is
//   refused and renders as plain text with no `href`.

import type { RouteLocationRaw } from "vue-router";
import { SAME_ORIGIN_PATH_RE } from "./nodeTypes.ts";

export type LinkTarget =
	| { readonly kind: "internal"; readonly path: string }
	| { readonly kind: "external"; readonly url: string }
	| { readonly kind: "refused" };

// deno-lint-ignore no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** Parses an `https:` URL with a host; null for anything else. */
export const httpsUrl = (raw: unknown): string | null => {
	if (typeof raw !== "string" || !raw.startsWith("https://")) return null;
	if (CONTROL_RE.test(raw)) return null;
	try {
		const url = new URL(raw);
		return url.protocol === "https:" && url.hostname !== "" &&
				url.username === "" && url.password === ""
			? url.href
			: null;
	} catch {
		return null;
	}
};

export const classifyHref = (href: unknown): LinkTarget => {
	if (typeof href !== "string") return { kind: "refused" };
	if (SAME_ORIGIN_PATH_RE.test(href)) return { kind: "internal", path: href };
	const url = httpsUrl(href);
	return url === null ? { kind: "refused" } : { kind: "external", url };
};

/** A same-origin path or null (for `navigate` results, `return_to`, board cards). */
export const sameOriginPath = (value: unknown): string | null =>
	typeof value === "string" && SAME_ORIGIN_PATH_RE.test(value) ? value : null;

/** The interstitial route for an external URL. */
export const leavingRoute = (url: string): RouteLocationRaw => ({
	name: "leaving",
	query: { to: url },
});

/** Router location for a classified link, or null when it is refused. */
export const linkLocation = (target: LinkTarget): RouteLocationRaw | null => {
	switch (target.kind) {
		case "internal":
			return target.path;
		case "external":
			return leavingRoute(target.url);
		case "refused":
			return null;
	}
};
