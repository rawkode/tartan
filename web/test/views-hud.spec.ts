// The HUD page (WP19 view hosting the `hud.metric` and `home.section` slots:
// every judge question has a screen reachable in ≤ 2 clicks from the HUD)
// mounted with the real router and API client over the mock kernel with the
// sample catalog: the forge home shows each namespace's `hud` and `home`
// views, `?node=` one node's, and "Where to look" links every judge question
// in one click. The model's walk and links are pure.

import { describe, expect, it, vi } from "vitest";
import type { NodeDto, NodesResponse } from "@tartan/contract/api.ts";
import { EMPTY_CATALOG } from "../src/api/mock/catalog.ts";
import {
	hudHref,
	JUDGE_QUESTIONS,
	MAX_GUIDE_REPOS,
	questionLinks,
	selectedNode,
	walkRepos,
} from "../src/views/coord/hud/model.ts";
import { mountApp } from "./support/app.ts";
import { instId, NOTES } from "./support/catalog.ts";
import {
	byAttr,
	byTag,
	flush,
	type TestElement,
	text,
} from "./support/renderer.ts";

const links = (root: TestElement): string[] =>
	byTag(root, "a").map((a) => a.attrs["href"] ?? "");

const settle = async (app: Awaited<ReturnType<typeof mountApp>>) => {
	await vi.waitFor(() => {
		expect(byAttr(app.root, "data-guide-repo").length).toBeGreaterThan(0);
	});
	await flush();
};

describe("the forge home hosts each namespace's HUD", () => {
	it("renders the metrics and sections installed on acme", async () => {
		const app = await mountApp("/");
		await settle(app);
		const notes = instId(NOTES);
		const renders = app.calls
			.map((c) => c.path)
			.filter((p) => p.startsWith(`/-/api/slot/${notes}/`))
			.map((p) => p.split("?")[0]!.split("/").at(-1));
		expect(renders.sort()).toEqual(["count", "recent"]);
		const section = byAttr(app.root, "data-hud-node", "acme")[0]!;
		const t = text(section);
		expect(t).toContain("Notes");
		expect(t).toContain("42");
		expect(t).toContain("Recent sample notes");
		// The slot ctx names the namespace only (`hud.metric` takes the forge).
		const ctx =
			app.calls.find((c) => c.path.startsWith(`/-/api/slot/${notes}/count`))!
				.path;
		const hint = JSON.parse(
			atob(
				new URL(`https://x${ctx}`).searchParams.get("ctx")!.replace(/-/g, "+")
					.replace(/_/g, "/"),
			),
		);
		expect(hint).toEqual({ node: "acme" });
	});

	it("says what to install when no namespace has a HUD", async () => {
		const app = await mountApp("/", { mock: { catalog: EMPTY_CATALOG } });
		await vi.waitFor(() => expect(text(app.root)).toContain("No HUD yet"));
		expect(byAttr(app.root, "data-hud-node")).toEqual([]);
		expect(links(app.root)).toContain("/-/extensions");
	});

	it("leaves out namespaces without a HUD and keeps the namespace list", async () => {
		const app = await mountApp("/");
		await settle(app);
		expect(byAttr(app.root, "data-hud-node", "rawkode")).toEqual([]);
		expect(links(app.root)).toContain("/rawkode");
		expect(links(app.root)).toContain(hudHref("acme"));
	});
});

describe("where to look: every judge question in one click", () => {
	it("lists the repositories found with a link per question", async () => {
		const app = await mountApp("/");
		await settle(app);
		const rows = byAttr(app.root, "data-guide-repo");
		expect(rows.map((r) => r.attrs["data-guide-repo"])).toContain(
			"acme/platform/router",
		);
		expect(rows.length).toBeLessThanOrEqual(MAX_GUIDE_REPOS);
		const router = byAttr(app.root, "data-guide-repo", "acme/platform/router")[
			0
		]!;
		const byQuestion = Object.fromEntries(
			byAttr(router, "data-question-link").map((a) => [
				a.attrs["data-question-link"],
				a.attrs["href"],
			]),
		);
		expect(byQuestion).toEqual({
			q1: "/acme/platform/router/-/lanes",
			q2: "/acme/platform/router/-/lanes",
			q3: "/acme/platform/router/-/advances",
			q4: "/acme/platform/router/-/advances",
			q5: "/-/extensions",
		});
		expect(links(router)).toContain(hudHref("acme/platform/router"));
		expect(
			byAttr(app.root, "data-question").map((q) => q.attrs["data-question"]),
		).toEqual(JUDGE_QUESTIONS.map((q) => q.id));
	});

	it("each question's page is one click away and routes", async () => {
		const app = await mountApp("/");
		await settle(app);
		const router = byAttr(app.root, "data-guide-repo", "acme/platform/router")[
			0
		]!;
		for (const a of byAttr(router, "data-question-link")) {
			const href = a.attrs["href"]!;
			const resolved = app.router.resolve(href);
			expect(resolved.matched.length, href).toBeGreaterThan(0);
			expect(String(resolved.name), href).not.toBe("not-found");
		}
	});
});

describe("one node's HUD (?node=)", () => {
	it("a repository shows its own HUD, without the namespace list", async () => {
		const app = await mountApp(
			`/-/hud?node=${encodeURIComponent("acme/platform/router")}`,
		);
		await vi.waitFor(() =>
			expect(byAttr(app.root, "data-hud-node").length).toBe(1)
		);
		await flush();
		const renders = app.calls.map((c) => c.path.split("?")[0]);
		expect(renders).toContain(`/-/api/slot/${instId(NOTES)}/count`);
		expect(renders).toContain(`/-/api/slot/${instId(NOTES)}/recent`);
		const t = text(app.root);
		expect(t).toContain("HUD · acme/platform/router");
		expect(t).not.toContain("Namespaces");
		expect(links(app.root)).not.toContain(hudHref("acme/platform/router"));
	});

	it("a node with no HUD says what to install", async () => {
		const app = await mountApp("/-/hud?node=rawkode");
		await vi.waitFor(() =>
			expect(text(app.root)).toContain(
				"Nothing on rawkode contributes HUD metrics",
			)
		);
		expect(links(app.root)).toContain("/-/extensions");
	});

	it("an unknown node is a not-found page", async () => {
		const app = await mountApp("/-/hud?node=nobody");
		await vi.waitFor(() => expect(text(app.root)).toContain("was not found"));
	});
});

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const n = (path: string, kind: NodeDto["kind"], archived = false): NodeDto =>
	({
		id: path,
		parentId: null,
		kind,
		slug: path.split("/").at(-1)!,
		path,
		depth: path.split("/").length - 1,
		visibility: "internal",
		archived,
		createdAt: 0,
	}) as NodeDto;

const tree = (
	map: Record<string, readonly NodeDto[]>,
	calls: string[] = [],
): (parent: string) => Promise<NodesResponse> =>
(parent) => {
	calls.push(parent);
	return Promise.resolve({ nodes: map[parent] ?? [] });
};

describe("walkRepos", () => {
	it("walks breadth first, skips sim groups and archived nodes", async () => {
		const walked = await walkRepos(
			[n("rawkode", "user")],
			tree({
				rawkode: [
					n("rawkode/platform", "group"),
					n("rawkode/docs", "repo"),
					n("rawkode/sim", "group"),
					n("rawkode/old", "repo", true),
				],
				"rawkode/platform": [n("rawkode/platform/edge", "group")],
				"rawkode/platform/edge": [n("rawkode/platform/edge/router", "repo")],
			}),
		);
		expect(walked.repos.map((r) => r.path)).toEqual([
			"rawkode/docs",
			"rawkode/platform/edge/router",
		]);
		expect(walked.simGroups).toEqual(["rawkode/sim"]);
		expect(walked.truncated).toBe(false);
	});

	it("stops at its call and repo limits and says so", async () => {
		const many = Array.from({ length: 10 }, (_, i) => n(`a/r${i}`, "repo"));
		const capped = await walkRepos([n("a", "group")], tree({ a: many }), {
			repos: 3,
		});
		expect(capped.repos).toHaveLength(3);
		expect(capped.truncated).toBe(true);
		const calls: string[] = [];
		const deep: Record<string, NodeDto[]> = {};
		for (let i = 0; i < 20; i++) deep[`g${i}`] = [n(`g${i + 1}`, "group")];
		const stopped = await walkRepos([n("g0", "group")], tree(deep, calls), {
			calls: 4,
		});
		expect(calls).toHaveLength(4);
		expect(stopped.truncated).toBe(true);
	});

	it("lists a repo root as is", async () => {
		const walked = await walkRepos([n("a/b", "repo")], tree({}));
		expect(walked.repos.map((r) => r.path)).toEqual(["a/b"]);
	});
});

describe("questionLinks and selectedNode", () => {
	it("links every question to a kernel view", () => {
		const links = Object.fromEntries(
			questionLinks("a/b").map((l) => [l.id, l.href]),
		);
		expect(links).toEqual({
			q1: "/a/b/-/lanes",
			q2: "/a/b/-/lanes",
			q3: "/a/b/-/advances",
			q4: "/a/b/-/advances",
			q5: "/-/extensions",
		});
	});

	it("accepts node paths only", () => {
		expect(selectedNode("acme/platform/router")).toBe("acme/platform/router");
		expect(selectedNode(["acme"])).toBe("acme");
		expect(selectedNode("/acme/")).toBe("acme");
		expect(selectedNode("../etc")).toBeNull();
		expect(selectedNode("-/api")).toBeNull();
		expect(selectedNode(undefined)).toBeNull();
	});
});
