// The routes the SPA's API client calls (web/src/api/client.ts),
// as the owner, from the page with the owner's session. None may answer 405,
// 501 or a 404 for the route itself ("no route for …", "route"): those are
// the admin 404/501 regressions. A 404 for a thing (an unknown id)
// is fine. Routes the SPA still calls but the kernel does not serve yet are
// listed as pending tests that flip when they are fixed. `/-/api/me`
// answers each persona with the right role, and anonymous callers with no
// principal.

import { expect } from "e2e";
import type {
	InstallationsResponse,
	ViewResponse,
} from "@tartan/contract/api.ts";
import { test } from "../support/fixtures.ts";
import {
	type Api,
	boundedFetch,
	isUnrouted,
	ok,
	pageApi,
	query,
	type Reply,
	routeProblem,
	tokenApi,
} from "../support/http.ts";
import { PACK_GROUP } from "../support/names.ts";
import { packSlots, packTabs } from "../support/tabs.ts";
import { meOf } from "../support/page.ts";
import { FIXTURE_HEAD } from "../support/fixture-repo.ts";
import { fixtureRepo } from "../support/repos.ts";
import { type Stage, tokensOf, usernameOf } from "../support/stage.ts";

type Route = {
	readonly method: "GET" | "POST" | "PUT";
	readonly path: string;
	readonly body?: unknown;
};

const call = (api: Api, r: Route): Promise<Reply<unknown>> =>
	r.method === "GET" ? api.get(r.path) : api.send(r.method, r.path, r.body);

/** The SPA client's read routes, filled in for the run's fixture repo. */
const readRoutes = async (stage: Stage): Promise<Route[]> => {
	const repo = await fixtureRepo(stage, "classic", "api");
	const owner = tokenApi(stage.origin, tokensOf(stage).ownerPat);
	const installs = ok(
		"GET",
		"/-/api/installations",
		await owner.get<InstallationsResponse>(
			`/-/api/installations?${query({ node: PACK_GROUP.classic })}`,
		),
	).installations;
	const inst = installs.find((i) => i.installation.storageScope === "node") ??
		installs[0];
	const r = encodeURIComponent(repo.id);
	const [first, , last] = repo.shas;
	const get = (path: string): Route => ({ method: "GET", path });
	return [
		get("/-/health"),
		get("/-/api/me"),
		get(`/-/api/nodes?${query({ parent: "e2e" })}`),
		get(`/-/api/view?${query({ path: repo.path, view: "" })}`),
		get(`/-/api/view?${query({ path: repo.path, view: "work" })}`),
		get(`/-/api/tree?${query({ repo: repo.path, ref: "main", path: "" })}`),
		get(
			`/-/api/blob?${
				query({ repo: repo.path, ref: "main", path: "README.md" })
			}`,
		),
		get(`/-/api/log?${query({ repo: repo.path, ref: "main" })}`),
		get(`/-/api/commit?${query({ repo: repo.path, sha: last })}`),
		get(
			`/-/api/compare?${query({ repo: repo.path, base: first, head: last })}`,
		),
		get(`/-/api/lanes?${query({ repo: repo.path })}`),
		get(`/-/api/repos/${r}/lanes/settings`),
		get(`/-/api/repos/${r}/config`),
		get(`/-/api/repos/${r}/config/schema`),
		get(`/-/api/events?${query({ repo: repo.id })}`),
		get(`/-/api/runs/${r}`),
		get(`/-/api/advances?${query({ repo: repo.path })}`),
		get(`/-/api/why?${query({ repo: repo.path, path: "README.md" })}`),
		get("/-/api/agents"),
		get("/-/api/tokens"),
		get("/-/api/packages"),
		get(`/-/api/installations?${query({ node: PACK_GROUP.classic })}`),
		...(inst === undefined ? [] : [
			get(`/-/api/installations/${encodeURIComponent(inst.installation.id)}`),
			get(
				`/-/api/installations/${
					encodeURIComponent(inst.installation.id)
				}/console`,
			),
		]),
		{ method: "POST", path: "/-/setup/status" },
		get(`/-/agents.md?${query({ path: PACK_GROUP.classic })}`),
	];
};

test.describe("API routes the SPA calls", {
	tags: ["api", "regression", "admin-routes"],
}, () => {
	test("every read route the SPA calls is served", {
		session: "owner",
		tags: ["owner", "smoke"],
	}, async ({ app, browser, stage }) => {
		await app.open("/");
		const api = pageApi(browser);
		const broken: string[] = [];
		for (const route of await readRoutes(stage)) {
			const reply = await call(api, route);
			const problem = routeProblem(reply);
			if (problem !== null) {
				broken.push(
					`${route.method} ${
						route.path.split("?")[0]
					} ${reply.status} (${problem})`,
				);
			}
		}
		// Unrouted (405, 501, a route 404) or crashed (5xx): both fail.
		expect(broken, "routes the kernel does not serve").toEqual([]);
	});

	test("/-/health has the expected shape", { tags: ["anonymous"] }, async ({
		stage,
	}) => {
		const { status, health } = await boundedFetch(
			`${stage.origin}/-/health`,
			{},
			"GET /-/health",
			async (response) => ({
				status: response.status,
				health: await response.json() as Record<string, unknown>,
			}),
		);
		expect(status).toBe(200);
		expect(health).toMatchObject({
			ok: true,
			product: "Tartan",
			stage: "dev-e2e",
			setupState: "done",
			version: expect.any(String),
			bindings: expect.any(Object),
		});
	});

	test("/-/agents.md describes the Classic protocol to the owner", {
		session: "owner",
		tags: ["owner"],
	}, async ({ app, browser }) => {
		await app.open("/");
		const reply = await browser.evaluate(async (path: string) => {
			const r = await fetch(path);
			return {
				status: r.status,
				type: r.headers.get("content-type") ?? "",
				text: await r.text(),
			};
		}, `/-/agents.md?${query({ path: PACK_GROUP.classic })}`);
		expect(reply.status).toBe(200);
		expect(reply.type).toMatch(/^text\//);
		expect(reply.text).toContain("Tartan");
	});

	for (const persona of ["owner", "developer", "reporter"] as const) {
		test(`/-/api/me names the ${persona}`, {
			session: persona,
			tags: [persona],
		}, async ({ app, browser }) => {
			await app.open("/");
			const me = await meOf(browser);
			expect(me.principal?.handle).toBe(usernameOf(persona));
			expect(me.auth?.isAdmin).toBe(persona === "owner");
		});
	}

	test("/-/api/me names nobody for an anonymous caller", {
		tags: ["anonymous"],
	}, async ({ app, browser }) => {
		await app.open("/");
		const me = await meOf(browser);
		expect(me.principal).toBeNull();
	});

	test("the view of a repo carries its node, viewer and slots", {
		session: "developer",
		tags: ["developer"],
	}, async ({ app, browser, stage }) => {
		const repo = await fixtureRepo(stage, "classic", "api");
		await app.open("/");
		const view = ok(
			"GET",
			"/-/api/view",
			await pageApi(browser).get<ViewResponse>(
				`/-/api/view?${query({ path: repo.path, view: "" })}`,
			),
		);
		expect(view.node).toMatchObject({
			kind: "repo",
			path: repo.path,
		});
		expect(view.viewer.role).toBe(30);
		expect(view.repo?.trunkSha).toBe(FIXTURE_HEAD);
		// The repo home's dynamic slots: exactly the Classic members'
		// `repo.sidebar` contributions, from the manifests.
		const expected = packSlots("classic", "repo.sidebar")
			.map((s) => `${s.ext}:${s.id}`).sort();
		expect(expected.length, "Classic contributes a repo.sidebar")
			.toBeGreaterThan(
				0,
			);
		expect(
			view.slots.filter((s) => s.slot === "repo.sidebar")
				.map((s) => `${s.ext}:${s.id}`).sort(),
		).toEqual(expected);
		// And the static tabs: every Classic `repo.tab`.
		const tabs = packTabs().filter((t) =>
			t.pack === "classic" && t.slot === "repo.tab"
		).map((t) => t.id).sort();
		expect(
			view.static.tabs.filter((t) => t.slot === "repo.tab").map((t) => t.id)
				.sort(),
		).toEqual(tabs);
	});

	for (
		const [method, path, why] of [
			["GET", "/-/api/settings", "the forge settings summary"],
			["GET", "/-/api/admin/selftest/lanes", "the last lane self-test"],
			["POST", "/-/api/admin/root-key/export", "the root key export"],
		] as const
	) {
		test(`pending: ${method} ${path} is served (${why})`, {
			session: "owner",
			tags: ["owner", "pending"],
			skip: `pending: ${why} is not served yet`,
		}, async ({ app, browser }) => {
			await app.open("/");
			const reply = await call(pageApi(browser), { method, path });
			expect(isUnrouted(reply)).toBe(false);
		});
	}
});
