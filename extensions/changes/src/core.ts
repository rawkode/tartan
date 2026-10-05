// Shared pieces of tartan.changes: the repo it serves, the `changes.*` emit
// helper, and a revision's derived data (affected projects and diffstat)
// read through `caps.repo` for the lane range (K17).

import { type Change, type ExtCtx, invalid, notFound } from "@tartan/contract";
import {
	type ChangeRow,
	createStore,
	type Diffstat,
	toChange,
} from "./store.ts";

export type RepoCtx = { readonly id: string; readonly path: string };

export const repoIdOf = (x: Pick<ExtCtx, "install">, hint?: string): string => {
	const key = x.install.scopeKey;
	if (key.startsWith("repo:")) return key.slice("repo:".length);
	if (hint !== undefined && hint !== "") return hint;
	throw invalid("tartan.changes runs per repo: no repo in this call");
};

export const repoOf = async (
	x: Pick<ExtCtx, "install" | "caps">,
	hint?: string,
): Promise<RepoCtx> => {
	const id = repoIdOf(x, hint);
	const info = await x.caps.repo.info({ id });
	return { id, path: info.path };
};

export const requireSameRepo = (repo: RepoCtx, arg: string | undefined) => {
	if (arg !== undefined && arg !== repo.path && arg !== repo.id) {
		throw notFound(`repo ${arg} is not served by this changes@1 installation`);
	}
};

export const changeOf = (x: Pick<ExtCtx, "sql">, id: string): ChangeRow => {
	const row = createStore(x.sql).change(id);
	if (row === null) throw notFound(`change ${id}`);
	return row;
};

export const changeDto = (
	x: Pick<ExtCtx, "sql">,
	repo: RepoCtx,
	row: ChangeRow,
): Change =>
	toChange(row, createStore(x.sql).revisions(row.change_id), repo.path);

/** Emits a `changes.*` event of this repo with the change as subject. */
export const emitChange = (
	x: ExtCtx,
	repo: RepoCtx,
	row: Pick<ChangeRow, "change_id" | "work_ref">,
	type: string,
	data: Record<string, unknown>,
	idemKey?: string,
): Promise<string> =>
	x.caps.events.emit(type, data, {
		repo: { id: repo.id },
		subject: { kind: "change", id: row.change_id },
		...(row.work_ref && `work:${row.work_ref}`.length <= 256
			? { correlation: `work:${row.work_ref}` }
			: {}),
		...(idemKey ? { idemKey } : {}),
	});

/**
 * Affected projects of `base..head` read in the lane's repo, with `*`
 * when a global file changed (the Weave partitions those alone).
 */
export const affectedOf = async (
	x: ExtCtx,
	repo: RepoCtx,
	laneId: string,
	base: string,
	head: string,
): Promise<string[]> => {
	try {
		const a = await x.caps.repo.affected({ id: repo.id }, base, head, {
			repoId: repo.id,
			laneId,
		});
		return [...a.projects, ...(a.global ? ["*"] : [])];
	} catch (error) {
		x.log.warn("affected failed; revision records none", {
			laneId,
			error: error instanceof Error ? error.message : String(error),
		});
		return [];
	}
};

/** Files, additions and deletions of `base..head` (best effort: files only on failure). */
export const diffstatOf = async (
	x: ExtCtx,
	repo: RepoCtx,
	laneId: string,
	base: string,
	head: string,
	paths?: number,
): Promise<Diffstat> => {
	try {
		const files = await x.caps.repo.diff(
			{ repoId: repo.id, sha: base },
			{ repoId: repo.id, laneId, sha: head },
		);
		return {
			files: files.length,
			additions: files.reduce((n, f) => n + f.additions, 0),
			deletions: files.reduce((n, f) => n + f.deletions, 0),
		};
	} catch (error) {
		x.log.warn("diff failed; diffstat counts files only", {
			laneId,
			error: error instanceof Error ? error.message : String(error),
		});
		return { files: paths ?? 0, additions: 0, deletions: 0 };
	}
};
