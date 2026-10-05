// Line splitting and binary detection. A line keeps its terminator ("\n"),
// so the last line of a file without a trailing newline differs from the
// same text with one, as git sees it.

/** Bytes inspected for a NUL when deciding that content is binary (git: 8000). */
export const BINARY_SNIFF_BYTES = 8000;

/** Splits text into lines, each with its trailing "\n" (the last may lack it). */
export const splitLines = (text: string): string[] => {
	const lines: string[] = [];
	let start = 0;
	for (;;) {
		const end = text.indexOf("\n", start);
		if (end === -1) break;
		lines.push(text.slice(start, end + 1));
		start = end + 1;
	}
	if (start < text.length) lines.push(text.slice(start));
	return lines;
};

/** True when the first `BINARY_SNIFF_BYTES` bytes contain a NUL (git's rule). */
export const isBinary = (bytes: Uint8Array): boolean => {
	const limit = Math.min(bytes.length, BINARY_SNIFF_BYTES);
	for (let i = 0; i < limit; i++) if (bytes[i] === 0) return true;
	return false;
};

const decoder = new TextDecoder("utf-8", { fatal: false });

/** UTF-8 decode (invalid sequences become U+FFFD). */
export const decodeText = (bytes: Uint8Array): string => decoder.decode(bytes);

/** True when the line ends with "\n". */
export const hasEol = (line: string): boolean => line.endsWith("\n");

/**
 * Interns lines of several sequences into shared integer ids, so the diff
 * compares numbers instead of strings.
 */
export const internLines = (
	...sequences: readonly (readonly string[])[]
): Int32Array[] => {
	const ids = new Map<string, number>();
	return sequences.map((lines) => {
		const out = new Int32Array(lines.length);
		lines.forEach((line, i) => {
			let id = ids.get(line);
			if (id === undefined) {
				id = ids.size;
				ids.set(line, id);
			}
			out[i] = id;
		});
		return out;
	});
};
