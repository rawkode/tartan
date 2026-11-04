// The forge shell's pure parts (addresses, role, theme) and a render of the real
// components to a string. Ark UI's behaviour needs a DOM, so it is not covered here.

import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vitest";
import { createSSRApp } from "vue";
import { createMemoryHistory } from "vue-router";
import { API, SESSION } from "../src/app/context.ts";
import { forgeRole } from "../src/auth/role.ts";
import type { Session } from "../src/auth/session.ts";
import { createApi } from "../src/api/client.ts";
import { createHttp, type FetchLike } from "../src/api/http.ts";
import {
	age,
	createForgeStore,
	describeEvent,
	FORGE,
	type ForgeNode,
	parseUrl,
	projectsUnder,
	rel,
	urlFor,
} from "../src/forge/data/index.ts";
import ForgeApp from "../src/forge/ForgeApp.vue";
import { formatAddress, parseAddress } from "../src/router/address.ts";
import { createAppRouter } from "../src/router/index.ts";
import { resolvesDark } from "../src/theme.ts";

const session = (status: Session["state"]["status"], admin = false): Session =>
	({
		state: { status, me: null, error: null },
		isAdmin: () => admin,
		principal: () => null,
		loginUrl: (to: string) => `/-/auth/login?return_to=${to}`,
		logout: () => Promise.resolve(),
		load: () => Promise.resolve(),
	}) as Session;

// A small kernel: oss/kiln-group/kiln (a monorepo with Issues), oss/plain (a
// single project without).
const KILN = "oss/kiln-group/kiln";
const KILN_ID = "r-kiln";
const PLAIN = "oss/plain";
const enc = encodeURIComponent;

const node = (path: string, kind: string, id: string) => ({
	id,
	parentId: null,
	kind,
	slug: path.split("/").pop(),
	path,
	depth: path.split("/").length - 1,
	visibility: "public",
	archived: false,
	createdAt: 1,
	...(kind === "repo" ? { defaultBranch: "main" } : {}),
});

const project = (
	name: string,
	root: string,
	enabled: boolean,
	deps: string[],
) => ({
	key: root,
	name,
	slug: name,
	root,
	source: "tartan",
	nameSource: "directory",
	layers: [],
	deps,
	dependents: [],
	manifestPath: `${root}/forge.cue`,
	issues: [],
	extensions: { "rawkode.issues": { enabled } },
});

const issue = (
	number: number,
	title: string,
	projectRoot: string | null,
	state = "open",
) => ({
	number,
	title,
	project: projectRoot,
	state,
	author: { kind: "user", id: "u1" },
	createdAt: 1000 * number,
	updatedAt: 1000 * number,
	closedAt: state === "closed" ? 1000 : null,
});

const KILN_ISSUES = [
	issue(2, "The lsp one", "crates/lsp"),
	issue(1, "The repo one", null),
	issue(0, "A closed one", null, "closed"),
];

const fakeKernel = (
	asked: string[],
	options: { readonly flatRefusal?: boolean } = {},
): FetchLike =>
(input, init) => {
	asked.push(input);
	const url = new URL(input, "https://forge.test");
	const reply = (status: number, body: unknown) =>
		Promise.resolve(new Response(JSON.stringify(body), { status }));
	const parent = url.searchParams.get("parent");
	if (url.pathname === "/-/api/nodes") {
		const below: Record<string, unknown[]> = {
			"": [node("oss", "group", "g-oss")],
			oss: [
				node("oss/kiln-group", "group", "g-kg"),
				node(PLAIN, "repo", "r-plain"),
			],
			"oss/kiln-group": [node(KILN, "repo", KILN_ID)],
		};
		return reply(200, { nodes: below[parent ?? ""] ?? [] });
	}
	if (url.pathname === `/-/api/repos/${KILN_ID}/projects`) {
		return reply(200, {
			sha: "abcdef1234",
			detector: "tartan",
			projects: [
				project("docs", "site/docs", false, []),
				project("lsp", "crates/lsp", true, ["core"]),
			],
		});
	}
	if (url.pathname === "/-/api/repos/r-plain/projects") {
		return reply(200, { sha: "1", detector: null, projects: [] });
	}
	const tool = url.pathname.match(/\/tools\/(\w+)$/)?.[1];
	if (tool) {
		if (url.pathname.includes("r-plain")) {
			return reply(404, {
				error: { code: "not_installed", message: "not installed" },
			});
		}
		if (options.flatRefusal) {
			return reply(401, { error: "unauthenticated", message: "sign in" });
		}
		const body = JSON.parse(String(init?.body)) as {
			args: { number?: number };
		};
		if (tool === "list") {
			return reply(200, {
				result: {
					state: "all",
					project: null,
					issues: KILN_ISSUES,
					open: 2,
					closed: 1,
				},
			});
		}
		if (tool === "create") {
			return reply(200, {
				result: { issue: issue(3, "New one", "crates/lsp") },
			});
		}
		if (body.args.number === 404) {
			return reply(404, { error: { code: "not_found", message: "no issue" } });
		}
		return reply(200, { result: { issue: KILN_ISSUES[0] } });
	}
	if (url.pathname === "/-/api/blob") {
		const path = url.searchParams.get("path");
		if (path === "crates/lsp/forge.cue") {
			return reply(200, { text: 'package tartan\n\ndeps: ["core"]\n' });
		}
		if (path === "crates/lsp/README.md") return reply(200, { text: "# lsp" });
		return reply(404, { error: "not_found", message: "no file" });
	}
	if (url.pathname === "/-/api/tree") {
		const path = url.searchParams.get("path");
		return reply(200, {
			entries: path === "crates/lsp"
				? [{ type: "blob", name: "README.md", path: "crates/lsp/README.md" }]
				: [],
		});
	}
	if (url.pathname === "/-/api/log") {
		return reply(200, {
			commits: [{
				sha: "feed",
				subject: "the subject",
				authoredAt: 1,
				author: { name: "dev" },
			}],
		});
	}
	if (url.pathname === "/-/api/events") {
		return reply(200, {
			head: 2,
			events: [
				{
					seq: 1,
					type: "repo.created",
					at: 1,
					actor: { kind: "system", id: "s" },
					data: {},
				},
				{
					seq: 2,
					type: "push.accepted",
					at: 2,
					actor: { kind: "user", id: "u1" },
					data: { ref: "refs/heads/main", after: "feed" },
				},
			],
		});
	}
	return reply(404, { error: "not_found", message: `no ${url.pathname}` });
};

const forge = (
	status: Session["state"]["status"] = "signed-in",
	options: { readonly flatRefusal?: boolean } = {},
) => {
	const paths: string[] = [];
	const api = createApi(createHttp(fakeKernel(paths, options)));
	return {
		api,
		store: createForgeStore(api, session(status)),
		asked: () => [...paths],
	};
};

describe("addresses", () => {
	it("splits a project from its repo", () => {
		expect(parseAddress("oss/devtools/build/kiln:lsp")).toEqual({
			path: "oss/devtools/build/kiln",
			project: "lsp",
		});
		expect(parseAddress("oss/kiln")).toEqual({
			path: "oss/kiln",
			project: null,
		});
		expect(parseAddress("kiln:a.b-c")).toEqual({
			path: "kiln",
			project: "a.b-c",
		});
		expect(parseAddress("")).toEqual({ path: "", project: null });
	});

	it("rejects malformed addresses", () => {
		for (
			const bad of ["a:", ":a", "a:b:c", "a:b/c", "a//b", "/a", "a/", "a/:b"]
		) {
			expect([bad, parseAddress(bad)]).toEqual([bad, null]);
		}
	});

	it("formats what it parses", () => {
		for (const address of ["oss/kiln:lsp", "oss/kiln", ""]) {
			expect(formatAddress(parseAddress(address)!)).toBe(address);
		}
	});

	it("reads a page off a URL", () => {
		expect(parseUrl("/oss/kiln:lsp/-/issues/128")).toEqual({
			addr: "oss/kiln:lsp",
			tab: "issues",
			detail: { type: "issue", n: 128 },
		});
		expect(parseUrl("/-/new/group")).toEqual({
			addr: "",
			tab: "overview",
			detail: { type: "new-node", kind: "group" },
		});
		expect(parseUrl("/oss/-/nope").unknown).toBe(true);
		expect(parseUrl("/%E0%A4%A").unknown).toBe(true);
		expect(urlFor("oss/kiln:lsp", "issues")).toBe("/oss/kiln:lsp/-/issues");
		expect(urlFor("", "projects")).toBe("/-/projects");
		expect(urlFor("")).toBe("/");
	});

	it("reads addresses relative to where you are", () => {
		expect(rel("oss", "oss/kiln:lsp")).toBe("kiln:lsp");
		expect(rel("oss/kiln", "oss/kiln:lsp")).toBe("lsp");
		expect(rel("oss/kiln:core", "oss/kiln:lsp")).toBe("lsp");
		expect(rel("oss/kiln", "oss/kiln")).toBe("");
		expect(rel("", "oss/kiln")).toBe("oss/kiln");
		expect(rel("infra", "oss/kiln")).toBe("~/oss/kiln");
	});

	it("says how long ago", () => {
		const now = 10_000_000_000;
		expect(age(now - 5_000, now)).toBe("now");
		expect(age(now - 120_000, now)).toBe("2m");
		expect(age(now - 7_200_000, now)).toBe("2h");
		expect(age(now - 172_800_000, now)).toBe("2d");
	});

	it("reads an event, and shows an unknown one by name", () => {
		expect(describeEvent("push.accepted", {
			ref: "refs/heads/main",
			after: "abc",
		})).toEqual({ text: "Pushed to main", sha: "abc" });
		expect(describeEvent("repo.created", {})).toEqual({ text: "Repo created" });
		expect(describeEvent("what.ever", {})).toEqual({ text: "what.ever" });
	});
});

describe("role", () => {
	it("comes from the session and fails closed", () => {
		expect(forgeRole(session("signed-in", true))).toBe("owner");
		expect(forgeRole(session("signed-in", false))).toBe("contributor");
		for (
			const status of ["unknown", "loading", "anonymous", "error"] as const
		) {
			expect(forgeRole(session(status, true))).toBe("anon");
		}
	});
});

describe("theme", () => {
	it("resolves the same way as tokens.css", () => {
		expect(resolvesDark("dark", false)).toBe(true);
		expect(resolvesDark("light", true)).toBe(false);
		expect(resolvesDark("system", true)).toBe(true);
		expect(resolvesDark("system", false)).toBe(false);
	});
});

describe("forge data", () => {
	it("loads an address a level at a time, and finds nothing past a repo", async () => {
		const { store, asked } = forge();
		expect((await store.reach(`${KILN}:lsp`)).status).toBe("found");
		expect(asked()).toEqual([
			"/-/api/nodes",
			"/-/api/nodes?parent=oss",
			`/-/api/nodes?parent=${enc("oss/kiln-group")}`,
			`/-/api/repos/${KILN_ID}/projects`,
		]);
		expect((await store.reach(`${KILN}/lsp`)).status).toBe("missing");
		expect((await store.reach("oss:kiln-group")).status).toBe("missing");
		expect((await store.reach("nothing/here")).status).toBe("missing");
		expect((await store.reach("a//b")).status).toBe("missing");
	});

	it("takes a project's facts from the graph", async () => {
		const { store } = forge();
		await store.reach(`${KILN}:docs`);
		const docs = store.nodeAt(`${KILN}:docs`)!;
		expect(docs.root).toBe("site/docs");
		expect(docs.issuesEnabled).toBe(false);
		const lsp = store.nodeAt(`${KILN}:lsp`)!;
		expect(lsp.manifestPath).toBe("crates/lsp/forge.cue");
		expect(lsp.deps).toEqual(["core"]);
	});

	it("counts issues by project root, and leaves out what has no answer", async () => {
		const { store } = forge();
		await store.reach(`${KILN}:lsp`);
		const tree = store.state.tree as ForgeNode;
		expect(store.openCount(store.nodeAt(KILN)!)).toBeUndefined();
		await store.loadEverything();
		expect(store.openCount(store.nodeAt(KILN)!)).toBe(2);
		expect(store.openCount(store.nodeAt(`${KILN}:lsp`)!)).toBe(1);
		expect(store.openCount(store.nodeAt(`${KILN}:docs`)!)).toBeUndefined();
		// `plain` has no Issues: nothing to add, and not a refusal to report.
		expect(store.issuesAt(PLAIN)).toMatchObject({
			status: "refused",
			reason: "not_installed",
		});
		expect(store.openCount(tree)).toBe(2);
		expect(store.refusedUnder(tree)).toEqual([]);
		expect(store.issuesUnder(tree).map((i) => i.where)).toEqual([
			`${KILN}:lsp`,
			KILN,
			KILN,
		]);
		expect(projectsUnder(tree).map((p) => p.addr)).toEqual([
			`${KILN}:docs`,
			`${KILN}:lsp`,
			PLAIN,
		]);
	});

	it("does not ask for what a project has turned off, or a stranger can't read", async () => {
		const { store, asked } = forge();
		await store.reach(`${KILN}:docs`);
		await store.ensureIssues(`${KILN}:docs`);
		expect(store.issuesAt(`${KILN}:docs`)).toMatchObject({
			reason: "extension_disabled",
		});
		expect(asked().filter((p) => p.includes("/tools/"))).toEqual([]);

		const anon = forge("anonymous");
		await anon.store.reach(KILN);
		await anon.store.ensureIssues(KILN);
		expect(anon.store.issuesAt(KILN)).toMatchObject({
			reason: "unauthenticated",
		});
		expect(anon.asked().filter((p) => p.includes("/tools/"))).toEqual([]);
		expect(anon.store.openCount(anon.store.nodeAt(KILN)!)).toBeUndefined();
	});

	it("reads a tool's refusal in both wire shapes", async () => {
		const { store } = forge();
		await store.reach(KILN);
		await expect(store.getIssue(KILN, 404)).rejects.toMatchObject({
			status: 404,
			code: "not_found",
		});
		await store.reach(PLAIN);
		await store.ensureIssues(PLAIN);
		expect(store.issuesAt(PLAIN)).toMatchObject({ reason: "not_installed" });

		const flat = forge("signed-in", { flatRefusal: true });
		await flat.store.reach(KILN);
		await flat.store.ensureIssues(KILN);
		expect(flat.store.issuesAt(KILN)).toMatchObject({
			reason: "unauthenticated",
		});
	});

	it("reads a list again after a change to the repo", async () => {
		const { store, asked } = forge();
		await store.reach(`${KILN}:lsp`);
		await store.ensureIssues(KILN);
		await store.ensureIssues(`${KILN}:lsp`);
		const before = asked().filter((p) => p.endsWith("/tools/list")).length;
		const url = await store.createIssue(`${KILN}:lsp`, "New one", "");
		expect(url).toBe(`/${KILN}:lsp/-/issues/3`);
		expect(store.state.banner).toEqual({ path: url, text: "Issue opened." });
		expect(asked().filter((p) => p.endsWith("/tools/list")).length).toBe(
			before + 2,
		);
	});

	it("reads a project's file and a README that exists, and answers null otherwise", async () => {
		const { store } = forge();
		await store.reach(KILN);
		const kiln = store.nodeAt(KILN)!;
		expect(await store.readFile(kiln, "crates/lsp/forge.cue")).toBe(
			'package tartan\n\ndeps: ["core"]\n',
		);
		expect(await store.readFile(kiln, "absent")).toBeNull();
		expect(await store.readme(kiln, "crates/lsp")).toEqual({
			path: "crates/lsp/README.md",
			text: "# lsp",
		});
		expect(await store.readme(kiln, "site/docs")).toBeNull();
	});

	it("reads the activity log newest first, with commits named", async () => {
		const { store } = forge();
		await store.reach(KILN);
		const events = await store.activity(store.nodeAt(KILN)!, () => "dev");
		expect(events.map((e) => [e.text, e.subject])).toEqual([
			["Pushed to main", "the subject"],
			["Repo created", undefined],
		]);
	});
});

describe("ForgeApp", () => {
	const render = async (
		path: string,
		status: Session["state"]["status"] = "signed-in",
	): Promise<string> => {
		const router = createAppRouter({ history: createMemoryHistory() });
		await router.push(path);
		await router.isReady();
		const { store, api } = forge(status);
		const { addr } = parseUrl(path);
		await store.reach(addr);
		await store.loadEverything();
		const app = createSSRApp(ForgeApp);
		app.use(router);
		app.provide(SESSION, session(status));
		app.provide(API, api);
		app.provide(FORGE, store);
		return await renderToString(app);
	};

	it("renders a project at its address, with no made-up CI or releases", async () => {
		const html = await render(`/${KILN}:lsp`);
		expect(html).toContain("data-forge");
		expect(html).toContain("Tartan");
		expect(html).toContain("crates/lsp/forge.cue");
		expect(html).not.toMatch(/CI on main|Releases|Passing/);
	});

	it("says projects are discovered, on a monorepo", async () => {
		const html = await render(`/${KILN}`);
		expect(html).toContain("Discovered from package tartan files at abcdef1");
		expect(html).toContain("on every push to main");
		expect(html).toContain("site/docs/forge.cue");
	});

	it("does not decide an address before the kernel has answered", async () => {
		const html = await render(`/${KILN}/lsp`);
		expect(html).toContain("Loading");
		expect(html).not.toContain("Discovered from");
	});

	it("hides Issues where a project turns it off, and on a repo without it", async () => {
		const off = await render(`/${KILN}:docs`);
		expect(off).not.toContain("/-/issues");
		const on = await render(`/${KILN}:lsp`);
		expect(on).toContain(`${KILN}:lsp/-/issues`);
		const plain = await render(`/${PLAIN}`);
		expect(plain).not.toContain(`${PLAIN}/-/issues`);
	});

	it("renders the root, issues and new-node pages", async () => {
		expect(await render("/")).toContain("Open issues");
		expect(await render(`/${KILN}/-/issues`)).toContain("The lsp one");
		expect(await render("/oss/-/new/repo")).toContain("New repo in oss");
		expect(await render("/-/issues/new")).toContain(
			"Issues belong to a repo or a project.",
		);
	});

	it("has no way to make a repo at the root, which the kernel needs a parent for", async () => {
		const html = await render("/-/new/repo");
		expect(html).toContain("Nothing at that address.");
	});
});
