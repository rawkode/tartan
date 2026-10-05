// Bounds of the Tier 0 cuenv walk (WP25 slice A′). The demo mirror has
// 1,112 directories, its deepest project 5 levels down, 41 `env.cue` and 57
// `.cue` blobs outside its one nested module.

/** Directory levels below the root the walk descends (a deeper one truncates). */
export const MAX_WALK_DEPTH = 12;
/** Directories the walk lists (more truncates). */
export const MAX_WALK_DIRS = 4096;
/** `env.cue` larger than this is no candidate (cuenv's own files are a few KiB). */
export const ENV_CUE_MAX_BYTES = 64 * 1024;
/** The package clause is read from this much of a `.cue` blob. */
export const CLAUSE_READ_CHARS = 1024;
/** `.cue` blobs whose package clause is recorded (more: `packages-limit`). */
export const MAX_PACKAGE_CLAUSES = 2000;
/** Projects per graph (the detector chain's `MAX_PROJECTS`). */
export const MAX_CUENV_PROJECTS = 500;
/** Longest literal name (`FootprintSchema`'s project strings). */
export const NAME_MAX = 128;
/**
 * Reads the walk keeps in flight. Above the probe's binding limit (16) on
 * purpose: a slot also holds the object-cache lookup and the cache write
 * around each binding read, and the probe still caps binding reads itself.
 */
export const WALK_CONCURRENCY = 48;
/** Warnings kept per graph (the rest are counted in one last warning). */
export const MAX_WARNINGS = 200;

/** Directory names the walk never enters (the `./...` pattern's rules, as in Go and CUE, plus vendored and build output). */
export const isSkippedDirName = (name: string): boolean =>
	name.startsWith(".") || name.startsWith("_") || name === "node_modules" ||
	name === "testdata" || name === "vendor" || name === "target" ||
	name === "dist";
