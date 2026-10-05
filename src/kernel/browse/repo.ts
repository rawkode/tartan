// The repo browse API (WP3): `GET /-/api/{tree,blob,log,commit,compare}` with
// query `repo` (the node path) and `ref`/`path`/`cursor`/`sha`/`base`/`head`.
// Each request resolves its refs to SHAs through RepoDO (in the public view,
// only visible refs and the commits reachable from them), reads the canonical
// repo by SHA, and reaches blobs only by walking trees from a commit (no read
// by a caller-named blob hash). Diffs come from RepoProbe (WP8); `commit` and
// `compare` take `patch=1` for each file's unified patch (within
// `PATCH_LIMITS`, else `patchOmitted` says why).

import {
	type BlobResponse,
	type CommitResponse,
	type CompareResponse,
	type FileDiff,
	invalid,
	type LogResponse,
	NOTES_REF,
	notFound,
	repoArtifactsName,
	type TreeResponse,
	type WhyNote,
	WhyNoteSchema,
} from "@tartan/contract";
import type {
	AuthContext,
	RepoStoreCommit,
	ResolvedSha,
} from "@tartan/contract/kernel.ts";
import type { RouteContext, RouteHandler } from "../../router.ts";
import {
	createResolver,
	type RepoView,
	repoView,
	type Resolver,
} from "./access.ts";
import { type BrowseDeps, browseDepsOf } from "./deps.ts";
import { failure, json, movedParam, optionalParam, param } from "./http.ts";
import {
	commitMeta,
	hashAt,
	isText,
	openReads,
	pathSegments,
	type RepoReads,
	treeEntries,
	walk,
} from "./reader.ts";

/** Blob bytes inlined as `text` in a `BlobResponse`. */
export const BLOB_INLINE_MAX = 1024 * 1024;
export const LOG_PAGE = 50;
/** Commits a path-filtered log page inspects before it answers with a cursor. */
export const LOG_PATH_SCAN_MAX = 300;
export const COMPARE_COMMITS_MAX = 250;
/** Files a root commit lists (no parent to diff against). */
export const ROOT_FILES_MAX = 1000;
const CURSOR_MAX = 1_000_000;

export type BrowseDepsFor = (c: RouteContext) => BrowseDeps;
const defaultDeps: BrowseDepsFor = (c) => browseDepsOf(c.env, c.ctx);

type Session = {
	readonly view: RepoView;
	readonly reads: RepoReads;
	readonly resolver: Resolver;
	readonly deps: BrowseDeps;
	readonly url: URL;
	readonly auth: AuthContext | null;
};

/** Runs `answer` for a readable repo; a moved repo path answers 301. */
const withRepo = (
	depsFor: BrowseDepsFor,
	answer: (s: Session) => Promise<Response>,
): RouteHandler =>
async (c) => {
	try {
		const deps = depsFor(c);
		const view = await repoView(deps, c.auth, param(c.url, "repo"));
		if ("moved" in view) return movedParam(c.url, "repo", view.moved);
		const reads = await openReads(
			deps.artifacts,
			repoArtifactsName(view.node.id),
		);
		try {
			return await answer({
				view,
				reads,
				resolver: createResolver(view, reads),
				deps,
				url: c.url,
				auth: c.auth,
			});
		} finally {
			reads.close();
		}
	} catch (error) {
		return failure(error);
	}
};

const commitOf = async (
	reads: RepoReads,
	sha: ResolvedSha,
): Promise<RepoStoreCommit> => {
	const commit = await reads.commit(sha);
	if (commit === null) throw notFound(`no commit ${sha}`);
	return commit;
};

const encodeSegments = (path: string): string =>
	path.split("/").map(encodeURIComponent).join("/");

/** `/<repoPath>/-/raw/<ref>/<file>` (served with `CSP: sandbox`). */
export const rawUrl = (repoPath: string, ref: string, file: string): string =>
	`/${repoPath}/-/raw/${encodeSegments(ref)}/${encodeSegments(file)}`;

/** `patch=1` (or `true`): diffs carry each file's unified patch. */
export const wantsPatch = (url: URL): boolean => {
	const raw = optionalParam(url, "patch", 8);
	if (raw === undefined || raw === "0" || raw === "false") return false;
	if (raw === "1" || raw === "true") return true;
	throw invalid("patch is 1 or 0");
};

const cursorOf = (url: URL): number => {
	const raw = optionalParam(url, "cursor", 16);
	if (raw === undefined) return 0;
	const n = Number(raw);
	if (!Number.isSafeInteger(n) || n < 0 || n > CURSOR_MAX) {
		throw invalid("cursor is a non-negative integer");
	}
	return n;
};

// ---------------------------------------------------------------------------
// tree, blob
// ---------------------------------------------------------------------------

export const createTreeHandler = (depsFor = defaultDeps): RouteHandler =>
	withRepo(depsFor, async ({ view, reads, resolver, url }) => {
		const ref = optionalParam(url, "ref", 1024) ?? resolver.defaultRef;
		const segments = pathSegments(optionalParam(url, "path", 4096) ?? "");
		const sha = await resolver.commit(ref);
		const commit = await commitOf(reads, sha);
		const walked = await walk(
			reads,
			commit.treeHash as ResolvedSha,
			segments,
		);
		if (walked === null || walked.kind !== "tree") {
			throw notFound(`no directory ${segments.join("/") || "/"} at ${ref}`);
		}
		return json(
			{
				repo: view.node.path,
				ref,
				sha,
				path: segments.join("/"),
				entries: treeEntries(segments, walked.entries),
			} satisfies TreeResponse,
		);
	});

export const createBlobHandler = (depsFor = defaultDeps): RouteHandler =>
	withRepo(depsFor, async ({ view, reads, resolver, url }) => {
		const ref = optionalParam(url, "ref", 1024) ?? resolver.defaultRef;
		const segments = pathSegments(param(url, "path", 4096));
		if (segments.length === 0) throw invalid("path names a file");
		const sha = await resolver.commit(ref);
		const commit = await commitOf(reads, sha);
		const walked = await walk(
			reads,
			commit.treeHash as ResolvedSha,
			segments,
		);
		if (walked === null || walked.kind !== "blob") {
			throw notFound(`no file ${segments.join("/")} at ${ref}`);
		}
		const blob = await reads.blob(walked.sha);
		if (blob === null) throw notFound(`blob ${walked.sha} is not readable`);
		const size = blob.size;
		const truncated = size > BLOB_INLINE_MAX;
		const bytes = new Uint8Array(
			await (truncated ? blob.slice(0, 8000) : blob).arrayBuffer(),
		);
		const binary = truncated ? bytes.includes(0) : !isText(bytes);
		const path = segments.join("/");
		return json(
			{
				repo: view.node.path,
				ref,
				sha,
				path,
				blob: walked.sha,
				size,
				binary,
				...(!binary && !truncated
					? { text: new TextDecoder().decode(bytes) }
					: {}),
				truncated,
				rawUrl: rawUrl(view.node.path, ref, path),
			} satisfies BlobResponse,
		);
	});

// ---------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------

/** One page of commits touching `segments` (the object at the path differs from the first parent's). */
const pathLog = async (
	reads: RepoReads,
	tip: ResolvedSha,
	segments: readonly string[],
	offset: number,
): Promise<{ commits: RepoStoreCommit[]; next?: number }> => {
	const out: RepoStoreCommit[] = [];
	let at = offset;
	let scanned = 0;
	while (out.length < LOG_PAGE && scanned < LOG_PATH_SCAN_MAX) {
		const batch = await reads.log(tip, { limit: 101, offset: at });
		if (batch.length === 0) return { commits: out };
		const usable = Math.min(batch.length, 100, LOG_PATH_SCAN_MAX - scanned);
		for (let i = 0; i < usable; i++) {
			const commit = batch[i];
			scanned++;
			at++;
			const parent = commit.parents[0];
			const parentTree = parent === undefined
				? null
				: batch[i + 1]?.hash === parent
				? batch[i + 1].treeHash
				: (await reads.commit(parent as ResolvedSha))?.treeHash ?? null;
			const here = await hashAt(
				reads,
				commit.treeHash as ResolvedSha,
				segments,
			);
			const before = parentTree === null
				? null
				: await hashAt(reads, parentTree as ResolvedSha, segments);
			if (here !== before) {
				out.push(commit);
				if (out.length === LOG_PAGE) {
					return i + 1 < batch.length ? { commits: out, next: at } : {
						commits: out,
					};
				}
			}
		}
		if (batch.length <= usable) return { commits: out };
	}
	return { commits: out, next: at };
};

export const createLogHandler = (depsFor = defaultDeps): RouteHandler =>
	withRepo(depsFor, async ({ view, reads, resolver, url }) => {
		const ref = optionalParam(url, "ref", 1024) ?? resolver.defaultRef;
		const path = optionalParam(url, "path", 4096);
		const offset = cursorOf(url);
		const sha = await resolver.commit(ref);
		let commits: RepoStoreCommit[];
		let next: number | undefined;
		if (path === undefined || pathSegments(path).length === 0) {
			const page = await reads.log(sha, { limit: LOG_PAGE + 1, offset });
			commits = page.slice(0, LOG_PAGE);
			next = page.length > LOG_PAGE ? offset + LOG_PAGE : undefined;
		} else {
			({ commits, next } = await pathLog(
				reads,
				sha,
				pathSegments(path),
				offset,
			));
		}
		return json(
			{
				repo: view.node.path,
				ref,
				commits: commits.map(commitMeta),
				...(next !== undefined ? { cursor: String(next) } : {}),
			} satisfies LogResponse,
		);
	});

// ---------------------------------------------------------------------------
// commit, compare
// ---------------------------------------------------------------------------

/**
 * Every file of a root commit as `added` (bounded; no parent to diff), path
 * level: with `patch` asked for, each says so (`patchOmitted`).
 */
const rootFiles = async (
	reads: RepoReads,
	tree: ResolvedSha,
	patch: boolean,
): Promise<FileDiff[]> => {
	const out: FileDiff[] = [];
	const queue: { sha: ResolvedSha; prefix: string }[] = [{
		sha: tree,
		prefix: "",
	}];
	while (queue.length > 0 && out.length < ROOT_FILES_MAX) {
		const next = queue.shift()!;
		const entries = await reads.tree(next.sha) ?? [];
		for (const e of entries) {
			const path = `${next.prefix}${e.name}`;
			if (e.type === "tree") {
				queue.push({ sha: e.hash as ResolvedSha, prefix: `${path}/` });
			} else if (out.length < ROOT_FILES_MAX) {
				out.push({
					path,
					change: "added",
					binary: false,
					additions: 0,
					deletions: 0,
					hunks: [],
					...(patch ? { patchOmitted: "path-level" as const } : {}),
				});
			}
		}
	}
	return out;
};

/** The why note of a landed commit (`refs/notes/tartan`, read by SHA; fan-out path second). */
const whyNote = async (
	view: RepoView,
	reads: RepoReads,
	sha: string,
): Promise<WhyNote | undefined> => {
	const notes = await view.repo.resolveRef(NOTES_REF);
	if (notes === null) return undefined;
	for (const path of [sha, `${sha.slice(0, 2)}/${sha.slice(2)}`]) {
		const blob = await reads.file(notes as ResolvedSha, path).catch(() => null);
		if (blob === null) continue;
		try {
			const parsed = WhyNoteSchema.safeParse(JSON.parse(await blob.text()));
			return parsed.success ? parsed.data : undefined;
		} catch {
			return undefined;
		}
	}
	return undefined;
};

export const createCommitHandler = (depsFor = defaultDeps): RouteHandler =>
	withRepo(depsFor, async ({ view, reads, resolver, url, deps }) => {
		const sha = await resolver.commit(param(url, "sha", 1024));
		const patch = wantsPatch(url);
		const commit = await commitOf(reads, sha);
		const parent = commit.parents[0];
		const [files, note] = await Promise.all([
			parent === undefined
				? rootFiles(reads, commit.treeHash as ResolvedSha, patch)
				: deps.probe().diff(
					{ repoId: view.node.id, sha: parent },
					{ repoId: view.node.id, sha },
					{ patch },
				),
			whyNote(view, reads, sha),
		]);
		return json(
			{
				repo: view.node.path,
				commit: commitMeta(commit),
				files: [...files],
				...(note !== undefined ? { note } : {}),
			} satisfies CommitResponse,
		);
	});

export const createCompareHandler = (depsFor = defaultDeps): RouteHandler =>
	withRepo(depsFor, async ({ view, reads, resolver, url, deps }) => {
		const base = param(url, "base", 1024);
		const head = param(url, "head", 1024);
		const patch = wantsPatch(url);
		const [baseSha, headSha] = await Promise.all([
			resolver.commit(base),
			resolver.commit(head),
		]);
		if (baseSha === headSha) {
			return json(
				{
					repo: view.node.path,
					base,
					head,
					mergeBase: baseSha,
					commits: [],
					files: [],
					truncated: false,
				} satisfies CompareResponse,
			);
		}
		const [baseChain, headChain] = await Promise.all([
			reads.log(baseSha, { limit: 1000 }),
			reads.log(headSha, { limit: COMPARE_COMMITS_MAX + 1 }),
		]);
		const onBase = new Set(baseChain.map((c) => c.hash));
		const commits: RepoStoreCommit[] = [];
		let mergeBase: string | undefined;
		for (const commit of headChain) {
			if (onBase.has(commit.hash)) {
				mergeBase = commit.hash;
				break;
			}
			commits.push(commit);
		}
		// Without a merge base in reach, the walk stopped at a bound (or the
		// histories are unrelated: both chains read to their roots).
		const truncated = mergeBase === undefined &&
			(headChain.length > COMPARE_COMMITS_MAX || baseChain.length >= 1000);
		const files = await deps.probe().diff(
			{ repoId: view.node.id, sha: mergeBase ?? baseSha },
			{ repoId: view.node.id, sha: headSha },
			{ patch },
		);
		return json(
			{
				repo: view.node.path,
				base,
				head,
				...(mergeBase !== undefined ? { mergeBase } : {}),
				commits: commits.slice(0, COMPARE_COMMITS_MAX).map(commitMeta),
				files: [...files],
				truncated,
			} satisfies CompareResponse,
		);
	});
