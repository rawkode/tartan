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
