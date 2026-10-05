// A synthesized tree with the shape of the demo mirror (the public, MIT
// `rawkode-academy/rawkode-academy` monorepo): its 38 cuenv `#Project` roots
// and names, its three `#Base` layers, 13 `service.cue` files, one
// `package codegen` file, one clause-less `.cue` file, one nested CUE module
// inside a project, a Bun workspace whose members reach across projects, a
// CODEOWNERS file, and two `package tartan` files for the clause reader.
// File contents are written for this fixture (shapes only): no task bodies,
// environment values or secrets of the real repository.
//
// Shared by the detector goldens, the kernel API tests, the workerd test and
// the live script (`scripts/live/wp25-projects.ts`), which pushes it as a repo.

/** `[name, root, form]`: `line` is `schema.#Project` + `name:`; `block` is `schema.#Project & { name: … }`. */
export const CUENV_DEMO_PROJECTS: readonly (readonly [
	string,
	string,
	"line" | "block",
])[] = [
	["rawkode-academy-design-system", "packages/design-system", "line"],
	[
		"presentation-lets-meet-cdktf-python",
		"presentations/lets-meet-cdktf-python",
		"line",
	],
	["cloudnativecompass-fm", "projects/cloudnativecompass.fm", "line"],
	["code-rawkode-academy", "projects/code.rawkode.academy", "block"],
	["klustered-dev", "projects/klustered.dev", "line"],
	["rawkode-academy-api", "projects/rawkode.academy/api", "line"],
	["rawkode-academy-content", "projects/rawkode.academy/content", "line"],
	...[
		"achievements",
		"leaderboard",
		"player-learned-phrases",
		"player-stats",
		"share-cards",
	].map((g) =>
		[
			`rawkode-academy-game-sok-${g}`,
			`projects/rawkode.academy/games/secrets-of-kubernetes/${g}`,
			"line",
		] as const
	),
	["rawkode-academy-identity", "projects/rawkode.academy/identity", "line"],
	...[
		"achievements",
		"brackets",
		"email-preferences",
		"email-service",
		"emoji-reactions",
		"image-service",
		"leaderboard",
		"notifications",
		"search",
		"studio-recording-ingest",
		"transcriptions",
		"video-thumbnails",
		"watch-history",
		"zitadel-zulip-connector",
	].map((s) =>
		[
			`rawkode-academy-platform-${s}`,
			`projects/rawkode.academy/platform/${s}`,
			"line",
		] as const
	),
	...["random-social-post", "remove-content-prefix", "video-importer"].map((
		t,
	) =>
		[
			`rawkode-academy-task-${t}`,
			`projects/rawkode.academy/tasks/${t}`,
			"line",
		] as const
	),
	["rawkode-academy-website", "projects/rawkode.academy/website", "line"],
	["rawkode-arcade", "projects/rawkode.arcade", "line"],
	["rawkode-cloud", "projects/rawkode.cloud", "block"],
	["rawkode-link", "projects/rawkode.link", "line"],
	["rawkode-news", "projects/rawkode.news", "line"],
	["rawkode-academy-studio", "projects/rawkode.studio", "line"],
	[
		"rawkode-tools-observability-collector",
		"projects/rawkode.tools/observability-collector",
		"line",
	],
	["rawkode-tools-star-catcher", "projects/rawkode.tools/star-catcher", "line"],
];

/** The `#Base` layer directories ("" is the repo root). */
export const CUENV_DEMO_LAYERS = ["", "projects", "projects/rawkode.academy"];

/** Project roots holding a `service.cue` beside `env.cue`. */
export const CUENV_DEMO_SERVICES = [
	"projects/rawkode.academy/content",
	...[
		"achievements",
		"leaderboard",
		"player-learned-phrases",
		"player-stats",
		"share-cards",
	].map((g) => `projects/rawkode.academy/games/secrets-of-kubernetes/${g}`),
	...[
		"achievements",
		"brackets",
		"email-preferences",
		"email-service",
		"emoji-reactions",
		"leaderboard",
		"watch-history",
	].map((s) => `projects/rawkode.academy/platform/${s}`),
];

/** The nested CUE module (its own `cue.mod/`), inside a project. */
export const CUENV_DEMO_NESTED = "projects/code.rawkode.academy/config";

const IMPORT = 'import "github.com/cuenv/cuenv/schema"';

const projectEnv = (name: string, form: "line" | "block"): string =>
	form === "line"
		? `package cuenv

${IMPORT}

schema.#Project

name: "${name}"

tasks: {
	check: schema.#Task & {
		command: "bun"
		args: ["run", "check"]
		inputs: ["src/**", "package.json"]
	}
}
`
		: `package cuenv

${IMPORT}

schema.#Project & {
	name: "${name}"

	tasks: {
		render: schema.#Task & {
			command: "kubectl"
			args: ["kustomize", "./gitops"]
			// A string that mentions schema.#Project is not a declaration.
			description: "renders the schema.#Project manifests"
		}
	}
}
`;

const layerEnv = (comment: string): string =>
	`package cuenv

${IMPORT}

// ${comment}
schema.#Base

env: {
	LOG_LEVEL: "info"
	environment: production: LOG_LEVEL: "warn"
}
`;

const ROOT_ENV = `package cuenv

${IMPORT}

let _note = """
	A multi-line string: these lines are not declarations.
	schema.#Project
	name: "not-a-project"
	"""

// The repository's root layer: every project inherits it.
schema.#Base

ci: providers: ["github"]
hooks: onEnter: note: _note
`;

const service = (dir: string): string =>
	`package cuenv

import gen "github.com/rawkode-academy/rawkode-academy/projects/rawkode.academy/codegen"

_service: gen.#PlatformService & {
	serviceName: "${dir.split("/").at(-1)}"
}
`;

const pkg = (
	name: string,
	deps: Readonly<Record<string, string>> = {},
	scripts: Readonly<Record<string, string>> = {},
): string =>
	`${
		JSON.stringify(
			{
				name,
				private: true,
				...(Object.keys(scripts).length > 0 ? { scripts } : {}),
				...(Object.keys(deps).length > 0 ? { dependencies: deps } : {}),
			},
			null,
			"\t",
		)
	}\n`;

/** The fixture tree, `path → content`. */
export const CUENV_DEMO_FILES: Readonly<Record<string, string>> = {
	"README.md": "# rawkode-academy (fixture)\n\nA cuenv monorepo.\n",
	"AGENTS.md": "# Agents\n\nRun `cuenv task` from a project directory.\n",
	"CLAUDE.md": "See AGENTS.md.\n",
	"CODEOWNERS": "* @rawkode\n/projects/rawkode.studio/**/* @icepuma\n",
	"cue.mod/module.cue": `module: "github.com/rawkode-academy/rawkode-academy"
language: {
	version: "v0.14.0"
}
deps: {
	"github.com/cuenv/cuenv@v0": {
		v: "v0.55.1"
	}
}
`,
	"env.cue": ROOT_ENV,
	"tartan.cue": `package tartan

// Repository config (ADR repo config): the root package tartan.
extensions: {}
`,
	"package.json": `${
		JSON.stringify(
			{
				name: "rawkodeacademy",
				private: true,
				workspaces: [
					"content",
					"packages/**",
					"projects/**",
					"!projects/**/generators/**",
				],
			},
			null,
			"\t",
		)
	}\n`,
	"bun.lock": '{\n\t"lockfileVersion": 1,\n\t"workspaces": {}\n}\n',
	"content/package.json": pkg("@rawkodeacademy/content"),
	"content/courses/intro.md": "# Intro\n",
	"packages/design-system/package.json": pkg(
		"@rawkodeacademy/design-system",
		{},
		{ build: "vite build", check: "astro check" },
	),
	"packages/design-system/README.md":
		"# Design system\n\nShared components for every site.\n",
	"packages/design-system/tartan.cue":
		`// The project's own config (slice C, after submission).
package tartan

extensions: {}
`,
	"packages/design-system/src/button.ts":
		"export const button = (label: string) => `<button>${label}</button>`;\n",
	"presentations/lets-meet-cdktf-python/cdktf/policy.cue":
		'import "strings"\n\nallowed: strings.HasPrefix("aws_", "aws_")\n',
	"projects/env.cue": layerEnv("Every site under projects/ inherits this."),
	"projects/rawkode.academy/env.cue": layerEnv(
		"The rawkode.academy platform layer.",
	),
	"projects/rawkode.academy/AGENTS.md":
		"# rawkode.academy\n\nPlatform services and the website.\n",
	"projects/rawkode.academy/codegen/platform-service.cue": `package codegen

#PlatformService: {
	serviceName: string
}
`,
	[`${CUENV_DEMO_NESTED}/cue.mod/module.cue`]:
		'module: "rawkode.academy/code/config"\nlanguage: version: "v0.14.0"\n',
	[`${CUENV_DEMO_NESTED}/config.cue`]: "package config\n\nreplicas: 2\n",
	"projects/rawkode.academy/website/package.json": pkg(
		"website",
		{
			"@rawkodeacademy/design-system": "workspace:*",
			"@rawkodeacademy/content": "workspace:*",
			"notifications": "workspace:*",
		},
		{ build: "astro build", test: "vitest run" },
	),
	"projects/rawkode.academy/website/CLAUDE.md":
		"# website\n\nAstro site; `bun run dev`.\n",
	"projects/rawkode.academy/website/src/pages/index.astro": "<h1>Home</h1>\n",
	"projects/rawkode.academy/platform/notifications/package.json": pkg(
		"notifications",
		{},
		{ test: "vitest run" },
	),
	"projects/rawkode.academy/platform/youtube-scraper/package.json": pkg(
		"youtube-scraper",
	),
	"projects/rawkode.studio/package.json": pkg("@rawkode/studio", {
		"notifications": "workspace:*",
	}),
	"projects/rawkode.academy/api/package.json": pkg("api"),
	"projects/klustered.dev/package.json": pkg("klustered-dev"),
	...Object.fromEntries(
		CUENV_DEMO_PROJECTS.map((
			[name, root, form],
		) => [`${root}/env.cue`, projectEnv(name, form)]),
	),
	...Object.fromEntries(
		CUENV_DEMO_SERVICES.map((dir) => [`${dir}/service.cue`, service(dir)]),
	),
};
