// The sample's repos through the real project detector: what the live forge
// should discover from them, and that each named project exists.

import { deepStrictEqual } from "node:assert/strict";
import { createTreeView, detectProjects } from "@tartan/monorepo";
import { createMemGit } from "../../packages/monorepo/test/memgit.ts";
import { filesOf, pathOf, SAMPLE_REPOS, type SampleRepo } from "./sample.ts";

const graphOf = async (repo: SampleRepo) => {
	const git = createMemGit();
	return await detectProjects(
		createTreeView(git.objects, git.writeTree(filesOf(repo))),
	);
};

const repo = (path: string): SampleRepo => {
	const found = SAMPLE_REPOS.find((r) => pathOf(r) === path);
	if (found === undefined) throw new Error(`no repo ${path}`);
	return found;
};

const summary = async (path: string) =>
	(await graphOf(repo(path))).projects.map((p) => ({
		name: p.name,
		root: p.root,
		manifest: p.manifestPath,
		deps: [...p.deps],
		issues: p.extensions?.["rawkode.issues"]?.enabled,
	})).sort((a, b) => a.root < b.root ? -1 : 1);

Deno.test("kiln: its projects, under any filename, ignoring the env.cue beside one", async () => {
	deepStrictEqual(await summary("oss/devtools/build/kiln"), [
		{
			name: "cli",
			root: "crates/cli",
			manifest: "crates/cli/forge.cue",
			deps: ["core"],
			issues: true,
		},
		{
			name: "core",
			root: "crates/core",
			manifest: "crates/core/forge.cue",
			deps: [],
			issues: true,
		},
		{
			name: "lsp",
			root: "crates/lsp",
			manifest: "crates/lsp/forge.cue",
			deps: ["core"],
			issues: true,
		},
		{
			name: "vscode",
			root: "editors/vscode",
			manifest: "editors/vscode/tartan.cue",
			deps: ["lsp"],
			issues: true,
		},
		{
			name: "registry",
			root: "services/registry",
			manifest: "services/registry/forge.cue",
			deps: ["core"],
			issues: true,
		},
		{
			name: "docs",
			root: "site/docs",
			manifest: "site/docs/forge.cue",
			deps: [],
			issues: false,
		},
	]);
});

Deno.test("platform: a literal name wins over the directory", async () => {
	deepStrictEqual(await summary("infra/cloud/platform"), [
		{
			name: "deploy",
			root: "deploy/terraform",
			manifest: "deploy/terraform/forge.cue",
			deps: ["gateway"],
			issues: true,
		},
		{
			name: "shared",
			root: "libs/shared",
			manifest: "libs/shared/forge.cue",
			deps: [],
			issues: true,
		},
		{
			name: "gateway",
			root: "services/gateway",
			manifest: "services/gateway/forge.cue",
			deps: ["shared"],
			issues: true,
		},
	]);
});

Deno.test("the other repos are single projects", async () => {
	for (const path of ["oss/devtools/build/remote-cache", "writing/blog"]) {
		deepStrictEqual(await summary(path), [], path);
	}
	deepStrictEqual(await summary("dotfiles"), []);
});

Deno.test("every seeded issue names a project that exists and has Issues on", async () => {
	for (const r of SAMPLE_REPOS) {
		const graph = await graphOf(r);
		for (const issue of r.seedIssues) {
			if (issue.project === undefined) continue;
			const project = graph.projects.find((p) => p.name === issue.project);
			deepStrictEqual(
				project?.extensions?.["rawkode.issues"]?.enabled,
				true,
				`${pathOf(r)}: ${issue.title}`,
			);
		}
	}
});

Deno.test("only a repo with Issues gets seeded issues", () => {
	for (const r of SAMPLE_REPOS) {
		if (!r.issues) deepStrictEqual(r.seedIssues, [], pathOf(r));
	}
});
