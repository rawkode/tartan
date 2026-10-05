// Git over smart HTTP with tokens. The owner imports the fixture
// history in push mode (Owner-only import mode, then `import-complete`), an
// agent clones it, and the push rules hold: trunk is woven by Tartan (the
// owner's own push to `main` is refused with `woven-by-tartan`), a
// Reporter's push is refused by the role ceiling even though its PAT has
// `repo:write`, and an agent pushes only to its lanes (`agents-lanes-only`).
// The band-2 `remote:` guidance on a refusal is pending: it is sent only
// with `ECHO_ENABLED` (src/constants.ts, U4), which stays off until smoke S3
// has run. Tokens reach git through the environment only; all output is
// scrubbed before it is asserted.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { expect } from "e2e";
import type { LogResponse } from "@tartan/contract/api.ts";
import { test } from "../support/fixtures.ts";
import {
	buildFixture,
	FIXTURE_COMMITS,
	FIXTURE_HEAD,
	FIXTURE_SHAS,
} from "../support/fixture-repo.ts";
import { git, gitDate, gitEnv, gitOk } from "../support/git.ts";
import { ok, query, tokenApi } from "../support/http.ts";
import { expectApiClean, watchApi } from "../support/page.ts";
import { fixtureRepo, importModeRepo } from "../support/repos.ts";
import { type Stage, tokensOf } from "../support/stage.ts";

type Repo = Awaited<ReturnType<typeof importModeRepo>>;

/** 2026-01-02T00:00:00Z: commits made by the push tests. */
const PUSH_DATE = gitDate(1_767_312_000);

/** Clones `repo` into `dir/clone` with `token`; returns the clone and its env. */
const cloneWith = async (
	stage: Stage,
	repo: Repo,
	dir: string,
	token: string,
) => {
	const env = gitEnv({
		home: dir,
		auth: { origin: stage.origin, token },
		date: PUSH_DATE,
	});
	const clone = path.join(dir, "clone");
	await gitOk(["clone", "-q", repo.remote, clone], { cwd: dir, env, token });
	return { clone, env };
};

/** A new commit on top of the clone's HEAD (fixed content and date). */
const commitIn = async (
	clone: string,
	env: Record<string, string>,
	name: string,
): Promise<void> => {
	await writeFile(path.join(clone, `${name}.txt`), `${name}\n`);
	await gitOk(["add", "--all"], { cwd: clone, env });
	await gitOk(["commit", "-q", "--no-verify", "-m", `e2e ${name}`], {
		cwd: clone,
		env,
	});
};

test.describe("git: import, clone and the push rules", {
	serial: true,
	session: "developer",
	tags: ["git", "regression"],
}, () => {
	let repo: Repo | null = null;
	const theRepo = (): Repo => {
		if (repo === null) throw new Error("the import test did not run");
		return repo;
	};

	test("the owner imports the fixture history in push mode", async ({ stage, workdir }) => {
		const { ownerPat } = tokensOf(stage);
		repo = await importModeRepo(stage, "classic", "push");
		const home = path.join(workdir, "home");
		const work = path.join(workdir, "work");
		await mkdir(home);
		await mkdir(work);
		expect(await buildFixture(work, home)).toEqual([...FIXTURE_SHAS]);
		await gitOk(["push", "-q", repo.remote, "main:refs/heads/main"], {
			cwd: work,
			env: gitEnv({ home, auth: { origin: stage.origin, token: ownerPat } }),
			token: ownerPat,
		});

		const owner = tokenApi(stage.origin, ownerPat);
		const done = ok(
			"POST",
			"/-/api/repos/<id>/import-complete",
			await owner.send<{ trunkSha: string; defaultBranch: string }>(
				"POST",
				`/-/api/repos/${encodeURIComponent(repo.id)}/import-complete`,
				{},
			),
		);
		expect(done).toMatchObject({
			trunkSha: FIXTURE_HEAD,
			defaultBranch: "main",
		});
		const at = `/-/api/log?${query({ repo: repo.path, ref: "main" })}`;
		await expect.poll(async () => {
			const log = await owner.get<LogResponse>(at);
			return log.body?.commits.map((c) => c.sha) ?? [];
		}, {
			timeout: 90_000,
			interval: 2_000,
			message: "the log never showed the fixture",
		})
			.toEqual([...FIXTURE_SHAS].reverse());
	});

	test("an agent clones the repository with its token", async ({ stage, workdir }) => {
		const { developerAgent } = tokensOf(stage);
		const { clone, env } = await cloneWith(
			stage,
			theRepo(),
			workdir,
			developerAgent,
		);
		const head = await gitOk(["rev-parse", "HEAD"], { cwd: clone, env });
		expect(head.trim()).toBe(FIXTURE_HEAD);
		const config = await readFile(path.join(clone, ".git", "config"), "utf8");
		expect(
			/t(?:pat|agt)_|extraheader/i.test(config),
			"no credential in .git/config",
		)
			.toBe(false);
	});

	test("trunk is woven by Tartan: the owner's push to main is refused", async ({ stage, workdir }) => {
		const { ownerPat } = tokensOf(stage);
		const { clone, env } = await cloneWith(stage, theRepo(), workdir, ownerPat);
		await commitIn(clone, env, "owner-main");
		const pushed = await git(["push", "origin", "HEAD:refs/heads/main"], {
			cwd: clone,
			env,
			token: ownerPat,
		});
		expect(pushed.code).not.toBe(0);
		expect(pushed.stdout + pushed.stderr).toMatch(/woven-by-tartan/);
	});

	test("a Reporter's push is refused by its role, not its scope", {
		tags: ["reporter"],
	}, async ({ stage, workdir }) => {
		const { reporterPat } = tokensOf(stage);
		const { clone, env } = await cloneWith(
			stage,
			theRepo(),
			workdir,
			reporterPat,
		);
		await commitIn(clone, env, "reporter-branch");
		const pushed = await git(["push", "origin", "HEAD:refs/heads/x"], {
			cwd: clone,
			env,
			token: reporterPat,
		});
		expect(pushed.code).not.toBe(0);
		// The refusal is the role's: 403 before any pack is sent, with the
		// gateway's reason (git prints a text/plain error body as `remote:`).
		expect(pushed.stderr).toMatch(/\b403\b/);
		expect(pushed.stderr).toMatch(/pushing needs Developer\+/);
		const refs = await gitOk(["ls-remote", "origin", "refs/heads/x"], {
			cwd: clone,
			env,
			token: reporterPat,
		});
		expect(refs.trim()).toBe("");
	});

	test("an agent pushes only to its lanes", { tags: ["agent"] }, async ({
		stage,
		workdir,
	}) => {
		const { developerAgent } = tokensOf(stage);
		const { clone, env } = await cloneWith(
			stage,
			theRepo(),
			workdir,
			developerAgent,
		);
		await commitIn(clone, env, "agent-branch");
		const pushed = await git(["push", "origin", "HEAD:refs/heads/x"], {
			cwd: clone,
			env,
			token: developerAgent,
		});
		expect(pushed.code).not.toBe(0);
		expect(pushed.stdout + pushed.stderr).toMatch(/agents-lanes-only/);
	});

	test("History lists the fixture commits, newest first", async ({ app, browser, screen }) => {
		const r = theRepo();
		await app.open(`/${r.path}/-/commits/main`);
		await watchApi(browser);
		await expect(screen.getByRole("heading", { name: /^History of main$/ }))
			.toBeVisible();
		await expect(browser.locator("ol.commits .commits__subject")).toHaveText(
			FIXTURE_COMMITS.map((c) => c.subject).reverse(),
		);
		await expectApiClean(browser);
	});
});

// Outside the serial group: e2e takes `skip` per unit, so the group's own
// repo is not available here; the fixture repo is imported and protected.
test("a refused push to main carries remote: guidance", {
	session: "developer",
	tags: ["git", "regression", "pending"],
	skip:
		"pending U4: band-2 guidance needs ECHO_ENABLED (src/constants.ts), off until smoke S3",
}, async ({ stage, workdir }) => {
	const { ownerPat } = tokensOf(stage);
	const repo = await fixtureRepo(stage, "classic", "push-guidance");
	const { clone, env } = await cloneWith(stage, repo, workdir, ownerPat);
	await commitIn(clone, env, "owner-main-guidance");
	const pushed = await git(["push", "origin", "HEAD:refs/heads/main"], {
		cwd: clone,
		env,
		token: ownerPat,
	});
	expect(pushed.code).not.toBe(0);
	expect(pushed.stderr).toMatch(/^remote: tartan ▸ main is woven by Tartan/m);
});
