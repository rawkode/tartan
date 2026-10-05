// Byte helpers of the e2e mock IdP: base64url, SHA-256, constant-time
// comparison and random tokens. WebCrypto only, so the same module runs in
// workerd (the IdP Worker) and in Deno (the e2e launcher and the unit tests).

const encoder = new TextEncoder();

export const utf8 = (text: string): Uint8Array<ArrayBuffer> =>
	encoder.encode(text);

export const b64url = (bytes: Uint8Array): string => {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
		/=+$/,
		"",
	);
};

export const fromB64url = (text: string): Uint8Array<ArrayBuffer> => {
	if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("not base64url");
	const padded = text.replace(/-/g, "+").replace(/_/g, "/") +
		"=".repeat((4 - (text.length % 4)) % 4);
	const binary = atob(padded);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
};

export const hex = (bytes: Uint8Array): string =>
	Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export const sha256 = async (
	input: string | Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> =>
	new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			typeof input === "string" ? utf8(input) : input,
		),
	);

export const sha256Hex = async (
	input: string | Uint8Array<ArrayBuffer>,
): Promise<string> => hex(await sha256(input));

/** Equal length and equal bytes, without an early exit on the first difference. */
export const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
};

export type Random = (n: number) => Uint8Array;

export const cryptoRandom: Random = (n) =>
	crypto.getRandomValues(new Uint8Array(n));

/** `bytes` random bytes as base64url (32 bytes give 43 characters). */
export const randomToken = (random: Random, bytes = 32): string =>
	b64url(random(bytes));
