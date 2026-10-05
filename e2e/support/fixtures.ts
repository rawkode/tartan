// The suites' `test`: `@e2e-dev/web`'s, extended with two fixtures every
// test gets.
//
// - `stage`: the run's checked values (support/stage.ts).
// - `workdir`: a fresh temporary directory outside the repository
//   (`$TMPDIR/tartan-e2e-<runId>-…`) for git work, removed in teardown even
//   when the test failed.
//
// `sharedStore()` is the run's cross-worker store (support/shared.ts) for
// flows that span tests.
//
// Hooks and groups come from this `test` (`test.describe`, `test.beforeAll`)
// so they see the same fixtures.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test as base } from "@e2e-dev/web";
import { createShared, type Shared, sharedDirOf } from "./shared.ts";
import { type Stage, stage } from "./stage.ts";

export const test = base.extend<{ stage: Stage; workdir: string }>({
	stage: async (_fixtures, use) => {
		await use(stage());
	},
	workdir: async (_fixtures, use) => {
		const dir = await mkdtemp(
			path.join(tmpdir(), `tartan-e2e-${stage().runId}-`),
		);
		try {
			await use(dir);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
});

export const describe = test.describe;

let shared: Shared | null = null;

/** The run's store shared by every worker (`$TMPDIR/tartan-e2e-<runId>-shared/`). */
export const sharedStore = (): Shared =>
	shared ??= createShared(sharedDirOf(tmpdir(), stage().runId));
