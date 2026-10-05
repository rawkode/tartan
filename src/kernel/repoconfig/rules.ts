// The kernel's file rules for repository config (ADR repo config, "Tartan
// config in a repository"; REPO_CONFIG_RULES_VERSION 2). Pure.
//
// The set is every entry directly in the root tree whose name ends in
// `.cue` (`isPolicyPath`), of ANY package: the forge sends them all and the
// CLI (`cue export .:tartan`) decides which are package `tartan`. The kernel
// never reads package clauses, `_`/`.` prefixes, `_tool`/`_test` suffixes or
// `@if(…)` attributes: those are the CLI's rules, and a second, hand-written
// loader could disagree with it. So the rules here are only about what can
// be sent safely:
//
// - names `[A-Za-z0-9_.-]+\.cue`, ASCII only; another name (a space,
//   U+2028, any non-ASCII byte) is rejected, never dropped, because a local
//   `cue export .:tartan` would load it;
// - regular files only (git modes 100644, 100755); a symlink, a submodule or
//   a directory named `*.cue` is rejected;
// - at most 32 files, 64 KiB each, 256 KiB in total, counted across
//   packages (a large `env.cue` of another tool counts), valid UTF-8.
//
// A failure is `INVALID_INPUT` naming the path. Subdirectories, other files
// and the repository's own `cue.mod/` are never read.

import {
	isPolicyPath,
	REPO_CONFIG_FILE_RE,
	REPO_CONFIG_LIMITS,
} from "@tartan/contract";

/** One root tree entry, as the Artifacts binding lists it. */
export type ConfigTreeEntry = {
	readonly name: string;
	readonly mode: string;
	readonly hash: string;
	readonly type: string;
};

export type SelectedFile = { readonly name: string; readonly oid: string };

export type RuleViolation = {
	readonly ok: false;
	/** The repo-relative path the rule is about ("" for the whole set). */
	readonly path: string;
	readonly message: string;
};

export type Selection =
	| { readonly ok: true; readonly files: readonly SelectedFile[] }
	| RuleViolation;

const REGULAR = new Set(["100644", "100755"]);

const violation = (path: string, message: string): RuleViolation => ({
	ok: false,
	path,
	message,
});

/** A name as text a page may show (escaped, capped). */
export const describeName = (name: string): string =>
	JSON.stringify(name).slice(1, -1).slice(0, 200);

/** The root `*.cue` entries of a root tree listing (the policy paths), sorted by name. */
export const rootCueEntries = (
	root: readonly ConfigTreeEntry[],
): ConfigTreeEntry[] =>
	root.filter((e) => isPolicyPath(e.name)).sort((a, b) =>
		a.name < b.name ? -1 : a.name > b.name ? 1 : 0
	);

/**
 * Selects the files to send from the root `*.cue` entries. Every entry must
 * be a regular file with an admissible name; the count is capped.
 */
export const selectConfigFiles = (
	entries: readonly ConfigTreeEntry[],
): Selection => {
	const files: SelectedFile[] = [];
	for (const entry of rootCueEntries(entries)) {
		const { name } = entry;
		const shown = describeName(name);
		if (entry.type === "symlink" || entry.mode === "120000") {
			return violation(name, `${shown} is a symlink; use a file`);
		}
		if (entry.type === "gitlink" || entry.mode === "160000") {
			return violation(name, `${shown} is a submodule`);
		}
		if (entry.type === "tree" || /^0*40000$/.test(entry.mode)) {
			return violation(name, `${shown} is a directory named like a .cue file`);
		}
		if (!REPO_CONFIG_FILE_RE.test(name)) {
			return violation(
				name,
				`${shown}: root .cue names are ASCII letters, digits, _ . - (rename it; cue would load it)`,
			);
		}
		if (!REGULAR.has(entry.mode)) {
			return violation(name, `${shown} has mode ${entry.mode}`);
		}
		files.push({ name, oid: entry.hash });
	}
	if (files.length > REPO_CONFIG_LIMITS.files) {
		return violation(
			"",
			`${files.length} root .cue files; at most ${REPO_CONFIG_LIMITS.files} (every package counts)`,
		);
	}
	return { ok: true, files };
};

const decoder = new TextDecoder("utf-8", { fatal: true });

export type CheckedFile = SelectedFile & { readonly text: string };

/** Checks the selected files' bytes: sizes (across packages) and UTF-8. */
export const checkConfigContents = (
	files: readonly (SelectedFile & { readonly bytes: Uint8Array })[],
):
	| { readonly ok: true; readonly files: readonly CheckedFile[] }
	| RuleViolation => {
	let total = 0;
	const out: CheckedFile[] = [];
	for (const file of files) {
		if (file.bytes.byteLength > REPO_CONFIG_LIMITS.fileBytes) {
			return violation(
				file.name,
				`${file.bytes.byteLength} bytes; at most ${REPO_CONFIG_LIMITS.fileBytes} per root .cue file`,
			);
		}
		total += file.bytes.byteLength;
		if (total > REPO_CONFIG_LIMITS.totalBytes) {
			return violation(
				file.name,
				`more than ${REPO_CONFIG_LIMITS.totalBytes} bytes of root .cue files in total (every package counts)`,
			);
		}
		let text: string;
		try {
			text = decoder.decode(file.bytes);
		} catch {
			return violation(file.name, "not valid UTF-8");
		}
		out.push({ name: file.name, oid: file.oid, text });
	}
	return { ok: true, files: out };
};
