// The deterministic histories the repo suites start from: commits with fixed
// files, messages, author and dates, so their SHAs are constants. A SHA that
// differs means the fixture or git changed, never a flake;
// `scripts/e2e/support.test.ts` rebuilds every fixture with the local git
// and compares.
//
// - `FIXTURE` (the basic history, three commits): a root `tartan.cue` of the
//   CUE package `tartan` (ADR repo config) declaring one project, `app` at
//   `src/`, a router and a guide.
// - `BROKEN_CONFIG_FIXTURE`: a package tartan that does not evaluate.
// - `MONOREPO_FIXTURE`: two `package tartan` project directories.
// - `CUE_FIXTURE`: the CUE suite's repo, a `tartan.cue` and another tool's
//   `env.cue` (package cuenv) beside it.

import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { gitDate, gitEnv, gitOk } from "./git.ts";

export type FixtureCommit = {
	readonly subject: string;
	/** Seconds since the epoch (author and committer). */
	readonly at: number;
	readonly files: Readonly<Record<string, string>>;
};

export type Fixture = {
	readonly commits: readonly FixtureCommit[];
	/** The commit SHAs, oldest first. */
	readonly shas: readonly string[];
};

/** 2026-01-01T00:00:00Z. */
const T0 = 1_767_225_600;

/** A root `tartan.cue` declaring `projects` (name → root). */
export const tartanCue = (
	comment: string,
	projects: Readonly<Record<string, string>>,
): string =>
	[
		"package tartan",
		"",
		`// ${comment}`,
		...Object.entries(projects).map(([name, root]) =>
			`projects: ${name}: root: "${root}"`
		),
		"",
	].join("\n");

export const FIXTURE_COMMITS: readonly FixtureCommit[] = [
	{
		subject: "Start the e2e fixture",
		at: T0,
		files: {
			"README.md":
				"# e2e fixture\n\nA deterministic repository for the Tartan e2e suites.\n",
			"tartan.cue": tartanCue("One project: everything under src/.", {
				app: "src",
			}),
		},
	},
	{
		subject: "Add the router",
		at: T0 + 3_600,
		files: {
			"src/router/index.ts":
				"export const route = (path: string): string => path;\n",
		},
	},
	{
		subject: "Document the router",
		at: T0 + 7_200,
		files: {
			"docs/guide.md": "# Guide\n\nThe router maps paths to handlers.\n",
		},
	},
];

/** The commit SHAs of `FIXTURE_COMMITS`, oldest first. */
export const FIXTURE_SHAS: readonly string[] = [
	"60ded2f8c045493182d64347f14ea2b136b5a196",
	"01d9567a238de2b2daae7fa4a86b6b15c363424c",
	"ce952705d7425492657fac843e7baf9e3192df54",
];

export const FIXTURE: Fixture = {
	commits: FIXTURE_COMMITS,
	shas: FIXTURE_SHAS,
};

/** The last fixture commit: the trunk of a fresh fixture repo. */
export const FIXTURE_HEAD: string = FIXTURE_SHAS[FIXTURE_SHAS.length - 1];

/** The root entries of the fixture's trunk, as the tree lists them. */
export const FIXTURE_ROOT: readonly string[] = [
	"README.md",
	"docs",
	"src",
	"tartan.cue",
];

/** The paths that differ between the first and the last commit. */
export const FIXTURE_COMPARE_PATHS: readonly string[] = [
	"docs/guide.md",
	"src/router/index.ts",
];

/** The line the last commit adds to the guide (diffs show it). */
export const FIXTURE_GUIDE_LINE = "The router maps paths to handlers.";

// ---------------------------------------------------------------------------
// A repository whose package tartan does not evaluate
// ---------------------------------------------------------------------------

/** The line of `tartan.cue` that holds the type error (a number where the schema wants a string). */
export const BROKEN_CONFIG_LINE = 4;

export const BROKEN_CONFIG_COMMITS: readonly FixtureCommit[] = [
	{
		subject: "Configure a project with a wrong root",
		at: T0,
		files: {
			"README.md":
				"# e2e broken config\n\nA package tartan that does not evaluate.\n",
			"tartan.cue": [
				"package tartan",
				"",
				"// A project root must be a string.",
				"projects: app: root: 42",
				"",
			].join("\n"),
			"env.cue": [
				"package cuenv",
				"",
				'env: NODE_ENV: "test"',
				"",
			].join("\n"),
		},
	},
];

export const BROKEN_CONFIG_SHAS: readonly string[] = [
	"e4b3c6a17b50080591f849d2c180eef0c8944769",
];

export const BROKEN_CONFIG_FIXTURE: Fixture = {
	commits: BROKEN_CONFIG_COMMITS,
	shas: BROKEN_CONFIG_SHAS,
};

// ---------------------------------------------------------------------------
// A monorepo whose projects are `package tartan` directories
// ---------------------------------------------------------------------------

/** The two projects of the monorepo fixture: name, root. */
export const MONOREPO_PROJECTS = {
	design: { name: "e2e-design", root: "packages/design" },
	web: { name: "e2e-web", root: "apps/web" },
} as const;
export type MonorepoProject = keyof typeof MONOREPO_PROJECTS;

const forgeCue = (name: string): string =>
	["package tartan", "", `name: "${name}"`, ""].join("\n");

export const MONOREPO_COMMITS: readonly FixtureCommit[] = [
	{
		subject: "Lay out the monorepo",
		at: T0,
		files: {
			"README.md":
				"# e2e monorepo\n\nTwo projects: a design system and a website.\n",
			[`${MONOREPO_PROJECTS.design.root}/forge.cue`]: forgeCue(
				MONOREPO_PROJECTS.design.name,
			),
			[`${MONOREPO_PROJECTS.design.root}/README.md`]:
				"# Design system\n\nTokens and components for the e2e website.\n",
			[`${MONOREPO_PROJECTS.design.root}/src/tokens.ts`]:
				'export const brand = "#5b21b6";\n',
			[`${MONOREPO_PROJECTS.web.root}/forge.cue`]: forgeCue(
				MONOREPO_PROJECTS.web.name,
			),
			[`${MONOREPO_PROJECTS.web.root}/README.md`]:
				"# Website\n\nThe e2e website.\n",
			[`${MONOREPO_PROJECTS.web.root}/src/index.ts`]:
				'export const title = "e2e";\n',
		},
	},
];

export const MONOREPO_SHAS: readonly string[] = [
	"b989657b96d28e11f0e641021a1100f940650f26",
];

export const MONOREPO_FIXTURE: Fixture = {
	commits: MONOREPO_COMMITS,
	shas: MONOREPO_SHAS,
};

// ---------------------------------------------------------------------------
// Repository config in CUE, end to end
// ---------------------------------------------------------------------------

/** The project the config names. */
export const CUE_PROJECT = "app";

export const CUE_COMMITS: readonly FixtureCommit[] = [
	{
		subject: "Configure the repository in CUE",
		at: T0,
		files: {
			"README.md":
				"# e2e cue\n\nThe root package tartan configures the projects.\n",
			"tartan.cue": tartanCue("One project: everything under src/.", {
				[CUE_PROJECT]: "src",
			}),
			"env.cue": [
				"package cuenv",
				"",
				"// Another tool's root file: the forge must leave it alone.",
				'env: NODE_ENV: "test"',
				"",
			].join("\n"),
			"src/app.ts": 'export const app = "e2e";\n',
			"docs/guide.md": "# Guide\n\nHow the e2e app works.\n",
		},
	},
];

export const CUE_SHAS: readonly string[] = [
	"444ddd7a301d881fb46de85460367de8b087b3b6",
];

export const CUE_FIXTURE: Fixture = { commits: CUE_COMMITS, shas: CUE_SHAS };

/** The root `.cue` files of the CUE suite's trunk, any package. */
export const CUE_ROOT_FILES: readonly string[] = Object.keys(
	CUE_COMMITS[0].files,
).filter((f) => f.endsWith(".cue")).sort();

// ---------------------------------------------------------------------------

/**
 * Builds `commits` in `dir` (an empty directory) with `home` as git's HOME;
 * returns the commit SHAs, oldest first.
 */
export const buildHistory = async (
	dir: string,
	home: string,
	commits: readonly FixtureCommit[],
): Promise<string[]> => {
	const base = gitEnv({ home });
	await gitOk(["init", "-q", "--initial-branch=main"], { cwd: dir, env: base });
	const shas: string[] = [];
	for (const commit of commits) {
		for (const [file, text] of Object.entries(commit.files)) {
			const target = path.join(dir, ...file.split("/"));
			await mkdir(path.dirname(target), { recursive: true });
			await writeFile(target, text);
		}
		const env = gitEnv({ home, date: gitDate(commit.at) });
		await gitOk(["add", "--all"], { cwd: dir, env });
		await gitOk(["commit", "-q", "--no-verify", "-m", commit.subject], {
			cwd: dir,
			env,
		});
		shas.push((await gitOk(["rev-parse", "HEAD"], { cwd: dir, env })).trim());
	}
	return shas;
};

/** The basic fixture (`FIXTURE_COMMITS`). */
export const buildFixture = (dir: string, home: string): Promise<string[]> =>
	buildHistory(dir, home, FIXTURE_COMMITS);
