// JSON with comments and trailing commas (deno.jsonc, tsconfig-style
// package manifests). Nothing that fails to parse throws: a
// broken manifest must not fail detection, it only contributes nothing
// (`parseJsonc` returns undefined for it).

/** Removes `//` and `/* *\/` comments and trailing commas outside strings. */
export const stripJsonc = (text: string): string => {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
			out += text.slice(i, j + 1);
			i = j + 1;
		} else if (ch === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
		} else if (ch === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end === -1 ? text.length : end + 2;
		} else if (ch === ",") {
			let j = i + 1;
			while (j < text.length && /\s/.test(text[j])) j++;
			if (text[j] !== "}" && text[j] !== "]") out += ch;
			i++;
		} else {
			out += ch;
			i++;
		}
	}
	return out;
};

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Parses JSON or JSONC; undefined when the text is not valid. */
export const parseJsonc = (text: string): JsonValue | undefined => {
	try {
		return JSON.parse(stripJsonc(text)) as JsonValue;
	} catch {
		return undefined;
	}
};

export const isObject = (value: unknown): value is JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** The string items of an array value (anything else is skipped). */
export const stringItems = (value: unknown): string[] =>
	Array.isArray(value)
		? value.filter((v): v is string => typeof v === "string")
		: [];
