// Route table and matcher: pure Deno tests. The
// end-to-end checks through the Worker are in router.workers.test.ts.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { capPath, type HealthResponse, redactSecrets } from "@tartan/contract";
import { ROUTE_AUTH } from "@tartan/contract/kernel.ts";
import type { AuthContext } from "@tartan/contract/kernel.ts";
import { BINDING_NAMES, type Env } from "./env.ts";
import { resetIsolateState, setupInfo } from "./kernel/http/isolate.ts";
import {
	createHealthHandler,
	createRouter,
	FALLTHROUGH,
	HEALTH_CACHE_MS,
	matchRoute,
	type RequestContext,
	type Route,
	type RouteMatch,
	ROUTES,
	type SecurityMiddleware,
	SPA_ASSET_RE,
	WORKER_PREFIXES,
} from "./router.ts";

const OWNERS = new Set([
	"WP0",
	"WP2",
	"WP3",
	"WP4",
	"WP5a",
	"WP5b",
	"WP6",
	"WP7a",
	"WP9",
	"WP10",
	"WP11",
	"WP20",
	"WP23",
	"WP26",
	"WP25",
]);

const LANE = "ln_01k0000000000000000000000a";
const REPO_ID = "01k6aaaaaaaaaaaaaaaaaaaaaa";
/** A syntactically valid capability path (`CAP_PATH_RE`); the MAC is not checked here. */
const NONCE = "0123456789abcdef0123456789abcdef";
const CAP = capPath({
	exp: 1_790_000_000,
	laneId: LANE,
	nonce: NONCE,
	mac: "ab".repeat(32),
	repoId: REPO_ID,
});

const routed = (method: string, path: string) => {
	const match: RouteMatch = matchRoute(method, path);
	if (match.kind !== "route") {
		throw new Error(`${method} ${path}: expected a route, got ${match.kind}`);
	}
	return { id: match.route.id, owner: match.route.owner, params: match.params };
};

Deno.test("route ids are unique, owners known, handlers present", () => {
	const ids = ROUTES.map((r) => r.id);
	equal(new Set(ids).size, ids.length, "duplicate route id");
	for (const route of ROUTES) {
		ok(OWNERS.has(route.owner), `${route.id}: unknown owner ${route.owner}`);
		ok(route.methods.length > 0, `${route.id}: no methods`);
		equal(typeof route.handler, "function", `${route.id}: no handler`);
	}
});

// One request per route prefix the router serves, plus the concrete routes of
// setup, sign-in, git, the capability route, views, imports, MCP, OAuth,
// discovery, deploy and health.
const TABLE: readonly [string, string, string, string][] = [
	["GET", "/-/health", "health", "WP0"],
	["HEAD", "/-/health", "health", "WP0"],
	["POST", "/-/health/warm", "health.warm", "WP9"],
	["POST", "/-/admin/idp/deregister", "admin.idp.deregister", "WP2"],
	["GET", "/-/setup", "setup.page", "WP0"],
	["POST", "/-/setup/unlock", "setup.api", "WP2"],
	["POST", "/-/setup/recover", "setup.api", "WP2"],
	["GET", "/-/auth/login", "auth.login", "WP2"],
	["GET", "/-/auth/callback", "auth.callback", "WP2"],
	["POST", "/-/auth/logout", "auth.logout", "WP2"],
	["GET", "/-/auth/jwks.json", "auth.jwks", "WP2"],
	["GET", "/-/avatar/u_01k0000000000000000000000a", "avatar", "WP2"],
	["GET", "/-/api/me", "api.me", "WP2"],
	["POST", "/-/api/tokens", "api.tokens", "WP2"],
	["POST", "/-/api/agents/bulk", "api.agents.bulk", "WP2"],
	["POST", "/-/api/agents", "api.agents", "WP2"],
	["DELETE", "/-/api/agents/a_01k0000000000000000000000a", "api.agents", "WP2"],
	["POST", "/-/api/invites", "api.invites", "WP2"],
	["GET", "/-/api/nodes", "api.nodes", "WP3"],
	["POST", "/-/api/nodes/01k0000000000000000000000a/repos", "api.nodes", "WP3"],
	["GET", "/-/api/tree", "api.tree", "WP3"],
	["GET", "/-/api/blob", "api.blob", "WP3"],
	["GET", "/-/api/log", "api.log", "WP3"],
	["GET", "/-/api/commit", "api.commit", "WP3"],
	["GET", "/-/api/compare", "api.compare", "WP3"],
	["GET", "/acme/shop/-/raw/main/README.md", "raw", "WP3"],
	["GET", "/acme/shop.git/info/refs", "git.canonical.info-refs", "WP4"],
	[
		"POST",
		"/acme/shop.git/git-upload-pack",
		"git.canonical.upload-pack",
		"WP4",
	],
	[
		"POST",
		"/acme/shop.git/git-receive-pack",
		"git.canonical.receive-pack",
		"WP4",
	],
	[
		"GET",
		`/acme/shop/-/lanes/${LANE}.git/info/refs`,
		"git.lane.info-refs",
		"WP4",
	],
	[
		"POST",
		`/acme/shop/-/lanes/${LANE}.git/git-upload-pack`,
		"git.lane.upload-pack",
		"WP4",
	],
	[
		"POST",
		`/acme/shop/-/lanes/${LANE}.git/git-receive-pack`,
		"git.lane.receive-pack",
		"WP4",
	],
	["GET", `${CAP}/info/refs`, "cap.info-refs", "WP4"],
	["POST", `${CAP}/git-upload-pack`, "cap.upload-pack", "WP4"],
	["GET", "/-/cap/nope", "cap.not-found", "WP4"],
	[
		"GET",
		`/acme/shop/-/lanes/${LANE.toUpperCase()}.git/info/refs`,
		"git.lane.not-found",
		"WP4",
	],
	[
		"POST",
		`/-/api/repos/${REPO_ID}/import-complete`,
		"api.repos.import-complete",
		"WP3",
	],
	[
		"GET",
		`/-/api/repos/${REPO_ID}/lanes/settings`,
		"api.repos.lanes.settings",
		"WP5a",
	],
	[
		"PUT",
		`/-/api/repos/${REPO_ID}/lanes/settings`,
		"api.repos.lanes.settings",
		"WP5a",
	],
	[
		"GET",
		`/-/api/repos/${REPO_ID}/projects`,
		"api.repos.projects",
		"WP25",
	],
	[
		"GET",
		`/-/api/repos/${REPO_ID}/projects/rawkode-academy-website/issues`,
		"api.repos.projects",
		"WP25",
	],
	[
		"GET",
		`/-/api/repos/${REPO_ID}/config`,
		"api.repos.config",
		"WP23",
	],
	[
		"POST",
		`/-/api/repos/${REPO_ID}/config/preview`,
		"api.repos.config",
		"WP23",
	],
	[
		"GET",
		`/-/api/repos/${REPO_ID}/config/evals/${"a".repeat(64)}`,
		"api.repos.config",
		"WP23",
	],
	[
		"GET",
		`/-/api/repos/${REPO_ID}/lanes/${LANE}/config`,
		"api.repos.lanes.config",
		"WP23",
	],
	[
		"POST",
		`/-/api/repos/${REPO_ID}/lanes/${LANE}/policy-signoff`,
		"api.repos.lanes.config",
		"WP23",
	],
	[
		"PUT",
		"/-/api/nodes/01k0000000000000000000000a/config-approvals/acme.no-secrets",
		"api.nodes.config-approvals",
		"WP23",
	],
	[
		"PUT",
		"/-/api/installations/i_01k0000000000000000000000a/repo-overrides",
		"api.installations.repo-overrides",
		"WP23",
	],
	["GET", "/-/api/lanes", "api.lanes", "WP5a"],
	["POST", `/-/api/lanes/${LANE}/close`, "api.lanes", "WP5a"],
	["POST", "/-/api/admin/selftest/lanes", "api.admin.selftest.lanes", "WP5b"],
	["GET", "/-/live", "live", "WP6"],
	["GET", "/-/api/events", "api.events", "WP6"],
	["GET", "/-/api/audit", "api.audit", "WP6"],
	["GET", "/-/api/inbox", "api.inbox", "WP6"],
	["POST", "/-/api/inbox/ack", "api.inbox", "WP6"],
	["GET", "/-/api/view", "api.view", "WP7a"],
	["GET", "/-/api/slot/i_x/repo.tab", "api.slot.render", "WP7a"],
	["POST", "/-/api/slot/i_x/repo.tab/action", "api.slot.action", "WP7a"],
	["PUT", "/-/api/packages", "api.packages", "WP7a"],
	["POST", "/-/api/installations", "api.installations", "WP7a"],
	["GET", "/-/api/runs/r_x/jobs/test/log", "api.runs", "WP9"],
	["GET", "/-/api/usage", "api.usage", "WP9"],
	["POST", "/-/dev/runs/r_x", "dev.runs", "WP9"],
	["POST", "/-/dev/land/r_x/setup", "dev.land", "WP10"],
	["POST", "/-/dev/cue", "dev.cue", "WP9"],
	["POST", "/-/dev/projects/r_x/seed", "dev.projects", "WP25"],
	["GET", "/-/api/advances", "api.advances", "WP10"],
	["GET", "/-/api/why", "api.why", "WP10"],
	["POST", "/-/api/seed-history", "api.seed-history", "WP10"],
	["GET", "/-/api/blame", "api.blame", "WP10"],
	["POST", "/-/mcp", "mcp", "WP11"],
	["POST", "/-/mcp/acme/platform", "mcp", "WP11"],
	["GET", "/-/oauth/authorize", "oauth", "WP11"],
	["GET", "/.well-known/oauth-authorization-server", "well-known", "WP11"],
	["GET", "/-/agents.md", "agents-md", "WP11"],
	["POST", "/-/api/swarm", "api.swarm", "WP20"],
	["GET", "/-/api/log/status", "api.log.status", "WP26"],
	["GET", "/-/api/log/dead", "api.log.dead", "WP26"],
	[
		"POST",
		"/-/api/log/dead/01k6aaaaaaaaaaaaaaaaaaaaaa/retry",
		"api.log.dead",
		"WP26",
	],
	["POST", "/-/dev/k2/conformance", "dev.k2", "WP26"],
];

Deno.test("every documented route resolves to its owner", () => {
	for (const [method, path, id, owner] of TABLE) {
		const got = routed(method, path);
		equal(got.id, id, `${method} ${path}`);
		equal(got.owner, owner, `${method} ${path}`);
	}
});

Deno.test("every route in the table is exercised by the request table", () => {
	const exercised = new Set(TABLE.map(([, , id]) => id));
	for (const route of ROUTES) {
		ok(exercised.has(route.id), `${route.id} has no request in TABLE`);
	}
});

Deno.test("git paths capture the repo path and lane, with or without .git", () => {
	deepStrictEqual(
		routed("POST", "/acme/platform/edge/router.git/git-receive-pack").params,
		{ repo: "acme/platform/edge/router" },
	);
	deepStrictEqual(routed("GET", "/acme/shop/info/refs").params, {
		repo: "acme/shop",
	});
	deepStrictEqual(
		routed("POST", `/acme/shop/-/lanes/${LANE}.git/git-upload-pack`).params,
		{ repo: "acme/shop", lane: LANE },
	);
	deepStrictEqual(
		routed("POST", `/-/api/repos/${REPO_ID}/import-complete`).params,
		{ repoId: REPO_ID },
	);
	deepStrictEqual(routed("GET", "/acme/shop/-/raw/main/docs/a.md").params, {
		repo: "acme/shop",
		rest: "main/docs/a.md",
	});
	deepStrictEqual(routed("POST", "/-/mcp/acme/platform").params, {
		rest: "acme/platform",
	});
	deepStrictEqual(routed("POST", "/-/mcp").params, {});
	deepStrictEqual(routed("POST", "/-/api/slot/i_x/repo.tab/action").params, {
		installation: "i_x",
		slot: "repo.tab",
	});
});

// GET paths the SPA owns (web/src/router/routes.ts): with run_worker_first
// they must reach ASSETS, so no route may claim them and none may sit under a
// Worker-owned prefix (those answer 404 JSON instead of the SPA shell).
const SPA_PATHS = [
	"/",
	"/acme",
	"/acme/shop",
	"/acme/shop/-/changes/zkqv",
	"/acme/shop/-/tree/main/src",
	"/acme/shop/-/runs/r_1/jobs/j_1",
	"/acme/shop/-/settings",
	"/acme/shop/-/blob/main/README.md",
	"/acme/shop/-/lanes",
	"/acme/shop/-/lanes/l_1",
	"/acme/shop/-/advances/a_1",

	"/acme/shop/-/radar",
	"/-/explore",
	"/-/agents",
	"/-/extensions",
	"/-/extensions/i_x",
	"/-/extensions/i_x/compare",
	"/-/settings",
	"/-/login",
	"/-/invite/abc",
	"/-/leaving",
	"/-/ui",
	"/-/hud",
	"/assets/index-abc123.js",
	"/favicon.svg",
];

Deno.test("forge pages and node pages are not git or API routes", () => {
	for (const path of SPA_PATHS) {
		equal(matchRoute("GET", path).kind, "none", path);
		ok(
			!WORKER_PREFIXES.some((prefix) => path.startsWith(prefix)),
			`${path} is under a Worker-owned prefix`,
		);
	}
	// The setup wizard is an explicit SPA route (GET /-/setup[/*]).
	equal(routed("GET", "/-/setup").id, "setup.page");
	// Lane remotes live under a repo path, never at the forge root.
	equal(matchRoute("GET", `/-/lanes/${LANE}.git/info/refs`).kind, "none");
});

Deno.test("lane remotes accept exactly a lowercase ln_<ulid>; other git-shaped lane paths reach WP4's 404", () => {
	for (
		const lane of [
			"ln_x",
			LANE.toUpperCase(),
			`LN_${LANE.slice(3)}`,
			LANE.slice(0, -1),
			`${LANE}a`,
			`l-${REPO_ID}`,
			LANE.replace("0a", "0u"),
		]
	) {
		for (const op of ["info/refs", "git-upload-pack", "git-receive-pack"]) {
			for (const method of ["GET", "POST", "PUT", "DELETE", "OPTIONS"]) {
				equal(
					routed(method, `/acme/shop/-/lanes/${lane}.git/${op}`).id,
					"git.lane.not-found",
					`${method} ${lane} ${op}`,
				);
			}
		}
	}
	// A valid lane id with another op or method is WP4's 404 too, never the
	// SPA or a 405.
	for (
		const [method, path] of [
			["GET", `/acme/shop/-/lanes/${LANE}.git/HEAD`],
			["GET", `/acme/shop/-/lanes/${LANE}.git/objects/info/packs`],
			["GET", `/acme/shop/-/lanes/${LANE}.git/git-receive-pack`],
		]
	) {
		equal(routed(method, path).id, "git.lane.not-found", `${method} ${path}`);
	}
	// SPA lane pages are not git-shaped and still fall through.
	for (const path of ["/acme/shop/-/lanes", `/acme/shop/-/lanes/${LANE}`]) {
		equal(matchRoute("GET", path).kind, "none", path);
	}
});

Deno.test("the capability route matches only the contract's CAP_PATH_RE shape", () => {
	deepStrictEqual(routed("GET", `${CAP}/info/refs`).params, {});
	equal(routed("HEAD", `${CAP}/info/refs`).id, "cap.info-refs");
	// Each op is its own route; any other method reaches WP4's uniform 404
	// (never a 405 with an `Allow` oracle).
	for (
		const [method, op] of [
			["GET", "git-upload-pack"],
			["POST", "info/refs"],
			["PUT", "info/refs"],
			["OPTIONS", "git-upload-pack"],
		]
	) {
		equal(
			routed(method, `${CAP}/${op}`).id,
			"cap.not-found",
			`${method} ${op}`,
		);
	}
	const at = (segment: number, value: string): string => {
		const parts = CAP.split("/");
		parts[segment] = value;
		return parts.join("/");
	};
	// ["", "-", "cap", "v1", exp, laneId, nonce, mac, "<repoId>.git"]
	for (
		const bad of [
			`${CAP}/git-receive-pack`,
			`${CAP}/HEAD`,
			`${CAP}/info/refs/`,
			`${CAP.replace("/-/cap/v1/", "/-/cap/v2/")}/info/refs`,
			`${CAP.replace("/-/cap/v1/", "/-/cap/")}/info/refs`,
			`${at(4, "179000000")}/info/refs`,
			`${at(5, LANE.toUpperCase())}/info/refs`,
			`${at(5, "ln_x")}/info/refs`,
			`${at(6, "0123456789ABCDEF0123456789ABCDEF")}/info/refs`,
			`${at(7, "ab".repeat(31))}/info/refs`,
			`${at(8, `${REPO_ID}`)}/info/refs`,
			`${at(8, `r-${REPO_ID}.git`)}/info/refs`,
		]
	) {
		// Every malformed path still reaches WP4 (syntax failures tick the failure
		// buckets), never the router's own 404.
		equal(routed("GET", bad).id, "cap.not-found", bad);
		equal(routed("POST", bad).id, "cap.not-found", bad);
	}
});

Deno.test("every other capability path is WP4's plain 404, with no body to leak the path", async () => {
	ok(WORKER_PREFIXES.includes("/-/cap/"));
	const router = createRouter(ROUTES, (_c, next) => next(null));
	for (
		const [method, path] of [
			["POST", `${CAP}/git-receive-pack`],
			["GET", `${CAP}/git-upload-pack`],
			["GET", "/-/cap/nope"],
			["GET", `${CAP.replace("/-/cap/v1/", "/-/cap/v2/")}/info/refs`],
		]
	) {
		const response = await router(
			new Request(`https://forge.test${path}`, { method }),
			fakeEnv,
			fakeCtx,
		);
		equal(response.status, 404, `${method} ${path}`);
		equal(await response.text(), "", `${method} ${path}`);
	}
	// The router's own 404 (other Worker prefixes) still redacts.
	const redacted = redactSecrets(`no route for ${CAP}/x`);
	ok(redacted.startsWith("no route for /-/cap/<redacted>/"), redacted);
	ok(!redacted.includes("ab".repeat(32)) && !redacted.includes(NONCE));
});

Deno.test("a path served only for other methods is a method mismatch", () => {
	deepStrictEqual(matchRoute("POST", "/-/health"), {
		kind: "method",
		allow: ["GET", "HEAD"],
	});
	deepStrictEqual(matchRoute("GET", "/acme/shop.git/git-receive-pack"), {
		kind: "method",
		allow: ["POST"],
	});
	// GET /-/setup/* is the SPA; unsafe methods are the setup API.
	equal(routed("GET", "/-/setup/idp").id, "setup.page");
	equal(routed("DELETE", "/-/setup/idp").id, "setup.api");
});

// ---------------------------------------------------------------------------
// Security seam
// ---------------------------------------------------------------------------

Deno.test("every route declares a well-formed security policy", () => {
	for (const route of ROUTES) {
		const p = route.policy;
		ok(ROUTE_AUTH.includes(p.auth), `${route.id}: auth ${p.auth}`);
		ok(["redirect", "forbid", "any"].includes(p.host), `${route.id}: host`);
		if (p.auth === "none") ok(p.anonymous, `${route.id}: none ⇒ anonymous`);
	}
});

Deno.test("cookies are never accepted on git or MCP; both forbid other hosts", () => {
	const tokenOnly = ROUTES.filter((r) =>
		r.id.startsWith("git.") || r.id === "mcp"
	);
	equal(tokenOnly.length, 8); // 3 lane, 1 lane not-found, 3 canonical, mcp
	for (const route of tokenOnly) {
		equal(route.policy.auth, "token", route.id);
		equal(route.policy.host, "forbid", route.id);
		equal(route.policy.setupExempt, false, route.id);
	}
	equal(routed("POST", "/-/mcp").id, "mcp");
	equal(ROUTES.find((r) => r.id === "mcp")?.policy.tokenScope, "mcp");
	equal(ROUTES.find((r) => r.id === "mcp")?.policy.anonymous, false);
});

Deno.test("only health, deploy-script endpoints, the wizard, its API and the OIDC flow skip setup gating", () => {
	deepStrictEqual(
		ROUTES.filter((r) => r.policy.setupExempt).map((r) => r.id).sort(),
		[
			"admin.idp.deregister",
			"auth.callback",
			"auth.jwks",
			"auth.login",
			"dev.cue",
			"dev.k2",
			"dev.land",
			"dev.projects",
			"dev.runs",
			"health",
			"health.warm",
			"setup.api",
			"setup.page",
		],
	);
	for (
		const id of [
			"health",
			"health.warm",
			"admin.idp.deregister",
			"dev.runs",
			"dev.land",
			"dev.cue",
			"dev.k2",
			"dev.projects",
		]
	) {
		const policy = ROUTES.find((r) => r.id === id)?.policy;
		equal(policy?.host, "any", id);
		equal(policy?.auth, "none", id);
	}
	equal(FALLTHROUGH.asset.policy.setupExempt, true);
	equal(FALLTHROUGH.page.policy.setupExempt, false);
	ok(
		SPA_ASSET_RE.test("/assets/index-abc.js") &&
			SPA_ASSET_RE.test("/favicon.svg"),
	);
	equal(SPA_ASSET_RE.test("/acme/shop"), false);
});

Deno.test("the capability route takes no credential, only on the canonical host", () => {
	const cap = ROUTES.filter((r) => r.id.startsWith("cap."));
	deepStrictEqual(cap.map((r) => r.id), [
		"cap.info-refs",
		"cap.upload-pack",
		"cap.not-found",
	]);
	for (const route of cap) {
		deepStrictEqual(route.policy, {
			auth: "none",
			anonymous: true,
			csrf: false,
			setupExempt: false,
			host: "forbid",
		});
		equal(route.owner, "WP4");
	}
});

Deno.test("cookie-authenticated unsafe routes require same-origin", () => {
	const unsafe = (r: Route) =>
		r.methods.some((m) => ["POST", "PUT", "PATCH", "DELETE"].includes(m));
	for (const route of ROUTES) {
		if (route.policy.auth === "token" || route.policy.auth === "none") continue;
		if (!unsafe(route)) continue;
		// OAuth: clients call /-/oauth/token without cookies; WP11 checks the
		// consent POST itself with requireSameOrigin.
		if (route.id === "oauth") continue;
		ok(route.policy.csrf, `${route.id} accepts cookies on unsafe methods`);
	}
	ok(ROUTES.find((r) => r.id === "setup.api")?.policy.csrf);
	ok(ROUTES.find((r) => r.id === "live")?.policy.csrf, "WebSocket Origin");
	for (const route of ROUTES.filter((r) => r.id.startsWith("api."))) {
		equal(route.policy.tokenScope, "api", route.id);
	}
});

const fakeEnv = {
	ASSETS: {
		fetch: (req: Request) =>
			Promise.resolve(new Response(`spa ${new URL(req.url).pathname}`)),
	},
} as unknown as Env;
const fakeCtx = {} as ExecutionContext;

Deno.test("every request passes the security middleware, which sets auth", async () => {
	const seen: string[] = [];
	const auth = { principal: "u_x" } as AuthContext;
	const security: SecurityMiddleware = (c: RequestContext, next) => {
		seen.push(`${c.route.id}:${c.route.policy.auth}`);
		return next(c.route.id === "probe" ? auth : null);
	};
	const probe: Route = {
		id: "probe",
		owner: "WP0",
		methods: ["GET"],
		pattern: /^\/-\/api\/probe$/,
		policy: ROUTES[0].policy,
		handler: (c) => Response.json({ principal: c.auth?.principal ?? null }),
	};
	const router = createRouter([probe], security);
	const call = (method: string, path: string) =>
		router(
			new Request(`https://forge.test${path}`, { method }),
			fakeEnv,
			fakeCtx,
		);
	deepStrictEqual(await (await call("GET", "/-/api/probe")).json(), {
		principal: "u_x",
	});
	equal((await call("POST", "/-/api/probe")).status, 405);
	equal((await call("GET", "/-/api/nope")).status, 404);
	equal(await (await call("GET", "/assets/a.js")).text(), "spa /assets/a.js");
	equal(await (await call("GET", "/acme/shop")).text(), "spa /acme/shop");
	deepStrictEqual(seen, [
		"probe:none",
		"unrouted.405:none",
		"unrouted.404:none",
		"spa.asset:none",
		"spa.page:cookie",
	]);
});

Deno.test("the middleware can answer itself, and its errors become JSON", async () => {
	const deny: SecurityMiddleware = () =>
		Promise.resolve(new Response("setup", { status: 503 }));
	equal(
		(await createRouter(ROUTES, deny)(
			new Request("https://forge.test/-/api/me"),
			fakeEnv,
			fakeCtx,
		)).status,
		503,
	);
	const fail: SecurityMiddleware = () => {
		throw Object.assign(new Error("denied(csrf): cross-site"), {});
	};
	const res = await createRouter(ROUTES, fail)(
		new Request("https://forge.test/-/api/tokens", { method: "POST" }),
		fakeEnv,
		fakeCtx,
	);
	equal(res.status, 403);
	deepStrictEqual(await res.json(), {
		error: "denied",
		reason: "csrf",
		message: "cross-site",
	});
});

// ---------------------------------------------------------------------------
// /-/health (WP0): cheap once set up, bounded, never a guessed `fresh`
// ---------------------------------------------------------------------------

type HealthFake = {
	env: Env;
	reads: { setup: number; runner: number };
	setState: (state: "fresh" | "done" | "stall") => void;
};

const healthEnv = (): HealthFake => {
	const reads = { setup: 0, runner: 0 };
	let state: "fresh" | "done" | "stall" = "done";
	const env = Object.fromEntries(
		BINDING_NAMES.map((name) => [name, {}]),
	) as Record<string, unknown>;
	env["FORGE"] = {
		getByName: () => ({
			identity: () => ({
				setupState: () => {
					reads.setup++;
					return state === "stall"
						? new Promise(() => {})
						: Promise.resolve({ state, rootKeyFallback: false });
				},
			}),
		}),
	};
	env["SANDBOX"] = {
		getByName: () => ({
			runnerInfo: () => {
				reads.runner++;
				return Promise.resolve(null);
			},
		}),
	};
	env["TARTAN_STAGE"] = "test";
	return {
		env: env as unknown as Env,
		reads,
		setState: (next) => {
			state = next;
		},
	};
};

const healthOf = async (
	handler: ReturnType<typeof createHealthHandler>,
	env: Env,
): Promise<HealthResponse> => {
	const url = new URL("https://forge.test/-/health");
	const res = await handler({
		req: new Request(url),
		env,
		ctx: fakeCtx,
		url,
		params: {},
		route: FALLTHROUGH.page,
		auth: null,
	});
	equal(res.status, 200);
	return await res.json() as HealthResponse;
};

Deno.test("health: a set-up forge answers from the isolate for 5 s, with no DO read", async () => {
	let t = 1_000_000;
	const handler = createHealthHandler({ now: () => t });
	const f = healthEnv();
	equal((await healthOf(handler, f.env)).setupState, "done");
	deepStrictEqual(f.reads, { setup: 1, runner: 1 });
	t += HEALTH_CACHE_MS - 1;
	equal((await healthOf(handler, f.env)).setupState, "done");
	deepStrictEqual(f.reads, { setup: 1, runner: 1 });
	t += 1;
	await healthOf(handler, f.env);
	deepStrictEqual(f.reads, { setup: 2, runner: 2 });
});

Deno.test("health: during setup every answer is read afresh (a wizard step never sees a stale state)", async () => {
	const handler = createHealthHandler({ now: () => 5 });
	const f = healthEnv();
	f.setState("fresh");
	equal((await healthOf(handler, f.env)).setupState, "fresh");
	equal((await healthOf(handler, f.env)).setupState, "fresh");
	f.setState("done");
	equal((await healthOf(handler, f.env)).setupState, "done");
	equal(f.reads.setup, 3);
});

Deno.test("health: a stalled ForgeDO answers within the bound with the isolate's last answer, never a guessed fresh", async () => {
	resetIsolateState();
	const f = healthEnv();
	// The middleware heard `done` from ForgeDO earlier in this isolate.
	await setupInfo(f.env);
	f.setState("stall");
	const handler = createHealthHandler({ readTimeoutMs: 20 });
	const started = Date.now();
	equal((await healthOf(handler, f.env)).setupState, "done");
	ok(Date.now() - started < 1000);
	// Nothing heard yet: `fresh`, as before.
	resetIsolateState();
	equal(
		(await healthOf(createHealthHandler({ readTimeoutMs: 20 }), f.env))
			.setupState,
		"fresh",
	);
	resetIsolateState();
});
