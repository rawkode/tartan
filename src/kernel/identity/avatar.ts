// `GET /-/avatar/<principal>` (WP2): avatars come
// from the forge itself, so the SPA's `img-src 'self' data:` never has to
// allow remote images. The kernel draws an initials badge; it never fetches
// an IdP `picture` URL (no outbound request, nothing to proxy).

const escapeXml = (text: string): string =>
	text.replace(
		/[&<>"']/g,
		(ch) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&apos;",
			})[
				ch
			] as string,
	);

/** Up to two letters or digits from a display name or handle. */
export const initialsOf = (name: string): string => {
	const words = name.trim().split(/[\s._-]+/).filter((w) =>
		/[\p{L}\p{N}]/u.test(w)
	);
	const letters = words.length >= 2
		? [words[0], words[words.length - 1]].map((w) => [...w][0])
		: [...(words[0] ?? "?")].slice(0, 2);
	return letters.join("").toUpperCase();
};

/** A stable hue per principal id. */
export const hueOf = (id: string): number => {
	let h = 0;
	for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
	return h;
};

export const avatarSvg = (id: string, name: string): string =>
	`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" role="img" aria-label="${
		escapeXml(name)
	}"><rect width="64" height="64" rx="12" fill="hsl(${
		hueOf(id)
	} 45% 42%)"/><text x="32" y="41" font-family="system-ui, sans-serif" font-size="26" font-weight="600" text-anchor="middle" fill="#fff">${
		escapeXml(initialsOf(name))
	}</text></svg>`;

/** Headers of an avatar: no script can run in it, even when opened directly. */
export const AVATAR_HEADERS = {
	"content-type": "image/svg+xml; charset=utf-8",
	"content-security-policy":
		"default-src 'none'; style-src 'unsafe-inline'; sandbox",
	"cache-control": "private, max-age=3600",
} as const;
