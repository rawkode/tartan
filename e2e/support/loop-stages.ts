// The M1 loop's stages (claim → lane → push → radar → submit
// → CI → review → Weave → Advance → why-notes), in order. Each stage of one
// loop instance runs once per run across all workers (support/shared.ts);
// a test that checks stage s first reaches every stage before it. The
// shared keys, the repo suite name of an instance and the checks a stage's
// progress must wait for are pure functions here, unit-tested in Deno.

export const LOOP_STAGES = [
	"repo",
	"claimed",
	"pushed",
	"submitted",
	"ci-green",
	"review-human",
	"approved",
	"landed",
	"closed",
] as const;
export type LoopStage = typeof LOOP_STAGES[number];

/** The stage before `stage`, or null for the first. */
export const previousStage = (stage: LoopStage): LoopStage | null => {
	const i = LOOP_STAGES.indexOf(stage);
	return i <= 0 ? null : LOOP_STAGES[i - 1];
};

/** The repo suite name of loop instance `index` (`<runId>-loop`, `…-loop-1`). */
export const loopSuite = (index: number): string =>
	index === 0 ? "loop" : `loop-${index}`;

/** The shared key of a stage of loop instance `index`. */
export const stageKey = (index: number, stage: LoopStage): string =>
	`loop-${index}-stage-${stage}`;

/** The shared flag a loop test sets when it starts (`started`) or ends (`done`). */
export const checkKey = (
	index: number,
	step: number,
	what: "started" | "done",
): string => `loop-${index}-check-${step}-${what}`;

/**
 * The loop's tests are numbered 1–9 (the repo, the claims, the pushes and
 * radar, the submits, CI, the approval, the land, the why-notes, the closed
 * items). Approving lets the changes land, which clears the radar conflict,
 * moves trunk and closes the lanes, so before the approval runs, every one
 * of these earlier checks that has started must have finished (bounded):
 * what they look at is still there while they look.
 */
export const PRE_LAND_CHECKS: readonly number[] = [1, 2, 3, 4, 5];
