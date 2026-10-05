// Route params ↔ node paths, refs and repo paths, plus link builders for the
// repo views. A ref is ONE path segment (encoded, so `lanes/ln_x` travels as
// `lanes%2Fln_x`); everything after it is the repo-relative path. Route params
// are hints: the kernel re-derives node, repo, ref and path.

import type { RouteLocationNormalizedLoaded } from "vue-router";

type Params = RouteLocationNormalizedLoaded["params"];

const list = (value: Params[string] | undefined): string[] =>
	value === undefined ? [] : Array.isArray(value) ? value : [value];

const one = (value: Params[string] | undefined): string =>
	Array.isArray(value) ? value.join("/") : value ?? "";

export const nodePathParam = (params: Params): string =>
	list(params["nodePath"]).join("/");

export const stringParam = (params: Params, name: string): string =>
	one(params[name]);

/** `:refPath*` → `{ref, path}`; an empty param means the default branch. */
export const refAndPath = (
	params: Params,
	defaultRef: string,
): { readonly ref: string; readonly path: string } => {
	const [ref, ...rest] = list(params["refPath"]);
	return { ref: ref && ref !== "" ? ref : defaultRef, path: rest.join("/") };
};

const encPath = (path: string): string =>
	path.split("/").filter((s) => s !== "").map(encodeURIComponent).join("/");

const join = (...parts: string[]): string =>
	parts.filter((p) => p !== "").join("/");

export const nodeHref = (nodePath: string): string => `/${encPath(nodePath)}`;

export const treeHref = (repo: string, ref: string, path = ""): string =>
	`/${
		join(encPath(repo), "-", "tree", encodeURIComponent(ref), encPath(path))
	}`;

export const blobHref = (repo: string, ref: string, path: string): string =>
	`/${
		join(encPath(repo), "-", "blob", encodeURIComponent(ref), encPath(path))
	}`;

/** Why for a file at a ref (`/-/blame/<ref>/<path>`, WhyBlameView). */
export const blameHref = (repo: string, ref: string, path: string): string =>
	`/${
		join(encPath(repo), "-", "blame", encodeURIComponent(ref), encPath(path))
	}`;

export const logHref = (repo: string, ref: string, path = ""): string =>
	`/${
		join(encPath(repo), "-", "commits", encodeURIComponent(ref), encPath(path))
	}`;

export const commitHref = (repo: string, sha: string): string =>
	`/${encPath(repo)}/-/commit/${encodeURIComponent(sha)}`;

export const compareHref = (repo: string, base: string, head: string): string =>
	`/${encPath(repo)}/-/compare/${encodeURIComponent(`${base}...${head}`)}`;

export const changeHref = (
	repo: string,
	changeId: string,
	tab?: string,
): string =>
	`/${encPath(repo)}/-/changes/${encodeURIComponent(changeId)}${
		tab ? `/${encodeURIComponent(tab)}` : ""
	}`;

export const settingsHref = (nodePath: string): string =>
	`/${encPath(nodePath)}/-/settings`;

/** Repository settings → Extensions: the repo's Tartan config (WP23). */
export const repoConfigHref = (repoPath: string): string =>
	`/${encPath(repoPath)}/-/settings/extensions`;

/** `base...head` or `base..head` → its parts (three dots preferred). */
export const parseRange = (
	range: string,
): { readonly base: string; readonly head: string } | null => {
	const three = range.indexOf("...");
	if (three > 0 && three + 3 < range.length) {
		return { base: range.slice(0, three), head: range.slice(three + 3) };
	}
	const two = range.indexOf("..");
	if (two > 0 && two + 2 < range.length) {
		return { base: range.slice(0, two), head: range.slice(two + 2) };
	}
	return null;
};

/** Breadcrumb segments of a repo-relative path. */
export const pathCrumbs = (
	path: string,
): readonly { readonly name: string; readonly path: string }[] => {
	const parts = path.split("/").filter((p) => p !== "");
	return parts.map((name, i) => ({
		name,
		path: parts.slice(0, i + 1).join("/"),
	}));
};
