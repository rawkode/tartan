// The repo a `tartan.work` installation serves (repo scope): its id comes
// from the installation's scope key (`repo:<id>`) or, failing that, from the
// call's context; its path (for `<repo>#<n>` refs and links) is read from
// the kernel on each use, so a moved repo yields current refs.

import {
	type ExtCtx,
	invalid,
	notFound,
	type WorkItem,
} from "@tartan/contract";
import {
	createStore,
	type ItemRow,
	parseWorkRef,
	toWorkItem,
} from "./store.ts";

export type RepoCtx = { readonly id: string; readonly path: string };

/** The repo id of this installation (`repo:<id>` scope key), else `hint`. */
export const repoIdOf = (x: Pick<ExtCtx, "install">, hint?: string): string => {
	const key = x.install.scopeKey;
	if (key.startsWith("repo:")) return key.slice("repo:".length);
	if (hint !== undefined && hint !== "") return hint;
	throw invalid("tartan.work runs per repo: no repo in this call");
};

export const repoOf = async (
	x: Pick<ExtCtx, "install" | "caps">,
	hint?: string,
): Promise<RepoCtx> => {
	const id = repoIdOf(x, hint);
	const info = await x.caps.repo.info({ id });
	return { id, path: info.path };
};

/** A `repo` argument (path or id) must name this installation's repo. */
export const requireSameRepo = (repo: RepoCtx, arg: string): void => {
	if (arg !== repo.path && arg !== repo.id) {
		throw notFound(`repo ${arg} is not served by this work@1 installation`);
	}
};

/** The item a ref names, in this repo, or `not_found`. */
export const itemOfRef = (
	x: Pick<ExtCtx, "sql">,
	repo: RepoCtx,
	ref: string,
): ItemRow => {
	const parsed = parseWorkRef(ref);
	if (parsed === null) throw invalid(`not a work ref: ${ref}`);
	if (parsed.repo !== repo.path) throw notFound(`work item ${ref}`);
	const row = createStore(x.sql).itemByNumber(parsed.n);
	if (row === null) throw notFound(`work item ${ref}`);
	return row;
};

/**
 * The item a slot entity names: `<n>`, `#<n>` or a full `<repo>#<n>` ref
 * (the SPA's `/-/work/<id>` route carries one path segment).
 */
export const itemOfEntityId = (
	x: Pick<ExtCtx, "sql">,
	repo: RepoCtx,
	id: string,
): ItemRow | null => {
	const bare = /^#?([1-9][0-9]{0,9})$/.exec(id);
	if (bare) return createStore(x.sql).itemByNumber(Number(bare[1]));
	const parsed = parseWorkRef(id);
	if (parsed === null || parsed.repo !== repo.path) return null;
	return createStore(x.sql).itemByNumber(parsed.n);
};

export const workItemOf = (
	x: Pick<ExtCtx, "sql">,
	repo: RepoCtx,
	row: ItemRow,
): WorkItem => toWorkItem(row, createStore(x.sql).claimsOf(row.id), repo.path);

/** An entity ref for a work item: the ref when it fits `EntityRef.id` (≤ 200), else the item id. */
export const workEntityId = (ref: string, itemId: string): string =>
	ref.length <= 200 ? ref : itemId;
