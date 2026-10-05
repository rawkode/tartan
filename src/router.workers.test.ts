/// <reference types="@cloudflare/vitest-pool-workers/types" />
// The router through the real Worker entry: every
// route answers (health 200, stubs 501 naming route and owner), method
// mismatches are 405, Worker-owned prefixes 404, everything else reaches the
// SPA assets. Pure matcher tests are in router.test.ts.

import { createExecutionContext } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import {
	COMPAT_DATE,
	type HealthResponse,
	PRODUCT_NAME,
} from "@tartan/contract";
import { describe, expect, it } from "vitest";
import { testEnv as env } from "../test/env.ts";
import { BINDING_NAMES } from "./env.ts";
import worker from "./index.ts";
import { devRunsKey } from "./kernel/runs/routes.ts";
import { createRouter, ROUTES, type SecurityMiddleware } from "./router.ts";

const ORIGIN = "https://tartan.test";
const LANE = "ln_01k0000000000000000000000a";
const REPO_ID = "01k6aaaaaaaaaaaaaaaaaaaaaa";
// Valid `CAP_PATH_RE` syntax; nothing behind it is checked by a stub.
const CAP = `/-/cap/v1/1790000000/${LANE}/${"0".repeat(32)}/${
	"ab".repeat(32)
}/${REPO_ID}.git`;

/**
 * The route table alone, behind a pass-through middleware: WP2's policy
 * enforcement (setup gating, host, auth, CSRF) is tested in
 * `src/kernel/http` and `src/kernel/identity`; a fresh forge would answer
 * 503 `setup_required` here.
 */
const passThrough: SecurityMiddleware = (_c, next) => next(null);
const tableRouter = createRouter(ROUTES, passThrough);
const callTable = (method: string, path: string, init: RequestInit = {}) =>
	tableRouter(
		new Request(`${ORIGIN}${path}`, { method, ...init }),
		env,
		createExecutionContext(),
	);

const call = (method: string, path: string, init: RequestInit = {}) =>
	worker.fetch(
		new Request(`${ORIGIN}${path}`, { method, ...init }),
		env,
		createExecutionContext(),
	);

/** One concrete request per route id (the ids of src/router.ts). */
const SAMPLES: Readonly<Record<string, readonly [string, string]>> = {
	"health": ["GET", "/-/health"],
	"health.warm": ["POST", "/-/health/warm"],
	"admin.idp.deregister": ["POST", "/-/admin/idp/deregister"],
	"setup.page": ["GET", "/-/setup"],
	"setup.api": ["POST", "/-/setup/unlock"],
	"auth.login": ["GET", "/-/auth/login?return_to=/acme"],
	"auth.callback": ["GET", "/-/auth/callback?code=c&state=s"],
	"auth.logout": ["POST", "/-/auth/logout"],
	"auth.jwks": ["GET", "/-/auth/jwks.json"],
	"avatar": ["GET", "/-/avatar/u_01k0000000000000000000000a"],
	"api.me": ["GET", "/-/api/me"],
	"api.tokens": ["GET", "/-/api/tokens"],
	"api.agents.bulk": ["POST", "/-/api/agents/bulk"],
	"api.agents": ["GET", "/-/api/agents"],
	"api.invites": ["POST", "/-/api/invites"],
	"api.nodes": ["GET", "/-/api/nodes"],
	"api.tree": ["GET", "/-/api/tree"],
	"api.blob": ["GET", "/-/api/blob"],
	"api.log": ["GET", "/-/api/log"],
	"api.commit": ["GET", "/-/api/commit"],
	"api.compare": ["GET", "/-/api/compare"],
	"api.repos.import-complete": [
		"POST",
		`/-/api/repos/${REPO_ID}/import-complete`,
	],
	"api.repos.lanes.settings": ["GET", `/-/api/repos/${REPO_ID}/lanes/settings`],
	"api.repos.config": ["GET", `/-/api/repos/${REPO_ID}/config`],
	"api.repos.projects": ["GET", `/-/api/repos/${REPO_ID}/projects`],
	"api.repos.lanes.config": [
		"GET",
		`/-/api/repos/${REPO_ID}/lanes/${LANE}/config`,
	],
	"api.nodes.config-approvals": [
		"GET",
		"/-/api/nodes/01k0000000000000000000000a/config-approvals",
	],
	"api.installations.repo-overrides": [
		"PUT",
		"/-/api/installations/i_01k0000000000000000000000a/repo-overrides",
	],
	"api.lanes": ["GET", "/-/api/lanes"],
	"api.admin.selftest.lanes": ["POST", "/-/api/admin/selftest/lanes"],
	"api.events": ["GET", "/-/api/events"],
	"api.audit": ["GET", "/-/api/audit"],
	"api.inbox": ["GET", "/-/api/inbox"],
	"api.view": ["GET", "/-/api/view?path=acme&view=changes"],
	"api.slot.action": ["POST", "/-/api/slot/i_x/repo.tab/action"],
	"api.slot.render": ["GET", "/-/api/slot/i_x/repo.tab?ctx=e30"],
	"api.packages": ["GET", "/-/api/packages"],
	"api.installations": ["GET", "/-/api/installations"],
	"api.runs": ["GET", "/-/api/runs"],
	"api.usage": ["GET", "/-/api/usage"],
	"dev.runs": ["POST", "/-/dev/runs"],
	"dev.land": ["POST", "/-/dev/land/01k6aaaaaaaaaaaaaaaaaaaaaa/setup"],
	"dev.cue": ["POST", "/-/dev/cue"],
	"dev.projects": [
		"POST",
		"/-/dev/projects/01k6aaaaaaaaaaaaaaaaaaaaaa/seed",
	],
	"api.advances": ["GET", "/-/api/advances"],
	"api.why": ["GET", "/-/api/why"],
	"api.seed-history": ["POST", "/-/api/seed-history"],
	"api.blame": ["GET", "/-/api/blame"],
	"api.swarm": ["GET", "/-/api/swarm"],
	"live": ["GET", "/-/live?repo=x&since=0"],
	"mcp": ["POST", "/-/mcp/acme/platform"],
	"oauth": ["GET", "/-/oauth/authorize"],
	"well-known": ["GET", "/.well-known/oauth-protected-resource"],
	"agents-md": ["GET", "/-/agents.md"],
	"cap.info-refs": ["GET", `${CAP}/info/refs?service=git-upload-pack`],
	"cap.upload-pack": ["POST", `${CAP}/git-upload-pack`],
	"cap.not-found": ["GET", `${CAP}/git-upload-pack`],
	"git.lane.not-found": [
		"GET",
		`/acme/shop/-/lanes/${LANE.toUpperCase()}.git/info/refs`,
	],
	"git.lane.info-refs": [
		"GET",
		`/acme/shop/-/lanes/${LANE}.git/info/refs?service=git-upload-pack`,
	],
	"git.lane.upload-pack": [
		"POST",
		`/acme/shop/-/lanes/${LANE}.git/git-upload-pack`,
	],
	"git.lane.receive-pack": [
		"POST",
		`/acme/shop/-/lanes/${LANE}.git/git-receive-pack`,
	],
	"git.canonical.info-refs": [
		"GET",
		"/acme/shop.git/info/refs?service=git-receive-pack",
	],
	"git.canonical.upload-pack": ["POST", "/acme/shop.git/git-upload-pack"],
	"git.canonical.receive-pack": ["POST", "/acme/shop.git/git-receive-pack"],
	"raw": ["GET", "/acme/shop/-/raw/main/README.md"],
	"api.log.status": ["GET", "/-/api/log/status"],
	"api.log.dead": ["GET", "/-/api/log/dead"],
	"dev.k2": ["GET", "/-/dev/k2/status"],
};

describe("router table", () => {
	it("has a sample request for every route", () => {
		expect(Object.keys(SAMPLES).sort()).toEqual(ROUTES.map((r) => r.id).sort());
	});

	/** Catch-alls whose M0 stub already answers the specified plain 404. */
	const NOT_FOUND = new Set(["cap.not-found", "git.lane.not-found"]);
	/**
	 * Owners whose routes are all implemented and covered by their own
	 * suites (WP2: src/kernel/identity, src/kernel/http; WP3:
	 * src/kernel/tree, src/kernel/browse; WP7a: src/kernel/exthost/registry,
	 * "WP7a routes through the Worker").
	 */
	const IMPLEMENTED_OWNERS = new Set(["WP0", "WP2", "WP3", "WP7a"]);
	/**
	 * Single implemented routes and what their sample answers through the
	 * route table with `auth: null` (WP6, WP9: the API needs a caller; the
	 * live sample is not an upgrade). `null`: covered by the owner's project
	 * (WP9's warm-up needs a container), so here it only must not be a stub.
	 */
	const IMPLEMENTED: Readonly<Record<string, number | null>> = {
		"api.events": 401,
		"api.audit": 401,
		"api.inbox": 401,
		"live": 426,
		// Runs are listed per repo: the bare sample has no repo id.
		"api.runs": 404,
		"api.usage": 401,
		"health.warm": null,
		// The dev route is invisible without dev tools and the dev key.
		"dev.runs": 404,
		// WP5a: the lanes API needs a caller.
		"api.lanes": 401,
		// WP5b: the lane-repo self-test is the forge Owner's.
		"api.admin.selftest.lanes": 401,
		"api.repos.lanes.settings": 401,
		// WP23: the repository-config API needs a caller.
		"api.repos.config": 401,
		"api.repos.lanes.config": 401,
		"api.nodes.config-approvals": 401,
		"api.installations.repo-overrides": 401,
		// WP4: anonymous receive-pack is challenged before any lookup.
		"git.canonical.info-refs": 401,
		"git.canonical.receive-pack": 401,
		// WP4: anonymous upload-pack resolves the repo first (a public repo
		// serves it); WP3's tree has no repo `acme/shop`, so it is a 401.
		"git.canonical.upload-pack": 401,
		// WP4: lane remotes have no public view; anonymous callers are
		// challenged on every op before any lookup.
		"git.lane.info-refs": 401,
		"git.lane.upload-pack": 401,
		"git.lane.receive-pack": 401,
		// WP4: the capability samples' `exp` (1790000000) has passed: the
		// time check refuses them with the plain 404, before any DO call.
		"cap.info-refs": 404,
		"cap.upload-pack": 404,
		// WP10: the bare samples name no repo (a public read needs no caller).
		"api.advances": 400,
		"api.why": 400,
		// WP10: the seeding route does not exist without dev tools.
		"api.seed-history": 404,
		"dev.land": 404,
		"dev.cue": 404,
		// WP25: the sample repo does not exist (a public read needs no
		// caller); the dev route is invisible without dev tools and the key.
		"api.repos.projects": 404,
		"dev.projects": 404,
		// WP11: MCP needs a token; forge discovery is tartan.json only (OAuth
		// metadata is M2); agents.md serves the forge-level card anonymously.
		"mcp": 401,
		"well-known": 404,
		"agents-md": 200,
		// WP26: the global log is for the forge Owner; the dev route is
		// invisible without dev tools and the dev key.
		"api.log.status": 401,
		"api.log.dead": 401,
		"dev.k2": 404,
		// WP20: the swarm route is invisible without dev tools.
		"api.swarm": 404,
	};
	const stubs = ROUTES.filter((route) =>
		!IMPLEMENTED_OWNERS.has(route.owner) && !NOT_FOUND.has(route.id) &&
		!(route.id in IMPLEMENTED)
	);
	it.each(Object.entries(IMPLEMENTED))(
		"%s is implemented (answers %s to its sample)",
		async (id, status) => {
			const [method, path] = SAMPLES[id];
			const response = await callTable(method, path);
			if (status === null) expect(response.status).not.toBe(501);
			else expect(response.status).toBe(status);
		},
	);
	it.each(stubs.map((route) => [route.id, route.owner] as const))(
		"%s (%s) answers 501 naming its route and owner",
		async (id, owner) => {
			const [method, path] = SAMPLES[id];
			const response = await callTable(method, path);
			expect(response.status).toBe(501);
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(await response.json()).toEqual({
				error: "not_implemented",
				message: `${id} is not implemented`,
				details: { route: id, owner },
			});
		},
	);

	it.each([...NOT_FOUND])(
		"%s answers a plain 404 with no body",
		async (id) => {
			const [method, path] = SAMPLES[id];
			const response = await callTable(method, path);
			expect(response.status).toBe(404);
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(response.headers.get("x-tartan-fake-assets")).toBeNull();
			expect(await response.text()).toBe("");
		},
	);

	it("serves GET /-/setup from the SPA assets", async () => {
		const response = await call("GET", "/-/setup");
		expect(response.status).toBe(200);
		expect(response.headers.get("x-tartan-fake-assets")).toBe("1");
	});

	it("falls through to the SPA for node and forge pages", async () => {
		for (
			const path of [
				"/",
				"/acme/platform",
				"/acme/shop/-/changes/zkqv",
				"/-/explore",
			]
		) {
			const response = await callTable("GET", path);
			expect(response.status, path).toBe(200);
			expect(response.headers.get("x-tartan-fake-assets"), path).toBe("1");
		}
	});

	it("answers 404 JSON for unknown paths under Worker-owned prefixes", async () => {
		for (
			const path of [
				"/-/api/nope",
				"/-/auth/nope",
				"/-/oauth/",
				"/-/mcp/",
				"/.well-known/",
			]
		) {
			const response = await call("GET", path);
			expect(response.status, path).toBe(404);
			expect(response.headers.get("x-tartan-fake-assets"), path).toBeNull();
			expect(await response.json(), path).toMatchObject({ error: "not_found" });
		}
	});

	it("answers 405 with Allow for a known path and the wrong method", async () => {
		const response = await call("DELETE", "/-/health");
		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("GET, HEAD");
		expect(await response.json()).toMatchObject({
			error: "invalid",
			reason: "method",
		});
		const git = await call("GET", "/acme/shop.git/git-receive-pack");
		expect(git.status).toBe(405);
		expect(git.headers.get("allow")).toBe("POST");
	});

	it("is the Worker's default fetch handler", async () => {
		// `ctx.exports` is untyped here (no `Cloudflare.GlobalProps.mainModule`).
		const loopback = exports as unknown as { readonly default: Fetcher };
		const response = await loopback.default.fetch(`${ORIGIN}/-/api/me`);
		// A fresh forge: WP2's middleware gates the API until the claim.
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ error: "setup_required" });
	});

	it("gates a fresh forge through the Worker: pages go to /-/setup", async () => {
		const response = await call("GET", "/acme/platform", {
			headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
		});
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("/-/setup");
	});
});

describe("/-/health", () => {
	it("reports every binding present, product, compat date and stage", async () => {
		const response = await call("GET", "/-/health");
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const { runner, ...body } = await response.json<HealthResponse>();
		// `runner` appears once a warm-up selftest ran (the warm route's sample
		// above runs one without a container); it never carries error text.
		if (runner !== undefined) {
			expect(Object.keys(runner).sort()).toEqual([
				"checkedAt",
				"gitVersion",
				"image",
				"mergeTree",
				"ok",
				"pnpmVersion",
				"users",
			]);
		}
		expect(body).toEqual({
			ok: true,
			product: PRODUCT_NAME,
			version: "0.0.0",
			compatDate: COMPAT_DATE,
			stage: "test",
			// A fresh forge (nothing claimed yet).
			setupState: "fresh",
			bindings: Object.fromEntries(BINDING_NAMES.map((name) => [name, "ok"])),
			// No K2 binding in the pool (the button path): the global log is off.
			k2: "off",
		});
	});

	it("answers HEAD", async () => {
		const response = await call("HEAD", "/-/health");
		expect(response.status).toBe(200);
	});

	it("reports a missing binding and answers 503", async () => {
		const { AI: _ai, ...withoutAi } = env;
		const response = await worker.fetch(
			new Request(`${ORIGIN}/-/health`),
			withoutAi as typeof env,
			createExecutionContext(),
		);
		expect(response.status).toBe(503);
		const body = await response.json<HealthResponse>();
		expect(body.ok).toBe(false);
		expect(body.bindings.AI).toBe("missing");
		expect(body.bindings.ARTIFACTS).toBe("ok");
	});
});

describe("dev-only runs route through the real middleware", () => {
	const devEnv = {
		...env,
		TARTAN_STAGE: "dev-test",
		TARTAN_DEV_TOOLS: "1",
		TARTAN_SECRET: "test-only-dev-secret",
	} as typeof env;
	const devFetch = (path: string, headers: Record<string, string> = {}) =>
		worker.fetch(
			new Request(`${ORIGIN}${path}`, { headers }),
			devEnv,
			createExecutionContext(),
		);

	it("reaches the handler with the dev key on an unclaimed dev stage; 404 without it; the API never takes the key", async () => {
		const key = await devRunsKey("test-only-dev-secret");
		const listed = await devFetch(`/-/dev/runs/${REPO_ID}`, {
			"x-tartan-dev-key": key,
		});
		expect(listed.status).toBe(200);
		expect(await listed.json()).toEqual({ runs: [] });
		expect((await devFetch(`/-/dev/runs/${REPO_ID}`)).status).toBe(404);
		expect(
			(await devFetch(`/-/dev/runs/${REPO_ID}`, {
				"x-tartan-dev-key": "0".repeat(64),
			})).status,
		).toBe(404);
		// The API route is setup-gated and authenticated; the key is no credential there.
		expect(
			(await devFetch(`/-/api/runs/${REPO_ID}`, { "x-tartan-dev-key": key }))
				.status,
		).toBe(503);
		// Without dev tools the route does not exist.
		const prod = await worker.fetch(
			new Request(`${ORIGIN}/-/dev/runs/${REPO_ID}`, {
				headers: { "x-tartan-dev-key": key },
			}),
			{ ...devEnv, TARTAN_DEV_TOOLS: "0" } as typeof env,
			createExecutionContext(),
		);
		expect(prod.status).toBe(404);
	});
});
