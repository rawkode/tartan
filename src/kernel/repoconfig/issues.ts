// CUE's text errors → positioned issues (tartan.cue-eval/1). Pure.
//
// `cue export` prints one error per unindented line (`<path>: <message>`,
// the path quote-aware since labels may contain `:`), followed by its
// positions, one per indented line (`    ./tartan.cue:4:11`). The text is
// repository-controlled: it is normalized here (the per-job module path
// becomes `<module>`, `./` is dropped from positions), capped (issues,
// message bytes, positions), positions are checked against the contract's
// pattern and dropped when they do not match, and the result is only ever
// shown as text.

import {
	EVAL_POSITION_RE,
	type EvalIssue,
	FORGE_SCHEMA_IMPORT,
	REPO_CONFIG_LIMITS,
	REPO_CONFIG_PACKAGE,
	REPO_CONFIG_POSITION_RE,
	stripForgeModule,
} from "@tartan/contract";

/** Control characters other than tab, stripped from messages. */
// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/g;

/**
 * Bidi, format and zero-width characters: shown as `\uXXXX`
 * so repository text on a sign-off surface (an issue, a plan value such as a
 * CI `run` string) reads in its stored order, never visually reordered or
 * hiding a character.
 */
const INVISIBLE =
	/[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/g;

/** `text` with every bidi, format and zero-width character as a visible `\uXXXX` escape. */
export const escapeInvisible = (text: string): string =>
	text.replace(
		INVISIBLE,
		(ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);

const clip = (text: string, max: number): string => {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1))}…`;
};

/** Splits `path: msg` at the first `: ` outside double quotes. */
const splitPath = (line: string): { path: string; msg: string } => {
	let quoted = false;
	for (let i = 0; i < line.length - 1; i++) {
		const ch = line[i];
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === '"') quoted = !quoted;
		if (!quoted && ch === ":" && line[i + 1] === " ") {
			return { path: line.slice(0, i), msg: line.slice(i + 2) };
		}
	}
	return { path: "", msg: line };
};

export const normalizeCueErrors = (text: string): EvalIssue[] => {
	const out: { path: string; msg: string; pos: string[] }[] = [];
	const lines = stripForgeModule(text).split("\n");
	for (const raw of lines) {
		const line = raw.replace(/\r$/, "");
		if (line.trim() === "") continue;
		if (/^\s/.test(line)) {
			const last = out[out.length - 1];
			if (last === undefined) continue;
			const pos = line.trim().replace(/^\.\//, "");
			if (
				last.pos.length < REPO_CONFIG_LIMITS.issuePositions &&
				pos.length <= 600 && EVAL_POSITION_RE.test(pos)
			) {
				last.pos.push(pos);
			}
			continue;
		}
		if (out.length >= REPO_CONFIG_LIMITS.issues) break;
		const { path, msg } = splitPath(line);
		out.push({
			path: clip(escapeInvisible(path.replace(CONTROL, "")), 2048),
			msg: clip(
				escapeInvisible(msg.replace(/:$/, "").replace(CONTROL, "")),
				REPO_CONFIG_LIMITS.issueMessageBytes,
			),
			pos: [],
		});
	}
	return out;
};

/** Load-phase failures (parse, imports, nesting): `LOAD_INSTANCE`. */
const LOAD_RE =
	/^(expected |illegal |missing |import failed|cannot find package|package .* not found|found packages|invalid package|.*: no such file|.* is not a valid|expression exceeds maximum nesting depth|no CUE files|cannot refer to parent directory|string literal not terminated|unexpected )/;

export const isLoadIssue = (issue: EvalIssue): boolean =>
	LOAD_RE.test(issue.msg) || LOAD_RE.test(`${issue.path}: ${issue.msg}`);

/** `import failed: … cannot find package "<p>"`: the package named. */
const IMPORT_RE =
	/(?:^|: )(?:import failed: )+cannot find package "([^"]{1,300})"/;

export type RefusedImport = {
	/** The import as the CLI names it (the innermost missing package). */
	readonly importPath: string;
	/** The first position in a repository root file (`<name>.cue:L:C`), if any. */
	readonly position: string | null;
};

/**
 * The import rule (ADR repo config): package `tartan` may import only the CUE
 * standard library and `tartan.dev/ext/...`. Any other import (a registry
 * module, a package of the repository's own module or its `cue.mod/pkg`,
 * the job's own module) fails in the CLI with `cannot find package`; this
 * finds that issue and its position in a root file.
 */
export const refusedImport = (
	issues: readonly EvalIssue[],
): RefusedImport | null => {
	for (const issue of issues) {
		const m = IMPORT_RE.exec(`${issue.path}: ${issue.msg}`);
		if (m === null) continue;
		const position = issue.pos.find((p) => REPO_CONFIG_POSITION_RE.test(p)) ??
			null;
		return { importPath: m[1], position };
	}
	return null;
};

/** The `INVALID_INPUT` message of a refused import (names the file, position and import). */
export const refusedImportMessage = (refused: RefusedImport): string => {
	const where = refused.position === null
		? "a file"
		: `\`${refused.position}\``;
	return refused.importPath === FORGE_SCHEMA_IMPORT ||
			refused.importPath.startsWith(`${FORGE_SCHEMA_IMPORT}/`)
		? `${where} imports \`${refused.importPath}\`, which this repository's schema does not provide (only approved and installed extensions are in it)`
		: `package ${REPO_CONFIG_PACKAGE} may import only the CUE standard library and ${FORGE_SCHEMA_IMPORT}: ${where} imports \`${refused.importPath}\``;
};

/** A short summary of an issue list (the envelope's `message`). */
export const summarizeIssues = (issues: readonly EvalIssue[]): string => {
	if (issues.length === 0) return "cue reported an error without details";
	// The first issue with a position says the most ("2 errors in empty
	// disjunction" heads a group and has none).
	const first = issues.find((i) => i.pos.length > 0) ?? issues[0];
	const head = first.path === "" ? first.msg : `${first.path}: ${first.msg}`;
	return clip(
		issues.length === 1 ? head : `${head} (and ${issues.length - 1} more)`,
		REPO_CONFIG_LIMITS.issueMessageBytes,
	);
};
