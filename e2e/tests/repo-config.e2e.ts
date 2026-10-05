// Repository config in CUE (ADR repo config) where it does not
// evaluate: a repo imported with a root `package tartan` holding a type
// error. The forge reports the failure with the file and line, the settings
// page shows it with a link to that line, and the `package cuenv` file
// beside it is not what failed. (The M1 loop covers a config that does
// evaluate: tests/loop/m1-loop.e2e.ts, step 1.)

import { expect } from "e2e";
import type { RepoConfigStateDto } from "@tartan/contract/repoconfig.ts";
import { test } from "../support/fixtures.ts";
import {
	BROKEN_CONFIG_FIXTURE,
	BROKEN_CONFIG_LINE,
} from "../support/fixture-repo.ts";
import { ok, tokenApi } from "../support/http.ts";
import { expectApiClean, watchApi } from "../support/page.ts";
import { fixtureRepo } from "../support/repos.ts";
import { tokensOf } from "../support/stage.ts";

const FAILED: RepoConfigStateDto["status"] = "failed";
const NEEDS_APPLY: RepoConfigStateDto["status"] = "needs-apply";
/**
 * The settings page's chip for each status (the kernel view's own labels,
 * web/src/views/repoconfig/model.ts STATUS_VIEW).
 */
const CHIP: Partial<Record<RepoConfigStateDto["status"], string>> = {
	[FAILED]: "failed",
	[NEEDS_APPLY]: "needs apply",
};

test(
	"a package tartan that does not evaluate shows its error with file and line",
	{
		session: "owner",
		tags: ["cue-config", "containers", "regression", "owner"],
		timeout: 600_000,
	},
	async ({ app, browser, stage }) => {
		test.skip(
			!stage.containers,
			"the CUE evaluator runs in a container (the stage was deployed with --no-containers)",
		);
		const repo = await fixtureRepo(
			stage,
			"classic",
			"broken-config",
			BROKEN_CONFIG_FIXTURE,
		);
		const owner = tokenApi(stage.origin, tokensOf(stage).ownerPat);
		const at = `/-/api/repos/${encodeURIComponent(repo.id)}/config`;
		let state: RepoConfigStateDto | null = null;
		// An import moves trunk outside the Advance: a config that does not
		// evaluate there is reported as `needs-apply` with its failure (no
		// apply can succeed); after a land it would be `failed`. Both carry
		// the failure, and that is what the page shows.
		await expect.poll(async () => {
			state = ok("GET", at, await owner.get<RepoConfigStateDto>(at));
			if (!state.enabled) return "disabled";
			return state.failure === undefined ? state.status : "reported";
		}, {
			timeout: 300_000,
			interval: 3_000,
			message: "the broken package tartan's failure was never reported",
		}).toMatch(/^(?:reported|disabled)$/);
		const s = state as unknown as RepoConfigStateDto;
		test.skip(
			!s.enabled,
			"repository config is off on this stage (stage up deploys with --repo-config)",
		);
		expect([FAILED, NEEDS_APPLY]).toContain(s.status);
		expect(s.appliedSha, "nothing was applied").toBeUndefined();
		// API: a positioned issue in tartan.cue at the line of the error.
		const positions = (s.failure?.issues ?? []).flatMap((i) => i.pos);
		expect(
			positions.some((p) => p.startsWith(`tartan.cue:${BROKEN_CONFIG_LINE}:`)),
			`an issue at tartan.cue:${BROKEN_CONFIG_LINE} (got ${
				positions.join(", ")
			})`,
		).toBe(true);
		expect(positions.some((p) => p.startsWith("env.cue:"))).toBe(false);

		// UI: the settings page shows the failure and links the line.
		await app.open(`/${repo.path}/-/settings/extensions`);
		await watchApi(browser);
		await expect(
			browser.locator('section[aria-labelledby="config-state"] [data-status]'),
		).toHaveText(CHIP[s.status] ?? s.status, { timeout: 20_000 });
		const errors = browser.locator('ul[aria-label="CUE errors"]');
		await expect(errors).toContainText(`tartan.cue:${BROKEN_CONFIG_LINE}`);
		await expect(
			browser.locator(
				'ul[aria-label="CUE errors"] a[href*="/-/blob/"][href*="tartan.cue"]',
			).first(),
		).toBeVisible();
		await expectApiClean(browser);
	},
);
