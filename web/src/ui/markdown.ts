// Safe markdown for `tartan-ui@1` `markdown` nodes.
//
// The contract carries the markdown source (`{t:"markdown", md}`), so the SPA
// renders it, and it does so without `v-html`: this module parses a small
// CommonMark subset into a tree of plain data, and `UiMarkdown.ts` turns that
// tree into Vue VNodes whose text is always escaped by Vue. Raw HTML in the
// source is shown as text; images render as their alt text (CSP `img-src`
// would block remote images anyway); links go through `links.ts`.
//
// Supported: ATX headings, paragraphs, fenced code, block quotes (nested up to
// 4), bullet and ordered lists (one level), thematic breaks, inline code,
// strong, emphasis, strikethrough, links, hard line breaks.

export type Inline =
	| { readonly t: "text"; readonly v: string }
	| { readonly t: "code"; readonly v: string }
	| { readonly t: "strong"; readonly c: readonly Inline[] }
	| { readonly t: "em"; readonly c: readonly Inline[] }
	| { readonly t: "del"; readonly c: readonly Inline[] }
	| { readonly t: "link"; readonly href: string; readonly c: readonly Inline[] }
	| { readonly t: "br" };

export type Block =
	| { readonly t: "p"; readonly c: readonly Inline[] }
	| {
		readonly t: "h";
		readonly level: 1 | 2 | 3 | 4 | 5 | 6;
		readonly c: readonly Inline[];
	}
	| { readonly t: "code"; readonly lang: string; readonly v: string }
	| { readonly t: "quote"; readonly c: readonly Block[] }
	| { readonly t: "ul"; readonly items: readonly (readonly Inline[])[] }
	| {
		readonly t: "ol";
		readonly start: number;
		readonly items: readonly (readonly Inline[])[];
	}
	| { readonly t: "hr" };

/** Same cap as the contract's `md` field. */
export const MARKDOWN_MAX = 20_000;
const MAX_QUOTE_DEPTH = 4;
const MAX_INLINE_DEPTH = 8;

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE_RE = /^ {0,3}> ?(.*)$/;
const UL_RE = /^ {0,3}[-*+][ \t]+(.*)$/;
const OL_RE = /^ {0,3}(\d{1,9})[.)][ \t]+(.*)$/;
const BLANK_RE = /^\s*$/;

const isBlockStart = (line: string): boolean =>
	FENCE_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line) ||
	QUOTE_RE.test(line) || UL_RE.test(line) || OL_RE.test(line);

// ---------------------------------------------------------------------------
// Inlines
// ---------------------------------------------------------------------------

const pushText = (out: Inline[], v: string): void => {
	if (v === "") return;
	const last = out[out.length - 1];
	if (last && last.t === "text") {
		out[out.length - 1] = { t: "text", v: last.v + v };
	} else out.push({ t: "text", v });
};

/** Finds the `]` that closes a `[` at `open`, honouring nesting and escapes. */
const closingBracket = (src: string, open: number): number => {
	let depth = 0;
	for (let i = open; i < src.length; i += 1) {
		const ch = src[i];
		if (ch === "\\") i += 1;
		else if (ch === "[") depth += 1;
		else if (ch === "]") {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	return -1;
};

const DELIMS = [
	{ mark: "**", t: "strong" },
	{ mark: "__", t: "strong" },
	{ mark: "~~", t: "del" },
	{ mark: "*", t: "em" },
	{ mark: "_", t: "em" },
] as const;

export const parseInline = (src: string, depth = 0): Inline[] => {
	const out: Inline[] = [];
	if (depth > MAX_INLINE_DEPTH) {
		pushText(out, src);
		return out;
	}
	let i = 0;
	while (i < src.length) {
		const ch = src[i] ?? "";
		// Backslash escape of ASCII punctuation.
		if (ch === "\\" && i + 1 < src.length) {
			const next = src[i + 1] ?? "";
			if (/[!-/:-@[-`{-~]/.test(next)) {
				pushText(out, next);
				i += 2;
				continue;
			}
		}
		// Hard line break: two trailing spaces or a backslash before a newline.
		if (ch === "\n") {
			const before = src.slice(0, i);
			if (/ {2,}$/.test(before) || before.endsWith("\\")) {
				const last = out[out.length - 1];
				if (last && last.t === "text") {
					out[out.length - 1] = {
						t: "text",
						v: last.v.replace(/(?: {2,}|\\)$/, ""),
					};
				}
				out.push({ t: "br" });
			} else pushText(out, " ");
			i += 1;
			continue;
		}
		// Code span.
		if (ch === "`") {
			const run = /^`+/.exec(src.slice(i))?.[0] ?? "`";
			const end = src.indexOf(run, i + run.length);
			if (end !== -1) {
				const body = src.slice(i + run.length, end).replace(/\n/g, " ");
				out.push({
					t: "code",
					v: body.length > 2 && body.startsWith(" ") && body.endsWith(" ")
						? body.slice(1, -1)
						: body,
				});
				i = end + run.length;
				continue;
			}
			pushText(out, run);
			i += run.length;
			continue;
		}
		// Image: alt text only.
		if (ch === "!" && src[i + 1] === "[") {
			const close = closingBracket(src, i + 1);
			const paren = close === -1 ? -1 : src.indexOf(")", close);
			if (close !== -1 && src[close + 1] === "(" && paren !== -1) {
				pushText(out, src.slice(i + 2, close));
				i = paren + 1;
				continue;
			}
		}
		// Link.
		if (ch === "[") {
			const close = closingBracket(src, i);
			if (close !== -1 && src[close + 1] === "(") {
				const paren = src.indexOf(")", close + 2);
				if (paren !== -1) {
					const target = src.slice(close + 2, paren).trim();
					const href = (target.split(/\s+/)[0] ?? "").replace(/^<|>$/g, "");
					out.push({
						t: "link",
						href,
						c: parseInline(src.slice(i + 1, close), depth + 1),
					});
					i = paren + 1;
					continue;
				}
			}
		}
		// Emphasis, strong, strikethrough.
		const delim = DELIMS.find((d) => src.startsWith(d.mark, i));
		if (delim) {
			const start = i + delim.mark.length;
			const end = src.indexOf(delim.mark, start);
			const inner = end === -1 ? "" : src.slice(start, end);
			const intraword = delim.mark.startsWith("_") &&
				/\w/.test(src[i - 1] ?? "");
			if (
				end !== -1 && inner.trim() !== "" && !/^\s/.test(inner) &&
				!/\s$/.test(inner) && !intraword
			) {
				out.push({ t: delim.t, c: parseInline(inner, depth + 1) });
				i = end + delim.mark.length;
				continue;
			}
			pushText(out, delim.mark);
			i += delim.mark.length;
			continue;
		}
		pushText(out, ch);
		i += 1;
	}
	return out;
};

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

const parseLines = (lines: readonly string[], quoteDepth: number): Block[] => {
	const blocks: Block[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		if (BLANK_RE.test(line)) {
			i += 1;
			continue;
		}
		const fence = FENCE_RE.exec(line);
		if (fence) {
			const mark = fence[1] ?? "```";
			const body: string[] = [];
			i += 1;
			while (i < lines.length && !(lines[i] ?? "").trim().startsWith(mark)) {
				body.push(lines[i] ?? "");
				i += 1;
			}
			i += 1; // closing fence (or end of input)
			blocks.push({ t: "code", lang: fence[2] ?? "", v: body.join("\n") });
			continue;
		}
		const heading = HEADING_RE.exec(line);
		if (heading) {
			blocks.push({
				t: "h",
				level: (heading[1] ?? "#").length as 1 | 2 | 3 | 4 | 5 | 6,
				c: parseInline((heading[2] ?? "").trim()),
			});
			i += 1;
			continue;
		}
		if (HR_RE.test(line)) {
			blocks.push({ t: "hr" });
			i += 1;
			continue;
		}
		if (QUOTE_RE.test(line)) {
			const body: string[] = [];
			while (i < lines.length && QUOTE_RE.test(lines[i] ?? "")) {
				body.push(QUOTE_RE.exec(lines[i] ?? "")?.[1] ?? "");
				i += 1;
			}
			blocks.push(
				quoteDepth >= MAX_QUOTE_DEPTH
					? { t: "p", c: parseInline(body.join("\n")) }
					: { t: "quote", c: parseLines(body, quoteDepth + 1) },
			);
			continue;
		}
		const ordered = OL_RE.exec(line);
		if (ordered || UL_RE.test(line)) {
			const re = ordered ? OL_RE : UL_RE;
			const items: string[][] = [];
			while (i < lines.length) {
				const current = lines[i] ?? "";
				const m = re.exec(current);
				if (m) {
					items.push([(ordered ? m[2] : m[1]) ?? ""]);
				} else if (
					!BLANK_RE.test(current) && /^\s+\S/.test(current) &&
					items.length > 0
				) {
					items[items.length - 1]?.push(current.trim());
				} else break;
				i += 1;
			}
			const parsed = items.map((item) => parseInline(item.join("\n")));
			blocks.push(
				ordered
					? {
						t: "ol",
						start: Math.min(Number(ordered[1] ?? "1"), 1_000_000),
						items: parsed,
					}
					: { t: "ul", items: parsed },
			);
			continue;
		}
		const para: string[] = [];
		while (
			i < lines.length && !BLANK_RE.test(lines[i] ?? "") &&
			(para.length === 0 || !isBlockStart(lines[i] ?? ""))
		) {
			para.push(lines[i] ?? "");
			i += 1;
		}
		blocks.push({ t: "p", c: parseInline(para.join("\n").trim()) });
	}
	return blocks;
};

export const parseMarkdown = (md: string): Block[] =>
	parseLines(
		md.slice(0, MARKDOWN_MAX).replace(/\r\n?/g, "\n").split("\n"),
		0,
	);
