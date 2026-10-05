// Pure path and slug rules of the hierarchy (WP3):
// slugs are `[a-z0-9][a-z0-9-]{0,63}`, root slugs share one space with the
// reserved words of the URL grammar, and a path is its ancestors' slugs
// joined by `/` (no depth limit beyond the URL length).

import {
	isReservedRootSlug,
	isValidSlug,
	NodePathSchema,
	pathPrefixes,
	tartanError,
} from "@tartan/contract";

/** The longest node path accepted (the 16 KB URL limit). */
export const MAX_NODE_PATH = 16_384;

/**
 * A slug for a node, or `invalid`. Root slugs must not be reserved words of
 * the URL grammar (`api`, `-`, `setup`, …).
 */
export const checkSlug = (
	slug: unknown,
	options: { readonly root: boolean },
): string => {
	if (typeof slug !== "string" || !isValidSlug(slug)) {
		throw tartanError(
			"invalid",
			"a slug is 1–64 lowercase letters, digits and dashes, starting with a letter or digit",
			{ reason: "slug" },
		);
	}
	if (options.root && isReservedRootSlug(slug)) {
		throw tartanError(
			"invalid",
			`${slug} is reserved and cannot name a root namespace`,
			{
				reason: "reserved-slug",
			},
		);
	}
	return slug;
};

export const childPath = (parentPath: string | null, slug: string): string =>
	parentPath === null ? slug : `${parentPath}/${slug}`;

/**
 * Splits a request path into its node part and the rest after the first
 * `/-/` (the GitLab-style separator), dropping a `.git` suffix on the node
 * part. Leading and trailing slashes are ignored.
 */
export const splitNodePath = (
	raw: string,
): { readonly nodePath: string; readonly rest: string } => {
	const trimmed = raw.replace(/^\/+/, "").replace(/\/+$/, "");
	const separator = trimmed === "-" || trimmed.startsWith("-/")
		? 0
		: trimmed.indexOf("/-/");
	const nodePart = separator < 0 ? trimmed : trimmed.slice(0, separator);
	const rest = separator < 0 ? "" : trimmed.slice(separator + 1);
	return { nodePath: nodePart.replace(/\.git$/, ""), rest };
};

/** True when `path` is a syntactically valid node path. */
export const isNodePath = (path: string): boolean =>
	path.length <= MAX_NODE_PATH && NodePathSchema.safeParse(path).success;

/** Ancestor-or-self paths of a node path, root first. */
export const ancestorPaths = (path: string): string[] => pathPrefixes(path);

/** `path` with its `from` prefix replaced by `to` (moves and redirects). */
export const rebase = (path: string, from: string, to: string): string =>
	path === from ? to : `${to}${path.slice(from.length)}`;
