// Route table, params, link builders and the first-run guard.

import { describe, expect, it } from "vitest";
import { createMemoryHistory } from "vue-router";
import { createAppRouter } from "../src/router/index.ts";
import {
	createSetupGuard,
	SETUP_GUARD_TIMEOUT_MS,
} from "../src/router/guards.ts";
import {
	blobHref,
	changeHref,
	compareHref,
	nodePathParam,
	parseRange,
	refAndPath,
	treeHref,
} from "../src/router/params.ts";

const resolve = async (path: string) => {
	const router = createAppRouter({ history: createMemoryHistory() });
	await router.push(path);
	return router.currentRoute.value;
};

describe("routes", () => {
	it("resolves node, repo and kernel views", async () => {
		expect((await resolve("/acme/platform")).name).toBe("node");
		expect((await resolve("/acme/platform/router/-/tree/main/src")).name).toBe(
			"repo-tree",
		);
		expect((await resolve("/acme/r/-/changes/abc")).name).toBe("change");
		expect((await resolve("/acme/r/-/changes/abc/checks")).params["tab"]).toBe(
			"checks",
		);
		expect((await resolve("/acme/r/-/work/w1")).name).toBe("work-item");
		expect((await resolve("/acme/r/-/lanes")).name).toBe("lanes");
		expect((await resolve("/acme/r/-/radar")).name).toBe("slot-tab");
		expect((await resolve("/acme/r/-/settings")).name).toBe("node-settings");
		expect((await resolve("/acme/r/-/settings/extensions")).name).toBe(
			"repo-config",
		);
		expect((await resolve("/-/agents")).name).toBe("agents");
		expect((await resolve("/-/nope")).name).toBe("forge-not-found");
	});

	it("keeps a ref with slashes as one segment and the rest as the path", async () => {
		const href = blobHref("acme/r", "lanes/ln_x", "src/a b.ts");
		expect(href).toBe("/acme/r/-/blob/lanes%2Fln_x/src/a%20b.ts");
		const route = await resolve(href);
		expect(route.name).toBe("repo-file");
		expect(nodePathParam(route.params)).toBe("acme/r");
		expect(refAndPath(route.params, "main")).toEqual({
			ref: "lanes/ln_x",
			path: "src/a b.ts",
		});
	});

	it("defaults the ref when the tree route has none", async () => {
		const route = await resolve(
			treeHref("acme/r", "main").replace(/\/main$/, ""),
		);
		expect(refAndPath(route.params, "trunk")).toEqual({
			ref: "trunk",
			path: "",
		});
	});

	it("builds compare and change links", () => {
		expect(compareHref("acme/r", "main", "lanes/x")).toBe(
			"/acme/r/-/compare/main...lanes%2Fx",
		);
		expect(changeHref("acme/r", "kqzv", "checks")).toBe(
			"/acme/r/-/changes/kqzv/checks",
		);
		expect(parseRange("main...lanes/x")).toEqual({
			base: "main",
			head: "lanes/x",
		});
		expect(parseRange("a..b")).toEqual({ base: "a", head: "b" });
		expect(parseRange("nothing")).toBeNull();
	});
});

describe("first-run guard", () => {
	it("sends every page to the wizard until setup is done, then caches done", async () => {
		let state: "fresh" | "done" = "fresh";
		let calls = 0;
		const guard = createSetupGuard(() => {
			calls += 1;
			return Promise.resolve(state);
		});
		const router = createAppRouter({ history: createMemoryHistory() });
		router.beforeEach(guard);
		await router.push("/-/explore");
		expect(router.currentRoute.value.name).toBe("setup");
		await router.push("/-/leaving?to=https://x.example");
		expect(router.currentRoute.value.name).toBe("leaving");
		state = "done";
		await router.push("/-/explore");
		expect(router.currentRoute.value.name).toBe("explore");
		await router.push("/-/agents");
		expect(calls).toBe(2);
	});

	it("never blocks navigation when health is unreachable", async () => {
		const router = createAppRouter({ history: createMemoryHistory() });
		router.beforeEach(
			createSetupGuard(() => Promise.reject(new Error("down"))),
		);
		await router.push("/-/explore");
		expect(router.currentRoute.value.name).toBe("explore");
	});

	it("goes on after the bound when health never answers (e2e blank page), and asks again next time", async () => {
		let calls = 0;
		const router = createAppRouter({ history: createMemoryHistory() });
		router.beforeEach(
			createSetupGuard(() => {
				calls += 1;
				return new Promise(() => {});
			}, { timeoutMs: 15 }),
		);
		const started = Date.now();
		await router.push("/-/explore");
		expect(router.currentRoute.value.name).toBe("explore");
		expect(Date.now() - started).toBeLessThan(1000);
		// `done` was never seen, so the next navigation checks again.
		await router.push("/-/agents");
		expect(calls).toBe(2);
	});

	it("bounds the wait at about 3 s by default", () => {
		expect(SETUP_GUARD_TIMEOUT_MS).toBe(3000);
	});
});
