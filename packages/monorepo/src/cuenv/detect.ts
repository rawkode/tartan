// The Tier 0 cuenv detector (WP25 slice A′): re-implements cuenv's
// project-discovery behaviour; no cuenv code or text is copied. A
// structural walk over
// the committed tree (K15: every read by SHA through the caller's view):
//
// 1. Module root: `cue.mod/module.cue` must be a blob at the repo root, or
//    the detector contributes nothing.
// 2. Walk: breadth-first; names starting with `.` or `_`, `node_modules`,
//    `testdata`, `vendor`, `target` and `dist` are skipped; a directory
//    holding `cue.mod/` is a nested module, skipped and listed in `skipped`.
//    `MAX_WALK_DEPTH`/`MAX_WALK_DIRS` truncate (`truncated`: every path is
//    then global, the safe side).
// 3. Candidates: a regular `env.cue` blob of at most 64 KiB whose first
//    meaningful line is `package cuenv`.
// 4. Kind: a top-level `#Project` embedding is a project, `#Base` alone a
//    layer, neither unknown (a warning).
// 5. Name: the first literal `name: "…"` at depth 0 or inside the
//    `#Project & {…}` block; otherwise the directory's slug, `unresolved`.
// 6. Layers: the `#Base` directories above each project, root first; each
//    layer lists the `.cue` paths under it outside every project root.
// 7. Nesting: a project under a project keeps both (longest root wins).
// 8. A root `env.cue` with `#Project` names the repo (`rootProject`), no row.
// 9. At most `MAX_CUENV_PROJECTS` projects, by path order.
// 10. Package clauses of every `.cue` blob outside nested modules.
//
// The graph key records only fact files `(path, mode, oid)`, nested module
// roots and the walk bound, never raw directory listings, so two trees with
// the same facts give the same graph.

import type { RawTreeEntry } from "../objects.ts";
import { createLimiter } from "../objects.ts";
import { basename, dirname, isUnder } from "../glob.ts";
import { isCuenvClause, packageClause } from "./clause.ts";
import { assignIdentities, slugOf } from "./identity.ts";
import {
	ENV_CUE_MAX_BYTES,
	isSkippedDirName,
	MAX_CUENV_PROJECTS,
	MAX_PACKAGE_CLAUSES,
	MAX_WALK_DEPTH,
	MAX_WALK_DIRS,
	MAX_WARNINGS,
	NAME_MAX,
	WALK_CONCURRENCY,
} from "./limits.ts";
import { classifyEnvCue, type EnvCueFacts } from "./scan.ts";
import type { NameSource, ProjectIssue, ProjectLayer } from "./types.ts";

/** What the detector reads, and where it records the facts behind the graph key. */
export type CuenvReads = {
	/** Entries of a directory ("" = the root); null when absent. */
	dir(path: string): Promise<readonly RawTreeEntry[] | null>;
	/** A blob's text by path; null when absent or too large to be a manifest. */
	text(path: string): Promise<string | null>;
	/** One fact of the graph key. */
	fact(key: string, value: string): void;
};

export type CuenvProjectDraft = {
	/** Unique within the graph. */
	readonly name: string;
	readonly root: string;
	readonly cuenvName?: string;
	readonly slug: string;
	readonly nameSource: Extract<NameSource, "literal" | "unresolved">;
	readonly layers: readonly string[];
	readonly issues: readonly ProjectIssue[];
	readonly manifestPath: string;
};

export type CuenvDetection = {
	readonly projects: readonly CuenvProjectDraft[];
	readonly layers: readonly ProjectLayer[];
	readonly skipped: readonly string[];
	readonly warnings: readonly ProjectIssue[];
	readonly truncated: boolean;
	readonly packages: Readonly<Record<string, string | null>>;
	readonly rootProject?: { readonly name: string };
};

export const MODULE_FILE = "cue.mod/module.cue";

const isRegular = (e: RawTreeEntry): boolean =>
	e.type === "blob" || e.type === "exec";

const join = (dir: string, name: string): string =>
	dir === "" ? name : `${dir}/${name}`;

const byteLength = (text: string): number =>
	new TextEncoder().encode(text).length;

type CueFile = { readonly path: string; readonly entry: RawTreeEntry };

type Walk = {
	readonly files: readonly CueFile[];
	readonly nested: readonly string[];
	readonly bound: "none" | "depth" | "dirs";
};

type Limit = ReturnType<typeof createLimiter>;

/** The child directories a listing schedules (none for a nested module). */
const childDirs = (
	dir: string,
	entries: readonly RawTreeEntry[],
): string[] | null => {
	if (
		dir !== "" &&
		entries.some((e) => e.name === "cue.mod" && e.type === "tree")
	) {
		return null;
	}
	return entries
		.filter((e) =>
			e.type === "tree" && !isSkippedDirName(e.name) &&
			!(dir === "" && e.name === "cue.mod")
		)
		.map((e) => join(dir, e.name));
};

/**
 * The walk, pipelined: every listing schedules its children at once, so
 * `WALK_CONCURRENCY` reads stay in flight across levels, and each `.cue`
 * file is handed to `found` as soon as its directory is listed. When the
 * tree holds more than `MAX_WALK_DIRS` directories the strict level-order
 * walk decides which ones count (its listings are memoised by the view), so
 * the result never depends on read timing.
 */
const walk = async (
	reads: CuenvReads,
	limit: Limit,
	found: (file: CueFile) => void,
): Promise<Walk> => {
	const listings = new Map<string, readonly RawTreeEntry[]>();
	let scheduled = 1;
	let overflow = false;
	let deep = false;
	const visit = async (dir: string, depth: number): Promise<void> => {
		const entries = (await limit(() => reads.dir(dir))) ?? [];
		listings.set(dir, entries);
		const children = childDirs(dir, entries);
		if (children === null) return;
		for (const e of entries) {
			if (e.type !== "tree" && e.name.endsWith(".cue")) {
				found({ path: join(dir, e.name), entry: e });
			}
		}
		const next: Promise<void>[] = [];
		for (const child of children) {
			if (depth + 1 > MAX_WALK_DEPTH) {
				deep = true;
				continue;
			}
			if (scheduled >= MAX_WALK_DIRS) {
				overflow = true;
				continue;
			}
			scheduled++;
			next.push(visit(child, depth + 1));
		}
		await Promise.all(next);
	};
	await visit("", 0);
	if (overflow) return await levelWalk(reads, limit);
	const files: CueFile[] = [];
	const nested: string[] = [];
	for (const [dir, entries] of listings) {
		if (childDirs(dir, entries) === null) {
			nested.push(dir);
			continue;
		}
		for (const e of entries) {
			if (e.type !== "tree" && e.name.endsWith(".cue")) {
				files.push({ path: join(dir, e.name), entry: e });
			}
		}
	}
	files.sort((a, b) => a.path < b.path ? -1 : 1);
	return { files, nested: nested.sort(), bound: deep ? "depth" : "none" };
};

/** The strict breadth-first walk (deterministic under `MAX_WALK_DIRS`). */
const levelWalk = async (reads: CuenvReads, limit: Limit): Promise<Walk> => {
	const files: CueFile[] = [];
	const nested: string[] = [];
	let bound: Walk["bound"] = "none";
	let level = [""];
	let listed = 0;
	for (let depth = 0; level.length > 0; depth++) {
		if (depth > MAX_WALK_DEPTH) {
			bound = "depth";
			break;
		}
		if (listed + level.length > MAX_WALK_DIRS) {
			bound = "dirs";
			level = level.slice(0, MAX_WALK_DIRS - listed);
		}
		listed += level.length;
		const listings = await Promise.all(
			level.map((dir) => limit(() => reads.dir(dir))),
		);
		const next: string[] = [];
		level.forEach((dir, i) => {
			const entries = listings[i] ?? [];
			if (
				dir !== "" &&
				entries.some((e) => e.name === "cue.mod" && e.type === "tree")
			) {
				nested.push(dir);
				return;
			}
			for (const e of entries) {
				const path = join(dir, e.name);
				if (e.type === "tree") {
					if (isSkippedDirName(e.name)) continue;
					if (dir === "" && e.name === "cue.mod") continue;
					next.push(path);
				} else if (e.name.endsWith(".cue")) {
					files.push({ path, entry: e });
				}
			}
		});
		if (bound === "dirs") break;
		level = next.sort();
	}
	files.sort((a, b) => a.path < b.path ? -1 : 1);
	return { files, nested: nested.sort(), bound };
};

type Classified = {
	readonly dir: string;
	readonly facts: EnvCueFacts;
};

/** Detects cuenv projects, or null when the tree has no cuenv module root. */
export const detectCuenv = async (
	reads: CuenvReads,
): Promise<CuenvDetection | null> => {
	const moduleEntry = (await reads.dir("cue.mod"))?.find((e) =>
		e.name === "module.cue"
	);
	reads.fact(
		"cuenv:module",
		moduleEntry ? `${moduleEntry.mode}:${moduleEntry.hash}` : "absent",
	);
	if (!moduleEntry || !isRegular(moduleEntry)) return null;

	// One limit for tree and blob reads; `.cue` texts are fetched as their
	// directories are listed (at most MAX_PACKAGE_CLAUSES), then selected by
	// path below, so which texts count never depends on read timing.
	const limit = createLimiter(WALK_CONCURRENCY);
	const prefetched = new Map<string, Promise<string | null>>();
	const walked = await walk(reads, limit, (f) => {
		if (!isRegular(f.entry) || prefetched.size >= MAX_PACKAGE_CLAUSES) return;
		const text = limit(() => reads.text(f.path));
		text.catch(() => {}); // awaited below when selected; unselected may fail quietly
		prefetched.set(f.path, text);
	});
	for (const f of walked.files) {
		reads.fact(`cuenv:cue:${f.path}`, `${f.entry.mode}:${f.entry.hash}`);
	}
	for (const dir of walked.nested) reads.fact(`cuenv:nested:${dir}`, "1");
	reads.fact("cuenv:bound", walked.bound);

	const warnings: ProjectIssue[] = [];
	const warn = (issue: ProjectIssue) => {
		if (warnings.length < MAX_WARNINGS) warnings.push(issue);
	};
	const skipped: string[] = [...walked.nested];
	if (walked.bound === "depth") skipped.push("depth-limit");
	if (walked.bound === "dirs") skipped.push("dir-limit");

	// Package clauses (and the env.cue texts) from the regular blobs.
	const regular = walked.files.filter((f) => isRegular(f.entry));
	for (const f of walked.files) {
		if (!isRegular(f.entry) && basename(f.path) === "env.cue") {
			warn({
				code: "env-cue-not-regular",
				path: f.path,
				message: `${f.path} is a ${f.entry.type}, not a regular file; skipped`,
			});
		}
	}
	const isEnv = (f: CueFile) => basename(f.path) === "env.cue";
	const others = regular.filter((f) => !isEnv(f));
	const readable = [
		...regular.filter(isEnv),
		...others.slice(
			0,
			Math.max(0, MAX_PACKAGE_CLAUSES - regular.filter(isEnv).length),
		),
	];
	if (readable.length < regular.length) skipped.push("packages-limit");
	const texts = new Map(
		await Promise.all(
			readable.map(async (f) =>
				[
					f.path,
					await (prefetched.get(f.path) ?? limit(() => reads.text(f.path))),
				] as const
			),
		),
	);
	const packages: Record<string, string | null> = {};
	for (const f of regular) {
		if (!texts.has(f.path)) continue;
		const text = texts.get(f.path) ?? null;
		const clause = text === null ? null : packageClause(text);
		packages[f.path] = clause?.name ?? null;
		if (clause && clause.attributes.length > 0) {
			warn({
				code: "package-attribute",
				path: f.path,
				message: `${f.path} has file attributes (${
					clause.attributes.map((a) => `@${a}`).join(", ")
				}) before its package clause`,
			});
		}
	}

	// Candidates.
	const classified: Classified[] = [];
	for (const f of regular.filter(isEnv)) {
		const text = texts.get(f.path) ?? null;
		if (text === null || byteLength(text) > ENV_CUE_MAX_BYTES) {
			warn({
				code: "env-cue-too-large",
				path: f.path,
				message: `${f.path} is over ${ENV_CUE_MAX_BYTES / 1024} KiB; skipped`,
			});
			continue;
		}
		if (!isCuenvClause(packageClause(text))) continue;
		classified.push({ dir: dirname(f.path), facts: classifyEnvCue(text) });
	}

	const layerRoots = classified.filter((c) => c.facts.kind === "base").map((
		c,
	) => c.dir);
	for (const c of classified.filter((c) => c.facts.kind === "unknown")) {
		warn({
			code: "unknown-env-cue",
			path: join(c.dir, "env.cue"),
			message: `${
				join(c.dir, "env.cue")
			} names neither #Project nor #Base; not a project`,
		});
	}
	const rootEnv = classified.find((c) =>
		c.dir === "" && c.facts.kind === "project"
	);
	let candidates = classified.filter((c) =>
		c.facts.kind === "project" && c.dir !== ""
	);
	if (rootEnv) {
		warn({
			code: "root-project",
			path: "env.cue",
			message:
				"the root env.cue declares a #Project: it names the repository, not a project",
		});
	}
	if (candidates.length > MAX_CUENV_PROJECTS) {
		candidates = candidates.slice(0, MAX_CUENV_PROJECTS);
		skipped.push("project-limit");
	}

	// Names (literal, too long or unresolved) and identity.
	const drafts = candidates.map((c) => {
		const issues: ProjectIssue[] = [];
		const literal = c.facts.name;
		const path = join(c.dir, "env.cue");
		if (literal !== undefined && literal.length > NAME_MAX) {
			issues.push({
				code: "name-too-long",
				path,
				message: `the name is longer than ${NAME_MAX} characters`,
			});
		}
		const resolved = literal !== undefined && literal.length <= NAME_MAX;
		if (!resolved) {
			issues.push({
				code: "computed-name",
				path,
				message:
					"no literal name: the directory name is used until the module is evaluated",
			});
		}
		return {
			root: c.dir,
			name: resolved ? literal : slugOf(basename(c.dir)),
			nameSource: resolved ? "literal" as const : "unresolved" as const,
			issues,
		};
	});
	const roots = drafts.map((d) => d.root);
	const identities = new Map(
		(await assignIdentities(drafts)).map((i) => [i.root, i]),
	);
	const projects: CuenvProjectDraft[] = drafts.map((d) => {
		const id = identities.get(d.root)!;
		const outer = roots.find((r) => r !== d.root && isUnder(d.root, r));
		const issues = [
			...d.issues,
			...id.issues,
			...(outer !== undefined
				? [{
					code: "nested-project",
					path: d.root,
					message: `inside the project at ${outer}; the longest root wins`,
				}]
				: []),
		];
		for (const issue of issues) warn(issue);
		return {
			name: id.name,
			root: d.root,
			...(id.cuenvName !== undefined ? { cuenvName: id.cuenvName } : {}),
			slug: id.slug,
			nameSource: d.nameSource,
			layers: layerRoots
				.filter((l) => l !== d.root && isUnder(d.root, l))
				.sort((a, b) => a.length - b.length),
			issues,
			manifestPath: join(d.root, "env.cue"),
		};
	}).sort((a, b) => a.root < b.root ? -1 : 1);

	// Layer paths: `.cue` files outside every project root, by deepest layer.
	const outside = walked.files.filter((f) =>
		!roots.some((r) => isUnder(f.path, r))
	);
	const layers: ProjectLayer[] = [...layerRoots]
		.sort((a, b) => a < b ? -1 : 1)
		.map((root) => ({
			root,
			paths: outside.filter((f) => {
				const deepest = layerRoots
					.filter((l) => isUnder(dirname(f.path), l))
					.sort((a, b) => b.length - a.length)[0];
				return deepest === root;
			}).map((f) => f.path),
		}));

	return {
		projects,
		layers,
		skipped,
		warnings,
		truncated: walked.bound !== "none",
		packages,
		...(rootEnv
			? { rootProject: { name: rootEnv.facts.name ?? slugOf("repository") } }
			: {}),
	};
};
