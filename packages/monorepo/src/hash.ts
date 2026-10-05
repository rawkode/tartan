// Canonical JSON and SHA-256 (WebCrypto, available in Workers and Deno).

/** JSON with object keys sorted at every level (arrays keep their order). */
export const canonicalJson = (value: unknown): string =>
	JSON.stringify(
		value,
		(_key, v) =>
			v !== null && typeof v === "object" && !Array.isArray(v)
				? Object.fromEntries(
					Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
						a < b ? -1 : a > b ? 1 : 0
					),
				)
				: v,
	);

const hex = (bytes: ArrayBuffer): string =>
	Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0"))
		.join("");

export const sha256Hex = async (text: string): Promise<string> =>
	hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
