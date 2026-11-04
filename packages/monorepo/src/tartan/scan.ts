// A small CUE tokenizer for the textual project read (`./manifest.ts`). It is
// no parser: it removes comments, replaces every string literal by `""`
// (keeping the literal's text aside) and records the bracket nesting at the
// start of each line, so the reader is not fooled by a declaration inside a
// string, a comment or a multi-line string.
//
// Strings: `"…"`, `'…'`, `"""…"""`, `'''…'''`, and each with `#` delimiters
// (`#"…"#`, `##"""…"""##`); escapes `\x` (`\#x` in a `#` string) and
// interpolations `\(…)` (`\#(…)`), which may hold further strings.

/** One string literal as written. */
export type CueString = {
	/** The characters between the delimiters, escapes left as written (capped). */
	readonly raw: string;
	/** A one-line `"…"` with no escape, interpolation or `#` delimiter. */
	readonly simple: boolean;
};

export type CueLine = {
	/** 1-based line number. */
	readonly n: number;
	/** Brackets (`{`, `[`, `(`) open at the start of the line, outside strings and comments. */
	readonly depth: number;
	/** The line starts inside a multi-line string: never a declaration. */
	readonly continued: boolean;
	/** The line without comments, each string literal replaced by `""`. */
	readonly code: string;
	/** String literals that start on this line, in order. */
	readonly strings: readonly CueString[];
};

/** Characters of a literal kept in `CueString.raw` (names are ≤ 128). */
const RAW_KEEP = 512;
/** `#`s a string delimiter may have; a longer run is not a string (CUE sets no limit, nobody needs one). */
const MAX_HASHES = 16;

type StringFrame = {
	readonly kind: "string";
	readonly quote: '"' | "'";
	readonly multi: boolean;
	readonly hashes: number;
	/** The literal starts at the top level of the file (not in an interpolation). */
	readonly base: boolean;
	readonly into: CueString[];
	raw: string;
	simple: boolean;
};
type InterpFrame = { readonly kind: "interp"; parens: number };
type Frame = StringFrame | InterpFrame;

const OPENERS = new Set(["{", "[", "("]);
const CLOSERS = new Set(["}", "]", ")"]);

/** Splits CUE source into lines with comments and string contents removed. */
export const scanCue = (text: string): CueLine[] => {
	const src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
	const lines: CueLine[] = [];
	const frames: Frame[] = [];
	let open = 0;
	let n = 1;
	let code = "";
	let strings: CueString[] = [];
	let startDepth = 0;
	let continued = false;

	const endLine = (): void => {
		lines.push({
			n,
			depth: startDepth,
			continued,
			code,
			strings,
		});
		n++;
		code = "";
		strings = [];
		startDepth = open;
		continued = frames.some((f) => f.kind === "string");
	};

	/** At `i`: `#`* then a quote starts a string; returns its length or 0. */
	const stringStart = (i: number, base: boolean): number => {
		let j = i;
		while (src[j] === "#" && j - i <= MAX_HASHES) j++;
		const q = src[j];
		if (q !== '"' && q !== "'") return 0;
		const hashes = j - i;
		const multi = src.startsWith(q.repeat(3), j);
		frames.push({
			kind: "string",
			quote: q,
			multi,
			hashes,
			base,
			into: strings,
			raw: "",
			simple: hashes === 0 && !multi && q === '"',
		});
		if (base) code += '""';
		return hashes + (multi ? 3 : 1);
	};

	let i = 0;
	while (i < src.length) {
		const ch = src[i];
		const top = frames.at(-1);
		if (top !== undefined && top.kind === "string") {
			const delim = top.multi ? top.quote.repeat(3) : top.quote;
			if (
				src.startsWith(delim, i) &&
				src.slice(i + delim.length, i + delim.length + top.hashes) ===
					"#".repeat(top.hashes)
			) {
				frames.pop();
				if (top.base) top.into.push({ raw: top.raw, simple: top.simple });
				i += delim.length + top.hashes;
				continue;
			}
			if (
				ch === "\\" &&
				src.slice(i + 1, i + 1 + top.hashes) === "#".repeat(top.hashes)
			) {
				const after = src[i + 1 + top.hashes];
				top.simple = false;
				if (after === "(") {
					frames.push({ kind: "interp", parens: 1 });
					i += top.hashes + 2;
					continue;
				}
				if (top.raw.length < RAW_KEEP) top.raw += `\\${after ?? ""}`;
				if (after === "\n") endLine();
				i += top.hashes + 2;
				continue;
			}
			if (ch === "\n") {
				if (!top.multi) {
					// A one-line string cannot span lines: end it here (malformed input).
					frames.pop();
					if (top.base) top.into.push({ raw: top.raw, simple: false });
				} else if (top.raw.length < RAW_KEEP) top.raw += "\n";
				endLine();
				i++;
				continue;
			}
			if (top.raw.length < RAW_KEEP) top.raw += ch;
			i++;
			continue;
		}
		if (top !== undefined && top.kind === "interp") {
			if (ch === "\n") {
				endLine();
				i++;
				continue;
			}
			const started = stringStart(i, false);
			if (started > 0) {
				i += started;
				continue;
			}
			if (ch === "(") top.parens++;
			else if (ch === ")" && --top.parens === 0) frames.pop();
			i++;
			continue;
		}
		// Top-level code.
		if (ch === "\n") {
			endLine();
			i++;
			continue;
		}
		if (ch === "/" && src[i + 1] === "/") {
			const nl = src.indexOf("\n", i);
			i = nl === -1 ? src.length : nl;
			continue;
		}
		const started = stringStart(i, true);
		if (started > 0) {
			i += started;
			continue;
		}
		if (OPENERS.has(ch)) open++;
		else if (CLOSERS.has(ch) && open > 0) open--;
		code += ch;
		i++;
	}
	// An unterminated literal still counts as one (malformed input).
	for (const frame of frames) {
		if (frame.kind === "string" && frame.base) {
			frame.into.push({ raw: frame.raw, simple: false });
		}
	}
	endLine();
	return lines;
};
