// What a project's `.cue` files say, read TEXTUALLY: no CUE evaluation, so only
// literal values count. The tokens of `./scan.ts` go through a small recursive
// reader of the struct subset the forms below need; anything else is opaque.
//
//   name: "x"                                        the project's name
//   deps: ["a", "b"]                                 its dependencies
//   extensions: "rawkode.issues": enabled: false     one line
//   extensions: { "rawkode.issues": { enabled: false } }   a block, on any lines
//
// A value that is not a literal (`enabled: *true | bool`, `extensions: x`, a
// comprehension) cannot be read. For `enabled` that means ENABLED, with a
// warning on the project: an unreadable form never switches an extension off.
//
// This read is not policy. Nothing here is evaluated, signed off or
// protected: a project-root `.cue` edit lands without the ADR's sign-off
// (docs/repo-config.md, "Per-project config is not enforced").

import { type CueLine, scanCue } from "./scan.ts";

/** The characters a literal name may hold (`FootprintSchema`-safe). */
export const NAME_CHARS_RE = /^[A-Za-z0-9._-]+$/;

/** Nesting the reader follows; a deeper value is opaque, whatever it holds. */
const MAX_NESTING = 32;

/** The extension whose per-project switch is read. */
export const ISSUES_EXTENSION = "rawkode.issues";

export type EnabledRead =
	/** No declaration: the extension stays on. */
	| { readonly state: "absent" }
	| { readonly state: "read"; readonly enabled: boolean }
	/** A declaration this reader cannot read: the extension stays on. */
	| { readonly state: "unreadable"; readonly why: string };

export type ManifestFacts = {
	/** The first literal top-level `name`. */
	readonly name?: string;
	/** A top-level `name` that is not a literal. */
	readonly computedName: boolean;
	/** A top-level `name` that is a literal, but not in `NAME_CHARS_RE`. */
	readonly invalidName: boolean;
	/** Literal strings of top-level `deps`. */
	readonly deps: readonly string[];
	/** A top-level `deps` (or an item of it) that is not a literal string. */
	readonly computedDeps: boolean;
	readonly issues: EnabledRead;
};

type Token =
	| { readonly kind: "string"; readonly raw: string; readonly simple: boolean }
	| { readonly kind: "ident"; readonly text: string }
	| { readonly kind: "punct"; readonly text: string }
	| { readonly kind: "newline" };

type Value =
	| { readonly kind: "string"; readonly raw: string; readonly simple: boolean }
	| { readonly kind: "bool"; readonly value: boolean }
	| { readonly kind: "list"; readonly items: readonly Value[] }
	| { readonly kind: "struct"; readonly fields: Fields; readonly open: boolean }
	| { readonly kind: "other" };

type Fields = readonly { readonly label: string; readonly value: Value }[];

const IDENT_RE = /^[A-Za-z_$#][A-Za-z0-9_$#]*/;

const tokensOf = (lines: readonly CueLine[]): Token[] => {
	const tokens: Token[] = [];
	for (const line of lines) {
		if (line.continued) {
			tokens.push({ kind: "newline" });
			continue;
		}
		let next = 0;
		let i = 0;
		const { code } = line;
		while (i < code.length) {
			if (code.startsWith('""', i) && next < line.strings.length) {
				const s = line.strings[next++];
				tokens.push({ kind: "string", raw: s.raw, simple: s.simple });
				i += 2;
				continue;
			}
			const ident = IDENT_RE.exec(code.slice(i));
			if (ident) {
				tokens.push({ kind: "ident", text: ident[0] });
				i += ident[0].length;
				continue;
			}
			if (!/\s/.test(code[i])) tokens.push({ kind: "punct", text: code[i] });
			i++;
		}
		tokens.push({ kind: "newline" });
	}
	return tokens;
};

const OPENERS: Readonly<Record<string, string>> = {
	"{": "}",
	"[": "]",
	"(": ")",
};

const createReader = (tokens: readonly Token[]) => {
	let at = 0;
	let nesting = 0;
	const isPunct = (token: Token | undefined, text: string): boolean =>
		token?.kind === "punct" && token.text === text;

	/** Skips balanced tokens up to a newline or `,` at this level, or a closer. */
	const skipDeclaration = (): void => {
		const open: string[] = [];
		for (; at < tokens.length; at++) {
			const t = tokens[at];
			if (t.kind === "newline" && open.length === 0) return;
			if (t.kind !== "punct") continue;
			if (OPENERS[t.text]) open.push(OPENERS[t.text]);
			else if (open.at(-1) === t.text) open.pop();
			else if (
				open.length === 0 && (t.text === "," || "}])".includes(t.text))
			) {
				return;
			}
		}
	};

	/** At a value's end: a newline, a `,`, a closer, or the end of the file. */
	const atValueEnd = (): boolean => {
		const t = tokens[at];
		return t === undefined || t.kind === "newline" ||
			(t.kind === "punct" && ",}])".includes(t.text));
	};

	const labelAt = (): string | null => {
		const t = tokens[at];
		if (t?.kind === "ident") return t.text;
		if (t?.kind === "string" && t.simple) return t.raw;
		return null;
	};

	/** `label:`, `label?:` or `label!:` at the cursor; the label, past the colon. */
	const fieldStart = (): string | null => {
		const label = labelAt();
		if (label === null) return null;
		let colon = at + 1;
		if (isPunct(tokens[colon], "?") || isPunct(tokens[colon], "!")) colon++;
		if (!isPunct(tokens[colon], ":")) return null;
		at = colon + 1;
		return label;
	};

	const fieldsUntil = (
		closer: string | null,
	): { fields: Fields; open: boolean } => {
		const fields: { label: string; value: Value }[] = [];
		let open = false;
		while (at < tokens.length) {
			const t = tokens[at];
			if (t.kind === "newline" || isPunct(t, ",")) {
				at++;
				continue;
			}
			if (closer !== null && isPunct(t, closer)) {
				at++;
				return { fields, open };
			}
			if (closer === null && t.kind === "punct" && "}])".includes(t.text)) {
				at++; // stray closer (malformed input)
				continue;
			}
			const label = fieldStart();
			if (label === null) {
				// An embedding, `let`, `import`, comprehension: its fields are unknown.
				const statement = t.kind === "ident" &&
					(t.text === "package" || t.text === "import");
				if (!statement) open = true;
				const before = at;
				skipDeclaration();
				if (at === before) at++;
				continue;
			}
			fields.push({ label, value: valueAt() });
		}
		return { fields, open };
	};

	const listItems = (): Value[] => {
		const items: Value[] = [];
		while (at < tokens.length) {
			const t = tokens[at];
			if (t.kind === "newline" || isPunct(t, ",")) {
				at++;
				continue;
			}
			if (isPunct(t, "]")) {
				at++;
				return items;
			}
			const before = at;
			items.push(valueAt());
			if (at === before) at++;
		}
		return items;
	};

	/** The value at the cursor; a composite expression is opaque as a whole. */
	const valueAt = (): Value => {
		if (nesting >= MAX_NESTING) {
			skipDeclaration();
			return { kind: "other" };
		}
		nesting++;
		const start = tokens[at];
		const value = ((): Value => {
			if (start === undefined) return { kind: "other" };
			const nested = fieldStart();
			if (nested !== null) {
				return {
					kind: "struct",
					fields: [{ label: nested, value: valueAt() }],
					open: false,
				};
			}
			at++;
			if (start.kind === "string") {
				return { kind: "string", raw: start.raw, simple: start.simple };
			}
			if (start.kind === "ident") {
				return start.text === "true" || start.text === "false"
					? { kind: "bool", value: start.text === "true" }
					: { kind: "other" };
			}
			if (isPunct(start, "{")) {
				return { kind: "struct", ...fieldsUntil("}") };
			}
			if (isPunct(start, "[")) return { kind: "list", items: listItems() };
			at--;
			return { kind: "other" };
		})();
		nesting--;
		if (atValueEnd()) return value;
		skipDeclaration();
		return { kind: "other" };
	};

	return { fields: () => fieldsUntil(null) };
};

const named = (fields: Fields, label: string): Value[] =>
	fields.filter((f) => f.label === label).map((f) => f.value);

/** Reads `<id>: enabled` from the values of a top-level `extensions`. */
const enabledOf = (values: readonly Value[], id: string): EnabledRead => {
	const reads: EnabledRead[] = [];
	for (const ext of values) {
		if (ext.kind !== "struct") {
			reads.push({ state: "unreadable", why: "extensions is not a literal" });
			continue;
		}
		const entries = named(ext.fields, id);
		if (entries.length === 0 && ext.open) {
			reads.push({ state: "unreadable", why: "extensions is not a literal" });
		}
		for (const entry of entries) {
			if (entry.kind !== "struct") {
				reads.push({ state: "unreadable", why: `${id} is not a literal` });
				continue;
			}
			const flags = named(entry.fields, "enabled");
			if (flags.length === 0 && entry.open) {
				reads.push({ state: "unreadable", why: `${id} is not a literal` });
			}
			for (const flag of flags) {
				reads.push(
					flag.kind === "bool"
						? { state: "read", enabled: flag.value }
						: { state: "unreadable", why: "enabled is not true or false" },
				);
			}
		}
	}
	return mergeEnabled(reads);
};

/** Several reads of one switch: a conflict or an unreadable one is unreadable. */
export const mergeEnabled = (reads: readonly EnabledRead[]): EnabledRead => {
	const unreadable = reads.find((r) => r.state === "unreadable");
	if (unreadable !== undefined) return unreadable;
	const values = new Set(
		reads.flatMap((r) => r.state === "read" ? [r.enabled] : []),
	);
	if (values.size > 1) {
		return {
			state: "unreadable",
			why: "enabled is declared both true and false",
		};
	}
	const [enabled] = values;
	return enabled === undefined
		? { state: "absent" }
		: { state: "read", enabled };
};

/** The literal facts of one `.cue` file (already known to be `package tartan`). */
export const readManifest = (text: string): ManifestFacts => {
	const lines = scanCue(text);
	const { fields } = createReader(tokensOf(lines)).fields();

	const names = named(fields, "name");
	const isLiteral = (v: Value) => v.kind === "string" && v.simple;
	const literal = names.find((v) =>
		v.kind === "string" && v.simple && NAME_CHARS_RE.test(v.raw)
	);

	const depValues = named(fields, "deps");
	const deps: string[] = [];
	let computedDeps = false;
	for (const value of depValues) {
		if (value.kind !== "list") {
			computedDeps = true;
			continue;
		}
		for (const item of value.items) {
			if (item.kind === "string" && item.simple) deps.push(item.raw);
			else computedDeps = true;
		}
	}

	const extensions = named(fields, "extensions");
	let issues = enabledOf(extensions, ISSUES_EXTENSION);
	const declared = extensions.some((ext) =>
		ext.kind === "struct" && named(ext.fields, ISSUES_EXTENSION).length > 0
	);
	if (
		!declared && issues.state === "absent" &&
		lines.some((l) => l.strings.some((s) => s.raw === ISSUES_EXTENSION))
	) {
		// The id is written somewhere this reader does not look.
		issues = {
			state: "unreadable",
			why: `${ISSUES_EXTENSION} appears outside a literal top-level extensions`,
		};
	}

	return {
		...(literal?.kind === "string" ? { name: literal.raw } : {}),
		computedName: literal === undefined && names.some((v) => !isLiteral(v)),
		invalidName: literal === undefined && names.some(isLiteral),
		deps,
		computedDeps,
		issues,
	};
};
