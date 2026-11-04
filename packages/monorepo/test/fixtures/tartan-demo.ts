// A synthesized monorepo for the project detector and the kernel's projects API:
// `package tartan` directories under any filename, with and without a literal
// name, literal deps, a project with Issues switched off, a project under a
// project, other CUE packages beside them, and files no project claims.

export const FORGE = (body = ""): string => `package tartan\n\n${body}`;

/** `[name, root, manifest]`. */
export const TARTAN_DEMO_PROJECTS: readonly (readonly [
	string,
	string,
	string,
])[] = [
	["rawkode-academy-design-system", "packages/design-system", "forge.cue"],
	["rawkode-academy-content", "projects/rawkode.academy/content", "forge.cue"],
	[
		"rawkode-academy-platform-notifications",
		"projects/rawkode.academy/platform/notifications",
		"forge.cue",
	],
	["rawkode-academy-website", "projects/rawkode.academy/website", "site.cue"],
	["studio", "projects/studio", "whatever.cue"],
	["docs", "projects/studio/docs", "forge.cue"],
];

export const TARTAN_DEMO_FILES: Readonly<Record<string, string>> = {
	"tartan.cue": 'package tartan\n\nglobal: ["tools/**"]\n',
	"cue.mod/module.cue":
		'module: "example.com/demo"\nlanguage: version: "v0.14.0"\n',
	"package.json": '{"name":"demo","private":true}\n',
	"bun.lock": '{\n\t"lockfileVersion": 1\n}\n',
	"AGENTS.md": "# demo\n\nThe demo repository.\n",
	"tools/gen.sh": "echo gen\n",
	"tools/codegen/service.cue": "package codegen\n\nreplicas: 2\n",
	"packages/design-system/README.md":
		"# Design system\n\nShared components for every site.\n",
	"packages/design-system/forge.cue": FORGE(
		'name: "rawkode-academy-design-system"\n',
	),
	"packages/design-system/src/button.ts": "export const button = 1;\n",
	"projects/rawkode.academy/AGENTS.md": "# rawkode.academy\n",
	"projects/rawkode.academy/content/forge.cue": FORGE(
		'name: "rawkode-academy-content"\n\nextensions: "rawkode.issues": enabled: false\n',
	),
	"projects/rawkode.academy/platform/notifications/forge.cue": FORGE(
		'name: "rawkode-academy-platform-notifications"\n',
	),
	"projects/rawkode.academy/website/site.cue": FORGE(
		`name: "rawkode-academy-website"
deps: [
	"rawkode-academy-design-system",
	"rawkode-academy-platform-notifications",
]
`,
	),
	"projects/rawkode.academy/website/CLAUDE.md": "# website\n",
	"projects/rawkode.academy/website/src/index.ts": "export {};\n",
	"projects/studio/whatever.cue": FORGE(),
	"projects/studio/docs/forge.cue": FORGE('name: "docs"\n'),
};
