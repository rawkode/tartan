// Input hashes for the result cache.
//
// The hash of a planned job is SHA-256 over: the job as it would run (run,
// cwd, env, timeout, context), the runner image id, and
// - for a project job, the tree hash of every project root in its
//   dependency closure, the hashes of the global files, and a digest of
//   every entry outside all project roots (such a path
//   is global, so it must invalidate every project job's cache too;
//   the walk descends only into directories that hold a project root);
// - for any other job (e.g. `install`), the root tree hash.
// Tree hashes are content addresses, so a lane head and a land candidate
// with the same project subtrees produce the same hash: that is what makes a
// candidate run nearly free and backs K6's "land without re-test". A global
// glob that is not a literal path or `dir/**` hashes its literal base
// directory (over-invalidates, never under-invalidates), except a root-level
// wildcard such as `*.cue` (ADR repo config: every root `*.cue` file is policy
// and global), whose matching root entries are hashed exactly, so editing
// one project does not invalidate every other project's cache.
//
// Pure over an injected `treeHash(path)` (`caps.repo.treeHash` at the run's
// sha and source), memoised per call, and `listTree(path)`
// (`caps.repo.readTree` at the same sha and source).

import { createProjectIndex, type GraphLike } from "./graph.ts";
import { globBase, globMatcher, isLiteralGlob, normaliseGlob } from "./glob.ts";
import type { PlannedJob } from "./plan.ts";

export type TreeHasher = (path: string) => Promise<string | null>;

/** The immediate entries of the tree at `path` (`""` = the root). */
export type TreeLister = (
	path: string,
) => Promise<
	readonly {
		readonly path: string;
		readonly hash: string;
		readonly type: string;
	}[]
>;

/** JSON with sorted object keys (stable across engines). */
export const canonicalJson = (value: unknown): string => {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value ?? null);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${
		entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(
			",",
		)
	}}`;
};

export const sha256Hex = async (text: string): Promise<string> => {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
		.join("");
};

/** What of a planned job goes into its hash (not its id or needs). */
export const jobSpecKey = (job: PlannedJob): unknown => ({
	context: job.context,
	run: job.run,
	cwd: job.cwd ?? "",
	env: job.env,
	timeoutMs: job.timeoutMs ?? null,
});

/** Tree-hash reads in flight at once (each is a RepoProbe call). */
export const TREE_HASH_CONCURRENCY = 8;

/** Memoised per path, at most `TREE_HASH_CONCURRENCY` reads at once. */
const memo = (hasher: TreeHasher): TreeHasher => {
	const seen = new Map<string, Promise<string | null>>();
	let active = 0;
	const waiting: (() => void)[] = [];
	const limited = async (path: string): Promise<string | null> => {
		if (active >= TREE_HASH_CONCURRENCY) {
			await new Promise<void>((go) => waiting.push(go));
		}
		active++;
		try {
			return await hasher(path);
		} finally {
			active--;
			waiting.shift()?.();
		}
	};
	return (path) => {
		let p = seen.get(path);
		if (p === undefined) {
			p = limited(path);
			seen.set(path, p);
		}
		return p;
	};
};

/** The path whose tree (or blob) hash stands for a global glob. */
export const globalHashPath = (glob: string): string => {
	const g = normaliseGlob(glob);
	if (isLiteralGlob(g)) return g;
	return globBase(g);
};

/** A wildcard glob that matches root entries only (`*.cue`): hashed by its matches. */
export const isRootGlob = (glob: string): boolean => {
	const g = normaliseGlob(glob);
	return !isLiteralGlob(g) && !g.includes("/") && !g.includes("**");
};

/** Directories walked for the out-of-root digest (each one `listTree` call). */
export const OUTSIDE_WALK_MAX = 256;

/**
 * Every tree entry outside all project roots as `[path, hash]`, sorted: a
 * directory that holds no project root counts by its tree hash, one that
 * holds a root is listed. A root at `""` leaves nothing outside. Null when
 * more than `OUTSIDE_WALK_MAX` directories hold roots (the caller then
 * hashes the whole tree: over-invalidates, never under-invalidates).
 */
export const outsideRoots = async (
	roots: readonly string[],
	listTree: TreeLister,
): Promise<(readonly [string, string])[] | null> => {
	const rootSet = new Set(roots.map((r) => r.replace(/\/+$/, "")));
	if (rootSet.has("")) return [];
	const holdsRoot = (dir: string) =>
		[...rootSet].some((r) => r.startsWith(`${dir}/`));
	const out: (readonly [string, string])[] = [];
	const queue = [""];
	for (let walked = 0; queue.length > 0; walked++) {
		if (walked >= OUTSIDE_WALK_MAX) return null;
		const entries = await listTree(queue.shift()!);
		for (const e of entries) {
			if (rootSet.has(e.path)) continue;
			if (e.type === "tree" && holdsRoot(e.path)) queue.push(e.path);
			else out.push([e.path, e.hash]);
		}
	}
	return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
};

/**
 * Input hashes of `jobs` (job id → 64 hex). `graph` is the graph the plan
 * used (at the base); `treeHash` and `listTree` read the run's own tree.
 */
export const inputHashes = async (
	jobs: readonly PlannedJob[],
	graph: GraphLike,
	image: string,
	treeHash: TreeHasher,
	listTree: TreeLister,
): Promise<Map<string, string>> => {
	const hash = memo(treeHash);
	const index = createProjectIndex(graph);
	const rootGlobs = [
		...new Set(
			graph.globalFiles.filter((g) => isRootGlob(g.glob)).map((g) =>
				normaliseGlob(g.glob)
			),
		),
	].sort();
	const globals = [
		...new Set(
			graph.globalFiles.filter((g) => !isRootGlob(g.glob)).map((g) =>
				globalHashPath(g.glob)
			),
		),
	].sort();
	let rootListing: ReturnType<TreeLister> | null = null;
	const rootFacts = async () => {
		if (rootGlobs.length === 0) return [];
		const entries = await (rootListing ??= listTree(""));
		return rootGlobs.map((glob) => {
			const match = globMatcher(glob);
			return [
				`root:${glob}`,
				entries.filter((e) => match(e.path)).map((e) => [e.path, e.hash])
					.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
			] as const;
		});
	};
	const globalFacts = async () => [
		...await Promise.all(globals.map(async (p) => [p, await hash(p)] as const)),
		...await rootFacts(),
	];
	let outside: Promise<string> | null = null;
	/** One digest of the out-of-root entries, shared by every project job. */
	const outsideDigest = () =>
		outside ??= outsideRoots(graph.projects.map((p) => p.root), listTree)
			.then(async (entries) =>
				sha256Hex(canonicalJson(entries ?? { tree: await hash("") }))
			);
	const hashed = await Promise.all(jobs.map(async (job) => {
		let inputs: unknown;
		if (job.project !== undefined && index.project(job.project) !== null) {
			const closure = [...index.depsClosure([job.project])].sort();
			const roots = await Promise.all(closure.map(async (name) => {
				const root = index.project(name)!.root;
				return [name, root, await hash(root)] as const;
			}));
			inputs = {
				roots,
				globals: await globalFacts(),
				outside: await outsideDigest(),
			};
		} else {
			inputs = { tree: await hash("") };
		}
		const digest = await sha256Hex(canonicalJson({
			v: 2,
			job: jobSpecKey(job),
			image,
			project: job.project ?? null,
			inputs,
		}));
		return [job.id, digest] as const;
	}));
	return new Map(hashed);
};
