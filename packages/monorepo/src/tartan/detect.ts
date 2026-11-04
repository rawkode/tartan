// The project detector: a structural walk over the committed tree (K15: every
// read by SHA through the caller's view). There is no central project list.
//
// 1. Walk: breadth-first; directory names starting with `.` or `_`,
//    `node_modules`, `testdata`, `vendor`, `target`, `dist` and `cue.mod` are
//    skipped. `MAX_WALK_DEPTH`/`MAX_WALK_DIRS` truncate (`truncated`: every path
//    is then global, the safe side).
// 2. Files: `.cue` files the CUE loader would read (`isCueSourceName`); their
//    package clauses are read textually, at most `MAX_PACKAGE_CLAUSES` by path
//    order (more truncates too).
// 3. A project: any directory but the root holding a regular such file in
//    `package tartan`, under any filename. Root `*.cue` files stay repository
//    config. A project under a project keeps both (longest root wins).
// 4. Name: the first literal top-level `name: "…"`, else the directory name.
//    Deps: literal top-level `deps: […]`. `extensions: "rawkode.issues":
//    enabled`, both forms, read by `./manifest.ts`: an unreadable form means
//    enabled, with a warning on the project.
// 5. Manifest: `forge.cue` when it is one of the project's files, else its first
//    file by path. A change to it is global for K6.
// 6. At most `MAX_TARTAN_PROJECTS` projects, by path order.
//
// Everything here is a TEXTUAL read of literals: nothing is evaluated and
// nothing is policy. The graph key records only fact files `(path, mode, oid)`
// and the walk bound, so two trees with the same facts give the same graph.

import type { RawTreeEntry } from "../objects.ts";
import { createLimiter } from "../objects.ts";
import { basename, dirname, isUnder } from "../glob.ts";
import { packageClause } from "./clause.ts";
import { assignIdentities, slugOf } from "./identity.ts";
import {
	isCueSourceName,
	isSkippedDirName,
	MAX_PACKAGE_CLAUSES,
	MAX_PROJECT_DEPS,
	MAX_PROJECT_ISSUES,
	MAX_TARTAN_PROJECTS,
	MAX_WALK_DEPTH,
	MAX_WALK_DIRS,
	MAX_WARNINGS,
	NAME_MAX,
	WALK_CONCURRENCY,
} from "./limits.ts";
import {
	type EnabledRead,
	ISSUES_EXTENSION,
	type ManifestFacts,
	mergeEnabled,
	readManifest,
} from "./manifest.ts";
import type { NameSource, ProjectExtensions, ProjectIssue } from "./types.ts";

/** What the detector reads, and where it records the facts behind the graph key. */
export type TartanReads = {
	/** Entries of a directory ("" = the root); null when absent. */
	dir(path: string): Promise<readonly RawTreeEntry[] | null>;
	/** A blob's text by path; null when absent or too large to be a manifest. */
	text(path: string): Promise<string | null>;
	/** One fact of the graph key. */
	fact(key: string, value: string): void;
};

export type TartanProjectDraft = {
	/** Unique within the graph. */
	readonly name: string;
	readonly root: string;
	readonly declaredName?: string;
	readonly slug: string;
	readonly nameSource: NameSource;
	/** Names of other projects, literal in the project's files. */
	readonly deps: readonly string[];
	readonly extensions: ProjectExtensions;
	readonly issues: readonly ProjectIssue[];
	readonly manifestPath: string;
};

export type TartanDetection = {
	readonly projects: readonly TartanProjectDraft[];
	readonly skipped: readonly string[];
	readonly warnings: readonly ProjectIssue[];
	readonly truncated: boolean;
	readonly packages: Readonly<Record<string, string | null>>;
};

/** The manifest a project's files prefer by convention. */
const CONVENTIONAL_MANIFEST = "forge.cue";

const isRegular = (e: RawTreeEntry): boolean =>
	e.type === "blob" || e.type === "exec";

const join = (dir: string, name: string): string =>
	dir === "" ? name : `${dir}/${name}`;

type CueFile = { readonly path: string; readonly entry: RawTreeEntry };

type Walk = {
	readonly files: readonly CueFile[];
	readonly bound: "none" | "depth" | "dirs";
};

type Limit = ReturnType<typeof createLimiter>;

const childDirs = (
	dir: string,
	entries: readonly RawTreeEntry[],
): string[] =>
	entries
		.filter((e) => e.type === "tree" && !isSkippedDirName(e.name))
		.map((e) => join(dir, e.name));

const cueFiles = (
	dir: string,
	entries: readonly RawTreeEntry[],
): CueFile[] =>
	entries
		.filter((e) => e.type !== "tree" && isCueSourceName(e.name))
		.map((e) => ({ path: join(dir, e.name), entry: e }));

/**
 * The walk, pipelined: every listing schedules its children at once, so
 * `WALK_CONCURRENCY` reads stay in flight across levels, and each `.cue`
 * file is handed to `found` as soon as its directory is listed. When the
 * tree holds more than `MAX_WALK_DIRS` directories the strict level-order
 * walk decides which ones count (its listings are memoised by the view), so
 * the result never depends on read timing.
 */
const walk = async (
	reads: TartanReads,
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
		cueFiles(dir, entries).forEach(found);
		const next: Promise<void>[] = [];
		for (const child of childDirs(dir, entries)) {
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
	const files = [...listings].flatMap(([dir, entries]) =>
		cueFiles(dir, entries)
	);
	files.sort((a, b) => a.path < b.path ? -1 : 1);
	return { files, bound: deep ? "depth" : "none" };
};

/** The strict breadth-first walk (deterministic under `MAX_WALK_DIRS`). */
const levelWalk = async (reads: TartanReads, limit: Limit): Promise<Walk> => {
	const files: CueFile[] = [];
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
			files.push(...cueFiles(dir, entries));
			next.push(...childDirs(dir, entries));
		});
		if (bound === "dirs") break;
		level = next.sort();
	}
	files.sort((a, b) => a.path < b.path ? -1 : 1);
	return { files, bound };
};

const extensionsOf = (read: EnabledRead): ProjectExtensions => ({
	[ISSUES_EXTENSION]: {
		enabled: read.state === "read" ? read.enabled : true,
	},
});

/**
 * The facts of one file. The reader is bounded, so this should never throw; if
 * it does, the file counts for nothing and the project keeps its safe defaults.
 * A file in a repo must not be able to fail the repo's whole address.
 */
const factsOf = (
	path: string,
	text: string,
	issues: ProjectIssue[],
): ManifestFacts & { readonly path: string } => {
	try {
		return { path, ...readManifest(text) };
	} catch {
		issues.push({
			code: "cue-unreadable",
			path,
			message: `${path} could not be read; nothing in it counts`,
		});
		return {
			path,
			computedName: false,
			invalidName: false,
			deps: [],
			computedDeps: false,
			issues: { state: "absent" },
		};
	}
};

/** At most `MAX_PROJECT_ISSUES`, the last saying how many more there were. */
const cappedIssues = (
	issues: readonly ProjectIssue[],
	path: string,
): readonly ProjectIssue[] =>
	issues.length <= MAX_PROJECT_ISSUES ? issues : [
		...issues.slice(0, MAX_PROJECT_ISSUES - 1),
		{
			code: "issues-truncated",
			path,
			message: `and ${issues.length - MAX_PROJECT_ISSUES + 1} more`,
		},
	];

/** Detects the projects of a tree: every directory holding a `package tartan` file. */
export const detectTartan = async (
	reads: TartanReads,
): Promise<TartanDetection> => {
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
		reads.fact(`tartan:cue:${f.path}`, `${f.entry.mode}:${f.entry.hash}`);
	}
	reads.fact("tartan:bound", walked.bound);

	const warnings: ProjectIssue[] = [];
	const warn = (issue: ProjectIssue) => {
		if (warnings.length < MAX_WARNINGS) warnings.push(issue);
	};
	const skipped: string[] = [];
	if (walked.bound === "depth") skipped.push("depth-limit");
	if (walked.bound === "dirs") skipped.push("dir-limit");

	const regular = walked.files.filter((f) => isRegular(f.entry));
	for (const f of walked.files) {
		if (!isRegular(f.entry)) {
			warn({
				code: "cue-not-regular",
				path: f.path,
				message: `${f.path} is a ${f.entry.type}, not a regular file; skipped`,
			});
		}
	}
	const readable = regular.slice(0, MAX_PACKAGE_CLAUSES);
	const overLimit = readable.length < regular.length;
	if (overLimit) skipped.push("packages-limit");
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

	// Package clauses, and the directories that hold `package tartan`.
	const packages: Record<string, string | null> = {};
	const byDir = new Map<string, string[]>();
	for (const f of readable) {
		const text = texts.get(f.path) ?? null;
		if (text === null) {
			packages[f.path] = null;
			warn({
				code: "cue-too-large",
				path: f.path,
				message:
					`${f.path} is too large to read; its directory may be a project`,
			});
			continue;
		}
		const clause = packageClause(text);
		packages[f.path] = clause.name;
		if (clause.name !== "tartan") continue;
		if (clause.attributes.length > 0) {
			warn({
				code: "package-attribute",
				path: f.path,
				message: `${f.path} has file attributes (${
					clause.attributes.map((a) => `@${a}`).join(", ")
				}) before its package clause; they are not evaluated`,
			});
		}
		const dir = dirname(f.path);
		if (dir !== "") byDir.set(dir, [...(byDir.get(dir) ?? []), f.path]);
	}

	let candidates = [...byDir].sort(([a], [b]) => a < b ? -1 : 1);
	if (candidates.length > MAX_TARTAN_PROJECTS) {
		candidates = candidates.slice(0, MAX_TARTAN_PROJECTS);
		skipped.push("project-limit");
	}

	// Names (literal or the directory's) and identity.
	const drafts = candidates.map(([root, files]) => {
		const manifestPath = files.find((f) =>
			basename(f) === CONVENTIONAL_MANIFEST
		) ?? files[0];
		const issues: ProjectIssue[] = [];
		const facts = [
			manifestPath,
			...files.filter((f) => f !== manifestPath),
		].map((path) => factsOf(path, texts.get(path) ?? "", issues));
		const literal = facts.find((f) => f.name !== undefined);
		if (literal?.name !== undefined && literal.name.length > NAME_MAX) {
			issues.push({
				code: "name-too-long",
				path: literal.path,
				message: `the name is longer than ${NAME_MAX} characters`,
			});
		}
		const resolved = literal?.name !== undefined &&
			literal.name.length <= NAME_MAX;
		const computed = facts.find((f) => f.computedName);
		if (!resolved && computed !== undefined) {
			issues.push({
				code: "computed-name",
				path: computed.path,
				message: "name is not a literal: the directory name is used",
			});
		}
		const invalid = facts.find((f) => f.invalidName);
		if (!resolved && invalid !== undefined) {
			issues.push({
				code: "invalid-name",
				path: invalid.path,
				message:
					"a name holds only letters, digits, dots, dashes and underscores: the directory name is used",
			});
		}
		const computedDeps = facts.find((f) => f.computedDeps);
		if (computedDeps !== undefined) {
			issues.push({
				code: "computed-deps",
				path: computedDeps.path,
				message:
					"deps holds something other than literal strings; only the literals are read",
			});
		}
		const enabled = mergeEnabled(facts.map((f) => f.issues));
		if (enabled.state === "unreadable") {
			issues.push({
				code: "extension-config-unread",
				path: manifestPath,
				message:
					`${ISSUES_EXTENSION} could not be read textually (${enabled.why}): it stays enabled`,
			});
		}
		const named = [...new Set(facts.flatMap((f) => f.deps))]
			.filter((dep) => dep.length <= NAME_MAX).sort();
		if (named.length > MAX_PROJECT_DEPS) {
			issues.push({
				code: "too-many-deps",
				path: manifestPath,
				message:
					`only the first ${MAX_PROJECT_DEPS} of ${named.length} deps are read`,
			});
		}
		return {
			root,
			manifestPath,
			name: resolved ? literal.name! : slugOf(basename(root)),
			nameSource: (resolved ? "literal" : "directory") as NameSource,
			deps: named.slice(0, MAX_PROJECT_DEPS),
			extensions: extensionsOf(enabled),
			issues,
		};
	});
	const roots = drafts.map((d) => d.root);
	const identities = new Map(
		(await assignIdentities(drafts)).map((i) => [i.root, i]),
	);
	const known = new Set([...identities.values()].map((i) => i.name));
	const projects: TartanProjectDraft[] = drafts.map((d) => {
		const id = identities.get(d.root)!;
		const outer = roots.find((r) => r !== d.root && isUnder(d.root, r));
		const unknown = d.deps.filter((dep) => !known.has(dep));
		const issues = cappedIssues([
			...d.issues,
			...id.issues,
			...unknown.map((dep) => ({
				code: "unknown-dep",
				path: d.manifestPath,
				message: `no project is named ${dep}`,
			})),
			...(outer !== undefined
				? [{
					code: "nested-project",
					path: d.root,
					message: `inside the project at ${outer}; the longest root wins`,
				}]
				: []),
		], d.manifestPath);
		for (const issue of issues) warn(issue);
		return {
			name: id.name,
			root: d.root,
			...(id.declaredName !== undefined
				? { declaredName: id.declaredName }
				: {}),
			slug: id.slug,
			nameSource: d.nameSource,
			deps: d.deps,
			extensions: d.extensions,
			issues,
			manifestPath: d.manifestPath,
		};
	}).sort((a, b) => a.root < b.root ? -1 : 1);

	return {
		projects,
		skipped,
		warnings,
		truncated: walked.bound !== "none" || overLimit,
		packages,
	};
};
