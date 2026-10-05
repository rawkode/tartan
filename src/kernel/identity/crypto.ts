// Small WebCrypto helpers shared by the identity module (ForgeDO) and the
// Worker-side HTTP code (WP2).
// Pure: no bindings, no `cloudflare:*` imports, so Deno unit tests run them
// as-is. Everything secret is compared as a SHA-256 digest in constant time.

const encoder = new TextEncoder();

/** Bytes backed by a plain `ArrayBuffer` (what WebCrypto's `BufferSource` takes). */
export type Bytes = Uint8Array<ArrayBuffer>;

export const utf8 = (text: string): Bytes => encoder.encode(text);

/** RFC 4648 §5 base64url without padding. */
export const toBase64Url = (bytes: Uint8Array): string => {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
		/=+$/,
		"",
	);
};

/** Decodes base64url (padding optional); throws on any other character. */
export const fromBase64Url = (text: string): Bytes => {
	if (!/^[A-Za-z0-9_-]*={0,2}$/.test(text)) {
		throw new TypeError("not base64url");
	}
	const base64 = text.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
	const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
	const binary = atob(padded);
	return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
};

export const toHex = (bytes: Uint8Array): string =>
	Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export const fromHex = (hex: string): Bytes => {
	if (!/^(?:[0-9a-f]{2})*$/.test(hex)) throw new TypeError("not lowercase hex");
	return Uint8Array.from(
		{ length: hex.length / 2 },
		(_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16),
	);
};

export const randomBytes = (length: number): Bytes =>
	crypto.getRandomValues(new Uint8Array(length));

/** 256 random bits as 43 base64url chars (tokens, cookies, invite codes). */
export const randomSecret = (): string => toBase64Url(randomBytes(32));

/** 128 random bits as 32 lowercase hex chars. */
export const randomHex128 = (): string => toHex(randomBytes(16));

/** SHA-256 digest bytes of a string (UTF-8) or bytes. */
export const sha256 = async (data: string | Bytes): Promise<Bytes> =>
	new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			typeof data === "string" ? utf8(data) : data,
		),
	);

/** Lowercase hex SHA-256: how sessions, tokens, codes and invites are stored. */
export const sha256Hex = async (data: string | Bytes): Promise<string> =>
	toHex(await sha256(data));

type TimingSafeSubtle = SubtleCrypto & {
	timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean;
};

/**
 * Constant-time equality of two byte strings. workerd's
 * `crypto.subtle.timingSafeEqual` when present;
 * elsewhere (Deno tests) a branch-free XOR fold. Different lengths are
 * unequal without comparing contents.
 */
export const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
	if (a.length !== b.length) return false;
	const native = (crypto.subtle as TimingSafeSubtle).timingSafeEqual;
	if (typeof native === "function") return native.call(crypto.subtle, a, b);
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
};

/**
 * Compares two secrets by their SHA-256 digests in constant time, so neither
 * the length nor a prefix of the expected value leaks through timing.
 */
export const secretsEqual = async (
	given: string,
	expected: string,
): Promise<boolean> =>
	constantTimeEqual(await sha256(given), await sha256(expected));

/**
 * The rate-limit key of a client address: the first 16 hex chars of its
 * SHA-256. Raw addresses are never stored.
 */
export const ipHash = async (ip: string): Promise<string> =>
	(await sha256Hex(ip)).slice(0, 16);
