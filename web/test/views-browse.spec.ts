// Namespace browser, node pages, repo code views, the change page as a slot
// host, extension tabs, the shell and the auth pages, against the mock kernel.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App.vue";
import type { FetchLike } from "../src/api/http.ts";
import { CHANGE_ID, SHAS } from "../src/api/mock/fixtures.ts";
import { withMockProjects } from "../src/api/mock/projects.ts";
import { createMockFetch } from "../src/api/mock/server.ts";
import { mountApp } from "./support/app.ts";
import {
	byTag,
	byText,
	click,
	findAll,
	flush,
	html,
	submit,
	type TestElement,
	text,
	type,
} from "./support/renderer.ts";

const links = (root: TestElement): string[] =>
	byTag(root, "a").map((a) => a.attrs["href"] ?? "");

beforeEach(() => vi.stubGlobal("confirm", () => true));
afterEach(() => vi.unstubAllGlobals());

describe("namespace browser", () => {
	it("loads the tree level by level and pages long levels", async () => {
		const app = await mountApp("/-/explore");
		expect(app.calls.filter((c) => c.path === "/-/api/nodes")).toHaveLength(1);
		const acme = findAll(
			app.root,
			(el) => el.tag === "button" && el.attrs["aria-label"] === "Expand acme",
		)[0]!;
		expect(acme.attrs["aria-expanded"]).toBe("false");
		click(acme);
		await flush();
		expect(app.calls.some((c) => c.path === "/-/api/nodes?parent=acme")).toBe(
			true,
		);
		expect(links(app.root)).toContain("/acme/platform");
		expect(text(app.root)).toContain("team-18");
		expect(text(app.root)).not.toContain("team-19");
		click(byText(app.root, "button", "Show more")!);
		await flush();
		expect(
			app.calls.some((c) => c.path === "/-/api/nodes?parent=acme&cursor=20"),
		).toBe(true);
		expect(text(app.root)).toContain("team-30");
		const platform = findAll(
			app.root,
			(el) => el.attrs["aria-label"] === "Expand platform",
		)[0]!;
		click(platform);
		await flush();
		expect(links(app.root)).toContain("/acme/platform/router");
		// Repositories are leaves.
		expect(
			findAll(app.root, (el) => el.attrs["aria-label"] === "Expand router"),
		).toEqual([]);
	});

	it("lets admins add a top-level group", async () => {
		const app = await mountApp("/-/explore");
		click(byText(app.root, "button", "New group")!);
		await flush();
		type(findAll(app.root, (el) => el.attrs["name"] === "slug")[0]!, "labs");
		submit(byTag(app.root, "form")[0]!);
		await flush();
		expect(app.calls.find((c) => c.method === "POST")?.body).toEqual({
			kind: "group",
			slug: "labs",
			visibility: "private",
		});
		// The node page is a lazy route chunk: wait for the navigation.
		await vi.waitFor(() =>
			expect(app.router.currentRoute.value.fullPath).toBe("/labs")
		);
	});
});

describe("node pages", () => {
	it("shows a group's sections, tabs and children, with create forms for maintainers", async () => {
		const app = await mountApp("/acme");
		expect(text(app.root)).toContain("Acme Corp");
		// node.tab contributions (tartan.board, tartan.epics); no first-party
		// extension contributes a node.section.
		expect(links(app.root)).toContain("/acme/-/board");
		expect(links(app.root)).toContain("/acme/-/epics");
		expect(links(app.root)).toContain("/acme/platform");
		expect(findAll(app.root, (el) => el.attrs["data-slot"] === "node.section"))
			.toHaveLength(0);
		click(byText(app.root, "button", "New repository")!);
		await flush();
		type(findAll(app.root, (el) => el.attrs["name"] === "slug")[0]!, "api");
		const importRadio = findAll(
			app.root,
			(el) => el.attrs["value"] === "import",
		)[0]!;
		importRadio.checked = true;
		for (const fn of importRadio.domListeners["change"] ?? []) {
			fn({ type: "change", target: importRadio } as never);
		}
		await flush();
		type(
			findAll(app.root, (el) => el.attrs["name"] === "import")[0]!,
			"http://insecure.example/x.git",
		);
		await flush();
		expect("disabled" in byText(app.root, "button", "Create repo")!.attrs).toBe(
			true,
		);
		type(
			findAll(app.root, (el) => el.attrs["name"] === "import")[0]!,
			"https://github.com/rawkode/x.git",
		);
		await flush();
		submit(byTag(app.root, "form")[0]!);
		await flush();
		expect(app.calls.find((c) => c.path === "/-/api/nodes/repos")?.body)
			.toEqual({
				parent: "acme",
				slug: "api",
				visibility: "private",
				import: { url: "https://github.com/rawkode/x.git" },
			});
		expect(app.router.currentRoute.value.fullPath).toBe("/acme/api");
	});

	it("marks archived children, which stay listed", async () => {
		const inner = withMockProjects(createMockFetch());
		const app = await mountApp("/acme", {
			fetch: async (input, init) => {
				const response = await inner(input, init);
				const url = new URL(input, "https://f.test");
				if (
					url.pathname !== "/-/api/nodes" ||
					url.searchParams.get("parent") !== "acme"
				) {
					return response;
				}
				const page = await response.json() as {
					nodes: { archived: boolean }[];
				};
				return Response.json({
					...page,
					nodes: page.nodes.map((n, i) => ({ ...n, archived: i === 0 })),
				});
			},
		});
		const items = findAll(
			app.root,
			(el) =>
				el.tag === "li" && (el.attrs["class"] ?? "").includes("children__item"),
		);
		expect(items.length).toBeGreaterThan(0);
		expect(text(items[0]!)).toContain("archived");
		for (const item of items.slice(1)) {
			expect(text(item)).not.toContain("archived");
		}
	});

	it("shows a repo's code at its home page", async () => {
		const app = await mountApp("/acme/platform/router");
		expect(text(app.root)).toContain("README.md");
		expect(links(app.root)).toContain("/acme/platform/router/-/tree/main/apps");
		expect(links(app.root)).toContain(
			"/acme/platform/router/-/blob/main/package.json",
		);
		// README rendered by the safe markdown renderer.
		expect(findAll(app.root, (el) => el.tag === "h3" && text(el) === "router"))
			.toHaveLength(1);
		// Repo sidebar slots (tartan.ci's projects).
		expect(findAll(app.root, (el) => el.attrs["data-slot"] === "repo.sidebar"))
			.toHaveLength(1);
		expect(text(app.root)).toContain("packages/shared");
		// Tabs: kernel views and static repo.tab contributions.
		expect(links(app.root)).toEqual(expect.arrayContaining([
			"/acme/platform/router/-/lanes",
			"/acme/platform/router/-/runs",
			"/acme/platform/router/-/advances",
			"/acme/platform/router/-/work",
			"/acme/platform/router/-/changes",
			"/acme/platform/router/-/radar",
			"/acme/platform/router/-/ci",
			"/acme/platform/router/-/weave",
			"/acme/platform/router/-/board",
			"/acme/platform/router/-/settings",
		]));
	});
});

describe("repo code views", () => {
	it("walks into a directory and shows the parent link", async () => {
		const app = await mountApp(
			"/acme/platform/router/-/tree/main/services/api",
		);
		expect(
			app.calls.some((c) =>
				c.path.startsWith(
					"/-/api/tree?repo=acme%2Fplatform%2Frouter&ref=main&path=services%2Fapi",
				)
			),
		).toBe(true);
		expect(links(app.root)).toContain(
			"/acme/platform/router/-/tree/main/services/api/src",
		);
		expect(links(app.root)).toContain(
			"/acme/platform/router/-/tree/main/services",
		);
	});

	it("shows a file with line numbers, a raw link and the file banner slot", async () => {
		const app = await mountApp(
			"/acme/platform/router/-/blob/main/services/api/src/server.ts",
		);
		const lines = findAll(
			app.root,
			(el) =>
				el.tag === "td" && (el.attrs["class"] ?? "").includes("file__line"),
		);
		expect(lines).toHaveLength(7);
		expect(text(lines[4]!)).toContain("limit(Number");
		expect(byText(app.root, "a", "Raw")!.attrs["href"]).toBe(
			"/-/raw/acme/platform/router/main/services/api/src/server.ts",
		);
		expect(text(app.root)).toContain("2 lanes are editing this file");
		expect(findAll(app.root, (el) => el.attrs["data-slot"] === "file.banner"))
			.toHaveLength(1);
	});

	it("says a binary file is not shown", async () => {
		const app = await mountApp(
			"/acme/platform/router/-/blob/main/apps/web/public/logo.png",
		);
		expect(text(app.root)).toContain("Binary file not shown.");
	});

	it("shows a not-found state for a missing path", async () => {
		const app = await mountApp("/acme/platform/router/-/blob/main/nope.ts");
		expect(text(app.root)).toContain("this file was not found");
	});

	it("lists history with agent and advance trailers", async () => {
		const app = await mountApp("/acme/platform/router/-/commits/main");
		expect(text(app.root)).toContain("api: split router into modules");
		expect(text(app.root)).toContain("advance: adv_2");
		expect(text(app.root)).toContain("agent: a_codex-1");
		expect(links(app.root)).toContain(
			`/acme/platform/router/-/commit/${SHAS.c2}`,
		);
	});

	it("shows a commit with trailers and file diffs", async () => {
		const app = await mountApp(`/acme/platform/router/-/commit/${SHAS.c1}`);
		// The page asks for the patches (WP8 builds them only on request).
		expect(
			app.calls.some((c) =>
				c.path.startsWith("/-/api/commit?") && c.path.endsWith("&patch=1")
			),
		).toBe(true);
		expect(text(app.root)).toContain("api: rate limits on /n");
		expect(text(app.root)).toContain("Change-Id");
		expect(text(app.root)).toContain("2 files changed");
		expect(
			findAll(
				app.root,
				(el) => (el.attrs["class"] ?? "").includes("diff__line--add"),
			).length,
		)
			.toBeGreaterThan(0);
		expect(links(app.root)).toContain(
			`/acme/platform/router/-/commit/${SHAS.genesis}`,
		);
	});

	it("compares two revisions and edits the range", async () => {
		const app = await mountApp(
			"/acme/platform/router/-/compare/main...lanes%2Fln_x",
		);
		expect(
			app.calls.some((c) =>
				c.path ===
					"/-/api/compare?repo=acme%2Fplatform%2Frouter&base=main&head=lanes%2Fln_x&patch=1"
			),
		).toBe(true);
		expect(text(app.root)).toContain("2 files");
		const head = findAll(app.root, (el) => el.attrs["name"] === "head")[0]!;
		expect(head.value).toBe("lanes/ln_x");
		type(head, "feature");
		submit(byTag(app.root, "form")[0]!);
		await flush();
		expect(app.router.currentRoute.value.fullPath).toBe(
			"/acme/platform/router/-/compare/main...feature",
		);
	});
});

describe("change page (slot host)", () => {
	it("renders change.tab, change.panel, change.sidebar and change.gate slots", async () => {
		const app = await mountApp(`/acme/platform/router/-/changes/${CHANGE_ID}`);
		await flush();
		const slots = (slot: string) =>
			findAll(app.root, (el) => el.attrs["data-slot"] === slot);
		expect(slots("change.gate")).toHaveLength(1);
		expect(slots("change.tab")).toHaveLength(1);
		expect(slots("change.panel")).toHaveLength(3);
		expect(slots("change.sidebar")).toHaveLength(4);
		// The first-party extensions all render on the change page.
		const exts = new Set(
			findAll(
				app.root,
				(el) => el.attrs["data-slot"]?.startsWith("change.") === true,
			)
				.map((el) => el.attrs["data-ext"]),
		);
		for (
			const ext of [
				"tartan.changes",
				"tartan.radar",
				"tartan.ci",
				"tartan.review",
				"tartan.weave",
			]
		) expect(exts).toContain(ext);
		expect(text(app.root)).toContain(
			"Rate limit the public API per token, not per IP.",
		);
		expect(text(app.root)).toContain("gate: allow");
		expect(text(app.root)).toContain("No predicted conflicts");
		// The default tab is the first change.tab: the diff, fetched by the
		// host with its patches, so its lines show.
		expect(
			app.calls.some((c) =>
				c.path.startsWith("/-/api/compare?repo=acme%2Fplatform%2Frouter") &&
				c.path.endsWith("&patch=1")
			),
		).toBe(true);
		expect(text(slots("change.tab")[0]!)).toContain(
			"services/api/src/server.ts",
		);
		// One request per dynamic slot, each with its contribution id as the
		// route's `<slotId>` (WP7a).
		const renders = app.calls.filter((c) => c.path.startsWith("/-/api/slot/"));
		expect(renders).toHaveLength(9);
		expect(
			new Set(
				renders.map((c) =>
					new URL(c.path, "https://f.test").pathname.split("/").at(-1)
				),
			),
		)
			.toEqual(
				new Set([
					"diff",
					"overview",
					"threads",
					"evidence",
					"checks",
					"conflicts",
					"findings",
					"position",
					"no-secrets",
				]),
			);
	});

	it("switches tabs by route and runs a panel form action", async () => {
		const app = await mountApp(
			`/acme/platform/router/-/changes/${CHANGE_ID}/revisions`,
		);
		await flush();
		const tab = findAll(
			app.root,
			(el) => el.attrs["data-slot"] === "change.tab",
		)[0]!;
		expect(text(tab)).toContain("r1: pushed 2 commits");
		// The selected tab's render carries its route; the panels' do not.
		const tabRender = app.calls.find((c) =>
			c.path.startsWith("/-/api/slot/") && c.path.includes("/revisions?")
		)!;
		const tabCtx = new URL(tabRender.path, "https://f.test").searchParams
			.get("ctx")!;
		expect(JSON.parse(atob(tabCtx.replace(/-/g, "+").replace(/_/g, "/"))))
			.toEqual({
				node: "acme/platform/router",
				entity: { kind: "change", id: CHANGE_ID },
				route: "revisions",
			});
		const threads = findAll(
			app.root,
			(el) =>
				el.attrs["data-slot"] === "change.panel" &&
				el.attrs["data-ext"] === "tartan.changes" &&
				findAll(el, (child) => child.tag === "form").length > 0,
		)[0]!;
		type(findAll(threads, (el) => el.tag === "textarea")[0]!, "LGTM");
		submit(findAll(threads, (el) => el.tag === "form")[0]!);
		await flush();
		const action = app.calls.find((c) => c.path.includes("/action"));
		expect(action?.path).toMatch(
			/\/-\/api\/slot\/i_[0-9a-z]+\/threads\/action$/,
		);
		expect(action?.body).toMatchObject({
			action: "comment",
			// The form's fields at the top level, the action's payload over them.
			payload: { body: "LGTM", path: "", line: "", changeId: CHANGE_ID },
			// The page hint narrowed to change.panel: no tab route.
			ctx: {
				node: "acme/platform/router",
				entity: { kind: "change", id: CHANGE_ID },
			},
		});
		expect(app.toasts.items.map((t) => t.text)).toContain(
			"tartan.changes: comment done",
		);
	});
});

describe("change overview", () => {
	it("shows the change first in the panels and abandons it from there", async () => {
		const app = await mountApp(`/acme/platform/router/-/changes/${CHANGE_ID}`);
		await flush();
		const panels = findAll(
			app.root,
			(el) => el.attrs["data-slot"] === "change.panel",
		);
		// Contribution order: the overview (order -10) before the threads.
		const overview = panels[0]!;
		expect(overview.attrs["data-ext"]).toBe("tartan.changes");
		expect(text(overview)).toContain("api: rate limits on /n");
		expect(text(overview)).toContain("submitted");
		const abandon = byText(overview, "button", "Abandon");
		expect(abandon).not.toBeNull();
		click(abandon!);
		await flush();
		const action = app.calls.find((c) => c.path.includes("/action"));
		expect(action?.path).toMatch(
			/\/-\/api\/slot\/i_[0-9a-z]+\/overview\/action$/,
		);
		expect(action?.body).toEqual({
			action: "abandon",
			payload: { changeId: CHANGE_ID },
			ctx: {
				node: "acme/platform/router",
				entity: { kind: "change", id: CHANGE_ID },
			},
		});
	});
});

describe("change tab without a page", () => {
	it("says so instead of rendering nothing", async () => {
		const mock = createMockFetch();
		const withoutTabPages: FetchLike = async (input, init) => {
			const res = await mock(input, init);
			if (!input.startsWith("/-/api/view")) return res;
			const view = await res.json() as {
				slots: { slot: string }[];
			};
			return Response.json({
				...view,
				slots: view.slots.filter((s) => s.slot !== "change.tab"),
			});
		};
		const app = await mountApp(
			`/acme/platform/router/-/changes/${CHANGE_ID}`,
			{ fetch: withoutTabPages },
		);
		await flush();
		expect(text(app.root)).toContain("Diff has nothing to show here.");
	});
});

describe("in-view navigation", () => {
	const renderCtx = (path: string): unknown => {
		const ctx = new URL(path, "https://f.test").searchParams.get("ctx")!;
		return JSON.parse(atob(ctx.replace(/-/g, "+").replace(/_/g, "/")));
	};

	it("re-renders the change slots with the new change's entity", async () => {
		const app = await mountApp(`/acme/platform/router/-/changes/${CHANGE_ID}`);
		await flush();
		const other = "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
		const before = app.calls.length;
		await app.router.push(`/acme/platform/router/-/changes/${other}`);
		await flush();
		const panels = app.calls.slice(before).filter((c) =>
			c.path.startsWith("/-/api/slot/")
		);
		expect(panels.length).toBeGreaterThan(0);
		for (const call of panels) {
			expect(renderCtx(call.path)).toMatchObject({
				node: "acme/platform/router",
				entity: { kind: "change", id: other },
			});
		}
		// No slot rendered B's page with A's change.
		expect(
			panels.some((c) => JSON.stringify(renderCtx(c.path)).includes(CHANGE_ID)),
		).toBe(false);
	});

	it("never mixes one repo's slots with another page's entity while the new view loads", async () => {
		const other = "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
		const mock = createMockFetch();
		let release = (): void => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		// The billing repo's change view arrives late, and carries the change
		// page's instances (the mock lists them for the router repo only).
		const fetch: FetchLike = async (input, init) => {
			const url = new URL(input, "https://f.test");
			if (
				url.pathname === "/-/api/view" &&
				url.searchParams.get("path") === "acme/platform/billing"
			) {
				await held;
				const billing = await (await mock(input, init)).json();
				const router = await (await mock(
					`/-/api/view?path=acme%2Fplatform%2Frouter&view=${
						encodeURIComponent(url.searchParams.get("view") ?? "")
					}`,
					init,
				)).json();
				return Response.json({
					...router,
					node: billing.node,
					repo: billing.repo,
				});
			}
			return mock(input, init);
		};
		const app = await mountApp(`/acme/platform/router/-/changes/${CHANGE_ID}`, {
			fetch,
		});
		await flush();
		const slotCalls = (from: number) =>
			app.calls.slice(from).filter((c) => c.path.startsWith("/-/api/slot/"));
		const before = app.calls.length;
		await app.router.push(`/acme/platform/billing/-/changes/${other}`);
		await flush();
		// The router repo's view is still on screen: its slots keep the router
		// change's hint instead of rendering {router, change B}.
		expect(slotCalls(before)).toEqual([]);
		release();
		await flush();
		const after = slotCalls(before);
		expect(after.length).toBeGreaterThan(0);
		for (const call of after) {
			expect(renderCtx(call.path)).toMatchObject({
				node: "acme/platform/billing",
				entity: { kind: "change", id: other },
			});
		}
	});
});

describe("extension tabs and work items", () => {
	it("renders a repo.tab page from its contribution", async () => {
		const app = await mountApp("/acme/platform/router/-/work");
		await flush();
		expect(findAll(app.root, (el) => el.attrs["data-slot"] === "repo.tab"))
			.toHaveLength(1);
		expect(text(app.root)).toContain("Add rate limits to /n");
		const nav = findAll(
			app.root,
			(el) => el.attrs["aria-label"] === "Repository",
		)[0]!;
		const current = findAll(nav, (el) => el.attrs["aria-current"] === "page");
		expect(current.map(text)).toEqual(["Work"]);
	});

	it("moves a board card through the slot action and refreshes the slot", async () => {
		const app = await mountApp("/acme/platform/router/-/board");
		await flush();
		const select = findAll(app.root, (el) => el.tag === "select")[0]!;
		select.value = "done";
		select.selectedIndex = 3;
		for (
			const fn of select.listeners["change"] ? [select.listeners["change"]] : []
		) fn({ type: "change", target: select } as never);
		await flush();
		const action = app.calls.find((c) => c.path.includes("/action"));
		expect(action?.body).toMatchObject({
			action: "move",
			payload: { card: "w_18", from: "open", to: "done" },
			ctx: { node: "acme/platform/router" },
		});
	});

	it("says when no extension provides a tab", async () => {
		const app = await mountApp("/acme/platform/router/-/nothing-here");
		expect(text(app.root)).toContain(
			"No extension provides “nothing-here” here.",
		);
	});

	it("renders a work item's panel and sidebar", async () => {
		const app = await mountApp("/acme/platform/router/-/work/w_17");
		await flush();
		expect(findAll(app.root, (el) => el.attrs["data-slot"] === "work.panel"))
			.toHaveLength(1);
		expect(findAll(app.root, (el) => el.attrs["data-slot"] === "work.sidebar"))
			.toHaveLength(1);
		expect(text(app.root)).toContain("Footprint");
	});
});

describe("shell, sign-in and the leaving interstitial", () => {
	it("shows admin navigation and sign out to a signed-in user", async () => {
		const app = await mountApp("/-/explore", { shell: App });
		const nav = findAll(
			app.root,
			(el) => el.attrs["aria-label"] === "Primary",
		)[0]!;
		expect(byTag(nav, "a").map(text)).toEqual([
			"Home",
			"Explore",
			"Agents",
			"Extensions",
			"Settings",
		]);
		expect(text(app.root)).toContain("rawkode");
		click(byText(app.root, "button", "Sign out")!);
		await flush();
		expect(app.calls.find((c) => c.path === "/-/auth/logout")?.method).toBe(
			"POST",
		);
		expect(byTag(nav, "a").map(text)).toEqual(["Home", "Explore"]);
		expect(byText(app.root, "a", "Sign in")!.attrs["href"]).toBe(
			"/-/auth/login?return_to=%2F-%2Fexplore",
		);
	});

	it("folds the navigation behind a menu button (375 px)", async () => {
		const app = await mountApp("/-/explore", { shell: App });
		const menu = findAll(
			app.root,
			(el) => el.attrs["aria-controls"] === "shell-nav",
		)[0]!;
		expect(menu.attrs["aria-expanded"]).toBe("false");
		click(menu);
		await flush();
		expect(menu.attrs["aria-expanded"]).toBe("true");
		const nav = findAll(app.root, (el) => el.attrs["id"] === "shell-nav")[0]!;
		expect(nav.attrs["class"]).toContain("shell-nav--open");
		await app.router.push("/-/agents");
		await flush();
		expect(menu.attrs["aria-expanded"]).toBe("false");
	});

	it("routes https links through the interstitial with rel=noopener noreferrer", async () => {
		const app = await mountApp(
			"/-/leaving?to=https%3A%2F%2Fexample.com%2Fdocs%3Fa%3D1",
		);
		const link = byText(app.root, "a", "Continue to example.com")!;
		expect(link.attrs["href"]).toBe("https://example.com/docs?a=1");
		expect(link.attrs["rel"]).toBe("noopener noreferrer");
		expect(text(app.root)).toContain("https://example.com/docs?a=1");
	});

	it("refuses anything but https in the interstitial", async () => {
		for (
			const to of [
				"javascript:alert(1)",
				"//evil.example",
				"http://evil.example",
				"https://u:p@evil.example",
			]
		) {
			const app = await mountApp(`/-/leaving?to=${encodeURIComponent(to)}`);
			expect(byTag(app.root, "a")).toEqual([]);
			expect(text(app.root)).toContain("not a valid https address");
			expect(html(app.root)).not.toContain('evil.example"');
		}
	});

	it("keeps login return_to on this origin", async () => {
		const app = await mountApp("/-/login?return_to=%2F%2Fevil.example", {
			mock: { signedIn: false },
		});
		expect(byText(app.root, "a", "Continue to sign in")!.attrs["href"]).toBe(
			"/-/auth/login?return_to=%2F",
		);
		const ok = await mountApp("/-/login?return_to=%2Facme", {
			mock: { signedIn: false },
		});
		expect(byText(ok.root, "a", "Continue to sign in")!.attrs["href"]).toBe(
			"/-/auth/login?return_to=%2Facme",
		);
	});

	it("turns an invite link into a login carrying the code", async () => {
		const app = await mountApp("/-/invite/abcDEF12345", {
			mock: { signedIn: false },
		});
		expect(byText(app.root, "a", "Accept and sign in")!.attrs["href"]).toBe(
			"/-/auth/login?return_to=%2F&invite=abcDEF12345",
		);
		const bad = await mountApp("/-/invite/%3Cscript%3E", {
			mock: { signedIn: false },
		});
		expect(byTag(bad.root, "a")).toEqual([]);
	});

	it("redirects to the wizard while the forge is not set up", async () => {
		const app = await mountApp("/-/explore", {
			mock: { setupState: "fresh", signedIn: false },
			guard: true,
		});
		expect(app.router.currentRoute.value.name).toBe("setup");
	});
});
