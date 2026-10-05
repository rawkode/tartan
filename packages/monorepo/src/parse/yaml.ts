// A YAML subset, enough for `pnpm-workspace.yaml` and other manifests: block mappings and sequences by indentation, flow
// collections (`[a, b]`, `{ root: x, deps: [y] }`, also across lines),
// plain/single/double-quoted scalars, `#` comments and `|`/`>` block
// scalars. Anchors, tags and multiple documents are not supported (an
// anchor or tag reads as part of a plain scalar). Throws `YamlError` on
// malformed input; callers treat that as "no config".

export type YamlValue =
	| null
	| boolean
	| number
	| string
	| YamlValue[]
	| { [key: string]: YamlValue };

export class YamlError extends Error {
	constructor(message: string, readonly line: number) {
		super(`yaml: ${message} (line ${line})`);
		this.name = "YamlError";
	}
}

type Line = {
	readonly indent: number;
	readonly text: string;
	readonly no: number;
};

/** Strips a trailing comment (a `#` at the start or after whitespace, outside quotes). */
const stripComment = (text: string): string => {
	let quote: string | null = null;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === quote) {
				if (quote === "'" && text[i + 1] === "'") i++;
				else quote = null;
			} else if (ch === "\\" && quote === '"') i++;
		} else if (ch === '"' || ch === "'") {
			if (i === 0 || /[\s[{,:-]/.test(text[i - 1])) quote = ch;
		} else if (ch === "#" && (i === 0 || /\s/.test(text[i - 1]))) {
			return text.slice(0, i);
		}
	}
	return text;
};

const toLines = (source: string): Line[] =>
	source.split(/\r?\n/).flatMap((raw, i) => {
		if (/^\s*(---|\.\.\.)\s*$/.test(raw)) return [];
		const tabbed = /^\t/.test(raw);
		if (tabbed) throw new YamlError("tab indentation", i + 1);
		const text = stripComment(raw).trimEnd();
		if (text.trim() === "") return [];
		const indent = text.length - text.trimStart().length;
		return [{ indent, text: text.trimStart(), no: i + 1 }];
	});

const NUMBER = /^[-+]?(\d[\d_]*)(\.\d+)?([eE][-+]?\d+)?$/;

const plainScalar = (text: string): YamlValue => {
	const t = text.trim();
	if (t === "" || t === "~" || t === "null" || t === "Null" || t === "NULL") {
		return null;
	}
	if (/^(true|True|TRUE)$/.test(t)) return true;
	if (/^(false|False|FALSE)$/.test(t)) return false;
	if (NUMBER.test(t)) return Number(t.replaceAll("_", ""));
	return t;
};

const ESCAPES: Record<string, string> = {
	n: "\n",
	t: "\t",
	r: "\r",
	"0": "\0",
	'"': '"',
	"\\": "\\",
	"/": "/",
};

/** A tiny cursor parser for one flow value or quoted scalar. */
const parseInline = (text: string, no: number): YamlValue => {
	let i = 0;
	const fail = (message: string): never => {
		throw new YamlError(message, no);
	};
	const ws = () => {
		while (i < text.length && /\s/.test(text[i])) i++;
	};
	const quoted = (): string => {
		const q = text[i++];
		let out = "";
		while (i < text.length) {
			const ch = text[i];
			if (ch === q) {
				if (q === "'" && text[i + 1] === "'") {
					out += "'";
					i += 2;
					continue;
				}
				i++;
				return out;
			}
			if (q === '"' && ch === "\\") {
				const e = text[i + 1];
				if (e === "u") {
					out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
					i += 6;
				} else {
					out += ESCAPES[e] ?? e;
					i += 2;
				}
				continue;
			}
			out += ch;
			i++;
		}
		return fail("unterminated string");
	};
	const plain = (stops: RegExp): YamlValue => {
		const start = i;
		while (i < text.length && !stops.test(text[i])) {
			if (text[i] === ":" && /[\s,\]}]/.test(text[i + 1] ?? " ")) break;
			i++;
		}
		return plainScalar(text.slice(start, i));
	};
	const value = (inFlow: boolean): YamlValue => {
		ws();
		const ch = text[i];
		if (ch === "[") {
			i++;
			const items: YamlValue[] = [];
			for (;;) {
				ws();
				if (text[i] === "]") {
					i++;
					return items;
				}
				items.push(value(true));
				ws();
				if (text[i] === ",") i++;
				else if (text[i] !== "]") fail("expected , or ]");
			}
		}
		if (ch === "{") {
			i++;
			const map: { [key: string]: YamlValue } = {};
			for (;;) {
				ws();
				if (text[i] === "}") {
					i++;
					return map;
				}
				const key = text[i] === '"' || text[i] === "'"
					? quoted()
					: String(plain(/[:,}]/) ?? "");
				ws();
				let v: YamlValue = null;
				if (text[i] === ":") {
					i++;
					v = value(true);
				}
				map[key] = v;
				ws();
				if (text[i] === ",") i++;
				else if (text[i] !== "}") fail("expected , or }");
			}
		}
		if (ch === '"' || ch === "'") return quoted();
		return plain(inFlow ? /[,\]}]/ : /$^/);
	};
	const result = value(false);
	ws();
	if (i < text.length) fail(`unexpected ${JSON.stringify(text.slice(i))}`);
	return result;
};

const flowDepth = (text: string): number => {
	let depth = 0;
	let quote: string | null = null;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === quote) quote = null;
			else if (ch === "\\" && quote === '"') i++;
		} else if (ch === '"' || ch === "'") quote = ch;
		else if (ch === "[" || ch === "{") depth++;
		else if (ch === "]" || ch === "}") depth--;
	}
	return depth;
};

/** `key: rest` split at the first `: ` (or trailing `:`) outside quotes. */
const splitKey = (text: string): [string, string] | null => {
	let quote: string | null = null;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === quote) quote = null;
			continue;
		}
		if ((ch === '"' || ch === "'") && i === 0) quote = ch;
		else if (ch === "[" || ch === "{") return null;
		else if (ch === ":" && (i + 1 === text.length || text[i + 1] === " ")) {
			const raw = text.slice(0, i).trim();
			const key = raw.startsWith('"') || raw.startsWith("'")
				? String(parseInline(raw, 0))
				: raw;
			return [key, text.slice(i + 1).trim()];
		}
	}
	return null;
};

type Cursor = { pos: number };

/** A value written after `key:` or `- ` on the same line (plus continuation lines). */
const inlineValue = (
	lines: readonly Line[],
	cur: Cursor,
	first: string,
	no: number,
	parentIndent: number,
): YamlValue => {
	if (first === "|" || first === ">" || /^[|>][-+]?$/.test(first)) {
		const body: string[] = [];
		let indent = -1;
		while (cur.pos < lines.length && lines[cur.pos].indent > parentIndent) {
			const line = lines[cur.pos++];
			if (indent < 0) indent = line.indent;
			body.push(" ".repeat(Math.max(0, line.indent - indent)) + line.text);
		}
		const joined = first.startsWith("|") ? body.join("\n") : body.join(" ");
		return first.endsWith("-") ? joined : `${joined}\n`;
	}
	let text = first;
	while (flowDepth(text) > 0 && cur.pos < lines.length) {
		text += ` ${lines[cur.pos++].text}`;
	}
	return parseInline(text, no);
};

const parseBlock = (
	lines: readonly Line[],
	cur: Cursor,
	indent: number,
): YamlValue => {
	const first = lines[cur.pos];
	if (first.text === "-" || first.text.startsWith("- ")) {
		const items: YamlValue[] = [];
		while (cur.pos < lines.length && lines[cur.pos].indent === indent) {
			const line = lines[cur.pos];
			if (!(line.text === "-" || line.text.startsWith("- "))) break;
			cur.pos++;
			const rest = line.text.slice(1).trimStart();
			const restIndent = indent + (line.text.length - rest.length);
			if (rest === "") {
				items.push(
					cur.pos < lines.length && lines[cur.pos].indent > indent
						? parseBlock(lines, cur, lines[cur.pos].indent)
						: null,
				);
			} else if (splitKey(rest) !== null) {
				// "- key: value" starts a mapping at the column of `key`.
				const virtual: Line[] = [
					{ indent: restIndent, text: rest, no: line.no },
				];
				const inner = { pos: 0 };
				const tail = lines.slice(cur.pos);
				let take = 0;
				while (take < tail.length && tail[take].indent >= restIndent) take++;
				const block = [...virtual, ...tail.slice(0, take)];
				items.push(parseBlock(block, inner, restIndent));
				cur.pos += take;
			} else {
				items.push(inlineValue(lines, cur, rest, line.no, indent));
			}
		}
		return items;
	}
	const map: { [key: string]: YamlValue } = {};
	while (cur.pos < lines.length && lines[cur.pos].indent === indent) {
		const line = lines[cur.pos];
		const kv = splitKey(line.text);
		if (kv === null) {
			if (Object.keys(map).length === 0) {
				cur.pos++;
				return inlineValue(lines, cur, line.text, line.no, indent - 1);
			}
			throw new YamlError("expected key: value", line.no);
		}
		cur.pos++;
		const [key, rest] = kv;
		if (rest === "") {
			const next = lines[cur.pos];
			if (next && next.indent > indent) {
				map[key] = parseBlock(lines, cur, next.indent);
			} else if (
				next && next.indent === indent &&
				(next.text === "-" || next.text.startsWith("- "))
			) {
				// A sequence may sit at the same indent as its key.
				map[key] = parseBlock(lines, cur, indent);
			} else {
				map[key] = null;
			}
		} else {
			map[key] = inlineValue(lines, cur, rest, line.no, indent);
		}
	}
	if (cur.pos < lines.length && lines[cur.pos].indent > indent) {
		throw new YamlError("bad indentation", lines[cur.pos].no);
	}
	return map;
};

/** Parses one YAML document (the subset above). An empty document is null. */
export const parseYaml = (source: string): YamlValue => {
	const lines = toLines(source);
	if (lines.length === 0) return null;
	const cur = { pos: 0 };
	const value = parseBlock(lines, cur, lines[0].indent);
	if (cur.pos < lines.length) {
		throw new YamlError("unexpected content", lines[cur.pos].no);
	}
	return value;
};
