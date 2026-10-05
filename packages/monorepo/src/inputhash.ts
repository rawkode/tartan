// Input hash per (job, project): SHA-256 of
// the job spec, the image id, the tree hash of every project root in the
// project's dependency closure and the blob (or tree) hashes of the global
// files. Computed from tree reads only, no container. A change outside the
// closure and the global files leaves it unchanged.

import type { GraphLike } from "./affected.ts";
import { createProjectIndex } from "./affected.ts";
import { globBase, globMatcher, isLiteralGlob, normaliseGlob } from "./glob.ts";
import { canonicalJson, sha256Hex } from "./hash.ts";
import type { TreeView } from "./objects.ts";

/** Files a global glob may expand to before the hash gives up listing them. */
export const GLOBAL_EXPANSION_MAX = 2_000;

/** The hash of the entry at `path` (a tree for directories); null when absent. */
export const treeHashAt = async (
	view: TreeView,
	path: string,
): Promise<string | null> => (await view.entry(path))?.hash ?? null;

/** Every file path under `dir` with its blob hash (bounded). */
const filesUnder = async (
	view: TreeView,
	dir: string,
	limit: number,
): Promise<[string, string][]> => {
	const out: [string, string][] = [];
	const walk = async (path: string): Promise<void> => {
		for (const e of (await view.dir(path)) ?? []) {
			if (out.length >= limit) return;
			const child = path === "" ? e.name : `${path}/${e.name}`;
			if (e.type === "tree") await walk(child);
			else out.push([child, e.hash]);
		}
	};
	await walk(dir);
	return out;
};

/**
 * `[glob, path, hash]` facts for the global files: a literal path's entry,
 * a `dir/**` pattern's tree hash, or each matching file under the glob's
 * literal base.
 */
export const globalFileHashes = async (
	view: TreeView,
	globs: readonly string[],
): Promise<[string, string, string | null][]> => {
	const facts: [string, string, string | null][] = [];
	for (const raw of [...globs].sort()) {
		const glob = normaliseGlob(raw);
		if (isLiteralGlob(glob)) {
			facts.push([glob, glob, await treeHashAt(view, glob)]);
			continue;
		}
		const base = globBase(glob);
		if (glob === `${base}/**`) {
			facts.push([glob, base, await treeHashAt(view, base)]);
			continue;
		}
		const match = globMatcher(glob);
		for (
			const [path, hash] of await filesUnder(view, base, GLOBAL_EXPANSION_MAX)
		) {
			if (match(path)) facts.push([glob, path, hash]);
		}
	}
	return facts;
};

export type InputHashJob = {
	/** The job spec as the planner resolved it (any JSON). */
	readonly spec: unknown;
	/** Runner image digest or id. */
	readonly imageId: string;
};

/** The input hash of `job` for `project` at the tree behind `view` (64 hex). */
export const inputHash = async (
	view: TreeView,
	graph: GraphLike,
	project: string,
	job: InputHashJob,
): Promise<string> => {
	const index = createProjectIndex(graph);
	if (index.project(project) === null) {
		throw new Error(`unknown project ${project}`);
	}
	const closure = [...index.depsClosure([project])].sort();
	const roots = await Promise.all(closure.map(async (name) => {
		const root = index.project(name)!.root;
		return [name, root, await treeHashAt(view, root)] as const;
	}));
	const globals = await globalFileHashes(
		view,
		graph.globalFiles.map((g) => g.glob),
	);
	return await sha256Hex(canonicalJson({
		v: 1,
		job: job.spec,
		image: job.imageId,
		project,
		roots,
		globals,
	}));
};
