// @tartan/monorepo (WP8): the affected-project planner
// over SHA-only object reads: hash-pruned tree diff, project detection at a
// commit, affected closure, K6 disjointness and input hashes. Pure: the
// caller supplies a `GitObjects` port bound to the repo holding the objects.

export {
	createLimiter,
	createTreeView,
	type GitObjects,
	type Limiter,
	MANIFEST_MAX_BYTES,
	MissingObjectError,
	type RawTreeEntry,
	requireBlob,
	requireTree,
	type TreeView,
} from "./objects.ts";
export {
	diffTrees,
	pairRenames,
	touchedPaths,
	TREE_DIFF_CONCURRENCY,
	TREE_DIFF_MAX_PATHS,
	type TreeChange,
	type TreeDiff,
	type TreeDiffOptions,
	type TreeSide,
} from "./treediff.ts";
export {
	ALWAYS_GLOBAL,
	type DetectedGraph,
	detectProjects,
	type GlobalFile,
	MAX_PROJECTS,
	NO_PROJECT_CONFIG,
	type ProjectConfig,
} from "./detect.ts";
export {
	affectedBy,
	checkDisjoint,
	createProjectIndex,
	type DisjointReason,
	type DisjointResult,
	type GlobalReason,
	type GraphLike,
	type Landing,
	type ProjectIndex,
} from "./affected.ts";
export {
	GLOBAL_EXPANSION_MAX,
	globalFileHashes,
	inputHash,
	type InputHashJob,
	treeHashAt,
} from "./inputhash.ts";
export {
	basename,
	dirname,
	globMatcher,
	isUnder,
	joinPath,
	normaliseGlob,
} from "./glob.ts";
export { canonicalJson, sha256Hex } from "./hash.ts";
