// The Worker's single front door. Stateless: every
// route points at a handler exported by its owning module.
// Routes are tried in table order; the first whose pattern matches the path
// and whose methods include the request method wins (HEAD is served by GET
// routes). A path that matches only with other methods gets 405 with
// `Allow`. Unmatched paths under a Worker-owned prefix get a 404 JSON error;
// everything else goes to the SPA assets.
//
// Security seam: every route declares a `RoutePolicy` (which
// credentials, anonymous or not, CSRF, setup exemption, host rule, channel
// scope), and every request — routes, 404/405 answers and the SPA
// fall-through — runs through WP2's `withSecurity` middleware
// (`src/kernel/http/middleware.ts`): setup gating (302 / 503
// `setup_required`), canonical-host 308/403, authentication, CSRF and
// security headers. It puts `auth` on the RouteContext; handlers call WP3's
// `authorize` for node permissions. In M0 the middleware is the identity
// (`auth` is always null).

import {
	CAP_PATH_RE,
	type CapPathOp,
	COMPAT_DATE,
	FORGE_DO_NAME,
	type HealthResponse,
	type HealthRunner,
	httpStatus,
	notFound,
	PRODUCT_NAME,
	redactSecrets,
	type SetupStateDto,
	tartanError,
	toWire,
	ULID_RE,
} from "@tartan/contract";
import type { AuthContext, RoutePolicy } from "@tartan/contract/kernel.ts";
import { TARTAN_VERSION } from "./constants.ts";
import { BINDING_NAMES, type Env } from "./env.ts";
import {
	handleBlob,
	handleCommit,
	handleCompare,
	handleImportComplete,
	handleLog,
	handleNodes,
	handleRaw,
	handleTree,
} from "./kernel/browse/routes.ts";
import { handleDevK2 } from "./kernel/bus/dev.ts";
import { handleGlobalLog, healthK2 } from "./kernel/bus/routes.ts";
import {
	handleAudit,
	handleEvents,
	handleLive,
} from "./kernel/events/routes.ts";
import {
	handleInstallations,
	handlePackages,
	handleSlotAction,
	handleSlotRender,
	handleView,
} from "./kernel/exthost/api/routes.ts";
import {
	handleCapInfoRefs,
	handleCapNotFound,
	handleCapUploadPack,
	handleInfoRefs,
	handleLaneNotFound,
	handleReceivePack,
	handleUploadPack,
} from "./kernel/gateway/routes.ts";
import {
	handleAgents,
	handleAgentsBulk,
	handleAvatar,
	handleCallback,
	handleIdpDeregister,
	handleInvites,
	handleJwks,
	handleLogin,
	handleLogout,
	handleMe,
	handleSetupApi,
	handleTokens,
} from "./kernel/identity/routes.ts";
import { lastSetupInfo } from "./kernel/http/isolate.ts";
import { withSecurity } from "./kernel/http/middleware.ts";
import { handleInbox } from "./kernel/inbox/routes.ts";
import { handleDevLand } from "./kernel/land/dev.ts";
import { handleDevCue } from "./kernel/runs/cueprobe.ts";
import {
	handleAdvances,
	handleBlame,
	handleSeedHistory,
	handleWhy,
} from "./kernel/land/routes.ts";
import {
	handleAgentsMd,
	handleMcp,
	handleOAuth,
	handleWellKnown,
} from "./kernel/mcp/routes.ts";
import { handleDevProjects } from "./kernel/projects/dev.ts";
import { handleProjects } from "./kernel/projects/routes.ts";
import { handleLaneSelfTest } from "./kernel/repo/lanes/repo-backend/index.ts";
import { handleLanes, handleLaneSettings } from "./kernel/repo/routes.ts";
import {
	handleConfigApprovals,
	handleRepoConfig,
	handleRepoConfigLane,
	handleRepoOverrides,
} from "./kernel/repoconfig/routes.ts";
import {
	handleDevRuns,
	handleHealthWarm,
	handleRuns,
	handleUsage,
} from "./kernel/runs/routes.ts";
import { handleSwarm } from "./kernel/swarm/routes.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RouteOwner =
	| "WP0"
	| "WP2"
	| "WP3"
	| "WP4"
	| "WP5a"
	| "WP5b"
	| "WP6"
	| "WP7a"
	| "WP9"
	| "WP10"
	| "WP11"
	| "WP20"
	| "WP23"
	| "WP25"
	| "WP26";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

export type RouteInfo = {
	readonly id: string;
	readonly owner: RouteOwner;
	readonly policy: RoutePolicy;
};

/** What the security middleware sees: everything but the authenticated caller. */
export type RequestContext = {
	readonly req: Request;
	readonly env: Env;
	readonly ctx: ExecutionContext;
	readonly url: URL;
	/** Named groups of the route pattern (e.g. `repo`, `lane`, `rest`). */
	readonly params: Readonly<Record<string, string>>;
	readonly route: RouteInfo;
};

export type RouteContext = RequestContext & {
	/**
	 * The caller as authenticated by WP2's middleware under `route.policy`
	 * (null = anonymous). Node permissions are WP3's `authorize(auth, …)`.
	 */
	readonly auth: AuthContext | null;
};

export type RouteHandler = (c: RouteContext) => Response | Promise<Response>;

/**
 * WP2's seam (`src/kernel/http/middleware.ts`): runs for every request with
 * its route's policy; calls `next(auth)` to run the handler (or answers
 * itself: 302/308/401/403/503) and may decorate the response (headers).
 */
export type SecurityMiddleware = (
	c: RequestContext,
	next: (auth: AuthContext | null) => Promise<Response>,
) => Promise<Response>;

export type Route = {
	/** Stable id (`<area>.<name>`), used in logs, stub errors and tests. */
	readonly id: string;
	readonly owner: RouteOwner;
	readonly methods: readonly Method[];
	/** Matched against the raw `URL.pathname`. */
	readonly pattern: RegExp;
	readonly policy: RoutePolicy;
	readonly handler: RouteHandler;
};

// ---------------------------------------------------------------------------
// Path grammar
// ---------------------------------------------------------------------------

/**
 * A node path: one or more segments, none starting with `-` (slugs are
 * `[a-z0-9][a-z0-9-]*`), so the first `/-/` always ends the node path. The
 * pattern is looser than the slug grammar; handlers resolve and 404.
 * Segments are lazy so a trailing `.git` stays outside the capture.
 */
const NODE_PATH = String.raw`(?<repo>[^/-][^/]*?(?:/[^/-][^/]*?)*?)`;
/** A lane id in a lane-remote URL: exactly a lowercase `ln_<ulid>`. */
const LANE_ID = `ln_${ULID_RE.source.replace(/^\^|\$$/g, "")}`;
const GIT_OPS = {
	"info-refs": { op: "info/refs", method: "GET", handler: handleInfoRefs },
	"upload-pack": {
		op: "git-upload-pack",
		method: "POST",
		handler: handleUploadPack,
	},
	"receive-pack": {
		op: "git-receive-pack",
		method: "POST",
		handler: handleReceivePack,
	},
} as const;

const escapeRegExp = (text: string): string =>
	text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Exactly `path`. */
const exact = (path: string): RegExp => new RegExp(`^${escapeRegExp(path)}$`);

/** `<base>` or `<base>/<rest>`. */
const withRest = (base: string): RegExp =>
	new RegExp(`^${escapeRegExp(base)}(?:/(?<rest>.+))?$`);

/**
 * One op of the capability route: the path must match the contract's
 * `CAP_PATH_RE` (both ops) and end in `op`, so each op is its own route.
 */
const capRoutePattern = (op: CapPathOp): RegExp =>
	new RegExp(
		`(?=${CAP_PATH_RE.source}).*/${escapeRegExp(op)}$`,
		CAP_PATH_RE.flags.replace(/[gy]/g, ""),
	);

const READ: readonly Method[] = ["GET"];
const WRITE: readonly Method[] = ["POST", "PUT", "PATCH", "DELETE"];
const CRUD: readonly Method[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
/** Catch-alls answer every method themselves (no 405 `Allow` oracle). */
const ANY: readonly Method[] = [...CRUD, "OPTIONS"];

// ---------------------------------------------------------------------------
// Route policies. Cookies are never accepted on git or MCP; bearer requests are
// CSRF-immune.
// ---------------------------------------------------------------------------

export const POLICY = {
	/** `/-/health`: any host, any setup state, never authenticated. */
	health: {
		auth: "none",
		anonymous: true,
		csrf: false,
		setupExempt: true,
		host: "any",
	},
	/**
	 * Deploy-script endpoints (`POST /-/health/warm`, `POST
	 * /-/admin/idp/deregister`): any host and any setup state (a deploy warms
	 * the containers before the claim; destroy may run on an unclaimed stage),
	 * no session or token. The handler authorizes: ForgeDO's rate limit on
	 * warm-up, the one-time `TARTAN_DESTROY_TOKEN` (404 without it).
	 */
	deployScript: {
		auth: "none",
		anonymous: true,
		csrf: false,
		setupExempt: true,
		host: "any",
	},
	/** The setup wizard page and static assets (the wizard needs them). */
	setupPage: {
		auth: "none",
		anonymous: true,
		csrf: false,
		setupExempt: true,
		host: "redirect",
	},
	/** `/-/setup/*` API: WP2's handler checks the setup session; same-origin JSON. */
	setupApi: {
		auth: "none",
		anonymous: true,
		csrf: true,
		setupExempt: true,
		host: "redirect",
	},
	/** OIDC login, callback, JWKS: reachable during setup (the claim logs in). */
	authFlow: {
		auth: "none",
		anonymous: true,
		csrf: false,
		setupExempt: true,
		host: "redirect",
	},
	/** Browser-only, cookie, same-origin (logout, the avatar proxy, SPA pages). */
	browser: {
		auth: "cookie",
		anonymous: true,
		csrf: true,
		setupExempt: false,
		host: "redirect",
	},
	/** Kernel API for signed-in callers (session or a token with `api`). */
	api: {
		auth: "any",
		anonymous: false,
		csrf: true,
		setupExempt: false,
		host: "redirect",
		tokenScope: "api",
	},
	/** Kernel API that public repos serve anonymously; the handler authorizes. */
	apiPublic: {
		auth: "any",
		anonymous: true,
		csrf: true,
		setupExempt: false,
		host: "redirect",
		tokenScope: "api",
	},
	/** `/-/live`: cookie plus an exact Origin on the upgrade. */
	live: {
		auth: "cookie",
		anonymous: true,
		csrf: true,
		setupExempt: false,
		host: "redirect",
	},
	/** `/-/mcp`: tokens only, the `mcp` scope; WP11 checks any `Origin`. */
	mcp: {
		auth: "token",
		anonymous: false,
		csrf: false,
		setupExempt: false,
		host: "forbid",
		tokenScope: "mcp",
	},
	/**
	 * `/-/oauth/*` (M2): the consent screen uses the owner's session and WP11
	 * calls `requireSameOrigin` on the consent POST itself; the token and
	 * registration endpoints are called by MCP clients without cookies.
	 */
	oauth: {
		auth: "cookie",
		anonymous: true,
		csrf: false,
		setupExempt: false,
		host: "redirect",
	},
	/** Discovery documents (`/.well-known/*`, `/-/agents.md`). */
	discovery: {
		auth: "any",
		anonymous: true,
		csrf: false,
		setupExempt: false,
		host: "redirect",
	},
	/** Git smart HTTP: tokens only (Basic password or Bearer); the handler answers 401 first. */
	git: {
		auth: "token",
		anonymous: true,
		csrf: false,
		setupExempt: false,
		host: "forbid",
	},
	/**
	 * The capability route `/-/cap/v1/…`: no credential at all (the
	 * path carries its MAC, verified in the isolate before any DO call),
	 * canonical host only, read-only upload-pack for Artifacts' importer.
	 */
	capability: {
		auth: "none",
		anonymous: true,
		csrf: false,
		setupExempt: false,
		host: "forbid",
	},
	/** Raw files (`CSP: sandbox`): browsers with a session, scripts with a token. */
	raw: {
		auth: "any",
		anonymous: true,
		csrf: false,
		setupExempt: false,
		host: "redirect",
	},
	/** 404/405 answers: only headers apply. */
	unrouted: {
		auth: "none",
		anonymous: true,
		csrf: false,
		setupExempt: true,
		host: "any",
	},
} as const satisfies Record<string, RoutePolicy>;

/** Static files the SPA (and the setup wizard) load; exempt from setup gating. */
export const SPA_ASSET_RE = /^\/(?:assets\/|favicon\.svg$)/;

/** Pseudo-routes for requests that match no route (they still pass the middleware). */
export const FALLTHROUGH = {
	asset: { id: "spa.asset", owner: "WP0", policy: POLICY.setupPage },
	page: { id: "spa.page", owner: "WP0", policy: POLICY.browser },
	notFound: { id: "unrouted.404", owner: "WP0", policy: POLICY.unrouted },
	method: { id: "unrouted.405", owner: "WP0", policy: POLICY.unrouted },
} as const satisfies Record<string, RouteInfo>;

// ---------------------------------------------------------------------------
// Health (WP0): binding presence, no network calls to Cloudflare APIs
// ---------------------------------------------------------------------------

const SETUP_STATE_TIMEOUT_MS = 2000;

const bindingStatus = (env: Env, name: string): "ok" | "missing" => {
	const value = (env as unknown as Record<string, unknown>)[name];
	return value === undefined || value === null ? "missing" : "ok";
};

const withTimeout = <T>(work: Promise<T>, ms: number): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
	});
	return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
};

/**
 * The forge's setup state from the identity module, bounded at 2 s; null
 * when it cannot answer (the caller falls back to what the isolate last
 * heard, else `fresh`).
 */
const readSetupState = async (
	env: Env,
	ms: number,
): Promise<SetupStateDto["state"] | null> => {
	if (bindingStatus(env, "FORGE") === "missing") return "fresh";
	try {
		const forge = env.FORGE.getByName(FORGE_DO_NAME);
		const state = await withTimeout(forge.identity().setupState(), ms);
		return state.state;
	} catch {
		return null;
	}
};

/**
 * The runner's last warm-up selftest (WP9), read from DO storage only (no
 * container start); null while none has run or the sandbox cannot answer.
 * The selftest's error text is not exposed.
 */
const readRunner = async (
	env: Env,
	ms: number,
): Promise<HealthRunner | null> => {
	if (bindingStatus(env, "SANDBOX") === "missing") return null;
	try {
		const info = await withTimeout(
			env.SANDBOX.getByName("selftest").runnerInfo(),
			ms,
		);
		if (info === null) return null;
		return {
			ok: info.ok,
			gitVersion: info.gitVersion,
			pnpmVersion: info.pnpmVersion,
			mergeTree: info.mergeTree,
			users: info.users,
			image: info.image === null ? null : { ...info.image },
			checkedAt: info.checkedAt,
		};
	} catch {
		return null;
	}
};

/**
 * A set-up forge's health is answered from the isolate for this long, with
 * no Durable Object read (the SPA's guard and the deploy script poll it).
 */
export const HEALTH_CACHE_MS = 5_000;

type HealthReads = {
	readonly setupState: SetupStateDto["state"];
	readonly runner: HealthRunner | null;
	readonly k2: NonNullable<HealthResponse["k2"]>;
};

/**
 * `/-/health` (WP0). Binding presence is computed per request; the DO reads
 * (setup state, runner) are cached in the isolate (one Worker, one forge)
 * for `HEALTH_CACHE_MS` once the forge is `done` (setup never goes back, so
 * a wizard step always reads afresh). A setup read that fails reports what
 * the isolate last heard from ForgeDO, never a guessed `fresh` for a forge
 * that is set up.
 */
export const createHealthHandler = (
	options: {
		readonly now?: () => number;
		/** Each DO read's bound (tests shorten it). */
		readonly readTimeoutMs?: number;
	} = {},
): RouteHandler => {
	const now = options.now ?? Date.now;
	const ms = options.readTimeoutMs ?? SETUP_STATE_TIMEOUT_MS;
	let cached: { readonly at: number; readonly reads: HealthReads } | null =
		null;
	const reads = async (env: Env): Promise<HealthReads> => {
		if (cached !== null && now() - cached.at < HEALTH_CACHE_MS) {
			return cached.reads;
		}
		const [read, runner, k2] = await Promise.all([
			readSetupState(env, ms),
			readRunner(env, ms),
			healthK2(env),
		]);
		const setupState = read ?? lastSetupInfo()?.state ?? "fresh";
		const fresh: HealthReads = { setupState, runner, k2 };
		if (read === "done") cached = { at: now(), reads: fresh };
		return fresh;
	};
	return async ({ env }) => {
		const bindings = Object.fromEntries(
			BINDING_NAMES.map((name) => [name, bindingStatus(env, name)]),
		);
		const ok = Object.values(bindings).every((status) => status === "ok");
		const { setupState, runner, k2 } = await reads(env);
		const body: HealthResponse = {
			ok,
			product: PRODUCT_NAME,
			version: TARTAN_VERSION,
			compatDate: COMPAT_DATE,
			stage: typeof env.TARTAN_STAGE === "string"
				? env.TARTAN_STAGE
				: "unknown",
			setupState,
			bindings,
			...(runner === null ? {} : { runner }),
			k2,
		};
		return Response.json(body, {
			status: ok ? 200 : 503,
			headers: { "cache-control": "no-store" },
		});
	};
};

export const handleHealth: RouteHandler = createHealthHandler();

/** Serves the SPA shell and static files (`ASSETS`, SPA not-found handling). */
export const handleAssets: RouteHandler = ({ req, env }) =>
	env.ASSETS.fetch(req);

// ---------------------------------------------------------------------------
// Route table (plus the concrete setup and auth routes)
// ---------------------------------------------------------------------------

const gitRoutes = (kind: "canonical" | "lane"): Route[] =>
	Object.entries(GIT_OPS).map(([name, { op, method, handler }]) => ({
		id: `git.${kind}.${name}`,
		owner: "WP4",
		methods: [method],
		policy: POLICY.git,
		pattern: kind === "lane"
			? new RegExp(
				`^/${NODE_PATH}/-/lanes/(?<lane>${LANE_ID})\\.git/${op}$`,
			)
			: new RegExp(`^/${NODE_PATH}(?:\\.git)?/${op}$`),
		handler,
	}));

export const ROUTES: readonly Route[] = [
	// Health and first-run setup. GET /-/setup[/*] is the SPA wizard.
	{
		id: "health",
		owner: "WP0",
		methods: READ,
		policy: POLICY.health,
		pattern: exact("/-/health"),
		handler: handleHealth,
	},
	// Container warm-up after a deploy (rate-limited by ForgeDO).
	{
		id: "health.warm",
		owner: "WP9",
		methods: ["POST"],
		policy: POLICY.deployScript,
		pattern: exact("/-/health/warm"),
		handler: handleHealthWarm,
	},
	{
		id: "setup.page",
		owner: "WP0",
		methods: READ,
		policy: POLICY.setupPage,
		pattern: withRest("/-/setup"),
		handler: handleAssets,
	},
	{
		id: "setup.api",
		owner: "WP2",
		methods: WRITE,
		policy: POLICY.setupApi,
		pattern: withRest("/-/setup"),
		handler: handleSetupApi,
	},

	// OIDC relying party and the avatar proxy.
	{
		id: "auth.login",
		owner: "WP2",
		methods: READ,
		policy: POLICY.authFlow,
		pattern: exact("/-/auth/login"),
		handler: handleLogin,
	},
	{
		id: "auth.callback",
		owner: "WP2",
		methods: READ,
		policy: POLICY.authFlow,
		pattern: exact("/-/auth/callback"),
		handler: handleCallback,
	},
	{
		id: "auth.logout",
		owner: "WP2",
		methods: ["POST"],
		policy: POLICY.browser,
		pattern: exact("/-/auth/logout"),
		handler: handleLogout,
	},
	{
		id: "auth.jwks",
		owner: "WP2",
		methods: READ,
		policy: POLICY.authFlow,
		pattern: exact("/-/auth/jwks.json"),
		handler: handleJwks,
	},
	{
		id: "avatar",
		owner: "WP2",
		methods: READ,
		policy: POLICY.browser,
		pattern: /^\/-\/avatar\/(?<principal>[^/]+)$/,
		handler: handleAvatar,
	},
	// RFC 7592 deletion of the stage's DCR client by `deno task destroy`.
	{
		id: "admin.idp.deregister",
		owner: "WP2",
		methods: ["POST"],
		policy: POLICY.deployScript,
		pattern: exact("/-/admin/idp/deregister"),
		handler: handleIdpDeregister,
	},

	// Kernel HTTP API (/-/api/*).
	{
		id: "api.me",
		owner: "WP2",
		methods: READ,
		policy: POLICY.apiPublic,
		pattern: exact("/-/api/me"),
		handler: handleMe,
	},
	{
		id: "api.tokens",
		owner: "WP2",
		methods: ["GET", "POST", "DELETE"],
		policy: POLICY.api,
		pattern: withRest("/-/api/tokens"),
		handler: handleTokens,
	},
	{
		id: "api.agents.bulk",
		owner: "WP2",
		methods: ["POST"],
		policy: POLICY.api,
		pattern: exact("/-/api/agents/bulk"),
		handler: handleAgentsBulk,
	},
	{
		id: "api.agents",
		owner: "WP2",
		methods: CRUD,
		policy: POLICY.api,
		pattern: withRest("/-/api/agents"),
		handler: handleAgents,
	},
	{
		id: "api.invites",
		owner: "WP2",
		methods: ["GET", "POST", "DELETE"],
		policy: POLICY.api,
		pattern: withRest("/-/api/invites"),
		handler: handleInvites,
	},
	// Repository config (WP23; ADR repo config): an Owner's approvals for
	// repo config at a node, before WP3's node API.
	{
		id: "api.nodes.config-approvals",
		owner: "WP23",
		methods: ["GET", "PUT", "DELETE"],
		policy: POLICY.api,
		pattern:
			/^\/-\/api\/nodes\/(?<node>[^/]+)\/config-approvals(?:\/(?<extId>[^/]+))?$/,
		handler: handleConfigApprovals,
	},
	{
		id: "api.nodes",
		owner: "WP3",
		methods: CRUD,
		policy: POLICY.apiPublic,
		pattern: withRest("/-/api/nodes"),
		handler: handleNodes,
	},
	{
		id: "api.tree",
		owner: "WP3",
		methods: READ,
		policy: POLICY.apiPublic,
		pattern: exact("/-/api/tree"),
		handler: handleTree,
	},
	{
		id: "api.blob",
		owner: "WP3",
		methods: READ,
		policy: POLICY.apiPublic,
		pattern: exact("/-/api/blob"),
		handler: handleBlob,
	},
	{
		id: "api.log",
		owner: "WP3",
		methods: READ,
		policy: POLICY.apiPublic,
		pattern: exact("/-/api/log"),
		handler: handleLog,
	},
	{
		id: "api.commit",
		owner: "WP3",
		methods: READ,
		policy: POLICY.apiPublic,
		pattern: exact("/-/api/commit"),
		handler: handleCommit,
	},
	{
		id: "api.compare",
		owner: "WP3",
		methods: READ,
		policy: POLICY.apiPublic,
		pattern: exact("/-/api/compare"),
		handler: handleCompare,
	},
	{
		id: "api.repos.import-complete",
		owner: "WP3",
		methods: ["POST"],
		policy: POLICY.api,
		pattern: /^\/-\/api\/repos\/(?<repoId>[^/]+)\/import-complete$/,
		handler: handleImportComplete,
	},
	{
		id: "api.repos.lanes.settings",
		owner: "WP5a",
		methods: ["GET", "PUT"],
		policy: POLICY.api,
		pattern: /^\/-\/api\/repos\/(?<repoId>[^/]+)\/lanes\/settings$/,
		handler: handleLaneSettings,
	},
	// Monorepo projects (WP25 slice A′; TARTAN_PROJECTS, 404 while off).
	{
		id: "api.repos.projects",
		owner: "WP25",
		methods: READ,
		policy: POLICY.apiPublic,
		pattern: /^\/-\/api\/repos\/(?<repoId>[^/]+)\/projects(?:\/(?<rest>.+))?$/,
		handler: handleProjects,
	},
	// Repository config (WP23; ADR repo config).
	{
		id: "api.repos.config",
		owner: "WP23",
		methods: ["GET", "POST"],
		policy: POLICY.api,
		pattern: /^\/-\/api\/repos\/(?<repoId>[^/]+)\/config(?:\/(?<rest>.+))?$/,
		handler: handleRepoConfig,
	},
	{
		id: "api.repos.lanes.config",
		owner: "WP23",
		methods: ["GET", "POST", "DELETE"],
		policy: POLICY.api,
		pattern:
			/^\/-\/api\/repos\/(?<repoId>[^/]+)\/lanes\/(?<laneId>ln_[^/]+)\/(?<what>config|policy-signoff)$/,
		handler: handleRepoConfigLane,
	},
	{
		id: "api.lanes",
		owner: "WP5a",
		methods: ["GET", "POST", "DELETE"],
		policy: POLICY.api,
		pattern: withRest("/-/api/lanes"),
		handler: handleLanes,
	},
	// The post-claim lane-repo self-test (Owner).
	{
		id: "api.admin.selftest.lanes",
		owner: "WP5b",
		methods: ["GET", "POST"],
		policy: POLICY.api,
		pattern: exact("/-/api/admin/selftest/lanes"),
		handler: handleLaneSelfTest,
	},
	{
		id: "api.events",
		owner: "WP6",
		methods: READ,
		policy: POLICY.api,
		pattern: exact("/-/api/events"),
		handler: handleEvents,
	},
	{
		id: "api.audit",
		owner: "WP6",
		methods: READ,
		policy: POLICY.api,
		pattern: exact("/-/api/audit"),
		handler: handleAudit,
	},
	{
		id: "api.inbox",
		owner: "WP6",
		methods: ["GET", "POST"],
		policy: POLICY.api,
		pattern: withRest("/-/api/inbox"),
		handler: handleInbox,
	},
	{
		id: "api.view",
		owner: "WP7a",
		methods: READ,
		policy: POLICY.apiPublic,
		pattern: exact("/-/api/view"),
		handler: handleView,
	},
	{
		id: "api.slot.action",
		owner: "WP7a",
		methods: ["POST"],
		policy: POLICY.api,
		pattern: /^\/-\/api\/slot\/(?<installation>[^/]+)\/(?<slot>[^/]+)\/action$/,
		handler: handleSlotAction,
	},
	{
		id: "api.slot.render",
		owner: "WP7a",
		methods: READ,
		policy: POLICY.apiPublic,
		pattern: /^\/-\/api\/slot\/(?<installation>[^/]+)\/(?<slot>[^/]+)$/,
		handler: handleSlotRender,
	},
	{
		id: "api.packages",
		owner: "WP7a",
		methods: ["GET", "POST", "PUT", "DELETE"],
		policy: POLICY.api,
		pattern: withRest("/-/api/packages"),
		handler: handlePackages,
	},
	// The Owner's repo-overrides opt-in (WP23), before WP7a's installations API.
	{
		id: "api.installations.repo-overrides",
		owner: "WP23",
		methods: ["PUT"],
		policy: POLICY.api,
		pattern:
			/^\/-\/api\/installations\/(?<installation>[^/]+)\/repo-overrides$/,
		handler: handleRepoOverrides,
	},
	{
		id: "api.installations",
		owner: "WP7a",
		methods: CRUD,
		policy: POLICY.api,
		pattern: withRest("/-/api/installations"),
		handler: handleInstallations,
	},
	{
		id: "api.runs",
		owner: "WP9",
		methods: ["GET", "POST"],
		policy: POLICY.api,
		pattern: withRest("/-/api/runs"),
		handler: handleRuns,
	},
	{
		id: "api.usage",
		owner: "WP9",
		methods: READ,
		policy: POLICY.api,
		pattern: exact("/-/api/usage"),
		handler: handleUsage,
	},
	// Dev stages only: CI runs for live checks, authorized by the dev
	// key alone in the handler (404 without it), in any setup state.
	{
		id: "dev.runs",
		owner: "WP9",
		methods: ["GET", "POST"],
		policy: POLICY.deployScript,
		pattern: withRest("/-/dev/runs"),
		handler: handleDevRuns,
	},
	// Dev stages only: the WP10 live acceptance (repo setup, lanes,
	// submit, verification), authorized by the dev key alone in the handler.
	{
		id: "dev.land",
		owner: "WP10",
		methods: ["GET", "POST"],
		policy: POLICY.deployScript,
		pattern: withRest("/-/dev/land"),
		handler: handleDevLand,
	},
	// Dev stages only: probes of the repository-config evaluator
	// sandboxes (network, memory limits, timings), authorized by
	// the dev key alone in the handler (404 without it), in any setup state.
	{
		id: "dev.cue",
		owner: "WP9",
		methods: ["POST"],
		policy: POLICY.deployScript,
		pattern: exact("/-/dev/cue"),
		handler: handleDevCue,
	},
	// Dev stages only: the WP25 live acceptance (seed a tree, read its
	// projects), authorized by the dev key alone in the handler.
	{
		id: "dev.projects",
		owner: "WP25",
		methods: ["GET", "POST"],
		policy: POLICY.deployScript,
		pattern: withRest("/-/dev/projects"),
		handler: handleDevProjects,
	},
	{
		id: "api.advances",
		owner: "WP10",
		methods: READ,
		policy: POLICY.apiPublic,
		pattern: withRest("/-/api/advances"),
		handler: handleAdvances,
	},
	// Dev stages only: the audited history seeding for the gate replay
	// (demo beat 3); a forge admin's act.
	{
		id: "api.seed-history",
		owner: "WP10",
		methods: ["POST"],
		policy: POLICY.api,
		pattern: exact("/-/api/seed-history"),
		handler: handleSeedHistory,
	},
	{
		id: "api.why",
		owner: "WP10",
		methods: READ,
		policy: POLICY.apiPublic,
		pattern: exact("/-/api/why"),
		handler: handleWhy,
	},
	{
		id: "api.blame",
		owner: "WP10",
		methods: READ,
		policy: POLICY.apiPublic,
		pattern: exact("/-/api/blame"),
		handler: handleBlame,
	},
	{
		id: "api.swarm",
		owner: "WP20",
		methods: ["GET", "POST", "DELETE"],
		policy: POLICY.api,
		pattern: withRest("/-/api/swarm"),
		handler: handleSwarm,
	},
	// The global log (WP26): status and dead letters, forge Owner only.
	{
		id: "api.log.status",
		owner: "WP26",
		methods: READ,
		policy: POLICY.api,
		pattern: /^\/-\/api\/log\/(?<rest>status)$/,
		handler: handleGlobalLog,
	},
	{
		id: "api.log.dead",
		owner: "WP26",
		methods: ["GET", "POST"],
		policy: POLICY.api,
		pattern: /^\/-\/api\/log\/(?<rest>dead(?:\/.+)?)$/,
		handler: handleGlobalLog,
	},
	// Dev stages only: the WP26 live acceptance (status, relay reads,
	// the live K2 conformance suite), authorized by the dev key alone.
	{
		id: "dev.k2",
		owner: "WP26",
		methods: ["GET", "POST"],
		policy: POLICY.deployScript,
		pattern: withRest("/-/dev/k2"),
		handler: handleDevK2,
	},

	// Live feed.
	{
		id: "live",
		owner: "WP6",
		methods: READ,
		policy: POLICY.live,
		pattern: exact("/-/live"),
		handler: handleLive,
	},

	// Agents: MCP, OAuth (M2), discovery, agents.md.
	{
		id: "mcp",
		owner: "WP11",
		methods: ["GET", "POST", "DELETE", "OPTIONS"],
		policy: POLICY.mcp,
		pattern: withRest("/-/mcp"),
		handler: handleMcp,
	},
	{
		id: "oauth",
		owner: "WP11",
		methods: ["GET", "POST", "OPTIONS"],
		policy: POLICY.oauth,
		pattern: /^\/-\/oauth\/(?<rest>.+)$/,
		handler: handleOAuth,
	},
	{
		id: "well-known",
		owner: "WP11",
		methods: ["GET", "OPTIONS"],
		policy: POLICY.discovery,
		pattern: /^\/\.well-known\/(?<rest>.+)$/,
		handler: handleWellKnown,
	},
	{
		id: "agents-md",
		owner: "WP11",
		methods: READ,
		policy: POLICY.discovery,
		pattern: exact("/-/agents.md"),
		handler: handleAgentsMd,
	},

	// Lane-repo seeding: read-only upload-pack for Artifacts' importer.
	{
		id: "cap.info-refs",
		owner: "WP4",
		methods: READ,
		policy: POLICY.capability,
		pattern: capRoutePattern("info/refs"),
		handler: handleCapInfoRefs,
	},
	{
		id: "cap.upload-pack",
		owner: "WP4",
		methods: ["POST"],
		policy: POLICY.capability,
		pattern: capRoutePattern("git-upload-pack"),
		handler: handleCapUploadPack,
	},
	// Every other `/-/cap/` path, any method (after the two precise routes): WP4
	// answers the uniform plain 404 and counts it in the failure buckets.
	{
		id: "cap.not-found",
		owner: "WP4",
		methods: ANY,
		policy: POLICY.capability,
		pattern: /^\/-\/cap\//,
		handler: handleCapNotFound,
	},

	// Git smart HTTP: lane remotes (`repo` backend) first, then any other
	// git-shaped lane path (a malformed or uppercase lane id, another op: a plain
	// 404 from WP4), then canonical; raw files.
	...gitRoutes("lane"),
	{
		id: "git.lane.not-found",
		owner: "WP4",
		methods: ANY,
		policy: POLICY.git,
		pattern: new RegExp(`^/${NODE_PATH}/-/lanes/[^/]+\\.git/`),
		handler: handleLaneNotFound,
	},
	...gitRoutes("canonical"),
	{
		id: "raw",
		owner: "WP3",
		methods: READ,
		policy: POLICY.raw,
		pattern: new RegExp(`^/${NODE_PATH}/-/raw/(?<rest>.+)$`),
		handler: handleRaw,
	},
];

/** Prefixes the Worker owns: an unmatched path here is a 404 JSON error, never the SPA. */
export const WORKER_PREFIXES = [
	"/-/api/",
	"/-/cap/",
	"/-/auth/",
	"/-/oauth/",
	"/-/mcp/",
	"/.well-known/",
] as const;

// ---------------------------------------------------------------------------
// Matching and dispatch
// ---------------------------------------------------------------------------

export type RouteMatch =
	| {
		readonly kind: "route";
		readonly route: Route;
		readonly params: Readonly<Record<string, string>>;
	}
	| { readonly kind: "method"; readonly allow: readonly string[] }
	| { readonly kind: "none" };

export const matchRoute = (
	method: string,
	pathname: string,
	routes: readonly Route[] = ROUTES,
): RouteMatch => {
	const wanted = method === "HEAD" ? "GET" : method;
	const allow = new Set<string>();
	for (const route of routes) {
		const match = route.pattern.exec(pathname);
		if (match === null) continue;
		if ((route.methods as readonly string[]).includes(wanted)) {
			const params = Object.fromEntries(
				Object.entries(match.groups ?? {}).filter(
					(entry): entry is [string, string] => entry[1] !== undefined,
				),
			);
			return { kind: "route", route, params };
		}
		for (const m of route.methods) allow.add(m);
		if (route.methods.includes("GET")) allow.add("HEAD");
	}
	return allow.size > 0
		? { kind: "method", allow: [...allow].sort() }
		: { kind: "none" };
};

const jsonError = (error: unknown): Response => {
	const wire = toWire(error);
	return Response.json(wire, {
		status: httpStatus(wire.error),
		headers: { "cache-control": "no-store" },
	});
};

/** 405 with `Allow`; the body uses the `invalid` code with reason `method`. */
const methodNotAllowed = (method: string, allow: readonly string[]): Response =>
	Response.json(
		toWire(
			tartanError("invalid", `method ${method} not allowed`, {
				reason: "method",
				details: { allow },
			}),
		),
		{
			status: 405,
			headers: { "cache-control": "no-store", allow: allow.join(", ") },
		},
	);

export type Router = (
	req: Request,
	env: Env,
	ctx: ExecutionContext,
) => Promise<Response>;

type Target = {
	readonly route: RouteInfo;
	readonly params: Readonly<Record<string, string>>;
	readonly run: (c: RouteContext) => Promise<Response>;
};

const resolveTarget = (
	method: string,
	pathname: string,
	routes: readonly Route[],
): Target => {
	const match = matchRoute(method, pathname, routes);
	if (match.kind === "route") {
		const { route, params } = match;
		return {
			route: { id: route.id, owner: route.owner, policy: route.policy },
			params,
			run: async (c) => await route.handler(c),
		};
	}
	if (match.kind === "method") {
		return {
			route: FALLTHROUGH.method,
			params: {},
			run: () => Promise.resolve(methodNotAllowed(method, match.allow)),
		};
	}
	if (WORKER_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
		return {
			route: FALLTHROUGH.notFound,
			params: {},
			// Redacted: a capability path is a bearer secret.
			run: () =>
				Promise.resolve(
					jsonError(notFound(redactSecrets(`no route for ${pathname}`))),
				),
		};
	}
	return {
		route: SPA_ASSET_RE.test(pathname) ? FALLTHROUGH.asset : FALLTHROUGH.page,
		params: {},
		run: ({ req, env }) => env.ASSETS.fetch(req),
	};
};

/**
 * The router. `security` is WP2's middleware (`withSecurity`); tests may pass
 * their own. Errors from the middleware or a handler become JSON errors
 * (internal ones are logged with the route id and never leak details).
 */
export const createRouter = (
	routes: readonly Route[] = ROUTES,
	security: SecurityMiddleware = withSecurity,
): Router =>
async (req, env, ctx) => {
	const url = new URL(req.url);
	const target = resolveTarget(req.method, url.pathname, routes);
	const base: RequestContext = {
		req,
		env,
		ctx,
		url,
		params: target.params,
		route: target.route,
	};
	try {
		return await security(base, (auth) => target.run({ ...base, auth }));
	} catch (error) {
		const wire = toWire(error);
		if (wire.error === "internal") {
			console.error(`[tartan] route ${target.route.id} failed`, error);
		}
		return jsonError(error);
	}
};
