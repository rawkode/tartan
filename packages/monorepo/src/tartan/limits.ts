// Bounds of the project walk.

/** Directory levels below the root the walk descends (a deeper one truncates). */
export const MAX_WALK_DEPTH = 12;
/** Directories the walk lists (more truncates). */
export const MAX_WALK_DIRS = 4096;
/** `.cue` blobs whose package clause is read (more truncates: `packages-limit`). */
export const MAX_PACKAGE_CLAUSES = 2000;
/** Projects per graph. */
export const MAX_TARTAN_PROJECTS = 500;
/** Literal deps read per project (more are dropped, with an issue). */
export const MAX_PROJECT_DEPS = 128;
/** Issues kept per project (the rest are counted in one last issue). */
export const MAX_PROJECT_ISSUES = 32;
/** Longest literal name (`FootprintSchema`'s project strings). */
export const NAME_MAX = 128;
/**
 * Reads the walk keeps in flight. Above the probe's binding limit (16) on
 * purpose: a slot also holds the object-cache lookup and the cache write
 * around each binding read, and the probe still caps binding reads itself.
 */
export const WALK_CONCURRENCY = 48;
/** Warnings kept per graph (the rest are dropped). */
export const MAX_WARNINGS = 200;

/** Directory names the walk never enters (the `./...` pattern's rules, as in Go and CUE, plus vendored and build output). */
export const isSkippedDirName = (name: string): boolean =>
	name.startsWith(".") || name.startsWith("_") || name === "node_modules" ||
	name === "testdata" || name === "vendor" || name === "target" ||
	name === "dist" || name === "cue.mod";

/**
 * A `.cue` file the CUE loader would read by default: not `_`- or `.`-prefixed,
 * and not a `_tool.cue` or `_test.cue` file.
 */
export const isCueSourceName = (name: string): boolean =>
	name.endsWith(".cue") && !name.startsWith("_") && !name.startsWith(".") &&
	!name.endsWith("_tool.cue") && !name.endsWith("_test.cue");
