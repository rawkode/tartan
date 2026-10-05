// The CI pipeline library: the pipeline
// schema (`tartan.ci`'s repo policy in package `tartan`, ADR repo config),
// zero-config detection, the JobGraph planner over affected sets, and input
// hashes for the result cache.
//
// It lives inside `tartan.ci` because builtins may import only
// `@tartan/contract` and `@tartan/ext-api`;
// `@tartan/pipeline` (packages/pipeline) re-exports it for kernel, tooling
// and tests. Pure: no I/O, no platform globals beyond `crypto.subtle`.

export {
	affectedOn,
	createProjectIndex,
	type GlobalReason,
	type GraphLike,
	type ProjectIndex,
} from "./graph.ts";
export {
	globBase,
	globMatcher,
	isLiteralGlob,
	isUnder,
	normaliseGlob,
} from "./glob.ts";
export {
	canonicalJson,
	globalHashPath,
	inputHashes,
	jobSpecKey,
	OUTSIDE_WALK_MAX,
	outsideRoots,
	sha256Hex,
	type TreeHasher,
	type TreeLister,
} from "./hash.ts";
export {
	jobsToRun,
	type Plan,
	PLAN_MAX_JOBS,
	planJobs,
	type PlannedJob,
	type PlanResult,
	type PlanTrigger,
	selectJobs,
	slug,
} from "./plan.ts";
export {
	type EachMode,
	type LaneCiMode,
	parseDuration,
	type Pipeline,
	PIPELINE_JOB_ID_RE,
	PIPELINE_LOCATION,
	PIPELINE_MAX_JOBS,
	PIPELINE_POLICY_KEY,
	PIPELINE_TIMEOUT_DEFAULT_MS,
	PIPELINE_TIMEOUT_MAX_MS,
	type PipelineJob,
	type PipelineResult,
	validatePipeline,
} from "./schema.ts";
export {
	nodeScriptCommand,
	shellQuote,
	testScriptOf,
	type ZeroConfig,
	zeroConfigOf,
	zeroPipeline,
	type ZeroProject,
} from "./zero.ts";
