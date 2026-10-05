// Project resolution and the page filters (WP25 slice A′): every project
// gets a slug (workspace graphs included), a project resolves by slug,
// root, graph name or raw cuenv name, and the filters keep exactly the
// items and changes that belong to it.

import { deepStrictEqual, equal } from "node:assert/strict";
import type { Change, ProjectGraph, WorkItem } from "@tartan/contract";
import { createProjectIndex } from "@tartan/monorepo";
import { filterChanges, workMatch } from "./filter.ts";
import { projectView, resolveProject } from "./resolve.ts";

const graphOf = (projects: object[]): ProjectGraph =>
	({
		sha: "a".repeat(40),
		manifestsTreeSha: "b".repeat(64),
		projects: projects.map((p) => ({
			deps: [],
			dependents: [],
			owners: [],
			sensitive: false,
			source: "pnpm-workspace",
			...p,
		})),
		globalFiles: [],
	}) as unknown as ProjectGraph;

Deno.test("view: workspace projects get unique slugs from their names", () => {
	const view = projectView(graphOf([
		{ name: "@acme/web", root: "apps/web" },
		{ name: "acme-web", root: "apps/acme-web" },
		{ name: "Shared", root: "packages/shared" },
	]));
	deepStrictEqual(view.projects.map((p) => [p.root, p.slug, p.key]), [
		["apps/acme-web", "acme-web", "apps/acme-web"],
		["apps/web", "acme-web-2", "apps/web"],
		["packages/shared", "shared", "packages/shared"],
	]);
});

Deno.test("resolve: slug, then root, then name, then cuenv name", () => {
	const view = projectView(graphOf([
		{ name: "api", root: "a", slug: "api", source: "cuenv" },
		{ name: "api@b", root: "b", slug: "api-b", cuenvName: "api" },
		{ name: "web", root: "api-b", slug: "web" },
	]));
	equal(resolveProject(view, "api")?.root, "a");
	equal(resolveProject(view, "api-b")?.root, "b", "a slug beats a root");
	equal(resolveProject(view, "b")?.name, "api@b");
	equal(resolveProject(view, "api@b")?.root, "b");
	equal(resolveProject(view, "web")?.root, "api-b");
	equal(resolveProject(view, "nope"), null);
});

Deno.test("filters: footprints and affected sets", () => {
	const graph = graphOf([
		{ name: "ds", root: "packages/ds", slug: "ds" },
		{ name: "ds-docs", root: "packages/ds/docs", slug: "ds-docs" },
	]);
	const view = projectView(graph);
	const ds = resolveProject(view, "ds")!;
	const { projectOf } = createProjectIndex(graph);
	const fp = (projects: string[], prefixes: string[] = []) => ({
		footprint: { projects, prefixes },
	} as Pick<WorkItem, "footprint">);
	equal(workMatch(fp(["ds"]), ds, projectOf), "project");
	equal(workMatch(fp(["packages/ds"]), ds, projectOf), "project");
	equal(workMatch(fp([], ["./packages/ds/src/"]), ds, projectOf), "prefix");
	equal(workMatch(fp([], ["packages/ds/docs"]), ds, projectOf), null);
	equal(workMatch(fp([], ["packages"]), ds, projectOf), null);
	equal(workMatch(fp([], [""]), ds, projectOf), null);
	const changes = [
		{ changeId: "x", revisions: [] },
		{
			changeId: "y",
			revisions: [{ n: 2, affected: ["ds"] }, { n: 1, affected: [] }],
		},
		{ changeId: "z", revisions: [{ n: 1, affected: ["*"] }] },
	].map((c) => ({
		title: c.changeId,
		state: "draft",
		laneId: "l",
		author: "u",
		...c,
	})) as unknown as Change[];
	deepStrictEqual(
		filterChanges(ds, changes).map((c) => [c.changeId, c.revision, c.global]),
		[["y", 2, false], ["z", 1, true]],
	);
});
