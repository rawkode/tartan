// The Advance's git work over a `GitExec`:
// the warm `git:<repoId>` sandbox in production (`TartanSandbox.gitExec`,
// serialized per sandbox), a local git in tests. One instance per step;
// nothing here holds a token beyond the call that uses it.
//
// - Content-parsing execs (fetch, merge-tree, cat-file, commit-tree, notes)
//   run as `tartan-git` with at most a read token; a push runs as
//   `tartan-push` with a write token scoped to the one repo it writes (the
//   sandbox kills every `tartan-git` process first).
// - Tokens reach git only as `GIT_CONFIG_*` `http.<remote>.extraHeader` in
//   one exec's environment (`gitAuthEnv`), never in argv, files or output.

import { invalid, isPolicyPath, unavailable, ZERO_SHA } from "@tartan/contract";
import type { ConflictRegion } from "@tartan/contract";
import type { GitExecOptions, GitExecResult } from "@tartan/contract/kernel.ts";
import { policyDigestOf } from "../repoconfig/key.ts";
import { gitAuthEnv } from "../runs/shell.ts";
import {
	catBlobArgv,
	commitTreeArgv,
	diffPathsArgv,
	fetchArgv,
	type FetchSpec,
	forEachRefArgv,
	type GitIdentity,
	hasCommitArgv,
	identityEnv,
	initMirrorArgv,
	lsTreeRootArgv,
	mergeTreeArgv,
	type MergeTreeResult,
	mirrorPath,
	notesAddArgv,
	notesShowArgv,
	parseConflictRegions,
	parseLines,
	parseLsTree,
	parseMergeTree,
	parseNulList,
	parsePushPorcelain,
	pushArgv,
	type PushRefOutcome,
	type PushSpec,
	revListArgv,
	revParseArgv,
	SHA_RE,
	updateRefArgv,
	updateRefStdinArgv,
} from "./gitcmd.ts";

export type GitRunner = (
	argv: readonly string[],
	options?: GitExecOptions,
) => Promise<GitExecResult>;

/** Where the warm mirrors live in the runner image (group `tartan`, mode 2775). */
export const SANDBOX_MIRROR_ROOT = "/srv/mirror";
/** At most this many conflicted files get regions per change. */
export const REGION_FILES_MAX = 10;
/** One git command never runs longer than this. */
export const GIT_EXEC_TIMEOUT_MS = 120_000;

export type Credential = { readonly remote: string; readonly token: string };

export type LandGit = {
	readonly mirror: string;
	ensureMirror(): Promise<void>;
	fetch(cred: Credential, specs: readonly FetchSpec[]): Promise<void>;
	has(sha: string): Promise<boolean>;
	mergeTree(ours: string, theirs: string): Promise<MergeTreeResult>;
	conflictRegions(
		tree: string,
		paths: readonly string[],
	): Promise<{ path: string; regions: ConflictRegion[] }[]>;
	commitTree(input: {
		readonly tree: string;
		readonly parent: string;
		readonly message: string;
		readonly author: GitIdentity;
		readonly committer: GitIdentity;
		readonly date: number;
	}): Promise<string>;
	diffPaths(parent: string, commit: string): Promise<string[]>;
	/**
	 * The root `*.cue` digest of `commit` (`ls-tree` of its root; null when
	 * it has no root `*.cue` entry): the candidate's policy digest for K13.2
	 * (ADR repo config), compared with the one its sign-off names.
	 */
	policyDigest?(commit: string): Promise<string | null>;
	revList(head: string, exclude: string, max: number): Promise<string[]>;
	/**
	 * Builds `notesRef` on top of `base` (zeros: a first notes commit) with
	 * one note per commit; returns the new notes tip.
	 */
	/** Whether `notesRef` holds a note for `commit`. */
	hasNote(notesRef: string, commit: string): Promise<boolean>;
	buildNotes(input: {
		readonly notesRef: string;
		readonly base: string;
		readonly notes: readonly {
			readonly commit: string;
			readonly text: string;
		}[];
		readonly identity: GitIdentity;
		readonly date: number;
	}): Promise<string>;
	push(
		cred: Credential,
		specs: readonly PushSpec[],
		options?: { readonly atomic?: boolean },
	): Promise<{ readonly exitCode: number; readonly refs: PushRefOutcome[] }>;
	/** Deletes the work refs under `prefix` (best effort). */
	cleanup(prefix: string): Promise<void>;
};

const firstLine = (text: string): string =>
	text.split("\n").map((l) => l.trim()).find((l) => l.length > 0)?.slice(
		0,
		300,
	) ?? "";

export const createLandGit = (deps: {
	readonly exec: GitRunner;
	readonly repoId: string;
	readonly mirrorRoot?: string;
}): LandGit => {
	const mirror = mirrorPath(
		deps.mirrorRoot ?? SANDBOX_MIRROR_ROOT,
		deps.repoId,
	);

	const run = async (
		argv: readonly string[],
		options: GitExecOptions = {},
		allow: readonly number[] = [0],
	): Promise<GitExecResult> => {
		const result = await deps.exec(argv, {
			timeoutMs: GIT_EXEC_TIMEOUT_MS,
			...options,
		});
		if (!allow.includes(result.exitCode)) {
			const sub = argv.find((a, i) =>
				i > 0 && !a.startsWith("-") && argv[i - 1] !== "-C" &&
				argv[i - 1] !== "-c"
			) ?? "git";
			throw unavailable(
				`git ${sub} failed (exit ${result.exitCode}): ${
					firstLine(result.stderr) || firstLine(result.stdout)
				}`,
				{ exitCode: result.exitCode },
			);
		}
		return result;
	};

	const ensureMirror = async (): Promise<void> => {
		await run(initMirrorArgv(mirror));
	};

	const fetch = async (
		cred: Credential,
		specs: readonly FetchSpec[],
	): Promise<void> => {
		if (specs.length === 0) return;
		await run(fetchArgv(mirror, cred.remote, specs), {
			env: gitAuthEnv([cred]),
			uid: "tartan-git",
		});
	};

	const has = async (sha: string): Promise<boolean> => {
		if (!SHA_RE.test(sha)) throw invalid(`not a sha: ${sha}`);
		const out = await run(hasCommitArgv(mirror, sha), {}, [0, 1, 128]);
		return out.exitCode === 0;
	};

	const mergeTree = async (
		ours: string,
		theirs: string,
	): Promise<MergeTreeResult> => {
		const out = await run(mergeTreeArgv(mirror, ours, theirs), {}, [0, 1]);
		return parseMergeTree(out.exitCode, out.stdout);
	};

	const conflictRegions = async (tree: string, paths: readonly string[]) => {
		const found: { path: string; regions: ConflictRegion[] }[] = [];
		for (const path of paths.slice(0, REGION_FILES_MAX)) {
			const out = await run(catBlobArgv(mirror, tree, path), {}, [0, 128]);
			if (out.exitCode !== 0) {
				found.push({ path, regions: [] });
				continue;
			}
			found.push({ path, regions: parseConflictRegions(out.stdout) });
		}
		return found;
	};

	const commitTree: LandGit["commitTree"] = async (input) => {
		const out = await run(
			commitTreeArgv(mirror, input.tree, input.parent),
			{
				env: identityEnv(input.author, input.committer, input.date),
				stdin: input.message,
			},
		);
		const sha = out.stdout.trim();
		if (!SHA_RE.test(sha)) throw unavailable("commit-tree printed no sha");
		return sha;
	};

	const diffPaths = async (parent: string, commit: string) =>
		parseNulList((await run(diffPathsArgv(mirror, parent, commit))).stdout);

	const policyDigest = async (commit: string) => {
		if (!SHA_RE.test(commit)) throw invalid(`not a sha: ${commit}`);
		const out = await run(lsTreeRootArgv(mirror, commit));
		return policyDigestOf(
			parseLsTree(out.stdout)
				.filter((e) => isPolicyPath(e.name))
				.map((e) => ({ name: e.name, mode: e.mode, oid: e.oid })),
		);
	};

	const revList = async (head: string, exclude: string, max: number) =>
		parseLines((await run(revListArgv(mirror, head, exclude, max))).stdout);

	const hasNote = async (notesRef: string, commit: string) =>
		(await run(notesShowArgv(mirror, notesRef, commit), {}, [0, 1, 128]))
			.exitCode === 0;

	const buildNotes: LandGit["buildNotes"] = async (input) => {
		if (!input.notesRef.startsWith("refs/notes/")) {
			throw invalid("a notes ref lives under refs/notes/");
		}
		await run(updateRefArgv(mirror, input.notesRef, input.base), {}, [0, 1]);
		const env = identityEnv(input.identity, input.identity, input.date);
		for (const note of input.notes) {
			await run(notesAddArgv(mirror, input.notesRef, note.commit), {
				env,
				stdin: note.text,
			});
		}
		const tip = (await run(revParseArgv(mirror, input.notesRef), {}, [0, 1]))
			.stdout.trim();
		if (!SHA_RE.test(tip)) {
			if (input.notes.length === 0 && input.base === ZERO_SHA) return ZERO_SHA;
			throw unavailable("the notes ref has no tip");
		}
		return tip;
	};

	const push: LandGit["push"] = async (cred, specs, options = {}) => {
		const out = await run(
			pushArgv(mirror, cred.remote, specs, options),
			{ env: gitAuthEnv([cred]), uid: "tartan-push" },
			[0, 1],
		);
		const refs = parsePushPorcelain(out.stdout);
		if (out.exitCode !== 0 && refs.length === 0) {
			throw unavailable(
				`git push failed: ${firstLine(out.stderr) || "no status"}`,
			);
		}
		return { exitCode: out.exitCode, refs };
	};

	const cleanup = async (prefix: string): Promise<void> => {
		const listed = await run(forEachRefArgv(mirror, prefix), {}, [0, 128]);
		const refs = parseLines(listed.stdout);
		if (refs.length === 0) return;
		await run(updateRefStdinArgv(mirror), {
			stdin: refs.map((r) => `delete ${r}\n`).join(""),
		}, [0, 128]);
	};

	return {
		mirror,
		ensureMirror,
		fetch,
		has,
		mergeTree,
		conflictRegions,
		commitTree,
		diffPaths,
		policyDigest,
		revList,
		hasNote,
		buildNotes,
		push,
		cleanup,
	};
};
