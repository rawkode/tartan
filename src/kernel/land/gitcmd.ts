// The git command lines of the Advance and the
// parsers of their output. Pure: argv arrays only (never a shell string,
// contract `GitExec`), so they run unchanged in the runner image
// (`git:<repoId>`, git ≥ 2.38) and against a local git in tests.
//
// - Every fetch is by explicit SHA into a work ref (`+<sha>:<ref>`):
//   never `FETCH_HEAD`, never a tag.
// - `merge-tree --write-tree` composes without a work tree; `diff3` markers
//   give the conflict regions.
// - Commits and notes get fixed identities and dates, so a re-run of a step
//   writes the same objects (the steps are re-entrant).
// - Pushes use `--force-with-lease=<ref>:<expected>` and `--porcelain`.

import { invalid, ZERO_SHA } from "@tartan/contract";
import type { ConflictRegion } from "@tartan/contract";
import type { GitIdentity } from "@tartan/contract/kernel.ts";

export const SHA_RE = /^[0-9a-f]{40}$/;

const requireSha = (sha: string, what: string): string => {
	if (!SHA_RE.test(sha)) throw invalid(`${what}: not a sha: ${sha}`);
	return sha;
};

/** The warm mirror of a repo inside its `git:<repoId>` sandbox. */
export const mirrorPath = (root: string, repoId: string): string =>
	`${root.replace(/\/+$/, "")}/${repoId}.git`;

/** Group-shared bare mirror (both runner uids write it); idempotent. */
export const initMirrorArgv = (mirror: string): string[] => [
	"git",
	"init",
	"--bare",
	"--quiet",
	"--shared=group",
	mirror,
];

export type FetchSpec = { readonly sha: string; readonly ref: string };

export const fetchArgv = (
	mirror: string,
	remote: string,
	specs: readonly FetchSpec[],
): string[] => {
	if (specs.length === 0) throw invalid("fetch needs at least one sha");
	return [
		"git",
		"-C",
		mirror,
		"fetch",
		"--no-tags",
		"--no-write-fetch-head",
		"--no-auto-gc",
		"--quiet",
		remote,
		...specs.map((s) => `+${requireSha(s.sha, "fetch")}:${s.ref}`),
	];
};

/** Exit 0 iff the mirror holds `sha` as a commit. */
export const hasCommitArgv = (mirror: string, sha: string): string[] => [
	"git",
	"-C",
	mirror,
	"cat-file",
	"-e",
	`${requireSha(sha, "cat-file")}^{commit}`,
];

export const mergeTreeArgv = (
	mirror: string,
	ours: string,
	theirs: string,
): string[] => [
	"git",
	"-C",
	mirror,
	"-c",
	"merge.conflictStyle=diff3",
	"merge-tree",
	"--write-tree",
	"--name-only",
	"--no-messages",
	requireSha(ours, "merge-tree"),
	requireSha(theirs, "merge-tree"),
];

export type MergeTreeResult =
	| { readonly clean: true; readonly tree: string }
	| {
		readonly clean: false;
		readonly tree: string;
		readonly paths: readonly string[];
	};

/**
 * `merge-tree --write-tree --name-only --no-messages`: exit 0 clean (one
 * line, the tree), exit 1 conflicted (the tree, then one conflicted path per
 * line); anything else is an error.
 */
export const parseMergeTree = (
	exitCode: number,
	stdout: string,
): MergeTreeResult => {
	const lines = stdout.split("\n").filter((l) => l.length > 0);
	const tree = lines[0] ?? "";
	if (!SHA_RE.test(tree) || (exitCode !== 0 && exitCode !== 1)) {
		throw invalid(`merge-tree failed (exit ${exitCode})`);
	}
	if (exitCode === 0) return { clean: true, tree };
	return { clean: false, tree, paths: [...new Set(lines.slice(1))] };
};

/** A conflicted file of the merged tree, with its markers. */
export const catBlobArgv = (
	mirror: string,
	tree: string,
	path: string,
): string[] => [
	"git",
	"-C",
	mirror,
	"cat-file",
	"blob",
	`${requireSha(tree, "cat-file")}:${path}`,
];

/**
 * Conflict regions from `diff3` markers (`<<<<<<<`, `|||||||`, `=======`,
 * `>>>>>>>`). Line numbers are 1-based and counted per side in the merged
 * file: a line outside every conflict counts for all three sides, a line
 * inside a section for that side only. They locate the conflict for people
 * and agents; they are not offsets into the original blobs.
 */
export const parseConflictRegions = (text: string): ConflictRegion[] => {
	const regions: ConflictRegion[] = [];
	const counters = { base: 0, ours: 0, theirs: 0 };
	type Section = "ours" | "base" | "theirs";
	let current: Section | null = null;
	let open: ConflictRegion | null = null;
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	for (const line of lines) {
		if (line.startsWith("<<<<<<<")) {
			current = "ours";
			open = {
				baseStart: counters.base + 1,
				baseLines: 0,
				oursStart: counters.ours + 1,
				oursLines: 0,
				theirsStart: counters.theirs + 1,
				theirsLines: 0,
			};
			continue;
		}
		if (open !== null && line.startsWith("|||||||")) {
			current = "base";
			continue;
		}
		if (open !== null && line.startsWith("=======")) {
			current = "theirs";
			continue;
		}
		if (open !== null && line.startsWith(">>>>>>>")) {
			regions.push(open);
			open = null;
			current = null;
			continue;
		}
		if (open === null || current === null) {
			counters.base++;
			counters.ours++;
			counters.theirs++;
			continue;
		}
		counters[current]++;
		const key = `${current}Lines` as const;
		open = { ...open, [key]: open[key] + 1 };
	}
	return regions;
};

export type { GitIdentity };

export const identityEnv = (
	author: GitIdentity,
	committer: GitIdentity,
	epochSeconds: number,
): Record<string, string> => {
	const date = `@${Math.floor(epochSeconds)} +0000`;
	const clean = (v: string) => v.replace(/[<>\n\r\0]/g, "").trim() || "tartan";
	return {
		GIT_AUTHOR_NAME: clean(author.name),
		GIT_AUTHOR_EMAIL: clean(author.email),
		GIT_AUTHOR_DATE: date,
		GIT_COMMITTER_NAME: clean(committer.name),
		GIT_COMMITTER_EMAIL: clean(committer.email),
		GIT_COMMITTER_DATE: date,
	};
};

/** `commit-tree <tree> -p <parent> -F -` (the message on stdin). */
export const commitTreeArgv = (
	mirror: string,
	tree: string,
	parent: string,
): string[] => [
	"git",
	"-C",
	mirror,
	"commit-tree",
	requireSha(tree, "commit-tree"),
	"-p",
	requireSha(parent, "commit-tree"),
	"-F",
	"-",
];

/** Paths a commit changed against `parent` (NUL-separated). */
export const diffPathsArgv = (
	mirror: string,
	parent: string,
	commit: string,
): string[] => [
	"git",
	"-C",
	mirror,
	"diff-tree",
	"-r",
	"--name-only",
	"--no-commit-id",
	"-z",
	requireSha(parent, "diff-tree"),
	requireSha(commit, "diff-tree"),
];

export const parseNulList = (stdout: string): string[] =>
	stdout.split("\0").filter((p) => p.length > 0);

/** The root tree of a commit (`ls-tree -z`, not recursive): K13.2's root `*.cue` entries. */
export const lsTreeRootArgv = (mirror: string, commit: string): string[] => [
	"git",
	"-C",
	mirror,
	"ls-tree",
	"-z",
	"--full-tree",
	requireSha(commit, "ls-tree"),
];

export type LsTreeEntry = {
	readonly mode: string;
	readonly type: string;
	readonly oid: string;
	readonly name: string;
};

/** `<mode> SP <type> SP <oid> TAB <name>` NUL-separated. */
export const parseLsTree = (stdout: string): LsTreeEntry[] =>
	parseNulList(stdout).flatMap((line) => {
		const tab = line.indexOf("\t");
		if (tab < 0) return [];
		const [mode, type, oid] = line.slice(0, tab).split(" ");
		if (mode === undefined || type === undefined || oid === undefined) {
			return [];
		}
		return [{ mode, type, oid, name: line.slice(tab + 1) }];
	});

/** The lane range's commits (`<head> ^<trunk>`), newest first, at most `max`. */
export const revListArgv = (
	mirror: string,
	head: string,
	exclude: string,
	max: number,
): string[] => [
	"git",
	"-C",
	mirror,
	"rev-list",
	`--max-count=${Math.max(1, Math.floor(max))}`,
	requireSha(head, "rev-list"),
	`^${requireSha(exclude, "rev-list")}`,
];

export const parseLines = (stdout: string): string[] =>
	stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

/** Adds (or replaces) the note of `commit` on `notesRef` (message on stdin). */
export const notesAddArgv = (
	mirror: string,
	notesRef: string,
	commit: string,
): string[] => [
	"git",
	"-C",
	mirror,
	"notes",
	`--ref=${notesRef}`,
	"add",
	"-f",
	"-F",
	"-",
	requireSha(commit, "notes"),
];

/** Exit 0 iff `notesRef` holds a note for `commit`. */
export const notesShowArgv = (
	mirror: string,
	notesRef: string,
	commit: string,
): string[] => [
	"git",
	"-C",
	mirror,
	"notes",
	`--ref=${notesRef}`,
	"show",
	requireSha(commit, "notes"),
];

export const updateRefArgv = (
	mirror: string,
	ref: string,
	sha: string,
): string[] =>
	sha === ZERO_SHA
		? ["git", "-C", mirror, "update-ref", "-d", ref]
		: ["git", "-C", mirror, "update-ref", ref, requireSha(sha, "update-ref")];

export const revParseArgv = (mirror: string, ref: string): string[] => [
	"git",
	"-C",
	mirror,
	"rev-parse",
	"--verify",
	"--quiet",
	ref,
];

export const forEachRefArgv = (mirror: string, prefix: string): string[] => [
	"git",
	"-C",
	mirror,
	"for-each-ref",
	"--format=%(refname)",
	prefix,
];

/** `update-ref --stdin` deleting every ref of `refs` (stdin built by the caller). */
export const updateRefStdinArgv = (mirror: string): string[] => [
	"git",
	"-C",
	mirror,
	"update-ref",
	"--stdin",
];

export type PushSpec = {
	readonly src: string;
	readonly dst: string;
	/** The remote value the lease expects (zeros: the ref must not exist). */
	readonly expect: string;
};

export const pushArgv = (
	mirror: string,
	remote: string,
	specs: readonly PushSpec[],
	options: { readonly atomic?: boolean } = {},
): string[] => {
	if (specs.length === 0) throw invalid("push needs at least one ref");
	return [
		"git",
		"-C",
		mirror,
		"push",
		"--porcelain",
		"--no-verify",
		...(options.atomic ? ["--atomic"] : []),
		...specs.map((s) =>
			`--force-with-lease=${s.dst}:${
				s.expect === ZERO_SHA ? "" : requireSha(s.expect, "lease")
			}`
		),
		remote,
		...specs.map((s) => `${requireSha(s.src, "push")}:${s.dst}`),
	];
};

export type PushRefOutcome = {
	readonly ref: string;
	/** `ok`: updated or created; `uptodate`; `stale`: the lease failed; `rejected`: refused. */
	readonly kind: "ok" | "uptodate" | "stale" | "rejected";
	readonly reason: string;
};

/**
 * `git push --porcelain`: one `<flag>\t<from>:<to>\t<summary>` line per ref
 * (`' '`, `+`, `-`, `*` updated; `=` up to date; `!` rejected, with
 * `(stale info)` for a failed lease).
 */
export const parsePushPorcelain = (stdout: string): PushRefOutcome[] => {
	const out: PushRefOutcome[] = [];
	for (const line of stdout.split("\n")) {
		const m = /^([ +\-*=!])\t([^\t]*):([^\t]+)\t(.*)$/.exec(line);
		if (!m) continue;
		const [, flag, , ref, summary] = m;
		const kind: PushRefOutcome["kind"] = flag === "="
			? "uptodate"
			: flag === "!"
			? /stale info|fetch first|non-fast-forward/.test(summary)
				? "stale"
				: "rejected"
			: "ok";
		out.push({ ref, kind, reason: summary.trim() });
	}
	return out;
};
