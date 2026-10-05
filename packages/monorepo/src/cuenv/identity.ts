// Project identity in a cuenv graph (WP25 slice A′): three names, one job
// each. The **key** is the root (storage, installation targets, caching);
// the **name** is the graph's primary key everywhere today (`projects.name`,
// radar areas, Weave partitions, CI job ids, footprints), so it is made
// unique by construction; the **slug** is the URL segment.
//
// - Names: the first root in path order keeps the bare cuenv name; every
//   later root with the same name becomes `<name>@<slug(root)>` and keeps the
//   raw name in `cuenvName`; both carry a `duplicate-name` issue. Names are a
//   function of one tree, so unlike slugs they are NOT stable across commits
//   while a name is duplicated: a new root that sorts earlier takes the bare
//   name (the `duplicate-name` issue is the signal). Keeping the bare name
//   with the root that held it first needs the previous trunk graph (open).
// - Slugs: the name lowercased, every character outside `[a-z0-9.-]` → `-`,
//   leading and trailing `.`/`-` trimmed; when two different names give one
//   slug, **every** colliding root gets `-<hex of sha256(root)>`
//   (deterministic from the tree, so a new root never takes a bare slug from
//   an existing one).

import { sha256Hex } from "../hash.ts";
import { NAME_MAX } from "./limits.ts";
import type { ProjectIssue } from "./types.ts";

/** A URL slug for a name or path (`PROJECT_SLUG_RE`). */
export const slugOf = (text: string): string => {
	const slug = text.toLowerCase()
		.replace(/[^a-z0-9.-]/g, "-")
		.replace(/^[.-]+/, "")
		.slice(0, NAME_MAX)
		.replace(/[.-]+$/, "");
	return slug === "" ? "project" : slug;
};

export type IdentityInput = {
	readonly root: string;
	/** The cuenv name (or the fallback for an unresolved one). */
	readonly name: string;
};

export type Identity = {
	readonly root: string;
	/** Unique within the graph. */
	readonly name: string;
	/** The raw cuenv name, present only when `name` carries a suffix. */
	readonly cuenvName?: string;
	/** Unique within the graph. */
	readonly slug: string;
	readonly issues: readonly ProjectIssue[];
};

const byRoot = (a: { root: string }, b: { root: string }) =>
	a.root < b.root ? -1 : a.root > b.root ? 1 : 0;

/** Names and slugs for every root, unique by construction. Sorted by root. */
export const assignIdentities = async (
	inputs: readonly IdentityInput[],
): Promise<Identity[]> => {
	const sorted = [...inputs].sort(byRoot);
	const counts = new Map<string, number>();
	for (const p of sorted) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
	const taken = new Set<string>();
	const named = sorted.map((p) => {
		const issues: ProjectIssue[] = [];
		const duplicated = (counts.get(p.name) ?? 0) > 1;
		if (duplicated) {
			issues.push({
				code: "duplicate-name",
				path: p.root,
				message: `${counts.get(p.name)} projects are named "${p.name}"`,
			});
		}
		if (!taken.has(p.name)) {
			taken.add(p.name);
			return { root: p.root, name: p.name, issues };
		}
		let name = `${p.name}@${slugOf(p.root)}`;
		for (let k = 2; taken.has(name); k++) {
			name = `${p.name}@${slugOf(p.root)}-${k}`;
		}
		taken.add(name);
		return { root: p.root, name, cuenvName: p.name, issues };
	});
	const bases = named.map((p) => slugOf(p.name));
	const groups = new Map<string, number>();
	for (const base of bases) groups.set(base, (groups.get(base) ?? 0) + 1);
	const slugs = await Promise.all(named.map(async (p, i) => {
		const base = bases[i];
		if ((groups.get(base) ?? 0) === 1) return base;
		const hex = await sha256Hex(p.root);
		return { base, hex };
	}));
	// Colliding roots get the shortest hex suffix (≥ 4) that separates them.
	const used = new Set(slugs.filter((s): s is string => typeof s === "string"));
	const out: Identity[] = named.map((p, i) => {
		const s = slugs[i];
		if (typeof s === "string") {
			return { ...p, slug: s };
		}
		let slug = "";
		for (let len = 4; len <= 64; len += 4) {
			slug = `${s.base.slice(0, NAME_MAX - 1 - len)}-${s.hex.slice(0, len)}`;
			if (!used.has(slug)) break;
		}
		used.add(slug);
		return {
			...p,
			slug,
			issues: [...p.issues, {
				code: "slug-collision",
				path: p.root,
				message: `the slug "${s.base}" is shared by several projects`,
			}],
		};
	});
	return out;
};
