// Output masking of the e2e launcher. Everything a child prints (the e2e
// list reporter, deploy, wrangler, git) passes through `createMasker` before
// it reaches the terminal, because stdout is what an agent driving the
// harness keeps in its transcript, and the leak scan only sees files.
// Masked: Tartan tokens, the forge's session, setup and login cookies,
// Bearer credentials, setup-URL fragments, IdP codes, and every exact value
// the launcher knows is secret (passwords, minted tokens, the setup token).

export const MASK = "<redacted>";

const PATTERNS: readonly { readonly re: RegExp; readonly keep: number }[] = [
	{ re: /t(?:pat|agt)_[A-Za-z0-9_-]{43}/g, keep: 0 },
	{ re: /(__Host-tartan-[a-z0-9-]+=)[^;\s"'\\]+/g, keep: 1 },
	{ re: /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, keep: 1 },
	{ re: /(\/-\/setup#t=)[^\s"'&]+/g, keep: 1 },
	{ re: /([?&]code=)[A-Za-z0-9_-]{16,}/g, keep: 1 },
	{
		re: /(registration_access_token"?\s*[:=]\s*"?)[A-Za-z0-9_-]{16,}/g,
		keep: 1,
	},
];

const escapeRegExp = (text: string): string =>
	text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A masker for the patterns above plus `secrets` (values under 6 chars are ignored). */
export const createMasker = (secrets: readonly string[] = []) => {
	const exact = [...new Set(secrets.filter((s) => s.length >= 6))]
		.sort((a, b) => b.length - a.length)
		.flatMap((s) => [s, encodeURIComponent(s)])
		.map((s) => new RegExp(escapeRegExp(s), "g"));
	return (text: string): string => {
		let out = text;
		for (const re of exact) out = out.replace(re, MASK);
		for (const { re, keep } of PATTERNS) {
			out = out.replace(re, (...m) => `${keep === 1 ? m[1] : ""}${MASK}`);
		}
		return out;
	};
};

export type Masker = ReturnType<typeof createMasker>;

/**
 * Copies `source` to `sink` line by line through `mask`. A partial line is
 * held until its newline (or the end), so a secret is never split across
 * two writes and escapes the patterns.
 */
export const pipeMasked = async (
	source: ReadableStream<Uint8Array>,
	sink: { write(p: Uint8Array): Promise<number> },
	mask: Masker,
): Promise<void> => {
	const encoder = new TextEncoder();
	let pending = "";
	const decoder = new TextDecoder();
	for await (const chunk of source) {
		pending += decoder.decode(chunk, { stream: true });
		const end = pending.lastIndexOf("\n");
		if (end === -1) continue;
		await sink.write(encoder.encode(mask(pending.slice(0, end + 1))));
		pending = pending.slice(end + 1);
	}
	pending += decoder.decode();
	if (pending !== "") await sink.write(encoder.encode(mask(pending)));
};
