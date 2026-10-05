// The land HTTP API: repo resolution and `read` authorization first, then
// the RepoDO copy of why notes and advances; the dev route is invisible
// without dev tools and the dev key.

import { deepStrictEqual, equal } from "node:assert/strict";
import { denied, type NodeDto } from "@tartan/contract";
import type { Env } from "../../env.ts";
import type { RouteContext } from "../../router.ts";
import { devLandKey, handleDevLand } from "./dev.ts";
import type { AuthContext } from "@tartan/contract/kernel.ts";
import {
	createAdvancesHandler,
	createSeedHistoryHandler,
	createWhyHandler,
	type LandRoutesDeps,
} from "./routes.ts";

const REPO = "01k6rrrrrrrrrrrrrrrrrrrrrr";
const node = {
	id: REPO,
	parentId: null,
	kind: "repo",
	slug: "shop",
	path: "acme/shop",
	depth: 1,
	visibility: "private",
	archived: false,
	createdAt: 0,
} as unknown as NodeDto;

const ctx = (
	url: string,
	options: { rest?: string; env?: Partial<Env>; headers?: HeadersInit } = {},
) =>
	({
		req: new Request(url, { headers: options.headers }),
		url: new URL(url),
		params: options.rest !== undefined ? { rest: options.rest } : {},
		env: (options.env ?? {}) as Env,
		auth: null,
		ctx: { exports: {} },
	}) as unknown as RouteContext;

const deps = (
	allow: boolean,
	calls: string[],
): LandRoutesDeps => ({
	createAuthorize: () => (_auth, target, perm) => {
		calls.push(`authorize ${target.node.id} ${perm}`);
		if (!allow) return Promise.reject(denied("role"));
		return Promise.resolve(20);
	},
	tree: () =>
		({
			resolvePath: (path: string) =>
				Promise.resolve(
					path === "acme/shop" ? { node, rest: "" } : null,
				),
		}) as unknown as ReturnType<LandRoutesDeps["tree"]>,
	land: () =>
		({
			why: (q: unknown) => {
				calls.push(`why ${JSON.stringify(q)}`);
				return Promise.resolve(
					(q as { sha?: string }).sha === "abcdef1"
						? { commit: "a".repeat(40), note: null, events: [] }
						: null,
				);
			},
			status: (id: string) => {
				calls.push(`status ${id}`);
				return Promise.resolve(null);
			},
			advances: (f: unknown) => {
				calls.push(`advances ${JSON.stringify(f)}`);
				return Promise.resolve({ advances: [] });
			},
			seedHistory: (input: unknown) => {
				calls.push(`seed ${JSON.stringify(input)}`);
				return Promise.resolve({
					advances: 41,
					head: "b".repeat(40),
					withFakeKeys: [12, 31],
				});
			},
		}) as unknown as ReturnType<LandRoutesDeps["land"]>,
	audit: (_env, entry) => {
		calls.push(`audit ${JSON.stringify(entry)}`);
		return Promise.resolve();
	},
});

Deno.test("why: authorizes read on the repo, then answers from RepoDO", async () => {
	const calls: string[] = [];
	const why = createWhyHandler(deps(true, calls));
	const ok = await why(ctx("https://t/-/api/why?repo=acme/shop&sha=abcdef1"));
	equal(ok.status, 200);
	deepStrictEqual(await ok.json(), {
		repo: "acme/shop",
		commit: "a".repeat(40),
		note: null,
		events: [],
	});
	deepStrictEqual(calls, [`authorize ${REPO} read`, 'why {"sha":"abcdef1"}']);
	equal(
		(await why(ctx("https://t/-/api/why?repo=acme/shop&sha=abcdef2"))).status,
		404,
	);
	equal((await why(ctx("https://t/-/api/why?repo=acme/shop"))).status, 400);
	equal(
		(await why(ctx("https://t/-/api/why?repo=acme/shop&sha=a&path=b"))).status,
		400,
	);
	equal(
		(await why(ctx("https://t/-/api/why?repo=nope&sha=abcdef1"))).status,
		404,
	);
	const deniedCalls: string[] = [];
	const refused = await createWhyHandler(deps(false, deniedCalls))(
		ctx("https://t/-/api/why?repo=acme/shop&sha=abcdef1"),
	);
	equal(refused.status, 403);
	deepStrictEqual(
		deniedCalls,
		[`authorize ${REPO} read`],
		"no read before authz",
	);
});

Deno.test("advances: a page, a batch, and unknown ids", async () => {
	const calls: string[] = [];
	const advances = createAdvancesHandler(deps(true, calls));
	const page = await advances(
		ctx("https://t/-/api/advances?repo=acme/shop&limit=5", { rest: "" }),
	);
	equal(page.status, 200);
	deepStrictEqual(await page.json(), { advances: [] });
	const missing = await advances(
		ctx(
			"https://t/-/api/advances/lb_01k6xxxxxxxxxxxxxxxxxxxxxx?repo=acme/shop",
			{
				rest: "lb_01k6xxxxxxxxxxxxxxxxxxxxxx",
			},
		),
	);
	equal(missing.status, 404);
	const bad = await advances(
		ctx("https://t/-/api/advances/x?repo=acme/shop", { rest: "x" }),
	);
	equal(bad.status, 400);
	deepStrictEqual(calls.filter((c) => !c.startsWith("authorize")), [
		'advances {"limit":5}',
		"status lb_01k6xxxxxxxxxxxxxxxxxxxxxx",
	]);
});

Deno.test("dev land route: 404 without dev tools, the dev key or a valid key", async () => {
	const secret = "s3cret-root-key";
	const key = await devLandKey(secret);
	const url = `https://t/-/dev/land/${REPO}/status?batch=x`;
	const rest = `${REPO}/status`;
	const cases: [Partial<Env>, HeadersInit][] = [
		[{ TARTAN_STAGE: "prod", TARTAN_DEV_TOOLS: "1", TARTAN_SECRET: secret }, {
			"x-tartan-dev-key": key,
		}],
		[
			{
				TARTAN_STAGE: "dev-wp10",
				TARTAN_DEV_TOOLS: "0",
				TARTAN_SECRET: secret,
			},
			{
				"x-tartan-dev-key": key,
			},
		],
		[
			{
				TARTAN_STAGE: "dev-wp10",
				TARTAN_DEV_TOOLS: "1",
				TARTAN_SECRET: secret,
			},
			{},
		],
		[
			{
				TARTAN_STAGE: "dev-wp10",
				TARTAN_DEV_TOOLS: "1",
				TARTAN_SECRET: secret,
			},
			{
				"x-tartan-dev-key": key.replace(/.$/, "0"),
			},
		],
		[{ TARTAN_STAGE: "dev-wp10", TARTAN_DEV_TOOLS: "1" }, {
			"x-tartan-dev-key": key,
		}],
	];
	for (const [env, headers] of cases) {
		const response = await handleDevLand(ctx(url, { rest, env, headers }));
		equal(response.status, 404, JSON.stringify(env));
		equal(await response.text(), "");
	}
});

const admin: AuthContext = {
	principal: "u_01k6adminadminadminadminad",
	kind: "user",
	via: "session",
	scopes: ["api"],
	nodeId: null,
	laneId: null,
	maxRole: 50,
	isAdmin: true,
};

const seedCtx = (
	auth: AuthContext | null,
	env: Partial<Env>,
	body: unknown = { count: 41 },
	method = "POST",
) =>
	({
		req: new Request("https://t/-/api/seed-history?repo=acme/shop", {
			method,
			...(method === "POST" ? { body: JSON.stringify(body) } : {}),
		}),
		url: new URL("https://t/-/api/seed-history?repo=acme/shop"),
		params: {},
		env: env as Env,
		auth,
		ctx: { exports: {} },
	}) as unknown as RouteContext;

const DEV = { TARTAN_STAGE: "dev-demo", TARTAN_DEV_TOOLS: "1" };

Deno.test("seed-history: a forge admin on a dev stage with dev tools seeds through RepoDO", async () => {
	const calls: string[] = [];
	const seed = createSeedHistoryHandler(deps(true, calls));
	const res = await seed(seedCtx(admin, DEV));
	equal(res.status, 201);
	deepStrictEqual(await res.json(), {
		repo: "acme/shop",
		advances: 41,
		head: "b".repeat(40),
		withFakeKeys: [12, 31],
	});
	deepStrictEqual(calls.slice(0, 2), [
		`authorize ${REPO} install-privileged`,
		`seed {"count":41,"actor":{"kind":"user","id":"${admin.principal}"}}`,
	]);
	// The seed is in the forge audit log, with what it wrote.
	deepStrictEqual(calls.slice(2).map((c) => JSON.parse(c.slice(6))), [{
		principal: admin.principal,
		action: "land.seed_history",
		target: REPO,
		data: {
			repo: "acme/shop",
			count: 41,
			advances: 41,
			head: "b".repeat(40),
			withFakeKeys: [12, 31],
		},
	}]);
});

Deno.test("seed-history: a reader of the repo (an admin token bounded to Reporter) is refused before anything is seeded", async () => {
	const calls: string[] = [];
	const base = deps(true, calls);
	const seed = createSeedHistoryHandler({
		...base,
		createAuthorize: () => (_auth, target, perm) => {
			calls.push(`authorize ${target.node.id} ${perm}`);
			// The caller may read the repo, nothing more.
			return perm === "read"
				? Promise.resolve(20)
				: Promise.reject(denied("role"));
		},
	});
	const res = await seed(seedCtx({ ...admin, via: "pat", maxRole: 20 }, DEV));
	equal(res.status, 403);
	deepStrictEqual(calls, [`authorize ${REPO} install-privileged`]);
});

Deno.test("seed-history: absent without dev tools, refused to agents and non-admins, nothing seeded", async () => {
	const calls: string[] = [];
	const seed = createSeedHistoryHandler(deps(true, calls));
	for (
		const env of [
			{},
			{ TARTAN_STAGE: "production", TARTAN_DEV_TOOLS: "1" },
			{ TARTAN_STAGE: "dev-demo", TARTAN_DEV_TOOLS: "0" },
		]
	) {
		equal((await seed(seedCtx(admin, env))).status, 404, JSON.stringify(env));
	}
	equal((await seed(seedCtx(null, DEV))).status, 404);
	equal((await seed(seedCtx(admin, DEV, {}, "GET"))).status, 404);
	equal(
		(await seed(seedCtx({ ...admin, kind: "agent", via: "agent-token" }, DEV)))
			.status,
		403,
	);
	equal((await seed(seedCtx({ ...admin, isAdmin: false }, DEV))).status, 403);
	equal((await seed(seedCtx(admin, DEV, { count: "41" }))).status, 400);
	deepStrictEqual(calls, []);
});
