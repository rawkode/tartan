// Cookies (WP2): every Tartan cookie is a
// `__Host-` cookie (`Secure; Path=/`, no `Domain`), `HttpOnly` and
// `SameSite=Lax`. Values are opaque 256-bit secrets; the server stores only
// their SHA-256.

/** Cookie name → value of a `Cookie` header (the first occurrence wins). */
export const parseCookies = (header: string | null): Map<string, string> => {
	const out = new Map<string, string>();
	if (header === null) return out;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq <= 0) continue;
		const name = part.slice(0, eq).trim();
		const value = part.slice(eq + 1).trim().replace(/^"(.*)"$/, "$1");
		if (name !== "" && !out.has(name)) out.set(name, value);
	}
	return out;
};

export const cookieOf = (req: Request, name: string): string | null =>
	parseCookies(req.headers.get("cookie")).get(name) ?? null;

/** `Set-Cookie` for a `__Host-` cookie that lives `maxAgeS` seconds. */
export const hostCookie = (
	name: string,
	value: string,
	maxAgeS: number,
): string => {
	if (!name.startsWith("__Host-")) {
		throw new TypeError(`not a __Host- cookie: ${name}`);
	}
	if (!/^[A-Za-z0-9_-]*$/.test(value)) {
		throw new TypeError("cookie values are base64url");
	}
	return `${name}=${value}; Max-Age=${
		Math.max(0, Math.floor(maxAgeS))
	}; Path=/; Secure; HttpOnly; SameSite=Lax`;
};

/** `Set-Cookie` that deletes a `__Host-` cookie. */
export const clearCookie = (name: string): string => hostCookie(name, "", 0);
