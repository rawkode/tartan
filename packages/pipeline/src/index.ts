// @tartan/pipeline (WP14): the `tartan.ci` pipeline schema (its repo
// policy key `pipeline` in the root package `tartan`, ADR repo config),
// zero-config detection, the JobGraph planner over affected sets, and CI
// input hashes.
//
// The implementation lives in `tartan.ci` (`extensions/ci/src/pipeline/`):
// builtins may import only `@tartan/contract` and `@tartan/ext-api`
// (`scripts/check-imports.ts`), so the extension cannot import this package;
// this package re-exports the extension's copy for every other consumer
// (kernel, scripts, tests). If the import rule ever admits `@tartan/pipeline`
// for builtins, the code moves here unchanged.

export * from "../../../extensions/ci/src/pipeline/index.ts";
