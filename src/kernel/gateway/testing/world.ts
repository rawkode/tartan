// Test-only (Deno): the gateway end to end with real parts wherever a test
// can have them. Stock git is the client; the gateway handlers run behind a
// local HTTP server that stands in for the router and WP2's middleware
// (tokens only, 401 with the Basic challenge for a bad one, never cookies);
// RepoDO is WP5a's real `core` module on the `node:sqlite` fake (its own
// recording fakes for ForgeDO, WP6, WP8 and WP10); the upstream is a bare
// repository served by `git http-backend`, reached through the remote URL
// RepoDO's `upstream()` returns. WP3's tree is a small in-memory fake.

import {
	type EffectiveRole,
	type GitSource,
	type NodeDto,
	ROLE,
	ulid,
} from "@tartan/contract";
import type {
	AuthContext,
	DiffResult,
	ResolvedPath,
	Upstream,
} from "@tartan/contract/kernel.ts";
import { createHarness, type Harness } from "../../repo/testing/harness.ts";
import { canonicalPushPolicy, laneRepoPolicy } from "../policy.ts";
import { handleReceivePack } from "../receive.ts";
import type {
	GatewayConfig,
	GatewayDeps,
	GatewayRepo,
	GitRequest,
} from "../types.ts";
import { handleInfoRefs, handleUploadPack } from "../upload.ts";
import { GIT_CHALLENGE } from "../respond.ts";
import {
	git,
	type GitBackend,
	type GitResult,
	hasGit,
	initBare,
	initWork,
	makeSandbox,
	revParse,
	type Sandbox,
	startBackend,
} from "./git.ts";

/** The remote prefix the WP5a harness's fake Artifacts hands out. */
const FAKE_REMOTE = "https://artifacts.fake.test/ns/";

const CANONICAL =
	/^\/(?<repo>[^/-][^/]*?(?:\/[^/-][^/]*?)*?)(?:\.git)?\/(?<op>info\/refs|git-upload-pack|git-receive-pack)$/;

export type TestPrincipal = {
	readonly id: string;
	readonly kind: "user" | "agent";
	readonly token: string;
	readonly auth: AuthContext;
};

export type World = {
	readonly sandbox: Sandbox;
	readonly backend: GitBackend;
	readonly h: Harness;
	readonly repoId: string;
	readonly repoPath: string;
	/** The bare upstream repository (`r-<repoId>.git`). */
	readonly bare: string;
	/** The seed work tree (pushed directly to the bare repository). */
	readonly seed: string;
	readonly trunk: string;
	/** `http://127.0.0.1:<port>` of the gateway. */
	readonly gatewayUrl: string;
	/** `<gateway>/acme/shop.git` */
	readonly remote: string;
	readonly node: { visibility: NodeDto["visibility"]; archived: boolean };
	/** `repo.upstream()` calls by scope (a write mint is visible here). */
	readonly upstreamCalls: { scope: "read" | "write" }[];
	readonly probeCalls: { source: GitSource; after: string }[];
	readonly logs: { message: string; data: Record<string, unknown> }[];
	readonly redirects: Map<string, string>;
	readonly forgeOwners: Set<string>;
	config: GatewayConfig;
	/** The installations' echo on accepted pushes; none by default. */
	echo: GatewayDeps["echo"];
	/** Replaces RepoDO's facade methods the gateway calls (fault injection). */
	repo: GatewayRepo;
	principal(
		kind: "user" | "agent",
		options?: {
			readonly role?: EffectiveRole;
			readonly scopes?: AuthContext["scopes"];
			readonly laneId?: string | null;
			readonly nodeId?: string | null;
			readonly maxRole?: AuthContext["maxRole"];
		},
	): TestPrincipal;
	/** A second token of the same principal, pinned to `laneId`. */
	pin(who: TestPrincipal, laneId: string): TestPrincipal;
	/** Opens a `branch` lane for `owner` through RepoDO (K16 as the owner). */
	openLane(owner: TestPrincipal): Promise<string>;
	/** Runs stock git as `who` (null: anonymous). */
	gitAs(
		who: TestPrincipal | null,
		args: readonly string[],
		options?: { readonly cwd?: string; readonly allowFail?: boolean },
	): Promise<GitResult>;
	/** A clone of the canonical repo through the gateway. */
	clone(who: TestPrincipal | null, name: string): Promise<string>;
	/** Awaits the gateway's `waitUntil` work and RepoDO's detached work. */
	settle(): Promise<void>;
	close(): Promise<void>;
};

const randomToken = (prefix: "tpat_" | "tagt_"): string => {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-")
		.replace(/\//g, "_").replace(/=+$/, "");
	return `${prefix}${b64}`;
};

/** `Authorization: Basic x:<token>` as a git `http.extraHeader`. */
export const basicHeader = (token: string): string =>
	`Authorization: Basic ${btoa(`x:${token}`)}`;

const credentialOf = (header: string): string | null => {
	const m = /^\s*(Bearer|Basic)\s+(\S+)\s*$/i.exec(header);
	if (m === null) return null;
	if (m[1].toLowerCase() === "bearer") return m[2];
	try {
		const decoded = atob(m[2]);
		const colon = decoded.indexOf(":");
		return colon === -1 ? null : decoded.slice(colon + 1);
	} catch {
		return null;
	}
};

export const defaultConfig = (): GatewayConfig => ({
	maxPushBytes: 95_000_000,
	echo: false,
	upstreamAuth: "bearer",
	phase1WaitMs: 5_000,
	policy: canonicalPushPolicy,
	lanePolicy: laneRepoPolicy,
});

/** Diff results the RepoProbe fake returns. */
export const probeDiff = (source: GitSource, after: string): DiffResult => ({
	rangeBase: after,
	rangeTruncated: false,
	diffKey: `diffs/${source.repoId}/${after}..${after}.json`,
	commits: [],
	paths: [],
	truncated: false,
});

export const createWorld = async (
	options: { readonly visibility?: NodeDto["visibility"] } = {},
): Promise<World> => {
	const sandbox = await makeSandbox();
	const backend = startBackend(
		sandbox,
		(header) => header !== null && /^Bearer art_v2_/.test(header),
	);
	const seed = await initWork(sandbox, "seed", 2);
	const trunk = await revParse(sandbox, seed, "HEAD");
	const h = await createHarness({ trunk });
	const bare = await initBare(sandbox, h.canonical);
	await git(sandbox, ["push", "-q", bare, "main:refs/heads/main"], {
		cwd: seed,
	});
	// A hidden kernel ref upstream (a landed change's history).
	await git(sandbox, ["push", "-q", bare, `main~1:refs/tartan/changes/c1`], {
		cwd: seed,
	});

	const repoPath = "acme/shop";
	const node = {
		visibility: options.visibility ?? ("private" as NodeDto["visibility"]),
		archived: false,
	};
	const nodeDto = (): NodeDto => ({
		id: h.repoId,
		parentId: null,
		kind: "repo",
		slug: "shop",
		path: repoPath,
		depth: 1,
		visibility: node.visibility,
		defaultBranch: "main",
		archived: node.archived,
		createdAt: 0,
	});
	const redirects = new Map<string, string>();
	const tokens = new Map<string, AuthContext>();
	const upstreamCalls: { scope: "read" | "write" }[] = [];
	const probeCalls: { source: GitSource; after: string }[] = [];
	const logs: { message: string; data: Record<string, unknown> }[] = [];
	const waits: Promise<unknown>[] = [];
	const forgeOwners = new Set<string>();

	const facade = h.facade;
	const realRepo: GatewayRepo = {
		pushContext: (...args) => facade.pushContext(...args),
		readContext: (...args) => facade.readContext(...args),
		recordPush: (...args) => facade.recordPush(...args),
		recordRejection: (...args) => facade.recordRejection(...args),
		recordDiff: (...args) => facade.recordDiff(...args),
		refs: () => facade.refs(),
		getLane: (laneId) => facade.getLane(laneId),
		upstream: (target, scope): Promise<Upstream> => {
			upstreamCalls.push({ scope });
			return facade.upstream(target, scope);
		},
	};

	const world: World = {
		sandbox,
		backend,
		h,
		repoId: h.repoId,
		repoPath,
		bare,
		seed,
		trunk,
		gatewayUrl: "",
		remote: "",
		node,
		upstreamCalls,
		probeCalls,
		logs,
		redirects,
		forgeOwners,
		config: defaultConfig(),
		echo: undefined,
		repo: realRepo,
		principal: (kind, opts = {}) => {
			const id = `${kind === "user" ? "u" : "a"}_${ulid()}`;
			const token = randomToken(kind === "user" ? "tpat_" : "tagt_");
			const auth: AuthContext = {
				principal: id,
				kind,
				via: kind === "user" ? "pat" : "agent-token",
				tokenId: `tok_${ulid()}`,
				scopes: opts.scopes ??
					(kind === "user"
						? ["repo:read", "repo:write", "lanes"]
						: ["repo:read", "repo:write", "lanes", "mcp"]),
				nodeId: opts.nodeId ?? null,
				laneId: opts.laneId ?? null,
				maxRole: opts.maxRole ?? ROLE.owner,
				isAdmin: false,
			};
			tokens.set(token, auth);
			if ((opts.role ?? ROLE.developer) > 0) {
				h.tree.roles.set(id, opts.role ?? ROLE.developer);
			}
			return { id, kind, token, auth };
		},
		pin: (who, laneId) => {
			const token = randomToken(who.kind === "user" ? "tpat_" : "tagt_");
			const auth: AuthContext = {
				...who.auth,
				tokenId: `tok_${ulid()}`,
				laneId,
			};
			tokens.set(token, auth);
			return { ...who, token, auth };
		},
		openLane: async (owner) => {
			const lane = await facade.openLane({
				owner: owner.id,
				actor: { kind: owner.kind, id: owner.id },
			});
			return lane.id;
		},
		gitAs: (who, args, opts = {}) =>
			git(
				sandbox,
				who === null
					? args
					: ["-c", `http.extraHeader=${basicHeader(who.token)}`, ...args],
				opts,
			),
		clone: async (who, name) => {
			const dir = `${sandbox.root}/clones/${name}`;
			await world.gitAs(who, ["clone", "-q", world.remote, dir]);
			return dir;
		},
		settle: async () => {
			for (let round = 0; round < 20; round++) {
				if (waits.length === 0) {
					await h.settle();
					if (waits.length === 0) return;
				}
				await Promise.allSettled(waits.splice(0));
			}
		},
		close: async () => {
			await world.settle();
			await server.shutdown();
			await backend.close();
			await sandbox.cleanup();
		},
	};

	const deps = (): GatewayDeps => ({
		tree: {
			resolvePath: (path): Promise<ResolvedPath | null> => {
				const moved = redirects.get(path);
				if (moved !== undefined) {
					return Promise.resolve({
						node: nodeDto(),
						rest: "",
						redirectTo: moved,
					});
				}
				return Promise.resolve(
					path === repoPath ? { node: nodeDto(), rest: "" } : null,
				);
			},
			effectiveRole: (principals) =>
				Promise.resolve(
					Math.max(
						0,
						...principals.map((p) => h.tree.roles.get(p) ?? 0),
					) as EffectiveRole,
				),
			node: (id) =>
				Promise.resolve(
					id === h.repoId
						? nodeDto()
						: id === "group-acme"
						? { ...nodeDto(), id, kind: "group", slug: "acme", path: "acme" }
						: id === "group-other"
						? { ...nodeDto(), id, kind: "group", slug: "other", path: "other" }
						: null,
				),
		},
		repo: () => world.repo,
		isForgeOwner: (principal) => Promise.resolve(forgeOwners.has(principal)),
		echo: (event, at, budgetMs) =>
			world.echo === undefined
				? Promise.resolve([])
				: world.echo(event, at, budgetMs),
		probe: () => ({
			laneDiff: (source, after) => {
				probeCalls.push({ source, after });
				return Promise.resolve(probeDiff(source, after));
			},
		}),
		fetch: (request) => {
			const url = request.url;
			if (!url.startsWith(FAKE_REMOTE)) {
				return Promise.reject(new Error(`unexpected upstream ${url}`));
			}
			return fetch(
				new Request(`${backend.url}/${url.slice(FAKE_REMOTE.length)}`, request),
			);
		},
		requestId: ulid,
		log: (message, data) => void logs.push({ message, data }),
		config: world.config,
	});

	const server = Deno.serve(
		{ hostname: "127.0.0.1", port: 0, onListen: () => {} },
		async (request) => {
			const url = new URL(request.url);
			const match = CANONICAL.exec(url.pathname);
			if (match?.groups === undefined) {
				return new Response("not found\n", { status: 404 });
			}
			const header = request.headers.get("authorization");
			let auth: AuthContext | null = null;
			if (header !== null) {
				const credential = credentialOf(header);
				auth = credential === null ? null : tokens.get(credential) ?? null;
				if (auth === null) {
					return new Response("bad credentials\n", {
						status: 401,
						headers: { "www-authenticate": GIT_CHALLENGE },
					});
				}
			}
			const r: GitRequest = {
				req: request,
				url,
				repoPath: match.groups.repo,
				auth,
				waitUntil: (promise) => void waits.push(promise),
			};
			const op = match.groups.op;
			const method = op === "info/refs" ? "GET" : "POST";
			if (
				request.method !== method &&
				!(method === "GET" && request.method === "HEAD")
			) {
				return new Response("method\n", { status: 405 });
			}
			const d = deps();
			return op === "info/refs"
				? await handleInfoRefs(d, r)
				: op === "git-upload-pack"
				? await handleUploadPack(d, r)
				: await handleReceivePack(d, r);
		},
	);
	const gatewayUrl = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
	Object.assign(world, {
		gatewayUrl,
		remote: `${gatewayUrl}/${repoPath}.git`,
	});
	return world;
};

// ---------------------------------------------------------------------------
// Helpers shared by the stock-git suites
// ---------------------------------------------------------------------------

/** A Deno test that needs stock git (skipped without it). */
export const gitTest = (name: string, fn: () => Promise<void>): void =>
	Deno.test({
		name,
		ignore: !hasGit,
		// Deno.serve and the git subprocesses outlive single awaits.
		sanitizeOps: false,
		sanitizeResources: false,
		fn,
	});

export const laneRef = (id: string): string => `refs/heads/lanes/${id}`;

/** Upstream receive-pack POSTs (pushes that reached the backend). */
export const forwardedPushes = (w: World) =>
	w.backend.requests.filter((r) =>
		r.method === "POST" && r.path.endsWith("/git-receive-pack")
	);

/** Ref names `git ls-remote` lists through the gateway. */
export const lsRemote = async (
	w: World,
	who: TestPrincipal | null,
	extra: readonly string[] = [],
): Promise<string[]> =>
	(await w.gitAs(who, ["ls-remote", ...extra, w.remote])).stdout.trim()
		.split("\n").filter((l) => l !== "").map((l) => l.split("\t")[1]);

/** An agent with an open `branch` lane and a clone switched to `lanes/<id>`. */
export const agentWithLane = async (
	w: World,
	name: string,
): Promise<{ agent: TestPrincipal; laneId: string; dir: string }> => {
	const agent = w.principal("agent");
	const laneId = await w.openLane(agent);
	const dir = await w.clone(agent, name);
	await w.gitAs(agent, ["switch", "-q", "-c", `lanes/${laneId}`], { cwd: dir });
	return { agent, laneId, dir };
};

/** `n` random (incompressible) bytes. */
export const randomBytes = (n: number): Uint8Array => {
	const out = new Uint8Array(n);
	for (let at = 0; at < n; at += 65_536) {
		crypto.getRandomValues(out.subarray(at, Math.min(n, at + 65_536)));
	}
	return out;
};

/** Runs `body` with a fresh world, always closing it. */
export const withWorld = async <T>(
	body: (world: World) => Promise<T>,
	options?: Parameters<typeof createWorld>[0],
): Promise<T> => {
	const world = await createWorld(options);
	try {
		return await body(world);
	} finally {
		await world.close();
	}
};
