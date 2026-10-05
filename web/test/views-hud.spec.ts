// The HUD page (WP19 view hosting WP20's tartan.hud: every judge question
// has a screen reachable in ≤ 2 clicks from the HUD)
// mounted with the real router and API client over the mock kernel: the
// forge home shows each namespace's `hud` and `home` views, `?node=` one
// node's (a repo adds its repo-scoped metrics), and "Where to look" links
// every judge question in one click. The model's walk and links are pure.

import { describe, expect, it, vi } from "vitest";
import type { NodeDto, NodesResponse } from "@tartan/contract/api.ts";
import { instId } from "../src/api/mock/fixtures.ts";
import { HUD_NUMBERS } from "../src/api/mock/hud.ts";
import {
	hudHref,
	JUDGE_QUESTIONS,
	MAX_GUIDE_REPOS,
	questionLinks,
	selectedNode,
	walkRepos,
} from "../src/views/coord/hud/model.ts";
import { mountApp } from "./support/app.ts";
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
	it("renders tartan.hud's five metrics and the real/simulated split for acme", async () => {
		const app = await mountApp("/");
		await settle(app);
		const hud = instId("tartan.hud");
		const renders = app.calls
			.map((c) => c.path)
			.filter((p) => p.startsWith(`/-/api/slot/${hud}/`))
			.map((p) => p.split("?")[0]!.split("/").at(-1));
		expect(renders.sort()).toEqual([
			"active-lanes",
			"conflicts-avoided",
			"landed-per-hour",
			"needed-a-human",
			"predicted-conflicts",
			"swarm",
		]);
		const section = byAttr(app.root, "data-hud-node", "acme")[0]!;
		const t = text(section);
		expect(t).toContain("Active lanes");
		expect(t).toContain(String(HUD_NUMBERS.activeLanes));
		expect(t).toContain("Simulated agents (swarm)");
		expect(t).toContain("300 of them simulated agents (swarm)");
		expect(t).toContain("Needed a human");
		// The slot ctx names the namespace only (`hud.metric` takes the forge).
		const ctx =
			app.calls.find((c) =>
				c.path.startsWith(`/-/api/slot/${hud}/active-lanes`)
			)!.path;
		const hint = JSON.parse(
			atob(
				new URL(`https://x${ctx}`).searchParams.get("ctx")!.replace(/-/g, "+")
					.replace(/_/g, "/"),
			),
		);
		expect(hint).toEqual({ node: "acme" });
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
			q2: "/acme/platform/router/-/radar",
			q3: "/acme/platform/router/-/changes",
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
	it("a repository adds its repo-scoped metrics and sections", async () => {
		const app = await mountApp(
			`/-/hud?node=${encodeURIComponent("acme/platform/router")}`,
		);
		await vi.waitFor(() =>
			expect(byAttr(app.root, "data-hud-node").length).toBe(1)
		);
		await flush();
		const renders = app.calls.map((c) => c.path.split("?")[0]);
		expect(renders).toContain(
			`/-/api/slot/${instId("tartan.radar")}/conflicts-avoided`,
		);
		expect(renders).toContain(
			`/-/api/slot/${instId("tartan.weave")}/landed-per-hour`,
		);
		expect(renders).toContain(
			`/-/api/slot/${instId("tartan.review")}/attention`,
		);
		const t = text(app.root);
		expect(t).toContain("HUD · acme/platform/router");
		expect(t).toContain("Needs your review");
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
	const tab = (route: string) => ({
		installationId: "i_x",
		ext: "x",
		slot: "repo.tab" as const,
		id: route,
		route,
		order: 0,
	});

	it("falls back to kernel views when an extension tab is missing", () => {
		const weaveOnly = Object.fromEntries(
			questionLinks("a/b", [tab("weave")]).map((l) => [l.id, l.href]),
		);
		expect(weaveOnly["q2"]).toBe("/a/b/-/weave");
		expect(weaveOnly["q3"]).toBe("/a/b/-/advances");
		const none = Object.fromEntries(
			questionLinks("a/b", []).map((l) => [l.id, l.href]),
		);
		expect(none["q2"]).toBe("/a/b/-/lanes");
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
