// A TOML subset, enough for Cargo manifests: `[table]` and `[[array]]`
// headers with dotted/quoted keys, `key = value` with dotted keys, basic and
// literal strings (also multi-line), integers, floats, booleans, arrays
// (also across lines), inline tables, and comments. Dates read as strings.
// Throws `TomlError` on malformed input.

export type TomlValue =
	| string
	| number
	| boolean
	| TomlValue[]
	| { [key: string]: TomlValue };
export type TomlTable = { [key: string]: TomlValue };

export class TomlError extends Error {
	constructor(message: string, readonly line: number) {
		super(`toml: ${message} (line ${line})`);
		this.name = "TomlError";
	}
}

const ESCAPES: Record<string, string> = {
	b: "\b",
	t: "\t",
	n: "\n",
	f: "\f",
	r: "\r",
	'"': '"',
	"\\": "\\",
};

type Reader = { text: string; i: number; line: number };

const fail = (r: Reader, message: string): never => {
	throw new TomlError(message, r.line);
};

/** Skips spaces, tabs, comments and (when `newlines`) line breaks. */
const skip = (r: Reader, newlines: boolean): void => {
	while (r.i < r.text.length) {
		const ch = r.text[r.i];
		if (ch === " " || ch === "\t" || ch === "\r") r.i++;
		else if (ch === "#") {
			while (r.i < r.text.length && r.text[r.i] !== "\n") r.i++;
		} else if (ch === "\n" && newlines) {
			r.line++;
			r.i++;
		} else break;
	}
};

const readString = (r: Reader): string => {
	const q = r.text[r.i];
	const multi = r.text.startsWith(q.repeat(3), r.i);
	r.i += multi ? 3 : 1;
	if (multi && r.text[r.i] === "\n") {
		r.i++;
		r.line++;
	}
	let out = "";
	for (;;) {
		if (r.i >= r.text.length) fail(r, "unterminated string");
		const ch = r.text[r.i];
		if (multi ? r.text.startsWith(q.repeat(3), r.i) : ch === q) {
			r.i += multi ? 3 : 1;
			return out;
		}
		if (ch === "\n") {
			if (!multi) fail(r, "newline in string");
			r.line++;
		}
		if (ch === "\\" && q === '"') {
			const e = r.text[r.i + 1];
			if (e === "u" || e === "U") {
				const len = e === "u" ? 4 : 8;
				out += String.fromCodePoint(
					parseInt(r.text.slice(r.i + 2, r.i + 2 + len), 16),
				);
				r.i += 2 + len;
			} else if (multi && (e === "\n" || e === " " || e === "\r")) {
				r.i++;
				skip(r, true);
			} else {
				out += ESCAPES[e] ?? fail(r, `bad escape \\${e}`);
				r.i += 2;
			}
			continue;
		}
		out += ch;
		r.i++;
	}
};

const BARE = /[A-Za-z0-9_-]/;

const readKey = (r: Reader): string[] => {
	const parts: string[] = [];
	for (;;) {
		skip(r, false);
		const ch = r.text[r.i];
		if (ch === '"' || ch === "'") parts.push(readString(r));
		else {
			const start = r.i;
			while (r.i < r.text.length && BARE.test(r.text[r.i])) r.i++;
			if (r.i === start) fail(r, "expected a key");
			parts.push(r.text.slice(start, r.i));
		}
		skip(r, false);
		if (r.text[r.i] !== ".") return parts;
		r.i++;
	}
};

const readValue = (r: Reader): TomlValue => {
	skip(r, false);
	const ch = r.text[r.i];
	if (ch === '"' || ch === "'") return readString(r);
	if (ch === "[") {
		r.i++;
		const items: TomlValue[] = [];
		for (;;) {
			skip(r, true);
			if (r.text[r.i] === "]") {
				r.i++;
				return items;
			}
			items.push(readValue(r));
			skip(r, true);
			if (r.text[r.i] === ",") r.i++;
			else if (r.text[r.i] !== "]") fail(r, "expected , or ]");
		}
	}
	if (ch === "{") {
		r.i++;
		const table: TomlTable = {};
		skip(r, false);
		if (r.text[r.i] === "}") {
			r.i++;
			return table;
		}
		for (;;) {
			const key = readKey(r);
			if (r.text[r.i] !== "=") fail(r, "expected =");
			r.i++;
			assign(r, table, key, readValue(r));
			skip(r, false);
			if (r.text[r.i] === "}") {
				r.i++;
				return table;
			}
			if (r.text[r.i] !== ",") fail(r, "expected , or }");
			r.i++;
		}
	}
	const start = r.i;
	while (r.i < r.text.length && /[^\s,\]}#]/.test(r.text[r.i])) r.i++;
	// Dates/times may contain a space between date and time.
	if (/^\d{4}-\d{2}-\d{2}$/.test(r.text.slice(start, r.i))) {
		const m = /^ \d{2}:\d{2}[^\s,\]}#]*/.exec(r.text.slice(r.i));
		if (m) r.i += m[0].length;
	}
	const raw = r.text.slice(start, r.i);
	if (raw === "true") return true;
	if (raw === "false") return false;
	const num = raw.replaceAll("_", "");
	if (/^[-+]?(0x[0-9a-fA-F]+|0o[0-7]+|0b[01]+)$/.test(num)) {
		const sign = num.startsWith("-") ? -1 : 1;
		return sign * Number(num.replace(/^[-+]/, ""));
	}
	if (/^[-+]?(\d+(\.\d+)?([eE][-+]?\d+)?|inf|nan)$/.test(num)) {
		return num.endsWith("inf")
			? (num.startsWith("-") ? -Infinity : Infinity)
			: Number(num);
	}
	if (/^\d{4}-\d{2}-\d{2}|^\d{2}:\d{2}/.test(raw)) return raw;
	return fail(r, `bad value ${JSON.stringify(raw)}`);
};

const isTable = (v: TomlValue | undefined): v is TomlTable =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** The table at `path` under `root`, creating tables (or using an array's last). */
const tableAt = (
	r: Reader,
	root: TomlTable,
	path: readonly string[],
): TomlTable => {
	let table = root;
	for (const part of path) {
		const next = table[part];
		if (next === undefined) {
			const fresh: TomlTable = {};
			table[part] = fresh;
			table = fresh;
		} else if (isTable(next)) {
			table = next;
		} else if (Array.isArray(next) && isTable(next.at(-1))) {
			table = next.at(-1) as TomlTable;
		} else {
			fail(r, `${part} is not a table`);
		}
	}
	return table;
};

const assign = (
	r: Reader,
	table: TomlTable,
	key: readonly string[],
	value: TomlValue,
): void => {
	const target = tableAt(r, table, key.slice(0, -1));
	const last = key.at(-1)!;
	if (last in target) fail(r, `duplicate key ${key.join(".")}`);
	target[last] = value;
};

/** Parses a TOML document (the subset above). */
export const parseToml = (text: string): TomlTable => {
	const root: TomlTable = {};
	const r: Reader = { text, i: 0, line: 1 };
	let current = root;
	for (;;) {
		skip(r, true);
		if (r.i >= text.length) return root;
		if (text[r.i] === "[") {
			const array = text[r.i + 1] === "[";
			r.i += array ? 2 : 1;
			const path = readKey(r);
			if (!text.startsWith(array ? "]]" : "]", r.i)) fail(r, "bad header");
			r.i += array ? 2 : 1;
			if (array) {
				const parent = tableAt(r, root, path.slice(0, -1));
				const name = path.at(-1)!;
				const list = parent[name] ?? [];
				if (!Array.isArray(list)) fail(r, `${name} is not an array`);
				const entry: TomlTable = {};
				(list as TomlValue[]).push(entry);
				parent[name] = list;
				current = entry;
			} else {
				current = tableAt(r, root, path);
			}
		} else {
			const key = readKey(r);
			if (text[r.i] !== "=") fail(r, "expected =");
			r.i++;
			assign(r, current, key, readValue(r));
		}
		skip(r, false);
		if (r.i < text.length && text[r.i] !== "\n") fail(r, "expected newline");
	}
};
