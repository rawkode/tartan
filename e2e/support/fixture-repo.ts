// The deterministic histories the repo suites start from: commits with fixed
// files, messages, author and dates, so their SHAs are constants. A SHA that
// differs means the fixture or git changed, never a flake;
// `scripts/e2e/support.test.ts` rebuilds every fixture with the local git
// and compares.
//
// - `FIXTURE` (the basic history, three commits): a root `ci.cue` of the
//   CUE package `tartan` (ADR repo config) whose one job prints `CI_MARKER` for
//   every change and land candidate, a router and a guide.
// - `LOOP_FIXTURE` (the M1 loop, two commits): the root package `tartan`
//   split across `tartan.cue` (one project, `app` at `src/`), `ci.cue` (the
//   same marker job) and `review.cue` (an owners rule of sensitivity 3 on
//   `src/**`, so a change there is routed to a person), a `package cuenv`
//   `env.cue` the forge must leave alone, and `src/rate/limits.ts`, which
//   both loop agents edit on lines far enough apart to merge cleanly.

import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { gitDate, gitEnv, gitOk } from "./git.ts";

/** The line the CI job prints (the CI checks read it from the job log). */
export const CI_MARKER = "e2e-ci-ok";
/** The CI job of both fixtures (`extensions: "tartan.ci": settings: pipeline: jobs`). */
export const CI_JOB = "e2e-check";

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

const ciCue = (comment: string): string =>
	[
		"package tartan",
		"",
		`// ${comment}`,
		'extensions: "tartan.ci": settings: pipeline: {',
		`\tjobs: "${CI_JOB}": run: "echo ${CI_MARKER}"`,
		`\ton: {change: ["${CI_JOB}"], land: ["${CI_JOB}"]}`,
		'\tlanes: ci: "on-submit"',
		"}",
		"",
	].join("\n");

export const FIXTURE_COMMITS: readonly FixtureCommit[] = [
	{
		subject: "Start the e2e fixture",
		at: T0,
		files: {
			"README.md":
				"# e2e fixture\n\nA deterministic repository for the Tartan e2e suites.\n",
			"ci.cue": ciCue("One job that prints a marker for changes and lands."),
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
	"7c0b7e38c7fa2aad2330458df690bb1e0eec6705",
	"92fb7d65bb38c3bed8172619d43d1fa7eed1d1ee",
	"d47225bffcb488ba90cec19b8e0f8e2ad3a36f17",
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
	"ci.cue",
	"docs",
	"src",
];

/** The paths that differ between the first and the last commit. */
export const FIXTURE_COMPARE_PATHS: readonly string[] = [
	"docs/guide.md",
	"src/router/index.ts",
];

/** The line the last commit adds to the guide (diffs show it). */
export const FIXTURE_GUIDE_LINE = "The router maps paths to handlers.";

// ---------------------------------------------------------------------------
// The M1 loop's repository
// ---------------------------------------------------------------------------

/** The file both loop agents edit. */
export const LOOP_FILE = "src/rate/limits.ts";
/** The project `tartan.cue` declares (`projects: app: root: "src"`). */
export const LOOP_PROJECT = "app";
/** The owners rule's sensitivity (0–3) on `src/**`. */
export const LOOP_SENSITIVITY = 3;

const LIMITS_LINES = [
	"// Rate limits for the e2e loop: one value per line.",
	"export const LIMITS = {",
	"\tread: 100,",
	"\twrite: 10,",
	"\tsearch: 20,",
	"\tupload: 5,",
	"\tadmin: 1,",
	"};",
];

/**
 * The line each agent replaces in `LOOP_FILE` (1-based) and what it was:
 * agent A the third line, agent B the seventh, three unchanged lines apart,
 * so radar sees both lanes in one file while git merges them cleanly.
 */
export const LOOP_EDITS = {
	A: { line: 3, was: "\tread: 100," },
	B: { line: 7, was: "\tadmin: 1," },
} as const;
export type LoopAgent = keyof typeof LOOP_EDITS;

/** `LOOP_FILE` after `who` replaced its line with `text`. */
export const editedLimits = (
	lines: readonly string[],
	who: LoopAgent,
	text: string,
): string[] => lines.map((l, i) => i === LOOP_EDITS[who].line - 1 ? text : l);

export const LOOP_LIMITS_LINES: readonly string[] = LIMITS_LINES;

export const LOOP_COMMITS: readonly FixtureCommit[] = [
	{
		subject: "Configure the loop repository",
		at: T0,
		files: {
			"README.md":
				"# e2e loop\n\nThe M1 loop: claim, lane, push, radar, submit, CI, review, Weave, Advance.\n",
			"tartan.cue": [
				"package tartan",
				"",
				"// One project: everything under src/.",
				`projects: ${LOOP_PROJECT}: root: "src"`,
				"",
			].join("\n"),
			"ci.cue": ciCue("The loop's CI: one job for changes and lands."),
			"review.cue": [
				"package tartan",
				"",
				"// Code under src/ is sensitive: a person reviews every change there.",
				'extensions: "tartan.review": settings: owners: rules: [',
				`\t{paths: ["src/**"], sensitivity: ${LOOP_SENSITIVITY}},`,
				"]",
				"",
			].join("\n"),
			"env.cue": [
				"package cuenv",
				"",
				"// Another tool's root file: the forge must leave it alone.",
				'env: NODE_ENV: "test"',
				"",
			].join("\n"),
		},
	},
	{
		subject: "Add the rate limits",
		at: T0 + 3_600,
		files: { [LOOP_FILE]: `${LIMITS_LINES.join("\n")}\n` },
	},
];

/** The commit SHAs of `LOOP_COMMITS`, oldest first. */
export const LOOP_SHAS: readonly string[] = [
	"c0b2c3f82a7cb9c632c2c80c9af66de693d45246",
	"ff12eb6f84ecae3a226791a2d683970d63b3b70a",
];

export const LOOP_FIXTURE: Fixture = { commits: LOOP_COMMITS, shas: LOOP_SHAS };

/** The root `.cue` files of the loop's trunk, of any package. */
export const LOOP_CUE_FILES: readonly string[] = Object.keys(
	LOOP_COMMITS[0].files,
).filter((f) => f.endsWith(".cue")).sort();

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
// Two lane repositories in one Advance (multi-repo compose)
// ---------------------------------------------------------------------------

/**
 * The Weave's debounce in the compose repo: an overlay of the Swarm group's
 * Weave (`config.repoOverridable`), so the first approved change waits for
 * the second before a batch forms. It is the Weave's maximum (60 s): both
 * approvals must arrive within it, or the changes land through two Advances
 * and the compose test fails on timing, not on the forge.
 */
export const COMPOSE_DEBOUNCE_MS = 60_000;

export const COMPOSE_COMMITS: readonly FixtureCommit[] = [
	{
		subject: "Configure a patient Weave",
		at: T0,
		files: {
			"README.md":
				"# e2e compose\n\nTwo lane repositories land through one Advance.\n",
			"ci.cue": ciCue("One job that prints a marker for changes and lands."),
			"weave.cue": [
				"package tartan",
				"",
				"// The Weave waits for a second approved change before a batch forms.",
				`extensions: "tartan.weave": settings: debounceMs: ${COMPOSE_DEBOUNCE_MS}`,
				"",
			].join("\n"),
		},
	},
];

export const COMPOSE_SHAS: readonly string[] = [
	"7b2f125c739bb69dcb5805bfb3f6b0d364e7c485",
];

export const COMPOSE_FIXTURE: Fixture = {
	commits: COMPOSE_COMMITS,
	shas: COMPOSE_SHAS,
};

// ---------------------------------------------------------------------------
// A Swarm repo whose queue@1 an Owner swaps to FIFO
// ---------------------------------------------------------------------------

/**
 * Every change is routed to a person (an owners rule of sensitivity 3 on
 * every path), because FIFO lands only what a person approved.
 */
export const SWAP_COMMITS: readonly FixtureCommit[] = [
	{
		subject: "Route every change to a person",
		at: T0,
		files: {
			"README.md":
				"# e2e queue swap\n\nAn Owner swaps the queue@1 provider of this repository.\n",
			"ci.cue": ciCue("One job that prints a marker for changes and lands."),
			"review.cue": [
				"package tartan",
				"",
				"// A person reviews every change here.",
				'extensions: "tartan.review": settings: owners: rules: [',
				'\t{paths: ["**"], sensitivity: 3},',
				"]",
				"",
			].join("\n"),
		},
	},
];

export const SWAP_SHAS: readonly string[] = [
	"e1bfbd96b76e9b73a000e0fadb08867d9b8a431e",
];

export const SWAP_FIXTURE: Fixture = { commits: SWAP_COMMITS, shas: SWAP_SHAS };

// ---------------------------------------------------------------------------
// A monorepo whose projects are cuenv `#Project`s
// ---------------------------------------------------------------------------

const CUENV_IMPORT = 'import "github.com/cuenv/cuenv/schema"';

/** The two cuenv projects of the monorepo fixture: name, root. */
export const MONOREPO_PROJECTS = {
	design: { name: "e2e-design", root: "packages/design" },
	web: { name: "e2e-web", root: "apps/web" },
} as const;
export type MonorepoProject = keyof typeof MONOREPO_PROJECTS;

const cuenvProject = (name: string): string =>
	[
		"package cuenv",
		"",
		CUENV_IMPORT,
		"",
		"schema.#Project",
		"",
		`name: "${name}"`,
		"",
		"tasks: check: schema.#Task & {",
		'\tcommand: "bun"',
		'\targs: ["run", "check"]',
		"}",
		"",
	].join("\n");

export const MONOREPO_COMMITS: readonly FixtureCommit[] = [
	{
		subject: "Lay out the monorepo",
		at: T0,
		files: {
			"README.md":
				"# e2e monorepo\n\nTwo cuenv projects: a design system and a website.\n",
			"ci.cue": ciCue("One job that prints a marker for changes and lands."),
			// A CUE module root: cuenv's projects live in one (the detector reads
			// nothing without it). No deps: package tartan imports none.
			"cue.mod/module.cue": [
				'module: "example.com/e2e/monorepo"',
				'language: version: "v0.14.0"',
				"",
			].join("\n"),
			"env.cue": [
				"package cuenv",
				"",
				CUENV_IMPORT,
				"",
				"// The root layer: every project inherits it.",
				"schema.#Base",
				"",
				'env: LOG_LEVEL: "info"',
				"",
			].join("\n"),
			[`${MONOREPO_PROJECTS.design.root}/env.cue`]: cuenvProject(
				MONOREPO_PROJECTS.design.name,
			),
			[`${MONOREPO_PROJECTS.design.root}/README.md`]:
				"# Design system\n\nTokens and components for the e2e website.\n",
			[`${MONOREPO_PROJECTS.design.root}/src/tokens.ts`]:
				'export const brand = "#5b21b6";\n',
			[`${MONOREPO_PROJECTS.web.root}/env.cue`]: cuenvProject(
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
	"d8b16b446a440729275c1d33787d453fd1956f57",
];

export const MONOREPO_FIXTURE: Fixture = {
	commits: MONOREPO_COMMITS,
	shas: MONOREPO_SHAS,
};

// ---------------------------------------------------------------------------
// Repository config in CUE, end to end
// ---------------------------------------------------------------------------

/** The jobs of the CUE suite's pipeline (`tartan.ci`). */
export const CUE_JOBS = ["e2e-check", "e2e-lint"] as const;
/** The owners rule's paths: a change there is routed to a person. */
export const CUE_OWNED = "docs/**";
/** The project the config names. */
export const CUE_PROJECT = "app";

/** `ci.cue` with `jobs` (each prints `<job>-ok`), run for changes and lands. */
export const cueCi = (jobs: readonly string[]): string =>
	[
		"package tartan",
		"",
		"// The pipeline: every job runs for changes and lands.",
		'extensions: "tartan.ci": settings: pipeline: {',
		...jobs.map((j) => `\tjobs: "${j}": run: "echo ${j}-ok"`),
		`\ton: {change: [${jobs.map((j) => `"${j}"`).join(", ")}], land: [${
			jobs.map((j) => `"${j}"`).join(", ")
		}]}`,
		'\tlanes: ci: "on-submit"',
		"}",
		"",
	].join("\n");

export const CUE_COMMITS: readonly FixtureCommit[] = [
	{
		subject: "Configure the repository in CUE",
		at: T0,
		files: {
			"README.md":
				"# e2e cue\n\nThe root package tartan configures CI, review and projects.\n",
			"tartan.cue": [
				"package tartan",
				"",
				"// One project: everything under src/.",
				`projects: ${CUE_PROJECT}: root: "src"`,
				"",
			].join("\n"),
			"ci.cue": cueCi(CUE_JOBS),
			"review.cue": [
				"package tartan",
				"",
				"// The docs are owned: a person reviews every change there.",
				'extensions: "tartan.review": settings: owners: rules: [',
				`\t{paths: ["${CUE_OWNED}"], sensitivity: 3},`,
				"]",
				"",
			].join("\n"),
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
	"73547929020ea903deeb82b7448106d93318ac97",
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
