// `GET /-/api/view`: static contributions with
// `when` and declared roles applied server-side, dynamic slot instances per
// view, routed tab pages, repo status and banners, redirects.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import type { ViewResponse } from "@tartan/contract";
import { apiFixture, OWNER, session } from "./test/fixture.ts";
import {
	configLabel,
	handleViewRequest,
	viewEntity,
	viewSlots,
} from "./view.ts";

const READER = "u_reader";
const DEV = "u_dev";

const setup = async () => {
	const a = apiFixture();
	a.fx.tree.grant("acme/platform", READER, 20);
	a.fx.tree.grant("acme/platform", DEV, 30);
	await a.registry.facade.install(OWNER, {
		extId: "tartan.work",
		version: "0.1.0",
		node: "acme/platform",
		mode: "enforce",
	});
	await a.registry.facade.install(OWNER, {
		extId: "tartan.board",
		version: "0.1.0",
		node: "acme",
		mode: "enforce",
	});
	return a;
};

const view = async (
	a: Awaited<ReturnType<typeof setup>>,
	path: string,
	v = "",
	auth = session(READER),
) => {
	const url = new URL("https://forge.test/-/api/view");
	url.searchParams.set("path", path);
	if (v !== "") url.searchParams.set("view", v);
	return await handleViewRequest(a.deps, new Request(url), auth);
};

const body = async (res: Response) => (await res.json()) as ViewResponse;

Deno.test("a repo view: tabs, nav and actions evaluated server-side; no extension runs", async () => {
	const a = await setup();
	const res = await view(a, "acme/platform/router");
	equal(res.status, 200);
	const v = await body(res);
	equal(v.node.path, "acme/platform/router");
	deepStrictEqual(v.repo, {
		id: a.nodeId("acme/platform/router"),
		defaultBranch: "main",
		trunkSha: a.sha,
		landingPaused: false,
	});
	equal(v.viewer.role, 20);
	equal(v.viewer.principal?.handle, "reader");
	deepStrictEqual(v.static.tabs.map((t) => [t.ext, t.id, t.route]), [[
		"tartan.work",
		"work",
		"work",
	]]);
	deepStrictEqual(v.static.nav.map((t) => t.id), ["nav"]);
	// new-work declares role 30: hidden for a Reporter, shown for a Developer.
	deepStrictEqual(v.static.actions, []);
	const dev = await body(
		await view(a, "acme/platform/router", "", session(DEV)),
	);
	deepStrictEqual(dev.static.actions.map((t) => t.id), ["new-work"]);
	deepStrictEqual(v.slots.map((s) => [s.ext, s.slot, s.id]), [[
		"tartan.work",
		"repo.sidebar",
		"mine",
	]]);
	equal(a.calls.length, 0);
});

Deno.test("when expressions hide repo-only contributions on groups", async () => {
	const a = await setup();
	const v = await body(await view(a, "acme/platform"));
	deepStrictEqual(v.static.tabs.map((t) => t.id), ["board"]); // node.tab
	deepStrictEqual(v.static.actions, []);
	equal(v.repo, undefined);
	// node.section `summary` declares role 40: hidden for a Reporter.
	deepStrictEqual(v.slots, []);
	const owner = await body(await view(a, "acme/platform", "", session(OWNER)));
	deepStrictEqual(owner.slots.map((s) => s.id), ["summary"]);
});

Deno.test("entity views and routed tab pages add their dynamic slots", async () => {
	const a = await setup();
	// An entity view is never a tab page: no repo.tab `work` here.
	const work = await body(await view(a, "acme/platform/router", "work/7"));
	deepStrictEqual(work.slots.map((s) => s.id).sort(), ["item"]);
	const tabPage = await body(await view(a, "acme/platform/router", "work"));
	deepStrictEqual(tabPage.slots.map((s) => s.id), ["work"]);
	const hud = await body(await view(a, "acme", "hud", session(OWNER)));
	deepStrictEqual(hud.slots.map((s) => [s.id, s.cache]), [["wip", "role"]]);
	deepStrictEqual(viewEntity("changes/zkqv"), { kind: "change", id: "zkqv" });
	equal(viewEntity("weave"), undefined);
	deepStrictEqual(viewSlots("repo", "changes/zkqv").tabs, [
		"repo.tab",
		"change.tab",
	]);
});

Deno.test("a change view lists its change.tab pages and no repo.tab page", async () => {
	const a = await setup();
	await a.registry.facade.install(OWNER, {
		extId: "tartan.changes",
		version: "0.1.0",
		node: "acme/platform",
		mode: "enforce",
	});
	for (
		const v of ["changes/zkqv", "changes/zkqv/diff", "changes/zkqv/revisions"]
	) {
		const change = await body(await view(a, "acme/platform/router", v));
		deepStrictEqual(
			change.slots.map((s) => [s.ext, s.slot, s.id]),
			[
				["tartan.changes", "change.tab", "diff"],
				["tartan.changes", "change.panel", "threads"],
				["tartan.changes", "change.tab", "revisions"],
			],
			v,
		);
		deepStrictEqual(
			change.static.tabs.filter((t) => t.slot === "change.tab").map((t) =>
				t.route
			),
			["diff", "revisions"],
		);
	}
	// The Changes tab page itself is still the repo.tab.
	const tab = await body(await view(a, "acme/platform/router", "changes"));
	deepStrictEqual(tab.slots.map((s) => [s.slot, s.id]), [[
		"repo.tab",
		"changes",
	]]);
	// Changes live in repos: a group lists no change.tab page.
	const group = await body(
		await view(a, "acme/platform", "changes/zkqv", session(OWNER)),
	);
	ok(group.slots.every((s) => s.slot !== "change.tab"));
	// Lanes and work items list no tab page either.
	const lane = await body(
		await view(
			a,
			"acme/platform/router",
			"lanes/ln_01k6c0000000000000000000aa",
		),
	);
	ok(lane.slots.every((s) => s.slot !== "repo.tab"));
});

Deno.test("access: anonymous reads public repos only; unknown paths are 404", async () => {
	const a = await setup();
	equal((await view(a, "acme/platform/edge", "", null as never)).status, 200);
	equal((await view(a, "acme/platform/router", "", null as never)).status, 401);
	equal((await view(a, "nope")).status, 404);
	const missing = await handleViewRequest(
		a.deps,
		new Request("https://forge.test/-/api/view"),
		session(READER),
	);
	equal(missing.status, 400);
});

Deno.test("repo status falls back with a banner when RepoDO cannot answer", async () => {
	const a = await setup();
	a.failRepoInfo();
	const v = await body(await view(a, "acme/platform/router"));
	equal(v.repo?.trunkSha, null);
	ok(v.banners.some((b) => b.tone === "warning"));
});

Deno.test("an installation's labels config renames its own tab labels (Classic: Issues)", async () => {
	const a = apiFixture();
	a.fx.tree.grant("acme/platform", DEV, 30);
	await a.registry.facade.install(OWNER, {
		extId: "tartan.work",
		version: "0.1.0",
		node: "acme/platform",
		mode: "enforce",
		config: {
			labels: {
				work: " Issues\u001b[31m ",
				"new-work": "x".repeat(41),
				item: "never shown",
			},
		},
	});
	await a.registry.facade.install(OWNER, {
		extId: "tartan.changes",
		version: "0.1.0",
		node: "acme/platform",
		mode: "enforce",
		config: { labels: { changes: "Pull requests", diff: 7 } },
	});
	const v = await body(await view(a, "acme/platform/router", "", session(DEV)));
	const label = (id: string) =>
		[...v.static.tabs, ...v.static.actions].find((t) => t.id === id)?.label;
	// Control characters are stripped; the rest is trimmed.
	equal(label("work"), "Issues[31m");
	equal(label("changes"), "Pull requests");
	// Too long: the manifest's label stays.
	equal(label("new-work"), "New work");
	const change = await body(
		await view(a, "acme/platform/router", "changes/c_1", session(DEV)),
	);
	// Not a string: the manifest's label stays.
	equal(change.static.tabs.find((t) => t.id === "diff")?.label, "Diff");
});

Deno.test("configLabel ignores inherited keys and non-objects", () => {
	equal(configLabel({ labels: {} }, "constructor"), undefined);
	equal(configLabel({ labels: ["Issues"] }, "0"), undefined);
	equal(configLabel(null, "work"), undefined);
	equal(configLabel({ labels: { work: "   " } }, "work"), undefined);
	equal(configLabel({ labels: { work: "Issues" } }, "work"), "Issues");
});

Deno.test("a moved node answers 301 to its new path", async () => {
	const a = await setup();
	const deps = {
		...a.deps,
		tree: () => ({
			...a.deps.tree(),
			resolvePath: () =>
				Promise.resolve({
					node: {} as never,
					rest: "",
					redirectTo: "acme/new",
				}),
		}),
	};
	const res = await handleViewRequest(
		deps,
		new Request("https://forge.test/-/api/view?path=acme/old&view=work"),
		session(READER),
	);
	equal(res.status, 301);
	equal(res.headers.get("location"), "/-/api/view?path=acme%2Fnew&view=work");
});
