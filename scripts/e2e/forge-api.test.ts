// The launcher's forge API client on a fake fetch.

import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { CHILDREN_PAGES_MAX, createForgeApi } from "./forge-api.ts";

const ORIGIN = "https://tartan-dev-e2e.acme.workers.dev";

Deno.test("children reads every page, so a teardown sees all of a run's repos", async () => {
	const asked: string[] = [];
	const pages: Record<string, { nodes: { slug: string }[]; cursor?: string }> =
		{
			"": { nodes: [{ slug: "r1-a" }, { slug: "r1-b" }], cursor: "c1" },
			c1: { nodes: [{ slug: "r2-a" }], cursor: "c2" },
			c2: { nodes: [{ slug: "r3-a" }] },
		};
	const fetchFn = ((url: string) => {
		const u = new URL(url);
		asked.push(u.search);
		equal(u.searchParams.get("parent"), "e2e/swarm");
		return Promise.resolve(
			Response.json(pages[u.searchParams.get("cursor") ?? ""]),
		);
	}) as unknown as typeof fetch;
	const api = createForgeApi(fetchFn, ORIGIN);
	const nodes = await api.children({ kind: "bearer", token: "t" }, "e2e/swarm");
	deepStrictEqual(nodes.map((n) => n.slug), ["r1-a", "r1-b", "r2-a", "r3-a"]);
	equal(asked.length, 3);

	const endless = ((url: string) =>
		Promise.resolve(
			Response.json({
				nodes: [],
				cursor: `${new URL(url).searchParams.get("cursor") ?? ""}x`,
			}),
		)) as unknown as typeof fetch;
	await rejects(
		() =>
			createForgeApi(endless, ORIGIN).children(
				{ kind: "bearer", token: "t" },
				"e2e/swarm",
			),
		new RegExp(`more than ${CHILDREN_PAGES_MAX} pages`),
	);
});
