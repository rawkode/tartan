// The binding's read methods, reads by SHA (K15; smoke checks A1 and A4):
// - `log`/`readFile` resolve only a short branch name (`main` means
//   `refs/heads/main`) or a 40-hex SHA; `HEAD`, `refs/heads/*`, `heads/*`,
//   notes and hidden refs resolve to nothing (`[]` / null), never an error;
//   `log()` without a ref starts at the default branch;
// - `readCommit` drops extra commit headers and one trailing newline of the
//   message; `readBlob(<commit sha>)` is null;
// - `readTree`/`readCommit`/`readBlob` take a lowercase 40-hex object id
//   (`INVALID_INPUT` otherwise, as documented); a wrong object type is
//   `INTERNAL_ERROR` for trees and commits, as documented.

import { text } from "../bytes.ts";
import {
	MODE,
	parseCommit,
	parseTag,
	parseTree,
	SHA_RE,
} from "../git/objects.ts";
import { firstParentChain, lookupPath } from "../git/store.ts";
import { artifactsError } from "./errors.ts";
import type { RepoState } from "./state.ts";

const requireHash = (hash: unknown): string => {
	if (typeof hash !== "string" || !SHA_RE.test(hash)) {
		throw artifactsError("INVALID_INPUT", "Invalid object hash.");
	}
	return hash;
};

/** Peels tags to the commit they point at. */
const peelToCommit = (repo: RepoState, oid: string): string | null => {
	let current = oid;
	for (let i = 0; i < 8; i++) {
		const object = repo.store.get(current);
		if (!object) return null;
		if (object.type === "commit") return current;
		if (object.type !== "tag") return null;
		current = parseTag(object.data).object;
	}
	return null;
};

/**
 * What the binding resolves for a `ref` argument: a 40-hex SHA present in
 * the repo, or a short branch name. Everything else is null.
 */
export const resolveReadRef = (
	repo: RepoState,
	ref: string | undefined,
): string | null => {
	if (ref === undefined) {
		const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
		return tip === undefined ? null : peelToCommit(repo, tip);
	}
	if (SHA_RE.test(ref)) return peelToCommit(repo, ref);
	const tip = repo.refs.get(`refs/heads/${ref}`);
	return tip === undefined ? null : peelToCommit(repo, tip);
};

const TYPE_OF_MODE: Readonly<Record<string, ArtifactsTreeEntryType>> = {
	[MODE.tree]: "tree",
	[MODE.file]: "blob",
	[MODE.exec]: "exec",
	[MODE.symlink]: "symlink",
	[MODE.gitlink]: "gitlink",
};

export const commitMetadata = (
	repo: RepoState,
	oid: string,
): ArtifactsCommitMetadata | null => {
	const object = repo.store.get(oid);
	if (!object) return null;
	if (object.type !== "commit") {
		throw artifactsError("INTERNAL_ERROR");
	}
	const c = parseCommit(object.data);
	return {
		hash: oid,
		treeHash: c.tree,
		message: c.message.replace(/\n$/, ""),
		author: { name: c.author.name, email: c.author.email },
		committer: { name: c.committer.name, email: c.committer.email },
		parents: [...c.parents],
		authoredAt: c.author.at,
		committedAt: c.committer.at,
	};
};

export const readCommit = (
	repo: RepoState,
	hash: unknown,
): ArtifactsCommitMetadata | null => commitMetadata(repo, requireHash(hash));

export const readTree = (
	repo: RepoState,
	hash: unknown,
): ArtifactsTreeEntry[] | null => {
	const object = repo.store.get(requireHash(hash));
	if (!object) return null;
	if (object.type !== "tree") throw artifactsError("INTERNAL_ERROR");
	return parseTree(object.data).map((e) => ({
		name: e.name,
		mode: e.mode,
		hash: e.oid,
		type: TYPE_OF_MODE[e.mode] ?? "blob",
	}));
};

/** Bytes as an untyped Blob (readBlob) or with a browser-safe type (readFile). */
const toBlob = (data: Uint8Array, type = ""): Blob =>
	new Blob([data.slice()], { type });

const isUtf8Text = (data: Uint8Array): boolean => {
	if (data.includes(0)) return false;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(data);
		return true;
	} catch {
		return false;
	}
};

export const readBlob = (repo: RepoState, hash: unknown): Blob | null => {
	const object = repo.store.get(requireHash(hash));
	return object?.type === "blob" ? toBlob(object.data) : null;
};

export const readFile = (
	repo: RepoState,
	args: { ref?: unknown; path?: unknown } | undefined,
): Blob | null => {
	const ref = args?.ref;
	const path = args?.path;
	if (
		typeof ref !== "string" || ref === "" || typeof path !== "string" ||
		path === ""
	) {
		throw artifactsError("INVALID_INPUT", "ref and path are required.");
	}
	const commit = resolveReadRef(repo, ref);
	if (commit === null) return null;
	const c = parseCommit(repo.store.get(commit)!.data);
	const entry = lookupPath(repo.store, c.tree, path);
	if (!entry || entry.mode === MODE.tree || entry.mode === MODE.gitlink) {
		return null;
	}
	const blob = repo.store.get(entry.oid);
	if (!blob) return null;
	return toBlob(
		blob.data,
		isUtf8Text(blob.data)
			? "text/plain;charset=utf-8"
			: "application/octet-stream",
	);
};

export const LOG_DEFAULT_LIMIT = 50;
export const LOG_MAX_LIMIT = 1000;

export const log = (
	repo: RepoState,
	opts: { ref?: string; limit?: number; offset?: number } | undefined,
): ArtifactsCommitMetadata[] => {
	const from = resolveReadRef(repo, opts?.ref);
	if (from === null) return [];
	const limit = Math.min(
		Math.max(opts?.limit ?? LOG_DEFAULT_LIMIT, 0),
		LOG_MAX_LIMIT,
	);
	const offset = Math.max(opts?.offset ?? 0, 0);
	return firstParentChain(repo.store, from, offset + limit)
		.slice(offset)
		.map((oid) => commitMetadata(repo, oid)!);
};

/** Decoded text of a blob, for assertions. */
export const blobText = (blob: Blob | null): Promise<string | null> =>
	blob === null
		? Promise.resolve(null)
		: blob.arrayBuffer().then((b) => text(new Uint8Array(b)));
