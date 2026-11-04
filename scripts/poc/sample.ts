// The sample forge `deno task poc` seeds: the hierarchy, each repo's real git
// history, which repos have Issues and the issues they start with. Data only,
// so `sample.test.ts` can run the real project detector over it.

/** A commit: its files, written over the one before. */
export type SampleCommit = {
	readonly message: string;
	readonly files: Readonly<Record<string, string>>;
};

/** An issue the seed opens through the tool route. */
export type SampleIssue = {
	readonly title: string;
	readonly body?: string;
	/** A project's name; repo-wide without one. */
	readonly project?: string;
	/** Closed after it is opened. */
	readonly closed?: true;
};

export type SampleRepo = {
	/** The parent group's path; absent at the top of the tree. */
	readonly parent?: string;
	readonly slug: string;
	readonly description: string;
	/** Whether Issues is installed on it. */
	readonly issues: boolean;
	readonly commits: readonly SampleCommit[];
	readonly seedIssues: readonly SampleIssue[];
};

/** Created in order, so a parent comes before its children. */
export const SAMPLE_GROUPS: readonly (readonly [string, string])[] = [
	["oss", "Open source"],
	["oss/devtools", "Developer tools"],
	["oss/devtools/build", "Build tooling"],
	["infra", "Infrastructure"],
	["infra/cloud", "Cloud"],
	["writing", "Writing"],
];

const crate = (name: string, deps = ""): string =>
	`[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n${deps}`;

const forge = (body = ""): string =>
	`package tartan\n${body === "" ? "" : `\n${body}\n`}`;

const KILN: SampleRepo = {
	parent: "oss/devtools/build",
	slug: "kiln",
	description: "A build system, its language server and its registry",
	issues: true,
	commits: [
		{
			message: "chore: start the kiln workspace",
			files: {
				"README.md":
					"# kiln\n\nA build system. The crates are under `crates/`, the registry under `services/`, and the editor support under `editors/`.\n",
				"Cargo.toml":
					'[workspace]\nresolver = "2"\nmembers = ["crates/core", "crates/cli", "crates/lsp"]\n',
				".gitignore": "target/\nnode_modules/\n",
			},
		},
		{
			message: "feat(core): add the build graph",
			files: {
				"crates/core/forge.cue": forge(),
				"crates/core/Cargo.toml": crate("kiln-core"),
				"crates/core/src/lib.rs":
					"/// A target and the targets it needs first.\npub struct Target {\n\tpub name: String,\n\tpub needs: Vec<String>,\n}\n",
			},
		},
		{
			message: "feat(cli): add the kiln command",
			files: {
				"crates/cli/forge.cue": forge('deps: ["core"]'),
				"crates/cli/Cargo.toml": crate(
					"kiln-cli",
					'kiln-core = { path = "../core" }\n',
				),
				"crates/cli/src/main.rs":
					'fn main() {\n\tprintln!("kiln: nothing to build");\n}\n',
			},
		},
		{
			message: "feat(lsp): serve diagnostics to editors",
			files: {
				"crates/lsp/forge.cue": forge('deps: ["core"]'),
				"crates/lsp/Cargo.toml": crate(
					"kiln-lsp",
					'kiln-core = { path = "../core" }\n',
				),
				"crates/lsp/src/main.rs":
					'fn main() {\n\teprintln!("kiln-lsp: listening on stdio");\n}\n',
			},
		},
		{
			message: "feat(registry): add the package registry",
			files: {
				"services/registry/forge.cue": forge('deps: ["core"]'),
				// Another CUE package beside the project. Nothing in it counts: not the
				// name, not the deps, not the switch.
				"services/registry/env.cue":
					'package cuenv\n\nname: "not-the-registry"\ndeps: ["cli"]\nextensions: "rawkode.issues": enabled: false\n',
				"services/registry/main.go":
					'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("registry: serving")\n}\n',
			},
		},
		{
			message: "feat(vscode): add the editor extension",
			files: {
				"editors/vscode/tartan.cue": forge('deps: ["lsp"]'),
				"editors/vscode/package.json":
					'{\n\t"name": "kiln-vscode",\n\t"version": "0.1.0",\n\t"private": true\n}\n',
				"editors/vscode/src/extension.ts":
					'export const activate = (): void => {\n\tconsole.log("kiln: activated");\n};\n',
			},
		},
		{
			message: "docs: add the documentation site",
			files: {
				"site/docs/forge.cue": forge(
					'extensions: "rawkode.issues": enabled: false',
				),
				"site/docs/index.md":
					"# kiln\n\nReport problems against the crates, not this site.\n",
			},
		},
	],
	seedIssues: [
		{
			title: "The language server drops diagnostics on save",
			body: "Save twice quickly and the second set never reaches the editor.",
			project: "lsp",
		},
		{
			title: "Hover shows the wrong target on a generated file",
			project: "lsp",
		},
		{
			title: "A cycle in the build graph hangs instead of failing",
			body: "`Target.needs` is never checked for cycles.",
			project: "core",
		},
		{
			title: "kiln --help lists no subcommands",
			project: "cli",
			closed: true,
		},
		{
			title: "The registry answers 500 on an unknown version",
			project: "registry",
		},
		{
			title: "Bundle the language server with the extension",
			project: "vscode",
		},
		{
			title: "Agree the minimum supported Rust version",
			body: "Across the whole workspace, so this one is repo-wide.",
		},
	],
};

const REMOTE_CACHE: SampleRepo = {
	parent: "oss/devtools/build",
	slug: "remote-cache",
	description: "A content-addressed cache for build outputs",
	issues: true,
	commits: [
		{
			message: "feat: serve blobs by digest",
			files: {
				"README.md":
					"# remote-cache\n\nStores build outputs by digest, so a second machine never builds them again.\n",
				"Cargo.toml": crate("remote-cache"),
				"src/main.rs":
					'fn main() {\n\tprintln!("remote-cache: serving on :9092");\n}\n',
			},
		},
		{
			message: "feat: evict the least recently read blobs",
			files: {
				"src/evict.rs":
					"/// Blobs to drop until the store fits in `limit` bytes.\npub fn evict(limit: u64) -> u64 {\n\tlimit\n}\n",
			},
		},
	],
	seedIssues: [
		{
			title: "Eviction ignores blobs still being uploaded",
			body: "A blob mid-upload can be dropped before it finishes.",
		},
		{
			title: "Expose the hit rate as a metric",
			closed: true,
		},
	],
};

const PLATFORM: SampleRepo = {
	parent: "infra/cloud",
	slug: "platform",
	description: "The shared libraries, the gateway and how they deploy",
	issues: true,
	commits: [
		{
			message: "chore: start the platform monorepo",
			files: {
				"README.md":
					"# platform\n\nThe shared libraries, the gateway and the Terraform that deploys them.\n",
			},
		},
		{
			message: "feat(shared): add the request id",
			files: {
				"libs/shared/forge.cue": forge(),
				"libs/shared/request.ts":
					"export const requestId = (): string => crypto.randomUUID();\n",
			},
		},
		{
			message: "feat(gateway): route by host",
			files: {
				"services/gateway/forge.cue": forge('deps: ["shared"]'),
				"services/gateway/main.ts":
					'import { requestId } from "../../libs/shared/request.ts";\n\nconsole.log(requestId());\n',
			},
		},
		{
			message: "feat(deploy): deploy the gateway with Terraform",
			files: {
				"deploy/terraform/forge.cue": forge(
					'name: "deploy"\ndeps: ["gateway"]',
				),
				"deploy/terraform/main.tf":
					'terraform {\n\trequired_version = ">= 1.9"\n}\n',
			},
		},
	],
	seedIssues: [
		{
			title: "The gateway drops the request id on a retry",
			project: "gateway",
		},
		{
			title: "Pin the provider versions",
			project: "deploy",
		},
		{
			title: "Rotate the shared signing key",
		},
	],
};

const BLOG: SampleRepo = {
	parent: "writing",
	slug: "blog",
	description: "Posts",
	issues: true,
	commits: [
		{
			message: "post: why a forge should own its trunk",
			files: {
				"README.md": "# blog\n\nPosts, one Markdown file each.\n",
				"posts/owning-the-trunk.md":
					"# Owning the trunk\n\nA draft about who may move `main`.\n",
			},
		},
		{
			message: "post: projects are directories",
			files: {
				"posts/projects-are-directories.md":
					"# Projects are directories\n\nThere is no list. A file says so.\n",
			},
		},
	],
	seedIssues: [
		{ title: "Fix the broken link in the trunk post" },
	],
};

// At the top of the tree, with no group above it. It has no Issues: the proof
// reads 404 not_installed from it.
export const DOTFILES: SampleRepo = {
	slug: "dotfiles",
	description: "Shell and editor configuration",
	issues: false,
	commits: [
		{
			message: "feat: add the shell configuration",
			files: {
				"README.md": "# dotfiles\n\nLinked into place by hand.\n",
				"zshrc": "export EDITOR=hx\n",
			},
		},
	],
	seedIssues: [],
};

export const SAMPLE_REPOS: readonly SampleRepo[] = [
	KILN,
	REMOTE_CACHE,
	PLATFORM,
	BLOG,
	DOTFILES,
];

export const pathOf = (repo: SampleRepo): string =>
	repo.parent === undefined ? repo.slug : `${repo.parent}/${repo.slug}`;

/** A repo's files at its last commit. */
export const filesOf = (repo: SampleRepo): Record<string, string> =>
	Object.assign({}, ...repo.commits.map((c) => c.files));
