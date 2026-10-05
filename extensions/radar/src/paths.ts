// Path, prefix and project helpers (pure). Paths are repo-relative and never
// start with `/` (`RepoPathSchema`); a footprint prefix covers itself and
// everything below it, directory-wise (`services/api` covers
// `services/api/x.ts`, not `services/api2/x.ts`).

import { isWithinPath } from "@tartan/contract";

/** Removes leading `./`/`/` and trailing `/` from a footprint prefix. */
export const normalizePrefix = (prefix: string): string =>
	prefix.replace(/^(\.\/)+/, "").replace(/^\/+/, "").replace(/\/+$/, "");

/** True when one prefix lies under the other (or both are equal). */
export const prefixesOverlap = (a: string, b: string): boolean =>
	isWithinPath(a, b) || isWithinPath(b, a);

/** The more specific of two overlapping prefixes: their intersection. */
export const prefixIntersection = (a: string, b: string): string =>
	a.length >= b.length ? a : b;

/** Every ancestor directory of `path` and the path itself, shortest first. */
export const ancestorsOrSelf = (path: string): string[] => {
	const parts = path.split("/").filter((p) => p !== "");
	return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
};

/**
 * Bounds of the paths strictly under `prefix` for an index range scan:
 * `path > prefix + "/" AND path < prefix + "0"` ('0' sorts right after '/').
 */
export const underBounds = (prefix: string): [string, string] => [
	`${prefix}/`,
	`${prefix}0`,
];

/** The area key of a project-level overlap (conflict `path`). */
export const projectArea = (project: string): string => `project:${project}`;

export type ProjectRoot = { readonly name: string; readonly root: string };

/** Roots ordered for longest-root matching (deepest first; the repo root last). */
export const sortRoots = (roots: readonly ProjectRoot[]): ProjectRoot[] =>
	roots
		.map((r) => ({ name: r.name, root: normalizePrefix(r.root) }))
		.sort((a, b) =>
			b.root.length - a.root.length || (a.name < b.name ? -1 : 1)
		);

/** The project owning `path` by longest-root match, or null. */
export const projectOf = (
	roots: readonly ProjectRoot[],
	path: string,
): string | null => {
	for (const r of roots) {
		if (r.root === "" || r.root === "." || isWithinPath(r.root, path)) {
			return r.name;
		}
	}
	return null;
};

/** A deterministic 64-bit FNV-1a hash in hex (dedupe keys; not a security hash). */
export const fnv64 = (text: string): string => {
	let h1 = 0x811c9dc5;
	let h2 = 0xcbf29ce4;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
		h2 = Math.imul(h2 ^ c ^ (i & 0xff), 0x01000193) >>> 0;
	}
	return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
};
