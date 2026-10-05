// Security headers (WP2) on every response the router
// produces. A header the handler already set wins (raw files carry their own
// `Content-Security-Policy: sandbox`, the login callback its own
// `Referrer-Policy: no-referrer`). WebSocket upgrades (101) pass untouched.

export const SPA_CSP =
	"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export const HSTS = "max-age=31536000";

export type HeaderOptions = {
	/** `Cache-Control: no-store` unless the handler chose a cache policy (all but static assets). */
	readonly noStore: boolean;
	/** `Set-Cookie` lines the middleware adds (e.g. clearing a stale session). */
	readonly setCookies?: readonly string[];
};

export const withSecurityHeaders = (
	response: Response,
	options: HeaderOptions,
): Response => {
	if (response.status === 101 || response.webSocket) return response;
	const out = new Response(response.body, response);
	const h = out.headers;
	const setDefault = (name: string, value: string) => {
		if (!h.has(name)) h.set(name, value);
	};
	setDefault("x-content-type-options", "nosniff");
	setDefault("referrer-policy", "same-origin");
	setDefault("strict-transport-security", HSTS);
	if ((h.get("content-type") ?? "").toLowerCase().startsWith("text/html")) {
		setDefault("content-security-policy", SPA_CSP);
		setDefault("x-frame-options", "DENY");
	}
	if (options.noStore) setDefault("cache-control", "no-store");
	for (const cookie of options.setCookies ?? []) h.append("set-cookie", cookie);
	return out;
};
