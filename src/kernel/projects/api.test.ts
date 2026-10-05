// The projects API over fakes (WP25 slice A′): reads follow the repo, `?sha=` needs Reporter+
// and a trunk commit, the project segment resolves by slug, root or name,
// README and agent docs are found, and the Issues and Pull requests lists
// are the providers' tools called as the viewer, filtered by footprint and
// affected set.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { CUENV_DEMO_FILES } from "../../../packages/monorepo/test/fixtures/cuenv-demo.ts";
import { createAdmission } from "./deps.ts";
import type {
	ProjectChangesResponse,
	ProjectDetailResponse,
	ProjectIssuesResponse,
	ProjectsResponse,
} from "@tartan/contract";
import {
	authOf,
	DS,
	fakes,
	get,
	GUEST,
	item,
	OLD,
	OWNER,
	REPO_ID,
	TIP,
	WEB,
} from "./testing/fakes.ts";

Deno.test("off: every projects route is 404", async () => {
	const f = fakes({ mode: "off" });
	for (const rest of ["", `/${DS}`, `/${DS}/issues`]) {
		equal((await get(f, rest)).status, 404, rest);
	}
});

Deno.test("list: the trunk graph, served to an anonymous reader of a public repo", async () => {
	const f = fakes();
	const { status, body } = await get<ProjectsResponse>(f, "", null);
	equal(status, 200);
	equal(body.sha, TIP);
	equal(body.detector, "cuenv");
	equal(body.fidelity, "scan");
	equal(body.projects.length, 38);
	deepStrictEqual(body.repo, { id: REPO_ID, path: "rawkode/academy" });
	deepStrictEqual(body.layers.map((l) => l.root), [
		"",
		"projects",
		"projects/rawkode.academy",
	]);
	deepStrictEqual(body.skipped, ["projects/code.rawkode.academy/config"]);
	equal(body.truncated, false);
	ok(body.global.includes("bun.lock"));
	const ds = body.projects.find((p) => p.name === DS)!;
	deepStrictEqual(
		[ds.slug, ds.root, ds.key, ds.source, ds.dependents],
		[DS, "packages/design-system", "packages/design-system", "cuenv", [WEB]],
	);
	deepStrictEqual(f.graphCalls, [TIP]);
});

Deno.test("list: a private repo is 404 to a reader who may not see it; a repo without commits has no graph", async () => {
	const f = fakes({ visibility: "private" });
	equal((await get(f, "", null)).status, 404);
	equal((await get(f, "", authOf(GUEST))).status, 403);
	equal((await get(f, "")).status, 200);
	equal((await get(f, "", null, "01k6zzzzzzzzzzzzzzzzzzzzzz")).status, 404);
	equal((await get(f, "", null, "not-a-ulid")).status, 404);
	const empty = await get<ProjectsResponse>(fakes({ trunkSha: null }), "");
	deepStrictEqual([empty.status, empty.body.sha, empty.body.projects], [
		200,
		null,
		[],
	]);
	equal((await get(fakes({ trunkSha: null }), `/${DS}`)).status, 404);
});

Deno.test("?sha=: Reporter+ and a trunk commit; uncached requests are rate-limited", async () => {
	const f = fakes();
	// The public view has no ?sha= (anonymous, or a Guest of a public repo).
	equal((await get(f, `?sha=${OLD}`, null)).status, 404);
	equal((await get(f, `?sha=${OLD}`, authOf(GUEST))).status, 404);
	// A cached trunk commit is served from RepoDO without RepoProbe.
	const old = await get<ProjectsResponse>(f, `?sha=${OLD}`);
	deepStrictEqual([old.status, old.body.sha], [200, OLD]);
	deepStrictEqual(f.graphCalls, []);
	equal((await get(f, `?sha=${"c".repeat(40)}`)).status, 404, "not on trunk");
	equal((await get(f, "?sha=main")).status, 400);
	// An uncached trunk commit: admitted, then refused.
	const limited = fakes({
		cached: new Map(),
		admit: createAdmission(1, () => 0),
	});
	equal((await get(limited, `?sha=${OLD}`)).status, 200);
	const refused = await get<{ error: string }>(limited, `?sha=${OLD}`);
	deepStrictEqual([refused.status, refused.body.error], [429, "rate_limited"]);
});

Deno.test("detail: by slug, root or name; README, the nearest agent doc, layers and edges", async () => {
	const f = fakes();
	const bySlug = await get<ProjectDetailResponse>(f, `/${DS}`, null);
	equal(bySlug.status, 200);
	const d = bySlug.body;
	deepStrictEqual([d.project.name, d.sha, d.total], [DS, TIP, 38]);
	deepStrictEqual(d.readme, {
		path: "packages/design-system/README.md",
		text: CUENV_DEMO_FILES["packages/design-system/README.md"],
		truncated: false,
	});
	deepStrictEqual(d.agentsDoc, { path: "AGENTS.md" });
	deepStrictEqual(d.layers, [{ root: "", paths: ["env.cue", "tartan.cue"] }]);
	deepStrictEqual(d.dependents, [{
		name: WEB,
		slug: WEB,
		root: "projects/rawkode.academy/website",
	}]);
	deepStrictEqual(d.deps, []);
	const byRoot = await get<ProjectDetailResponse>(
		f,
		`/${encodeURIComponent("projects/rawkode.academy/website")}`,
	);
	equal(byRoot.body.project.name, WEB);
	deepStrictEqual(byRoot.body.agentsDoc, {
		path: "projects/rawkode.academy/website/CLAUDE.md",
	});
	equal(byRoot.body.readme, undefined);
	deepStrictEqual(byRoot.body.deps.map((p) => p.name), [
		DS,
		"rawkode-academy-platform-notifications",
	]);
	const content = await get<ProjectDetailResponse>(
		f,
		"/rawkode-academy-content",
	);
	deepStrictEqual(content.body.agentsDoc, {
		path: "projects/rawkode.academy/AGENTS.md",
	});
	equal(content.body.layers.length, 3);
});

Deno.test("detail: an unknown project is 404 naming the known slugs", async () => {
	const { status, body } = await get<
		{ error: string; details: { known: string[] } }
	>(fakes(), "/nope");
	equal(status, 404);
	equal(body.details.known.length, 38);
	ok(body.details.known.includes(DS));
	equal((await get(fakes(), `/${DS}/nope`)).status, 404);
	equal((await get(fakes(), `/${DS}/issues/x`)).status, 404);
});

Deno.test("issues: work_list as the viewer, kept by footprint (name, root or a prefix in the root)", async () => {
	const f = fakes();
	const { status, body } = await get<ProjectIssuesResponse>(
		f,
		`/${DS}/issues`,
	);
	equal(status, 200);
	deepStrictEqual(
		body.items.map((i) => [i.ref, i.matched, i.claims]),
		[
			["rawkode/academy#1", "project", 1],
			["rawkode/academy#2", "prefix", 0],
			["rawkode/academy#4", "project", 0],
		],
	);
	deepStrictEqual(
		[body.provider, body.scanned, body.complete],
		["tartan.work", 5, true],
	);
	deepStrictEqual(body.project, {
		name: DS,
		slug: DS,
		root: "packages/design-system",
	});
	// The tool saw the viewer, the repo path and no lane.
	const call = f.calls[0];
	deepStrictEqual([call.name, call.args.repo, call.args.limit], [
		"work_list",
		"rawkode/academy",
		200,
	]);
	deepStrictEqual(call.ctx, {
		node: REPO_ID,
		repo: REPO_ID,
		scope: "rawkode/academy",
		actor: { kind: "user", id: OWNER },
		mode: "enforce",
	});
	// state= is passed to the tool.
	const done = await get<ProjectIssuesResponse>(f, `/${DS}/issues?state=done`);
	deepStrictEqual(done.body.items.map((i) => i.ref), ["rawkode/academy#4"]);
	equal((await get(f, `/${DS}/issues?state=bogus`)).status, 400);
});

Deno.test("issues: anonymous readers sign in; a Guest gets the tool's own denial", async () => {
	const f = fakes();
	const anon = await get<{ error: string }>(f, `/${DS}/issues`, null);
	deepStrictEqual([anon.status, anon.body.error], [401, "unauthenticated"]);
	equal(f.calls.length, 0);
	const guest = await get<{ error: string; reason: string }>(
		f,
		`/${DS}/changes`,
		authOf(GUEST),
	);
	deepStrictEqual([guest.status, guest.body.error, guest.body.reason], [
		403,
		"denied",
		"role",
	]);
});

Deno.test("changes: changes_list as the viewer, kept by the latest revision's affected set", async () => {
	const { body } = await get<ProjectChangesResponse>(fakes(), `/${DS}/changes`);
	deepStrictEqual(
		body.changes.map((c) => [c.changeId.slice(0, 2), c.global, c.revision]),
		[["c1", false, 1], ["c3", true, 1]],
	);
	equal(body.provider, "tartan.changes");
	const web = await get<ProjectChangesResponse>(fakes(), `/${WEB}/changes`);
	deepStrictEqual(web.body.changes.map((c) => c.changeId.slice(0, 2)), [
		"c1",
		"c2",
		"c3",
		"c5",
	]);
});

Deno.test("lists: pages are followed up to the limit; no provider is an empty list", async () => {
	const many = Array.from(
		{ length: 1_250 },
		(_, i) => item(10 + i, { projects: i % 2 === 0 ? [DS] : [] }),
	);
	const f = fakes({ items: many });
	const { body } = await get<ProjectIssuesResponse>(f, `/${DS}/issues`);
	equal(f.calls.length, 2, "two pages of 200 hold 200 matches");
	equal(body.items.length, 200);
	equal(body.complete, false);
	const few = fakes({ items: many.slice(0, 450) });
	const all = await get<ProjectIssuesResponse>(few, `/${WEB}/issues`);
	deepStrictEqual([all.body.scanned, all.body.complete, few.calls.length], [
		450,
		true,
		3,
	]);
	// The last page pushes the matches past the cap: not complete.
	const over = Array.from(
		{ length: 350 },
		(_, i) => item(10 + i, { projects: i < 150 || i >= 230 ? [DS] : [] }),
	);
	const cut = fakes({ items: over });
	const capped = await get<ProjectIssuesResponse>(cut, `/${DS}/issues`);
	deepStrictEqual(
		[capped.body.items.length, capped.body.scanned, cut.calls.length],
		[200, 350, 2],
	);
	equal(capped.body.complete, false, "70 matches were left out");
	const none = await get<ProjectIssuesResponse>(
		fakes({ providers: false }),
		`/${DS}/issues`,
	);
	deepStrictEqual([none.body.provider, none.body.items], [null, []]);
});
