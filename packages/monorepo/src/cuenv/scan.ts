// A small CUE tokenizer for the Tier 0 scan (WP25 slice A′; written for
// Tartan, no cuenv code or text is copied). It is no parser: it removes comments, replaces every string
// literal by `""` (keeping the literal's text aside) and records the bracket
// nesting at the start of each line, so the classifier can ask "is there a
// top-level `#Project` reference" and "is there a literal `name`" without
// being fooled by a `#Project` inside a string, a comment, a multi-line
// string or a hidden field.
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

export type CueBracket = { readonly id: number; readonly ch: "{" | "[" | "(" };

export type CueLine = {
	/** 1-based line number. */
	readonly n: number;
	/** Brackets (`{`, `[`, `(`) open at the start of the line, outside strings and comments. */
	readonly depth: number;
	/** The innermost bracket open at the start of the line (0 = top level). */
	readonly block: number;
	/** The line starts inside a multi-line string: never a declaration. */
	readonly continued: boolean;
	/** The line without comments, each string literal replaced by `""`. */
	readonly code: string;
	/** String literals that start on this line, in order. */
	readonly strings: readonly CueString[];
	/** Brackets opened on this line and still open at its end, outermost first. */
	readonly opened: readonly CueBracket[];
};

/** Characters of a literal kept in `CueString.raw` (names are ≤ 128). */
const RAW_KEEP = 512;

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
	const open: CueBracket[] = [];
	const frames: Frame[] = [];
	let nextId = 1;
	let n = 1;
	let code = "";
	let strings: CueString[] = [];
	let pushed: CueBracket[] = [];
	let startDepth = 0;
	let startBlock = 0;
	let continued = false;

	const endLine = (): void => {
		lines.push({
			n,
			depth: startDepth,
			block: startBlock,
			continued,
			code,
			strings,
			opened: pushed.filter((b) => open.includes(b)),
		});
		n++;
		code = "";
		strings = [];
		pushed = [];
		startDepth = open.length;
		startBlock = open.at(-1)?.id ?? 0;
		continued = frames.some((f) => f.kind === "string");
	};

	/** At `i`: `#`* then a quote starts a string; returns its length or 0. */
	const stringStart = (i: number, base: boolean): number => {
		let j = i;
		while (src[j] === "#") j++;
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
		if (OPENERS.has(ch)) {
			const bracket: CueBracket = {
				id: nextId++,
				ch: ch as CueBracket["ch"],
			};
			open.push(bracket);
			pushed.push(bracket);
		} else if (CLOSERS.has(ch)) {
			open.pop();
		}
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

// ---------------------------------------------------------------------------
// env.cue classification (cuenv's discovery rules, re-implemented)
// ---------------------------------------------------------------------------

const QUALIFIED = String.raw`(?:[A-Za-z_$][\w$]*\.)?`;
/** A top-level embedding of `#Project` (`schema.#Project`, `schema.#Project & {`). */
const PROJECT_RE = new RegExp(String.raw`^\s*${QUALIFIED}#Project\b`);
const PROJECT_BLOCK_RE = new RegExp(
	String.raw`^\s*${QUALIFIED}#Project\s*&\s*\{`,
);
const BASE_RE = new RegExp(String.raw`^\s*${QUALIFIED}#Base\b`);
/** `name: "<one simple literal>"` (the literal is replaced by `""` in `code`). */
const NAME_LINE_RE = /^\s*name\s*:\s*""\s*,?\s*$/;
/** The characters a literal name may hold (`FootprintSchema`-safe). */
export const NAME_CHARS_RE = /^[A-Za-z0-9._-]+$/;

export type EnvCueKind = "project" | "base" | "unknown";

export type EnvCueFacts = {
	readonly kind: EnvCueKind;
	/** Line of the `#Project` / `#Base` embedding. */
	readonly kindLine?: number;
	/** The first literal `name` at the top level or in the `#Project & {…}` block (any length). */
	readonly name?: string;
	readonly nameLine?: number;
};

/**
 * cuenv's textual classification of one `env.cue` (already known to be
 * `package cuenv`): a top-level `#Project` reference makes a project, a
 * `#Base` reference alone a layer, neither is unknown. The name is the
 * first `name: "<literal>"` at brace depth 0, or at depth 1 directly inside
 * the block a top-level `#Project & {` opens.
 */
export const classifyEnvCue = (text: string): EnvCueFacts => {
	const lines = scanCue(text);
	const top = lines.filter((l) => l.depth === 0 && !l.continued);
	const projectLine = top.find((l) => PROJECT_RE.test(l.code));
	const baseLine = top.find((l) => BASE_RE.test(l.code));
	const projectBlocks = new Set(
		top.filter((l) => PROJECT_BLOCK_RE.test(l.code)).flatMap((l) => {
			const brace = l.opened.find((b) => b.ch === "{");
			return brace ? [brace.id] : [];
		}),
	);
	const nameLine = lines.find((l) =>
		!l.continued &&
		(l.depth === 0 || (l.depth === 1 && projectBlocks.has(l.block))) &&
		NAME_LINE_RE.test(l.code) && l.strings.length === 1 &&
		l.strings[0].simple && NAME_CHARS_RE.test(l.strings[0].raw)
	);
	const kind: EnvCueKind = projectLine
		? "project"
		: baseLine
		? "base"
		: "unknown";
	const kindAt = projectLine ?? baseLine;
	return {
		kind,
		...(kindAt ? { kindLine: kindAt.n } : {}),
		...(nameLine
			? { name: nameLine.strings[0].raw, nameLine: nameLine.n }
			: {}),
	};
};
