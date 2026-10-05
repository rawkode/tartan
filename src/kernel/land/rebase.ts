// Server-side rebase of a lane in the bare mirror (WP10; `lanes_restack`): the
// lane's own commits (non-merge, oldest first, as `git rebase` without
// `--rebase-merges` linearizes them) are replayed one by one onto the new base
// with `merge-tree --merge-base=<parent>` and `commit-tree`, keeping each
// commit's author, author date and message; the committer is the kernel. No
// work tree, no index: the same primitives compose uses. A conflict stops the
// replay and reports the conflicted paths with their diff3 regions; nothing is
// written.

import { invalid, unavailable } from "@tartan/contract";
import type { ConflictRegion } from "@tartan/contract";
import type { GitExecResult } from "@tartan/contract/kernel.ts";
import type { GitRunner } from "./git.ts";
import {
	catBlobArgv,
	type GitIdentity,
	parseConflictRegions,
	parseLines,
	parseMergeTree,
	SHA_RE,
} from "./gitcmd.ts";

/** A lane range longer than this is not rebased server-side. */
export const REBASE_MAX_COMMITS = 500;

export type RebaseOutcome =
	| { readonly ok: true; readonly head: string; readonly replayed: number }
	| {
		readonly ok: false;
		/** The lane commit whose replay conflicted. */
		readonly at: string;
		readonly conflicts: readonly {
			readonly path: string;
			readonly regions: readonly ConflictRegion[];
		}[];
	};

export type CommitHeader = {
	readonly tree: string;
	readonly parents: readonly string[];
	readonly author: GitIdentity;
	/** `@<epoch> <tz>` as recorded. */
	readonly authorDate: string;
	readonly message: string;
};

/** Parses `git cat-file commit <sha>`. */
export const parseCommitObject = (text: string): CommitHeader => {
	const split = text.indexOf("\n\n");
	const head = split === -1 ? text : text.slice(0, split);
	const message = split === -1 ? "" : text.slice(split + 2);
	let tree = "";
	const parents: string[] = [];
	let author: GitIdentity | null = null;
	let authorDate = "";
	for (const line of head.split("\n")) {
		if (line.startsWith("tree ")) tree = line.slice(5).trim();
		else if (line.startsWith("parent ")) parents.push(line.slice(7).trim());
		else if (line.startsWith("author ")) {
			const m = /^author (.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
			if (m === null) throw invalid("unparseable author line");
			author = { name: m[1], email: m[2] };
			authorDate = `@${m[3]} ${m[4]}`;
		}
	}
	if (!SHA_RE.test(tree) || author === null) {
		throw invalid("not a commit object");
	}
	return { tree, parents, author, authorDate, message };
};

const clean = (v: string) => v.replace(/[<>\n\r\0]/g, "").trim() || "tartan";

export const rebaseOnto = async (
	deps: {
		readonly exec: GitRunner;
		readonly mirror: string;
		readonly committer: GitIdentity;
		/** Epoch seconds of the committer date. */
		readonly date: number;
		readonly max?: number;
	},
	input: {
		readonly head: string;
		readonly onto: string;
		/** More commits that are not the lane's own (trunk, for a restack onto another lane). */
		readonly exclude?: readonly string[];
	},
): Promise<RebaseOutcome> => {
	const { mirror } = deps;
	for (const sha of [input.head, input.onto, ...(input.exclude ?? [])]) {
		if (!SHA_RE.test(sha)) throw invalid(`not a sha: ${sha}`);
	}
	const git = async (
		args: readonly string[],
		options: { stdin?: string; env?: Record<string, string> } = {},
		allow: readonly number[] = [0],
	): Promise<GitExecResult> => {
		const out = await deps.exec(["git", "-C", mirror, ...args], {
			uid: "tartan-git",
			...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
			...(options.env !== undefined ? { env: options.env } : {}),
		});
		if (!allow.includes(out.exitCode)) {
			throw unavailable(
				`git ${args[0]} failed (exit ${out.exitCode}): ${
					out.stderr.split("\n")[0]?.slice(0, 200) ?? ""
				}`,
			);
		}
		return out;
	};
	// Already on the new base: nothing to replay.
	const ancestor = await git(
		["merge-base", "--is-ancestor", input.onto, input.head],
		{},
		[0, 1],
	);
	if (ancestor.exitCode === 0) {
		return { ok: true, head: input.head, replayed: 0 };
	}
	const max = deps.max ?? REBASE_MAX_COMMITS;
	const listed = parseLines(
		(await git([
			"rev-list",
			"--no-merges",
			"--topo-order",
			`--max-count=${max + 1}`,
			input.head,
			`^${input.onto}`,
			...(input.exclude ?? []).map((sha) => `^${sha}`),
		])).stdout,
	);
	if (listed.length > max) {
		throw invalid(`the lane has more than ${max} commits to replay`);
	}
	const commits = [...listed].reverse();
	let tip = input.onto;
	for (const commit of commits) {
		const header = parseCommitObject(
			(await git(["cat-file", "commit", commit])).stdout,
		);
		const parent = header.parents[0];
		if (parent === undefined) {
			throw invalid(`a root commit in the lane: ${commit}`);
		}
		const replayed = await git(
			[
				"-c",
				"merge.conflictStyle=diff3",
				"merge-tree",
				"--write-tree",
				"--name-only",
				"--no-messages",
				`--merge-base=${parent}`,
				tip,
				commit,
			],
			{},
			[0, 1],
		);
		const merged = parseMergeTree(replayed.exitCode, replayed.stdout);
		if (!merged.clean) {
			const conflicts = [];
			for (const path of merged.paths.slice(0, 10)) {
				const out = await deps.exec(catBlobArgv(mirror, merged.tree, path), {
					uid: "tartan-git",
				});
				conflicts.push({
					path,
					regions: out.exitCode === 0 ? parseConflictRegions(out.stdout) : [],
				});
			}
			return { ok: false, at: commit, conflicts };
		}
		const created = await git(
			["commit-tree", merged.tree, "-p", tip, "-F", "-"],
			{
				stdin: header.message,
				env: {
					GIT_AUTHOR_NAME: clean(header.author.name),
					GIT_AUTHOR_EMAIL: clean(header.author.email),
					GIT_AUTHOR_DATE: header.authorDate,
					GIT_COMMITTER_NAME: clean(deps.committer.name),
					GIT_COMMITTER_EMAIL: clean(deps.committer.email),
					GIT_COMMITTER_DATE: `@${Math.floor(deps.date)} +0000`,
				},
			},
		);
		const sha = created.stdout.trim();
		if (!SHA_RE.test(sha)) throw unavailable("commit-tree printed no sha");
		tip = sha;
	}
	return { ok: true, head: tip, replayed: commits.length };
};
