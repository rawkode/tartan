// The "paste your issuer URL" field. The kernel
// matches the issuer EXACTLY against the discovery document, so the wizard
// sends what the owner typed (trimmed) and never rewrites it; it only refuses
// what cannot be an issuer and warns about the usual trailing-slash mistake.

export type IssuerCheck =
	| { readonly ok: true; readonly issuer: string; readonly warning?: string }
	| { readonly ok: false; readonly error: string };

export const checkIssuer = (raw: string): IssuerCheck => {
	const value = raw.trim();
	if (value === "") {
		return { ok: false, error: "Paste your identity provider's issuer URL." };
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return { ok: false, error: "That is not a URL." };
	}
	if (url.protocol !== "https:") {
		return { ok: false, error: "The issuer must be an https:// URL." };
	}
	if (url.username !== "" || url.password !== "") {
		return {
			ok: false,
			error: "The issuer URL must not contain a user name or password.",
		};
	}
	if (url.search !== "" || url.hash !== "") {
		return {
			ok: false,
			error: "The issuer URL has no query string or fragment.",
		};
	}
	if (value.endsWith("/.well-known/openid-configuration")) {
		return {
			ok: false,
			error:
				"Paste the issuer itself, without /.well-known/openid-configuration.",
		};
	}
	return value.endsWith("/")
		? {
			ok: true,
			issuer: value,
			warning:
				"Issuers are matched exactly. Most have no trailing slash; check the `issuer` in your provider's discovery document.",
		}
		: { ok: true, issuer: value };
};

/** The redirect URI Tartan registers (shown for manual client setup). */
export const redirectUri = (canonicalOrigin: string): string =>
	`${canonicalOrigin.replace(/\/+$/, "")}/-/auth/callback`;

/** The JWKS URL for `private_key_jwt` clients. */
export const jwksUri = (canonicalOrigin: string): string =>
	`${canonicalOrigin.replace(/\/+$/, "")}/-/auth/jwks.json`;
